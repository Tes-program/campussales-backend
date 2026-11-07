import {
  Index,
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';

@Entity('refresh_tokens')
@Index('IDX_refresh_tokens_hash', ['tokenHash'])
@Index('IDX_refresh_tokens_family', ['familyId'])
export class RefreshToken {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  userId: string;

  @Column()
  tokenHash: string;

  @Column()
  expiresAt: Date;

  @Column({ default: false })
  isRevoked: boolean;

  /**
   * All tokens descending from one login share a family. Reusing a rotated
   * token revokes the whole family. Rows created before B2 have no family and
   * are treated as their own family (their id).
   */
  @Column({ type: 'uuid', nullable: true })
  familyId?: string | null;

  /** Set when this token was exchanged for a newer one. */
  @Column({ type: 'timestamp', nullable: true })
  rotatedAt?: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  revokedAt?: Date | null;

  /** logout | logout_all | reuse | password_change | rotated */
  @Column({ type: 'varchar', length: 32, nullable: true })
  revokedReason?: string | null;

  /** Truncated User-Agent, for a future "your devices" screen. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  userAgent?: string | null;

  @CreateDateColumn()
  createdAt: Date;

  // Relations
  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;
}
