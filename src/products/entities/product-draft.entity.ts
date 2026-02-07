// src/products/entities/product-draft.entity.ts
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { ProductCondition } from './product.entity';

@Entity('product_drafts')
export class ProductDraft {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  sellerId: string;

  @Column({ nullable: true })
  title?: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  price?: number;

  @Column({
    type: 'enum',
    enum: ProductCondition,
    nullable: true,
  })
  condition?: ProductCondition;

  @Column({ nullable: true })
  quantity?: number;

  @Column({ nullable: true })
  categoryId?: string;

  // Store images as JSON array
  @Column({ type: 'simple-json', nullable: true })
  images?: string[];

  // Store tags as JSON array
  @Column({ type: 'simple-json', nullable: true })
  tags?: string[];

  // Store any additional metadata
  @Column({ type: 'simple-json', nullable: true })
  metadata?: Record<string, any>;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  // Relations
  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'sellerId' })
  seller: User;
}
