import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Logger, OnModuleDestroy } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Namespace, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ChatService } from './chat.service';
import { ChatPresence } from './chat-presence';
import { ChatNotifier } from './chat-notifier';
import { SendMessageDto } from './dto/send-message.dto';
import {
  chatEvents,
  ChatMessageEvent,
  ChatMessageUpdatedEvent,
  ChatStatusEvent,
  ChatUnreadEvent,
} from './chat-events';
import { chatMetrics, CHAT_METRIC } from './chat-metrics';
import { metrics } from '../common/observability/metrics';
import { socketCorsOrigin } from '../common/adapters/socket-cors';
import { DEFAULT_MESSAGES } from '../common/errors/messages';
import { ErrorCode } from '../common/errors/error-codes';
import { writeJson } from '../common/observability/json-logger';
import { hashUserId } from '../common/observability/redact';
import { UserStatus } from '../common/enum/user.enums';

interface SocketData {
  userId?: string;
  presenceVisible: boolean;
  /** A valid, unexpired token is attached right now. */
  authed?: boolean;
  /** User room joined, presence and metrics counted (once per socket). */
  bound?: boolean;
  authReason?: AuthReason;
}

type AuthReason = 'missing' | 'invalid' | 'expired' | 'revoked';

class AuthFailure extends Error {
  constructor(readonly reason: AuthReason) {
    super(reason);
  }
}

interface VerifiedToken {
  userId: string;
  presenceVisible: boolean;
  exp: number | null;
}

const AUTH_COPY: Record<AuthReason, string> = {
  missing: 'Please log in to continue.',
  invalid: 'Please log in to continue.',
  expired: 'Your session needs a refresh.',
  revoked: 'Your session has ended. Please log in again.',
};

/** How long an unauthenticated socket may stay open waiting for auth:refresh. */
export const authGraceMs = () =>
  Number(process.env.CHAT_AUTH_GRACE_MS) > 0
    ? Number(process.env.CHAT_AUTH_GRACE_MS)
    : 30_000;
type ChatSocket = Socket & { data: SocketData };

/** Ack payload for every client -> server event (same error shape as REST). */
export type Ack<T = unknown> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
        fields?: Record<string, string>;
        retryAfterSeconds?: number;
        /** auth:refresh failures: missing | invalid | expired | revoked */
        reason?: string;
        /** message:send failures: which message failed. */
        conversationId?: string | null;
        clientMessageId?: string | null;
      };
    };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** How long the server waits for a recipient's socket to ack message:new. */
const DELIVERY_ACK_TIMEOUT_MS = 10_000;
export const HEARTBEAT_INTERVAL_MS = 25_000;

const userRoom = (id: string) => `user:${id}`;
const presenceRoom = (id: string) => `presence:${id}`;

/**
 * Real-time chat (C1). Namespace /chat on the API's own port.
 *
 * Connect: `io(API_URL + '/chat', { auth: (cb) => cb({ token: latest() }) })`
 * (the callback form, so every reconnect sends the newest token).
 * Auth is recoverable (docs/chat-contract.md §2): a missing, invalid or
 * expired token never closes the socket at once. The server emits
 * `auth:expired { reason, graceMs }` and keeps the connection open for 30 s;
 * send `auth:refresh { token }` to continue. No valid token in time:
 * `auth:failed`, then disconnect. Live sockets get the same flow when their
 * token expires.
 *
 * Each socket joins a private room `user:<id>`; all events are addressed to
 * users, never broadcast. Server -> client: message:new (ack it),
 * message:status, message:updated, conversation:updated, typing, presence,
 * unread:update, message:error, auth:expired, auth:failed. Client -> server
 * (all acked with { ok, data | error }): auth:refresh, message:send,
 * message:delivered, message:read, typing, presence:subscribe,
 * presence:unsubscribe, heartbeat.
 *
 * Several instances: main.ts installs the Redis adapter, so rooms and acks
 * work across instances. One instance needs no adapter (in-memory).
 */
