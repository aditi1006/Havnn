/**
 * Core domain types shared between the SyncRoom server and client.
 * The server is the single source of truth for room state; clients render
 * snapshots and apply targeted delta events (chat, sync, signaling).
 */

export interface Participant {
  /** Stable participant id, survives socket reconnects within a session. */
  id: string;
  name: string;
  isHost: boolean;
  /** Media presence flags, mirrored to everyone for UI badges. */
  micOn: boolean;
  cameraOn: boolean;
  screenSharing: boolean;
  /** Whether this participant's camera tile is shown flipped for everyone. */
  mirrored: boolean;
  joinedAt: number;
}
export interface RoomReaction {
  id: string;
  participantId: string;
  emoji: string;
}

export type MediaKind =
  | 'youtube'
  | 'vimeo'
  | 'twitch'
  | 'file'
  | 'hls'
  | 'dash'
  | 'drive'
  | 'drive-embed';

export interface MediaItem {
  id: string;
  url: string;
  kind: MediaKind;
  title: string;
  /** Extracted provider id (YouTube video id, Drive file id). */
  providerId?: string;
  addedBy: string;
}

/**
 * Host-authoritative playback state. `time` is the media position (seconds)
 * at server timestamp `updatedAt` (ms). While `playing`, the expected
 * position at any wall-clock instant is derived, never streamed.
 *
 * Every mutation is stamped by the server with a monotonic `seq` plus the
 * origin metadata, so clients can (a) drop stale/out-of-order states and
 * (b) never re-emit an event that came from synchronization.
 */
export interface SyncState {
  media: MediaItem | null;
  playing: boolean;
  time: number;
  rate: number;
  updatedAt: number;
  /** Monotonic per-room sequence number, incremented on every mutation. */
  seq: number;
  /** Participant whose action produced this state. */
  originId?: string;
  /** Client-generated id of the originating user action. */
  eventId?: string;
}

export type ControlMode = 'host-only' | 'everyone';

export interface RoomSnapshot {
  code: string;
  locked: boolean;
  hostId: string;
  controlMode: ControlMode;
  participants: Participant[];
  sync: SyncState;
  queue: MediaItem[];
  createdAt: number;
}

export interface ChatAttachment {
  name: string;
  size: number;
  mimeType: string;
  /** data: URL, attachments are relayed in-memory, never persisted. */
  dataUrl: string;
}

export interface ChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  text: string;
  attachment?: ChatAttachment;
  ts: number;
  deleted: boolean;
  /** Participant ids that have read the message. */
  readBy: string[];
}

/** WebRTC signaling payload relayed verbatim between two peers. */
export interface SignalPayload {
  to: string;
  from: string;
  description?: RTCSessionDescriptionLike;
  candidate?: RTCIceCandidateLike;
  /** Maps remote MediaStream ids to their purpose so tiles render correctly. */
  streamMeta?: Record<string, 'camera' | 'screen'>;
}

/** Structural stand-ins so shared code does not depend on DOM lib types. */
export interface RTCSessionDescriptionLike {
  type: 'offer' | 'answer' | 'pranswer' | 'rollback';
  sdp?: string;
}
export interface RTCIceCandidateLike {
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

/**
 * One STUN/TURN entry, structurally compatible with the browser's
 * `RTCIceServer`. Served by `GET /ice` so relay credentials are a server-side
 * env change (and can be rotated) instead of a value baked into the SPA at
 * build time.
 */
export interface IceServerConfig {
  urls: string[];
  username?: string;
  credential?: string;
}

/** Response body of `GET /ice`. */
export interface IceConfigResponse {
  iceServers: IceServerConfig[];
}

export interface JoinRequest {
  code: string;
  name: string;
  /** Client-generated stable key; lets a refreshed tab reclaim its identity. */
  participantKey: string;
  create: boolean;
}

export type JoinErrorReason =
  | 'not-found'
  | 'locked'
  | 'invalid-code'
  | 'invalid-name'
  | 'duplicate'
  | 'room-exists'
  | 'rate-limited'
  | 'room-full';

export interface JoinResult {
  ok: boolean;
  reason?: JoinErrorReason;
  selfId?: string;
  room?: RoomSnapshot;
  chatHistory?: ChatMessage[];
}
