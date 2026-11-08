# Performance baseline and fixes (B5, F-09)

Every number below was measured before and after each change, on the same
machine, data and settings. Raw results are in `scripts/out/load-*.json`
(git-ignored). **These are local measurements, not staging and not from
Lagos.** §6 lists what the owner still has to measure (the region and
network side) and how.

## 1. How it was measured

- **Data:** `campussales_bench`, a local Postgres 14 copy with the schema
  migrated to B5 and seeded by `npm run seed:perf`: 10,000 listings, 400
  sellers, 8 schools, 13 categories. Production was never touched.
- **API:** `node dist/main` with `NODE_ENV=staging` (production code paths,
  no TypeORM synchronize) on a 16-core WSL2 laptop, with Postgres and Redis on
  the same machine.
- **Load:** `node scripts/load-test.js --database=campussales_bench`. Each
  route gets 50 concurrent connections with no think time for 15 s
  (autocannon). The feed rotates 50 logged-in users, item rotates 200 ids,
  search rotates 10 queries including a typo, and login rotates 400 accounts
  under the per-account limit. `RATE_LIMIT_SCALE=1000` lifts the new
  per-minute limit, because all traffic comes from one IP.
- **Server side:** the new timing middleware logs every request as JSON:
  route, status, durationMs, dbMs, queries and bytes.
  `node scripts/perf-report.js <log> --markdown` turns that log into the
  per-route tables. Run the same command over a day of `railway logs` once B5
  is deployed.

## 2. Load test, 50 concurrent users (client side, p95 is the headline)

| Route | Before p50 / p95 / p99 (ms) | After p50 / p95 / p99 (ms) | Before → after req/s |
| --- | --- | --- | --- |
| `GET /api/feed` (logged in) | 720 / **932** / 1079 | 244 / **336** / 786 | 66 → 190 |
| `GET /api/products/:id` | 199 / **239** / 544 | 72 / **92** / 199 | 239 → 643 |
| `GET /api/products?q=…` (search) | 550 / **784** / 904 | 129 / **156** / 215 | 87 → 373 |
| `POST /api/auth/login` | 14 of 3,186 finished within 10 s | 2,039 / 2,239 / 2,309, all 1,600 OK | 0.1 → 24 |

Before: `main` at 477b127 (B4). After: this branch. Login stays slow under a
50-login burst on purpose: bcrypt cost 12 takes about 250 ms of CPU per hash,
and that cost is the B2 security requirement. The difference is that logins
no longer freeze every other request (see §4.1).

### Step by step (feed p95 / item p95 / search p95, ms)

| Change | Feed | Item | Search |
| --- | --- | --- | --- |
| Baseline (B4) | 932 | 239 | 784 |
| + timing middleware, structured logs instead of logging every body, caches (item, list, categories, schools), feed query rewrite | 739 | 83 | 144 |
| + per-user ranked feed cache (30 s, cleared on block/report) | 480 | n/a | n/a |
| + lean card query (no 6-way ORM join or entity hydration) | 314–336 | 79–92 | 156–183 |

## 3. Server side, after (from the JSON request logs)

Under the same 50-connection load:

| Route | Requests | p50 ms | p95 ms | p99 ms | DB ms (avg) | Queries | KB | 5xx |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `GET /api/feed` | 2859 | 200 | 284.6 | 605.9 | 99.3 | 3 | 5.1 | 0 |
| `GET /api/products` (search) | 5605 | 69.1 | 86.6 | 112 | 0.1 | 0 | 7.7 | 0 |
| `GET /api/products/:id` | 9652 | 42.4 | 57.2 | 129.2 | 13.4 | 0.7 | 0.8 | 0 |

Sequential, one request at a time, **cache disabled** (`CACHE_DISABLED=true`,
`scripts/bench-b3.js --n=100`). This is the cost of a cache miss:

| Scenario | p50 ms | p95 ms | Queries |
| --- | ---: | ---: | ---: |
| list newest (first page) | 13.6 | 17.6 | 3 |
| list newest (cursor page) | 13.1 | 15.8 | 3 |
| list campus + category | 10.8 | 14.2 | 4 |
| list price_asc + range | 12.4 | 15.1 | 3 |
| search `laptop` | 35.2 | 42.0 | 4 |
| search `laptpo` (typo) | 33.1 | 38.3 | 4 |
| item `GET /products/:id` | 10.1 | 14.5 | 3 |
| suggest `lap` | 1.9 | 2.4 | 0 |

Every list and item route is well under the **150 ms server-side** target,
uncached. Cold start is 2.2 s from process start to a healthy `/health`, and
the first API calls afterwards take 36 ms. That is under the 5 s target for
the first request after a restart.

## 4. What the data showed, and the fix for each

