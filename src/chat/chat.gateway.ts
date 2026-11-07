import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  ConnectedSocket,
  MessageBody,
  WsException,
} from '@nestjs/websockets';
import { Logger, UsePipes, ValidationPipe } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue, QueueEvents } from 'bullmq';
import { ChatService } from './chat.service';
import { SendMessageDto } from './dto/send-message.dto';
import { MessageStatus } from './enums/chat.enums';
import {
  SendMessageJobData,
  MarkReadJobData,
  DeliveryStatusJobData,
} from './chat.processor';
import { FilterConversationsDto } from './dto/filter-conversations.dto';

interface AuthenticatedSocket extends Socket {
  userId: string;
}

@WebSocketGateway({
  cors: {
    origin: [
      'http://localhost:3000',
      'http://localhost:3001',
      'http://localhost:5173',
    ],
    credentials: true,
  },
  namespace: '/chat',
  pingInterval: 25000,
  pingTimeout: 60000,
  transports: ['websocket', 'polling'],
})
@UsePipes(
  new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    exceptionFactory: (errors) => {
      const messages = errors.map((e) =>
        Object.values(e.constraints || {}).join(', '),
      );
      return new WsException({ message: messages, error: 'Validation failed' });
    },
  }),
)
export class ChatGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(ChatGateway.name);

  /**
   * userId -> Set<socketId>
   * Tracks multi-device / multi-tab connections per user.
   */
  private onlineUsers = new Map<string, Set<string>>();

  /**
   * Typing auto-expiry: `${conversationId}:${userId}` -> timeout handle
   */
  private typingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly TYPING_TIMEOUT_MS = 5000;

  /**
   * Simple per-socket rate limiter: socketId -> { count, resetAt }
   */
  private rateLimits = new Map<string, { count: number; resetAt: number }>();
  private readonly RATE_LIMIT_MAX = 30; // messages per window
  private readonly RATE_LIMIT_WINDOW_MS = 10_000; // 10 seconds

  /** QueueEvents listener (initialised in afterInit) */
  private queueEvents: QueueEvents | null = null;

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly chatService: ChatService,
    @InjectQueue('chat') private readonly chatQueue: Queue,
  ) {}

  // ─── LIFECYCLE ───────────────────────────────────────────────

  afterInit() {
    this.logger.log('Chat WebSocket gateway initialised');

    // Listen for completed queue jobs and emit results via Socket.io
    try {
      const redisHost = this.configService.get<string>(
        'REDIS_HOST',
        'localhost',
      );
      const redisPort = this.configService.get<number>('REDIS_PORT', 6379);
      const redisPassword = this.configService.get<string>('REDIS_PASSWORD');

      this.queueEvents = new QueueEvents('chat', {
        connection: {
          host: redisHost,
          port: redisPort,
          password: redisPassword || undefined,
        },
      });

      this.queueEvents.on('completed', ({ jobId, returnvalue }) => {
        this.handleJobCompleted(jobId, returnvalue);
      });

      this.queueEvents.on('failed', ({ jobId, failedReason }) => {
        this.logger.error(`Job ${jobId} failed: ${failedReason}`);
      });

      this.logger.log('Queue event listeners attached');
    } catch (error) {
      this.logger.error(
        `Failed to set up queue events: ${error.message}`,
        error.stack,
      );
    }
  }

  // ─── CONNECTION ──────────────────────────────────────────────

  async handleConnection(client: AuthenticatedSocket) {
    try {
      const token = this.extractToken(client);
      if (!token) {
        this.disconnectWithError(client, 'MISSING_TOKEN', 'No token provided');
        return;
      }

      const payload = this.jwtService.verify(token, {
        secret: this.configService.get<string>('JWT_SECRET'),
      });
      client.userId = payload.sub;

      // Track online status (multi-device aware)
      if (!this.onlineUsers.has(client.userId)) {
        this.onlineUsers.set(client.userId, new Set());
      }
      this.onlineUsers.get(client.userId)!.add(client.id);

      // Join personal notification room
      await client.join(`user:${client.userId}`);

      // Auto-join ALL conversation rooms this user belongs to
      await this.autoJoinConversations(client);

      // Broadcast online presence to conversation peers
      this.broadcastPresence(client.userId, 'online');

      this.logger.log(`Client connected: ${client.userId} (${client.id})`);

      // Confirm connection to client with useful boot data
      client.emit('connected', {
        userId: client.userId,
        socketId: client.id,
        onlineUsers: this.getOnlineUserIds(),
      });
    } catch {
      this.disconnectWithError(
        client,
        'AUTH_FAILED',
        'Invalid or expired token',
      );
    }
  }

  handleDisconnect(client: AuthenticatedSocket) {
    if (!client.userId) return;

    const sockets = this.onlineUsers.get(client.userId);
    if (sockets) {
      sockets.delete(client.id);
      if (sockets.size === 0) {
        this.onlineUsers.delete(client.userId);
        this.broadcastPresence(client.userId, 'offline');
      }
    }

    // Clean up typing timers & rate limit state
    this.clearAllTypingTimersForUser(client.userId);
    this.rateLimits.delete(client.id);

    this.logger.log(`Client disconnected: ${client.userId} (${client.id})`);
  }

  // ─── ROOM MANAGEMENT ────────────────────────────────────────

  @SubscribeMessage('conversation:join')
  async handleJoinConversation(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { conversationId: string },
  ) {
    try {
      if (!data?.conversationId) {
        throw new WsException('conversationId is required');
      }
      // Verify participant access
      await this.chatService.getConversationById(
        data.conversationId,
        client.userId,
      );
      await client.join(`conversation:${data.conversationId}`);
      this.logger.debug(
        `User ${client.userId} joined room ${data.conversationId}`,
      );
      return {
        event: 'conversation:joined',
        data: { conversationId: data.conversationId },
      };
    } catch (error) {
      this.logger.error(`Join failed: ${error.message}`, error.stack);
      throw new WsException(error.message || 'Failed to join conversation');
    }
  }

  @SubscribeMessage('conversation:leave')
  async handleLeaveConversation(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { conversationId: string },
  ) {
    if (!data?.conversationId) {
      throw new WsException('conversationId is required');
    }
    this.clearTypingTimer(data.conversationId, client.userId);
    await client.leave(`conversation:${data.conversationId}`);
    return {
      event: 'conversation:left',
      data: { conversationId: data.conversationId },
    };
  }

  // ─── MESSAGING (queue-backed) ────────────────────────────────

  @SubscribeMessage('message:send')
  async handleSendMessage(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { conversationId: string } & SendMessageDto,
  ) {
    try {
      if (!data?.conversationId) {
        throw new WsException('conversationId is required');
      }

      // Rate limit check
      if (this.isRateLimited(client.id)) {
        client.emit('message:error', {
          conversationId: data.conversationId,
          error: 'Rate limit exceeded. Please slow down.',
          code: 'RATE_LIMITED',
        });
        return;
      }

      const { conversationId, ...messageDto } = data;

      // Normalise type to lowercase (frontend may send "TEXT")
      if (messageDto.type) {
        messageDto.type =
          messageDto.type.toLowerCase() as SendMessageDto['type'];
      }

      // Same checks as REST (blocks, length, 30/min) before queueing, so the
      // sender gets the standard error code straight away.
      try {
        messageDto.content = await this.chatService.assertCanSend(
          conversationId,
          client.userId,
          messageDto,
        );
      } catch (e) {
        const res = (e as { getResponse?: () => unknown }).getResponse?.() as
          | {
              code?: string;
              message?: string;
              fields?: Record<string, string>;
              retryAfterSeconds?: number;
            }
          | undefined;
        client.emit('message:error', {
          conversationId,
          code: res?.code ?? 'SEND_FAILED',
          error: res?.message ?? 'Message could not be sent.',
          fields: res?.fields,
          retryAfterSeconds: res?.retryAfterSeconds,
        });
        return;
      }

      // Enqueue the message for reliable, async processing
      const job = await this.chatQueue.add(
        'send-message',
        {
          type: 'send-message',
          conversationId,
          senderId: client.userId,
          dto: messageDto,
          socketId: client.id,
        } satisfies SendMessageJobData,
        {
          attempts: 3,
          backoff: { type: 'exponential', delay: 1000 },
          removeOnComplete: 100,
          removeOnFail: 500,
        },
      );

      // Immediately clear typing indicator
      this.clearTypingTimer(conversationId, client.userId);
      client.to(`conversation:${conversationId}`).emit('typing:update', {
        conversationId,
        userId: client.userId,
        isTyping: false,
      });

      // Acknowledge receipt to sender (message is queued, not yet persisted)
      return {
        event: 'message:queued',
        data: { jobId: job.id, conversationId },
      };
    } catch (error) {
      this.logger.error(`Send failed: ${error.message}`, error.stack);
      client.emit('message:error', {
        conversationId: data?.conversationId,
        error: error.message,
        code: 'SEND_FAILED',
      });
    }
  }

  // ─── DELIVERY & READ RECEIPTS ───────────────────────────────

  @SubscribeMessage('message:delivered')
  async handleMessageDelivered(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { messageId: string; conversationId: string },
  ) {
    try {
      if (!data?.messageId || !data?.conversationId) {
        throw new WsException('messageId and conversationId are required');
      }

      await this.chatQueue.add(
        'delivery-status',
        {
          type: 'delivery-status',
          messageId: data.messageId,
          conversationId: data.conversationId,
          status: MessageStatus.DELIVERED,
        } satisfies DeliveryStatusJobData,
        { removeOnComplete: 50, removeOnFail: 200 },
      );

      // Optimistically broadcast status change (processor confirms DB update)
      this.server
        .to(`conversation:${data.conversationId}`)
        .emit('message:status', {
          messageId: data.messageId,
          status: MessageStatus.DELIVERED,
        });
    } catch (error) {
      this.logger.error(`Delivery status failed: ${error.message}`);
      throw new WsException('Failed to update delivery status');
    }
  }

  @SubscribeMessage('message:read')
  async handleMessageRead(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { conversationId: string },
  ) {
    try {
      if (!data?.conversationId) {
        throw new WsException('conversationId is required');
      }

      await this.chatQueue.add(
        'mark-read',
        {
          type: 'mark-read',
          conversationId: data.conversationId,
          userId: client.userId,
        } satisfies MarkReadJobData,
        { removeOnComplete: 50, removeOnFail: 200 },
      );

      // Optimistically notify the sender that their messages were read
      client.to(`conversation:${data.conversationId}`).emit('messages:read', {
        conversationId: data.conversationId,
        readBy: client.userId,
        readAt: new Date().toISOString(),
      });

      return {
        event: 'message:read:ack',
        data: { conversationId: data.conversationId },
      };
    } catch (error) {
      this.logger.error(`Mark read failed: ${error.message}`);
      throw new WsException('Failed to mark as read');
    }
  }

  // ─── TYPING INDICATORS ──────────────────────────────────────

  @SubscribeMessage('typing:start')
  handleTypingStart(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { conversationId: string },
  ) {
    if (!data?.conversationId) return;

    // Clear existing timer and reset
    this.clearTypingTimer(data.conversationId, client.userId);

    client.to(`conversation:${data.conversationId}`).emit('typing:update', {
      conversationId: data.conversationId,
      userId: client.userId,
      isTyping: true,
    });

    // Auto-stop after TYPING_TIMEOUT_MS if client doesn't send typing:stop
    const timerKey = `${data.conversationId}:${client.userId}`;
    const timer = setTimeout(() => {
      client.to(`conversation:${data.conversationId}`).emit('typing:update', {
        conversationId: data.conversationId,
        userId: client.userId,
        isTyping: false,
      });
      this.typingTimers.delete(timerKey);
    }, this.TYPING_TIMEOUT_MS);

    this.typingTimers.set(timerKey, timer);
  }

  @SubscribeMessage('typing:stop')
  handleTypingStop(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { conversationId: string },
  ) {
    if (!data?.conversationId) return;

    this.clearTypingTimer(data.conversationId, client.userId);

    client.to(`conversation:${data.conversationId}`).emit('typing:update', {
      conversationId: data.conversationId,
      userId: client.userId,
      isTyping: false,
    });
  }

  // ─── PRESENCE ────────────────────────────────────────────────

  @SubscribeMessage('user:check-online')
  handleCheckOnline(
    @ConnectedSocket() _client: AuthenticatedSocket,
    @MessageBody() data: { userIds: string[] },
  ) {
    if (!data?.userIds || !Array.isArray(data.userIds)) {
      throw new WsException('userIds array is required');
    }

    return data.userIds.map((id) => ({
      userId: id,
      isOnline: this.onlineUsers.has(id),
    }));
  }

  // ─── PUBLIC EMITTERS (called from ChatController) ────────────

  /**
   * Push a notification payload to a specific user's personal room.
   */
  emitNotification(userId: string, notification: any) {
    this.server.to(`user:${userId}`).emit('notification:new', notification);
  }

  /**
   * Emit a new message to all sockets in a conversation room.
   */
  emitNewMessage(conversationId: string, message: any) {
    this.server
      .to(`conversation:${conversationId}`)
      .emit('message:new', message);
  }

  /**
   * Send a notification to participants NOT currently in the conversation room.
   */
  async emitMessageNotification(
    conversationId: string,
    senderId: string,
    message: any,
  ) {
    const conversationRoom = `conversation:${conversationId}`;
    const socketsInRoom = await this.server.in(conversationRoom).fetchSockets();
    const userIdsInRoom = new Set(
      socketsInRoom.map((s) => (s as unknown as AuthenticatedSocket).userId),
    );

    const conversation = await this.chatService.getConversationById(
      conversationId,
      senderId,
    );

    for (const participant of conversation.participants) {
      if (
        participant.userId !== senderId &&
        !userIdsInRoom.has(participant.userId)
      ) {
        this.server
          .to(`user:${participant.userId}`)
          .emit('message:notification', {
            conversationId,
            message,
          });
      }
    }
  }

  // ─── PRIVATE HELPERS ─────────────────────────────────────────

  private extractToken(client: Socket): string | null {
    const authHeader = client.handshake.headers?.authorization;
    if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7);
    return (
      (client.handshake.auth?.token as string) ||
      (client.handshake.query?.token as string) ||
      null
    );
  }

  private disconnectWithError(client: Socket, code: string, message: string) {
    this.logger.warn(`Disconnecting ${client.id}: ${message}`);
    client.emit('error:auth', { code, message });
    client.disconnect(true);
  }

  /**
   * Auto-join all conversation rooms the user participates in.
   * This ensures they receive messages even when they haven't opened a specific chat.
   */
  private async autoJoinConversations(client: AuthenticatedSocket) {
    try {
      const filterDto = new FilterConversationsDto();
      filterDto.page = 1;
      filterDto.limit = 500;
      const result = await this.chatService.getConversations(
        client.userId,
        filterDto,
      );
      for (const conv of result.data) {
        await client.join(`conversation:${conv.id}`);
      }
      this.logger.debug(
        `User ${client.userId} auto-joined ${result.data.length} rooms`,
      );
    } catch (error) {
      this.logger.error(`Auto-join failed: ${error.message}`);
    }
  }

  /**
   * Broadcast presence change to all conversation rooms this user is in.
   * With the Redis adapter this works across all server instances.
   */
  private broadcastPresence(userId: string, status: 'online' | 'offline') {
    const payload = {
      userId,
      status,
      lastSeen: status === 'offline' ? new Date().toISOString() : null,
    };

    // Emit to the user's personal room (their own tabs pick it up)
    this.server.to(`user:${userId}`).emit('presence:update', payload);

    // Also broadcast globally so any conversation partner listening gets it
    this.server.emit('presence:update', payload);
  }

  /**
   * Simple sliding-window rate limiter per socket.
   */
  private isRateLimited(socketId: string): boolean {
    const now = Date.now();
    const entry = this.rateLimits.get(socketId);

    if (!entry || now > entry.resetAt) {
      this.rateLimits.set(socketId, {
        count: 1,
        resetAt: now + this.RATE_LIMIT_WINDOW_MS,
      });
      return false;
    }

    entry.count++;
    return entry.count > this.RATE_LIMIT_MAX;
  }

  /**
   * Handle completed queue jobs — emit results to Socket.io rooms.
   */
  private handleJobCompleted(jobId: string, returnvalue: any) {
    try {
      const result =
        typeof returnvalue === 'string' ? JSON.parse(returnvalue) : returnvalue;

      if (!result) return;

      if (result.message && result.conversationId) {
        // send-message job completed — broadcast to conversation room
        this.server
          .to(`conversation:${result.conversationId}`)
          .emit('message:new', result.message);

        // Notify offline participants via personal rooms
        void this.notifyOfflineParticipants(
          result.conversationId,
          result.senderId,
          result.message,
        );

        // Emit conversation:updated for sidebar refresh
        this.server
          .to(`conversation:${result.conversationId}`)
          .emit('conversation:updated', {
            conversationId: result.conversationId,
            lastMessage: {
              id: result.message.id,
              content: result.message.content,
              type: result.message.type,
              senderId: result.message.senderId,
              status: result.message.status,
              createdAt: result.message.createdAt,
            },
            updatedAt: result.message.createdAt,
          });
      }
    } catch (error) {
      this.logger.error(
        `Error handling job ${jobId} completion: ${error.message}`,
      );
    }
  }

  private async notifyOfflineParticipants(
    conversationId: string,
    senderId: string,
    message: any,
  ) {
    try {
      const conversationRoom = `conversation:${conversationId}`;
      const socketsInRoom = await this.server
        .in(conversationRoom)
        .fetchSockets();
      const userIdsInRoom = new Set(
        socketsInRoom.map((s) => (s as unknown as AuthenticatedSocket).userId),
      );

      const conversation = await this.chatService.getConversationById(
        conversationId,
        senderId,
      );

      for (const p of conversation.participants) {
        if (p.userId !== senderId && !userIdsInRoom.has(p.userId)) {
          this.server
            .to(`user:${p.userId}`)
            .emit('message:notification', { conversationId, message });
        }
      }
    } catch (error) {
      this.logger.error(`Offline notification failed: ${error.message}`);
    }
  }

  private clearTypingTimer(conversationId: string, userId: string) {
    const timerKey = `${conversationId}:${userId}`;
    const existing = this.typingTimers.get(timerKey);
    if (existing) {
      clearTimeout(existing);
      this.typingTimers.delete(timerKey);
    }
  }

  private clearAllTypingTimersForUser(userId: string) {
    for (const [key, timer] of this.typingTimers.entries()) {
      if (key.endsWith(`:${userId}`)) {
        clearTimeout(timer);
        this.typingTimers.delete(key);

        const conversationId = key.split(':')[0];
        this.server
          .to(`conversation:${conversationId}`)
          .emit('typing:update', { conversationId, userId, isTyping: false });
      }
    }
  }

  private getOnlineUserIds(): string[] {
    return Array.from(this.onlineUsers.keys());
  }
}
