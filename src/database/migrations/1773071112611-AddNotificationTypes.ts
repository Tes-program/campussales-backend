import { MigrationInterface, QueryRunner } from "typeorm";

export class AddNotificationTypes1773071112611 implements MigrationInterface {

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Add new enum values to the notifications_type_enum
        await queryRunner.query(`ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'new_conversation'`);
        await queryRunner.query(`ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'wishlist'`);
        await queryRunner.query(`ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'price_drop'`);
        await queryRunner.query(`ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'offer_received'`);
        await queryRunner.query(`ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'offer_accepted'`);
        await queryRunner.query(`ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'offer_rejected'`);
        await queryRunner.query(`ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'product_sold'`);
        await queryRunner.query(`ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'account'`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // PostgreSQL does not support removing enum values directly.
        // To revert, you would need to recreate the enum type without these values.
        // This is intentionally left as a no-op for safety.
    }

}
