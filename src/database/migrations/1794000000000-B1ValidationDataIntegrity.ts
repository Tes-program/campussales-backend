import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * B1: validation and data integrity.
 *
 * Every statement is guarded (IF NOT EXISTS / type checks) because databases
 * in the wild were built by `synchronize` and may already have some of these
 * columns. Nothing is deleted.
 *
 * products
 *   - isSold                  (entity had it; no migration ever added it)
 *   - status                  active | inactive | sold | needs_review, backfilled
 *                             from isAvailable/isSold
 *   - tags, priceHistory      jsonb, default []
 *   - lastBumpedAt            relist bump limiter
 *   - deletedAt               soft delete
 *   - price numeric(10,2) -> integer naira, ROUND()ed. Run
 *     scripts/audit-data.js first: it lists rows with kobo values.
 * user_profiles
 *   - level                   100..600, Postgraduate, Alumnus
 *   - gender enum             + 'Prefer not to say'
 * universities
 *   - city
 * users
 *   - index on phoneNumber    (duplicate-number checks)
 */
export class B1ValidationDataIntegrity1794000000000
  implements MigrationInterface
{
  name = 'B1ValidationDataIntegrity1794000000000';

  public async up(q: QueryRunner): Promise<void> {
    // ---- products ----
    await q.query(
      `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "isSold" boolean NOT NULL DEFAULT false`,
    );
    const hadStatus = await q.hasColumn('products', 'status');
    await q.query(
      `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "status" varchar(20) NOT NULL DEFAULT 'active'`,
    );
    if (!hadStatus) {
      await q.query(`
        UPDATE "products" SET "status" = CASE
          WHEN "isSold" THEN 'sold'
          WHEN "isAvailable" THEN 'active'
          ELSE 'inactive' END
      `);
    }
    await q.query(
      `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "tags" jsonb NOT NULL DEFAULT '[]'`,
    );
    await q.query(
      `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "priceHistory" jsonb NOT NULL DEFAULT '[]'`,
    );
    await q.query(
      `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "lastBumpedAt" TIMESTAMP NULL`,
    );
    await q.query(
      `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP NULL`,
    );

    const [priceCol] = await q.query(
      `SELECT data_type FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'products' AND column_name = 'price'`,
    );
    if (priceCol && priceCol.data_type !== 'integer') {
      await q.query(
        `ALTER TABLE "products" ALTER COLUMN "price" TYPE integer USING ROUND("price")::integer`,
      );
    }

    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_products_status_deleted" ON "products" ("status", "deletedAt")`,
    );

    // ---- user_profiles ----
    await q.query(
      `ALTER TABLE "user_profiles" ADD COLUMN IF NOT EXISTS "level" varchar(20) NULL`,
    );
    const [genderType] = await q.query(
      `SELECT 1 FROM pg_type WHERE typname = 'user_profiles_gender_enum'`,
    );
    if (genderType) {
      // Allowed inside a transaction on PostgreSQL 12+; the value is not used
      // in this transaction.
      await q.query(
        `ALTER TYPE "user_profiles_gender_enum" ADD VALUE IF NOT EXISTS 'Prefer not to say'`,
      );
    }

    // ---- universities ----
    await q.query(
      `ALTER TABLE "universities" ADD COLUMN IF NOT EXISTS "city" varchar NULL`,
    );

    // ---- users ----
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_users_phoneNumber" ON "users" ("phoneNumber")`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "IDX_users_phoneNumber"`);
    await q.query(`ALTER TABLE "universities" DROP COLUMN IF EXISTS "city"`);
    // The gender enum value cannot be removed in PostgreSQL; it is harmless.
    await q.query(`ALTER TABLE "user_profiles" DROP COLUMN IF EXISTS "level"`);
    await q.query(`DROP INDEX IF EXISTS "IDX_products_status_deleted"`);
    // Fails if any price exceeds 99,999,999.99 (allowed since B1).
    await q.query(
      `ALTER TABLE "products" ALTER COLUMN "price" TYPE numeric(10,2) USING "price"::numeric(10,2)`,
    );
    await q.query(`ALTER TABLE "products" DROP COLUMN IF EXISTS "deletedAt"`);
    await q.query(
      `ALTER TABLE "products" DROP COLUMN IF EXISTS "lastBumpedAt"`,
    );
    await q.query(
      `ALTER TABLE "products" DROP COLUMN IF EXISTS "priceHistory"`,
    );
    await q.query(`ALTER TABLE "products" DROP COLUMN IF EXISTS "tags"`);
    await q.query(`ALTER TABLE "products" DROP COLUMN IF EXISTS "status"`);
    // isSold is left in place: the entity depended on it before B1.
  }
}
