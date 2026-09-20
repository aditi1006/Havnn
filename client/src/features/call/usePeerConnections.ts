import { useCallback, useEffect, useRef, useState } from 'react';
import type { SignalPayload } from '@syncroom/shared';
import { socket } from '@/lib/socket';
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
  /** Tail of this peer's in-order signal chain, see `applySignal`. */
  queue: Promise<void>;
}

/** Verbose signaling/ICE tracing, dev-only: SDP and candidates are sensitive
 * enough (and noisy enough) that they should never hit a production console. */
function debug(...args: unknown[]): void {
  if (import.meta.env.DEV) console.log(...args);
}

/**
 * ICE configuration, tuned to keep media direct (P2P) and only relay when a
 * direct path is impossible.
 *
 * We list STUN first and TURN (if configured) second. With the default
 * `iceTransportPolicy: 'all'`, the browser gathers host + server-reflexive
 * (STUN) candidates and always *prefers* a direct connection; a TURN `relay`
 * candidate is used only when no direct pair can be established (strict/
 * symmetric NAT, ~10-15% of pairs). We never set `iceTransportPolicy: 'relay'`,
 * which would force every call through TURN and defeat the point of P2P.
 * VITE_TURN_URL may list several URLs (comma-separated), e.g. UDP + TCP/443.
 */
let turnWarningLogged = false;

function iceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [
    {
      urls: [
        'stun:stun.relay.metered.ca:80',
      ],
    },
  ];

  const turnUsername = import.meta.env.VITE_TURN_USERNAME as string | undefined;
  const turnCredential = import.meta.env.VITE_TURN_CREDENTIAL as string | undefined;

  if (turnUsername && turnCredential) {
    servers.push({
      urls: [
        'turn:global.relay.metered.ca:80',
        'turn:global.relay.metered.ca:80?transport=tcp',
        'turn:global.relay.metered.ca:443',
        'turns:global.relay.metered.ca:443?transport=tcp',
      ],
      username: turnUsername,
      credential: turnCredential,
    });
  } else if (!turnWarningLogged) {
    turnWarningLogged = true;

    console.warn(
      '[webrtc] TURN credentials are not configured — calls between peers behind ' +
      'strict/symmetric NATs may fail to connect.',
    );
  }

  return servers;
}

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
    (peerId: string): PeerRecord => {
      const pc = new RTCPeerConnection({ iceServers: iceServers() });
      pc.onsignalingstatechange = () => {
        debug("[SIGNAL STATE]", peerId, pc.signalingState);
      };

      pc.onconnectionstatechange = async () => {
        debug("[CONNECTION STATE]", peerId, pc.connectionState);

        if (pc.connectionState === "connected") {
          const stats = await pc.getStats();

          stats.forEach((report) => {
            if (report.type === "candidate-pair" && report.state === "succeeded") {
              debug("[SELECTED ICE PAIR]", {
                localCandidateId: report.localCandidateId,
                remoteCandidateId: report.remoteCandidateId,
                nominated: report.nominated,
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
        queue: Promise.resolve(),
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

      pc.onicecandidate = (ev): void => {
        debug("[ICE OUT]", ev.candidate);

        if (ev.candidate) {
          debug("[ICE CANDIDATE TYPE]", {
            type: ev.candidate.type,
            protocol: ev.candidate.protocol,
            address: ev.candidate.address,
            port: ev.candidate.port,
          });

          socket.emit('signal', {
            to: peerId,
            from: selfId ?? '',
            candidate: ev.candidate.toJSON(),
          });
        }
      };
      pc.oniceconnectionstatechange = (): void => {
        debug("[ICE STATE]", peerId, pc.iceConnectionState);
        const state = pc.iceConnectionState;

        if (state === 'failed') {
          if (disconnectTimer) {
            clearTimeout(disconnectTimer);
            disconnectTimer = undefined;
          }
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
      let peer = peersRef.current.get(peerId);
      if (!peer) {
        peer = createPeer(peerId);
        syncAllTracks();
      }
      // Apply strictly in arrival order. `applySignal` awaits, so firing each
      // packet independently lets an ICE candidate overtake the offer it
      // belongs to: `addIceCandidate` then rejects (no remote description yet)
      // and that candidate is lost for good, stranding ICE in `checking` with
      // a black tile. Chaining per peer keeps offer → answer → candidates in
      // the order the server relayed them.
      const target = peer;
      peer.queue = peer.queue.then(() => applySignal(target, payload));
    };
    socket.on('signal', handler);
    return () => {
      socket.off('signal', handler);
    };
  }, [active, selfId, createPeer, streamMeta, syncAllTracks]);

  /** Open connections to newcomers; tear down leavers. */
  useEffect(() => {
    if (!active || !selfId) return;
    const current = new Set((participants ?? []).map((p) => p.id));
    current.delete(selfId);

    for (const peerId of current) {
      if (!peersRef.current.has(peerId)) {
        createPeer(peerId);
      }
    }
    for (const [peerId, peer] of peersRef.current) {
      if (!current.has(peerId)) {
        peer.pc.close();
        peersRef.current.delete(peerId);
        removeFeedsFor(peerId);
      }
    }
    syncAllTracks();
  }, [active, selfId, participants, createPeer, removeFeedsFor, syncAllTracks]);

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
    if (!active) {
      for (const peer of peers.values()) peer.pc.close();
      peers.clear();
      setFeeds([]);
    }
    return () => {
      for (const peer of peers.values()) peer.pc.close();
      peers.clear();
    };
  }, [active]);

  return { feeds, peersRef, syncAllTracks };
}

export type PeersRef = ReturnType<typeof usePeerConnections>['peersRef'];
