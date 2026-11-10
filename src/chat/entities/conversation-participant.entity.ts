import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Unique,
  Index,
} from 'typeorm';
import { Conversation } from './conversation.entity';
import { User } from '../../users/entities/user.entity';
import { bigintNumber } from './bigint-number';

@Entity('conversation_participants')
@Index('IDX_conv_participants_user_last', { synchronize: false })
@Index('IDX_conv_participants_user', { synchronize: false })
@Unique(['conversationId', 'userId'])
export class ConversationParticipant {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  conversationId: string;

  @Column()
  userId: string;

  @Column({ type: 'timestamp', nullable: true })
  lastReadAt?: Date;

  /** C1: unread messages from the other person (incremented on send, recomputed on read). */
  @Column({ type: 'integer', default: 0 })
  unreadCount: number;

  @Column({ type: 'bigint', default: 0, transformer: bigintNumber })
  lastReadSeq: number;

  @Column({ type: 'bigint', default: 0, transformer: bigintNumber })
  lastDeliveredSeq: number;

  /** Copy of the conversation's lastMessageAt: the list's sort key. */
  @Column({ type: 'timestamp', nullable: true })
  lastMessageAt?: Date | null;

  @Column({ default: false })
  archived: boolean;

  @Column({ default: false })
  muted: boolean;

  /** "Delete chat" for this user: messages up to this seq are hidden from them. */
  @Column({ type: 'bigint', nullable: true, transformer: bigintNumber })
  clearedSeq?: number | null;

  @CreateDateColumn()
  createdAt: Date;

  // Relations
  @ManyToOne(() => Conversation, (c) => c.participants, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'conversationId' })
  conversation: Conversation;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;
}
