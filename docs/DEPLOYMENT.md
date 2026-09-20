# Deployment guide

## Current production: AWS EC2 (havnn.in)

Production runs as a single-server deployment (Option B below) on an Ubuntu
EC2 instance:

- **Process manager:** PM2 runs `node server/dist/index.js` (serves the SPA and
  Socket.IO on one port).
- **Reverse proxy:** Nginx terminates TLS (Let's Encrypt) for `https://havnn.in`
  and proxies everything — including WebSocket upgrades and the `/drive/*`
  streaming/transcoding routes — to the Node process.
- **CI/CD:** every push to `main` triggers `.github/workflows/deploy.yml`,
  which SSHes to the instance and runs `/home/ubuntu/deploy.sh` (pull, install,
  build, PM2 restart).
- **FFmpeg:** Drive transcoding requires a working ffmpeg. The server resolves
  one at boot (`FFMPEG_PATH` → bundled `ffmpeg-static` → `ffmpeg` on PATH) and
  logs which binary it picked; check the PM2 logs for
  `[transcode] using ffmpeg:` after a deploy.

The Render (`render.yaml`) and Vercel (`vercel.json`) configs from the earlier
free-tier deployment have been removed; the sections below are kept as
reference for alternative hosts.

## Option A, free split deploy: Vercel (SPA) + Render (sockets)

Step-by-step instructions live in the [README](../README.md#deploy-for-free-vercel--render). Summary of the moving parts:

| Piece            | Where       | File          | Key config                                                                                                         |
| ---------------- | ----------- | ------------- | ------------------------------------------------------------------------------------------------------------------ |
| SPA (static)     | Vercel      | `vercel.json` | build `npm run build -w client`, output `client/dist`, SPA rewrite → `index.html`, immutable caching for `/assets` |
| Socket.IO server | Render free | `render.yaml` | `npm ci && npm run build -w server`, start `node server/dist/index.js`, health check `/healthz`                    |
| CORS             | Render env  |,             | `CLIENT_ORIGIN` comma list; wildcard `https://*.vercel.app` covers preview deploys (`server/src/cors.ts`)          |
| Socket URL       | Vercel env  |,             | `VITE_SERVER_URL` (build-time; client falls back to same-origin when unset)                                        |
| TURN             | Render env  |,             | `TURN_URLS` + `TURN_SECRET` (or `TURN_USERNAME`/`TURN_CREDENTIAL`); served to the SPA at runtime via `GET /ice`    |

Why this works over HTTPS/WSS with zero extra config: Vercel and Render both terminate TLS. The client connects to `https://…onrender.com`; Socket.IO upgrades to `wss://` on the same connection. WebRTC's secure-context requirement is satisfied by Vercel's HTTPS, and all signaling (SDP/ICE relay) rides the encrypted socket. Media itself is peer-to-peer DTLS-SRTP and never touches either host, which is exactly why the free tiers hold up.

Free-plan caveats (Render): sleeps after ~15 min idle → ~50 s cold start on the next join (live WebSocket connections prevent sleeping mid-call; a 5-minute `/healthz` pinger prevents it entirely, and one always-on free service fits the 750 h/month allowance). Rooms are in-memory by design, a restart just means clients silently auto-rejoin.

Railway was rejected (free tier is now a one-time trial credit) and Fly.io requires a credit card; both remain usable via Option C if you have accounts.

## Option B, single server (one process serves SPA + sockets)

One Node process serves the SPA **and** Socket.IO. No database, no object storage, no queues.

```bash
npm ci
npm run build
PORT=3001 node server/dist/index.js
```

Put any TLS-terminating proxy in front (Caddy, nginx, or the platform's edge). **HTTPS is required in production**, browsers only expose camera/microphone on secure origins.

### Environment variables

| Variable                                      | Where        | Default                 | Purpose                                                                                  |
| --------------------------------------------- | ------------ | ----------------------- | ---------------------------------------------------------------------------------------- |
| `PORT`                                        | server       | `3001`                  | Listen port                                                                              |
| `CLIENT_ORIGIN`                               | server       | `http://localhost:5173` | CORS allow-list, comma-separated; wildcard subdomains (`https://*.vercel.app`) supported |
| `VITE_SERVER_URL`                             | client build | _(same origin)_         | Socket server URL when hosted separately                                                 |
| `STUN_URLS`                                   | server       | Google + Cloudflare     | STUN list served by `GET /ice`, comma-separated                                          |
| `TURN_URLS`                                   | server       | _(none)_                | TURN list served by `GET /ice`, comma-separated (e.g. `turn:turn.example.com:3478`)      |
| `TURN_SECRET`                                 | server       | _(none)_                | coturn `static-auth-secret`; `/ice` mints short-lived credentials from it                |
| `TURN_TTL_SEC`                                | server       | `86400`                 | Lifetime of a generated credential                                                       |
| `TURN_USERNAME` / `TURN_CREDENTIAL`           | server       | _(none)_                | Static TURN credentials, for managed providers (ignored when `TURN_SECRET` is set)       |
| `VITE_FORCE_TURN`                             | client build | `true` (test mode)      | `false` restores normal P2P; `true` forces `iceTransportPolicy: "relay"` to verify TURN   |
| `VITE_WEBRTC_DEBUG`                           | client build | _(off)_                 | `true` enables WebRTC candidate/state tracing in a production build                      |

### Example: Caddy on a $5 VPS

```
meet.example.com {
    reverse_proxy localhost:3001
}
```

Caddy handles TLS + WebSocket upgrade automatically. A 1 vCPU / 512 MB box handles hundreds of concurrent rooms, media is peer-to-peer and never touches the server.

## Option C, container hosts (Fly.io, any Docker platform)

The repo ships a multi-stage [`Dockerfile`](../Dockerfile) building a single full-stack image (server serves the SPA):

```bash
docker build -t syncroom .
docker run -p 3001:3001 -e CLIENT_ORIGIN=https://your.domain syncroom
```

- **Fly.io**, `fly launch` detects the Dockerfile; set `CLIENT_ORIGIN` via `fly secrets set`. Requires a credit card on file (their pay-as-you-go floor), so it's not in the free-first path.
- **Not suitable for the server:** Vercel/Netlify serverless functions (no long-lived WebSockets). They're perfect for the static client (Option A).

## Generic split deployment (any static host + any Node host)

1. Deploy the server anywhere Node runs; set `CLIENT_ORIGIN=https://app.example.com` (comma-list; wildcards allowed).
2. Build the client with `VITE_SERVER_URL=https://ws.example.com` and host `client/dist` on any static host/CDN. Add an SPA fallback rewrite to `index.html` so `/room/<code>` deep links resolve.

## TURN (required in production)

STUN alone fails for ~10–15% of peer pairs (symmetric NATs, strict firewalls). Those peers join the room, appear in the participant list and exchange chat — and never exchange video, because ICE never finds a valid candidate pair. A relay is the only fix.

The client asks the signaling server for its ICE servers at runtime (`GET /ice`), so TURN is **server** env plus a restart, not a client rebuild. The server logs which mode it is in at boot:

```
[syncroom] TURN relay: turn:turn.example.com:3478 (ephemeral credentials)
[syncroom] TURN relay: NOT CONFIGURED — …
```

There is no bundled default. Relaying costs bandwidth, so every usable relay needs credentials; the free public endpoints that used to be pasted into WebRTC samples now reject every allocation, and shipping one would silence the warning while leaving calls just as broken.

### Managed provider (what HAVNN uses: Metered)

Take the credentials from the provider dashboard and set them as **server** environment variables — never in the repo:

```
TURN_URLS=turn:global.relay.metered.ca:80,turn:global.relay.metered.ca:80?transport=tcp,turn:global.relay.metered.ca:443,turns:global.relay.metered.ca:443?transport=tcp
TURN_USERNAME=<from the Metered dashboard>
TURN_CREDENTIAL=<from the Metered dashboard>
```

Listing UDP/80 first and TLS/443 last matters: a peer on a network that only permits outbound 443 still gets a relay candidate via `turns:`. Cloudflare Calls TURN, Twilio NTS and Xirsys work the same way.

### Self-hosted coturn (alternative — it can share the app's box)

```bash
sudo apt install coturn
sudo sed -i 's/^#TURNSERVER_ENABLED=1/TURNSERVER_ENABLED=1/' /etc/default/coturn
```

`/etc/turnserver.conf`:

```
listening-port=3478
tls-listening-port=5349
fingerprint
lt-cred-mech
use-auth-secret
static-auth-secret=<the same value as TURN_SECRET>
realm=turn.example.com
# Public IP of the box; add external-ip=<public>/<private> behind NAT (e.g. EC2).
external-ip=<public-ip>
min-port=49160
max-port=49200
no-cli
```

```bash
sudo systemctl enable --now coturn
```

Open **3478/udp, 3478/tcp and 49160–49200/udp** in the firewall (on EC2, the security group). Then set on the signaling server:

```
TURN_URLS=turn:turn.example.com:3478,turn:turn.example.com:3478?transport=tcp
TURN_SECRET=<the same value as static-auth-secret>
```

`use-auth-secret` means `/ice` mints a short-lived username/password pair per request (HMAC of an expiry timestamp), so no long-lived password ever reaches a browser and nothing has to be rotated by hand. `TURN_TTL_SEC` (default 24 h) sets the lifetime.


### Verifying

Paste the output of `curl https://your-server/ice` into the [Trickle ICE test page](https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/). A working relay yields at least one candidate of type **`relay`**; if you only see `host` and `srflx`, TURN is not working and strict-NAT pairs will still fail.

There is no build-time TURN override. `GET /ice` is the only source of ICE configuration the client uses, so there is exactly one place to look when a relay misbehaves.

### Relay-only test mode

`VITE_FORCE_TURN` (default **on**, see `client/src/lib/iceConfig.ts`) builds every `RTCPeerConnection` with `iceTransportPolicy: "relay"`. The browser then discards host and server-reflexive candidates, so a call that connects proves TURN itself works end to end across networks. With it on, the console logs every candidate line (look for `typ relay`) and warns if gathering completes without one.

Turn it off with `VITE_FORCE_TURN=false` at build time once TURN is verified — relay-only sends 100% of media through the TURN provider, which is metered and adds latency.

## Scaling notes

| Concern                                       | Answer                                                                                                                                               |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| More rooms                                    | Vertical first, signaling is trivial JSON; a single instance goes very far.                                                                         |
| Multiple instances                            | Add sticky sessions + the socket.io Redis adapter, or shard rooms by code prefix at the proxy. Rooms are self-contained, so sharding is clean.       |
| >4–5 people per room, recording, mobile-heavy | Move media to an SFU (LiveKit self-hosted). See `docs/ROADMAP.md`, the room/chat/sync layers are transport-agnostic and survive the swap unchanged. |
| Server restart                                | Clients auto-rejoin with their stable identity; rooms re-form. In-flight chat history is lost (by design, nothing persists).                        |

## Operational checklist

- [ ] HTTPS on (WebRTC requirement)
- [ ] TURN configured (`TURN_URLS` + `TURN_SECRET`); boot log says `TURN relay: …`, not `NOT CONFIGURED`
- [ ] `CLIENT_ORIGIN` set if split-deployed
- [ ] `/healthz` wired to your uptime monitor
- [ ] Reverse proxy timeout ≥ 120 s for WebSocket idle
