import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToOne,
  JoinColumn,
  ManyToOne,
} from 'typeorm';
import { User } from './user.entity';
import { University } from './university.entity';
import { Gender, GENDERS, Level } from '../../common/constants/profile';

@Entity('user_profiles')
export class UserProfile {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  userId: string;

  @Column()
  firstName: string;

  @Column()
  lastName: string;

  @Column({ type: 'enum', enum: GENDERS, nullable: true })
  gender?: Gender | null;

  /** 100-600, Postgraduate or Alumnus (see common/constants/profile.ts). */
  @Column({ type: 'varchar', length: 20, nullable: true })
  level?: Level | null;

  @Column({ type: 'date', nullable: true })
  dateOfBirth?: Date;

  @Column({ nullable: true })
  profilePictureUrl?: string;

  @Column({ nullable: true })
  universityId?: string;

  @Column({ nullable: true })
  universityName?: string;

  @Column({ type: 'text', nullable: true })
  bio?: string;

  // ✅ FIX: Rename from 'interest' to 'interests' (plural)
  @Column({ type: 'simple-array', nullable: true, name: 'interest' }) // Keep DB column as 'interest'
  interests?: string[]; // ✅ Use 'interests' in code

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  // Relations
  @OneToOne(() => User, (user) => user.profile, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  @ManyToOne(() => University, { nullable: true })
  @JoinColumn({ name: 'universityId' })
  university?: University;
}
