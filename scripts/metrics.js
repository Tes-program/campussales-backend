#!/usr/bin/env node
/* eslint-disable */
// Read-only product metrics: runs the funnels in scripts/funnels.sql.
//   node scripts/metrics.js [--days=30] [--only=funnel_signup,report_rate] [--database=<name>]
// Runs inside a READ ONLY transaction. Point it at a replica or a restored
// backup where possible (docs/runbook.md §2), not the live primary.
const fs = require('fs');
const path = require('path');
const { parseArgs, connect } = require('./lib/common');

function loadQueries() {
  const text = fs.readFileSync(path.join(__dirname, 'funnels.sql'), 'utf8');
  const out = [];
  for (const block of text.split(/^-- name: /m).slice(1)) {
    const [name, ...rest] = block.split('\n');
    const sql = rest.filter((l) => !l.startsWith('--')).join('\n').trim().replace(/;\s*$/, '');
    out.push({ name: name.trim(), sql });
  }
  return out;
}

async function main() {
  const args = parseArgs();
  const days = Number(args.days || 30);
  if (!Number.isInteger(days) || days < 1 || days > 400) throw new Error('--days must be 1..400');
  const only = args.only ? String(args.only).split(',') : null;
  const { client } = await connect(args);
  try {
    await client.query('BEGIN TRANSACTION READ ONLY');
    for (const q of loadQueries()) {
      if (only && !only.includes(q.name)) continue;
      const { rows } = await client.query(q.sql.replace(/:days/g, '$1'), [String(days)]);
      console.log(`\n== ${q.name} (last ${days} days)`);
      console.table(rows);
    }
    await client.query('ROLLBACK');
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
