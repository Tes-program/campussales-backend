import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export const REPORT_TARGETS = ['listing', 'user', 'message'] as const;
export type ReportTarget = (typeof REPORT_TARGETS)[number];
export const REPORT_REASONS = [
  'scam',
  'fake_item',
  'prohibited',
  'spam',
  'harassment',
  'other',
] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

/**
 * A report. Private: never shown to the reported user. Only admins see the
 * reporter id. `targetUserId` is the owner of the target (seller, user,
 * message sender) for repeat-offender checks.
 */
@Entity('reports')
@Index('IDX_reports_target', ['targetType', 'targetId'])
@Index('IDX_reports_reporter_created', ['reporterId', 'createdAt'])
@Index('IDX_reports_status_created', ['status', 'createdAt'])
@Index('IDX_reports_target_user', ['targetUserId', 'status'])
export class Report {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'uuid' }) reporterId: string;
  @Column({ type: 'varchar', length: 16 }) targetType: ReportTarget;
  @Column({ type: 'uuid' }) targetId: string;
  @Column({ type: 'uuid', nullable: true }) targetUserId?: string | null;
  @Column({ type: 'varchar', length: 24 }) reason: ReportReason;
  @Column({ type: 'varchar', length: 1000, nullable: true }) details?:
    | string
    | null;
  /** open | dismissed | actioned (actioned = confirmed) */
  @Column({ type: 'varchar', length: 16, default: 'open' }) status:
    | 'open'
    | 'dismissed'
    | 'actioned';
  @Column({ type: 'varchar', length: 32, nullable: true }) resolution?:
    | string
    | null;
  @Column({ type: 'uuid', nullable: true }) resolvedById?: string | null;
  @Column({ type: 'timestamp', nullable: true }) resolvedAt?: Date | null;
  @CreateDateColumn() createdAt: Date;
}

@Entity('admin_audit_logs')
export class AdminAuditLog {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'uuid' }) adminId: string;
  @Column({ type: 'varchar', length: 32 }) action: string;
  @Column({ type: 'varchar', length: 16 }) targetType: string;
  @Column({ type: 'uuid' }) targetId: string;
  @Column({ type: 'varchar', length: 500, nullable: true }) reason?:
    | string
    | null;
  @Column({ type: 'jsonb', nullable: true }) details?: Record<
    string,
    unknown
  > | null;
  @CreateDateColumn() createdAt: Date;
}
