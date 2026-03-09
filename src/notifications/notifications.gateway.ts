import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';

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
  namespace: '/notifications',
  pingInterval: 25000,
  pingTimeout: 60000,
  transports: ['websocket', 'polling'],
})
export class NotificationsGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(NotificationsGateway.name);

  /** userId -> Set<socketId> for multi-device tracking */
  private connectedUsers = new Map<string, Set<string>>();

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  // ─── LIFECYCLE ───────────────────────────────────────────────

  afterInit() {
    this.logger.log('Notifications WebSocket gateway initialised');
  }

  async handleConnection(client: AuthenticatedSocket) {
    try {
      const token =
        client.handshake.auth?.token ||
        client.handshake.headers?.authorization?.replace('Bearer ', '');

      if (!token) {
        this.logger.warn(
          `Notification socket rejected – no token: ${client.id}`,
        );
        client.disconnect(true);
        return;
      }

      const payload = this.jwtService.verify(token, {
        secret: this.configService.get<string>('JWT_SECRET'),
      });

      client.userId = payload.sub;

      // Join personal room
      await client.join(`notify:${client.userId}`);

      // Track connection
      if (!this.connectedUsers.has(client.userId)) {
        this.connectedUsers.set(client.userId, new Set());
      }
      this.connectedUsers.get(client.userId)!.add(client.id);

      this.logger.log(
        `Notification socket connected: user=${client.userId} socket=${client.id}`,
      );
    } catch {
      this.logger.warn(
        `Notification socket rejected – invalid token: ${client.id}`,
      );
      client.disconnect(true);
    }
  }

  handleDisconnect(client: AuthenticatedSocket) {
    if (!client.userId) return;

    const sockets = this.connectedUsers.get(client.userId);
    if (sockets) {
      sockets.delete(client.id);
      if (sockets.size === 0) {
        this.connectedUsers.delete(client.userId);
      }
    }

    this.logger.log(
      `Notification socket disconnected: user=${client.userId} socket=${client.id}`,
    );
  }

  // ─── PUBLIC EMITTERS ─────────────────────────────────────────

  /**
   * Push a notification to a user's personal room.
   */
  sendToUser(userId: string, notification: any) {
    this.server.to(`notify:${userId}`).emit('notification:new', notification);
  }

  /**
   * Push updated unread count to a user (after mark-read, delete, etc.)
   */
  sendUnreadCount(userId: string, count: number) {
    this.server
      .to(`notify:${userId}`)
      .emit('notification:unread-count', { count });
  }

  /**
   * Check if user is connected to the notifications namespace.
   */
  isUserConnected(userId: string): boolean {
    return this.connectedUsers.has(userId);
  }
}
