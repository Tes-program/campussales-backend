import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { MessageType, MessageStatus } from '../enums/chat.enums';
import { Conversation } from './conversation.entity';
import { User } from '../../users/entities/user.entity';
import { Product } from '../../products/entities/product.entity';
import { bigintNumber } from './bigint-number';

export interface MessageAttachment {
  url: string;
  thumbUrl?: string;
  width?: number;
  height?: number;
}

@Entity('messages')
@Index('UQ_messages_conversation_seq', { synchronize: false })
@Index('UQ_messages_client_id', { synchronize: false })
@Index('IDX_messages_sender_created', { synchronize: false })
@Index('IDX_messages_product', { synchronize: false })
export class Message {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  conversationId: string;

  @Column()
  senderId: string;

  /** Per-conversation sequence number: stable ordering and resume (C1). */
  @Column({ type: 'bigint', transformer: bigintNumber })
  seq: number;

  /** Client-generated id; a retry with the same id returns the same message. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  clientMessageId?: string | null;

  @Column({ type: 'text' })
  content: string;

  /** Images (C1): [{ url, thumbUrl, width?, height? }]. */
  @Column({ type: 'jsonb', default: () => "'[]'" })
  attachments: MessageAttachment[];

  /** The sender deleted it for everyone (within 10 minutes). Never hard-deleted. */
  @Column({ type: 'timestamp', nullable: true })
  deletedAt?: Date | null;

  @Column({
    type: 'enum',
    enum: MessageType,
    default: MessageType.TEXT,
  })
  type: MessageType;

  @Column({
    type: 'enum',
    enum: MessageStatus,
    default: MessageStatus.SENT,
  })
  status: MessageStatus;

  @Column({ nullable: true })
  attachmentUrl?: string;

  @Column({ nullable: true })
  replyToId?: string;

  @Column({ nullable: true })
  productId?: string;

  /**
   * Scam signals (account_number, payment_request, external_link). Used only
   * to protect users: never blocks or edits the message.
   */
  @Column({ type: 'jsonb', default: () => "'[]'" })
  flags: string[];

  @CreateDateColumn()
  createdAt: Date;

  // Relations
  @ManyToOne(() => Conversation, (c) => c.messages, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'conversationId' })
  conversation: Conversation;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'senderId' })
  sender: User;

  @ManyToOne(() => Message, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'replyToId' })
  replyTo?: Message;

  @ManyToOne(() => Product, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'productId' })
  product?: Product;
}
