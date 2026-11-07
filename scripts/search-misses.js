#!/usr/bin/env node
/* eslint-disable */
// Read-only: prints the top 50 zero-result searches (default: last 7 days).
//   node scripts/search-misses.js [--days=7] [--database=<name>]
// Review weekly: add synonyms to data/search-synonyms.json, or tell the team
// what students are looking for and can't find.
const { parseArgs, connect } = require('./lib/common');

async function main() {
  const args = parseArgs();
  const days = Number(args.days || 7);
  const { client } = await connect(args);
  try {
    await client.query('BEGIN TRANSACTION READ ONLY');
    const { rows } = await client.query(
      `SELECT query, count(*)::int AS searches, max("createdAt") AS last_seen
         FROM search_misses WHERE "createdAt" > now() - ($1 || ' days')::interval
        GROUP BY query ORDER BY searches DESC, last_seen DESC LIMIT 50`,
      [String(days)],
    );
    await client.query('ROLLBACK');
    console.log(`Top ${rows.length} zero-result searches, last ${days} days:\n`);
    rows.forEach((r, i) =>
      console.log(`${String(i + 1).padStart(2)}. ${String(r.searches).padStart(5)}  ${r.query}`),
    );
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
