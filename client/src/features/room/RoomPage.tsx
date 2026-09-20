import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { PhoneOff } from 'lucide-react';
import { expectedTime, normalizeRoomCode, type JoinErrorReason } from '@syncroom/shared';
import { socket, serverNow, startClockSync, stopClockSync } from '@/lib/socket';
import { wireSocketToStore } from '@/lib/wireSocket';
import { getParticipantKey, saveName } from '@/lib/session';
import { useRoomStore } from '@/store/room';
import { useSettings } from '@/store/settings';
import { useLocalMedia } from '@/features/call/useLocalMedia';
import { usePeerConnections } from '@/features/call/usePeerConnections';
import { useCallStats } from '@/features/call/useCallStats';
import { useKeyboardShortcuts, type ShortcutMap } from '@/hooks/useKeyboardShortcuts';
import { useFullscreen } from '@/hooks/useFullscreen';
import { Lobby } from '@/features/lobby/Lobby';
import { TopBar } from './TopBar';
import { VideoGrid } from './VideoGrid';
import { FloatingThumbs } from './FloatingThumbs';
import { ControlBar } from './ControlBar';
import { SEEK_STEP_S, seekBy, toggleCamera, toggleMic } from './mediaActions';
import { ParticipantsPanel } from './ParticipantsPanel';
import { ChatPanel } from '@/features/chat/ChatPanel';
import { SyncPanel } from '@/features/sync/SyncPanel';
import { PlayerStage } from '@/features/sync/PlayerStage';
import { SettingsModal } from '@/features/settings/SettingsModal';
import { Toasts } from '@/components/ui/Toasts';
import { Button } from '@/components/ui/Button';

const IN_ROOM_KEY = 'syncroom:in-room';

const JOIN_ERRORS: Record<JoinErrorReason, string> = {
  'not-found': 'This room does not exist (or already ended). Check the code.',
  locked: 'The host locked this room.',
  'invalid-code': 'That room code is not valid.',
  'invalid-name': 'That name is not valid.',
  duplicate: 'You are already in this room in another tab.',
  'room-exists':
    'A room with this code already exists, joining it instead requires the plain link.',
  'rate-limited': 'Too many attempts. Wait a moment and try again.',
  'room-full': 'This room is full (8 participants max).',
};

