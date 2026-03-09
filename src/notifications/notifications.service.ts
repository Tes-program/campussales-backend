import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  Notification,
  NotificationType,
} from './entities/notification.entity';
import { FilterNotificationsDto } from './dto/filter-notifications.dto';
import { CreateNotificationDto } from './dto/create-notification.dto';
import { ChatGateway } from '../chat/chat.gateway';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @InjectRepository(Notification)
    private notificationsRepository: Repository<Notification>,
    private chatGateway: ChatGateway,
  ) {}

  /**
   * Create a notification and push it via socket
   */
  async create(dto: CreateNotificationDto): Promise<Notification> {
    const notification = this.notificationsRepository.create({
      userId: dto.userId,
      type: dto.type,
      title: dto.title,
      body: dto.body,
      metadata: dto.metadata,
    });

    const saved = await this.notificationsRepository.save(notification);

    // Push real-time notification via socket
    this.chatGateway.emitNotification(dto.userId, {
      id: saved.id,
      type: saved.type,
      title: saved.title,
      body: saved.body,
      isRead: saved.isRead,
      metadata: saved.metadata,
      createdAt: saved.createdAt.toISOString(),
    });

    this.logger.log(
      `Notification created for user ${dto.userId}: ${dto.title}`,
    );

    return saved;
  }

  /**
   * List user notifications (paginated)
   */
  async findAll(
    userId: string,
    filterDto: FilterNotificationsDto,
  ): Promise<{
    data: Notification[];
    total: number;
    page: number;
    limit: number;
    unreadCount: number;
  }> {
    const { page = 1, limit = 20, type = 'all' } = filterDto;
    const validPage = page < 1 ? 1 : page;
    const validLimit = limit < 1 || limit > 100 ? 20 : limit;

    const where: any = { userId };

    if (type === 'unread') {
      where.isRead = false;
    }

    const [data, total] = await this.notificationsRepository.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      skip: (validPage - 1) * validLimit,
      take: validLimit,
    });

    // Get unread count (always, regardless of filter)
    const unreadCount = await this.notificationsRepository.count({
      where: { userId, isRead: false },
    });

    return {
      data,
      total,
      page: validPage,
      limit: validLimit,
      unreadCount,
    };
  }

  /**
   * Get unread notification count
   */
  async getUnreadCount(userId: string): Promise<{ count: number }> {
    const count = await this.notificationsRepository.count({
      where: { userId, isRead: false },
    });
    return { count };
  }

  /**
   * Mark a single notification as read
   */
  async markAsRead(
    id: string,
    userId: string,
  ): Promise<{ message: string }> {
    const notification = await this.notificationsRepository.findOne({
      where: { id, userId },
    });

    if (!notification) {
      throw new NotFoundException('Notification not found');
    }

    notification.isRead = true;
    await this.notificationsRepository.save(notification);

    return { message: 'Notification marked as read' };
  }

  /**
   * Mark all notifications as read for a user
   */
  async markAllAsRead(userId: string): Promise<{ message: string }> {
    await this.notificationsRepository.update(
      { userId, isRead: false },
      { isRead: true },
    );

    return { message: 'All notifications marked as read' };
  }

  /**
   * Helper: create a message notification
   */
  async notifyNewMessage(
    userId: string,
    senderName: string,
    conversationId: string,
    messagePreview: string,
  ): Promise<Notification> {
    return this.create({
      userId,
      type: NotificationType.MESSAGE,
      title: `New message from ${senderName}`,
      body:
        messagePreview.length > 100
          ? messagePreview.substring(0, 100) + '...'
          : messagePreview,
      metadata: { conversationId },
    });
  }

  /**
   * Helper: create a listing notification (e.g., listing sold)
   */
  async notifyListingSold(
    sellerId: string,
    productTitle: string,
    productId: string,
  ): Promise<Notification> {
    return this.create({
      userId: sellerId,
      type: NotificationType.LISTING,
      title: 'Your listing has been sold!',
      body: `"${productTitle}" has been marked as sold.`,
      metadata: { productId },
    });
  }

  /**
   * Helper: create a system notification
   */
  async notifySystem(
    userId: string,
    title: string,
    body: string,
  ): Promise<Notification> {
    return this.create({
      userId,
      type: NotificationType.SYSTEM,
      title,
      body,
    });
  }
}