@WebSocketGateway({
  cors: { origin: socketCorsOrigin, credentials: true },
  namespace: '/chat',
  pingInterval: HEARTBEAT_INTERVAL_MS,
  pingTimeout: 20_000,
  transports: ['websocket', 'polling'],
  // Payloads are small JSON; compression costs more CPU than it saves.
  perMessageDeflate: false,
})
export class ChatGateway
  implements
    OnGatewayInit,
    OnGatewayConnection,
    OnGatewayDisconnect,
    OnModuleDestroy
{
  @WebSocketServer()
  server: Namespace;

  private readonly logger = new Logger(ChatGateway.name);
  private readonly expiryTimers = new Map<string, NodeJS.Timeout>();
  private readonly graceTimers = new Map<string, NodeJS.Timeout>();
  /** conversationId:userId -> peer id (typing), short-lived. */
  private readonly peerCache = new Map<
    string,
    { peer: string | null; at: number }
  >();

  private readonly onMessage = (e: ChatMessageEvent) => this.deliver(e);
  private readonly onStatus = (e: ChatStatusEvent) =>
    this.server?.to(userRoom(e.toUserId)).emit('message:status', {
      conversationId: e.conversationId,
      upToSeq: e.upToSeq,
      status: e.status,
      userId: e.byUserId,
    });
  private readonly onUnread = (e: ChatUnreadEvent) =>
    this.server?.to(userRoom(e.userId)).emit('unread:update', {
      conversationId: e.conversationId,
      unreadCount: e.unreadCount,
      total: e.total,
    });
  private readonly onUpdated = (e: ChatMessageUpdatedEvent) => {
    for (const id of e.userIds)
      this.server?.to(userRoom(id)).emit('message:updated', e.message);
  };

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly chat: ChatService,
    private readonly presence: ChatPresence,
    private readonly notifier: ChatNotifier,
    @InjectDataSource() private readonly ds: DataSource,
  ) {}

  // ─── lifecycle ──────────────────────────────────────────────────────

  afterInit(nsp: Namespace) {
    // Never refuse the handshake: a socket with a missing, invalid or expired
    // token is accepted unauthenticated, gets auth:expired and has
    // authGraceMs() to send auth:refresh (see handleConnection).
    nsp.use((socket, next) => {
      const s = socket as ChatSocket;
      this.verify(extractToken(s))
        .then((r) => this.applyAuth(s, r))
        .catch((e: unknown) => {
          s.data.authReason = e instanceof AuthFailure ? e.reason : 'invalid';
        })
        .finally(() => next());
    });
    chatEvents.on('message', this.onMessage);
    chatEvents.on('status', this.onStatus);
    chatEvents.on('unread', this.onUnread);
    chatEvents.on('message-updated', this.onUpdated);
  }

  onModuleDestroy() {
    chatEvents.off('message', this.onMessage);
    chatEvents.off('status', this.onStatus);
    chatEvents.off('unread', this.onUnread);
    chatEvents.off('message-updated', this.onUpdated);
    for (const t of [
      ...this.expiryTimers.values(),
      ...this.graceTimers.values(),
    ])
      clearTimeout(t);
    this.expiryTimers.clear();
    this.graceTimers.clear();
  }

  /** Same rules as the HTTP JWT strategy: valid token, active account, not signed out everywhere. */
  private async verify(token: string | null): Promise<VerifiedToken> {
    if (!token) throw new AuthFailure('missing');
    let payload: { sub?: string; iat?: number; exp?: number };
    try {
      payload = this.jwt.verify(token, {
        secret: this.config.get<string>('JWT_SECRET'),
      });
    } catch (e) {
      throw new AuthFailure(
        (e as Error).name === 'TokenExpiredError' ? 'expired' : 'invalid',
      );
    }
    if (!payload.sub || !UUID.test(payload.sub))
      throw new AuthFailure('invalid');
    const [u] = await this.ds.query<
      Array<{
        status: UserStatus;
        isActive: boolean;
        deletionRequestedAt: Date | null;
        tokensValidAfter: Date | null;
        chatPresenceVisible: boolean;
      }>
    >(
      `SELECT status, "isActive", "deletionRequestedAt", "tokensValidAfter", "chatPresenceVisible"
         FROM "users" WHERE id = $1`,
      [payload.sub],
    );
    if (
      !u ||
      u.status !== UserStatus.ACTIVE ||
      !u.isActive ||
      u.deletionRequestedAt ||
      (u.tokensValidAfter &&
        (payload.iat ?? 0) < Math.floor(u.tokensValidAfter.getTime() / 1000))
    ) {
      throw new AuthFailure('revoked');
    }
    return {
      userId: payload.sub,
      presenceVisible: u.chatPresenceVisible,
      exp: payload.exp ?? null,
    };
  }

  /** Marks the socket authenticated and schedules auth:expired at the token's expiry. */
  private applyAuth(socket: ChatSocket, r: VerifiedToken) {
    socket.data.userId = r.userId;
    socket.data.presenceVisible = r.presenceVisible;
    socket.data.authed = true;
    socket.data.authReason = undefined;
    const old = this.expiryTimers.get(socket.id);
    if (old) clearTimeout(old);
    this.expiryTimers.delete(socket.id);
    if (r.exp) {
      const ms = r.exp * 1000 - Date.now();
      const t = setTimeout(
        () => this.startGrace(socket, 'expired'),
        Math.max(0, Math.min(ms, 2 ** 31 - 1)),
      );
      t.unref();
      this.expiryTimers.set(socket.id, t);
    }
  }

  /**
   * auth:expired, then authGraceMs() to send auth:refresh. The connection
   * (and the user room, if any) stays open meanwhile; other client events
   * are refused with UNAUTHENTICATED. No valid token in time: disconnect.
   */
  private startGrace(socket: ChatSocket, reason: AuthReason) {
    socket.data.authed = false;
    socket.data.authReason = reason;
    const graceMs = authGraceMs();
    socket.emit('auth:expired', {
      code: ErrorCode.UNAUTHENTICATED,
      reason,
      message: AUTH_COPY[reason],
      graceMs,
    });
    const old = this.graceTimers.get(socket.id);
    if (old) clearTimeout(old);
    const t = setTimeout(() => {
      this.graceTimers.delete(socket.id);
      if (socket.data.authed) return;
      socket.emit('auth:failed', {
        code: ErrorCode.UNAUTHENTICATED,
        reason,
        message: DEFAULT_MESSAGES[ErrorCode.UNAUTHENTICATED],
      });
      socket.disconnect(true);
    }, graceMs);
    t.unref();
    this.graceTimers.set(socket.id, t);
  }

  async handleConnection(client: ChatSocket) {
    if (!client.data.authed) {
      this.startGrace(client, client.data.authReason ?? 'missing');
      return;
    }
    await this.bind(client);
  }

  /** Joins the user room, presence and metrics; emits `connected`. Once per socket. */
  private async bind(client: ChatSocket) {
    const userId = client.data.userId;
    if (!userId || client.data.bound) return;
    client.data.bound = true;
    await client.join(userRoom(userId));
    chatMetrics.connections++;
    metrics.count(
      this.presence.isReconnect(userId)
        ? CHAT_METRIC.reconnect
        : CHAT_METRIC.connect,
    );
    const cameOnline = this.presence.connect(userId, client.id);
    if (cameOnline && client.data.presenceVisible) {
      this.server.to(presenceRoom(userId)).emit('presence', {
        userId,
        online: true,
        lastActiveAt: new Date().toISOString(),
      });
    }
    client.emit('connected', {
      userId,
      serverTime: new Date().toISOString(),
      heartbeatMs: HEARTBEAT_INTERVAL_MS,
    });
  }

  handleDisconnect(client: ChatSocket) {
    for (const timers of [this.expiryTimers, this.graceTimers]) {
      const t = timers.get(client.id);
      if (t) clearTimeout(t);
      timers.delete(client.id);
    }
    const userId = client.data.userId;
    if (!userId || !client.data.bound) return;
    chatMetrics.connections = Math.max(0, chatMetrics.connections - 1);
    metrics.count(CHAT_METRIC.disconnect);
    this.presence.disconnect(userId, client.id, () => {
      this.chat.touchLastActive(userId).catch(() => undefined);
      for (const key of this.presence.typingKeysFor(userId)) {
        this.presence.stopTyping(key);
        const conversationId = key.split(':')[0];
        const peer = this.peerCache.get(key)?.peer;
        if (peer) this.emitTyping(peer, conversationId, userId, false);
      }
      if (client.data.presenceVisible) {
        this.server?.to(presenceRoom(userId)).emit('presence', {
          userId,
          online: false,
          lastActiveAt: new Date().toISOString(),
        });
      }
    });
  }

  // ─── client -> server ───────────────────────────────────────────────

  /**
   * { token } -> ack { ok: true, data: { userId, expiresAt } }. Works on an
   * unauthenticated socket (first auth) and on a live one (rotate before or
   * after auth:expired). A token for a different account is refused.
   */
  @SubscribeMessage('auth:refresh')
  async handleAuthRefresh(
    @ConnectedSocket() client: ChatSocket,
    @MessageBody() body: { token?: unknown },
  ): Promise<Ack> {
    const raw = typeof body?.token === 'string' ? body.token : null;
    let r: VerifiedToken;
    try {
      r = await this.verify(raw ? raw.replace(/^Bearer /, '') : null);
    } catch (e) {
      const reason = e instanceof AuthFailure ? e.reason : 'invalid';
      return fail(ErrorCode.UNAUTHENTICATED, AUTH_COPY[reason], {
        reason,
      });
    }
    if (client.data.userId && client.data.userId !== r.userId) {
      return fail(
        ErrorCode.FORBIDDEN,
        'This session belongs to another account. Reconnect instead.',
      );
    }
    const t = this.graceTimers.get(client.id);
    if (t) clearTimeout(t);
    this.graceTimers.delete(client.id);
    this.applyAuth(client, r);
    await this.bind(client);
    return {
      ok: true,
      data: {
        userId: r.userId,
        expiresAt: r.exp ? new Date(r.exp * 1000).toISOString() : null,
      },
    };
  }

  /**
   * { conversationId, clientMessageId, text, attachments? } -> ack
   * { ok: true, data: { message, created } }. A retry with the same
   * clientMessageId acks the original message (created: false).
   * On failure the ack AND a `message:error` event carry the
   * conversationId and clientMessageId, so the client fails the right bubble.
   */
  @SubscribeMessage('message:send')
  async handleSend(
    @ConnectedSocket() client: ChatSocket,
    @MessageBody() body: unknown,
  ): Promise<Ack> {
    const requestId = ChatService.requestId();
    const { conversationId, ...rest } = (
      body && typeof body === 'object' ? body : {}
    ) as Record<string, unknown>;
    const ids = {
      conversationId:
        typeof conversationId === 'string' ? conversationId : null,
      clientMessageId:
        typeof rest.clientMessageId === 'string' ? rest.clientMessageId : null,
    };
    const failed = (ack: Ack): Ack => {
      if (ack.ok) return ack;
      const error = { ...ack.error, ...ids };
      client.emit('message:error', {
        ...error,
        // legacy (one release): the old client read `error` as the text
        error: error.message,
      });
      return { ok: false, error };
    };
    if (!client.data.authed) return failed(unauthenticated());
    try {
      if (typeof conversationId !== 'string' || !UUID.test(conversationId)) {
        return failed(fail(ErrorCode.CONVERSATION_NOT_FOUND));
      }
      const dto = plainToInstance(SendMessageDto, rest);
      const errors = await validate(dto, {
        whitelist: true,
        forbidNonWhitelisted: true,
      });
      if (errors.length) {
        const fields: Record<string, string> = {};
        for (const e of errors)
          fields[e.property] =
            Object.values(e.constraints ?? {})[0] ?? 'Invalid value.';
        return failed(fail(ErrorCode.VALIDATION_FAILED, undefined, { fields }));
      }
      const res = await this.chat.sendMessage(
        conversationId,
        client.data.userId,
        dto,
        { via: 'socket', requestId },
      );
      // Sending ends the typing indicator.
      const key = `${conversationId}:${client.data.userId}`;
      if (this.presence.stopTyping(key)) {
        const peer = this.peerCache.get(key)?.peer;
        if (peer)
          this.emitTyping(peer, conversationId, client.data.userId, false);
      }
      return { ok: true, data: res };
    } catch (e) {
      return failed(errorAck(e, this.logger, requestId));
    }
  }

  /** { conversationId, seq }: everything up to seq reached this device. */
  @SubscribeMessage('message:delivered')
  async handleDelivered(
    @ConnectedSocket() client: ChatSocket,
    @MessageBody() body: { conversationId?: unknown; seq?: unknown },
  ): Promise<Ack> {
    if (!client.data.authed) return unauthenticated();
    try {
      const seq = Number(body?.seq);
      if (!isUuid(body?.conversationId) || !Number.isInteger(seq) || seq < 0)
        return fail(ErrorCode.VALIDATION_FAILED);
      await this.chat.markDelivered(
        body.conversationId,
        client.data.userId,
        seq,
      );
      return { ok: true, data: null };
    } catch (e) {
      return errorAck(e, this.logger);
    }
  }

  /** { conversationId, upToSeq? } -> same as POST /chat/conversations/:id/read. */
  @SubscribeMessage('message:read')
  async handleRead(
    @ConnectedSocket() client: ChatSocket,
    @MessageBody() body: { conversationId?: unknown; upToSeq?: unknown },
  ): Promise<Ack> {
    if (!client.data.authed) return unauthenticated();
    try {
      if (!isUuid(body?.conversationId))
        return fail(ErrorCode.CONVERSATION_NOT_FOUND);
      const up =
        body.upToSeq === undefined || body.upToSeq === null
          ? undefined
          : Number(body.upToSeq);
      if (up !== undefined && (!Number.isInteger(up) || up < 0))
        return fail(ErrorCode.VALIDATION_FAILED);
      return {
        ok: true,
        data: await this.chat.markRead(
          body.conversationId,
          client.data.userId,
          up,
        ),
      };
    } catch (e) {
      return errorAck(e, this.logger);
    }
  }

  /**
   * { conversationId, isTyping }. Send every ~3 s while typing; the
   * indicator expires 5 s after the last event. Nothing is stored.
   */
  @SubscribeMessage('typing')
  async handleTyping(
    @ConnectedSocket() client: ChatSocket,
    @MessageBody() body: { conversationId?: unknown; isTyping?: unknown },
  ): Promise<Ack> {
    if (!client.data.authed) return unauthenticated();
    if (!isUuid(body?.conversationId))
      return fail(ErrorCode.CONVERSATION_NOT_FOUND);
    const conversationId = body.conversationId;
    const userId = client.data.userId;
    const peer = await this.peer(conversationId, userId);
    if (!peer) return fail(ErrorCode.CONVERSATION_NOT_FOUND);
    const key = `${conversationId}:${userId}`;
    if (body.isTyping === false) {
      if (this.presence.stopTyping(key))
        this.emitTyping(peer, conversationId, userId, false);
    } else {
      this.presence.startTyping(key, () =>
        this.emitTyping(peer, conversationId, userId, false),
      );
      this.emitTyping(peer, conversationId, userId, true);
    }
    return { ok: true, data: null };
  }

  /**
   * { userIds } (up to 100): presence for people you chat with who allow it.
   * The socket then gets `presence` events for them until it unsubscribes.
   */
  @SubscribeMessage('presence:subscribe')
  async handlePresenceSubscribe(
    @ConnectedSocket() client: ChatSocket,
    @MessageBody() body: { userIds?: unknown },
  ): Promise<Ack> {
    if (!client.data.authed) return unauthenticated();
    try {
      const ids = Array.isArray(body?.userIds)
        ? [...new Set(body.userIds.filter(isUuid))].slice(0, 100)
        : [];
      const visible = await this.chat.presenceVisibleTo(
        client.data.userId,
        ids,
      );
      const data = await Promise.all(
        visible.map(async (v) => {
          await client.join(presenceRoom(v.userId));
          return {
            userId: v.userId,
            online: await this.isOnline(v.userId),
            lastActiveAt: v.lastActiveAt,
          };
        }),
      );
      return { ok: true, data };
    } catch (e) {
      return errorAck(e, this.logger);
    }
  }

  @SubscribeMessage('presence:unsubscribe')
  async handlePresenceUnsubscribe(
    @ConnectedSocket() client: ChatSocket,
    @MessageBody() body: { userIds?: unknown },
  ): Promise<Ack> {
    if (!client.data.authed) return unauthenticated();
    const ids = Array.isArray(body?.userIds) ? body.userIds.filter(isUuid) : [];
    await Promise.all(ids.map((id) => client.leave(presenceRoom(id))));
    return { ok: true, data: null };
  }

  /** App-level heartbeat (Socket.IO also pings every 25 s): returns server time. */
  @SubscribeMessage('heartbeat')
  handleHeartbeat(): Ack {
    return { ok: true, data: { serverTime: new Date().toISOString() } };
  }

  // ─── server -> client ───────────────────────────────────────────────

  /**
   * message:new to every participant's devices. The recipient's ack marks
   * the message delivered (and gives delivery latency). No ack from any of
   * their devices within 10 s (or no devices at all) means offline: the
   * notifier creates the in-app notification (and push / email digest).
   */
  private deliver(e: ChatMessageEvent) {
    if (!this.server) return;
    const m = e.message;
    for (const p of e.participants) {
      this.server.to(userRoom(p.userId)).emit('conversation:updated', {
        id: m.conversationId,
        lastSeq: m.seq,
        unreadCount: p.unreadCount,
        updatedAt: m.createdAt,
        lastMessage: {
          id: m.id,
          seq: m.seq,
          text: m.text,
          type: m.type,
          senderId: m.senderId,
          hasAttachments: m.attachments.length > 0,
          deleted: false,
          createdAt: m.createdAt,
        },
      });
      if (p.userId === m.senderId) {
        // The sender's other devices (the sending one dedupes by clientMessageId).
        this.server.to(userRoom(p.userId)).emit('message:new', m);
        continue;
      }
      this.server
        .to(userRoom(p.userId))
        .timeout(DELIVERY_ACK_TIMEOUT_MS)
        .emit('message:new', m, (_err: Error | null, acks: unknown[]) => {
          if (acks?.length) {
            chatMetrics.delivered(Date.now() - e.savedAt);
            this.chat
              .markDelivered(m.conversationId, p.userId, m.seq)
              .catch(() => undefined);
          } else {
            this.notifier
              .messageWhileOffline(p.userId, m, p.muted)
              .catch((err: Error) =>
                writeJson(
                  'error',
                  'chat.notify failed',
                  { user: hashUserId(p.userId), error: err.message },
                  'Chat',
                ),
              );
          }
        });
      this.chat
        .emitUnread(p.userId, m.conversationId, p.unreadCount)
        .catch(() => undefined);
    }
  }

  private emitTyping(
    toUserId: string,
    conversationId: string,
    userId: string,
    isTyping: boolean,
  ) {
    this.server?.to(userRoom(toUserId)).emit('typing', {
      conversationId,
      userId,
      isTyping,
      expiresInMs: isTyping ? 5000 : 0,
    });
  }

  private async peer(
    conversationId: string,
    userId: string,
  ): Promise<string | null> {
    const key = `${conversationId}:${userId}`;
    const hit = this.peerCache.get(key);
    if (hit && Date.now() - hit.at < 30_000) return hit.peer;
    const peer = await this.chat.peerFor(conversationId, userId);
    if (this.peerCache.size > 10_000) this.peerCache.clear();
    this.peerCache.set(key, { peer, at: Date.now() });
    return peer;
  }

  /** Local first; across instances through the adapter. */
  async isOnline(userId: string): Promise<boolean> {
    if (this.presence.isOnline(userId)) return true;
    const sockets = await this.server.in(userRoom(userId)).fetchSockets();
    return sockets.length > 0;
  }
}

