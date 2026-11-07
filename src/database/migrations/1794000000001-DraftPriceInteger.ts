import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * product_drafts.price numeric(10,2) -> integer naira, matching products.price
 * (numeric(10,2) cannot hold the new ₦100,000,000 maximum). Guarded.
 */
export class DraftPriceInteger1794000000001 implements MigrationInterface {
  name = 'DraftPriceInteger1794000000001';

  public async up(q: QueryRunner): Promise<void> {
    const [col] = await q.query(
      `SELECT data_type FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'product_drafts' AND column_name = 'price'`,
    );
    if (col && col.data_type !== 'integer') {
      await q.query(
        `ALTER TABLE "product_drafts" ALTER COLUMN "price" TYPE integer USING ROUND("price")::integer`,
      );
    }
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "product_drafts" ALTER COLUMN "price" TYPE numeric(10,2) USING "price"::numeric(10,2)`,
    );
  }
}
