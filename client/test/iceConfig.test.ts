import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as IceConfigModule from '../src/lib/iceConfig';

/**
 * The module reads `import.meta.env` at import time, so each test that cares
 * about a flag re-imports it after stubbing.
 */
async function freshModule(): Promise<typeof IceConfigModule> {
  vi.resetModules();
  return import('../src/lib/iceConfig');
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json; charset=utf-8' }),
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

const TURN_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302'] },
  {
    urls: ['turn:global.relay.metered.ca:80', 'turns:global.relay.metered.ca:443?transport=tcp'],
    username: 'from-env-not-source',
    credential: 'from-env-not-source',
  },
];

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('getIceServers', () => {
  it('returns the iceServers the backend sent', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ iceServers: TURN_SERVERS }));
    const { getIceServers } = await freshModule();

    await expect(getIceServers()).resolves.toEqual(TURN_SERVERS);
  });

  it('requests /ice same-origin with no-store', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ iceServers: TURN_SERVERS }));
    const { getIceServers, ICE_ENDPOINT } = await freshModule();
    await getIceServers();

    expect(ICE_ENDPOINT).toBe('/ice');
    expect(fetchMock).toHaveBeenCalledWith('/ice', expect.objectContaining({ cache: 'no-store' }));
  });

  it('uses VITE_SERVER_URL when the backend is a different origin', async () => {
    vi.stubEnv('VITE_SERVER_URL', 'https://havnn.onrender.com/');
    fetchMock.mockResolvedValue(jsonResponse({ iceServers: TURN_SERVERS }));
    const { getIceServers, ICE_ENDPOINT } = await freshModule();
    await getIceServers();

    expect(ICE_ENDPOINT).toBe('https://havnn.onrender.com/ice');
    expect(fetchMock).toHaveBeenCalledWith('https://havnn.onrender.com/ice', expect.anything());
  });

  it('fetches once and caches the result', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ iceServers: TURN_SERVERS }));
    const { getIceServers } = await freshModule();

    await Promise.all([getIceServers(), getIceServers()]);
    await getIceServers();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('getIceServers failure handling', () => {
  it('throws on a non-ok status instead of falling back', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 503));
    const { getIceServers } = await freshModule();

    await expect(getIceServers()).rejects.toThrow('Failed to load ICE servers: 503');
  });

  it('throws when the list is missing or empty', async () => {
    const { getIceServers, resetIceServersCache } = await freshModule();

    for (const body of [{}, { iceServers: [] }, { iceServers: 'nope' }, { iceServers: [{}] }]) {
      resetIceServersCache();
      fetchMock.mockResolvedValue(jsonResponse(body));
      await expect(getIceServers()).rejects.toThrow('No ICE servers returned by server');
    }
  });

  it('throws a diagnosable error when /ice falls through to the SPA', async () => {
    // Exactly what havnn.onrender.com/ice returned before this route shipped:
    // HTTP 200 with the landing page, not a 404.
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/html; charset=UTF-8' }),
      json: () => Promise.reject(new SyntaxError('Unexpected token <')),
    } as unknown as Response);
    const { getIceServers } = await freshModule();

    await expect(getIceServers()).rejects.toThrow(/missing the \/ice route/);
  });

  it('never resolves to an empty configuration', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ iceServers: [] }));
    const { getIceServers } = await freshModule();

    await expect(getIceServers()).rejects.toThrow();
  });

  it('retries on the next call after a failure', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('network down'));
    fetchMock.mockResolvedValueOnce(jsonResponse({ iceServers: TURN_SERVERS }));
    const { getIceServers } = await freshModule();

    await expect(getIceServers()).rejects.toThrow('network down');
    await expect(getIceServers()).resolves.toEqual(TURN_SERVERS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('peer connection configuration', () => {
  it('passes the fetched servers straight into the RTCPeerConnection config', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ iceServers: TURN_SERVERS }));
    const { getIceServers, peerConnectionConfig } = await freshModule();

    const config = peerConnectionConfig(await getIceServers());

    expect(config.iceServers).toEqual(TURN_SERVERS);
    expect(new Set(Object.keys(config))).toEqual(new Set(['iceServers', 'iceTransportPolicy']));
  });

  it('forces relay-only transport while the TURN test flag is on', async () => {
    vi.stubEnv('VITE_FORCE_TURN', 'true');
    const { FORCE_TURN_FOR_TEST, ICE_TRANSPORT_POLICY, peerConnectionConfig } = await freshModule();

    expect(FORCE_TURN_FOR_TEST).toBe(true);
    expect(ICE_TRANSPORT_POLICY).toBe('relay');
    expect(peerConnectionConfig(TURN_SERVERS).iceTransportPolicy).toBe('relay');
  });

  it('restores normal P2P transport with VITE_FORCE_TURN=false', async () => {
    vi.stubEnv('VITE_FORCE_TURN', 'false');
    const { FORCE_TURN_FOR_TEST, ICE_TRANSPORT_POLICY, peerConnectionConfig } = await freshModule();

    expect(FORCE_TURN_FOR_TEST).toBe(false);
    expect(ICE_TRANSPORT_POLICY).toBe('all');
    expect(peerConnectionConfig(TURN_SERVERS).iceTransportPolicy).toBe('all');
  });
});

describe('diagnostics helpers', () => {
  it('detects a credentialed relay', async () => {
    const { hasTurn } = await freshModule();

    expect(hasTurn(TURN_SERVERS)).toBe(true);
    expect(hasTurn([{ urls: ['stun:stun.l.google.com:19302'] }])).toBe(false);
    // TURN urls with no credentials cannot authenticate, so they do not count.
    expect(hasTurn([{ urls: ['turn:relay.example.com:3478'] }])).toBe(false);
  });

  it('summarises without leaking credentials', async () => {
    const { describeIceServers } = await freshModule();
    const summary = describeIceServers(TURN_SERVERS);

    expect(summary).toContain('credentialed relay: yes');
    expect(summary).not.toContain('from-env-not-source');
  });
});

describe('secret hygiene', () => {
  it('has no TURN credentials or provider API keys committed in the source', () => {
    const root = path.resolve(__dirname, '../..');
    const scanned: string[] = [];

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        if (['node_modules', 'dist', '.git', 'coverage', 'test-results'].includes(entry)) continue;
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx|js|jsx)$/.test(entry)) scanned.push(full);
      }
    };
    walk(path.join(root, 'client', 'src'));
    walk(path.join(root, 'server', 'src'));
    walk(path.join(root, 'shared', 'src'));

    expect(scanned.length).toBeGreaterThan(0);
    for (const file of scanned) {
      const source = readFileSync(file, 'utf8');
      // A literal credential would appear as a `username`/`credential` field
      // assigned a string rather than read from the environment.
      expect(source, file).not.toMatch(/\b(username|credential)\s*:\s*['"][^'"]+['"]/);
      expect(source, file).not.toMatch(/openrelayproject|apiKey\s*[:=]\s*['"]/i);
    }
  });
});
