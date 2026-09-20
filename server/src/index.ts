import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextFunction, Request, Response } from 'express';
import express from 'express';
import { Server } from 'socket.io';
import { LIMITS } from '@syncroom/shared';
import type { AppServer } from './handlers';
import { registerHandlers } from './handlers';
import { RoomManager } from './roomManager';
import { driveProxy, QUALITY_HEADERS } from './driveProxy';
import { resolveFfmpeg, TranscodeError, transcodeManager } from './transcode';
import { isOriginAllowed, makeOriginCheck, parseAllowedOrigins } from './cors';
import { config } from './config';
import { buildIceServers, createIceHandler, hasTurn } from './ice';
import { ConnectionGate } from './connectionGate';

const ALLOWED_ORIGINS = parseAllowedOrigins(process.env.CLIENT_ORIGIN);

// Single-service deployments serve the SPA from this same process, so the
// browser's WebSocket handshake is same-origin. Render exposes the public URL
// as RENDER_EXTERNAL_URL, auto-allow it (and its www/non-www) so sockets
// connect without anyone having to hand-set CLIENT_ORIGIN. Harmless elsewhere
// (the var is only present on Render).
const selfOrigin = process.env.RENDER_EXTERNAL_URL?.replace(/\/+$/, '');
if (selfOrigin && !ALLOWED_ORIGINS.includes(selfOrigin)) {
  ALLOWED_ORIGINS.push(selfOrigin);
}
console.log(`[syncroom] allowed origins: ${ALLOWED_ORIGINS.join(', ')}`);

// Whether strict-NAT peers can connect at all is decided entirely here, so say
// so at boot rather than leaving it to be discovered later as "video sometimes
// doesn't arrive".
const bootIce = buildIceServers(config.ice);
console.log(
  hasTurn(bootIce)
    ? `[syncroom] TURN relay: ${config.ice.turnUrls.join(', ')} (${config.ice.turnSecret ? 'ephemeral credentials' : 'static credentials'})`
    : '[syncroom] TURN relay: NOT CONFIGURED — peers behind strict/symmetric NAT (~10-15%) ' +
        'will connect to the room but never exchange video. Set TURN_URLS plus TURN_SECRET ' +
        '(coturn use-auth-secret) or TURN_USERNAME/TURN_CREDENTIAL. See docs/DEPLOYMENT.md.',
);

if (!config.isProduction) {
  console.warn(`[syncroom] NODE_ENV=${config.nodeEnv} (set NODE_ENV=production in deployment)`);
}

const app = express();
app.disable('x-powered-by');

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime(), connections: io.engine.clientsCount });
});

// STUN/TURN handed to browsers at runtime. Keeping this out of the client
// bundle is what makes relay credentials operable: `VITE_*` values are inlined
// at build time, so changing TURN there means rebuilding and redeploying the
// SPA, whereas this is an env var plus a restart. Registered here, well ahead
// of the SPA catch-all at the bottom of this file — a server that predates
// this route answers `/ice` with index.html rather than a 404, which the
// client detects and reports (see client/src/lib/iceConfig.ts).
app.get(
  '/ice',
  createIceHandler({
    ice: config.ice,
    allowOrigin: (origin) => isOriginAllowed(origin, ALLOWED_ORIGINS),
  }),
);

// Streams a public Google Drive file so it plays in the synced HTML5 player
// instead of Drive's un-syncable preview iframe. This is the ONLY path where
// bytes flow through the server (WebRTC media is strictly peer-to-peer), so it
// is capped: past `maxDriveStreams` concurrent streams new requests get a 503
// rather than letting a few large streams saturate the instance. The proxy
// itself streams (never buffers the whole file) and aborts on client close.
let activeDriveStreams = 0;
app.get('/drive/:id', (req: Request, res: Response, next: NextFunction) => {
  // Same-origin (single-service deploy) needs nothing extra. Split deploys
  // (SPA on a CDN, this box for media) need these two so the client-side
  // quality picker's cross-origin fetch can read the X-Drive-* headers below,
  // reusing the same origin allow-list sockets already trust.
  const origin = req.headers.origin;
  if (origin && isOriginAllowed(origin, ALLOWED_ORIGINS)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Expose-Headers', QUALITY_HEADERS.join(', '));
  }
  if (activeDriveStreams >= config.maxDriveStreams) {
    res.status(503).set('Retry-After', '5').json({ error: 'Server busy, please retry shortly.' });
    return;
  }
  activeDriveStreams += 1;
  // Release exactly once. A single movie opens several concurrent range
  // requests, so a leaked slot here quickly starves the cap and 503s every
  // later load; guard against double-fire and differing close/finish semantics
  // across Node versions so the count can never drift up (or below zero).
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    activeDriveStreams -= 1;
  };
  res.on('close', release);
  res.on('finish', release);
  void driveProxy(req, res, { onUnplayable: (fileId) => transcodeManager.prewarm(fileId) }).catch(
    next,
  );
});

