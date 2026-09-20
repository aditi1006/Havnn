/**
 * Runtime configuration, read once at boot from the environment.
 *
 * Every scalability knob is configurable so the same image runs on a free
 * Render instance (small caps) or a beefy VPS (large caps) by env alone, no
 * rebuild. Defaults are tuned for a single ~512 MB / shared-CPU instance.
 */

import ffmpegStatic from 'ffmpeg-static';

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

function list(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : fallback;
}

function str(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

/**
 * Public STUN. Several servers, because a single unreachable one means no
 * server-reflexive candidate at all, which silently downgrades every call to
 * host candidates only (works on one LAN, nowhere else).
 *
 * There is deliberately no default TURN here. Relaying costs real bandwidth,
 * so every relay worth pointing at needs credentials; the "free public TURN"
 * endpoints that used to fill this slot now answer every allocation with an
 * error. A default that silently fails is worse than none, because it hides
 * the one thing an operator has to act on.
 */
const DEFAULT_STUN = [
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
  'stun:stun.cloudflare.com:3478',
];

export const config = {
  port: int('PORT', 3001),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  isProduction: (process.env.NODE_ENV ?? 'development') === 'production',

  /**
   * Hard ceiling on concurrent WebSocket clients. New handshakes past this are
   * rejected at the Engine.IO layer (HTTP 403) *before* a socket is allocated,
   * so a connection spike can never starve users who are already in a room.
   * ~512 MB comfortably holds a few hundred idle signaling sockets; 150 leaves
   * generous headroom. Raise on larger instances.
   */
  maxConnections: int('MAX_CONNECTIONS', 150),

  /**
   * Connection-burst smoothing. Handshakes are admitted at up to
   * `connectionBurstPerSec` per second; excess handshakes are *staggered*
   * (delayed up to `connectionMaxStaggerMs`, never dropped) so hundreds of
   * simultaneous joins don't spike CPU or block the event loop. The delay is
   * applied with an unref'd timer, so the loop stays free while waiting.
   */
  connectionBurstPerSec: int('CONNECTION_BURST_PER_SEC', 20),
  connectionMaxStaggerMs: int('CONNECTION_MAX_STAGGER_MS', 500),

  /**
   * Heartbeat. Engine.IO sends a ping every `pingIntervalMs`; if no pong
   * arrives within `pingTimeoutMs` the socket is terminated and our `disconnect`
   * handler frees its room/membership/rate-limiter state. This is what reaps
   * abandoned browser tabs, no separate ping loop is needed (that would just
   * duplicate what the transport already does).
   */
  pingIntervalMs: int('PING_INTERVAL_MS', 30_000),
  pingTimeoutMs: int('PING_TIMEOUT_MS', 60_000),

  /**
   * Max concurrent Google-Drive proxy streams. This is the only path where
   * bytes flow *through* the box (media proper is P2P); without a cap a handful
   * of large streams could saturate the instance's bandwidth/memory. Excess
   * requests get a 503 + Retry-After instead of degrading everyone.
   */
  maxDriveStreams: int('MAX_DRIVE_STREAMS', 8),

  /**
   * On-the-fly Drive transcoding (ffmpeg → HLS). Used when a Drive file's
   * container/codec can't play in a browser <video> (e.g. MPEG-2 .MPG, MKV):
   * the proxy re-encodes the stream to H.264/AAC HLS so it still plays in the
   * SYNCED player instead of dropping to Drive's un-syncable preview iframe.
   *
   * This is CPU-heavy (a live re-encode per distinct file, shared across the
   * viewers watching it), so it is capped hard and disabled where ffmpeg is
   * absent (the request 502s and the client falls back to the unsynced embed,
   * exactly as before). `ffmpegPath` lets a host point at a non-PATH binary.
   */
  transcodeEnabled: bool('TRANSCODE_ENABLED', true),
  // Prefer an explicit override, then the bundled static binary (works on a
  // bare Render/clone with no system ffmpeg), then whatever is on PATH.
  ffmpegPath: process.env.FFMPEG_PATH?.trim() || ffmpegStatic || 'ffmpeg',
  maxTranscodeSessions: int('MAX_TRANSCODE_SESSIONS', 2),
  /**
   * Stall window: the encode fails if NO input bytes arrive AND no first
   * segment appears for this long. Progress (a downloading input) keeps
   * resetting the clock, so a large file that is still transferring is never
   * killed mid-download.
   */
  transcodeStartTimeoutMs: int('TRANSCODE_START_TIMEOUT_MS', 60_000),
  /** Absolute ceiling for the first segment (covers download + probe + encode). */
  transcodeMaxStartMs: int('TRANSCODE_MAX_START_MS', 10 * 60_000),
  /**
   * How long a single playlist request may wait for readiness before returning
   * 503 + Retry-After (the client retries). Kept well under typical reverse-
   * proxy read timeouts (nginx default 60 s) so warming encodes never 504.
   */
  transcodePollWaitMs: int('TRANSCODE_POLL_WAIT_MS', 10_000),
  /** Idle grace after the last playlist/segment hit before a session is reaped. */
  transcodeIdleMs: int('TRANSCODE_IDLE_MS', 60_000),

  /**
   * Self-restart guard. When RSS exceeds this many MB the process logs and
   * exits gracefully so the platform (Render/PM2/systemd) restarts it clean,
   * turning a slow leak into a blip instead of an OOM kill. 0 disables it.
   * On Render free (512 MB) ~450 is a safe value; left off by default so it
   * never surprises a large host.
   */
  memoryLimitMb: int('MEMORY_LIMIT_MB', 0),

  /**
   * Whether this process should also serve the built SPA. Defaults on (single
   * "one process, one port" deployments). Set false in split deployments where
   * a CDN/static host (Vercel, Render Static, Cloudflare, Netlify) serves the
   * frontend and this box handles signaling only, offloading all static I/O.
   */
  serveClient: bool('SERVE_CLIENT', true),

  /**
   * STUN/TURN served to browsers at runtime by `GET /ice`.
   *
   * Runtime rather than build time on purpose: Vite inlines `VITE_*` into the
   * bundle, so changing a relay there means rebuilding and redeploying the
   * SPA. Here it is an env change plus a restart — which is also what makes
   * `turnSecret` (short-lived, per-request credentials) possible at all.
   *
   * Supply `turnUrls` plus EITHER `turnSecret` (coturn `use-auth-secret`,
   * preferred: nothing long-lived ever reaches the browser) OR a static
   * `turnUsername`/`turnCredential` pair (what managed providers hand out).
   */
  ice: {
    stunUrls: list('STUN_URLS', DEFAULT_STUN),
    turnUrls: list('TURN_URLS', []),
    turnUsername: str('TURN_USERNAME', ''),
    turnCredential: str('TURN_CREDENTIAL', ''),
    turnSecret: str('TURN_SECRET', ''),
    /** Lifetime of a generated credential. Must outlast the longest call. */
    turnTtlSec: int('TURN_TTL_SEC', 24 * 60 * 60),
  },
} as const;

export type Config = typeof config;
