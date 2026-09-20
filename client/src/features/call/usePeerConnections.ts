import { useCallback, useEffect, useRef, useState } from 'react';
import type { IceServerConfig, SignalPayload } from '@syncroom/shared';
import { socket } from '@/lib/socket';
import {
  FORCE_TURN_FOR_TEST,
  ICE_ENDPOINT,
  describeIceServers,
  getIceServers,
  hasTurn,
  peerConnectionConfig,
} from '@/lib/iceConfig';
import { QUALITY_MAX_BITRATE, useSettings } from '@/store/settings';
import { useRoomStore } from '@/store/room';

export interface RemoteFeed {
  peerId: string;
  stream: MediaStream;
  kind: 'camera' | 'screen';
}

interface PeerRecord {
  pc: RTCPeerConnection;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  /** Their stream-id → purpose map, learned from their signals. */
  remoteMeta: Record<string, 'camera' | 'screen'>;
  camSenders: Partial<Record<'audio' | 'video', RTCRtpSender>>;
  screenSenders: Partial<Record<'audio' | 'video', RTCRtpSender>>;
}

/**
 * Verbose signaling/ICE tracing. Normally dev-only — SDP and candidates are
 * sensitive and noisy enough that they should not hit a production console —
 * but it also switches on while the relay test mode is active, because that
 * test is run against the deployed site and is worthless without the candidate
 * log. `VITE_WEBRTC_DEBUG=true` turns it on independently.
 */
const TRACE =
  import.meta.env.DEV ||
  FORCE_TURN_FOR_TEST ||
  (import.meta.env.VITE_WEBRTC_DEBUG as string | undefined)?.trim() === 'true';

function debug(...args: unknown[]): void {
  if (TRACE) console.log(...args);
}

/**
 * ICE configuration comes from `@/lib/iceConfig`, which fetches it from the
 * server's `GET /ice` (see that file). STUN comes first and TURN second, so
 * with `iceTransportPolicy: 'all'` the browser gathers host + server-reflexive
 * candidates and always *prefers* a direct connection; a TURN `relay` candidate
 * is used only when no direct pair can be established (strict/symmetric NAT,
 * ~10-15% of pairs).
 *
 * `FORCE_TURN_FOR_TEST` overrides that with `'relay'`, which suppresses every
 * non-relay candidate so a successful call proves TURN itself works.
 */

/**
 * Full-mesh WebRTC with the "perfect negotiation" pattern. Each remote
 * participant gets one RTCPeerConnection carrying the camera stream and,
 * when active, a separate screen-share stream (identified via streamMeta
 * piggybacked on signaling).
 *
 * P2P mesh = no SFU in the media path: original encoder quality end-to-end,
 * lowest possible latency, zero media-server cost. See ARCHITECTURE.md for
 * the SFU trade-off discussion.
 */
