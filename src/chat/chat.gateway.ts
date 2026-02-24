import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket,
  MessageBody,
  WsException,
} from '@nestjs/websockets';
import {
  Logger,
  UnauthorizedException,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { ChatService } from './chat.service';
import { SendMessageDto } from './dto/send-message.dto';
import { MessageStatus } from './enums/chat.enums';

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
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(ChatGateway.name);
  // userId -> Set<socketId>
  private onlineUsers = new Map<string, Set<string>>();
  // Typing auto-expiry: `${conversationId}:${userId}` -> timeout handle
  private typingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly TYPING_TIMEOUT_MS = 5000;

  constructor(
    private jwtService: JwtService,
    private configService: ConfigService,
    private chatService: ChatService,
  ) {}

  // --- Connection lifecycle ---

  async handleConnection(client: AuthenticatedSocket) {
    try {
      const token =
        client.handshake.auth?.token ||
        client.handshake.headers?.authorization?.replace('Bearer ', '');

      if (!token) {
        throw new UnauthorizedException('No token provided');
      }

      const payload = this.jwtService.verify(token, {
        secret: this.configService.get<string>('JWT_SECRET'),
      });

      client.userId = payload.sub;

      // Track online status
      if (!this.onlineUsers.has(client.userId)) {
        this.onlineUsers.set(client.userId, new Set());
      }
      this.onlineUsers.get(client.userId)!.add(client.id);

      // Join user's personal room for direct notifications
      await client.join(`user:${client.userId}`);

      // Broadcast online status
      this.server.emit('user:online', { userId: client.userId });

      this.logger.log(`Client connected: ${client.userId} (${client.id})`);
    } catch {
      this.logger.warn(`Unauthorized connection attempt: ${client.id}`);
      client.emit('error', { message: 'Unauthorized' });
      client.disconnect();
    }
  }

  handleDisconnect(client: AuthenticatedSocket) {
    if (!client.userId) return;

    const sockets = this.onlineUsers.get(client.userId);
    if (sockets) {
      sockets.delete(client.id);
      if (sockets.size === 0) {
        this.onlineUsers.delete(client.userId);
        // Broadcast offline + lastSeen
        this.server.emit('user:offline', {
          userId: client.userId,
          lastSeen: new Date().toISOString(),
        });
      }
    }

    // Clear any typing timers for this user on disconnect
    this.clearAllTypingTimersForUser(client.userId);

    this.logger.log(`Client disconnected: ${client.userId} (${client.id})`);
  }

  // --- Events ---

  @SubscribeMessage('conversation:join')
  async handleJoinConversation(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { conversationId: string },
  ) {
    try {
      if (!data?.conversationId) {
        throw new WsException('conversationId is required');
      }

      // Verify the user is a participant before letting them join the room
      await this.chatService.getConversationById(
        data.conversationId,
        client.userId,
      );
      await client.join(`conversation:${data.conversationId}`);
      this.logger.log(
        `User ${client.userId} joined conversation room ${data.conversationId}`,
      );
      return {
        event: 'conversation:joined',
        data: { conversationId: data.conversationId },
      };
    } catch (error) {
      this.logger.error(
        `Error joining conversation: ${error.message}`,
        error.stack,
      );
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
    // Clear typing timer when leaving
    this.clearTypingTimer(data.conversationId, client.userId);
    await client.leave(`conversation:${data.conversationId}`);
    return {
      event: 'conversation:left',
      data: { conversationId: data.conversationId },
    };
  }

  @SubscribeMessage('message:send')
  async handleSendMessage(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody()
    data: { conversationId: string } & SendMessageDto,
  ) {
    try {
      if (!data?.conversationId) {
        throw new WsException('conversationId is required');
      }

      const { conversationId, ...messageDto } = data;

      // Normalize type to lowercase to match DB enum values (text, image, file)
      // Frontend may send "TEXT", "IMAGE", etc. — DB expects lowercase
      if (messageDto.type) {
        messageDto.type =
          messageDto.type.toLowerCase() as SendMessageDto['type'];
      }

      const message = await this.chatService.sendMessage(
        conversationId,
        client.userId,
        messageDto,
      );

      // Clear typing indicator since user sent a message
      this.clearTypingTimer(conversationId, client.userId);
      client.to(`conversation:${conversationId}`).emit('typing:stop', {
        conversationId,
        userId: client.userId,
      });

      // Emit to all participants in the conversation room
      this.server
        .to(`conversation:${conversationId}`)
        .emit('message:new', message);

      // Notify participants who are NOT in the conversation room (avoids duplicates)
      const conversation = await this.chatService.getConversationById(
        conversationId,
        client.userId,
      );

      const conversationRoom = `conversation:${conversationId}`;
      const socketsInRoom = await this.server
        .in(conversationRoom)
        .fetchSockets();
      const userIdsInRoom = new Set(
        socketsInRoom.map((s) => (s as unknown as AuthenticatedSocket).userId),
      );

      for (const participant of conversation.participants) {
        if (
          participant.userId !== client.userId &&
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

      return message;
    } catch (error) {
      this.logger.error(`Error sending message: ${error.message}`, error.stack);
      throw new WsException(error.message || 'Failed to send message');
    }
  }

  @SubscribeMessage('message:delivered')
  async handleMessageDelivered(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { messageId: string; conversationId: string },
  ) {
    try {
      if (!data?.messageId || !data?.conversationId) {
        throw new WsException('messageId and conversationId are required');
      }

      const updated = await this.chatService.updateMessageStatus(
        data.messageId,
        MessageStatus.DELIVERED,
      );
      this.server
        .to(`conversation:${data.conversationId}`)
        .emit('message:status', {
          messageId: data.messageId,
          status: updated.status,
        });
    } catch (error) {
      this.logger.error(
        `Error updating message status: ${error.message}`,
        error.stack,
      );
      throw new WsException(error.message || 'Failed to update message status');
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

      await this.chatService.markAsRead(data.conversationId, client.userId);
      this.server
        .to(`conversation:${data.conversationId}`)
        .emit('messages:read', {
          conversationId: data.conversationId,
          readBy: client.userId,
          readAt: new Date().toISOString(),
        });
    } catch (error) {
      this.logger.error(
        `Error marking messages as read: ${error.message}`,
        error.stack,
      );
      throw new WsException(error.message || 'Failed to mark messages as read');
    }
  }

  @SubscribeMessage('typing:start')
  handleTypingStart(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { conversationId: string },
  ) {
    if (!data?.conversationId) return;

    const timerKey = `${data.conversationId}:${client.userId}`;

    // Clear any existing timer
    this.clearTypingTimer(data.conversationId, client.userId);

    // Broadcast typing start
    client.to(`conversation:${data.conversationId}`).emit('typing:start', {
      conversationId: data.conversationId,
      userId: client.userId,
    });

    // Set auto-expiry: if no typing:stop within TYPING_TIMEOUT_MS,
    // automatically emit typing:stop to prevent "typing forever" on disconnect/crash
    const timer = setTimeout(() => {
      client.to(`conversation:${data.conversationId}`).emit('typing:stop', {
        conversationId: data.conversationId,
        userId: client.userId,
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

    client.to(`conversation:${data.conversationId}`).emit('typing:stop', {
      conversationId: data.conversationId,
      userId: client.userId,
    });
  }

  @SubscribeMessage('user:check-online')
  handleCheckOnline(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { userIds: string[] },
  ) {
    if (!data?.userIds || !Array.isArray(data.userIds)) {
      throw new WsException('userIds array is required');
    }

    const onlineStatuses = data.userIds.map((id) => ({
      userId: id,
      isOnline: this.onlineUsers.has(id),
    }));
    return onlineStatuses;
  }

  // --- Public method for REST controller to emit socket events ---

  emitNewMessage(conversationId: string, message: any) {
    this.server
      .to(`conversation:${conversationId}`)
      .emit('message:new', message);
  }

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

  // --- Private helpers ---

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

        // Notify conversation rooms that this user stopped typing
        const conversationId = key.split(':')[0];
        this.server
          .to(`conversation:${conversationId}`)
          .emit('typing:stop', { conversationId, userId });
      }
    }
  }
}
