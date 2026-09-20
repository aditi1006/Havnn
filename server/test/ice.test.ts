import { createHmac } from 'node:crypto';
import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { buildIceServers, createIceHandler, hasTurn, type IceOptions } from '../src/ice';

const base: IceOptions = {
  stunUrls: ['stun:stun.l.google.com:19302'],
  turnUrls: [],
  turnUsername: '',
  turnCredential: '',
  turnSecret: '',
  turnTtlSec: 3600,
};

describe('buildIceServers', () => {
  it('serves STUN only when no relay is configured', () => {
    const servers = buildIceServers(base);
    expect(servers).toEqual([{ urls: ['stun:stun.l.google.com:19302'] }]);
    expect(hasTurn(servers)).toBe(false);
  });

  it('passes through a static credential pair', () => {
    const servers = buildIceServers({
      ...base,
      turnUrls: ['turn:relay.example.com:3478', 'turns:relay.example.com:5349'],
      turnUsername: 'alice',
      turnCredential: 's3cret',
    });
    expect(servers[1]).toEqual({
      urls: ['turn:relay.example.com:3478', 'turns:relay.example.com:5349'],
      username: 'alice',
      credential: 's3cret',
    });
    expect(hasTurn(servers)).toBe(true);
  });

  it('derives coturn use-auth-secret credentials that expire', () => {
    const now = (): number => 1_700_000_000_000;
    const servers = buildIceServers(
      { ...base, turnUrls: ['turn:relay.example.com:3478'], turnSecret: 'shared', turnTtlSec: 600 },
      now,
    );
    const expiry = 1_700_000_000 + 600;
    expect(servers[1]?.username).toBe(String(expiry));
    expect(servers[1]?.credential).toBe(
      createHmac('sha1', 'shared').update(String(expiry)).digest('base64'),
    );
    expect(hasTurn(servers)).toBe(true);
  });

  it('prefers the shared secret over a static pair', () => {
    const servers = buildIceServers({
      ...base,
      turnUrls: ['turn:relay.example.com:3478'],
      turnSecret: 'shared',
      turnUsername: 'alice',
      turnCredential: 's3cret',
    });
    expect(servers[1]?.username).not.toBe('alice');
  });

  it('drops TURN urls with no credentials rather than serving an unusable relay', () => {
    const servers = buildIceServers({ ...base, turnUrls: ['turn:relay.example.com:3478'] });
    expect(servers).toHaveLength(1);
    expect(hasTurn(servers)).toBe(false);
  });
});

/** Minimal express req/res doubles, enough to exercise the route contract. */
function call(
  handler: (req: Request, res: Response) => void,
  origin?: string,
): { body: unknown; headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  let body: unknown;
  const res = {
    setHeader: (k: string, v: string) => {
      headers[k] = v;
    },
    json: vi.fn((payload: unknown) => {
      body = payload;
    }),
  } as unknown as Response;
  handler({ headers: origin ? { origin } : {} } as unknown as Request, res);
  return { body, headers };
}

describe('GET /ice', () => {
  const metered: IceOptions = {
    ...base,
    turnUrls: [
      'turn:global.relay.metered.ca:80',
      'turn:global.relay.metered.ca:80?transport=tcp',
      'turn:global.relay.metered.ca:443',
      'turns:global.relay.metered.ca:443?transport=tcp',
    ],
    turnUsername: 'env-user',
    turnCredential: 'env-credential',
  };

  it('returns usable iceServers in the shape the client expects', () => {
    const handler = createIceHandler({ ice: metered, allowOrigin: () => true });
    const { body } = call(handler);

    const servers = (body as { iceServers: unknown[] }).iceServers;
    expect(Array.isArray(servers)).toBe(true);
    expect(servers.length).toBeGreaterThan(0);
    expect(servers[1]).toMatchObject({
      urls: metered.turnUrls,
      username: 'env-user',
      credential: 'env-credential',
    });
    expect(hasTurn(servers as never)).toBe(true);
  });

  it('never caches a credential-bearing response', () => {
    const handler = createIceHandler({ ice: metered, allowOrigin: () => true });
    expect(call(handler).headers['Cache-Control']).toBe('no-store');
  });

  it('echoes only allow-listed origins and never wildcards', () => {
    const handler = createIceHandler({
      ice: metered,
      allowOrigin: (o) => o === 'https://havnn.in',
    });

    expect(call(handler, 'https://havnn.in').headers['Access-Control-Allow-Origin']).toBe(
      'https://havnn.in',
    );
    expect(call(handler, 'https://evil.example').headers['Access-Control-Allow-Origin']).toBeUndefined();
    // Same-origin requests send no Origin and need no header.
    expect(call(handler).headers['Access-Control-Allow-Origin']).toBeUndefined();
  });

  it('still answers with STUN when no relay is configured', () => {
    const handler = createIceHandler({ ice: base, allowOrigin: () => true });
    const servers = (call(handler).body as { iceServers: unknown[] }).iceServers;

    expect(servers).toHaveLength(1);
    expect(hasTurn(servers as never)).toBe(false);
  });
});
