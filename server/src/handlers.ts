import type { Server, Socket } from 'socket.io';
import { randomUUID } from 'node:crypto';
import type {
  ClientToServerEvents,
  JoinResult,
  ServerToClientEvents,
  SyncRateCommand,
  SyncTimeCommand,
} from '@syncroom/shared';
import {
  LIMITS,
  MEDIA_URL_ERROR_TEXT,
  classifyMediaUrl,
  isValidDisplayName,
  isValidPlaybackRate,
  isValidRoomCode,
  isValidTime,
  normalizeRoomCode,
  sanitizeDisplayName,
} from '@syncroom/shared';
import type { Room } from './room';
import type { RoomManager } from './roomManager';
import { RateLimiter } from './rateLimiter';

interface SocketData {
  roomCode: string | null;
  participantId: string | null;
}

export type AppServer = Server<ClientToServerEvents, ServerToClientEvents, object, SocketData>;
export type AppSocket = Socket<ClientToServerEvents, ServerToClientEvents, object, SocketData>;

const ATTACHMENT_MIME = /^(image|video|audio|application|text)\//;

function clientIp(socket: AppSocket): string {
  const fwd = socket.handshake.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0]!.trim();
  return socket.handshake.address;
}

export function registerHandlers(
  io: AppServer,
  rooms: RoomManager,
  limiter: RateLimiter = new RateLimiter(),
): RateLimiter {
  const sweepTimer = setInterval(() => limiter.sweep(), 5 * 60 * 1000);
  sweepTimer.unref?.();

  io.on('connection', (socket) => {
    socket.data.roomCode = null;
    socket.data.participantId = null;

    const currentRoom = (): Room | null => {
      if (!socket.data.roomCode) return null;
      return rooms.get(socket.data.roomCode) ?? null;
    };

    const self = (): { room: Room; id: string } | null => {
      const room = currentRoom();
      const id = socket.data.participantId;
      if (!room || !id || !room.members.has(id)) return null;
      return { room, id };
    };

    const broadcastState = (room: Room): void => {
      io.to(room.code).emit('room:state', room.snapshot());
    };

    /**
     * Rate guard. Rejections are silent for the caller's traffic shape,
     * the user is told at most once per 5s so a burst of throttled events
     * can never turn into a toast storm.
     */
    let lastRateNoticeAt = 0;
    const guard = (cls: Parameters<RateLimiter['allow']>[1]): boolean => {
      if (limiter.allow(socket.id, cls)) return true;
      const now = Date.now();
      if (now - lastRateNoticeAt > 5000) {
        lastRateNoticeAt = now;
        socket.emit('error', 'You are doing that too fast. Slow down.');
      }
      return false;
    };

    const ALLOWED_REACTIONS = new Set([
      '👍',
      '❤️',
      '😂',
      '😮',
      '👏',
      '🎉',
      '😢',
      '😍',
    ]);

    socket.on('reaction:send', (emoji) => {
      if (!guard('generic')) return;

      const ctx = self();
      if (!ctx) return;

      if (!ALLOWED_REACTIONS.has(emoji)) return;

      io.to(ctx.room.code).emit('reaction:show', {
        id: randomUUID(),
        participantId: ctx.id,
        emoji,
      });
    });

    /** Extracts a bounded, string-typed eventId from a client command. */
    const eventIdOf = (cmd: unknown): string | undefined => {
      if (typeof cmd !== 'object' || cmd === null) return undefined;
      const id = (cmd as { eventId?: unknown }).eventId;
      return typeof id === 'string' && id.length > 0 ? id.slice(0, 64) : undefined;
    };

    /* ------------------------------ room lifecycle ------------------------------ */

    socket.on('room:join', (req, ack) => {
      if (typeof ack !== 'function') return;
      if (!limiter.allow(clientIp(socket), 'join')) {
        ack({ ok: false, reason: 'rate-limited' });
        return;
      }
      if (typeof req !== 'object' || req === null) {
        ack({ ok: false, reason: 'invalid-code' });
        return;
      }
      const code = normalizeRoomCode(String(req.code ?? ''));
      const name = sanitizeDisplayName(String(req.name ?? ''));
      const key = String(req.participantKey ?? '');
      if (!isValidRoomCode(code)) {
        ack({ ok: false, reason: 'invalid-code' });
        return;
      }
      if (!isValidDisplayName(name) || key.length < 8 || key.length > 64) {
        ack({ ok: false, reason: 'invalid-name' });
        return;
      }

      let room = rooms.get(code);
      // A member reclaiming their identity (tab refresh, or a transport drop
      // followed by a socket.io reconnect) re-sends `create` so the room is
      // rebuilt if the server restarted while they were away. That must never
      // be read as "create a brand-new room": the `room-exists` guard only
      // applies to someone who is not already a member here. Without this the
      // rejoin is refused whenever anyone else is still connected, the member
      // falls out of the participant list after the grace window, and every
      // peer tears their RTCPeerConnection down, no video either way.
      const returning = room?.findByKey(key);
      if (req.create && !returning) {
        if (room && room.connectedCount > 0) {
          ack({ ok: false, reason: 'room-exists' });
          return;
        }
        room ??= rooms.create(code) ?? undefined;
        if (!room) {
          ack({ ok: false, reason: 'invalid-code' });
          return;
        }
      }
      if (!room) {
        ack({ ok: false, reason: 'not-found' });
        return;
      }

      if (returning && returning.socketId !== null && returning.socketId !== socket.id) {
        ack({ ok: false, reason: 'duplicate' });
        return;
      }
      if (!returning) {
        if (room.locked) {
          ack({ ok: false, reason: 'locked' });
          return;
        }
        if (room.connectedCount >= LIMITS.MAX_PARTICIPANTS) {
          ack({ ok: false, reason: 'room-full' });
          return;
        }
      }

      const member = room.addMember(name, key, socket.id);
      socket.data.roomCode = room.code;
      socket.data.participantId = member.participant.id;
      void socket.join(room.code);
      rooms.cancelReap(room.code);

      const result: JoinResult = {
        ok: true,
        selfId: member.participant.id,
        room: room.snapshot(),
        chatHistory: room.chat,
      };
      ack(result);
      broadcastState(room);
    });

    const leaveRoom = (): void => {
      const ctx = self();
      if (!ctx) return;
      const { room, id } = ctx;
      room.removeMember(id);
      void socket.leave(room.code);
      socket.data.roomCode = null;
      socket.data.participantId = null;
      if (room.members.size === 0) {
        rooms.scheduleReapIfEmpty(room.code);
      } else {
        broadcastState(room);
      }
    };

    socket.on('room:leave', leaveRoom);

    socket.on('disconnect', () => {
      // Reclaim this socket's rate-limiter buckets right away rather than
      // waiting for the periodic sweep, keeps memory flat under churn.
      limiter.clear(socket.id);
      const ctx = self();
      if (!ctx) return;
      const { room, id } = ctx;
      const member = room.members.get(id);
      if (!member) return;
      // Grace window: a refreshed tab can reclaim this identity.
      member.socketId = null;
      member.disconnectedAt = Date.now();
      broadcastState(room);
      const code = room.code;
      const timer = setTimeout(() => {
        const r = rooms.get(code);
        const m = r?.members.get(id);
        if (r && m && m.socketId === null) {
          r.removeMember(id);
          if (r.members.size === 0) rooms.scheduleReapIfEmpty(code);
          else io.to(code).emit('room:state', r.snapshot());
        }
      }, LIMITS.RECONNECT_GRACE_MS);
      timer.unref?.();
    });

    /* ------------------------------ host controls ------------------------------ */

    const asHost = (): { room: Room; id: string } | null => {
      const ctx = self();
      if (!ctx || !ctx.room.isHost(ctx.id)) return null;
      return ctx;
    };

    socket.on('room:lock', (locked) => {
      if (!guard('generic')) return;
      const ctx = asHost();
      if (!ctx) return;
      ctx.room.locked = Boolean(locked);
      broadcastState(ctx.room);
    });

    socket.on('room:control-mode', (mode) => {
      if (!guard('generic')) return;
      const ctx = asHost();
      if (!ctx || (mode !== 'host-only' && mode !== 'everyone')) return;
      ctx.room.controlMode = mode;
      broadcastState(ctx.room);
    });

    socket.on('room:kick', (participantId) => {
      if (!guard('generic')) return;
      // Any member may remove another member. Guards: you can't remove
      // yourself, and only the host may remove the host (so a guest can't
      // depose the host, use "Make host" to transfer that role first).
      const ctx = self();
      if (!ctx) return;
      const targetId = String(participantId);
      if (targetId === ctx.id) return;
      const target = ctx.room.members.get(targetId);
      if (!target) return;
      if (ctx.room.isHost(targetId) && !ctx.room.isHost(ctx.id)) return;
      if (target.socketId) {
        const targetSocket = io.sockets.sockets.get(target.socketId);
        if (targetSocket) {
          targetSocket.emit('room:kicked');
          targetSocket.data.roomCode = null;
          targetSocket.data.participantId = null;
          void targetSocket.leave(ctx.room.code);
        }
      }
      ctx.room.removeMember(target.participant.id);
      broadcastState(ctx.room);
    });

    socket.on('room:force-mute', (participantId) => {
      if (!guard('generic')) return;
      const ctx = asHost();
      if (!ctx) return;
      const target = ctx.room.members.get(String(participantId));
      if (!target?.socketId) return;
      target.participant.micOn = false;
      io.sockets.sockets.get(target.socketId)?.emit('room:force-muted');
      broadcastState(ctx.room);
    });

    socket.on('room:transfer-host', (participantId) => {
      if (!guard('generic')) return;
      const ctx = asHost();
      if (!ctx) return;
      if (ctx.room.transferHost(String(participantId))) broadcastState(ctx.room);
    });

    socket.on('room:end', () => {
      const ctx = asHost();
      if (!ctx) return;
      io.to(ctx.room.code).emit('room:ended');
      io.in(ctx.room.code).socketsLeave(ctx.room.code);
      rooms.destroy(ctx.room.code);
      socket.data.roomCode = null;
      socket.data.participantId = null;
    });

    socket.on('presence:update', (flags) => {
      if (!guard('generic')) return;
      const ctx = self();
      if (!ctx || typeof flags !== 'object' || flags === null) return;
      // Only broadcast when a flag actually flips. Clients re-send presence on
      // reconnect/track changes, and re-emitting an identical full snapshot to
      // the whole room is pure waste, this drops those redundant broadcasts.
      const p = ctx.room.members.get(ctx.id)!.participant;
      let changed = false;
      if (typeof flags.micOn === 'boolean' && p.micOn !== flags.micOn) {
        p.micOn = flags.micOn;
        changed = true;
      }
      if (typeof flags.cameraOn === 'boolean' && p.cameraOn !== flags.cameraOn) {
        p.cameraOn = flags.cameraOn;
        changed = true;
      }
      if (typeof flags.screenSharing === 'boolean' && p.screenSharing !== flags.screenSharing) {
        p.screenSharing = flags.screenSharing;
        changed = true;
      }
      if (typeof flags.mirrored === 'boolean' && p.mirrored !== flags.mirrored) {
        p.mirrored = flags.mirrored;
        changed = true;
      }
      if (changed) broadcastState(ctx.room);
    });

    /* ------------------------------ webrtc signaling ------------------------------ */

    socket.on('signal', (payload) => {
      if (!limiter.allow(socket.id, 'signal')) return;
      const ctx = self();
      if (!ctx || typeof payload !== 'object' || payload === null) return;
      const target = ctx.room.members.get(String(payload.to));
      if (!target?.socketId) return;
      io.sockets.sockets
        .get(target.socketId)
        ?.emit('signal', { ...payload, from: ctx.id, to: target.participant.id });
    });

    /* ------------------------------ chat ------------------------------ */

    socket.on('chat:send', (msg) => {
      if (!guard('chat')) return;
      const ctx = self();
      if (!ctx || typeof msg !== 'object' || msg === null) return;
      const text = String(msg.text ?? '').slice(0, LIMITS.MAX_CHAT_LENGTH);
      let attachment = msg.attachment;
      if (attachment) {
        const okAttachment =
          typeof attachment.dataUrl === 'string' &&
          attachment.dataUrl.startsWith('data:') &&
          attachment.dataUrl.length <= LIMITS.MAX_ATTACHMENT_BYTES * 1.4 && // base64 overhead
          typeof attachment.name === 'string' &&
          attachment.name.length <= 255 &&
          typeof attachment.mimeType === 'string' &&
          ATTACHMENT_MIME.test(attachment.mimeType) &&
          typeof attachment.size === 'number' &&
          attachment.size <= LIMITS.MAX_ATTACHMENT_BYTES;
        if (!okAttachment) {
          socket.emit('error', 'Attachment rejected (too large or unsupported type).');
          return;
        }
        attachment = {
          name: attachment.name,
          size: attachment.size,
          mimeType: attachment.mimeType,
          dataUrl: attachment.dataUrl,
        };
      }
      if (!text.trim() && !attachment) return;
      const message = ctx.room.addChat(ctx.id, text, attachment);
      if (message) io.to(ctx.room.code).emit('chat:message', message);
    });

    socket.on('chat:delete', (messageId) => {
      if (!guard('chat')) return;
      const ctx = self();
      if (!ctx) return;
      if (ctx.room.deleteChat(String(messageId), ctx.id)) {
        io.to(ctx.room.code).emit('chat:deleted', String(messageId));
      }
    });

    socket.on('chat:typing', (typing) => {
      if (!guard('generic')) return;
      const ctx = self();
      if (!ctx) return;
      socket.to(ctx.room.code).emit('chat:typing', ctx.id, Boolean(typing));
    });

    socket.on('chat:read', (messageIds) => {
      if (!guard('generic')) return;
      const ctx = self();
      if (!ctx || !Array.isArray(messageIds)) return;
      const ids = messageIds.slice(0, 100).map(String);
      const updated = ctx.room.markRead(ctx.id, ids);
      if (updated.length > 0) socket.to(ctx.room.code).emit('chat:read', ctx.id, updated);
    });

    /* ------------------------------ media sync ------------------------------ */

    const asController = (): { room: Room; id: string } | null => {
      const ctx = self();
      if (!ctx || !ctx.room.canControlPlayback(ctx.id)) return null;
      return ctx;
    };

    socket.on('sync:set-media', (url) => {
      if (!guard('sync')) return;
      const ctx = asController();
      if (!ctx || typeof url !== 'string' || url.length > 2048) return;
      const classified = classifyMediaUrl(url);
      if (!classified.ok) {
        socket.emit('error', MEDIA_URL_ERROR_TEXT[classified.reason]);
        return;
      }
      const item = ctx.room.setMedia(url, ctx.id);
      if (!item) {
        socket.emit('error', 'That link is not a supported video URL.');
        return;
      }
      io.to(ctx.room.code).emit('sync:state', ctx.room.sync);
    });

    socket.on('sync:clear', () => {
      if (!guard('sync')) return;
      const ctx = asController();
      if (!ctx) return;
      ctx.room.clearMedia(ctx.id);
      io.to(ctx.room.code).emit('sync:state', ctx.room.sync);
    });

    socket.on('sync:play', (cmd) => {
      if (!guard('sync')) return;
      const ctx = asController();
      const time = Number((cmd as SyncTimeCommand | undefined)?.time);
      if (!ctx || !isValidTime(time)) return;
      ctx.room.play(time, ctx.id, eventIdOf(cmd));
      io.to(ctx.room.code).emit('sync:state', ctx.room.sync);
    });

    socket.on('sync:pause', (cmd) => {
      if (!guard('sync')) return;
      const ctx = asController();
      const time = Number((cmd as SyncTimeCommand | undefined)?.time);
      if (!ctx || !isValidTime(time)) return;
      ctx.room.pause(time, ctx.id, eventIdOf(cmd));
      io.to(ctx.room.code).emit('sync:state', ctx.room.sync);
    });

    socket.on('sync:seek', (cmd) => {
      if (!guard('sync')) return;
      const ctx = asController();
      const time = Number((cmd as SyncTimeCommand | undefined)?.time);
      if (!ctx || !isValidTime(time)) return;
      ctx.room.seek(time, ctx.id, eventIdOf(cmd));
      io.to(ctx.room.code).emit('sync:state', ctx.room.sync);
    });

    socket.on('sync:rate', (cmd) => {
      if (!guard('sync')) return;
      const ctx = asController();
      const rate = Number((cmd as SyncRateCommand | undefined)?.rate);
      if (!ctx || !isValidPlaybackRate(rate)) return;
      ctx.room.setRate(rate, ctx.id, eventIdOf(cmd));
      io.to(ctx.room.code).emit('sync:state', ctx.room.sync);
    });

    /* ------------------------------ queue ------------------------------ */

    socket.on('queue:add', (url) => {
      if (!guard('sync')) return;
      const ctx = self();
      if (!ctx || typeof url !== 'string' || url.length > 2048) return;
      const classified = classifyMediaUrl(url);
      if (!classified.ok) {
        socket.emit('error', MEDIA_URL_ERROR_TEXT[classified.reason]);
        return;
      }
      const item = ctx.room.queueAdd(url, ctx.id);
      if (!item) {
        socket.emit('error', 'The queue is full.');
        return;
      }
      io.to(ctx.room.code).emit('queue:state', ctx.room.queue);
    });

    socket.on('queue:remove', (itemId) => {
      if (!guard('sync')) return;
      const ctx = asController();
      if (!ctx) return;
      if (ctx.room.queueRemove(String(itemId))) {
        io.to(ctx.room.code).emit('queue:state', ctx.room.queue);
      }
    });

    socket.on('queue:play', (itemId) => {
      if (!guard('sync')) return;
      const ctx = asController();
      if (!ctx) return;
      if (ctx.room.queuePlay(String(itemId), ctx.id)) {
        io.to(ctx.room.code).emit('queue:state', ctx.room.queue);
        io.to(ctx.room.code).emit('sync:state', ctx.room.sync);
      }
    });

    /* ------------------------------ clock sync ------------------------------ */

    socket.on('time:ping', (_clientSent, ack) => {
      if (typeof ack === 'function') ack(Date.now());
    });
  });

  return limiter;
}