1. **`bcryptjs` blocked the event loop.** The library is pure JavaScript, so
   every login hash (about 300 ms) froze every other request. That is why
   "each call takes seconds" whenever several students log in at once.
   - **Fix:** native `bcrypt`, which hashes on libuv's thread pool, with
     `UV_THREADPOOL_SIZE=8`. Same `$2b$` hashes at the same cost, and existing
     hashes verify unchanged.
2. **Every request and response body was logged.** `LoggingInterceptor` wrote
   each body at debug level, including **access and refresh tokens**, and
   Nest's default logger prints debug in production. That was slow and a
   security problem.
   - **Fix:** one JSON line per request with route, status, timings and a
     hashed user id, passed through redaction. The interceptor is removed.
3. **The feed sorted every live listing.** The candidate query scanned and
   sorted all active rows (27 ms at 10k rows, growing with the catalogue).
   - **Fix:** two index-backed top-N slices (same campus, everyone): 8.8 ms,
     and the cost stays flat as listings grow. Each user's ranked candidate
     list is also cached for 30 s, so the next page and the bootstrap/feed
     pair reuse one ranking. Blocks and reports clear it immediately.
4. **Cards came from a six-way ORM join.** It loaded whole user rows and
   spent most of the Node CPU on entity hydration.
   - **Fix:** one hand-written query selecting only card columns, with images
     aggregated in SQL. The output is identical, and the B3 e2e suite covers
     the shape.
5. **Nothing was cached.**
   - **Fix:** an in-process TTL cache with single-flight loading (concurrent
     misses cost one query). It covers the anonymous feed and list pages
     (30 s), item and similar pages (30 s), categories (5 min, counts 60 s),
     schools (10 min) and suggestions (60 s). Writes invalidate entries:
     every product write path, moderation, account deletion and category
     edits.
6. **HTTP caching.**
   - **Fix:** public anonymous GETs send `Cache-Control: public, max-age,
     stale-while-revalidate` and an ETag, so revisits are `304` with no body.
     Personal data is `no-store`.
7. **Hot-path foreign keys had no index.** The worst was
   `user_profiles.userId`, which every authenticated request and every card
   joins on. It's harmless at 400 users and a sequential scan at 50k.
   - **Fix:** ten indexes, built `CONCURRENTLY`.
8. **The pool had no limits.**
   - **Fix:** one shared pool per process with `max=20` (`DB_POOL_MAX`), a
     5 s connect timeout, a 14 s `statement_timeout`, and saturation
     alerting.
9. **Payloads.** Compression was already on (br quality 4 or gzip). The
   threshold is now explicit at 1 KB. List cards keep a 160-character excerpt
   and no full descriptions, and the bootstrap response stays under 50 KB
   (tested).

Find more unindexed foreign keys with:

```sql
SELECT c.conrelid::regclass, a.attname
  FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
 WHERE c.contype = 'f' AND array_length(c.conkey, 1) = 1
   AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.conrelid AND i.indkey[0] = c.conkey[1]);
```

## 5. Why the server-side numbers don't explain "2 to 4 seconds" on their own

The API now answers in tens of milliseconds, so the rest of a slow request is
network, region and cold starts. Each needs the owner (docs/infra.md):

- **Region.** Each request from Lagos crosses the network to Railway and back,
  and every database query crosses again if the database is in another
  region. With the API in US West and the database in US East, a 4-query
  request adds about 4 × 70 ms of query round trips. With the API in US and
  users in Nigeria, each request adds about 200–300 ms. Moving both to
  **Europe West (Amsterdam)** puts them about 90–110 ms from Lagos and about
  1 ms from each other.
- **Cold starts.** A Render free web service sleeps after 15 minutes idle and
  takes 30–60 s to wake. The frontend should be a Render **static site**,
  which never sleeps, or a paid instance. Railway does not sleep unless "App
  Sleeping" is turned on, so keep it off. `.github/workflows/keep-warm.yml`
  pings `/health` every 10 minutes as a safety net.
- **Round trips.** The first screen used to need 6–7 requests (me, unread
  counts, wishlist, categories, schools, feed). `GET /api/bootstrap` makes it
  one.

## 6. Still to measure (owner)

These need staging and a West African vantage point, which this environment
doesn't have:

1. **Load test against staging.** Once B5 is on staging:

   ```
   node scripts/load-test.js --base=https://<staging-api>/api --allow-host=<staging-api> \
     --database=<staging db name> --label=staging
   ```

   The script refuses production hosts.
2. **Latency from Lagos.**
   - Run [WebPageTest](https://www.webpagetest.org) from Lagos, or the nearest
     location (Johannesburg or Europe), against the frontend.
   - Run `curl -w "%{time_connect} %{time_starttransfer}\n"` from a Lagos VPS
     against `/api/products?limit=20` and `/api/products/<id>`.
   - Target: **p95 under 400 ms** for list and item.
3. **A day of production traffic** once deployed:

   ```
   railway logs --json > day.log && node scripts/perf-report.js day.log --markdown
   ```

   Paste the table here.
