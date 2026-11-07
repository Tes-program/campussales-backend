import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The notifications table was only ever created by `synchronize`, so on a
 * fresh database AddNotificationTypes1773071112611 failed ("type
 * notifications_type_enum does not exist") and the chain could not run.
 * This creates the table only when it is missing; it is a no-op on any
 * database that already has it (local dev, production).
 */
export class CreateNotificationsIfMissing1773071112610
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasTable('notifications')) return;

    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "notifications_type_enum" AS ENUM ('message', 'order', 'listing', 'system', 'promo');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await queryRunner.query(`
      CREATE TABLE "notifications" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "userId" uuid NOT NULL,
        "type" "notifications_type_enum" NOT NULL DEFAULT 'system',
        "title" character varying NOT NULL,
        "body" text NOT NULL,
        "isRead" boolean NOT NULL DEFAULT false,
        "metadata" jsonb,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_notifications_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_notifications_user" FOREIGN KEY ("userId")
          REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_notifications_user_read" ON "notifications" ("userId", "isRead")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_notifications_user_created" ON "notifications" ("userId", "createdAt")`,
    );
  }

  public async down(): Promise<void> {
    // Intentionally a no-op: we can't tell whether this migration or
    // synchronize created the table, and dropping it would lose data.
  }
}
