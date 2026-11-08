import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Product analytics (B5). Deliberately minimal: no IP address, no user
 * agent, a random client-generated anonId, the user id only when logged in,
 * and allowlisted props (see event-schema.ts). Deleted after 13 months.
 */
@Entity('analytics_events')
@Index('IDX_analytics_name_occurred', ['name', 'occurredAt'])
@Index('IDX_analytics_anon', ['anonId', 'occurredAt'])
@Index('IDX_analytics_received', ['receivedAt'])
export class AnalyticsEvent {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Column({ type: 'varchar', length: 40 })
  name: string;

  /** Client time (clamped to the receive time window). */
  @Column({ type: 'timestamptz' })
  occurredAt: Date;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  receivedAt: Date;

  @Column({ type: 'varchar', length: 64 })
  anonId: string;

  @Index('IDX_analytics_user', { where: '"userId" IS NOT NULL' })
  @Column({ type: 'uuid', nullable: true })
  userId: string | null;

  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  props: Record<string, string | number | boolean | null>;
}
