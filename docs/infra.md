# Infrastructure (B5)

## 1. Services and regions

Fill in the "Current region" column from each dashboard; I can't see them
from the code. The recommended column is where each service should end up.

| Service | Host | Current region (owner: check) | Recommended | How to check |
| --- | --- | --- | --- | --- |
| API (NestJS) | Railway | _fill in_ | **Europe West (Amsterdam), `europe-west4`** | Railway → service → Settings → Region |
| PostgreSQL | Railway | _fill in_ | **Same region as the API** | Railway → Postgres → Settings → Region |
| Redis | Railway | _fill in_ | Same region as the API | Railway → Redis → Settings → Region |
| Frontend | Render | _fill in_ | Frankfurt (closest Render region to Lagos) | Render → service → Settings → Region |
| Images | Cloudinary | global CDN | n/a | n/a |

**Why Europe West:** no major host offers a West African region for these
services yet. Western Europe has the shortest submarine-cable path to Lagos,
about 90–110 ms round trip, against about 200–300 ms to US regions. The most
important thing is that the **API and database are in the same region**: each
request makes 2–5 queries, so a cross-region database adds that many round
trips to every request.

## 2. Moving regions (manual step for the owner, not done in this PR)

Changing regions is an infrastructure change with a short outage. Do it in a
quiet hour, preferably 02:00–05:00 WAT.

1. Announce a maintenance window.
2. **Database.** Create a new Postgres in Europe West, take a fresh backup of
   the old one, and restore it into the new one (docs/runbook.md §2). Run
   `npm run migration:run` against the new database and check row counts
   match.
3. **Redis.** Create a new instance in Europe West. It only holds rate limits
   and job queues, so it needs no copying.
4. **API.** Switch the service region (Railway → Settings → Region), or deploy
   a new service there. Point `DATABASE_*` and `REDIS_*` at the new instances.
5. Smoke test: `/health/ready`, log in, the feed, post a listing with a
   photo.
6. Keep the old database read-only for 7 days, then delete it.
7. Update the "Current region" column above.

## 3. Environment variables added in B5

| Variable | Default | Purpose |
| --- | --- | --- |
| `DB_POOL_MAX` | 20 | Postgres pool size per instance. Keep below `max_connections / instances` (Railway: 100). |
| `DB_STATEMENT_TIMEOUT_MS` | 14000 | Postgres stops queries just before the 15 s request timeout. |
| `DB_CONNECTION_TIMEOUT_MS` | 5000 | Fail fast when the pool is exhausted. |
| `REQUEST_TIMEOUT_MS` | 15000 | Per-request timeout, then `504 TIMEOUT`. |
| `SHUTDOWN_GRACE_MS` | 20000 | Time in-flight requests get to finish on deploy/restart. |
| `RATE_LIMIT_SCALE` | 1 | Multiplies every per-minute limit (tests use 1000). |
| `LOG_FORMAT` | `json` in production | `json` or `pretty`. |
| `LOG_REQUESTS` | true (false in tests) | One log line per request. |
| `LOG_HASH_SALT` | falls back to `JWT_SECRET` | Salt for hashed user ids in logs. Set a long random value. |
| `SLOW_QUERY_MS` | 500 | Slow-query log threshold. |
| `CACHE_DISABLED` / `CACHE_MAX_ENTRIES` | false / 5000 | In-process cache switch and size. |
| `FEATURE_FLAGS` | `{}` | JSON overrides, e.g. `{"signedUploads":false}`. |
| `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET` | required with `STORAGE_TYPE=cloudinary` | Signing direct uploads. |
| `CLOUDINARY_UPLOAD_PRESET` | unset | Optional signed preset (see §5). |
| `UPLOAD_VERIFY_WITH_ADMIN_API` | true | Checks real size/format on `/uploads/complete`. |
| `UPLOAD_CLEANUP_MODE` | `dry-run` | `dry-run`, `delete` or `off`. |
| `ALERT_WEBHOOK_URL` | unset | Slack incoming webhook for alerts. |
| `ALERT_EMAIL` | falls back to `ADMIN_ALERT_EMAIL` | Alert email recipient. |
| `UV_THREADPOOL_SIZE` | 8 | Set in main.ts. Shared by bcrypt and compression. |

Startup fails in production with the **full list** of missing or invalid
variables (`src/config/env.validation.ts`), and prints warnings for
recommended ones.

## 4. Health checks, keep-warm and uptime monitoring

- **Railway health check:** Settings → Deploy → Healthcheck Path =
  `/health/ready`, timeout 10 s. A deploy only goes live once the new
  instance can reach the database.
- **Uptime monitor (free):** UptimeRobot or Better Stack.
  - HTTP check on `https://<api>/health/ready` every 1 minute.
  - Alert after 2 failures to the team email and Slack.
  - A second check on the frontend URL.
  - This is what fires when the whole service or database is down, because
    the in-app alerts can't send if the process is dead.
- **In-app alerts:** set `ALERT_WEBHOOK_URL` and/or `ALERT_EMAIL`, then send
  `POST /api/admin/alerts/test` once to confirm delivery. See
  docs/runbook.md §5 for the alert list.
- **Keep-warm:** `.github/workflows/keep-warm.yml` pings `/health` (API) and
  the frontend every 10 minutes. Set the repository variables `API_URL` and
  `FRONTEND_URL`.
  - **Recommended:** serve the frontend as a Render **Static Site** (it never
    sleeps), or use a paid Render instance. Keep Railway "App Sleeping" off.
  - A free Render web service can take 30–60 s to wake, which breaks the
    "first request under 5 s" goal.

## 5. Cloudinary set-up (owner)

The API signs every upload itself, restricted to the `campussales/products/`
or `campussales/avatars/` folder, jpg/png/webp/heic, and an incoming
transformation of `c_limit,w_1600,h_1600/q_auto:good` with eager 400 and
800 px versions. No preset is required.

Optional hardening:

1. Settings → Upload → Add upload preset: **Signed**, folder `campussales`,
   allowed formats `jpg,jpeg,png,webp,heic`, incoming transformation
   `c_limit,w_1600,h_1600/q_auto:good`.
2. Set `CLOUDINARY_UPLOAD_PRESET` to its name. The API then adds it to every
   signed request.
3. Settings → Security → turn on "Restricted media types: unsigned uploads
   off".

**3 MB limit:**
- Cloudinary can't enforce a per-upload size cap on signed uploads, so it is
  enforced in three places:
  - the phone (the frontend must check `file.size` against `maxBytes` before
    uploading)
  - `/uploads/complete`, which reads the real stored size from the Admin API,
    rejects anything over 3 MB and deletes it
  - the incoming transformation, which caps stored images at 1600 px
- The Admin API allows 500 calls per hour on the free plan. If it is rate
  limited, `/complete` falls back to the signed response and logs a warning.
