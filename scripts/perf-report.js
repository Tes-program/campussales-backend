#!/usr/bin/env node
/* eslint-disable */
// Per-route latency report from the API's structured request logs (B5).
//
//   railway logs --json > day.log      (or any file of JSON log lines)
//   node scripts/perf-report.js day.log [--min=20] [--markdown]
//   cat server.log | node scripts/perf-report.js -
//
// Reads lines with msg "request" (written by the timing middleware) and
// prints count, p50/p95/p99 duration, average database time, queries and
// response size per route, worst p95 first. No personal data is in these
// lines (route templates, hashed user ids), so the output is safe to paste
// into docs/perf-baseline.md or a PR.
const fs = require('fs');
const readline = require('readline');

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--')) || '-';
const min = Number((args.find((a) => a.startsWith('--min=')) || '--min=1').split('=')[1]);
const markdown = args.includes('--markdown');

const pct = (sorted, p) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))] : 0;
const r1 = (v) => Math.round(v * 10) / 10;

async function main() {
  const input = file === '-' ? process.stdin : fs.createReadStream(file);
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  const routes = new Map();
  let lines = 0;
  for await (const raw of rl) {
    const start = raw.indexOf('{');
    if (start < 0) continue;
    let o;
    try {
      o = JSON.parse(raw.slice(start));
    } catch {
      continue;
    }
    // railway logs --json wraps the line in { message: "..." }
    if (typeof o.message === 'string' && o.message.startsWith('{')) {
      try {
        o = JSON.parse(o.message);
      } catch {
        continue;
      }
    }
    if (o.msg !== 'request' || typeof o.durationMs !== 'number') continue;
    lines++;
    const g = routes.get(o.route) || { ms: [], db: 0, q: 0, bytes: 0, e5: 0 };
    g.ms.push(o.durationMs);
    g.db += o.dbMs || 0;
    g.q += o.queries || 0;
    g.bytes += o.bytes || 0;
    if (o.status >= 500) g.e5++;
    routes.set(o.route, g);
  }
  const rows = [...routes.entries()]
    .filter(([, g]) => g.ms.length >= min)
    .map(([route, g]) => {
      const s = g.ms.sort((a, b) => a - b);
      const n = s.length;
      return { route, n, p50: r1(pct(s, 50)), p95: r1(pct(s, 95)), p99: r1(pct(s, 99)), db: r1(g.db / n), q: r1(g.q / n), kb: r1(g.bytes / n / 1024), e5: g.e5 };
    })
    .sort((a, b) => b.p95 - a.p95);

  console.log(`${lines} request lines, ${rows.length} routes (min ${min} requests)\n`);
  if (markdown) {
    console.log('| Route | Requests | p50 ms | p95 ms | p99 ms | DB ms (avg) | Queries | KB | 5xx |');
    console.log('|---|---:|---:|---:|---:|---:|---:|---:|---:|');
    for (const r of rows)
      console.log(`| \`${r.route}\` | ${r.n} | ${r.p50} | ${r.p95} | ${r.p99} | ${r.db} | ${r.q} | ${r.kb} | ${r.e5} |`);
  } else {
    for (const r of rows)
      console.log(`${r.route.padEnd(48)} n=${String(r.n).padStart(6)} p50=${r.p50} p95=${r.p95} p99=${r.p99} db=${r.db} q=${r.q} kb=${r.kb} 5xx=${r.e5}`);
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
