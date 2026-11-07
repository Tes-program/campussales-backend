// pg ships without type declarations in this repo, so query rows are untyped.
/* eslint-disable @typescript-eslint/no-unsafe-return */
import { execFileSync } from 'child_process';
import { join } from 'path';
import { Client } from 'pg';
import { assertSafeTestDatabase } from './setup/env';

const ROOT = join(__dirname, '..');

function run(script: string, args: string[] = []) {
  return execFileSync('node', [join(ROOT, 'scripts', script), ...args], {
    cwd: ROOT,
    env: { ...process.env },
    encoding: 'utf8',
  });
}

describe('B1 data scripts (e2e)', () => {
  let db: Client;
  const checksum = async () => {
    const r = await db.query<{ products: string; users: string }>(`
      SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS products,
             (SELECT md5(coalesce(string_agg(id || coalesce("phoneNumber", ''), '|' ORDER BY id), '')) FROM users) AS users
        FROM products t`);
    return r.rows[0];
  };

  beforeAll(async () => {
    assertSafeTestDatabase();
    db = new Client({
      host: process.env.DATABASE_HOST || 'localhost',
      port: parseInt(process.env.DATABASE_PORT || '5432', 10),
      user: process.env.DATABASE_USERNAME,
      password: process.env.DATABASE_PASSWORD,
      database: process.env.DATABASE_NAME,
    });
    await db.connect();
    // The known test listing the audit should flag, plus a bad phone.
    const u = await db.query(
      `INSERT INTO users (email, "passwordHash", username, "phoneNumber")
       VALUES ('qa-fixture@test.campussales.ng', 'x', 'qa_fixture', '123') RETURNING id`,
    );
    await db.query(
      `INSERT INTO products ("sellerId", title, description, price, quantity, status, "isAvailable")
       VALUES ($1, 'QA Test', '', 0, -3, 'active', true)`,
      [u.rows[0].id],
    );
  });
  afterAll(async () => {
    await db.end();
  });

  it('audit-data.js reports the counts and modifies nothing', async () => {
    const before = await checksum();
    const out = run('audit-data.js');
    expect(out).toMatch(/price_under_50\s+[1-9]/);
    expect(out).toMatch(/quantity_under_1\s+[1-9]/);
    expect(out).toMatch(/no_images\s+[1-9]/);
    expect(out).toMatch(/title_junk\s+[1-9]/);
    expect(out).toMatch(/users_invalid_phone\s+[1-9]/);
    expect(out).toContain('"QA Test"');
    expect(out).toContain('No data was modified');
    expect(await checksum()).toEqual(before);
  });

  it('fix-data.js dry run prints the plan and changes nothing', async () => {
    const before = await checksum();
    const out = run('fix-data.js');
    expect(out).toContain('DRY RUN');
    expect(out).toMatch(
      /products\.status .* active -> needs_review .*"QA Test"/,
    );
    expect(out).toMatch(/products\.quantity .* -3 -> 1/);
    expect(out).toContain('nothing was changed');
    expect(await checksum()).toEqual(before);
  });

  it('fix-data.js --apply hides the QA listing, clamps quantity and never deletes', async () => {
    const count = async () =>
      (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM products'))
        .rows[0].n;
    const n = await count();
    run('fix-data.js', ['--apply']);
    const row = (
      await db.query(
        `SELECT status, quantity, "isAvailable" FROM products WHERE title = 'QA Test'`,
      )
    ).rows[0];
    expect(row).toEqual({
      status: 'needs_review',
      quantity: 1,
      isAvailable: false,
    });
    expect(await count()).toBe(n);
    expect(run('fix-data.js')).toContain('0 change(s) planned');
  });
});