export function RoomPage() {
  const params = useParams<{ code: string }>();
  const code = normalizeRoomCode(params.code ?? '');
  const [search, setSearch] = useSearchParams();
  const navigate = useNavigate();

  const joined = useRoomStore((s) => s.joined);
  const ending = useRoomStore((s) => s.ending);
  const micOn = useRoomStore((s) => s.micOn);
  const cameraOn = useRoomStore((s) => s.cameraOn);
  const panel = useRoomStore((s) => s.panel);
  const setPanel = useRoomStore((s) => s.setPanel);
  const setMedia = useRoomStore((s) => s.setMedia);
  const hasMedia = useRoomStore((s) => s.syncState?.media != null);
  const mirrorVideo = useSettings((s) => s.mirrorVideo);

  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null);
  /* Ref mirror so the unmount cleanup can stop tracks without stale closures. */
  const screenStreamRef = useRef<MediaStream | null>(null);
  screenStreamRef.current = screenStream;
  useEffect(
    () => () => {
      screenStreamRef.current?.getTracks().forEach((t) => t.stop());
    },
    [],
  );

  const local = useLocalMedia();
  const { feeds, peersRef, syncAllTracks } = usePeerConnections({
    active: joined,
    localStream: local.stream,
    screenStream,
  });
  const stats = useCallStats(peersRef, joined);

  /* Two fullscreen targets: the media stage (cinema mode, keeps thumbnails,
     chat overlays and the floating bar inside) when media is active, the
     whole page otherwise. Both are strictly local. */
  const pageRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const pageFs = useFullscreen(pageRef);
  const stageFs = useFullscreen(stageRef);
  const stageFsExit = stageFs.exit;
  const stageFsToggle = stageFs.toggle;
  const pageFsToggle = pageFs.toggle;
  const pageFsExit = pageFs.exit;

  const isFullscreen = stageFs.isFullscreen || pageFs.isFullscreen;
  const toggleFullscreen = useCallback((): void => {
    if (useRoomStore.getState().syncState?.media) stageFsToggle();
    else pageFsToggle();
  }, [stageFsToggle, pageFsToggle]);

  /* Media cleared (or room ended) while in cinema fullscreen → leave it. */
  useEffect(() => {
    if (!hasMedia && stageFs.isFullscreen) stageFsExit();
  }, [hasMedia, stageFs.isFullscreen, stageFsExit]);

  /* Honor the "join with mic/camera off" preferences before the lobby
     preview and the join handshake read these flags. Runs once per mount. */
  useEffect(() => {
    const s = useSettings.getState();
    useRoomStore.getState().setMedia({ micOn: !s.startMicOff, cameraOn: !s.startCameraOff });
  }, []);

  /* Connect socket + listeners for the lifetime of this page. */
  useEffect(() => {
    wireSocketToStore();
    socket.connect();
    startClockSync();
    return () => {
      stopClockSync();
      socket.emit('room:leave');
      socket.disconnect();
      useRoomStore.getState().reset();
    };
  }, []);

  const join = useCallback(
    (name: string): void => {
      saveName(name);
      setJoining(true);
      setJoinError('');

      // Guard against an infinite "Joining…" spinner. If the socket can't reach
      // the signaling server (server asleep/cold-starting, unreachable, or
      // VITE_SERVER_URL misconfigured so the handshake never completes) the ack
      // below never fires. This timeout surfaces an actionable error instead of
      // hanging forever. `settled` makes the ack and the timeout mutually
      // exclusive so a late ack can't clobber a shown error (or vice versa).
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        setJoining(false);
        setJoinError(
          socket.connected
            ? 'The server did not respond. Please try again.'
            : 'Cannot reach the server. It may be waking up (up to ~30s on the free tier), retry in a moment. If this persists, the server URL may be misconfigured.',
        );
      }, 20_000);

      socket.emit(
        'room:join',
        {
          code,
          name,
          participantKey: getParticipantKey(),
          create: search.get('create') === '1',
        },
        (res) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          setJoining(false);
          if (!res.ok || !res.selfId || !res.room) {
            setJoinError(JOIN_ERRORS[res.reason ?? 'not-found']);
            return;
          }
          useRoomStore.getState().setJoined(res.selfId, res.room, res.chatHistory ?? []);
          sessionStorage.setItem(IN_ROOM_KEY, code);
          if (search.get('create')) setSearch({}, { replace: true });
        },
      );
    },
    [code, search, setSearch],
  );

  /* Silent rejoin after a transport drop or server restart. */
  useEffect(() => {
    const onReconnect = (): void => {
      startClockSync();
      const st = useRoomStore.getState();
      if (!st.joined || sessionStorage.getItem(IN_ROOM_KEY) !== code) return;
      const name = st.room?.participants.find((p) => p.id === st.selfId)?.name ?? 'Guest';

      // `create` covers one case only: the server restarted while we were away
      // and the room went with it. Sending it on every rejoin made an ordinary
      // reconnect look like an attempt to create a room that already exists,
      // which the server refuses (`room-exists`) whenever anyone else is still
      // connected, so the dropped member never got back in, dropped out of the
      // participant list, and every peer tore their video down. Rejoin plainly
      // first and only recreate when the room really is gone. A failure is
      // surfaced now instead of leaving the tab silently orphaned.
      const attempt = (create: boolean): void => {
        socket.emit(
          'room:join',
          { code, name, participantKey: getParticipantKey(), create },
          (res) => {
            if (res.ok && res.selfId && res.room) {
              st.setJoined(res.selfId, res.room, res.chatHistory ?? []);
              st.toast('success', 'Reconnected.');
            } else if (!create && res.reason === 'not-found') {
              attempt(true);
            } else {
              st.toast('error', JOIN_ERRORS[res.reason ?? 'not-found']);
            }
          },
        );
      };
      attempt(false);
    };
    socket.io.on('reconnect', onReconnect);
    return () => {
      socket.io.off('reconnect', onReconnect);
    };
  }, [code]);

  /* Mirror mic/cam flags into tracks + presence.
     Presence is emitted only when a flag actually transitions, never as a
     side effect of unrelated re-renders (that once caused an emit/broadcast
     feedback loop and rate-limit toast spam). */
  const sentPresence = useRef<{
    micOn: boolean | null;
    cameraOn: boolean | null;
    mirrored: boolean | null;
  }>({
    micOn: null,
    cameraOn: null,
    mirrored: null,
  });
  useEffect(() => {
    local.setTrackEnabled('audio', micOn);
    if (joined && sentPresence.current.micOn !== micOn) {
      sentPresence.current.micOn = micOn;
      socket.emit('presence:update', { micOn });
    }
  }, [micOn, joined, local]);
  useEffect(() => {
    local.setTrackEnabled('video', cameraOn);
    if (joined && sentPresence.current.cameraOn !== cameraOn) {
      sentPresence.current.cameraOn = cameraOn;
      socket.emit('presence:update', { cameraOn });
    }
  }, [cameraOn, joined, local]);
  /* Broadcast the "mirror my video" preference so everyone renders this
     participant's tile flipped (or not). Emitted on join and on every change. */
  useEffect(() => {
    if (joined && sentPresence.current.mirrored !== mirrorVideo) {
      sentPresence.current.mirrored = mirrorVideo;
      socket.emit('presence:update', { mirrored: mirrorVideo });
    }
  }, [mirrorVideo, joined]);
  /* Reset the change tracker when leaving so a rejoin re-announces flags. */
  useEffect(() => {
    if (!joined) sentPresence.current = { micOn: null, cameraOn: null, mirrored: null };
  }, [joined]);

  const stopShare = useCallback((): void => {
    setScreenStream((s) => {
      s?.getTracks().forEach((t) => t.stop());
      return null;
    });
    setMedia({ sharing: false });
    if (socket.connected) socket.emit('presence:update', { screenSharing: false });
  }, [setMedia]);

  const toggleShare = useCallback(async (): Promise<void> => {
    if (screenStream) {
      stopShare();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30 } },
        audio: true,
      });
      stream.getVideoTracks().forEach((t) => {
        t.contentHint = 'detail';
        t.onended = stopShare; // browser "stop sharing" button
      });
      setScreenStream(stream);
      setMedia({ sharing: true });
      socket.emit('presence:update', { screenSharing: true });
    } catch {
      /* user cancelled the picker */
    }
  }, [screenStream, stopShare, setMedia]);

  const leave = useCallback((): void => {
    stageFsExit();
    pageFsExit();
    stopShare();
    local.stop();
    sessionStorage.removeItem(IN_ROOM_KEY);
    navigate('/');
  }, [stopShare, local, navigate, stageFsExit, pageFsExit]);

  /* Space toggles synced playback for controllers. */
  const togglePlayback = useCallback((): void => {
    const st = useRoomStore.getState();
    const sync = st.syncState;
    if (!sync?.media) return;
    const canControl = st.room?.controlMode === 'everyone' || st.room?.hostId === st.selfId;
    if (!canControl) return;
    const now = expectedTime(sync, serverNow());
    if (sync.playing) socket.emit('sync:pause', { time: now, eventId: crypto.randomUUID() });
    else socket.emit('sync:play', { time: sync.time, eventId: crypto.randomUUID() });
  }, []);

  const shortcuts = useMemo<ShortcutMap>(
    () => ({
      m: toggleMic,
      v: toggleCamera,
      s: () => void toggleShare(),
      arrowleft: () => void seekBy(-SEEK_STEP_S),
      arrowright: () => void seekBy(SEEK_STEP_S),
      c: () => setPanel(useRoomStore.getState().panel === 'chat' ? null : 'chat'),
      p: () => setPanel(useRoomStore.getState().panel === 'people' ? null : 'people'),
      w: () => setPanel(useRoomStore.getState().panel === 'media' ? null : 'media'),
      f: toggleFullscreen,
      space: togglePlayback,
      escape: () => setPanel(null),
    }),
    [setPanel, toggleShare, toggleFullscreen, togglePlayback],
  );
  useKeyboardShortcuts(joined ? shortcuts : {});

  /* Kicked / meeting ended overlay. */
  if (ending) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-4 p-6 text-center">
        <span className="flex h-14 w-14 items-center justify-center rounded-full bg-danger/15 text-danger">
          <PhoneOff size={24} />
        </span>
        <h1 className="text-xl font-semibold">
          {ending === 'kicked' ? 'You were removed from the room' : 'The host ended this meeting'}
        </h1>
        <Button onClick={leave}>Back to home</Button>
      </div>
    );
  }

  if (!joined) {
    return (
      <>
        <Lobby
          code={code}
          local={local}
          joining={joining}
          joinError={joinError}
          autoJoin={sessionStorage.getItem(IN_ROOM_KEY) === code}
          onJoin={join}
        />
        <Toasts />
      </>
    );
  }

  const panelTitle = panel === 'chat' ? 'Chat' : panel === 'people' ? 'People' : 'Watch together';

  return (
    <div ref={pageRef} className="flex h-dvh flex-col overflow-x-hidden bg-surface">
      <TopBar stats={stats} onOpenSettings={() => setSettingsOpen(true)} />

      <div className="flex min-h-0 flex-1 gap-3 px-3 pb-2">
        <main className="min-h-0 min-w-0 flex-1">
          {hasMedia ? (
            <div className="flex h-full min-h-0 flex-col gap-2 lg:flex-row">
              <div className="min-h-0 flex-1">
                <PlayerStage
                  fsRef={stageRef}
                  isFullscreen={stageFs.isFullscreen}
                  onToggleFullscreen={stageFsToggle}
                  onLeave={leave}
                  thumbs={
                    <FloatingThumbs
                      localStream={local.stream}
                      screenStream={screenStream}
                      feeds={feeds}
                      stats={stats}
                    />
                  }
                />
              </div>
              <div className="h-28 shrink-0 lg:h-auto lg:w-52">
                <VideoGrid
                  strip
                  localStream={local.stream}
                  screenStream={screenStream}
                  feeds={feeds}
                  stats={stats}
                />
              </div>
            </div>
          ) : (
            <VideoGrid
              localStream={local.stream}
              screenStream={screenStream}
              feeds={feeds}
              stats={stats}
            />
          )}
        </main>

        {/* In cinema fullscreen the stage renders its own overlays; skip the
            page-level panel so components (and their effects) aren't doubled. */}
        {panel && !stageFs.isFullscreen && (
          <aside
            className="glass fixed inset-x-2 bottom-24 top-16 z-30 flex flex-col overflow-hidden rounded-2xl shadow-2xl animate-slide-in-right sm:static sm:inset-auto sm:z-auto sm:w-80 sm:shrink-0"
            aria-label={panelTitle}
          >
            <div className="flex items-center justify-between border-b border-line px-4 py-3">
              <h2 className="text-sm font-semibold">{panelTitle}</h2>
              <button
                type="button"
                aria-label="Close panel"
                className="cursor-pointer rounded-lg px-2 py-1 text-xs text-ink-faint transition-colors hover:bg-surface-overlay hover:text-ink"
                onClick={() => setPanel(null)}
              >
                Esc
              </button>
            </div>
            <div className="min-h-0 flex-1">
              {panel === 'chat' && <ChatPanel />}
              {panel === 'people' && <ParticipantsPanel />}
              {panel === 'media' && <SyncPanel />}
            </div>
          </aside>
        )}
      </div>

      <footer className="px-3 pb-3">
        <ControlBar
          onToggleMic={toggleMic}
          onToggleCamera={toggleCamera}
          onToggleShare={() => void toggleShare()}
          onLeave={leave}
          onToggleFullscreen={toggleFullscreen}
          isFullscreen={isFullscreen}
        />
      </footer>

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onDeviceChange={(kind, deviceId) => {
          const op =
            kind === 'camera' ? local.switchCamera(deviceId) : local.switchMicrophone(deviceId);
          void op.then(() => syncAllTracks());
        }}
        onReacquire={() => {
          // Re-capture with the new resolution/frame-rate/audio-processing and
          // push the fresh tracks to every peer (also re-applies encoder bitrate).
          void local.acquire().then(() => syncAllTracks());
        }}
      />
      <Toasts />
    </div>
  );
}
