import { createHmac } from 'node:crypto';
import type { Request, Response } from 'express';
import type { IceServerConfig } from '@syncroom/shared';

export interface IceOptions {
  stunUrls: string[];
  turnUrls: string[];
  turnUsername: string;
  turnCredential: string;
  turnSecret: string;
  turnTtlSec: number;
}

/**
 * Builds the STUN/TURN list served by `GET /ice`.
 *
 * STUN alone only solves the easy cases. When both peers sit behind a strict
 * or symmetric NAT (~10-15% of pairs) no candidate pair is ever valid: ICE
 * stalls in `checking`, no media flows, and the tile stays black. A TURN relay
 * is the only fix, and it needs credentials, which is why there is no default.
 *
 * Two credential modes:
 *
 *  - `turnSecret` — coturn's `use-auth-secret` / REST scheme. The username is
 *    an expiry timestamp and the password is its HMAC under a secret shared
 *    with the relay. Nothing long-lived reaches the browser and credentials
 *    age out on their own, so this is the mode to prefer for a relay you run.
 *  - `turnUsername` + `turnCredential` — a static long-term pair, which is
 *    what managed providers hand out.
 */
export function buildIceServers(opts: IceOptions, now: () => number = Date.now): IceServerConfig[] {
  const servers: IceServerConfig[] = [];
  if (opts.stunUrls.length > 0) servers.push({ urls: [...opts.stunUrls] });
  if (opts.turnUrls.length === 0) return servers;

  if (opts.turnSecret) {
    const username = String(Math.floor(now() / 1000) + opts.turnTtlSec);
    servers.push({
      urls: [...opts.turnUrls],
      username,
      credential: createHmac('sha1', opts.turnSecret).update(username).digest('base64'),
    });
  } else if (opts.turnUsername && opts.turnCredential) {
    servers.push({
      urls: [...opts.turnUrls],
      username: opts.turnUsername,
      credential: opts.turnCredential,
    });
  }
  // TURN urls without either credential mode are dropped rather than served
  // unusable: the client's "no relay" warning is then accurate.
  return servers;
}

/** True when the list contains a relay a browser can actually authenticate to. */
export function hasTurn(servers: IceServerConfig[]): boolean {
  return servers.some((s) => s.urls.some((u) => u.startsWith('turn')) && Boolean(s.username));
}

/**
 * `GET /ice` — the browser's only source of ICE configuration.
 *
 * Cross-origin reads reuse the socket allow-list (`CLIENT_ORIGIN`) rather than
 * `*`, because the body carries TURN credentials. Same-origin requests, which
 * is how the single-process production deployment serves it, send no `Origin`
 * and need no header at all.
 */
export function createIceHandler(opts: {
  ice: IceOptions;
  allowOrigin: (origin: string) => boolean;
  now?: () => number;
}): (req: Request, res: Response) => void {
  return (req, res) => {
    const origin = req.headers.origin;
    if (origin && opts.allowOrigin(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    // Never cached: the body is credential-bearing, and with `turnSecret` it
    // is a freshly minted, expiring pair on every request.
    res.setHeader('Cache-Control', 'no-store');
    res.json({ iceServers: buildIceServers(opts.ice, opts.now) });
  };
}
