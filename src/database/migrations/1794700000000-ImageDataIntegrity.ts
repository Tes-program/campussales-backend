import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Image data integrity: product_images."unavailableAt" is set (by
 * scripts/mark-missing-images.js --apply) when the photo's file no longer
 * exists. The listing and the image row are kept; the API returns the image
 * with `unavailable: true`, ordered last, so apps can show a placeholder and
 * the seller is asked to add a new photo.
 */
export class ImageDataIntegrity1794700000000 implements MigrationInterface {
  name = 'ImageDataIntegrity1794700000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "product_images" ADD COLUMN IF NOT EXISTS "unavailableAt" TIMESTAMPTZ NULL`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "product_images" DROP COLUMN IF EXISTS "unavailableAt"`,
    );
  }
}
