import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { Brackets, DataSource, Repository, SelectQueryBuilder } from 'typeorm';
import {
  categorySlugVariants,
  resolveCategorySlug,
} from '../common/constants/categories';
import { ProductStatus } from '../common/constants/listing';
import { notFound } from '../common/errors/app-errors';
import { MSG } from '../common/errors/messages';
import { blockedEitherWay } from '../blocks/user-block.entity';
import { buildTsQuery } from '../search/query-parser';
import { searchDocument } from '../search/search-sql';
import { SearchService } from '../search/search.service';
import { User } from '../users/entities/user.entity';
import { Category } from './entities/category.entity';
import { Product } from './entities/product.entity';
import {
  Cursor,
  decodeCursor,
  encodeCursor,
  LIST_LIMIT_DEFAULT,
  ListProductsQueryDto,
  Sort,
} from './dto/list-products.dto';
import {
  orderedImages,
  priceDropSummary,
  ProductCard,
  sellerCard,
  toCard,
} from './product-card';

export const TOTAL_CAP = 1000;
export const NEARBY_THRESHOLD = 4;
export const NEARBY_LIMIT = 8;

export interface ListResult {
  items: ProductCard[];
  nextCursor: string | null;
  /** Capped at 1000; see totalCapped. */
  total: number;
  totalCapped: boolean;
  didYouMean: string | null;
  fromOtherCampuses: boolean;
  moreFromNearby: ProductCard[];
  // legacy
  data: ProductCard[];
  page: number;
  limit: number;
}

interface Search {
  tsq: string | null;
  text: string;
  categoryIds: string[];
}

const CATEGORY_CACHE_MS = 5 * 60_000;

/**
 * Read side for listings: list/search with keyset cursors, the public item
 * page and similar items. Cards are loaded in one query with images, seller,
 * profile, campus and (for logged-in viewers) the wishlist flag, so a list
 * request costs at most: spell-check (only with q) + ids + capped count +
 * nearby ids (only when a campus is short of results) + cards.
 */
@Injectable()
export class ListingService {
  private categoryCache: { at: number; bySlug: Map<string, string> } | null =
    null;

  constructor(
    @InjectRepository(Product) private readonly products: Repository<Product>,
    @InjectDataSource() private readonly ds: DataSource,
    private readonly search: SearchService,
  ) {}

  // ───────────────────────────── list ─────────────────────────────

  async list(dto: ListProductsQueryDto, viewer?: User): Promise<ListResult> {
    const limit = dto.limit ?? LIST_LIMIT_DEFAULT;
    const sort = this.resolveSort(dto);
    const cursor = dto.cursor ? decodeCursor(dto.cursor) : null;
    const legacyOffset =
      !dto.cursor && dto.page && dto.page > 1 ? (dto.page - 1) * limit : 0;

    let search: Search | null = null;
    let didYouMean: string | null = null;
    if (dto.q) {
      const corrected = await this.search.correct(dto.q);
      didYouMean = corrected.didYouMean;
      search = {
        tsq: buildTsQuery(corrected.tokens),
        text: corrected.tokens.join(' '),
        categoryIds: await this.categoryIdsForTokens(corrected.tokens),
      };
    }

    const campusFilter =
      dto.campus && dto.campus !== 'all' ? dto.campus : undefined;
    const categoryIds = await this.resolveCategoryFilter(dto);

    const base = () => {
      const qb = this.products.createQueryBuilder('p');
      this.applyFilters(qb, dto, viewer, categoryIds, search);
      if (campusFilter)
        qb.andWhere('p."campusId" = :campus', { campus: campusFilter });
      return qb;
    };

    // 1) ids + sort keys
    const idsQb = base().select('p.id', 'id');
    this.applySort(idsQb, sort, search);
    this.applyCursor(idsQb, sort, cursor);
    if (sort === 'relevance') idsQb.offset(cursor?.o ?? legacyOffset);
    else if (legacyOffset) idsQb.offset(legacyOffset);
    idsQb
      .addSelect(`to_char(p."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.US')`, 'cts')
      .addSelect('p.price', 'price')
      .limit(limit + 1);
    const rows: { id: string; cts: string; price: number }[] =
      await idsQb.getRawMany();
    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);

