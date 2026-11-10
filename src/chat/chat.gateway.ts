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
  userId: string;
  presenceVisible: boolean;
}
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
 * Connect: `io(API_URL + '/chat', { auth: { token: accessToken } })`. The
 * token is checked before the connection is accepted (connect_error
 * `UNAUTHENTICATED` otherwise) and the socket is closed with `auth:expired`
 * when the token expires; refresh and reconnect.
 *
 * Each socket joins a private room `user:<id>`; all events are addressed to
 * users, never broadcast. Server -> client: message:new (ack it),
 * message:status, message:updated, conversation:updated, typing, presence,
 * unread:update, auth:expired. Client -> server (all acked with
 * { ok, data | error }): message:send, message:delivered, message:read,
 * typing, presence:subscribe, presence:unsubscribe, heartbeat.
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
    nsp.use((socket, next) => {
      this.authenticate(socket as ChatSocket)
        .then(() => next())
        .catch((e: Error & { data?: unknown }) => next(e));
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
    for (const t of this.expiryTimers.values()) clearTimeout(t);
    this.expiryTimers.clear();
  }

  /** Same rules as the HTTP JWT strategy: valid token, active account, not signed out everywhere. */
  private async authenticate(socket: ChatSocket): Promise<void> {
    const fail = () => {
      const err = new Error(ErrorCode.UNAUTHENTICATED) as Error & {
        data: unknown;
      };
      err.data = {
        code: ErrorCode.UNAUTHENTICATED,
        message: DEFAULT_MESSAGES[ErrorCode.UNAUTHENTICATED],
      };
      return err;
    };
    const token = extractToken(socket);
    if (!token) throw fail();
    let payload: { sub?: string; iat?: number; exp?: number };
    try {
      payload = this.jwt.verify(token, {
        secret: this.config.get<string>('JWT_SECRET'),
      });
    } catch {
      throw fail();
    }
    if (!payload.sub || !UUID.test(payload.sub)) throw fail();
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
      throw fail();
    }
    socket.data.userId = payload.sub;
    socket.data.presenceVisible = u.chatPresenceVisible;
    if (payload.exp) {
      const ms = payload.exp * 1000 - Date.now();
      const t = setTimeout(
        () => {
          socket.emit('auth:expired', {
            code: ErrorCode.UNAUTHENTICATED,
            message: 'Your session needs a refresh.',
          });
          socket.disconnect(true);
        },
        Math.max(0, Math.min(ms, 2 ** 31 - 1)),
      );
      t.unref();
      this.expiryTimers.set(socket.id, t);
    }
  }

  async handleConnection(client: ChatSocket) {
    const userId = client.data.userId;
    if (!userId) return client.disconnect(true);
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
    const t = this.expiryTimers.get(client.id);
    if (t) clearTimeout(t);
    this.expiryTimers.delete(client.id);
    const userId = client.data.userId;
    if (!userId) return;
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
   * { conversationId, clientMessageId, text, attachments? } -> ack
   * { ok: true, data: { message, created } }. A retry with the same
   * clientMessageId acks the original message (created: false).
   */
  @SubscribeMessage('message:send')
  async handleSend(
    @ConnectedSocket() client: ChatSocket,
    @MessageBody() body: unknown,
  ): Promise<Ack> {
    const requestId = ChatService.requestId();
    try {
      const { conversationId, ...rest } = (body ?? {}) as Record<
        string,
        unknown
      >;
      if (typeof conversationId !== 'string' || !UUID.test(conversationId)) {
        return fail(ErrorCode.CONVERSATION_NOT_FOUND);
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
        return fail(ErrorCode.VALIDATION_FAILED, undefined, { fields });
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
      return errorAck(e, this.logger, requestId);
    }
  }

  /** { conversationId, seq }: everything up to seq reached this device. */
  @SubscribeMessage('message:delivered')
  async handleDelivered(
    @ConnectedSocket() client: ChatSocket,
    @MessageBody() body: { conversationId?: unknown; seq?: unknown },
  ): Promise<Ack> {
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
  extra: { fields?: Record<string, string>; retryAfterSeconds?: number } = {},
): Ack {
  return {
    ok: false,
    error: { code, message: message ?? DEFAULT_MESSAGES[code], ...extra },
  };
}

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
