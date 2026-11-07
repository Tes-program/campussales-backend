import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ListingService } from '../products/listing.service';
import { ProductCard } from '../products/product-card';
import { User } from '../users/entities/user.entity';
import { FeedCandidate, rankFeed } from './feed-score';

export const FEED_POOL = 400;
export const FEED_PAGE = 20;

@Injectable()
export class FeedService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly listing: ListingService,
  ) {}

  /**
   * Personal feed: a pool of recent live items (same-campus first), scored by
   * feed-score.ts, never the viewer's own items or blocked users. Cursor is
   * an offset into the ranked pool.
   */
  async feed(viewer: User, offset = 0, limit = FEED_PAGE) {
    const campusId = viewer.profile?.universityId ?? null;
    const interests = viewer.profile?.interests ?? [];
    const rows: Array<{
      id: string;
      sellerId: string;
      createdAt: Date;
      campusId: string | null;
      categorySlug: string | null;
      lastPriceDropAt: Date | null;
      sellerLastActiveAt: Date | null;
    }> = await this.ds.query(
      `SELECT p."id", p."sellerId", p."createdAt", p."campusId", c."slug" AS "categorySlug",
              CASE WHEN (p."priceHistory"->-1->>'newPrice')::int < (p."priceHistory"->-1->>'oldPrice')::int
                   THEN (p."priceHistory"->-1->>'changedAt')::timestamptz END AS "lastPriceDropAt",
              u."lastActiveAt" AS "sellerLastActiveAt"
         FROM "products" p
         JOIN "users" u ON u."id" = p."sellerId"
         LEFT JOIN "categories" c ON c."id" = p."categoryId"
        WHERE p."status" = 'active' AND p."deletedAt" IS NULL
          AND p."sellerId" <> $1
          AND NOT EXISTS (SELECT 1 FROM "user_blocks" b
                           WHERE (b."blockerId" = $1 AND b."blockedId" = p."sellerId")
                              OR (b."blockedId" = $1 AND b."blockerId" = p."sellerId"))
          AND NOT EXISTS (SELECT 1 FROM "reports" rr WHERE rr."reporterId" = $1 AND (
                (rr."targetType" = 'listing' AND rr."targetId" = p."id") OR
                (rr."targetType" = 'user' AND rr."targetId" = p."sellerId")))
        ORDER BY (p."campusId" IS NOT DISTINCT FROM $2) DESC, p."createdAt" DESC
        LIMIT ${FEED_POOL}`,
      [viewer.id, campusId],
    );
    const candidates: FeedCandidate[] = rows.map((r) => ({
      ...r,
      createdAt: new Date(r.createdAt),
      lastPriceDropAt: r.lastPriceDropAt ? new Date(r.lastPriceDropAt) : null,
      sellerLastActiveAt: r.sellerLastActiveAt
        ? new Date(r.sellerLastActiveAt)
        : null,
    }));
    const ranked = rankFeed(candidates, { campusId, interests });
    const page = ranked.slice(offset, offset + limit);
    const cards = await this.listing.loadCards(
      page.map((p) => p.id),
      viewer,
    );
    const items: ProductCard[] = page
      .map((p) => cards.get(p.id))
      .filter((c): c is ProductCard => !!c);
    const next = offset + limit < ranked.length ? offset + limit : null;
    return {
      items,
      nextCursor:
        next === null
          ? null
          : Buffer.from(JSON.stringify({ o: next })).toString('base64url'),
    };
  }
}
