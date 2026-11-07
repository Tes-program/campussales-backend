import { MigrationInterface, QueryRunner } from 'typeorm';
import { searchDocument } from '../../search/search-sql';

/**
 * B3: products, search and feed. Guarded and additive.
 *
 * - extensions pg_trgm, fuzzystrmatch (both "trusted" on PostgreSQL 13+, so
 *   the database owner can create them on Railway)
 * - products.campusId (seller's school at listing time), backfilled
 * - users.lastActiveAt
 * - user_blocks (endpoints arrive in B4; list/search/feed already filter)
 * - search_misses (zero-result queries, no user id)
 * - search_vocabulary materialized view (words from live titles and tags)
 * - indexes: full-text expression, trigram on title, GIN on tags,
 *   (status, campusId, createdAt), (categoryId, status, createdAt),
 *   (sellerId, status), partial indexes for active items
 */
export class B3ProductsSearchFeed1794200000000 implements MigrationInterface {
  name = 'B3ProductsSearchFeed1794200000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
    await q.query(`CREATE EXTENSION IF NOT EXISTS fuzzystrmatch`);

    await q.query(
      `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "campusId" uuid NULL`,
    );
    await q.query(`
      UPDATE "products" p SET "campusId" = up."universityId"
        FROM "user_profiles" up
       WHERE up."userId" = p."sellerId" AND p."campusId" IS NULL AND up."universityId" IS NOT NULL`);
    await q.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "lastActiveAt" TIMESTAMP NULL`,
    );

    await q.query(`
      CREATE TABLE IF NOT EXISTS "user_blocks" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "blockerId" uuid NOT NULL,
        "blockedId" uuid NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_user_blocks_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_user_blocks_pair" UNIQUE ("blockerId", "blockedId"),
        CONSTRAINT "FK_user_blocks_blocker" FOREIGN KEY ("blockerId") REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_user_blocks_blocked" FOREIGN KEY ("blockedId") REFERENCES "users"("id") ON DELETE CASCADE
      )`);
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_user_blocks_blocked" ON "user_blocks" ("blockedId")`,
    );

    await q.query(`
      CREATE TABLE IF NOT EXISTS "search_misses" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "query" varchar(100) NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_search_misses_id" PRIMARY KEY ("id")
      )`);
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_search_misses_created" ON "search_misses" ("createdAt")`,
    );

    // Indexes
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_products_search" ON "products" USING GIN (${searchDocument('products')})`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_products_title_trgm" ON "products" USING GIN (lower("title") gin_trgm_ops)`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_products_tags" ON "products" USING GIN ("tags" jsonb_path_ops)`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_products_status_campus_created" ON "products" ("status", "campusId", "createdAt" DESC, "id" DESC)`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_products_category_status_created" ON "products" ("categoryId", "status", "createdAt" DESC)`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_products_seller_status" ON "products" ("sellerId", "status")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_products_active_created" ON "products" ("createdAt" DESC, "id" DESC) WHERE "status" = 'active' AND "deletedAt" IS NULL`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_products_active_price" ON "products" ("price", "id") WHERE "status" = 'active' AND "deletedAt" IS NULL`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_product_images_product" ON "product_images" ("productId", "sortOrder")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_wishlists_product" ON "wishlists" ("productId")`,
    );

    await q.query(`
      CREATE MATERIALIZED VIEW IF NOT EXISTS "search_vocabulary" AS
      SELECT word, count(*)::int AS ndoc FROM (
        SELECT DISTINCT p."id", w AS word
          FROM "products" p,
               regexp_split_to_table(
                 lower(p."title" || ' ' || translate(coalesce(p."tags"::text, ''), '[]",', '    ')),
                 '[^[:alnum:]]+') AS w
         WHERE p."deletedAt" IS NULL AND p."status" IN ('active', 'sold') AND length(w) >= 2
      ) x GROUP BY word`);
    await q.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_search_vocabulary_word" ON "search_vocabulary" (word)`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_search_vocabulary_trgm" ON "search_vocabulary" USING GIN (word gin_trgm_ops)`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP MATERIALIZED VIEW IF EXISTS "search_vocabulary"`);
    for (const i of [
      'IDX_wishlists_product',
      'IDX_product_images_product',
      'IDX_products_active_price',
      'IDX_products_active_created',
      'IDX_products_seller_status',
      'IDX_products_category_status_created',
      'IDX_products_status_campus_created',
      'IDX_products_tags',
      'IDX_products_title_trgm',
      'IDX_products_search',
    ]) {
      await q.query(`DROP INDEX IF EXISTS "${i}"`);
    }
    await q.query(`DROP TABLE IF EXISTS "search_misses"`);
    await q.query(`DROP TABLE IF EXISTS "user_blocks"`);
    await q.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "lastActiveAt"`);
    await q.query(`ALTER TABLE "products" DROP COLUMN IF EXISTS "campusId"`);
  }
}
