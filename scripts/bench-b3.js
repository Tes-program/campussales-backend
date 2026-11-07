#!/usr/bin/env node
/* eslint-disable */
// LOCAL ONLY. Measures list/item/search latency against a running API that
// points at a seeded bench database, and prints EXPLAIN ANALYZE for the main
// list queries.
//   node scripts/bench-b3.js --base=http://localhost:3999/api --database=campussales_bench [--n=200]
const { parseArgs, connect, isLocalHost, dbConfig } = require('./lib/common');

const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

async function timeGet(url) {
  const t = process.hrtime.bigint();
  const res = await fetch(url);
  await res.arrayBuffer();
  return {
    ms: Number(process.hrtime.bigint() - t) / 1e6,
    status: res.status,
    queries: Number(res.headers.get('x-query-count') || 0),
  };
}

async function main() {
  const args = parseArgs();
  const base = args.base || 'http://localhost:3999/api';
  const n = Number(args.n || 200);
  const cfg = dbConfig(args);
  if (!isLocalHost(cfg.host)) throw new Error('bench is local only');
  const { client } = await connect(args);

  const campuses = (await client.query(`SELECT "campusId" AS id, count(*) FROM products WHERE status='active' GROUP BY 1 ORDER BY 2 DESC LIMIT 5`)).rows.map((r) => r.id);
  const items = (await client.query(`SELECT id FROM products WHERE status='active' ORDER BY random() LIMIT 50`)).rows.map((r) => r.id);
  const total = (await client.query(`SELECT count(*)::int n FROM products`)).rows[0].n;

  // a cursor from deep in the list
  const deep = await (await fetch(`${base}/products?limit=50`)).json();

  const scenarios = {
    'list newest (first page)': () => `${base}/products?limit=20`,
    'list newest (cursor page)': () => `${base}/products?limit=20&cursor=${deep.nextCursor}`,
    'list campus + category': (i) => `${base}/products?campus=${campuses[i % campuses.length]}&category=electronics`,
    'list price_asc + range': () => `${base}/products?sort=price_asc&minPrice=10000&maxPrice=200000`,
    'search q=laptop': () => `${base}/products?q=laptop`,
    'search q=laptpo (typo)': () => `${base}/products?q=laptpo`,
    'search q=iphon relevance': () => `${base}/products?q=iphon&sort=relevance`,
    'item GET /products/:id': (i) => `${base}/products/${items[i % items.length]}`,
    'suggest q=lap': () => `${base}/search/suggest?q=lap`,
  };

  console.log(`Bench: ${total} products, ${n} requests per scenario, sequential.\n`);
  console.log('Scenario                           p50 ms   p95 ms   max ms  queries');
  console.log('---------------------------------  ------   ------   ------  -------');
  const results = {};
  for (const [name, url] of Object.entries(scenarios)) {
    for (let i = 0; i < 10; i++) await timeGet(url(i)); // warm up
    const runs = [];
    for (let i = 0; i < n; i++) runs.push(await timeGet(url(i)));
    const bad = runs.filter((r) => r.status !== 200 && r.status !== 304);
    if (bad.length) throw new Error(`${name}: ${bad.length} non-200 responses (${bad[0].status})`);
    const ms = runs.map((r) => r.ms);
    const q = Math.max(...runs.map((r) => r.queries));
    results[name] = { p50: pct(ms, 50), p95: pct(ms, 95), max: Math.max(...ms), queries: q };
    console.log(
      `${name.padEnd(33)}  ${pct(ms, 50).toFixed(1).padStart(6)}   ${pct(ms, 95).toFixed(1).padStart(6)}   ${Math.max(...ms).toFixed(1).padStart(6)}  ${String(q).padStart(7)}`,
    );
  }

  console.log('\nEXPLAIN ANALYZE: list newest, campus filter');
  const plan1 = await client.query(
    `EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
     SELECT p.id FROM products p
      WHERE p.status = 'active' AND p."deletedAt" IS NULL AND p."campusId" = $1
      ORDER BY p."createdAt" DESC, p.id DESC LIMIT 21`,
    [campuses[0]],
  );
  console.log(plan1.rows.map((r) => '  ' + r['QUERY PLAN']).join('\n'));

  console.log('\nEXPLAIN ANALYZE: full-text search "laptop"');
  const plan2 = await client.query(
    `EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
     SELECT p.id FROM products p
      WHERE p.status = 'active' AND p."deletedAt" IS NULL
        AND ((setweight(to_tsvector('english', coalesce(p."title", '')), 'A') ||
              setweight(to_tsvector('english', translate(coalesce(p."tags"::text, ''), '[]",', '    ')), 'B') ||
              setweight(to_tsvector('english', coalesce(p."description", '')), 'D')) @@ to_tsquery('english', 'laptop:*')
             OR 'laptop' <% lower(p.title))
      ORDER BY p."createdAt" DESC, p.id DESC LIMIT 21`,
  );
  console.log(plan2.rows.map((r) => '  ' + r['QUERY PLAN']).join('\n'));
  await client.end();

  const worst = Math.max(...Object.values(results).map((r) => r.p95));
  console.log(`\nWorst p95: ${worst.toFixed(1)} ms (target 300 ms).`);
  if (worst > 300) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
