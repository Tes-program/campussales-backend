import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
} from 'typeorm';
import { ConversationType } from '../enums/chat.enums';
import { ConversationParticipant } from './conversation-participant.entity';
import { Message } from './message.entity';

@Entity('conversations')
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
