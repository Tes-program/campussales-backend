# Moderation, reports and chat safety (B4)

## 1. Listing screening

Runs on create, on edit, on relist with edits, and on draft publish.
Rules live in `src/moderation/screening.ts` (pure, unit-tested). The keyword
list is `data/prohibited.json`. The team can test text without saving through
`POST /api/admin/moderation/dry-run`.

Order and outcomes:

| Step | Rule | Outcome |
| --- | --- | --- |
| Hard rules | price below ₦50, no photo | already a 400 from validation (B1); counted again for backfills |
| | title made only of symbols | needs_review |
| | the same character 6+ times ("aaaaaaaa", "phoneeeeee") | needs_review |
| | all-caps title of 20+ characters | needs_review |
| | phone number, email, link or WhatsApp/Telegram handle **in the title** | **rejected**: "Please remove phone numbers, emails, links or WhatsApp details from the title. Buyers can message you in the app." |
| | same title as one of the seller's active listings in the last 24 h | needs_review |
| Prohibited items | `block` keyword (weapons, drugs, counterfeit, exam leaks and cheating services, adult, stolen) | **rejected** with the category message, e.g. "Weapons and ammunition can't be sold on CampusSales." |
| | `review` keyword (knife, glue gun, replica, vape…) | needs_review |
| Spam rate | 10+ new listings in the last hour or 30+ in the last day | needs_review |

