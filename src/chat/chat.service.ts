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
  ) {}

  async createConversation(
    userId: string,
    dto: CreateConversationDto,
  ): Promise<Conversation> {
    if (userId === dto.participantId) {
      throw new BadRequestException('Cannot create a conversation with yourself');
    }

    // Check if a direct conversation already exists between these two users
    const existing = await this.findExistingDirectConversation(
      userId,
      dto.participantId,
      dto.productId,
    );
    if (existing) {
      return this.getConversationById(existing.id, userId);
    }

    const conversation = this.conversationRepo.create({
      type: dto.productId
        ? ConversationType.PRODUCT_INQUIRY
        : dto.type || ConversationType.DIRECT,
      productId: dto.productId,
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

    return this.getConversationById(saved.id, userId);
  }

  async getConversations(
    userId: string,
    filterDto: FilterConversationsDto,
  ): Promise<{ data: any[]; total: number; page: number; limit: number }> {
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
      .leftJoinAndSelect('c.participants', 'p')
      .leftJoinAndSelect('p.user', 'u')
      .leftJoinAndSelect('u.profile', 'profile')
      .leftJoinAndSelect('c.product', 'product')
      .orderBy('c.updatedAt', 'DESC');

    const [conversations, total] = await qb
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    // Enrich with lastMessage and unreadCount
    const data = await Promise.all(
      conversations.map(async (conv) => {
        const lastMessage = await this.messageRepo.findOne({
          where: { conversationId: conv.id },
          order: { createdAt: 'DESC' },
          relations: ['sender', 'sender.profile'],
        });

        const unreadCount = await this.getUnreadCount(conv.id, userId);

        // Get the other participant for display purposes
        const otherParticipant = conv.participants.find(
          (p) => p.userId !== userId,
        );

        return {
          id: conv.id,
          type: conv.type,
          product: conv.product
            ? { id: conv.product.id, title: conv.product.title }
            : null,
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
                createdAt: lastMessage.createdAt,
              }
            : null,
          unreadCount,
          updatedAt: conv.updatedAt,
          createdAt: conv.createdAt,
        };
      }),
    );

    // Filter unread-only if requested
    if (filterDto.filter === ConversationFilter.UNREAD) {
      const filtered = data.filter((c) => c.unreadCount > 0);
      return { data: filtered, total: filtered.length, page, limit };
    }

    return { data, total, page, limit };
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
        'product',
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
  ): Promise<{ data: Message[]; total: number; page: number; limit: number }> {
    const page = filterDto.page ?? 1;
    const limit = filterDto.limit ?? 30;

    // Verify user is a participant
    await this.getConversationById(conversationId, userId);

    const [data, total] = await this.messageRepo.findAndCount({
      where: { conversationId },
      relations: ['sender', 'sender.profile', 'replyTo'],
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    return { data: data.reverse(), total, page, limit };
  }

  async sendMessage(
    conversationId: string,
    senderId: string,
    dto: SendMessageDto,
  ): Promise<Message> {
    // Verify sender is a participant
    await this.getConversationById(conversationId, senderId);

    const message = this.messageRepo.create({
      conversationId,
      senderId,
      content: dto.content,
      type: dto.type || MessageType.TEXT,
      status: MessageStatus.SENT,
      attachmentUrl: dto.attachmentUrl,
      replyToId: dto.replyToId,
    });

    const saved = await this.messageRepo.save(message);

    // Update conversation's updatedAt to push it to top
    await this.conversationRepo.update(conversationId, {
      updatedAt: new Date(),
    });

    // Return with relations
    return this.messageRepo.findOneOrFail({
      where: { id: saved.id },
      relations: ['sender', 'sender.profile', 'replyTo'],
    });
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

  async getUnreadCount(conversationId: string, userId: string): Promise<number> {
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

  async getTotalUnreadCount(userId: string): Promise<number> {
    const participants = await this.participantRepo.find({
      where: { userId },
    });

    let total = 0;
    for (const p of participants) {
      total += await this.getUnreadCount(p.conversationId, userId);
    }
    return total;
  }

  async deleteConversation(
    conversationId: string,
    userId: string,
  ): Promise<void> {
    const conversation = await this.getConversationById(conversationId, userId);
    this.assertParticipant(conversation, userId);
    await this.conversationRepo.remove(conversation);
  }

  // ---- Private helpers ----

  private async findExistingDirectConversation(
    userId: string,
    otherUserId: string,
    productId?: string,
  ): Promise<Conversation | null> {
    const qb = this.conversationRepo
      .createQueryBuilder('c')
      .innerJoin('c.participants', 'p1', 'p1.userId = :userId', { userId })
      .innerJoin('c.participants', 'p2', 'p2.userId = :otherUserId', {
        otherUserId,
      });

    if (productId) {
      qb.andWhere('c.productId = :productId', { productId });
    } else {
      qb.andWhere('c.productId IS NULL');
    }

    return qb.getOne();
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
}
