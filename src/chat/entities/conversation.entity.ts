import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
  Index,
} from 'typeorm';
import { ConversationType } from '../enums/chat.enums';
import { ConversationParticipant } from './conversation-participant.entity';
import { Message } from './message.entity';
import { bigintNumber } from './bigint-number';

@Entity('conversations')
@Index('UQ_conversations_pair_product', { synchronize: false })
@Index('IDX_conversations_pair', { synchronize: false })
@Index('IDX_conversations_product', { synchronize: false })
export class Conversation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({
    type: 'enum',
    enum: ConversationType,
    default: ConversationType.DIRECT,
  })
  type: ConversationType;

  /** Listing this chat is about, frozen at the time (B4). */
  @Column({ type: 'uuid', nullable: true })
  productId?: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  productTitle?: string | null;

  @Column({ type: 'varchar', nullable: true })
  productImageUrl?: string | null;

  @Column({ type: 'integer', nullable: true })
  productPrice?: number | null;

  /** The participant pair, sorted (C1): one conversation per (pair, product). */
  @Column({ type: 'uuid', nullable: true })
  userLowId?: string | null;

  @Column({ type: 'uuid', nullable: true })
  userHighId?: string | null;

  /** Last allocated message sequence number (C1). */
  @Column({ type: 'bigint', default: 0, transformer: bigintNumber })
  lastSeq: number;

  @Column({ type: 'timestamp', nullable: true })
  lastMessageAt?: Date | null;

  /** Set when the item is sold or deleted. Messaging still works. */
  @Column({ type: 'timestamp', nullable: true })
  closedAt?: Date | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  closedReason?: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  // Relations
  @OneToMany(() => ConversationParticipant, (p) => p.conversation, {
    cascade: true,
  })
  participants: ConversationParticipant[];

  @OneToMany(() => Message, (m) => m.conversation)
  messages: Message[];
}
