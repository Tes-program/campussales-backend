import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

/** A search that returned nothing. Query text only: no user id, no IP. */
@Entity('search_misses')
export class SearchMiss {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 100 })
  query: string;

  @CreateDateColumn()
  createdAt: Date;
}
