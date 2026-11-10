import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  Index,
} from 'typeorm';

/** A browser's Web Push endpoint (C1). Removed when the push service says it is gone. */
@Entity('push_subscriptions')
@Index('UQ_push_subscriptions_endpoint', { synchronize: false })
@Index('IDX_push_subscriptions_user', { synchronize: false })
export class PushSubscription {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  userId: string;

  @Column('text')
  endpoint: string;

  @Column({ type: 'varchar', length: 255 })
  p256dh: string;

  @Column({ type: 'varchar', length: 255 })
  auth: string;

  @CreateDateColumn()
  createdAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  lastUsedAt?: Date | null;
}
