import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  Index,
  ManyToOne,
  OneToMany,
  JoinColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Category } from './category.entity';
import { ProductImage } from './product-image.entity';
import {
  ProductCondition,
  ProductStatus,
} from '../../common/constants/listing';

export { ProductCondition, ProductStatus };

export interface PriceChange {
  oldPrice: number;
  newPrice: number;
  changedAt: string;
}

@Entity('products')
@Index('IDX_products_status_deleted', ['status', 'deletedAt'])
export class Product {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  sellerId: string;

  @Column({ nullable: true })
  categoryId?: string;

  @Column()
  title: string;

  @Column({ type: 'text' })
  description: string;

  /** Whole naira (integer). Kobo is not stored; see docs/api.md. */
  @Column({ type: 'integer' })
  price: number;

  @Column({
    type: 'enum',
    enum: ProductCondition,
    default: ProductCondition.USED,
  })
  condition: ProductCondition;

  @Column({ default: 1 })
  quantity: number;

  @Column({ default: true })
  isAvailable: boolean;

  @Column({ default: false })
  isSold: boolean;

  @Column({ default: false })
  isFeatured: boolean;

  @Column({
    type: 'varchar',
    length: 20,
    default: ProductStatus.ACTIVE,
  })
  status: ProductStatus;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  tags: string[];

  /** Newest last. Drives "Price drop" and "Was/Now" in the UI. */
  @Column({ type: 'jsonb', default: () => "'[]'" })
  priceHistory: PriceChange[];

  /** Last time relist bumped createdAt (max once per 24h). */
  @Column({ type: 'timestamp', nullable: true })
  lastBumpedAt?: Date | null;

  /** Soft delete. TypeORM excludes these rows from finds and joins. */
  @DeleteDateColumn({ type: 'timestamp', nullable: true })
  deletedAt?: Date | null;

  @Column({ default: 0 })
  viewCount: number;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  // Relations
  @ManyToOne(() => User, (user) => user.products, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'sellerId' })
  seller: User;

  @ManyToOne(() => Category, (category) => category.products)
  @JoinColumn({ name: 'categoryId' })
  category?: Category;

  @OneToMany(() => ProductImage, (image) => image.product, { cascade: true })
  images: ProductImage[];
}

/** Sets status and keeps the legacy isAvailable/isSold flags in sync. */
export function applyStatus(product: Product, status: ProductStatus): void {
  product.status = status;
  product.isSold = status === ProductStatus.SOLD;
  product.isAvailable = status === ProductStatus.ACTIVE;
}
