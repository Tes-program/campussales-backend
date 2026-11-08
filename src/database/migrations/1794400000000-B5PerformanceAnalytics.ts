import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * B5: signed uploads, image clean-up, product analytics, usage-data setting.
 * Guarded and additive (safe to re-run; no data rewritten except backfilling
 * publicId/version on product_images from their Cloudinary URLs).
 */
export class B5PerformanceAnalytics1794400000000 implements MigrationInterface {
  name = 'B5PerformanceAnalytics1794400000000';

  public async up(q: QueryRunner): Promise<void> {
    const add = (table: string, col: string, type: string) =>
      q.query(
        `ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "${col}" ${type}`,
      );

    // uploads: lifecycle for signed direct uploads + responsive URLs
    await add('uploads', 'version', 'integer NULL');
    await add('uploads', 'status', `varchar(16) NOT NULL DEFAULT 'ready'`);
    await add('uploads', 'width', 'integer NULL');
    await add('uploads', 'height', 'integer NULL');
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_uploads_status_created" ON "uploads" ("status", "createdAt")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_uploads_public_id" ON "uploads" ("cloudinaryPublicId")`,
    );

    // product_images: public id + version
    await add('product_images', 'publicId', 'varchar(255) NULL');
    await add('product_images', 'version', 'integer NULL');
    await q.query(`
      UPDATE "product_images"
         SET "version" = (regexp_match("imageUrl", '/image/upload/(?:[^/]+/)*?v([0-9]+)/'))[1]::int,
             "publicId" = (regexp_match("imageUrl", '/image/upload/(?:[^/]+/)*?v[0-9]+/(.+?)(?:\\.[A-Za-z0-9]+)?$'))[1]
       WHERE "publicId" IS NULL
         AND "imageUrl" ~ '^https://res\\.cloudinary\\.com/[^/]+/image/upload/(?:[^/]+/)*?v[0-9]+/'`);
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_product_images_public_id" ON "product_images" ("publicId")`,
    );
    // image clean-up of listings deleted > 30 days ago
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_products_deleted_at" ON "products" ("deletedAt") WHERE "deletedAt" IS NOT NULL`,
    );

    // users: Settings > "Share usage data" (default on)
    await add('users', 'shareUsageData', 'boolean NOT NULL DEFAULT true');

    // analytics_events
    await q.query(`
      CREATE TABLE IF NOT EXISTS "analytics_events" (
        "id" BIGSERIAL PRIMARY KEY,
        "name" varchar(40) NOT NULL,
        "occurredAt" timestamptz NOT NULL,
        "receivedAt" timestamptz NOT NULL DEFAULT now(),
        "anonId" varchar(64) NOT NULL,
        "userId" uuid NULL,
        "props" jsonb NOT NULL DEFAULT '{}'::jsonb
      )`);
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_analytics_name_occurred" ON "analytics_events" ("name", "occurredAt")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_analytics_anon" ON "analytics_events" ("anonId", "occurredAt")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_analytics_received" ON "analytics_events" ("receivedAt")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_analytics_user" ON "analytics_events" ("userId") WHERE "userId" IS NOT NULL`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "analytics_events"`);
    await q.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "shareUsageData"`);
    await q.query(`DROP INDEX IF EXISTS "IDX_products_deleted_at"`);
    await q.query(`DROP INDEX IF EXISTS "IDX_product_images_public_id"`);
    await q.query(
      `ALTER TABLE "product_images" DROP COLUMN IF EXISTS "version", DROP COLUMN IF EXISTS "publicId"`,
    );
    await q.query(`DROP INDEX IF EXISTS "IDX_uploads_public_id"`);
    await q.query(`DROP INDEX IF EXISTS "IDX_uploads_status_created"`);
    await q.query(
      `ALTER TABLE "uploads" DROP COLUMN IF EXISTS "height", DROP COLUMN IF EXISTS "width", DROP COLUMN IF EXISTS "status", DROP COLUMN IF EXISTS "version"`,
    );
  }
}
