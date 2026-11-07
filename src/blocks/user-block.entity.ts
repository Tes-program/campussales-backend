import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { User } from '../users/entities/user.entity';

/** blockerId has blocked blockedId. Blocking hides both users from each other. */
@Entity('user_blocks')
@Unique('UQ_user_blocks_pair', ['blockerId', 'blockedId'])
@Index('IDX_user_blocks_blocked', ['blockedId'])
export class UserBlock {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  blockerId: string;

  @Column({ type: 'uuid' })
  blockedId: string;

  @CreateDateColumn()
  createdAt: Date;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'blockerId' })
  blocker: User;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'blockedId' })
  blocked: User;
}

/**
 * SQL fragment: true when `userIdSql` and the viewer have blocked each other
 * in either direction. Use with a `:viewerId` parameter.
 */
export const blockedEitherWay = (userIdSql: string) =>
  `EXISTS (SELECT 1 FROM "user_blocks" ub WHERE ` +
  `(ub."blockerId" = :viewerId AND ub."blockedId" = ${userIdSql}) OR ` +
  `(ub."blockedId" = :viewerId AND ub."blockerId" = ${userIdSql}))`;
