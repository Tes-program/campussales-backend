import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  OneToMany,
} from 'typeorm';
import { UserProfile } from './user-profile.entity';

@Entity('universities')
export class University {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column({ nullable: true })
  location?: string;

  /** Short name, e.g. UNILAG. Exposed as `shortName` by GET /api/schools. */
  @Column({ unique: true, nullable: true })
  code?: string;

  @Column({ type: 'varchar', nullable: true })
  city?: string | null;

  @Column({ default: true })
  isActive: boolean;

  @CreateDateColumn()
  createdAt: Date;

  // Relations
  @OneToMany(() => UserProfile, (profile) => profile.university)
  profiles: UserProfile[];
}
