# Product metrics (B5)

## 1. Where the numbers come from

- **Events:** the frontend's `track()` (phase F0) sends them to
  `POST /api/events` (docs/api.md §12), and they're stored in
  `analytics_events`.
- **Facts:** listings, messages, reports and users come from their own
  tables, so the important funnels still work if a phone never sends its
  events.

No third-party analytics SDK is installed. Adding one (PostHog, GA,
Mixpanel…) needs the owner's approval; see §4 for the trade-offs.

## 2. Running the funnels

```bash
npm run metrics -- --days=30                              # every funnel
npm run metrics -- --days=7 --only=funnel_signup,report_rate
npm run metrics -- --database=<restored copy> --days=90   # preferred: a copy, not the live primary
```

The script runs every query inside a read-only transaction. The SQL is in
`scripts/funnels.sql`; copy any query into psql and replace `:days`.

| Query | Question it answers |
| --- | --- |
| `funnel_signup` | landing → sign-up started → sign-up complete → onboarding complete (school set) → first message |
| `onboarding_drop_off` | which onboarding step loses people, and errors per step |
| `first_post` | % of new accounts that post a listing within 7 days |
| `sell_flow` | sell screen opened → photo added → posted, plus post errors |
| `search_zero_results` | share of searches that found nothing |
| `top_missing_queries` | what students search for and can't find (server-side log, B3) |
| `report_rate` | reports per 1,000 live listings and per 1,000 active users, by reason |
| `report_flow` | report screen opened vs submitted, and blocks |
| `daily_active` | daily visitors (anonId) and logged-in users |

**How visitors link to accounts:** a visitor is identified by `anonId`. After
sign-up the same `anonId` keeps sending events, now with `userId` attached,
which ties the anonymous landing to the new account without ever storing an
email or IP.

**Events the frontend must send** (F0):
- `landing_view`, `signup_start`, `signup_complete`
- `onboarding_step_view` / `_complete` / `onboarding_error` with
  `{ step, field?, errorCode? }`
- `search` with `{ query, resultCount }` and `search_zero_results` with
  `{ query }`
- `sell_open`, `photo_added` with `{ photoCount }`, `post_success`,
  `post_error` with `{ errorCode }`
- `report_open`, `report_submit` with `{ targetType, reason }`
- `message_start` with `{ itemId }`, `wishlist_add` with `{ itemId }`,
  `share_click` with `{ channel }`, `block_user`

## 3. Privacy design (for the privacy notes; NEEDS LEGAL REVIEW)

These are technical choices, not a compliance claim (see docs/moderation.md
§7, NDPA 2023).

- **What is stored:** event name, client time, server receive time, a random
  `anonId` the app generates and keeps, allowlisted properties, and the user
  id only when logged in.
- **Never stored:** IP address, user agent, location, email, phone, names or
  message text.
  - The API rejects any property that looks like an email or phone number,
    and any text over 60 characters.
  - Property keys come from a fixed allowlist (`src/analytics/event-schema.ts`),
    and adding one is a code change for review.
  - Logs only ever hold a hashed user id.
- **Retention:** 13 months. A daily job deletes older events. When an account
  is deleted (after the 30-day grace), its events are unlinked
  (`userId = NULL`) and kept only as anonymous counts.
- **Opt-out:**
  - The browser's Do Not Track or Global Privacy Control signal is honoured
    (events are dropped).
  - **Settings → "Share usage data"** (`shareUsageData`, **default on**)
    drops all events from that account when switched off.
  - **Legal to confirm:** whether default-on is acceptable or should be
    opt-in.
- **Access:** `GET /api/me/export` includes the account's events (latest
  5,000).
- **Wording to add to the privacy notice (draft for legal):**
  - "We record how the app is used (for example, which screens are opened
    and whether a search found results) to improve CampusSales. We don't
    record your IP address or what you type in messages. You can turn this
    off in Settings → Share usage data. Usage records are deleted after 13
    months."

## 4. If a third-party tool is proposed (owner approval needed)

| Option | Gains | Privacy cost |
| --- | --- | --- |
| Keep in-house (current) | No new processor, full control, no cookies | Dashboards are SQL; no session replay |
| PostHog Cloud EU | Funnels/retention UI, feature flags | New data processor (EU); its SDK collects IP and device data by default (needs `ip: false`, autocapture off, masking); cookie banner likely needed |
| PostHog self-hosted | UI without a new processor | Infrastructure cost and maintenance |
| Google Analytics 4 | Free, familiar | Shares data with Google, cookies, transfer outside Nigeria; weakest fit for NDPA |

**Recommendation:** stay in-house until the funnels above stop being enough.
Then consider PostHog EU with autocapture and IP capture off, after a DPA and
a legal review.
