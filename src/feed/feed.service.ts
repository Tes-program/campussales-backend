import { ProductStatus } from '../common/constants/listing';
import { CACHE_TTL, CacheService, CK } from '../common/cache/cache.service';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ListingService } from '../products/listing.service';
import { ProductCard } from '../products/product-card';
import { User } from '../users/entities/user.entity';
import { FeedCandidate, rankFeed } from './feed-score';

export const FEED_POOL = 400;
export const FEED_PAGE = 20;
const POOL_SLICE = FEED_POOL + 200;

@Injectable()
export class FeedService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly listing: ListingService,
    private readonly cache: CacheService,
  ) {}

  /**
   * Personal feed: a pool of recent live items (same-campus first), scored by
   * feed-score.ts, never the viewer's own items or blocked users. Cursor is
   * an offset into the ranked pool.
   */
  async feed(viewer: User, offset = 0, limit = FEED_PAGE) {
    const campusId = viewer.profile?.universityId ?? null;
    const interests = viewer.profile?.interests ?? [];
    // Ranked candidate ids per user for 30 s: page 2, 3... and the bootstrap
    // + feed pair reuse one ranking. Blocks/reports drop it immediately;
    // cards are always loaded fresh so status/price are current.
    const ranked = await this.cache.wrap(
      `${CK.feed(viewer.id)}${campusId ?? '-'}:${interests.join(',')}`,
      CACHE_TTL.feedPool,
      () => this.rankedIds(viewer.id, campusId, interests),
    );
    const page = ranked.slice(offset, offset + limit);
    const cards = await this.listing.loadCards(page, viewer);
    const items: ProductCard[] = page
      .map((id) => cards.get(id))
      .filter(
        (c): c is ProductCard => !!c && c.status === ProductStatus.ACTIVE,
      );
    const next = offset + limit < ranked.length ? offset + limit : null;
    return {
      items,
      nextCursor:
        next === null
          ? null
          : Buffer.from(JSON.stringify({ o: next })).toString('base64url'),
    };
  }

  private async rankedIds(
    viewerId: string,
    campusId: string | null,
    interests: string[],
  ): Promise<string[]> {
    const rows: Array<{
      id: string;
      sellerId: string;
      createdAt: Date;
      campusId: string | null;
      categorySlug: string | null;
      lastPriceDropAt: Date | null;
      sellerLastActiveAt: Date | null;
    }> = await this.ds.query(
      // Two index-backed top-N slices (same campus, everyone) instead of
      // sorting every live listing: cost stays flat as the catalogue grows.
      // The slack (POOL_SLICE > FEED_POOL) absorbs rows removed by the
      // block/report filters, so the result matches the old full sort.
      `WITH pool AS (
         (SELECT p."id" FROM "products" p
           WHERE p."status" = 'active' AND p."deletedAt" IS NULL
             AND p."campusId" = $2 AND p."sellerId" <> $1
           ORDER BY p."createdAt" DESC LIMIT ${POOL_SLICE})
         UNION
         (SELECT p."id" FROM "products" p
           WHERE p."status" = 'active' AND p."deletedAt" IS NULL
             AND p."sellerId" <> $1
           ORDER BY p."createdAt" DESC LIMIT ${POOL_SLICE})
       )
       SELECT p."id", p."sellerId", p."createdAt", p."campusId", c."slug" AS "categorySlug",
              CASE WHEN (p."priceHistory"->-1->>'newPrice')::int < (p."priceHistory"->-1->>'oldPrice')::int
                   THEN (p."priceHistory"->-1->>'changedAt')::timestamptz END AS "lastPriceDropAt",
              u."lastActiveAt" AS "sellerLastActiveAt"
         FROM pool
         JOIN "products" p ON p."id" = pool."id"
         JOIN "users" u ON u."id" = p."sellerId"
         LEFT JOIN "categories" c ON c."id" = p."categoryId"
        WHERE NOT EXISTS (SELECT 1 FROM "user_blocks" b
                           WHERE (b."blockerId" = $1 AND b."blockedId" = p."sellerId")
                              OR (b."blockedId" = $1 AND b."blockerId" = p."sellerId"))
          AND NOT EXISTS (SELECT 1 FROM "reports" rr WHERE rr."reporterId" = $1 AND (
                (rr."targetType" = 'listing' AND rr."targetId" = p."id") OR
                (rr."targetType" = 'user' AND rr."targetId" = p."sellerId")))
        ORDER BY (p."campusId" IS NOT DISTINCT FROM $2) DESC, p."createdAt" DESC
        LIMIT ${FEED_POOL}`,
      [viewerId, campusId],
    );
    const candidates: FeedCandidate[] = rows.map((r) => ({
      ...r,
      createdAt: new Date(r.createdAt),
      lastPriceDropAt: r.lastPriceDropAt ? new Date(r.lastPriceDropAt) : null,
      sellerLastActiveAt: r.sellerLastActiveAt
        ? new Date(r.sellerLastActiveAt)
        : null,
    }));
    return rankFeed(candidates, { campusId, interests }).map((c) => c.id);
  }
}
