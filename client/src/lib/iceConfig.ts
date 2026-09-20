import type { IceConfigResponse, IceServerConfig } from '@syncroom/shared';

/**
 * The one place the frontend obtains ICE (STUN/TURN) configuration.
 *
 * Credentials are fetched from the signaling server's `GET /ice` at runtime and
 * are never baked into the bundle: TURN username/password live in the server's
 * environment (`TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL`, or `TURN_SECRET`
 * for coturn-style ephemeral credentials) so they can be rotated without
 * rebuilding and redeploying the SPA.
 *
 * There is deliberately no offline fallback list. A silent fallback to bare
 * STUN is what makes "works on my LAN, black tile across networks" so hard to
 * diagnose — a failed fetch must surface as a failed connection instead.
 */

/* -------------------------------------------------------------------------- */
/*  TEST MODE — remove or disable once TURN is verified                        */
/* -------------------------------------------------------------------------- */

/**
 * Forces every RTCPeerConnection to use `iceTransportPolicy: 'relay'`, so the
 * browser discards host and server-reflexive candidates and can ONLY connect
 * through the TURN relay. That is the definitive test that TURN works across
 * networks: if a call connects with this on, the relay is good; if nothing
 * connects, TURN is misconfigured.
 *
 * It is NOT a production setting. Relay-only routes 100% of media through the
 * TURN provider — every byte is metered, latency rises and quality drops,
 * which defeats the point of the P2P mesh.
 *
 * Disable with `VITE_FORCE_TURN=false` at build time (no code change), or flip
 * the default below back to `false` once testing is done.
 */
const forceTurnRaw = (import.meta.env.VITE_FORCE_TURN as string | undefined)?.trim().toLowerCase();

export const FORCE_TURN_FOR_TEST: boolean =
  forceTurnRaw === undefined || forceTurnRaw === ''
    ? true // ← TEST DEFAULT. Set to `false` (or VITE_FORCE_TURN=false) when done.
    : forceTurnRaw !== 'false' && forceTurnRaw !== '0' && forceTurnRaw !== 'off';

export const ICE_TRANSPORT_POLICY: RTCIceTransportPolicy = FORCE_TURN_FOR_TEST ? 'relay' : 'all';

/* -------------------------------------------------------------------------- */

/**
 * Same-origin by default — in production one Node process serves both the SPA
 * and the API, so `/ice` resolves against the page's own origin. `VITE_SERVER_URL`
 * is the project's existing mechanism for split deployments (it is what
 * `lib/socket.ts` uses to find the Socket.IO server) and is reused here so both
 * always point at the same backend.
 */
const serverUrl = ((import.meta.env.VITE_SERVER_URL as string | undefined) ?? '').replace(
  /\/+$/,
  '',
);

export const ICE_ENDPOINT = `${serverUrl}/ice`;

export class IceConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IceConfigError';
  }
}

function isServerList(value: unknown): value is IceServerConfig[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (s) =>
        typeof s === 'object' &&
        s !== null &&
        Array.isArray((s as IceServerConfig).urls) &&
        (s as IceServerConfig).urls.length > 0,
    )
  );
}

/** One network round trip. Throws on anything that is not a usable ICE list. */
async function fetchIceServers(): Promise<IceServerConfig[]> {
  const response = await fetch(ICE_ENDPOINT, { cache: 'no-store', credentials: 'omit' });

  if (!response.ok) {
    throw new IceConfigError(`Failed to load ICE servers: ${response.status}`);
  }

  // A deployment whose server predates the /ice route answers 200 with the
  // SPA's index.html (the catch-all route), not a 404. Without this check the
  // failure surfaces as an opaque JSON parse error.
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('json')) {
    throw new IceConfigError(
      `${ICE_ENDPOINT} returned "${contentType || 'no content-type'}" instead of JSON — ` +
        'the deployed server is missing the /ice route (it fell through to the SPA).',
    );
  }

  const data = (await response.json()) as IceConfigResponse;

  if (!isServerList(data.iceServers)) {
    throw new IceConfigError('No ICE servers returned by server');
  }

  return data.iceServers;
}

let cached: Promise<IceServerConfig[]> | null = null;

/**
 * Resolves the ICE servers, fetching at most once per page load. A rejection
 * clears the cache so the next connection attempt retries rather than being
 * stuck behind one bad response.
 */
export function getIceServers(): Promise<IceServerConfig[]> {
  cached ??= fetchIceServers().catch((err: unknown) => {
    cached = null;
    throw err;
  });
  return cached;
}

/** Test seam: drops the cached result. */
export function resetIceServersCache(): void {
  cached = null;
}

/** The exact configuration every RTCPeerConnection in the app is built with. */
export function peerConnectionConfig(iceServers: IceServerConfig[]): RTCConfiguration {
  return {
    iceServers: iceServers as RTCIceServer[],
    iceTransportPolicy: ICE_TRANSPORT_POLICY,
  };
}

/** True when the list contains a relay the browser can authenticate to. */
export function hasTurn(servers: IceServerConfig[]): boolean {
  return servers.some((s) => s.urls.some((u) => u.startsWith('turn')) && Boolean(s.username));
}

/** Credential-free one-liner for logs. Never include username/credential. */
export function describeIceServers(servers: IceServerConfig[]): string {
  const urls = servers.flatMap((s) => s.urls);
  const stun = urls.filter((u) => u.startsWith('stun')).length;
  const turn = urls.filter((u) => u.startsWith('turn')).length;
  return `${stun} STUN url(s), ${turn} TURN url(s), credentialed relay: ${hasTurn(servers) ? 'yes' : 'no'}`;
}
