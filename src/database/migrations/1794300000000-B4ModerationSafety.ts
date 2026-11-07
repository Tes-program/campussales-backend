import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * B4: moderation, reports and chat safety. Guarded and additive.
 */
export class B4ModerationSafety1794300000000 implements MigrationInterface {
  name = 'B4ModerationSafety1794300000000';

  public async up(q: QueryRunner): Promise<void> {
    const add = (table: string, col: string, type: string) =>
      q.query(
        `ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "${col}" ${type}`,
      );

    await add(
      'products',
      'moderationStatus',
      `varchar(20) NOT NULL DEFAULT 'approved'`,
    );
    await add('products', 'moderationReasons', `jsonb NOT NULL DEFAULT '[]'`);

    await add('users', 'postingSuspendedAt', 'TIMESTAMP NULL');
    await add('users', 'postingSuspendedReason', 'varchar(300) NULL');
    await add('users', 'needsReviewAt', 'TIMESTAMP NULL');
    await add('users', 'needsReviewReason', 'varchar(300) NULL');
    await add('users', 'deletionRequestedAt', 'TIMESTAMP NULL');
    await add('users', 'acceptedPrivacyVersion', 'varchar(32) NULL');
    await add('users', 'acceptedPrivacyAt', 'TIMESTAMP NULL');

    await add('conversations', 'productId', 'uuid NULL');
    await add('conversations', 'productTitle', 'varchar(255) NULL');
    await add('conversations', 'productImageUrl', 'varchar NULL');
    await add('conversations', 'productPrice', 'integer NULL');
    await add('conversations', 'closedAt', 'TIMESTAMP NULL');
    await add('conversations', 'closedReason', 'varchar(32) NULL');
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_conversations_product" ON "conversations" ("productId")`,
    );

    await add('messages', 'flags', `jsonb NOT NULL DEFAULT '[]'`);
    const [t] = await q.query(
      `SELECT 1 FROM pg_type WHERE typname = 'messages_type_enum'`,
    );
    if (t)
      await q.query(
        `ALTER TYPE "messages_type_enum" ADD VALUE IF NOT EXISTS 'system'`,
      );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_messages_sender_created" ON "messages" ("senderId", "createdAt")`,
    );

    await add('notifications', 'readAt', 'TIMESTAMP NULL');
    await q.query(
      `UPDATE "notifications" SET "readAt" = "updatedAt" WHERE "isRead" = true AND "readAt" IS NULL`,
    );

    await q.query(`
      CREATE TABLE IF NOT EXISTS "reports" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "reporterId" uuid NOT NULL,
        "targetType" varchar(16) NOT NULL,
        "targetId" uuid NOT NULL,
        "targetUserId" uuid NULL,
        "reason" varchar(24) NOT NULL,
        "details" varchar(1000) NULL,
        "status" varchar(16) NOT NULL DEFAULT 'open',
        "resolution" varchar(32) NULL,
        "resolvedById" uuid NULL,
        "resolvedAt" TIMESTAMP NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_reports_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_reports_reporter" FOREIGN KEY ("reporterId") REFERENCES "users"("id") ON DELETE CASCADE
      )`);
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_reports_target" ON "reports" ("targetType", "targetId")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_reports_reporter_created" ON "reports" ("reporterId", "createdAt")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_reports_status_created" ON "reports" ("status", "createdAt")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_reports_target_user" ON "reports" ("targetUserId", "status")`,
    );

    await q.query(`
      CREATE TABLE IF NOT EXISTS "admin_audit_logs" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "adminId" uuid NOT NULL,
        "action" varchar(32) NOT NULL,
        "targetType" varchar(16) NOT NULL,
        "targetId" uuid NOT NULL,
        "reason" varchar(500) NULL,
        "details" jsonb NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_admin_audit_logs_id" PRIMARY KEY ("id")
      )`);
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_admin_audit_created" ON "admin_audit_logs" ("createdAt")`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "admin_audit_logs"`);
    await q.query(`DROP TABLE IF EXISTS "reports"`);
    await q.query(`DROP INDEX IF EXISTS "IDX_messages_sender_created"`);
    await q.query(`DROP INDEX IF EXISTS "IDX_conversations_product"`);
    const drop = (t: string, c: string) =>
      q.query(`ALTER TABLE "${t}" DROP COLUMN IF EXISTS "${c}"`);
    await drop('notifications', 'readAt');
    await drop('messages', 'flags');
    for (const c of [
      'productId',
      'productTitle',
      'productImageUrl',
      'productPrice',
      'closedAt',
      'closedReason',
    ]) {
      await drop('conversations', c);
    }
    for (const c of [
      'postingSuspendedAt',
      'postingSuspendedReason',
      'needsReviewAt',
      'needsReviewReason',
      'deletionRequestedAt',
      'acceptedPrivacyVersion',
      'acceptedPrivacyAt',
    ]) {
      await drop('users', c);
    }
    await drop('products', 'moderationReasons');
    await drop('products', 'moderationStatus');
    // The 'system' message type value cannot be removed from the enum.
  }
}
