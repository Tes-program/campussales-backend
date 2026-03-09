import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Notification, NotificationType } from './entities/notification.entity';
import { FilterNotificationsDto } from './dto/filter-notifications.dto';
import { CreateNotificationDto } from './dto/create-notification.dto';
import { NotificationsGateway } from './notifications.gateway';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @InjectRepository(Notification)
    private notificationsRepository: Repository<Notification>,
    private notificationsGateway: NotificationsGateway,
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
    this.notificationsGateway.sendToUser(dto.userId, {
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
  async markAsRead(id: string, userId: string): Promise<{ message: string }> {
    const notification = await this.notificationsRepository.findOne({
      where: { id, userId },
    });

    if (!notification) {
      throw new NotFoundException('Notification not found');
    }

    notification.isRead = true;
    await this.notificationsRepository.save(notification);

    // Push updated unread count
    await this.pushUnreadCount(userId);

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

    // Push updated unread count (will be 0)
    this.notificationsGateway.sendUnreadCount(userId, 0);

    return { message: 'All notifications marked as read' };
  }

  /**
   * Delete a single notification
   */
  async deleteNotification(
    id: string,
    userId: string,
  ): Promise<{ message: string }> {
    const notification = await this.notificationsRepository.findOne({
      where: { id, userId },
    });

    if (!notification) {
      throw new NotFoundException('Notification not found');
    }

    await this.notificationsRepository.remove(notification);

    // Push updated unread count
    await this.pushUnreadCount(userId);

    return { message: 'Notification deleted' };
  }

  /**
   * Helper: push current unread count to user via socket
   */
  private async pushUnreadCount(userId: string): Promise<void> {
    const count = await this.notificationsRepository.count({
      where: { userId, isRead: false },
    });
    this.notificationsGateway.sendUnreadCount(userId, count);
  }

  // ─── NOTIFICATION HELPER METHODS ─────────────────────────────

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
   * Helper: notify when a new conversation is created with a user
   */
  async notifyNewConversation(
    userId: string,
    senderName: string,
    conversationId: string,
    productTitle?: string,
  ): Promise<Notification> {
    const body = productTitle
      ? `${senderName} started a conversation about "${productTitle}"`
      : `${senderName} started a new conversation with you`;

    return this.create({
      userId,
      type: NotificationType.NEW_CONVERSATION,
      title: 'New Conversation',
      body,
      metadata: { conversationId },
    });
  }

  /**
   * Helper: notify seller when their product is wishlisted
   */
  async notifyWishlistAdded(
    sellerId: string,
    buyerName: string,
    productTitle: string,
    productId: string,
  ): Promise<Notification> {
    return this.create({
      userId: sellerId,
      type: NotificationType.WISHLIST,
      title: 'Product Wishlisted!',
      body: `${buyerName} added "${productTitle}" to their wishlist`,
      metadata: { productId },
    });
  }

  /**
   * Helper: notify wishlisters when a product price drops
   */
  async notifyPriceDrop(
    userId: string,
    productTitle: string,
    oldPrice: number,
    newPrice: number,
    productId: string,
  ): Promise<Notification> {
    const discount = Math.round(((oldPrice - newPrice) / oldPrice) * 100);
    return this.create({
      userId,
      type: NotificationType.PRICE_DROP,
      title: 'Price Drop Alert!',
      body: `"${productTitle}" dropped from ₦${oldPrice.toLocaleString()} to ₦${newPrice.toLocaleString()} (${discount}% off)`,
      metadata: { productId, oldPrice, newPrice, discount },
    });
  }

  /**
   * Helper: notify seller when they receive an offer
   */
  async notifyOfferReceived(
    sellerId: string,
    buyerName: string,
    productTitle: string,
    offerAmount: number,
    productId: string,
  ): Promise<Notification> {
    return this.create({
      userId: sellerId,
      type: NotificationType.OFFER_RECEIVED,
      title: 'New Offer Received',
      body: `${buyerName} offered ₦${offerAmount.toLocaleString()} for "${productTitle}"`,
      metadata: { productId, offerAmount },
    });
  }

  /**
   * Helper: notify buyer when their offer is accepted
   */
  async notifyOfferAccepted(
    buyerId: string,
    productTitle: string,
    offerAmount: number,
    productId: string,
    sellerId: string,
  ): Promise<Notification> {
    return this.create({
      userId: buyerId,
      type: NotificationType.OFFER_ACCEPTED,
      title: 'Offer Accepted!',
      body: `Your offer of ₦${offerAmount.toLocaleString()} for "${productTitle}" was accepted`,
      metadata: { productId, offerAmount, sellerId },
    });
  }

  /**
   * Helper: notify buyer when their offer is rejected
   */
  async notifyOfferRejected(
    buyerId: string,
    productTitle: string,
    offerAmount: number,
    productId: string,
    sellerId: string,
  ): Promise<Notification> {
    return this.create({
      userId: buyerId,
      type: NotificationType.OFFER_REJECTED,
      title: 'Offer Declined',
      body: `Your offer of ₦${offerAmount.toLocaleString()} for "${productTitle}" was declined`,
      metadata: { productId, offerAmount, sellerId },
    });
  }

  /**
   * Helper: notify seller when their product is sold
   */
  async notifyProductSold(
    sellerId: string,
    productTitle: string,
    productId: string,
    buyerName?: string,
  ): Promise<Notification> {
    const body = buyerName
      ? `"${productTitle}" has been sold to ${buyerName}!`
      : `"${productTitle}" has been marked as sold.`;

    return this.create({
      userId: sellerId,
      type: NotificationType.PRODUCT_SOLD,
      title: 'Item Sold!',
      body,
      metadata: { productId },
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
