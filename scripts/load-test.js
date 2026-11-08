#!/usr/bin/env node
/* eslint-disable */
// Load test for the main routes (feed, item, search, login) with autocannon.
//
//   node scripts/load-test.js --base=http://localhost:3999/api --database=campussales_bench \
//     [--connections=50] [--duration=20] [--label=before] [--routes=feed,item,search,login]
//
// NEVER point this at production. It only runs against localhost, or against a
// host listed in --allow-host (staging), and refuses known production hosts.
// Test users and item ids come from the (local or staging) database given by
// --database; the bench seed (npm run seed:perf) creates users whose password
// is bench-password-1.
//
// Logins are rate limited per account and per IP (docs/security.md). Locally,
// run the API with TRUST_PROXY=1 so the X-Forwarded-For header this script
// rotates spreads logins over many IPs; on staging expect 429s in the login
// row and read them as the limiter working.
const fs = require('fs');
const path = require('path');
const autocannon = require('autocannon');
const { parseArgs, connect } = require('./lib/common');

const PRODUCTION_HOSTS = [
  'campus-sales.onrender.com',
  ...(process.env.LOAD_TEST_BLOCKED_HOSTS || '').split(',').filter(Boolean),
];

function assertSafeTarget(base, allowHost) {
  const host = new URL(base).hostname;
  if (PRODUCTION_HOSTS.includes(host) || /prod/i.test(host)) {
    throw new Error(`Refusing to load test ${host}: looks like production.`);
  }
  const local = ['localhost', '127.0.0.1', '::1'].includes(host);
  if (!local && host !== allowHost) {
    throw new Error(
      `Refusing to load test ${host}. Pass --allow-host=${host} if it is staging.`,
    );
  }
}

const ms = (v) => Math.round(v * 10) / 10;

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))] ?? 0;

// autocannon reports p97.5 but not p95, so collect every latency ourselves.
function run(opts) {
  return new Promise((resolve, reject) => {
    const latencies = [];
    const inst = autocannon(opts, (err, res) => {
      if (err) return reject(err);
      latencies.sort((a, b) => a - b);
      resolve({ res, latencies });
    });
    inst.on('response', (_c, _status, _bytes, responseTime) => latencies.push(responseTime));
  });
}

async function main() {
  const args = parseArgs();
  const base = (args.base || 'http://localhost:3999/api').replace(/\/$/, '');
  assertSafeTarget(base, args['allow-host']);
  const connections = Number(args.connections || 50);
  const duration = Number(args.duration || 20);
  const label = args.label || 'run';
  const routes = String(args.routes || 'feed,item,search,login').split(',');

  const { client } = await connect(args);
  let users, items;
  try {
    users = (
      await client.query(
        `SELECT email FROM users WHERE email LIKE 'bench%@example.edu.ng' ORDER BY email LIMIT 400`,
      )
    ).rows.map((r) => r.email);
    items = (
      await client.query(
        `SELECT id FROM products WHERE status = 'active' AND "deletedAt" IS NULL ORDER BY random() LIMIT 200`,
      )
    ).rows.map((r) => r.id);
  } finally {
    await client.end();
  }
  if (!users.length || !items.length) throw new Error('Seed the database first: npm run seed:perf');

  // The feed is per user: log in up to 50 different users and rotate them.
  const tokens = [];
  for (const [i, email] of users.slice(0, routes.includes('feed') ? 50 : 1).entries()) {
    const res = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.255.1.${i}` },
      body: JSON.stringify({ email, password: 'bench-password-1' }),
    });
    const body = await res.json();
    const token = body.accessToken || body.access_token || body.token;
    if (token) tokens.push(token);
  }
  if (!tokens.length) throw new Error('Could not log in any bench user.');

  const queries = ['laptop', 'iphone', 'textbook', 'fridge', 'laptpo', 'shoes', 'chair', 'calculator', 'bag', 'phone'];
  let n = 0;
  const scenarios = {
    feed: {
      requests: [
        {
          method: 'GET',
          setupRequest: (req) => ({
            ...req,
            path: `${new URL(base).pathname}/feed`,
            headers: { ...req.headers, authorization: `Bearer ${tokens[n++ % tokens.length]}` },
          }),
        },
      ],
    },
    item: {
      requests: [
        {
          method: 'GET',
          setupRequest: (req) => ({ ...req, path: `${new URL(base).pathname}/products/${items[n++ % items.length]}` }),
        },
      ],
    },
    search: {
      requests: [
        {
          method: 'GET',
          setupRequest: (req) => ({
            ...req,
            path: `${new URL(base).pathname}/products?q=${queries[n++ % queries.length]}`,
          }),
        },
      ],
    },
    login: {
      requests: [
        {
          method: 'POST',
          setupRequest: (req) => {
            const i = n++;
            return {
              ...req,
              path: `${new URL(base).pathname}/auth/login`,
              headers: {
                'content-type': 'application/json',
                'x-forwarded-for': `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`,
              },
              body: JSON.stringify({ email: users[i % users.length], password: 'bench-password-1' }),
            };
          },
        },
      ],
    },
  };

  const results = {};
  console.log(`Load test "${label}": ${connections} connections, ${duration}s per route, target ${base}\n`);
  for (const route of routes) {
    const s = scenarios[route];
    if (!s) throw new Error(`Unknown route ${route}`);
    const prefix = new URL(base).pathname;
    const reqs = s.requests.map((r) => ({ ...r, path: r.path ? prefix + r.path : prefix }));
    const { res, latencies } = await run({
      url: new URL(base).origin,
      connections,
      duration,
      requests: reqs,
      headers: { 'accept-encoding': 'gzip' },
      // Stay under the per-account login limit (5 per 15 min per account).
      ...(route === 'login' ? { amount: Math.min(users.length * 4, 1600) } : {}),
    });
    results[route] = {
      requests: res.requests.total,
      rps: ms(res.requests.average),
      p50: ms(pct(latencies, 50)),
      p95: ms(pct(latencies, 95)),
      p99: ms(pct(latencies, 99)),
      max: ms(latencies[latencies.length - 1] ?? 0),
      '2xx': res['2xx'],
      non2xx: res.non2xx,
      errors: res.errors + res.timeouts,
      avgBytes: res.requests.total ? Math.round(res.throughput.total / res.requests.total) : 0,
    };
  }

  console.log('Route    req/s    p50 ms   p95 ms   p99 ms   max ms    2xx  non-2xx  errors  bytes/resp');
  console.log('-------  -------  -------  -------  -------  -------  -----  -------  ------  ----------');
  for (const [r, v] of Object.entries(results)) {
    console.log(
      `${r.padEnd(7)}  ${String(v.rps).padStart(7)}  ${String(v.p50).padStart(7)}  ${String(v.p95).padStart(7)}  ${String(v.p99).padStart(7)}  ${String(v.max).padStart(7)}  ${String(v['2xx']).padStart(5)}  ${String(v.non2xx).padStart(7)}  ${String(v.errors).padStart(6)}  ${String(v.avgBytes).padStart(10)}`,
    );
  }
  const outDir = path.join(__dirname, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `load-${label}-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify({ label, base, connections, duration, results }, null, 2));
  console.log(`\nSaved ${file}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
