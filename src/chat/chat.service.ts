import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Conversation } from './entities/conversation.entity';
import { ConversationParticipant } from './entities/conversation-participant.entity';
import { Message } from './entities/message.entity';
import { CreateConversationDto } from './dto/create-conversation.dto';
import { SendMessageDto } from './dto/send-message.dto';
import {
  FilterConversationsDto,
  ConversationFilter,
} from './dto/filter-conversations.dto';
import { FilterMessagesDto } from './dto/filter-messages.dto';
import {
  MessageStatus,
  MessageType,
  ConversationType,
} from './enums/chat.enums';
import { NotificationsService } from '../notifications/notifications.service';
import { BlocksService } from '../blocks/blocks.service';
import { RateLimitService } from '../common/rate-limit/rate-limit.service';
import {
  rateLimited,
  ValidationFailed,
  notFound,
} from '../common/errors/app-errors';
import { Product } from '../products/entities/product.entity';
import { User } from '../users/entities/user.entity';
import { messageView, MessageView } from './chat-views';
import { scanMessage, SCAM_REVIEW_THRESHOLD } from './scam-signals';

export const CHAT_LIMITS = {
  messageMaxLength: 1000,
  messagesPerMinute: 30,
  newConversationsPerHour: 10,
} as const;

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    @InjectRepository(Conversation)
    private conversationRepo: Repository<Conversation>,
    @InjectRepository(ConversationParticipant)
    private participantRepo: Repository<ConversationParticipant>,
    @InjectRepository(Message)
    private messageRepo: Repository<Message>,
    private readonly notificationsService: NotificationsService,
    private readonly blocks: BlocksService,
    private readonly rateLimit: RateLimitService,
  ) {}

  /**
   * Find or create a conversation between two users.
   * One conversation per user pair (WhatsApp model).
   * productId is passed through for the frontend to use when sending the first message.
   */
  async createConversation(
    userId: string,
    dto: CreateConversationDto,
  ): Promise<{
    conversation: Conversation;
    isExisting: boolean;
    productId?: string;
  }> {
    if (userId === dto.participantId) {
      throw new BadRequestException(
        'You cannot start a conversation with yourself',
      );
    }

    const other = await this.conversationRepo.manager
      .getRepository(User)
      .findOne({ where: { id: dto.participantId } });
    if (!other) throw notFound("We couldn't find that person.");
    await this.blocks.assertNotBlocked(userId, dto.participantId);
    const context = dto.productId
      ? await this.listingContextFor(dto.productId)
      : null;

    // Check if a conversation already exists between these two users
    const existing = await this.findExistingDirectConversation(
      userId,
      dto.participantId,
    );
    if (existing) {
      if (context) {
        await this.conversationRepo.update(existing.id, {
          ...context,
          closedAt: null,
          closedReason: null,
        });
      }
      const conversation = await this.getConversationById(existing.id, userId);
      return {
        conversation,
        isExisting: true,
        productId: dto.productId,
      };
    }

    const limit = await this.rateLimit.consume(
      RateLimitService.key('chat-new', userId),
      CHAT_LIMITS.newConversationsPerHour,
      3_600_000,
    );
    if (!limit.allowed) {
      throw rateLimited(
        "You've started a lot of chats in the last hour. Please try again a bit later.",
        limit.retryAfterSeconds,
      );
    }

    // One conversation per user pair; it carries the latest listing context.
    const conversation = this.conversationRepo.create({
      type: dto.type || ConversationType.DIRECT,
      ...(context ?? {}),
    });
    const saved = await this.conversationRepo.save(conversation);

    // Add both participants
    const participants = [
      this.participantRepo.create({
        conversationId: saved.id,
        userId,
      }),
      this.participantRepo.create({
        conversationId: saved.id,
        userId: dto.participantId,
      }),
    ];
    await this.participantRepo.save(participants);

    const created = await this.getConversationById(saved.id, userId);

    // Notify the other participant about the new conversation (fire-and-forget)
    this.notifyNewConversationCreated(
      userId,
      dto.participantId,
      saved.id,
      created,
    ).catch((err) =>
      this.logger.error(
        'Failed to send new conversation notification',
        err.stack,
      ),
    );

    return {
      conversation: created,
      isExisting: false,
      productId: dto.productId,
    };
  }

  /**
   * Find existing conversation between two users without creating one.
   */
  async findExistingConversation(
    userId: string,
    participantId: string,
  ): Promise<Conversation | null> {
    const existing = await this.findExistingDirectConversation(
      userId,
      participantId,
    );
    if (!existing) return null;
    return this.getConversationById(existing.id, userId);
  }

  /**
   * Get paginated conversations for a user, enriched with
   * lastMessage, unreadCount, otherUser, and lastReferencedProduct.
   */
  async getConversations(
    userId: string,
    filterDto: FilterConversationsDto,
  ): Promise<{
    data: any[];
    total: number;
    page: number;
    limit: number;
    totalUnread: number;
  }> {
    const page = filterDto.page ?? 1;
    const limit = filterDto.limit ?? 10;

    // Get conversation IDs where user is a participant
    const participantQb = this.participantRepo
      .createQueryBuilder('cp')
      .select('cp.conversationId')
      .where('cp.userId = :userId', { userId });

    const qb = this.conversationRepo
      .createQueryBuilder('c')
      .where(`c.id IN (${participantQb.getQuery()})`)
      .setParameters(participantQb.getParameters())
      // Chats with blocked users (either direction) are hidden.
      .andWhere(
        `NOT EXISTS (SELECT 1 FROM "conversation_participants" op
                       JOIN "user_blocks" ub ON (ub."blockerId" = :userId AND ub."blockedId" = op."userId")
                                             OR (ub."blockedId" = :userId AND ub."blockerId" = op."userId")
                      WHERE op."conversationId" = c.id AND op."userId" <> :userId)`,
        { userId },
      )
      .leftJoinAndSelect('c.participants', 'p')
      .leftJoinAndSelect('p.user', 'u')
      .leftJoinAndSelect('u.profile', 'profile')
      .orderBy('c.updatedAt', 'DESC');

    const [conversations, total] = await qb
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    // Enrich with lastMessage, unreadCount, and lastReferencedProduct
    const data = await Promise.all(
      conversations.map(async (conv) => {
        const lastMessage = await this.messageRepo.findOne({
          where: { conversationId: conv.id },
          order: { createdAt: 'DESC' },
          relations: ['sender', 'sender.profile'],
        });

        const unreadCount = await this.getUnreadCount(conv.id, userId);

        // Get the other participant for display
        const otherParticipant = conv.participants.find(
          (p) => p.userId !== userId,
        );

        // Get the most recently referenced product in this conversation
        const lastProductMessage = await this.messageRepo.findOne({
          where: { conversationId: conv.id },
          order: { createdAt: 'DESC' },
          relations: ['product', 'product.images'],
        });
        const lastReferencedProduct = lastProductMessage?.product
          ? {
              id: lastProductMessage.product.id,
              title: lastProductMessage.product.title,
              price: lastProductMessage.product.price,
              images: lastProductMessage.product.images,
            }
          : null;

        return {
          id: conv.id,
          type: conv.type,
          otherUser: otherParticipant?.user
            ? {
                id: otherParticipant.user.id,
                username: otherParticipant.user.username,
                profile: otherParticipant.user.profile
                  ? {
                      firstName: otherParticipant.user.profile.firstName,
                      lastName: otherParticipant.user.profile.lastName,
                      profilePictureUrl:
                        otherParticipant.user.profile.profilePictureUrl,
                    }
                  : null,
              }
            : null,
          lastMessage: lastMessage
            ? {
                id: lastMessage.id,
                content: lastMessage.content,
                type: lastMessage.type,
                senderId: lastMessage.senderId,
                status: lastMessage.status,
                createdAt: lastMessage.createdAt.toISOString(),
              }
            : null,
          lastReferencedProduct,
          listing: conv.productId
            ? {
                productId: conv.productId,
                title: conv.productTitle ?? null,
                coverImageUrl: conv.productImageUrl ?? null,
                priceAtStart: conv.productPrice ?? null,
              }
            : null,
          closed: !!conv.closedAt,
          closedReason: conv.closedReason ?? null,
          unreadCount,
          updatedAt: conv.updatedAt.toISOString(),
          createdAt: conv.createdAt.toISOString(),
        };
      }),
    );

    // Filter unread-only if requested
    const totalUnread = await this.getTotalUnreadCount(userId);
    if (filterDto.filter === ConversationFilter.UNREAD) {
      const filtered = data.filter((c) => c.unreadCount > 0);
      return {
        data: filtered,
        total: filtered.length,
        page,
        limit,
        totalUnread,
      };
    }

    return { data, total, page, limit, totalUnread };
  }

  async getConversationById(
    conversationId: string,
    userId: string,
  ): Promise<Conversation> {
    const conversation = await this.conversationRepo.findOne({
      where: { id: conversationId },
      relations: [
        'participants',
        'participants.user',
        'participants.user.profile',
      ],
    });

    if (!conversation) {
      throw new NotFoundException('Conversation not found');
    }

    this.assertParticipant(conversation, userId);
    return conversation;
  }

  async getMessages(
    conversationId: string,
    userId: string,
    filterDto: FilterMessagesDto,
  ): Promise<{
    data: MessageView[];
    total: number;
    page: number;
    limit: number;
  }> {
    const page = filterDto.page ?? 1;
    const limit = filterDto.limit ?? 30;

    // Verify user is a participant
    await this.getConversationById(conversationId, userId);

    const [data, total] = await this.messageRepo.findAndCount({
      where: { conversationId },
      relations: [
        'sender',
        'sender.profile',
        'replyTo',
        'product',
        'product.images',
      ],
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    return { data: data.reverse().map(messageView), total, page, limit };
  }

  /**
   * Every check a send must pass (REST and sockets): participant, not
   * blocked, content rules, and (unless already counted) the 30/minute limit.
   * Returns the cleaned content.
   */
  async assertCanSend(
    conversationId: string,
    senderId: string,
    dto: SendMessageDto,
    opts: { countRate?: boolean } = { countRate: true },
  ): Promise<string> {
    const conversation = await this.getConversationById(
      conversationId,
      senderId,
    );
    for (const p of conversation.participants) {
      if (p.userId !== senderId)
        await this.blocks.assertNotBlocked(senderId, p.userId);
    }
    if (dto.type === MessageType.SYSTEM) {
      throw new ValidationFailed({ type: 'Choose text, image or file.' });
    }
    const content = typeof dto.content === 'string' ? dto.content.trim() : '';
    if (!content && !dto.attachmentUrl) {
      throw new ValidationFailed({ content: 'Type a message.' });
    }
    if (Array.from(content).length > CHAT_LIMITS.messageMaxLength) {
      throw new ValidationFailed({
        content: `Messages can be up to ${CHAT_LIMITS.messageMaxLength} characters.`,
      });
    }
    if (opts.countRate !== false) {
      const limit = await this.rateLimit.consume(
        RateLimitService.key('chat-msg', senderId),
        CHAT_LIMITS.messagesPerMinute,
        60_000,
      );
      if (!limit.allowed) {
        throw rateLimited(
          "You're sending messages very fast. Please slow down.",
          limit.retryAfterSeconds,
        );
      }
    }
    return content;
  }

  async sendMessage(
    conversationId: string,
    senderId: string,
    dto: SendMessageDto,
    opts: { rateAlreadyCounted?: boolean } = {},
  ): Promise<MessageView> {
    const content = await this.assertCanSend(conversationId, senderId, dto, {
      countRate: !opts.rateAlreadyCounted,
    });
    const flags = scanMessage(content);

    const message = this.messageRepo.create({
      conversationId,
      senderId,
      content,
      flags,
      type: dto.type || MessageType.TEXT,
      status: MessageStatus.SENT,
      attachmentUrl: dto.attachmentUrl,
      replyToId: dto.replyToId,
      productId: dto.productId,
    });

    const saved = await this.messageRepo.save(message);

    // Update conversation's updatedAt to push it to top
    await this.conversationRepo.update(conversationId, {
      updatedAt: new Date(),
    });

    // Return with all relations including product
    const fullMessage = await this.messageRepo.findOneOrFail({
      where: { id: saved.id },
      relations: [
        'sender',
        'sender.profile',
        'replyTo',
        'product',
        'product.images',
      ],
    });

    // Notify other participants (fire-and-forget)
    this.notifyMessageParticipants(conversationId, senderId, fullMessage).catch(
      (err) =>
        this.logger.error('Failed to send message notifications', err.stack),
    );
    if (flags.length) {
      this.reviewIfRepeatedSignals(senderId).catch(() => undefined);
    }

    return messageView(fullMessage);
  }

  /**
   * Flags only: if one account sent flagged messages in more than 5
   * conversations in 24h, surface the account in the admin queue.
   */
  private async reviewIfRepeatedSignals(senderId: string): Promise<void> {
    const [row] = await this.messageRepo.query<{ n: number }[]>(
      `SELECT count(DISTINCT "conversationId")::int AS n FROM "messages"
        WHERE "senderId" = $1 AND "flags" <> '[]'::jsonb
          AND "createdAt" > now() - ($2 || ' hours')::interval`,
      [senderId, String(SCAM_REVIEW_THRESHOLD.windowHours)],
    );
    if ((row?.n ?? 0) > SCAM_REVIEW_THRESHOLD.conversations) {
      await this.messageRepo.query(
        `UPDATE "users" SET "needsReviewAt" = now(),
                "needsReviewReason" = 'Possible scam patterns in chat messages across many conversations'
          WHERE "id" = $1 AND "needsReviewAt" IS NULL`,
        [senderId],
      );
    }
  }

  /** Listing snapshot stored on the conversation (title, cover, price at the time). */
  private async listingContextFor(productId: string) {
    const p = await this.conversationRepo.manager
      .getRepository(Product)
      .findOne({ where: { id: productId }, relations: ['images'] });
    if (!p) throw notFound('This item is no longer available.');
    const cover =
      [...(p.images ?? [])].sort(
        (a, b) =>
          Number(b.isPrimary) - Number(a.isPrimary) ||
          a.sortOrder - b.sortOrder,
      )[0]?.imageUrl ?? null;
    return {
      productId: p.id,
      productTitle: p.title,
      productImageUrl: cover,
      productPrice: Number(p.price),
    };
  }

  /**
   * Send notification to all participants in a conversation except the sender.
   */
  private async notifyMessageParticipants(
    conversationId: string,
    senderId: string,
    message: Message,
  ): Promise<void> {
    const participants = await this.participantRepo.find({
      where: { conversationId },
    });

    const senderName =
      message.sender?.profile?.firstName ||
      message.sender?.username ||
      'Someone';

    const preview = message.content || '📎 Attachment';

    for (const participant of participants) {
      if (participant.userId !== senderId) {
        await this.notificationsService.notifyNewMessage(
          participant.userId,
          senderName,
          conversationId,
          preview,
        );
      }
    }
  }

  async markAsRead(conversationId: string, userId: string): Promise<void> {
    // Verify user is a participant
    await this.getConversationById(conversationId, userId);

    // Update lastReadAt for this participant
    await this.participantRepo.update(
      { conversationId, userId },
      { lastReadAt: new Date() },
    );

    // Mark all messages from other users as read
    await this.messageRepo
      .createQueryBuilder()
      .update(Message)
      .set({ status: MessageStatus.READ })
      .where('conversationId = :conversationId', { conversationId })
      .andWhere('senderId != :userId', { userId })
      .andWhere('status != :read', { read: MessageStatus.READ })
      .execute();
  }

  async updateMessageStatus(
    messageId: string,
    status: MessageStatus,
  ): Promise<Message> {
    const message = await this.messageRepo.findOne({
      where: { id: messageId },
    });
    if (!message) {
      throw new NotFoundException('Message not found');
    }

    // Only allow forward status transitions: sent -> delivered -> read
    const statusOrder = [
      MessageStatus.SENT,
      MessageStatus.DELIVERED,
      MessageStatus.READ,
    ];
    if (statusOrder.indexOf(status) <= statusOrder.indexOf(message.status)) {
      return message;
    }

    message.status = status;
    return this.messageRepo.save(message);
  }

  async getUnreadCount(
    conversationId: string,
    userId: string,
  ): Promise<number> {
    const participant = await this.participantRepo.findOne({
      where: { conversationId, userId },
    });

    if (!participant) return 0;

    const qb = this.messageRepo
      .createQueryBuilder('m')
      .where('m.conversationId = :conversationId', { conversationId })
      .andWhere('m.senderId != :userId', { userId });

    if (participant.lastReadAt) {
      qb.andWhere('m.createdAt > :lastReadAt', {
        lastReadAt: participant.lastReadAt,
      });
    }

    return qb.getCount();
  }

  /** One query: unread messages across the user's visible conversations. */
  async getTotalUnreadCount(userId: string): Promise<number> {
    const [row] = await this.messageRepo.query<{ n: number }[]>(
      `SELECT count(*)::int AS n
         FROM "messages" m
         JOIN "conversation_participants" cp
           ON cp."conversationId" = m."conversationId" AND cp."userId" = $1
        WHERE m."senderId" <> $1
          AND (cp."lastReadAt" IS NULL OR m."createdAt" > cp."lastReadAt")
          AND NOT EXISTS (SELECT 1 FROM "user_blocks" ub
                           WHERE (ub."blockerId" = $1 AND ub."blockedId" = m."senderId")
                              OR (ub."blockedId" = $1 AND ub."blockerId" = m."senderId"))`,
      [userId],
    );
    return row?.n ?? 0;
  }

  async deleteConversation(
    conversationId: string,
    userId: string,
  ): Promise<void> {
    const conversation = await this.getConversationById(conversationId, userId);
    this.assertParticipant(conversation, userId);
    await this.conversationRepo.remove(conversation);
  }

  async searchMessages(
    conversationId: string,
    userId: string,
    searchTerm: string,
    page: number = 1,
    limit: number = 20,
  ): Promise<{
    data: MessageView[];
    total: number;
    page: number;
    limit: number;
  }> {
    // Verify user is a participant
    await this.getConversationById(conversationId, userId);

    const [data, total] = await this.messageRepo
      .createQueryBuilder('m')
      .leftJoinAndSelect('m.sender', 'sender')
      .leftJoinAndSelect('sender.profile', 'profile')
      .leftJoinAndSelect('m.replyTo', 'replyTo')
      .leftJoinAndSelect('m.product', 'product')
      .leftJoinAndSelect('product.images', 'productImages')
      .where('m.conversationId = :conversationId', { conversationId })
      .andWhere('LOWER(m.content) LIKE LOWER(:searchTerm)', {
        searchTerm: `%${searchTerm}%`,
      })
      .orderBy('m.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    return { data: data.reverse().map(messageView), total, page, limit };
  }

  // ---- Private helpers ----

  /**
   * Find existing conversation between two users (order-independent).
   * No longer considers productId — one conversation per user pair.
   */
  private async findExistingDirectConversation(
    userId: string,
    otherUserId: string,
  ): Promise<Conversation | null> {
    return this.conversationRepo
      .createQueryBuilder('c')
      .innerJoin('c.participants', 'p1', 'p1.userId = :userId', { userId })
      .innerJoin('c.participants', 'p2', 'p2.userId = :otherUserId', {
        otherUserId,
      })
      .getOne();
  }

  private assertParticipant(conversation: Conversation, userId: string): void {
    const isParticipant = conversation.participants.some(
      (p) => p.userId === userId,
    );
    if (!isParticipant) {
      throw new ForbiddenException(
        'You are not a participant of this conversation',
      );
    }
  }

  /**
   * Notify the other participant when a new conversation is created.
   */
  private async notifyNewConversationCreated(
    initiatorId: string,
    recipientId: string,
    conversationId: string,
    conversation: Conversation,
  ): Promise<void> {
    // Get initiator name from conversation participants
    const initiator = conversation.participants.find(
      (p) => p.userId === initiatorId,
    );
    const initiatorName =
      initiator?.user?.profile?.firstName ||
      initiator?.user?.username ||
      'Someone';

    await this.notificationsService.notifyNewConversation(
      recipientId,
      initiatorName,
      conversationId,
    );
  }
}
