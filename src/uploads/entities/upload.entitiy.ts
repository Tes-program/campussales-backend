import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';

export enum UploadType {
  PRODUCT_IMAGE = 'product_image',
  PROFILE_AVATAR = 'profile_avatar',
  PROFILE_COVER = 'profile_cover',
}

export type UploadStatus = 'pending' | 'ready' | 'deleted';

@Entity('uploads')
export class Upload {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  userId: string;

  @Column()
  filename: string;

  @Column()
  originalName: string;

  @Column()
  mimetype: string;

  @Column()
  size: number;

  @Column()
  url: string;

  @Column({
    type: 'enum',
    enum: UploadType,
    default: UploadType.PRODUCT_IMAGE,
  })
  uploadType: UploadType;

  @Column({ nullable: true })
  cloudinaryPublicId?: string;

  /** Cloudinary version, so clients can build cache-safe responsive URLs. */
  @Column({ type: 'int', nullable: true })
  version?: number | null;

  /** pending: signature issued, not uploaded/confirmed yet; ready; deleted (file removed). */
  @Column({ type: 'varchar', length: 16, default: 'ready' })
  status: UploadStatus;

  @Column({ type: 'int', nullable: true })
  width?: number | null;

  @Column({ type: 'int', nullable: true })
  height?: number | null;

  @CreateDateColumn()
  createdAt: Date;

  // Relations
  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;
}
