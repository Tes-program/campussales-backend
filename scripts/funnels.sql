-- Product funnels (B5). Read-only. Run with scripts/metrics.js, or paste into
-- psql against a replica/backup and replace :days with a number.
-- Events come from POST /api/events; facts (posts, messages, reports) come
-- from the real tables, so the funnels still work if the client drops events.
--
-- Visitors are identified by anonId. When someone signs up, the same anonId
-- keeps sending events with a userId attached, which links the anonymous
-- landing to the account.

-- name: funnel_signup
-- Landing -> sign-up started -> sign-up complete -> onboarding complete -> first message
WITH win AS (SELECT now() - (:days || ' days')::interval AS since),
landed AS (
  SELECT DISTINCT "anonId" FROM analytics_events, win
   WHERE name = 'landing_view' AND "occurredAt" >= win.since),
started AS (
  SELECT DISTINCT e."anonId" FROM analytics_events e JOIN landed l USING ("anonId")
   WHERE e.name = 'signup_start'),
completed AS (
  SELECT DISTINCT e."anonId", e."userId" FROM analytics_events e JOIN landed l USING ("anonId")
   WHERE e.name = 'signup_complete' AND e."userId" IS NOT NULL),
onboarded AS (
  SELECT c.* FROM completed c JOIN user_profiles up ON up."userId" = c."userId"
   WHERE up."universityId" IS NOT NULL),
messaged AS (
  SELECT DISTINCT o."userId" FROM onboarded o
    JOIN messages m ON m."senderId" = o."userId" AND m.type <> 'system')
SELECT 'landing_view' AS step, (SELECT count(*) FROM landed) AS visitors
UNION ALL SELECT 'signup_start', (SELECT count(*) FROM started)
UNION ALL SELECT 'signup_complete', (SELECT count(*) FROM completed)
UNION ALL SELECT 'onboarding_complete', (SELECT count(*) FROM onboarded)
UNION ALL SELECT 'first_message', (SELECT count(*) FROM messaged);

-- name: onboarding_drop_off
-- Where onboarding loses people: views and completions per step, plus errors
SELECT props->>'step' AS step,
       count(DISTINCT "anonId") FILTER (WHERE name = 'onboarding_step_view') AS viewed,
       count(DISTINCT "anonId") FILTER (WHERE name = 'onboarding_step_complete') AS completed,
       count(*) FILTER (WHERE name = 'onboarding_error') AS errors
  FROM analytics_events
 WHERE name IN ('onboarding_step_view', 'onboarding_step_complete', 'onboarding_error')
   AND "occurredAt" >= now() - (:days || ' days')::interval
 GROUP BY 1 ORDER BY 1;

-- name: first_post
-- New accounts in the window and how many posted a listing within 7 days
SELECT count(*) AS new_users,
       count(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM products p WHERE p."sellerId" = u.id
            AND p."createdAt" <= u."createdAt" + interval '7 days')) AS posted_within_7d,
       round(100.0 * count(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM products p WHERE p."sellerId" = u.id
            AND p."createdAt" <= u."createdAt" + interval '7 days')) / nullif(count(*), 0), 1) AS pct
  FROM users u
 WHERE u."createdAt" >= now() - (:days || ' days')::interval
   AND u.email NOT LIKE 'deleted-%';

-- name: sell_flow
-- Sell screen opened -> photo added -> posted (or failed)
SELECT count(DISTINCT "anonId") FILTER (WHERE name = 'sell_open') AS opened,
       count(DISTINCT "anonId") FILTER (WHERE name = 'photo_added') AS added_photo,
       count(DISTINCT "anonId") FILTER (WHERE name = 'post_success') AS posted,
       count(*) FILTER (WHERE name = 'post_error') AS post_errors
  FROM analytics_events
 WHERE "occurredAt" >= now() - (:days || ' days')::interval;

-- name: search_zero_results
-- Share of searches with no results (events), and the top missing queries (server log)
SELECT count(*) FILTER (WHERE name = 'search') AS searches,
       count(*) FILTER (WHERE name = 'search_zero_results') AS zero_results,
       round(100.0 * count(*) FILTER (WHERE name = 'search_zero_results')
             / nullif(count(*) FILTER (WHERE name = 'search'), 0), 1) AS zero_pct
  FROM analytics_events
 WHERE name IN ('search', 'search_zero_results')
   AND "occurredAt" >= now() - (:days || ' days')::interval;

-- name: top_missing_queries
SELECT query, count(*) AS searches
  FROM search_misses
 WHERE "createdAt" >= now() - (:days || ' days')::interval
 GROUP BY query ORDER BY searches DESC LIMIT 20;

-- name: report_rate
-- Reports per 1,000 live listings and per 1,000 active users, by reason
SELECT r.reason,
       count(*) AS reports,
       round(1000.0 * count(*) / nullif((SELECT count(*) FROM products WHERE "deletedAt" IS NULL AND status = 'active'), 0), 2) AS per_1000_listings,
       round(1000.0 * count(*) / nullif((SELECT count(*) FROM users WHERE "lastActiveAt" >= now() - (:days || ' days')::interval), 0), 2) AS per_1000_active_users
  FROM reports r
 WHERE r."createdAt" >= now() - (:days || ' days')::interval
 GROUP BY r.reason ORDER BY reports DESC;

-- name: report_flow
-- Report screen opened vs submitted (events)
SELECT count(*) FILTER (WHERE name = 'report_open') AS opened,
       count(*) FILTER (WHERE name = 'report_submit') AS submitted,
       count(*) FILTER (WHERE name = 'block_user') AS blocks
  FROM analytics_events
 WHERE "occurredAt" >= now() - (:days || ' days')::interval;

-- name: daily_active
-- Daily active visitors (anonId) and logged-in users
SELECT date_trunc('day', "occurredAt") AS day,
       count(DISTINCT "anonId") AS visitors,
       count(DISTINCT "userId") AS users
  FROM analytics_events
 WHERE "occurredAt" >= now() - (:days || ' days')::interval
 GROUP BY 1 ORDER BY 1;