// HLS transcode of a Drive file whose container/codec a browser can't decode
// (MPEG-2 .MPG, MKV, AVI, HEVC…). One ffmpeg → HLS encode per file id, shared
// by all its viewers, so the video still plays in the SYNCED player. `:file`
// is either `index.m3u8` (the playlist) or a `segNNNNN.ts` chunk; the manager
// validates the id/name and streams from its temp dir. While the encode warms
// up the playlist answers 503 + Retry-After (hls.js retries); a hard failure
// (ffmpeg absent, bad input, Drive refusal) surfaces as 502 and the client
// falls back to the unsynced embed.
app.get('/drive/:id/hls/:file', (req: Request, res: Response) => {
  const id = String(req.params.id ?? '');
  const file = String(req.params.file ?? '');
  transcodeManager.serve(id, file, res).catch((err: unknown) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const kind = err instanceof TranscodeError ? err.kind : 'ffmpeg';
    if (kind === 'bad-id') {
      res.status(400).json({ error: 'Invalid Drive file id.' });
    } else if (kind === 'pending') {
      res.status(503).set('Retry-After', '2').json({ error: 'Transcode warming up, retry shortly.' });
    } else if (kind === 'busy') {
      res.status(503).set('Retry-After', '10').json({ error: 'Server busy, please retry shortly.' });
    } else {
      const detail = err instanceof Error ? err.message : String(err);
      console.warn(`[transcode] ${id}: request failed (${kind}): ${detail}`);
      res.status(502).json({ error: 'Could not transcode this Drive file for synced playback.' });
    }
  });
});

// In single-process deployments the server also serves the built SPA. In split
// deployments (SPA on a CDN/static host, this box for signaling only) set
// SERVE_CLIENT=false so the process does zero static I/O. Hashed asset files
// are immutable and cached hard; index.html is always revalidated so a deploy
// is picked up immediately.
const dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.resolve(dirname, '../../client/dist');
if (config.serveClient && existsSync(clientDist)) {
  app.use(
    express.static(clientDist, {
      index: 'index.html',
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
        else res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      },
    }),
  );
  app.get('*', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

const httpServer = createServer(app);

// Overload protection + burst smoothing, applied at the handshake (before a
// socket is allocated) via Engine.IO's `allowRequest`.
let lastRejectLogAt = 0;
const gate = new ConnectionGate({
  maxConnections: config.maxConnections,
  burstPerSec: config.connectionBurstPerSec,
  maxStaggerMs: config.connectionMaxStaggerMs,
  currentCount: () => io.engine.clientsCount,
  onReject: (count) => {
    const now = Date.now();
    if (now - lastRejectLogAt > 5000) {
      lastRejectLogAt = now;
      console.warn(`[syncroom] connection rejected: at capacity (${count}/${config.maxConnections})`);
    }
  },
});

const io: AppServer = new Server(httpServer, {
  cors: {
    origin: makeOriginCheck(ALLOWED_ORIGINS),
    methods: ['GET', 'POST'],
  },
  // Attachments are relayed through the socket; allow cap + base64 overhead.
  maxHttpBufferSize: Math.ceil(LIMITS.MAX_ATTACHMENT_BYTES * 1.5),
  // Built-in heartbeat: ping every `pingIntervalMs`, drop the socket if no pong
  // within `pingTimeoutMs`. This is what evicts abandoned tabs; the `disconnect`
  // handler then frees their room/rate-limiter state. No manual ping loop, that
  // would only duplicate the transport's own liveness check.
  pingInterval: config.pingIntervalMs,
  pingTimeout: config.pingTimeoutMs,
  // WebSocket per-message compression OFF by default. On a shared-CPU instance
  // deflate's CPU/memory cost outweighs the benefit: the socket carries only
  // small JSON signaling (media is P2P), and compressing every frame would add
  // latency and allocations under load. Re-enable via a code change only if a
  // profiler shows bandwidth (not CPU) is the bottleneck.
  perMessageDeflate: false,
  allowRequest: gate.allowRequest,
});

const rooms = new RoomManager();
registerHandlers(io, rooms);

// Probe ffmpeg at boot so a missing binary is a loud startup log line, not a
// mystery 502 on the first Drive transcode.
if (config.transcodeEnabled) void resolveFfmpeg();

httpServer.listen(config.port, () => {
  console.log(
    `[syncroom] signaling server listening on :${config.port} ` +
      `(env=${config.nodeEnv}, maxConnections=${config.maxConnections}, ` +
      `serveClient=${config.serveClient && existsSync(clientDist)})`,
  );
});

/* ------------------------------ reliability ------------------------------ */

// Optional self-restart guard: if RSS crosses the limit, exit cleanly so the
// platform restarts a fresh process, turning a slow leak into a brief blip
// instead of an OOM kill. Disabled when memoryLimitMb === 0.
let memoryTimer: NodeJS.Timeout | undefined;
if (config.memoryLimitMb > 0) {
  memoryTimer = setInterval(() => {
    const rssMb = process.memoryUsage().rss / (1024 * 1024);
    if (rssMb > config.memoryLimitMb) {
      console.error(
        `[syncroom] RSS ${rssMb.toFixed(0)}MB exceeded MEMORY_LIMIT_MB=${config.memoryLimitMb}, restarting`,
      );
      shutdown(1);
    }
  }, 30_000);
  memoryTimer.unref();
}

let shuttingDown = false;
function shutdown(code = 0): void {
  if (shuttingDown) return;
  shuttingDown = true;
  if (memoryTimer) clearInterval(memoryTimer);
  // Kill any live ffmpeg encoders and remove their temp dirs.
  void transcodeManager.dispose();
  // Stop new work, let in-flight sockets close, then exit. The unref'd timer is
  // a hard backstop so a hung connection can't block the restart.
  io.close();
  httpServer.close(() => process.exit(code));
  setTimeout(() => process.exit(code), 3000).unref();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

// Never let a stray rejection or exception take the process down uncleanly. A
// rejection is logged (the process stays up); an uncaught exception leaves the
// process in an undefined state, so we log and restart via graceful shutdown.
process.on('unhandledRejection', (reason) => {
  console.error('[syncroom] unhandledRejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[syncroom] uncaughtException:', err);
  shutdown(1);
});
