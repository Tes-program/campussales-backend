import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * H1: usernames are public and unique ignoring case ("Ada" and "ada" clash).
 * Sign-up checks this in code; this index closes the race between two
 * concurrent sign-ups. If existing rows already clash on case, the index is
 * skipped (with a warning) rather than failing the deploy: run
 *   SELECT LOWER(username), COUNT(*) FROM users GROUP BY 1 HAVING COUNT(*) > 1;
 * rename the duplicates, then re-run this migration (revert + run).
 */
export class H1UsernameCaseInsensitive1794500000000
  implements MigrationInterface
{
  name = 'H1UsernameCaseInsensitive1794500000000';

  public async up(q: QueryRunner): Promise<void> {
    const dupes: Array<{ n: string }> = await q.query(
      `SELECT COUNT(*)::text AS n FROM (
         SELECT 1 FROM users GROUP BY LOWER(username) HAVING COUNT(*) > 1
       ) d`,
    );
    if (Number(dupes[0]?.n ?? 0) > 0) {
      console.warn(
        `[H1] ${dupes[0].n} usernames clash ignoring case; skipped UQ_users_username_lower. See migration notes.`,
      );
      return;
    }
    await q.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_users_username_lower" ON users (LOWER(username))`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "UQ_users_username_lower"`);
  }
}