function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID.test(v);
}

function extractToken(client: Socket): string | null {
  const authHeader = client.handshake.headers?.authorization;
  if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7);
  const t =
    (client.handshake.auth as { token?: unknown } | undefined)?.token ??
    client.handshake.query?.token;
  return typeof t === 'string' && t ? t.replace(/^Bearer /, '') : null;
}

function fail(
  code: ErrorCode,
  message?: string,
  extra: {
    fields?: Record<string, string>;
    retryAfterSeconds?: number;
    reason?: string;
  } = {},
): Ack {
  return {
    ok: false,
    error: { code, message: message ?? DEFAULT_MESSAGES[code], ...extra },
  };
}

const unauthenticated = () =>
  fail(ErrorCode.UNAUTHENTICATED, 'Refresh your session to continue.');

/** AppError -> its public code/message; anything else -> SERVER_ERROR (logged). */
function errorAck(e: unknown, logger: Logger, requestId?: string): Ack {
  const res = (e as { getResponse?: () => unknown }).getResponse?.() as
    | {
        code?: string;
        message?: string;
        fields?: Record<string, string>;
        retryAfterSeconds?: number;
      }
    | undefined;
  if (res?.code) {
    return {
      ok: false,
      error: {
        code: res.code,
        message: res.message ?? 'Something went wrong.',
        ...(res.fields ? { fields: res.fields } : {}),
        ...(res.retryAfterSeconds
          ? { retryAfterSeconds: res.retryAfterSeconds }
          : {}),
      },
    };
  }
  logger.error(
    `Socket handler failed${requestId ? ` (${requestId})` : ''}: ${(e as Error).message}`,
  );
  return fail(ErrorCode.SERVER_ERROR);
}