    // 2) capped total
    const [countSql, countParams] = base()
      .select('1')
      .limit(TOTAL_CAP + 1)
      .getQueryAndParameters();
    const [{ n }] = await this.ds.query<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM (${countSql}) t`,
      countParams,
    );

    // 3) nearby fallback (first page only)
    let nearbyIds: string[] = [];
    const firstPage = !dto.cursor && !legacyOffset;
    if (campusFilter && firstPage && pageRows.length < NEARBY_THRESHOLD) {
      const nq = this.products.createQueryBuilder('p');
      this.applyFilters(nq, dto, viewer, categoryIds, search);
      nq.andWhere('(p."campusId" IS NULL OR p."campusId" <> :campus)', {
        campus: campusFilter,
      })
        .leftJoin('universities', 'u', 'u.id = p."campusId"')
        .select('p.id', 'id')
        .orderBy(
          `(u.city IS NOT NULL AND u.city = (SELECT city FROM universities WHERE id = :campus))`,
          'DESC',
        )
        .addOrderBy('p."createdAt"', 'DESC')
        .limit(NEARBY_LIMIT);
      nearbyIds = (await nq.getRawMany<{ id: string }>()).map((r) => r.id);
    }

    // 4) cards (+ wishlist flag)
    const cards = await this.loadCards(
      [...pageRows.map((r) => r.id), ...nearbyIds],
      viewer,
    );
    const items = pageRows
      .map((r) => cards.get(r.id))
      .filter((c): c is ProductCard => !!c);
    const moreFromNearby = nearbyIds
      .map((id) => cards.get(id))
      .filter((c): c is ProductCard => !!c);

    if (dto.q && n === 0) void this.search.logMiss(dto.q);

    const last = pageRows[pageRows.length - 1];
    let nextCursor: string | null = null;
    if (hasMore && last) {
      const c: Cursor =
        sort === 'relevance'
          ? { s: sort, o: (cursor?.o ?? legacyOffset) + limit }
          : sort === 'newest'
            ? { s: sort, c: last.cts, i: last.id }
            : { s: sort, p: Number(last.price), i: last.id };
      nextCursor = encodeCursor(c);
    }

    return {
      items,
      nextCursor,
      total: Math.min(n, TOTAL_CAP),
      totalCapped: n > TOTAL_CAP,
      didYouMean,
      fromOtherCampuses: moreFromNearby.length > 0,
      moreFromNearby,
      data: items,
      page: dto.page ?? 1,
      limit,
    };
  }

  // ───────────────────────────── item ─────────────────────────────

  /**
   * Public item page. Sold/inactive items return 200 with their status;
   * deleted items, hidden (needs_review) items for non-owners and items from
   * blocked users return 404. Email/phone only for the owner.
   */
  async item(id: string, viewer?: User) {
    const p = await this.products.findOne({
      where: { id },
      relations: [
        'images',
        'category',
        'seller',
        'seller.profile',
        'seller.profile.university',
      ],
    });
    if (!p) throw notFound(MSG.productNotFound);
    const isOwner = !!viewer && viewer.id === p.sellerId;
    if (!isOwner && p.status === ProductStatus.NEEDS_REVIEW)
      throw notFound(MSG.productNotFound);

    const [stats] = await this.ds.query<
      {
        itemsSold: number;
        isWishlisted: boolean | null;
        wishlistCount: number | null;
        blocked: boolean;
      }[]
    >(
      `SELECT
         (SELECT count(*)::int FROM "products" WHERE "sellerId" = $1 AND "status" = 'sold' AND "deletedAt" IS NULL) AS "itemsSold",
         ${viewer ? `(SELECT count(*)::int FROM "wishlists" WHERE "productId" = $2 AND "userId" = $3) > 0` : 'NULL'} AS "isWishlisted",
         ${isOwner ? `(SELECT count(*)::int FROM "wishlists" WHERE "productId" = $2)` : 'NULL'} AS "wishlistCount",
         ${viewer && !isOwner ? `EXISTS (SELECT 1 FROM "user_blocks" WHERE ("blockerId" = $3 AND "blockedId" = $1) OR ("blockerId" = $1 AND "blockedId" = $3))` : 'false'} AS "blocked"`,
      viewer ? [p.sellerId, p.id, viewer.id] : [p.sellerId],
    );
    if (stats.blocked) throw notFound(MSG.productNotFound);

    if (!isOwner) {
      // Raw UPDATE: TypeORM's increment() would also bump updatedAt.
      void this.ds
        .query(
          `UPDATE "products" SET "viewCount" = "viewCount" + 1 WHERE "id" = $1`,
          [id],
        )
        .catch(() => undefined);
    }

    const s = p.seller;
    const card = sellerCard(p);
    return {
      id: p.id,
      title: p.title,
      description: p.description,
      price: Number(p.price),
      ...priceDropSummary(p),
      priceHistory: p.priceHistory ?? [],
      condition: p.condition,
      quantity: p.quantity,
      status: p.status,
      isAvailable: p.isAvailable,
      isSold: p.isSold,
      isFeatured: p.isFeatured,
      viewCount: p.viewCount,
      tags: p.tags ?? [],
      sellerId: p.sellerId,
      categoryId: p.categoryId ?? null,
      campusId: p.campusId ?? null,
      category: p.category
        ? { id: p.category.id, name: p.category.name, slug: p.category.slug }
        : null,
      images: orderedImages(p.images),
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
      lastBumpedAt: p.lastBumpedAt ? p.lastBumpedAt.toISOString() : null,
      seller: s
        ? {
            ...card,
            memberSince: s.createdAt.toISOString(),
            itemsSold: stats.itemsSold,
            lastActiveAt: s.lastActiveAt ? s.lastActiveAt.toISOString() : null,
            verifiedStudent: isVerifiedStudent(s),
            ...(isOwner
              ? { email: s.email, phoneNumber: s.phoneNumber ?? null }
              : {}),
          }
        : null,
      ...(viewer ? { isOwner, isWishlisted: !!stats.isWishlisted } : {}),
      ...(isOwner ? { wishlistCount: stats.wishlistCount ?? 0 } : {}),
    };
  }

  /** Same category; same campus first; price within 50–200%; never blocked users. */
  async similar(
    id: string,
    limit: number,
    viewer?: User,
  ): Promise<ProductCard[]> {
    const p = await this.products.findOne({ where: { id } });
    if (!p) throw notFound(MSG.productNotFound);
    const qb = this.products
      .createQueryBuilder('p')
      .select('p.id', 'id')
      .where('p.status = :active', { active: ProductStatus.ACTIVE })
      .andWhere('p.id <> :id', { id })
      .andWhere('p.price BETWEEN :lo AND :hi', {
        lo: Math.floor(Number(p.price) * 0.5),
        hi: Math.ceil(Number(p.price) * 2),
      });
    if (p.categoryId)
      qb.andWhere('p."categoryId" = :cat', { cat: p.categoryId });
    if (viewer) {
      qb.andWhere('p."sellerId" <> :viewerId', {
        viewerId: viewer.id,
      }).andWhere(`NOT ${blockedEitherWay('p."sellerId"')}`);
    }
    qb.orderBy(`(p."campusId" IS NOT DISTINCT FROM :campus)`, 'DESC')
      .setParameter('campus', p.campusId ?? null)
      .addOrderBy('p."createdAt"', 'DESC')
      .limit(limit);
    const ids = (await qb.getRawMany<{ id: string }>()).map((r) => r.id);
    const cards = await this.loadCards(ids, viewer);
    return ids.map((i) => cards.get(i)).filter((c): c is ProductCard => !!c);
  }

  // ─────────────────────────── helpers ────────────────────────────

  /** One query: products with images, category, seller, profile, campus (+ wishlist flag). */
  async loadCards(
    ids: string[],
    viewer?: User,
    opts: { withDeleted?: boolean } = {},
  ): Promise<Map<string, ProductCard>> {
    const out = new Map<string, ProductCard>();
    if (!ids.length) return out;
    const qb = this.products
      .createQueryBuilder('p')
      .leftJoinAndSelect('p.images', 'img')
      .leftJoinAndSelect('p.category', 'cat')
      .leftJoinAndSelect('p.seller', 'seller')
      .leftJoinAndSelect('seller.profile', 'profile')
      .leftJoinAndSelect('profile.university', 'uni')
      .where('p.id IN (:...ids)', { ids });
    if (opts.withDeleted) qb.withDeleted();
    if (viewer) {
      qb.addSelect(
        `EXISTS (SELECT 1 FROM "wishlists" w WHERE w."productId" = p.id AND w."userId" = :viewerId)`,
        'is_wishlisted',
      ).setParameter('viewerId', viewer.id);
    }
    const { entities, raw } = await qb.getRawAndEntities();
    const wish = new Map<string, boolean>();
    for (const r of raw as Record<string, unknown>[]) {
      if (viewer) wish.set(r.p_id as string, !!r.is_wishlisted);
    }
    for (const e of entities) {
      out.set(
        e.id,
        toCard(e, viewer ? { isWishlisted: wish.get(e.id) ?? false } : {}),
      );
    }
    return out;
  }

  private resolveSort(dto: ListProductsQueryDto): Sort {
    if (dto.sort) return dto.sort;
    if (dto.sortBy === 'price')
      return dto.sortOrder === 'asc' ? 'price_asc' : 'price_desc';
    return 'newest';
  }

  private applyFilters(
    qb: SelectQueryBuilder<Product>,
    dto: ListProductsQueryDto,
    viewer: User | undefined,
    categoryIds: string[] | null,
    search: Search | null,
  ) {
    qb.where('p.status = :status', {
      status: dto.status ?? ProductStatus.ACTIVE,
    });
    if (categoryIds)
      qb.andWhere('p."categoryId" IN (:...categoryIds)', { categoryIds });
    if (dto.condition?.length)
      qb.andWhere('p.condition IN (:...conditions)', {
        conditions: dto.condition,
      });
    if (dto.minPrice !== undefined)
      qb.andWhere('p.price >= :minPrice', { minPrice: dto.minPrice });
    if (dto.maxPrice !== undefined)
      qb.andWhere('p.price <= :maxPrice', { maxPrice: dto.maxPrice });
    if (dto.tag)
      qb.andWhere('p.tags @> CAST(:tagJson AS jsonb)', {
        tagJson: JSON.stringify([dto.tag]),
      });
    if (dto.sellerId)
      qb.andWhere('p."sellerId" = :sellerId', { sellerId: dto.sellerId });
    if (viewer) {
      qb.andWhere(`NOT ${blockedEitherWay('p."sellerId"')}`, {
        viewerId: viewer.id,
      });
    }
    if (search) {
      qb.andWhere(
        new Brackets((w) => {
          if (search.tsq) {
            w.where(`${searchDocument('p')} @@ to_tsquery('english', :tsq)`, {
              tsq: search.tsq,
            });
          }
          w.orWhere(`:qtext <% lower(p.title)`, { qtext: search.text });
          if (search.categoryIds.length) {
            w.orWhere('p."categoryId" IN (:...qcats)', {
              qcats: search.categoryIds,
            });
          }
        }),
      );
    }
  }

  private applySort(
    qb: SelectQueryBuilder<Product>,
    sort: Sort,
    search: Search | null,
  ) {
    if (sort === 'relevance' && search) {
      const rank = [
        search.tsq
          ? `ts_rank_cd(${searchDocument('p')}, to_tsquery('english', :tsq))`
          : '0',
        `word_similarity(:qtext, lower(p.title)) * 0.5`,
        search.categoryIds.length
          ? `(CASE WHEN p."categoryId" IN (:...qcats) THEN 0.2 ELSE 0 END)`
          : '0',
      ].join(' + ');
      qb.addSelect(rank, 'rank')
        .orderBy('rank', 'DESC')
        .addOrderBy('p.id', 'DESC');
    } else if (sort === 'price_asc') {
      qb.orderBy('p.price', 'ASC').addOrderBy('p.id', 'ASC');
    } else if (sort === 'price_desc') {
      qb.orderBy('p.price', 'DESC').addOrderBy('p.id', 'DESC');
    } else {
      qb.orderBy('p."createdAt"', 'DESC').addOrderBy('p.id', 'DESC');
    }
  }

  private applyCursor(
    qb: SelectQueryBuilder<Product>,
    sort: Sort,
    c: Cursor | null,
  ) {
    if (!c || c.s !== sort || sort === 'relevance') return;
    if (sort === 'newest') {
      qb.andWhere(
        '(p."createdAt", p.id) < (CAST(:cts AS timestamp), CAST(:cid AS uuid))',
        { cts: c.c, cid: c.i },
      );
    } else if (sort === 'price_asc') {
      qb.andWhere('(p.price, p.id) > (:cp, CAST(:cid AS uuid))', {
        cp: c.p,
        cid: c.i,
      });
    } else {
      qb.andWhere('(p.price, p.id) < (:cp, CAST(:cid AS uuid))', {
        cp: c.p,
        cid: c.i,
      });
    }
  }

  /** category slugs (+ legacy categoryId) -> ids; null means no filter. */
  private async resolveCategoryFilter(
    dto: ListProductsQueryDto,
  ): Promise<string[] | null> {
    const ids: string[] = [];
    if (dto.categoryId) ids.push(dto.categoryId);
    if (dto.category?.length) {
      const map = await this.categoryMap();
      for (const slug of dto.category) {
        for (const v of categorySlugVariants(slug)) {
          const id = map.get(v);
          if (id) ids.push(id);
        }
      }
      if (!ids.length) return ['00000000-0000-0000-0000-000000000000']; // nothing matches
    }
    return ids.length ? [...new Set(ids)] : null;
  }

  private async categoryIdsForTokens(tokens: string[]): Promise<string[]> {
    const slugs = new Set<string>();
    const whole = resolveCategorySlug(tokens.join(' '));
    if (whole) slugs.add(whole);
    for (const t of tokens) {
      const s = resolveCategorySlug(t);
      if (s) slugs.add(s);
    }
    if (!slugs.size) return [];
    const map = await this.categoryMap();
    return [...slugs]
      .flatMap((s) => categorySlugVariants(s))
      .map((v) => map.get(v))
      .filter((x): x is string => !!x);
  }

  private async categoryMap(): Promise<Map<string, string>> {
    if (
      this.categoryCache &&
      Date.now() - this.categoryCache.at < CATEGORY_CACHE_MS
    ) {
      return this.categoryCache.bySlug;
    }
    const rows = await this.ds
      .getRepository(Category)
      .find({ where: { isActive: true } });
    const bySlug = new Map(rows.map((r) => [r.slug, r.id]));
    this.categoryCache = { at: Date.now(), bySlug };
    return bySlug;
  }
}

/**
 * "Verified student" needs a real verification. Today that is a confirmed
 * email on an academic domain (.edu.ng / .edu). See docs/moderation.md for
 * other options.
 */
export function isVerifiedStudent(
  u: Pick<User, 'email' | 'emailVerifiedAt'>,
): boolean {
  return (
    !!u.emailVerifiedAt && /\.(edu\.ng|edu)$/i.test(u.email.split('@')[1] ?? '')
  );
}
