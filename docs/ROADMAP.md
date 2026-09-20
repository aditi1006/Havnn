# Roadmap

Deliberately deferred features, ordered by value, each with an implementation sketch.

## Near term

- **Background blur / virtual backgrounds**, MediaPipe Selfie Segmentation (or `@mediapipe/tasks-vision`) on a canvas pipeline: `getUserMedia → segmentation → canvas.captureStream() → replaceTrack`. Lazy-load the ~3 MB model only when enabled; needs a WebGL fallback check. This is the only reason it isn't in v1.
- **Vote-to-skip**, new `vote:skip` event; server counts unique voter ids per media item, advances the queue at >50% of connected participants. UI: pill on the player stage.
- **Timestamp comments / bookmarks**, store `{time, text, author}` per media item in room memory; clicking one seeks (controllers) or requests a seek (host approval). Renders as markers on a custom progress bar.
- **Speaking indicator**, `AudioContext` + `AnalyserNode` on local audio, throttled `presence:update({speaking})`; ring highlight on the active tile.
- **Reactions**, ephemeral emoji burst broadcast (`react:send`), rendered as floating particles; no history.

## Medium term

- **SFU mode for larger rooms**, self-hosted [LiveKit](https://livekit.io). Client swap: replace `usePeerConnections`/`useCallStats` with `@livekit/components-react` hooks; server issues LiveKit access tokens on join. Room/chat/sync layers unchanged. Trigger: rooms regularly >4 participants or recording demand.
- **Recording**, only sensible after the SFU step (LiveKit Egress records server-side).
- **Optional auth (Google OAuth)**, gate room creation behind a session; guests keep code-only access. Server gains one `/auth` route + a signed cookie; rooms stay stateless.
- **Persistent chat / rejoin history**, Redis with TTL per room if product needs history across reconnect gaps; deliberately violates the "nothing stored" default, so keep opt-in.
- **Subtitle support**, `.vtt` URL alongside media; `<track>` element for HTML5, custom overlay renderer for YouTube (which exposes its own captions anyway).

## Long term

- Mobile apps (React Native + LiveKit SDK once SFU lands).
- E2E-encrypted media notes: P2P WebRTC is already DTLS-SRTP encrypted hop-to-hop; with an SFU, add insertable streams (E2EE) if the threat model demands it.
- Live co-browsing / whiteboard (CRDT via Yjs over the existing socket).

## Known limitations (accepted for v1)

- Google Drive sync depends on Drive allowing direct download; fallback is unsynced (documented in FEATURES.md).
- Force-mute is advisory (participant may unmute; matches Google Meet behavior).
- No TURN bundled, strict-NAT pairs need a relay configured via `TURN_URLS` (DEPLOYMENT.md).
- Quality preset changes apply on next camera restart, not live (a live path via `applyConstraints` is a small follow-up).
- Playlist reordering is add/remove/play-next only (no drag-sort yet).
