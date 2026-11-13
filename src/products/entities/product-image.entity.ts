import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Product } from './product.entity';

@Entity('product_images')
export class ProductImage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  productId: string;

  /** Full URL, kept for older clients. */
  @Column()
  imageUrl: string;

  /** Cloudinary public id + version (parsed from the URL) for responsive URLs. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  publicId?: string | null;

  @Column({ type: 'int', nullable: true })
  version?: number | null;

  /** Set when the file is missing (scripts/mark-missing-images.js). */
  @Column({ type: 'timestamptz', nullable: true })
  unavailableAt?: Date | null;

  @Column({ default: false })
  isPrimary: boolean;

  @Column({ default: 0 })
  sortOrder: number;

  @CreateDateColumn()
  createdAt: Date;

  // Relations
  @ManyToOne(() => Product, (product) => product.images, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'productId' })
  product: Product;
}