Matching is whole-word (so "Expo markers" or "begun" don't match), on title,
description and tags, after undoing common obfuscation: digits for letters
(`c0caine`, `p1st0l`) and spaced or dotted letters (`g u n`, `c.o.c.a.i.n.e`).
Model numbers like `ak47` and prices are left alone.

**We never auto-reject on a guess.** Only `block` keywords and contact details
in the title are rejected; anything doubtful goes to a person. No account
action is ever taken from a single keyword.

Statuses (`products.moderationStatus`):

- `approved`: shows immediately.
- `needs_review`: `status = needs_review`, hidden from every list, search, feed
  and share page. Its owner sees it with `moderationNote: "Under review. This
  usually takes under 24 hours."` and can't activate it. Editing the listing
  re-screens it: a clean edit makes it live again, unless it is held because
  of reports or by a moderator.
- `rejected`: a 400 `MODERATION_REJECTED` on create/edit (nothing saved), or
  set by a moderator; hidden from everyone except the owner.

**Backfill:** `node scripts/fix-data.js --screening` dry-runs the rules on
existing approved listings and prints what would change.
`--apply --screening` moves anything not approved to needs_review. Existing
listings are never auto-rejected or deleted.

## 2. Reports

`POST /api/reports { targetType: listing|user|message, targetId, reason, details? }`

- Reasons: `scam`, `fake_item`, `prohibited`, `spam`, `harassment`, `other`.
  `details` ≤ 1000 characters.
- One report per user per target per 24 h (repeat → 409). At most 20 reports
  per user per day (→ 429).
- You can't report yourself. Message reports require being in that conversation.
- **The reporter stops seeing it immediately:** a reported listing, or every
  listing of a reported user, is filtered out of their lists, search, feed
  and similar items.
- **Privacy:** report details and reporter identity are visible only through
  the admin API. The reported user gets a generic "being reviewed" notice.
  Their data export includes reports *they* filed, never reports about them.

**Auto-hide** (listing → needs_review, owner notified generically):

- 3 open reports from **different** users; or
- 1 `scam` or `prohibited` report from an account older than 7 days.

**Repeat offenders:** when a user's listings or messages reach **3 confirmed
reports** (moderator `reject`, `remove` or `warn_user`) within 30 days,
posting is paused (`users.postingSuspendedAt`). The user can still browse and
chat. They get an in-app notice and an email with the reason and the appeal
address (`APPEAL_EMAIL`, default `appeals@campussales.ng`). New listings and
relists return 403 `ACCOUNT_SUSPENDED`.

### Appeal flow

1. The user emails the appeal address with their username (stated in the
   notice and email).
2. A moderator checks `GET /api/admin/users` and the audit log.
3. If upheld: `POST /api/admin/actions { action: "unsuspend_user", targetId }`,
   and/or `approve` the listing. Both are audited.

## 3. Blocks

`POST /api/blocks { userId }` (idempotent), `DELETE /api/blocks/:userId`
(idempotent), `GET /api/blocks`.

Blocking works in **both directions**:

- the two users' listings disappear for each other in list, search, feed,
  similar items, wishlist and the item page (404);
- their conversations disappear from both chat lists, and are left out of unread counts;
- neither can send a message or start a chat: 403 `BLOCKED` with the neutral
  message "You can't interact with this account." (REST and sockets).

## 4. Review queue (admin API)

**Access needs two things:** a logged-in user with `userType = admin`, AND the
`X-Admin-Key` header equal to `ADMIN_API_KEY`. A student token, or an admin's
token on its own, gets 403. With no `ADMIN_API_KEY` set the admin API is
disabled. (We chose an API over an internal page or CLI because it was the
smallest piece to secure and audit; a page can sit on top of it later.)

| Endpoint | Purpose |
| --- | --- |
| `GET /api/admin/reports?status=open` | open \| dismissed \| actioned \| all |
| `GET /api/admin/products?moderationStatus=needs_review` | listings to check, with reasons |
| `GET /api/admin/users` | accounts flagged by chat signals, or suspended |
| `GET /api/admin/audit-log` | who did what, when, why |
| `POST /api/admin/actions` | `{ action, targetId, reason? }` (below) |
| `POST /api/admin/moderation/dry-run` | screening on text, nothing saved |
| `POST /api/admin/summary/send` | send the queue summary email now |

Actions (every one writes `admin_audit_logs` and notifies the owner from our templates):

| Action | Target | Effect |
| --- | --- | --- |
| `approve` | listing | live again (previous status restored); its open reports dismissed |
| `reject` | listing | taken down (hidden, `moderationStatus = rejected`); reports confirmed; repeat-offender check. `reason` required |
| `remove` | listing | soft-deleted; chats about it closed; reports confirmed; repeat-offender check. `reason` required |
| `warn_user` | user | notice to the user; reports about them confirmed. `reason` required |
| `suspend_user` / `unsuspend_user` | user | pause or restore posting. `reason` required to suspend |
| `clear_user_review` | user | remove the chat-signal flag |
| `dismiss_report` | report | report closed, no action |

**Daily summary:** once a day (Redis lock, one instance), if
`ADMIN_ALERT_EMAIL` is set, an email lists open reports, listings and flagged
accounts older than 24 hours. There is no Slack webhook yet.

## 5. Chat safety

- Messages are trimmed; 1 to 1000 characters (an attachment may have no text).
  Clients can't send `system` messages.
- 30 messages per minute per user and 10 **new** conversations per hour.
  Over the limit: 429 with `retryAfterSeconds` (sockets get a
  `message:error` event with the same code).
- Every conversation carries a listing snapshot: `listing: { productId,
  title, coverImageUrl, priceAtStart }`. When the item is sold or deleted
  the chat is marked `closed` (`closedReason: sold | deleted | removed`) and
  a `system` message is added. Messaging still works.
- Conversation and message payloads never include email or phone.
- Unread counts: `unreadCount` per conversation and `totalUnread` on the
  list; `GET /chat/conversations/unread-count`; mark as read stays as
  before. All timestamps are ISO 8601 UTC.

### Scam signals (privacy note)

Messages are scanned for three patterns: a 10-digit account number (phone
numbers are ignored), payment-first phrases ("pay first", "send money",
gift cards…), and external links. A match **never blocks or edits** the
message. We store only which patterns matched (`messages.flags`) and show
the recipient a generic safety tip (`safetyTip: true`). If one account
triggers patterns in more than 5 different conversations within 24 hours, the
account is flagged for a person to look at (`users.needsReviewAt`, shown in
`GET /api/admin/users`). These are flags on messages, not a profile of the
user: there is no score or history beyond the flags themselves, and they are
deleted with the messages.

## 6. Trust fields

- `lastActiveAt`: updated at most every 5 minutes on authenticated requests;
  shown on the seller block of the item page.
- `verifiedStudent`: `true` only when the account has a **confirmed email on
  an academic domain** (`.edu.ng` or `.edu`). There is no other verification
  today. Options for later: school email allow-lists per school (exact
  domains), matriculation-number checks with schools, or an ID vendor. We
  don't recommend a vendor until volumes justify it.

## 7. Legal and privacy hooks (NEEDS LEGAL REVIEW)

These are implemented as technical hooks only. **They have not been reviewed
against the Nigeria Data Protection Act 2023 (NDPA). We do not claim
compliance.** A lawyer should review retention periods, the deletion
process, consent wording and the export format before launch.

- `GET /api/me/export`: JSON copy of the account, listings, wishlist,
  messages sent, reports filed, notifications and blocks (3 per day).
- `DELETE /api/me/account { "confirm": "DELETE" }`: deletion request.
  Sessions end, active listings are hidden, and logging in within **30 days**
  cancels it. After 30 days, a daily job anonymises the account: profile and
  contact data wiped, listings, wishlists, notifications and sessions deleted,
  and the person's messages replaced with "Message removed (account
  deleted)" so the other person's history stays coherent.
- `POST /api/me/consents { termsVersion?, privacyVersion? }` records
  acceptance with a timestamp (`acceptedTermsVersion/At`,
  `acceptedPrivacyVersion/At`). Sign-up already records terms (B2).
- Notifications older than 90 days are deleted daily.
- **Product analytics (B5):** no IP, a random anonymous id, the user id only
  when logged in, 13-month retention, Do Not Track honoured, and a
  "Share usage data" setting that defaults to on (legal to confirm the
  default). Events are included in the export and unlinked on account
  deletion. See docs/metrics.md §3.
- **Logs (B5):** structured JSON with hashed user ids. Passwords, tokens,
  message text and reset links are never logged, and a redaction layer masks
  them if code ever tries.

## 8. Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `ADMIN_API_KEY` | unset (admin API off) | second factor for the admin API (long random string) |
| `ADMIN_ALERT_EMAIL` | unset | daily review-queue summary |
| `APPEAL_EMAIL` | `appeals@campussales.ng` | shown in suspension notices |
| `MODERATION_SPAM_PER_HOUR` / `_PER_DAY` | 10 / 30 | spam-rate thresholds |