export function usePeerConnections(options: {
  active: boolean;
  localStream: MediaStream | null;
  screenStream: MediaStream | null;
}): {
  feeds: RemoteFeed[];
  peersRef: React.MutableRefObject<Map<string, PeerRecord>>;
  syncAllTracks: () => void;
} {
  const { active, localStream, screenStream } = options;
  const [feeds, setFeeds] = useState<RemoteFeed[]>([]);
  const peersRef = useRef<Map<string, PeerRecord>>(new Map());
  const localRef = useRef<{ cam: MediaStream | null; screen: MediaStream | null }>({
    cam: null,
    screen: null,
  });
  localRef.current = { cam: localStream, screen: screenStream };

  const selfId = useRoomStore((s) => s.selfId);
  const participants = useRoomStore((s) => s.room?.participants);

  /** Read from async continuations that may outlive the call. */
  const activeRef = useRef(active);
  activeRef.current = active;

  /**
   * Per-peer promise chain, keyed by peer id rather than held on the peer
   * record, because the record itself is now created asynchronously and a
   * signal can arrive before it exists.
   */
  const signalChains = useRef<Map<string, Promise<void>>>(new Map());

  const streamMeta = useCallback((): Record<string, 'camera' | 'screen'> => {
    const meta: Record<string, 'camera' | 'screen'> = {};
    const { cam, screen } = localRef.current;
    if (cam) meta[cam.id] = 'camera';
    if (screen) meta[screen.id] = 'screen';
    return meta;
  }, []);

  const removeFeedsFor = useCallback((peerId: string, streamId?: string): void => {
    setFeeds((prev) =>
      prev.filter(
        (f) => f.peerId !== peerId || (streamId !== undefined && f.stream.id !== streamId),
      ),
    );
  }, []);

  const applySenderQuality = useCallback(
    (sender: RTCRtpSender, kind: 'camera' | 'screen'): void => {
      if (sender.track?.kind !== 'video') return;
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
      const preset = useSettings.getState().quality;
      params.encodings.forEach((enc) => {
        enc.maxBitrate = QUALITY_MAX_BITRATE[preset];
      });
      params.degradationPreference = kind === 'screen' ? 'maintain-resolution' : 'balanced';
      sender.setParameters(params).catch(() => {
        /* older browsers may reject degradationPreference; harmless */
      });
    },
    [],
  );

  /** Ensures every peer connection carries the current local tracks. */
  const syncAllTracks = useCallback((): void => {
    const { cam, screen } = localRef.current;
    for (const peer of peersRef.current.values()) {
      const { pc } = peer;

      const syncSet = (
        stream: MediaStream | null,
        senders: Partial<Record<'audio' | 'video', RTCRtpSender>>,
        kind: 'camera' | 'screen',
      ): void => {
        if (stream) {
          for (const track of stream.getTracks()) {
            const slot = track.kind as 'audio' | 'video';
            const existing = senders[slot];
            if (!existing) {
              debug("[ADD TRACK]", {
                source: kind, // camera or screen
                trackKind: track.kind, // audio or video
                trackId: track.id,
                streamId: stream.id,
                enabled: track.enabled,
                readyState: track.readyState,
              });
              const sender = pc.addTrack(track, stream);
              senders[slot] = sender;
              applySenderQuality(sender, kind);
            } else if (existing.track !== track) {
              void existing.replaceTrack(track);
              applySenderQuality(existing, kind);
            }
          }
        } else {
          for (const slot of ['audio', 'video'] as const) {
            const sender = senders[slot];
            if (sender) {
              try {
                pc.removeTrack(sender);
              } catch {
                /* pc may be closed */
              }
              delete senders[slot];
            }
          }
        }
      };
      debug(
        "[LOCAL CAM]",
        cam?.getTracks().map(t => ({
          kind: t.kind,
          enabled: t.enabled,
          readyState: t.readyState
        }))
      );
      syncSet(cam, peer.camSenders, 'camera');
      syncSet(screen, peer.screenSenders, 'screen');
    }
  }, [applySenderQuality]);

  const createPeer = useCallback(
    (peerId: string, ice: IceServerConfig[]): PeerRecord => {
      const pc = new RTCPeerConnection(peerConnectionConfig(ice));
      debug(
        `[webrtc] peer ${peerId}: RTCPeerConnection created — ${describeIceServers(ice)}, ` +
          `iceTransportPolicy: ${peerConnectionConfig(ice).iceTransportPolicy}`,
      );
      pc.onsignalingstatechange = () => {
        debug("[SIGNAL STATE]", peerId, pc.signalingState);
      };

      pc.onconnectionstatechange = async () => {
        debug('[webrtc] connection state:', peerId, pc.connectionState);

        if (pc.connectionState === "connected") {
          const stats = await pc.getStats();
          // Resolve the nominated pair to real candidate rows so the log says
          // which transport actually carried the call (`relay` = via TURN).
          stats.forEach((report) => {
            if (report.type === "candidate-pair" && report.state === "succeeded") {
              const local = stats.get(report.localCandidateId as string) as
                | { candidateType?: string; protocol?: string }
                | undefined;
              const remote = stats.get(report.remoteCandidateId as string) as
                | { candidateType?: string }
                | undefined;
              debug('[webrtc] selected pair:', peerId, {
                local: local?.candidateType,
                remote: remote?.candidateType,
                protocol: local?.protocol,
                viaTurnRelay: local?.candidateType === 'relay' || remote?.candidateType === 'relay',
              });
            }
          });
        }
      };
      // A peer whose connection never recovers (network drop, `disconnected`
      // that never resolves to `failed`) would otherwise show a permanently
      // frozen/black tile with no way back short of leaving the room.
      let disconnectTimer: ReturnType<typeof setTimeout> | undefined;
      const peer: PeerRecord = {
        pc,
        polite: (selfId ?? '') < peerId,
        makingOffer: false,
        ignoreOffer: false,
        remoteMeta: {},
        camSenders: {},
        screenSenders: {},
      };

      pc.onnegotiationneeded = async (): Promise<void> => {
        debug("[NEGOTIATION]", {
          peerId,
          selfId,
          signalingState: pc.signalingState,
          iceConnectionState: pc.iceConnectionState,
        });

        try {
          peer.makingOffer = true;
          await pc.setLocalDescription();

          if (pc.localDescription) {
            debug("[SIGNAL OUT]", {
              type: pc.localDescription.type,
              to: peerId,
              from: selfId,
            });

            socket.emit('signal', {
              to: peerId,
              from: selfId ?? '',
              description: pc.localDescription.toJSON() as SignalPayload['description'],
              streamMeta: streamMeta(),
            });
          }
        } catch (err) {
          console.error("[NEGOTIATION ERROR]", err);
        } finally {
          peer.makingOffer = false;
        }
      };

      // Whether a relay candidate was ever gathered is the single fact that
      // separates "TURN is broken/missing" from every other reason a tile
      // stays black, so it is tracked and reported explicitly.
      let sawRelayCandidate = false;
      let candidateCount = 0;

      pc.onicecandidate = (ev): void => {
        if (ev.candidate) {
          candidateCount += 1;
          if (ev.candidate.type === 'relay') sawRelayCandidate = true;
          // The raw candidate line is logged verbatim so `typ relay` is
          // greppable straight out of the browser console during TURN testing.
          debug(`[webrtc] ICE candidate (${peerId}):`, ev.candidate.candidate);

          socket.emit('signal', {
            to: peerId,
            from: selfId ?? '',
            candidate: ev.candidate.toJSON(),
          });
        }
      };

      pc.onicegatheringstatechange = (): void => {
        debug('[webrtc] ICE gathering state:', peerId, pc.iceGatheringState);
        if (pc.iceGatheringState !== 'complete') return;

        const summary = `${candidateCount} candidate(s), relay candidate: ${sawRelayCandidate ? 'YES' : 'NO'}`;
        if (sawRelayCandidate) {
          debug(`[webrtc] gathering complete for ${peerId} — ${summary}`);
        } else {
          // Always a warning: with relay-only this guarantees failure, and
          // with the normal policy it means strict-NAT peers cannot connect.
          console.warn(
            `[webrtc] gathering complete for ${peerId} — ${summary}. No TURN relay candidate ` +
              'was gathered: check TURN_URLS/TURN_USERNAME/TURN_CREDENTIAL on the server and ' +
              `that GET /ice returns them.${FORCE_TURN_FOR_TEST ? ' Relay-only test mode is on, so this connection cannot succeed.' : ''}`,
          );
        }
      };

      pc.oniceconnectionstatechange = (): void => {
        debug('[webrtc] ICE connection state:', peerId, pc.iceConnectionState);
        const state = pc.iceConnectionState;

        if (state === 'failed') {
          if (disconnectTimer) {
            clearTimeout(disconnectTimer);
            disconnectTimer = undefined;
          }
          // Warn (not `debug`) so this survives into production: a failed ICE
          // negotiation is exactly the black tile users report, and without a
          // line here there is nothing to go on.
          console.warn(
            `[webrtc] ICE failed for peer ${peerId}, restarting.` +
              (sawRelayCandidate
                ? ' A relay candidate was gathered, so TURN allocation worked — the relay' +
                  ' may be unreachable from the remote peer, or its credentials expired.'
                : ' No relay candidate was gathered, so a strict/symmetric NAT on either' +
                  ' side cannot be traversed — check TURN config (docs/DEPLOYMENT.md).'),
          );
          debug("[ICE RESTART]", peerId);
          pc.restartIce();
        } else if (state === 'disconnected') {
          // `disconnected` is often transient (brief packet loss, a network
          // handoff) and self-heals within a couple seconds; some browsers
          // also never promote a stuck `disconnected` to `failed`, so without
          // this timer a dropped connection can stay black forever. Give it a
          // grace window, then force a restart if it hasn't recovered.
          if (!disconnectTimer) {
            disconnectTimer = setTimeout(() => {
              disconnectTimer = undefined;
              if (pc.iceConnectionState === 'disconnected') {
                debug("[ICE RESTART after disconnect]", peerId);
                pc.restartIce();
              }
            }, 3000);
          }
        } else {
          if (disconnectTimer) {
            clearTimeout(disconnectTimer);
            disconnectTimer = undefined;
          }
        }
      };

      pc.ontrack = (ev): void => {
        debug("[TRACK]", ev.track.kind, ev.streams);
        let stream = ev.streams[0];

        if (!stream) {
          stream = new MediaStream([ev.track]);
        }
        const kind = peer.remoteMeta[stream.id] ?? 'camera';
        setFeeds((prev) => {
          const without = prev.filter((f) => !(f.peerId === peerId && f.stream.id === stream.id));
          return [...without, { peerId, stream, kind }];
        });
        stream.onremovetrack = (): void => {
          if (stream.getTracks().length === 0) removeFeedsFor(peerId, stream.id);
        };
      };

      peersRef.current.set(peerId, peer);
      return peer;
    },
    [selfId, streamMeta, removeFeedsFor],
  );

  /**
   * The single entry point for opening a connection. Every RTCPeerConnection in
   * the app is built here, from the ICE servers `GET /ice` returned — so a peer
   * is never created with a guessed or empty configuration.
   *
   * Async because the config is fetched. The fetch is cached after the first
   * call, so this is a round trip once per page load and a resolved promise
   * afterwards.
   */
  const ensurePeer = useCallback(
    async (peerId: string): Promise<PeerRecord | null> => {
      const existing = peersRef.current.get(peerId);
      if (existing) return existing;

      const ice = await getIceServers();
      if (!activeRef.current) return null; // call ended while we were fetching

      // Another signal for the same peer may have won the race while awaiting.
      const raced = peersRef.current.get(peerId);
      if (raced) return raced;

      const peer = createPeer(peerId, ice);
      syncAllTracks();
      return peer;
    },
    [createPeer, syncAllTracks],
  );

  /**
   * Surfaces an ICE-config failure through the app's existing toast mechanism.
   * The message is deliberately generic: `err` can name the endpoint but must
   * never carry TURN credentials into the UI.
   */
  const reportIceFailure = useCallback((err: unknown): void => {
    console.error('[webrtc] could not load ICE servers from', ICE_ENDPOINT, err);
    useRoomStore
      .getState()
      .toast(
        'error',
        'Could not reach the connection service, so video cannot start. Retry in a moment.',
        'ice-config-failed',
      );
  }, []);

  /** Incoming signaling, one listener for all peers. */
  useEffect(() => {
    if (!active) return;

    /** Applies one signal. Runs to completion before the peer's next one. */
    const applySignal = async (peer: PeerRecord, payload: SignalPayload): Promise<void> => {
      const peerId = payload.from;
      if (payload.streamMeta) peer.remoteMeta = { ...peer.remoteMeta, ...payload.streamMeta };
      const { pc } = peer;

      try {
        if (payload.description) {
          const description = payload.description as RTCSessionDescriptionInit;
          const collision =
            description.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');
          peer.ignoreOffer = !peer.polite && collision;
          if (peer.ignoreOffer) return;
          await pc.setRemoteDescription(description);
          if (description.type === 'offer') {
            await pc.setLocalDescription();
            if (pc.localDescription) {
              socket.emit('signal', {
                to: peerId,
                from: selfId ?? '',
                description: pc.localDescription.toJSON() as SignalPayload['description'],
                streamMeta: streamMeta(),
              });
            }
          }
        } else if (payload.candidate) {
          try {
            debug("[ICE IN]", payload.candidate);
            await pc.addIceCandidate(payload.candidate as RTCIceCandidateInit);
          } catch (err) {
            if (!peer.ignoreOffer) throw err;
          }
        }
      } catch {
        /* a broken negotiation recovers via ICE restart / next offer */
      }
    };

    const handler = (payload: SignalPayload): void => {
      debug("[SIGNAL IN]", payload);

      const peerId = payload.from;
      if (!peerId || peerId === selfId) return;

      // Apply strictly in arrival order. Both `ensurePeer` (it fetches /ice)
      // and `applySignal` await, so firing each packet independently lets an
      // ICE candidate overtake the offer it belongs to: `addIceCandidate` then
      // rejects (no remote description yet) and that candidate is lost for
      // good, stranding ICE in `checking` with a black tile. Chaining per peer
      // keeps offer → answer → candidates in the order the server relayed them.
      const prev = signalChains.current.get(peerId) ?? Promise.resolve();
      const next = prev
        .then(async () => {
          const peer = await ensurePeer(peerId);
          if (peer) await applySignal(peer, payload);
        })
        .catch(reportIceFailure);
      signalChains.current.set(peerId, next);
    };
    socket.on('signal', handler);
    return () => {
      socket.off('signal', handler);
    };
  }, [active, selfId, ensurePeer, reportIceFailure, streamMeta]);

  /**
   * Warm the ICE config as soon as the room page mounts, so the first
   * connection does not pay for the round trip, and so a misconfigured `/ice`
   * is reported while the user is still in the lobby rather than mid-call.
   */
  useEffect(() => {
    void getIceServers().then(
      (servers) => {
        debug(`[webrtc] ICE config loaded from ${ICE_ENDPOINT} — ${describeIceServers(servers)}`);
        if (FORCE_TURN_FOR_TEST) {
          console.warn(
            '[webrtc] TURN TEST MODE is ON (iceTransportPolicy: "relay"). All media is forced ' +
              'through the TURN relay — this verifies TURN works but is not a production ' +
              'setting. Disable with VITE_FORCE_TURN=false (see client/src/lib/iceConfig.ts).',
          );
        }
        if (!hasTurn(servers)) {
          console.warn(
            '[webrtc] No TURN relay in the /ice response. Peers on the same network still ' +
              'connect, but a pair behind strict/symmetric NAT (~10-15%) will join the room ' +
              'and never exchange video. Set TURN_URLS + TURN_USERNAME/TURN_CREDENTIAL on the ' +
              'signaling server — see docs/DEPLOYMENT.md.',
          );
        }
      },
      // Not surfaced to the user here: nothing is broken until a call is
      // actually attempted, and `ensurePeer` reports it then.
      (err: unknown) => console.error('[webrtc] ICE config preload failed:', err),
    );
  }, []);

  /** Open connections to newcomers; tear down leavers. */
  useEffect(() => {
    if (!active || !selfId) return;
    const current = new Set((participants ?? []).map((p) => p.id));
    current.delete(selfId);

    for (const peerId of current) {
      if (!peersRef.current.has(peerId)) {
        void ensurePeer(peerId).catch(reportIceFailure);
      }
    }
    for (const [peerId, peer] of peersRef.current) {
      if (!current.has(peerId)) {
        peer.pc.close();
        peersRef.current.delete(peerId);
        signalChains.current.delete(peerId);
        removeFeedsFor(peerId);
      }
    }
    syncAllTracks();
  }, [active, selfId, participants, ensurePeer, reportIceFailure, removeFeedsFor, syncAllTracks]);

  /** Keep senders in step with the local streams. */
  useEffect(() => {
    syncAllTracks();
  }, [localStream, screenStream, syncAllTracks]);

  /**
   * A transport drop invalidates the whole mesh. The moment the server marks
   * this client offline it disappears from everyone's participant list, so
   * every remote peer closes its RTCPeerConnection to us — but the ones we
   * hold are left behind, half-dead and pointing at certificates/ICE
   * credentials the other side has already thrown away. Feeding the fresh
   * offers that follow a rejoin into those stale connections either fails
   * outright (mismatched m-lines) or leaves a frozen tile. Drop them here and
   * let the rejoin's `room:state` rebuild the mesh symmetrically.
   */
  useEffect(() => {
    if (!active) return;
    const onReconnect = (): void => {
      debug('[RECONNECT] rebuilding peer mesh');
      for (const peer of peersRef.current.values()) peer.pc.close();
      peersRef.current.clear();
      signalChains.current.clear();
      setFeeds([]);
    };
    socket.io.on('reconnect', onReconnect);
    return () => {
      socket.io.off('reconnect', onReconnect);
    };
  }, [active]);

  /** Full teardown when the call ends AND on unmount (no leaked RTCPeerConnections). */
  useEffect(() => {
    const peers = peersRef.current; // stable Map instance for the hook's lifetime
    const chains = signalChains.current;
    if (!active) {
      for (const peer of peers.values()) peer.pc.close();
      peers.clear();
      chains.clear();
      setFeeds([]);
    }
    return () => {
      for (const peer of peers.values()) peer.pc.close();
      peers.clear();
      chains.clear();
    };
  }, [active]);

  return { feeds, peersRef, syncAllTracks };
}

export type PeersRef = ReturnType<typeof usePeerConnections>['peersRef'];
