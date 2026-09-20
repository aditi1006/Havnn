import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Server } from 'socket.io';
import { io as connect, type Socket } from 'socket.io-client';
import type {
  ClientToServerEvents,
  JoinResult,
  RoomSnapshot,
  ServerToClientEvents,
  SyncState,
} from '@syncroom/shared';
import { registerHandlers, type AppServer } from '../src/handlers';
import { RoomManager } from '../src/roomManager';
import { RateLimiter } from '../src/rateLimiter';

type TestClient = Socket<ServerToClientEvents, ClientToServerEvents>;

let httpServer: ReturnType<typeof createServer>;
let io: AppServer;
let url = '';
const clients: TestClient[] = [];

function client(): TestClient {
  const c: TestClient = connect(url, { transports: ['websocket'], forceNew: true });
  clients.push(c);
  return c;
}

function join(
  c: TestClient,
  opts: { code: string; name: string; key: string; create?: boolean },
): Promise<JoinResult> {
  return new Promise((resolve) => {
    c.emit(
      'room:join',
      {
        code: opts.code,
        name: opts.name,
        participantKey: opts.key,
        create: opts.create ?? false,
      },
      resolve,
    );
  });
}

function once<T>(c: TestClient, event: string): Promise<T> {
  return new Promise((resolve) => {
    (c as Socket).once(event, (...args: unknown[]) =>
      resolve((args.length > 1 ? args : args[0]) as T),
    );
  });
}

beforeAll(async () => {
  httpServer = createServer();
  io = new Server(httpServer, { cors: { origin: '*' } });
  // All test clients share one IP, use a limiter that never throttles.
  const permissive = new RateLimiter();
  permissive.allow = () => true;
  registerHandlers(io, new RoomManager(), permissive);
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const port = (httpServer.address() as AddressInfo).port;
  url = `http://localhost:${port}`;
});

afterAll(async () => {
  for (const c of clients) c.disconnect();
  io.close();
  await new Promise<void>((resolve) => {
    httpServer.close(() => resolve());
  });
});

