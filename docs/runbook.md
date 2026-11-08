# Runbook

For whoever is on call. Commands assume the Railway CLI (`railway login`,
`railway link`) and `psql`.

**Never run destructive commands against production by accident:**
- Check the host in every command.
- Restore into a **new** database, never over the live one.

## 1. Backups

- **Automatic:** turn on Railway Postgres backups (Postgres service → Backups)
  with a daily schedule. Railway keeps them for the plan's retention period.
  Owner to confirm this is on.
- **Extra off-site copy, weekly (recommended):** dump to a file and keep it
  somewhere other than Railway (encrypted cloud storage):

  ```bash
  pg_dump "$PROD_DATABASE_URL" --format=custom --no-owner --file=campussales-$(date +%F).dump
  ```

- **Restore test, monthly (and after any backup change):** §2 on a scratch
  database. Record the date and result in the table at the end of this file.
  A backup that has never been restored is not a backup.

## 2. Restore a backup onto a test database

1. **Create an empty database.** Either create a new Railway Postgres service
   called `restore-test`, or use a local one:

   ```bash
   createdb campussales_restore_test
   ```

2. **Get the backup.**
   - Railway: Postgres → Backups → choose one → "Restore" **into the new
     service**. Never restore over production.
   - Or download it, or use a `pg_dump` file.
3. **Restore it** (for a `.dump` file):

   ```bash
   pg_restore --no-owner --no-privileges --dbname=postgres://…/campussales_restore_test campussales-2026-11-08.dump
   ```

4. **Bring the schema up to date:**

   ```bash
   DATABASE_HOST=… DATABASE_NAME=campussales_restore_test npm run migration:run
   ```

5. **Check it:**

   ```sql
   SELECT count(*) FROM users;
   SELECT count(*) FROM products WHERE "deletedAt" IS NULL;
   SELECT max("createdAt") FROM products;   -- close to the backup time?
   ```

   Read-only checks: `npm run audit:data -- --database=campussales_restore_test`.
6. **Point a local API at it:**

   ```bash
   DATABASE_NAME=campussales_restore_test NODE_ENV=staging npm run start:prod
   ```

   Then open `/health/ready` and log in with a test account.
7. Drop the test database when done. It contains real personal data.

## 3. Roll back a bad deploy

1. **Code:** Railway → Deployments → pick the last good deployment →
   "Redeploy". That takes about a minute.
2. **Migrations:** B1–B5 migrations are additive and guarded, so old code
   runs fine on the new schema. Don't revert migrations to roll back code.
3. If a migration itself is the problem, revert it on a copy first:

   ```bash
   npm run migration:revert
   ```

   This reverts the last migration only. Read its `down()` before running it
   on production, and back up first.
4. **Data damage:** restore the latest backup into a new database (§2), copy
   the affected rows across with SQL, and never swap databases blind.
5. Tell the team in Slack what happened and when it was fixed.

## 4. "The site is slow"

1. **Is it down or slow?** `curl -w '%{time_total}\n' https://<api>/health`
   should take a few tens of ms plus network.
   - Check `/health/ready`. A 503 means database trouble: go to step 4.
2. **Which routes?** `GET /api/admin/metrics?minutes=15` (admin token +
   `X-Admin-Key`) lists p50/p95/p99 per route, error counts, pool and cache
   stats. Alternatively:

   ```bash
   railway logs --json | node scripts/perf-report.js - --markdown
   ```

3. **Slow everywhere, high `durationMs` but low `dbMs`:** the CPU is
   saturated.
   - Check Railway → Metrics for CPU and memory.
   - A login burst is fine: bcrypt runs off the main thread now.
   - Scale up the instance or add a replica.
4. **High `dbMs`, or the pool-saturated alert:**
   - Find the slow queries. `pg_stat_statements` may need enabling:

     ```sql
     SELECT pid, now() - query_start AS running, state, left(query, 120)
       FROM pg_stat_activity WHERE datname = current_database() AND state <> 'idle'
      ORDER BY running DESC;
     ```

   - Cancel a runaway query with `SELECT pg_cancel_backend(<pid>);`.
     `statement_timeout` (14 s) stops most of them anyway.
   - Look for missing indexes with the query in docs/perf-baseline.md §4.
   - Pool exhausted with healthy queries: raise `DB_POOL_MAX` (keep it below
     100 / instances).
5. **One route slow:** `EXPLAIN ANALYZE` its query on a copy (see
   `scripts/bench-b3.js`).
6. **Slow only from Nigeria:** check the region (docs/infra.md §1) and the
   Cloudinary/Render status pages.
7. **Errors:** search the logs for `"level":"error"` and the `requestId` the
   user's error screen shows.

## 5. Alerts and what to do

| Alert | Meaning | First steps |
| --- | --- | --- |
| `error_rate` | > 2% of requests returned 5xx over 5 min (≥ 50 requests) | Logs with `"level":"error"`; roll back if it started at a deploy (§3) |
| `latency_p95` | p95 > 1 s over 10 min | §4 |
| `db_down` | `/health/ready` failing 2 checks in a row | Railway Postgres status/metrics; restart Postgres; check connection limits |
| `db_pool_saturated` | all connections busy with requests waiting, 3 min in a row | §4 step 4 |
| `signup_failures` | ≥ 10 failed signups/onboarding submits in 15 min | Try signing up yourself; check the last frontend deploy and validation errors in the logs |
| `email_failures` | ≥ 3 failed emails in 15 min | SMTP provider status and credentials (`EMAIL_*`) |
| External uptime monitor | the service is unreachable | Railway status, recent deploys, restart the service |

Alerts repeat at most every 30 minutes while firing and send a `[RESOLVED]`
message when they clear. They are per instance. Send
`POST /api/admin/alerts/test` to check delivery.

## 6. Shutdown and restarts

Deploys send SIGTERM:
- The API stops accepting connections and `/health/ready` returns 503.
- In-flight requests get up to `SHUTDOWN_GRACE_MS` (20 s) to finish.
- Queued analytics events are flushed, then the process exits.

An unhandled promise rejection or uncaught exception is logged with its stack,
and the process exits cleanly so Railway restarts it.

## 7. Error tracking

There's no third-party error tracker yet: Sentry needs the owner's approval.
Until then:
- 5xx errors are logged as JSON with `requestId`, the route and a hashed user
  id.
- The `requestId` is returned to clients in `X-Request-Id` and in
  `error.requestId`.
- To add Sentry after approval, call `setErrorReporter()`
  (`src/common/observability/error-reporter.ts`) from main.ts.

Privacy trade-off: Sentry receives stack traces and request metadata. Scrub
bodies, and send the hashed user id only.

## Restore test log

| Date | Backup used | Restored to | Row counts OK | By |
| --- | --- | --- | --- | --- |
| _first test pending_ | | | | |
