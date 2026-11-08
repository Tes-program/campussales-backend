import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import {
  DataSource,
  EntitySubscriberInterface,
  InsertEvent,
  ObjectLiteral,
  RemoveEvent,
  SoftRemoveEvent,
  UpdateEvent,
} from 'typeorm';
import { Product } from '../../products/entities/product.entity';
import { CacheService, CK } from './cache.service';

/**
 * Called by every write that changes what anonymous visitors see: product
 * create/edit/status/delete, moderation decisions, category edits.
 */
@Injectable()
export class ListingCacheInvalidator {
  constructor(private readonly cache: CacheService) {}

  productChanged(id?: string | null): void {
    if (id) this.cache.delPrefix(CK.item(id));
    this.cache.delPrefix(CK.list);
    this.cache.delPrefix(CK.bootstrap);
    // counts per category change with listings
    this.cache.delPrefix(`${CK.categories}counts`);
  }

  /** A block or report changes what these users may see in their feeds. */
  viewerChanged(...userIds: string[]): void {
    for (const id of userIds) this.cache.delPrefix(CK.feed(id));
  }

  /** Bulk raw-SQL changes (account deletion): drop every cached listing read. */
  allListingsChanged(): void {
    this.cache.delPrefix('item:');
    this.productChanged(null);
  }

  categoriesChanged(): void {
    this.cache.delPrefix(CK.categories);
    this.cache.delPrefix(CK.bootstrap);
    this.cache.delPrefix(CK.list);
  }
}

/**
 * Catches listing writes that go through TypeORM (repository save/update,
 * query-builder updates) anywhere in the app: moderation holds, admin
 * actions, edits. Raw SQL writes call ListingCacheInvalidator directly.
 */
@Injectable()
export class ProductCacheSubscriber
  implements EntitySubscriberInterface<Product>
{
  constructor(
    @InjectDataSource() ds: DataSource,
    private readonly invalidator: ListingCacheInvalidator,
  ) {
    ds.subscribers.push(this);
  }

  listenTo() {
    return Product;
  }

  private changed(entity?: { id?: string } | ObjectLiteral | null) {
    this.invalidator.productChanged(
      (entity as { id?: string } | undefined)?.id ?? null,
    );
  }

  afterInsert(e: InsertEvent<Product>) {
    this.changed(e.entity);
  }
  afterUpdate(e: UpdateEvent<Product>) {
    this.changed(e.entity ?? e.databaseEntity);
  }
  afterSoftRemove(e: SoftRemoveEvent<Product>) {
    this.changed(e.entity ?? e.databaseEntity);
  }
  afterRemove(e: RemoveEvent<Product>) {
    this.changed({ id: e.entityId ?? e.databaseEntity?.id });
  }
}
