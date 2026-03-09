import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { ChatService } from './chat.service';

/**
 * Job data shapes for the 'chat' queue.
 */
export interface SendMessageJobData {
  type: 'send-message';
  conversationId: string;
  senderId: string;
  dto: {
    content: string;
    type?: string;
    attachmentUrl?: string;
    replyToId?: string;
    productId?: string;
  };
  /** Socket ID of the sender (so gateway can ack back) */
  socketId: string;
}

export interface MarkReadJobData {
  type: 'mark-read';
  conversationId: string;
  userId: string;
}

export interface DeliveryStatusJobData {
  type: 'delivery-status';
  messageId: string;
  conversationId: string;
  status: string;
}

export type ChatJobData =
  | SendMessageJobData
  | MarkReadJobData
  | DeliveryStatusJobData;

@Processor('chat')
export class ChatProcessor extends WorkerHost {
  private readonly logger = new Logger(ChatProcessor.name);

  constructor(private readonly chatService: ChatService) {
    super();
  }

  async process(job: Job<ChatJobData>): Promise<any> {
    switch (job.data.type) {
      case 'send-message':
        return this.handleSendMessage(job as Job<SendMessageJobData>);
      case 'mark-read':
        return this.handleMarkRead(job as Job<MarkReadJobData>);
      case 'delivery-status':
        return this.handleDeliveryStatus(job as Job<DeliveryStatusJobData>);
      default:
        this.logger.warn(`Unknown job type: ${(job.data as any).type}`);
    }
  }

  private async handleSendMessage(job: Job<SendMessageJobData>) {
    const { conversationId, senderId, dto } = job.data;
    this.logger.debug(
      `Processing message from ${senderId} in conversation ${conversationId}`,
    );

    const message = await this.chatService.sendMessage(
      conversationId,
      senderId,
      dto as any,
    );

    // Return the saved message so the gateway can emit events
    return {
      message,
      conversationId,
      senderId,
      socketId: job.data.socketId,
    };
  }

  private async handleMarkRead(job: Job<MarkReadJobData>) {
    const { conversationId, userId } = job.data;
    await this.chatService.markAsRead(conversationId, userId);
    return { conversationId, userId };
  }

  private async handleDeliveryStatus(job: Job<DeliveryStatusJobData>) {
    const { messageId, status } = job.data;
    const updated = await this.chatService.updateMessageStatus(
      messageId,
      status as any,
    );
    return {
      messageId,
      conversationId: job.data.conversationId,
      status: updated.status,
    };
  }
}
