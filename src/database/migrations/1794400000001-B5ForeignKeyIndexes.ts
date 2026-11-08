import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * B5: indexes for foreign keys used on hot paths (found with the
 * unindexed-FK query in docs/perf-baseline.md). user_profiles.userId is
 * joined on every authenticated request and every product card.
 *
 * Built CONCURRENTLY so production keeps accepting writes; that cannot run
 * inside a transaction, hence `transaction = false`. Re-runnable.
 */
export class B5ForeignKeyIndexes1794400000001 implements MigrationInterface {
  name = 'B5ForeignKeyIndexes1794400000001';
  transaction = false as const;

  private readonly indexes: Array<[string, string, string]> = [
    ['IDX_user_profiles_user', 'user_profiles', '"userId"'],
    ['IDX_user_profiles_university', 'user_profiles', '"universityId"'],
    ['IDX_conv_participants_user', 'conversation_participants', '"userId"'],
    [
      'IDX_messages_conversation_created',
      'messages',
      '"conversationId", "createdAt"',
    ],
    ['IDX_messages_product', 'messages', '"productId"'],
    ['IDX_refresh_tokens_user', 'refresh_tokens', '"userId"'],
    ['IDX_product_drafts_seller', 'product_drafts', '"sellerId"'],
    ['IDX_uploads_user_created', 'uploads', '"userId", "createdAt"'],
    ['IDX_email_verifications_user', 'email_verifications', '"userId"'],
    ['IDX_password_resets_user', 'password_resets', '"userId"'],
  ];

  public async up(q: QueryRunner): Promise<void> {
    for (const [name, table, cols] of this.indexes) {
      const exists = await q.query(`SELECT to_regclass($1) AS t`, [
        `"${table}"`,
      ]);
      if (!exists[0]?.t) continue; // table not present in this database
      await q.query(
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS "${name}" ON "${table}" (${cols})`,
      );
    }
  }

  public async down(q: QueryRunner): Promise<void> {
    for (const [name] of this.indexes) {
      await q.query(`DROP INDEX CONCURRENTLY IF EXISTS "${name}"`);
    }
  }
}