describe('room lifecycle over sockets', () => {
  it('creates a room, joins a guest, syncs media, kicks, and ends', async () => {
    const host = client();
    const guest = client();

    const created = await join(host, {
      code: 'itest-room',
      name: 'Host',
      key: 'host-key-0001',
      create: true,
    });
    expect(created.ok).toBe(true);
    expect(created.room?.participants).toHaveLength(1);
    expect(created.room?.hostId).toBe(created.selfId);

    // Guest joining a missing room fails cleanly.
    const missing = await join(guest, { code: 'nope-room', name: 'G', key: 'guest-key-0001' });
    expect(missing).toMatchObject({ ok: false, reason: 'not-found' });

    const joined = await join(guest, { code: 'itest-room', name: 'Guest', key: 'guest-key-0001' });
    expect(joined.ok).toBe(true);
    expect(joined.room?.participants).toHaveLength(2);

    // Host sets media -> both receive authoritative sync state.
    const guestSync = once<SyncState>(guest, 'sync:state');
    host.emit('sync:set-media', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    const state = await guestSync;
    expect(state.media?.kind).toBe('youtube');
    expect(state.playing).toBe(false);
    expect(state.seq).toBeGreaterThan(0);

    // Shared control is the default: a guest can drive playback.
    const guestDrove = once<SyncState>(host, 'sync:state');
    guest.emit('sync:play', { time: 3, eventId: 'guest-evt-1' });
    const guestState = await guestDrove;
    expect(guestState.playing).toBe(true);
    expect(guestState.time).toBe(3);
    expect(guestState.originId).toBe(joined.selfId);
    expect(guestState.eventId).toBe('guest-evt-1');

    // Host can restrict control to host-only, which blocks guests again.
    host.emit('room:control-mode', 'host-only');
    await new Promise((r) => setTimeout(r, 100));
    guest.emit('sync:pause', { time: 0, eventId: 'guest-evt-2' });
    await new Promise((r) => setTimeout(r, 150));
    const guestSync2 = once<SyncState>(guest, 'sync:state');
    host.emit('sync:play', { time: 5, eventId: 'host-evt-1' });
    const after = await guestSync2;
    expect(after.playing).toBe(true);
    expect(after.time).toBe(5);
    // Stamped metadata: monotonic seq, origin + eventId echoed back.
    expect(after.seq).toBeGreaterThan(guestState.seq);
    expect(after.originId).toBe(created.selfId);
    expect(after.eventId).toBe('host-evt-1');

    // Kick the guest.
    const kicked = once<void>(guest, 'room:kicked');
    const guestId = joined.selfId!;
    // find guest id from host's snapshot to be safe
    host.emit('room:kick', guestId);
    await kicked;

    // End meeting.
    const ended = once<void>(host, 'room:ended');
    host.emit('room:end');
    await ended;
  });

  it('lets any member remove another member but protects the host', async () => {
    const host = client();
    const g1 = client();
    const g2 = client();

    const created = await join(host, {
      code: 'kick-room',
      name: 'Host',
      key: 'kick-host-01',
      create: true,
    });
    const g1Join = await join(g1, { code: 'kick-room', name: 'G1', key: 'kick-g1-0001' });
    const g2Join = await join(g2, { code: 'kick-room', name: 'G2', key: 'kick-g2-0001' });
    expect(g1Join.ok && g2Join.ok).toBe(true);

    // A non-host member removes another non-host member.
    const g2Kicked = once<void>(g2, 'room:kicked');
    g1.emit('room:kick', g2Join.selfId!);
    await g2Kicked;

    // A non-host member cannot remove the host.
    let hostKicked = false;
    (host as Socket).once('room:kicked', () => {
      hostKicked = true;
    });
    g1.emit('room:kick', created.selfId!);
    await new Promise((r) => setTimeout(r, 150));
    expect(hostKicked).toBe(false);
  });

  it('broadcasts the mirror-video presence flag to everyone', async () => {
    const host = client();
    const guest = client();
    await join(host, { code: 'mirror-rm', name: 'Host', key: 'mirror-host-01', create: true });
    const gJoin = await join(guest, { code: 'mirror-rm', name: 'G', key: 'mirror-guest-01' });
    expect(gJoin.ok).toBe(true);

    // Host turns mirroring on; the guest must see the host's flag flip.
    const next = once<RoomSnapshot>(guest, 'room:state');
    host.emit('presence:update', { mirrored: true });
    const room = await next;
    expect(room.participants.find((p) => p.name === 'Host')?.mirrored).toBe(true);
  });

  it('enforces lock and duplicate keys', async () => {
    const host = client();
    await join(host, { code: 'lock-room', name: 'Host', key: 'lock-host-01', create: true });
    host.emit('room:lock', true);
    await new Promise((r) => setTimeout(r, 100));

    const guest = client();
    const denied = await join(guest, { code: 'lock-room', name: 'G', key: 'lock-guest-01' });
    expect(denied).toMatchObject({ ok: false, reason: 'locked' });

    // Same key, second live socket -> duplicate.
    const dupe = client();
    const deniedDupe = await join(dupe, { code: 'lock-room', name: 'Host', key: 'lock-host-01' });
    expect(deniedDupe).toMatchObject({ ok: false, reason: 'duplicate' });
  });

  it('relays chat with read receipts and delete', async () => {
    const a = client();
    const b = client();
    await join(a, { code: 'chat-room', name: 'A', key: 'chat-a-00001', create: true });
    const bJoin = await join(b, { code: 'chat-room', name: 'B', key: 'chat-b-00001' });

    const bGotMsg = once<{ id: string; text: string }>(b, 'chat:message');
    a.emit('chat:send', { text: 'hello world' });
    const msg = await bGotMsg;
    expect(msg.text).toBe('hello world');

    const aGotRead = once<[string, string[]]>(a, 'chat:read');
    b.emit('chat:read', [msg.id]);
    const [readerId, ids] = await aGotRead;
    expect(readerId).toBe(bJoin.selfId);
    expect(ids).toEqual([msg.id]);

    const bGotDelete = once<string>(b, 'chat:deleted');
    a.emit('chat:delete', msg.id);
    expect(await bGotDelete).toBe(msg.id);
  });

  it('relays webrtc signals only to the addressed peer', async () => {
    const a = client();
    const b = client();
    const aJoin = await join(a, { code: 'sig-room', name: 'A', key: 'sig-a-000001', create: true });
    const bJoin = await join(b, { code: 'sig-room', name: 'B', key: 'sig-b-000001' });

    const bGotSignal = once<{ from: string; description?: { type: string } }>(b, 'signal');
    a.emit('signal', {
      to: bJoin.selfId!,
      from: aJoin.selfId!,
      description: { type: 'offer', sdp: 'v=0' },
    });
    const sig = await bGotSignal;
    expect(sig.from).toBe(aJoin.selfId);
    expect(sig.description?.type).toBe('offer');
  });

  it('lets a dropped member rejoin while the rest of the room is connected', async () => {
    const a = client();
    const b = client();
    await join(a, { code: 'recon-rm', name: 'A', key: 'recon-a-0001', create: true });
    const bJoin = await join(b, { code: 'recon-rm', name: 'B', key: 'recon-b-0001' });
    expect(bJoin.ok).toBe(true);

    // Transport drop: B's socket dies and socket.io-client reconnects on a
    // brand-new one. The rejoin may carry `create` (the room would be gone if
    // the server had restarted) and must still be admitted as the same member,
    // otherwise B falls out of the participant list and every peer tears down
    // B's RTCPeerConnection.
    b.disconnect();
    await new Promise((r) => setTimeout(r, 100));

    const b2 = client();
    const rejoin = await join(b2, {
      code: 'recon-rm',
      name: 'B',
      key: 'recon-b-0001',
      create: true,
    });
    expect(rejoin.ok).toBe(true);
    expect(rejoin.selfId).toBe(bJoin.selfId);
    expect(rejoin.room?.participants).toHaveLength(2);

    // The guard still holds for someone who is not already a member.
    const stranger = client();
    const denied = await join(stranger, {
      code: 'recon-rm',
      name: 'C',
      key: 'recon-c-0001',
      create: true,
    });
    expect(denied).toMatchObject({ ok: false, reason: 'room-exists' });
  });

  it('answers time pings with server time', async () => {
    const c = client();
    const serverNow = await new Promise<number>((resolve) => {
      c.emit('time:ping', Date.now(), resolve);
    });
    expect(Math.abs(serverNow - Date.now())).toBeLessThan(2000);
  });
});
