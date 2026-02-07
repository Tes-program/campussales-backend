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

  @CreateDateColumn()
  createdAt: Date;

  // Relations
  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;
}
