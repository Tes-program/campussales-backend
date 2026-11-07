// src/users/entities/user.entity.ts
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToOne,
  OneToMany,
  AfterLoad,
} from 'typeorm';
import { Exclude } from 'class-transformer';
import { UserProfile } from './user-profile.entity';
import { Product } from '../../products/entities/product.entity';
import { Wishlist } from '../../wishlist/entities/wishlist.entity'; // Add this import
import { UserType, UserStatus } from '../../common/enum/user.enums';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  email: string;

  @Column()
  @Exclude()
  passwordHash: string;

  /** Stored as +234XXXXXXXXXX (normalised on write since B1). */
  @Column({ type: 'varchar', nullable: true })
  phoneNumber?: string | null;

  @Column({
    type: 'enum',
    enum: UserType,
    default: UserType.STUDENT,
  })
  userType: UserType;

  @Column({
    type: 'enum',
    enum: UserStatus,
    default: UserStatus.ACTIVE,
  })
  status: UserStatus;

  @Column({ unique: true })
  username: string;

  @Column({ default: true })
  isActive: boolean;

  @Column({ default: false })
  isVerified: boolean;

  /** Name given at sign-up (onboarding later fills profile first/last name). */
  @Column({ type: 'varchar', length: 80, nullable: true })
  fullName?: string | null;

  @Column({ type: 'timestamp', nullable: true })
  emailVerifiedAt?: Date | null;

  /**
   * Unverified accounts may use the app until this time (sign-up + 24h).
   * null = no deadline (accounts created before B2).
   */
  @Column({ type: 'timestamp', nullable: true })
  verifyBy?: Date | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  acceptedTermsVersion?: string | null;

  @Column({ type: 'timestamp', nullable: true })
  acceptedTermsAt?: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  passwordChangedAt?: Date | null;

  /**
   * Access tokens issued before this instant are rejected (set on password
   * change and "sign out of all devices"). Internal; never returned.
   */
  @Column({ type: 'timestamp', nullable: true })
  tokensValidAfter?: Date | null;

  /** School picked at sign-up (optional until onboarding). */
  @Column({ type: 'uuid', nullable: true })
  signupSchoolId?: string | null;

  /** Computed, exposed on every user object. */
  emailVerified?: boolean;

  @AfterLoad()
  computeFlags() {
    this.emailVerified = !!this.emailVerifiedAt;
  }

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  // Relations
  @OneToOne(() => UserProfile, (profile) => profile.user, { cascade: true })
  profile: UserProfile;

  @OneToMany(() => Product, (product) => product.seller)
  products: Product[];

  @OneToMany(() => Wishlist, (wishlist) => wishlist.user) // Add this relation
  wishlists: Wishlist[];
}
