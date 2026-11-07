import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * B2: auth and tokens. Guarded and additive; nothing is dropped.
 * - users: fullName, emailVerifiedAt, verifyBy, acceptedTermsVersion,
 *   acceptedTermsAt, passwordChangedAt, tokensValidAfter, signupSchoolId
 * - refresh_tokens: familyId, rotatedAt, revokedAt, revokedReason, userAgent,
 *   indexes on tokenHash and familyId
 * - email_verifications table
 * Existing refresh tokens stay valid (they are looked up by hash either way).
 */
export class B2AuthTokens1794100000000 implements MigrationInterface {
  name = 'B2AuthTokens1794100000000';

  public async up(q: QueryRunner): Promise<void> {
    const userCols: [string, string][] = [
      ['fullName', 'varchar(80)'],
      ['emailVerifiedAt', 'TIMESTAMP'],
      ['verifyBy', 'TIMESTAMP'],
      ['acceptedTermsVersion', 'varchar(32)'],
      ['acceptedTermsAt', 'TIMESTAMP'],
      ['passwordChangedAt', 'TIMESTAMP'],
      ['tokensValidAfter', 'TIMESTAMP'],
      ['signupSchoolId', 'uuid'],
    ];
    for (const [name, type] of userCols) {
      await q.query(
        `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "${name}" ${type} NULL`,
      );
    }

    const tokenCols: [string, string][] = [
      ['familyId', 'uuid'],
      ['rotatedAt', 'TIMESTAMP'],
      ['revokedAt', 'TIMESTAMP'],
      ['revokedReason', 'varchar(32)'],
      ['userAgent', 'varchar(255)'],
    ];
    for (const [name, type] of tokenCols) {
      await q.query(
        `ALTER TABLE "refresh_tokens" ADD COLUMN IF NOT EXISTS "${name}" ${type} NULL`,
      );
    }
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_refresh_tokens_hash" ON "refresh_tokens" ("tokenHash")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_refresh_tokens_family" ON "refresh_tokens" ("familyId")`,
    );

    await q.query(`
      CREATE TABLE IF NOT EXISTS "email_verifications" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "userId" uuid NOT NULL,
        "tokenHash" varchar(64) NOT NULL,
        "expiresAt" TIMESTAMP NOT NULL,
        "usedAt" TIMESTAMP NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_email_verifications_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_email_verifications_user" FOREIGN KEY ("userId")
          REFERENCES "users"("id") ON DELETE CASCADE
      )`);
    await q.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_email_verifications_hash" ON "email_verifications" ("tokenHash")`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "email_verifications"`);
    await q.query(`DROP INDEX IF EXISTS "IDX_refresh_tokens_family"`);
    await q.query(`DROP INDEX IF EXISTS "IDX_refresh_tokens_hash"`);
    for (const c of [
      'familyId',
      'rotatedAt',
      'revokedAt',
      'revokedReason',
      'userAgent',
    ]) {
      await q.query(
        `ALTER TABLE "refresh_tokens" DROP COLUMN IF EXISTS "${c}"`,
      );
    }
    for (const c of [
      'fullName',
      'emailVerifiedAt',
      'verifyBy',
      'acceptedTermsVersion',
      'acceptedTermsAt',
      'passwordChangedAt',
      'tokensValidAfter',
      'signupSchoolId',
    ]) {
      await q.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "${c}"`);
    }
  }
}
