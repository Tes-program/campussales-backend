# CampusSales API contract

Base URL: `/api`. JSON in, JSON out. Authenticated routes need
`Authorization: Bearer <accessToken>`.

This file is the contract the frontend builds against. It covers the endpoints
changed in **B1 (validation and data integrity)**, **B2 (auth)**,
**B3 (products, search, feed)** and **B4 (moderation, reports, chat safety)**. Interactive docs for every
route are at `/api/docs` (Swagger).

---

## 1. Errors

Every non-2xx response has this body. All problems are reported at once,
one message per field; messages are never joined into one string:

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Please fix the highlighted fields.",
    "fields": { "price": "Price must be at least ₦50." },
    "requestId": "6f0c1d1e-8c1a-4a57-9a51-2b1f6f1d3c2a"
  }
}
```

| Field | Notes |
| --- | --- |
| `error.code` | One of the codes below. Branch on this, never on the message. |
| `error.message` | Student-facing, safe to show as-is. Never contains stack traces or internal ids. |
| `error.fields` | Only on field-level problems. Keys are request field names; nested fields use dots (`profile.level`); array items report on the array (`images`, not `images.2`). Values are student-facing and safe to show under the input. |
| `error.details` | Only on some codes (e.g. `TERMS_VERSION_MISMATCH`): extra machine-readable context. |
| `error.requestId` | Same value as the `X-Request-Id` response header. Show it in "contact support" flows. |

### Codes

| HTTP | `error.code` | When |
| --- | --- | --- |
| 400 | `VALIDATION_FAILED` | Bad input (also malformed JSON, bad ids in the URL). |
| 401 | `UNAUTHENTICATED` | Missing/expired/invalid token. |
| 403 | `FORBIDDEN` | Logged in but not allowed (e.g. not the listing owner). |
| 404 | `NOT_FOUND` | Missing **or soft-deleted** resource. |
| 409 | `CONFLICT` | Clashes with existing state (phone on another account, editing a sold item). May include `fields`. |
| 429 | `RATE_LIMITED` | Too many attempts (e.g. relist bump within 24 h). |
| 500 | `SERVER_ERROR` | Our bug. Message is generic; the server logs the details under `requestId`. |
| 401 | `INVALID_CREDENTIALS` | Login failed: "Email or password is incorrect." Never says which. |
| 400 | `TOKEN_INVALID` | Reset/verification link unknown, already used or superseded. |
| 400 | `TOKEN_EXPIRED` | Reset/verification link expired. |
| 403 | `EMAIL_NOT_VERIFIED` | 24 h unverified grace is over (write actions only). |
| 403 | `BLOCKED` | One user blocked the other. Neutral message. |
| 400 | `MODERATION_REJECTED` | Listing screening rejected the item (`fields` explains). |
| 403 | `ACCOUNT_SUSPENDED` | Posting is paused for this account. |
| 400 | `TERMS_VERSION_MISMATCH` | Sign-up sent a missing or outdated `acceptedTermsVersion` (and nothing else was wrong). `fields.acceptedTermsVersion` is set and `error.details` holds the current versions (same shape as `GET /legal/versions`). |

429 responses also carry `error.retryAfterSeconds` and a `Retry-After` header.

### Request ids

Every response (success or error) carries `X-Request-Id` (exposed to the
browser via CORS). Clients may send their own `X-Request-Id`
(8–64 chars of `A-Z a-z 0-9 . _ -`); it is reused, otherwise the server
generates a UUID.

### Legacy fields (deprecated, kept for one release)

So the currently deployed frontend keeps working, error bodies also include:

| Legacy field | Replacement |
| --- | --- |
| `statusCode` | HTTP status |
| `message` (string, or array of field messages for 400s) | `error.message` / `error.fields` |
| `errorCode` | `error.code` |
| `timestamp`, `path`, `method` | none |

**Breaking for anyone reading it:** the legacy top-level `error` *string*
("Bad Request") is now the `error` *object* above. The deployed frontend does
not read it.

These legacy fields will be removed in the release after B2. See section 11.

---

## 2. Listings (products)

### Field rules

Used by `POST /products`, `PATCH /products/:id`, `POST /products/:id/relist`
and draft publishing. All rules come from
`src/common/validation/rules.ts`.

| Field | Type | Rule | Messages (`fields.<name>`) |
| --- | --- | --- | --- |
| `title` | string | Required on create. Trimmed. 3–80 characters (emoji/accents count as one). No control or invisible formatting characters (tabs, newlines, zero-width space, RTL override…). | "Please enter a product title." · "Title must be at least 3 characters." · "Title must be 80 characters or fewer." · "Title contains characters we can’t display. Please retype it." |
| `description` | string | Optional. Trimmed. ≤ 600 characters. Newlines and tabs allowed. `null` on PATCH clears it. | "Description must be 600 characters or fewer." |
| `price` | integer | Required on create. **Whole naira**, 50–100,000,000. Numeric strings like `"2500"` are accepted; `0`, negatives, decimals, `"abc"`, booleans are rejected. | "Enter a price." · "Price must be a number, like 2500." · "Price must be a whole number of naira (no kobo)." · "Price must be at least ₦50." · "Price can’t be more than ₦100,000,000." |
| `quantity` | integer | Optional, default 1. 1–999. | "Quantity must be at least 1." · "Quantity can’t be more than 999." · "Quantity must be a whole number." |
| `category` | string | Slug from the shared list (below). Names and old slugs are accepted and normalised. Send this **or** `categoryId`; one is required on create. | "Please select a category." · "Choose a category from the list." |
| `categoryId` | uuid | Legacy alternative to `category`. Must be an active category in the shared list. | "Choose a category from the list." |
| `condition` | string | `new`, `like_new`, `used`, `fair`. UI labels `New`, `Like New`, `Used`, `Fair` are accepted (any case). Responses use the stored values. | "Choose the item’s condition." · "Condition must be New, Like New, Used or Fair." |
| `images` | string[] | Required on create. 1–5 unique URLs of the form `https://res.cloudinary.com/<our cloud name>/…`. Other hosts are rejected. (Local development with `STORAGE_TYPE=local` also accepts `<BACKEND_URL>/uploads/…`.) First image is the cover. | "Please add at least one image." · "Maximum 5 images allowed." · "Photos must be uploaded through CampusSales." · "Each photo can only be added once." |
| `tags` | string[] | Optional. Lowercased, trimmed, spaces collapsed and de-duplicated by the server, then ≤ 10 tags of 2–24 characters (letters, numbers, spaces, hyphens; unicode letters fine). | "You can add up to 10 tags." · "Each tag must be 2 to 24 characters." · "Tags can only use letters, numbers, spaces and hyphens." |

Unknown fields are rejected with "This field isn't accepted here."
(`isFeatured` and `isAvailable` are no longer accepted on PATCH.)

**Price storage:** whole naira as a PostgreSQL `integer`. Kobo is not stored.
The B1 migration converts existing `numeric(10,2)` prices with `ROUND()`;
`scripts/audit-data.js` lists any rows that had kobo before migrating.

### Shared categories

Single source of truth: `src/common/constants/categories.ts`.

| slug | name | also accepted |
| --- | --- | --- |
| `electronics` | Electronics | |
| `books-textbooks` | Books & Textbooks | books, books-notes, books-stationery, textbooks |
| `school-supplies` | School Supplies | stationery, supplies |
| `clothing-apparel` | Clothing & Apparel | clothing, clothing-fashion, fashion, apparel |
| `furniture` | Furniture | |
| `home-kitchen` | Home & Kitchen | kitchen-appliances, kitchen, home |
| `sports-outdoors` | Sports & Outdoors | sports, sports-fitness, fitness |
| `gaming` | Gaming | games, games-entertainment, toys-games |
| `musical-instruments` | Musical Instruments | music |
| `art-crafts` | Art & Crafts | |
| `bikes-transportation` | Bikes & Transportation | bicycles-accessories, bikes, bicycles |
| `beauty-personal-care` | Beauty & Personal Care | beauty |
| `other` | Other | others, miscellaneous |

`GET /api/categories/active` still returns the database rows (with ids).

### Product object (returned by every write)

Every write returns the full updated product, so the UI does not need to
refetch. New fields are marked **new**.

```json
{
  "id": "uuid",
  "sellerId": "uuid",
  "title": "Casio fx-991ES calculator",
  "description": "Works perfectly.",
  "price": 7500,
  "condition": "used",
  "quantity": 1,
  "categoryId": "uuid",
  "category": { "id": "uuid", "name": "School Supplies", "slug": "school-supplies", "...": "..." },
  "images": [{ "id": "uuid", "imageUrl": "https://res.cloudinary.com/...", "isPrimary": true, "sortOrder": 0 }],
  "tags": ["calculator", "casio"],
  "status": "active",
  "priceHistory": [{ "oldPrice": 7500, "newPrice": 6000, "changedAt": "2026-11-07T12:00:00.000Z" }],
  "lastBumpedAt": null,
  "deletedAt": null,
  "isAvailable": true,
  "isSold": false,
  "isFeatured": false,
  "viewCount": 0,
  "createdAt": "2026-11-07T12:00:00.000Z",
  "updatedAt": "2026-11-07T12:00:00.000Z"
}
```

| Field | Notes |
| --- | --- |
| `price` | **Now a number** (was a decimal string such as `"7500.00"`). |
| `status` (**new**) | `active` (public) · `inactive` (hidden by seller) · `sold` · `needs_review` (hidden by data clean-up until the seller fixes it). |
| `isAvailable`, `isSold` | Kept in sync with `status` (`isAvailable = status == active`, `isSold = status == sold`). Prefer `status`. |
| `tags` (**new**) | Stored and returned (previously accepted but dropped). |
| `priceHistory` (**new**) | Oldest first, last 20 changes. For "Price drop" and "Was ₦X / Now ₦Y": use the last entry's `oldPrice` and `newPrice`. |
| `lastBumpedAt` (**new**) | When relist last moved the item to the top. |
| `deletedAt` (**new**) | Only non-null in the response to `DELETE`. |

### Endpoints

| Method & path | Auth | Body | Success | Errors |
| --- | --- | --- | --- | --- |
| `POST /products` | yes | create fields | 201 product | 400 |
| `PATCH /products/:id` | owner | any subset of: title, description, price, quantity, category/categoryId, condition, images, tags | 200 product. Records `priceHistory` when the price changes; notifies wishlisters on a drop. | 400 · 403 not owner · 404 missing/deleted · 409 sold (relist instead) |
| `POST /products/:id/relist` | owner | optional, same as PATCH | 200 product, `status: active`. See rules below. | 400 listing invalid · 403 · 404 · 429 |
| `POST /products/:id/sold` | owner | – | 200 product (idempotent) | 403 · 404 |
| `POST /products/:id/deactivate` | owner | – | 200 product (idempotent; no-op on sold/inactive/needs_review) | 403 · 404 |
| `POST /products/:id/activate` | owner | – | 200 product (idempotent). From `needs_review`/`inactive` the listing is re-checked first. | 400 listing invalid · 403 · 404 · 409 sold |
| `DELETE /products/:id` | owner | – | **200** product with `deletedAt` (was 204, no body) | 403 · 404 |
| `PATCH /products/:id/sold` | owner | – | Deprecated alias of `POST …/sold` | |
| `PATCH /products/:id/unavailable` | owner | – | Deprecated toggle active⇄inactive (no-op on sold) | |
| `POST /products/drafts/:id/publish` | owner | optional overrides | 201 product. The merged draft goes through the create rules. | 400 with `message: "Finish the highlighted fields before publishing."` |

Ownership is checked after existence: a deleted or missing id is 404 for
everyone, an existing listing you don't own is 403.

**Relist rules.** A `sold`, `inactive` or `needs_review` item becomes `active`.
Edits in the body are applied first (this is the only way to edit a sold
item). The whole listing must then pass the rules (price, title, ≥ 1 photo).
`createdAt` is bumped to now at most once every 24 hours; inside that window
the item still reactivates, just without moving up. Relisting an item that is
already `active` is a pure bump: 429 `RATE_LIMITED` inside the 24 h window.

**Soft delete.** Deleted items are excluded from `GET /products`, search,
featured, recommended, `my-products`, stats, and `GET /products/:id` (404).
Chat headers stop showing them (`lastReferencedProduct` becomes `null`).
Rows are kept for audit.

### Drafts

`POST /products/drafts`, `PATCH /products/drafts/:id` and
`POST /products/drafts/auto-save` (`{ draftId?: uuid, data: {...draft fields} }`)
accept the listing fields, all optional, so a half-finished draft saves fine.
Any field that **is** sent must pass the listing rule, except that a draft may
have a short title (any length up to 80) and zero photos. `category` (slug) is
stored as `categoryId`. Errors for auto-save use `data.` prefixes
(`fields["data.price"]`). Publishing runs the full create rules.

### Other write endpoints validated in B1

| Endpoint | Body |
| --- | --- |
| `POST /wishlist/check-multiple` | `{ productIds: uuid[] }` (≤ 100) |
| `PATCH /users/:id/status` (admin) | `{ status: "active" \| "inactive" \| "suspended" }` |
| `POST /categories/bulk`, `POST /universities/bulk` (admin) | JSON array; each item validated like the single-create body |

Auth and chat bodies are covered in B2 and B4.

### Wishlist

`GET /wishlist` now **includes** items whose product was sold, hidden or
deleted, instead of silently dropping them:

```json
{ "id": "…", "productId": "…", "product": { "…": "full product, even if deleted" },
  "isUnavailable": true, "unavailableMessage": "No longer available" }
```

Show `unavailableMessage` instead of the buy/chat actions when
`isUnavailable` is true. `total` and `totalPages` now count every entry.
Deleted products can't be added (404).

---

## 3. Onboarding

`POST /users/onboarding/complete` (auth) returns **200** (was 201).

- **Idempotent**: repeating the call (same data, double tap, retry after a
  timeout) returns 200 and the current profile, never 400 or 409.
- **Returns the saved profile**, so no follow-up `GET` is needed.
- **All problems at once** in `error.fields`, including an unknown school.

**Decision (H2): `level` is optional.** Nothing in the product (feed, search,
listings, profile cards) reads it, and the deployed onboarding screen never
sends it, so requiring it blocked every new user. Ask for it later on the
profile page (`PATCH /users/me` with `profile.level`). If a feature starts to
depend on it, make it required in the same release as the frontend field.

| Field | Rule | Messages |
| --- | --- | --- |
| `firstName`, `lastName` | Required, trimmed, 2–50 characters. | "First name must be 2 to 50 characters." / "Last name must be 2 to 50 characters." |
| `phone` (alias: `phoneNumber`) | Required. Nigerian mobile: `0XXXXXXXXXX` (11 digits starting 070, 080, 081, 090, 091), `+234XXXXXXXXXX` or `234XXXXXXXXXX`. Spaces, dashes, dots and brackets are ignored. **Saved as `+234XXXXXXXXXX`.** Errors are reported under `fields.phone` even when `phoneNumber` was sent. | "Enter your phone number." · "Enter a valid Nigerian phone number, like 0803 123 4567." · 409 "That number is already used on another account." |
| `school` (alias: `universityId`) | Required. A school `id` from `GET /schools`, or its exact name / short name (case-insensitive). Never fuzzy-matched. Errors under `fields.school`. | "Choose your school." · "Choose your school from the list." |
| `level` | **Optional.** Omit to keep the current value; `null` or `""` clears it. Allowed: `100`, `200`, `300`, `400`, `500`, `600`, `Postgraduate`, `Alumnus`. Also accepts `300L`, `300 Level`, numbers, any case. `Graduate` is read as `Alumnus`. | "Level must be 100 to 600, Postgraduate or Alumnus." |
| `gender` | Optional. `Male`, `Female`, `Prefer not to say` (any case; `prefer_not_to_say` ok). | "Gender must be Male, Female or Prefer not to say." |
| `interests` | Optional. 0–8 categories by slug, name (`"Clothing & Apparel"`) or alias; normalised to slugs, duplicates removed. Slugs: `electronics`, `books-textbooks`, `school-supplies`, `clothing-apparel`, `furniture`, `home-kitchen`, `sports-outdoors`, `gaming`, `musical-instruments`, `art-crafts`, `bikes-transportation`, `beauty-personal-care`, `other`. | "You can pick up to 8 interests." · "Pick interests from the categories list." |
| `dateOfBirth` | Optional ISO date. | "Enter a valid date of birth." |
| `bio` | Optional, ≤ 500 characters. | "Bio must be 500 characters or fewer." |
| `profilePictureUrl` | Optional text. | |
| `universityName` | Accepted and ignored: the canonical school name is stored. | |

What the live frontend sends today (all accepted):
`{ firstName, lastName, phoneNumber: "0803…", gender: "Male" | "Female" | omitted, universityId, interests: ["Clothing & Apparel", …] }`.

Responses:

- **200**: the user (no `passwordHash`) with `phoneNumber` in +234 form,
  `profile` (including `level`, `universityId`, canonical `universityName`,
  `interests` as slugs) and `school: { id, name, shortName, city }`.
- **400** `VALIDATION_FAILED` with `fields`. When `level`, `gender` or
  `interests` fail, `error.details.allowedValues.<field>` lists the exact
  accepted values:

  ```json
  { "error": { "code": "VALIDATION_FAILED",
      "message": "Please fix the highlighted fields.",
      "fields": { "level": "Level must be 100 to 600, Postgraduate or Alumnus." },
      "details": { "allowedValues": { "level": ["100","200","300","400","500","600","Postgraduate","Alumnus"] } } } }
  ```
- **409** `CONFLICT` with `fields.phone` when another account uses the number.

Logs for 4xx responses record the `requestId` and the failing field names
(`fields=phone,school`), never the submitted values.

## 4. Profile update

`PATCH /users/me` (auth). Same validators as onboarding.

```json
{ "email": "…", "phone": "0803 123 4567", "profile": { "firstName": "…", "school": "<id>", "level": "300", "gender": "Female", "interests": ["electronics"], "bio": "…" } }
```

- `phone` (alias `phoneNumber`): `null` or `""` clears it. 409 with
  `fields.phone` if another account uses it (checked against both normalised
  and older stored formats).
- Nested errors use dotted keys: `fields["profile.level"]`.
- 409 with `fields.email` if the email belongs to another account.
- `userType`, `status`, `isVerified` and `isActive` are **no longer accepted**
  here (they let students change their own role). Admins use
  `PATCH /users/:id`.

## 5. Schools

`GET /schools?query=<text>` (public; `q` is an alias). Up to **20** results:

```json
[{ "id": "uuid", "name": "University of Lagos", "shortName": "UNILAG", "city": "Lagos" }]
```

Case-, accent- and punctuation-insensitive. Tolerates typos (`unilg`,
`covenent`, `univeristy of ibadan`) and matches word prefixes and city names.
Empty query returns the first 20 alphabetically. `query` longer than 100
characters is a 400.

The list is seeded from `data/schools.json` with `npm run seed:schools`
(idempotent: inserts missing schools and fills empty city/short name; never
deletes or renames). **The team must review that file for completeness before
launch.** `shortName` is stored in `universities.code`.

---

## 6. Data clean-up scripts

Both use the same `DATABASE_*` variables as the API and **ignore
`DATABASE_URL`**. Output goes to `scripts/out/` (git-ignored). Phone numbers
are masked in every output except fix-data's `changes.csv`, which holds the
real old values so changes can be reversed.

| Command | What it does |
| --- | --- |
| `npm run audit:data` | Read-only (runs in a `READ ONLY` transaction). Counts and CSVs: price < 50, kobo prices, price > max, quantity < 1 / > 999, no images, > 5 images, empty/short titles, junk titles, suspected test listings (e.g. "QA Test"), duplicate title + seller, sold-but-available, invalid / un-normalised / duplicate phones, categories outside the shared list. Works before or after the migration. |
| `npm run fix:data` | **Dry run** by default: prints the plan and writes `plan.csv`, changes nothing. |
| `npm run fix:data -- --apply` | Clamps quantity < 1 to 1; sets `status = needs_review` (hidden) on active/inactive listings with an invalid price, no images or a junk title; normalises parseable phones to +234. **Never deletes.** Non-local hosts also need `--confirm-host=<host>`. |

Test listings (e.g. "QA Test") are hidden, not deleted. Ask the owner before
deleting anything.

---

## 7. Deploy order (Railway)

The new code needs the new columns, so run the migration **before** the new
build starts serving.

1. Back up the production database.
2. `npm run audit:data` against production (read-only) and keep the report.
   Check `categories_outside_shared_list` is 0 and review `price_has_kobo`.
3. Run migrations: `npm run migration:run`. The B1 migration and
   `CreateNotificationsIfMissing` are guarded and safe on a schema built by
   `synchronize`. If production's `migrations` table is empty (schema built by
   `synchronize`), first mark the older migrations as run, the same way the
   test copy was baselined (see the PR notes).
4. `npm run seed:categories` and `npm run seed:schools` (insert-only).
5. Deploy the new build.
6. `npm run fix:data` (dry run), review `plan.csv`, then
   `npm run fix:data -- --apply --confirm-host=<host>`.

**B2–B4 additions** (same release train; migrations are guarded and additive):

7. Before deploying B2, set on Railway: `FRONTEND_URL=https://campus-sales.onrender.com`
   (startup fails without it), `CORS_ORIGIN=https://campus-sales.onrender.com`,
   `AUTH_LEGACY_TOKENS=true` (until the frontend migrates; remove by
   2027-01-31), and, because the frontend and API are on different sites,
   `AUTH_COOKIE_SAMESITE=none` or a shared domain (see docs/security.md).
8. B3 needs the `pg_trgm` and `fuzzystrmatch` extensions; the migration
   creates them (both are "trusted" on PostgreSQL 13+). Afterwards
   `REFRESH MATERIALIZED VIEW search_vocabulary;` runs automatically every
   10 minutes when listings change.
9. B4: set `ADMIN_API_KEY` (long random string; without it the admin API is
   off), `ADMIN_ALERT_EMAIL` and optionally `APPEAL_EMAIL`. Then
   `npm run fix:data -- --screening` (dry run) and, after review,
   `--apply --screening --confirm-host=<host>`.
10. B5: run migrations (`B5PerformanceAnalytics` is additive;
    `B5ForeignKeyIndexes` builds indexes `CONCURRENTLY`, outside a
    transaction, so writes keep flowing). Set the env vars in
    docs/infra.md §3 (at least `LOG_HASH_SALT`, `ALERT_WEBHOOK_URL` or
    `ALERT_EMAIL`, `CLOUDINARY_API_KEY/SECRET`), point Railway's health check
    at `/health/ready`, and leave `UPLOAD_CLEANUP_MODE` unset (dry run) until
    a week of dry-run logs has been reviewed. Region moves are manual: see
    docs/infra.md §2.
11. Local development uses TypeORM `synchronize`, which drops indexes it
    doesn't know about (the search indexes). Prefer running migrations locally
    too (`NODE_ENV=test`) or switch `synchronize` off.

---

## 8. Listings, search and feed (B3)

Performance proof: [docs/perf-b3.md](perf-b3.md) (worst p95 49 ms on 10,000 products).

### `GET /products` (public; personalised when a token is sent)

| Param | Notes |
| --- | --- |
| `q` | Search text, ≤ 100 chars (legacy alias `search`). Typo-tolerant. |
| `campus` | School id, or `all`. **Never defaulted by the server.** No param = no campus filter (legacy alias `universityId`). |
| `category` | Slug(s), repeat or comma-separate (`category=gaming,furniture`). Legacy `categoryId` still works. |
| `condition` | Multi-value (`new`, `like_new`, `used`, `fair` or labels). |
| `minPrice`, `maxPrice` | Integer naira. `maxPrice` < `minPrice` → `fields.maxPrice`. |
| `tag` | One tag (lowercase). |
| `status` | `active` (default) or `sold`. |
| `sort` | `newest` (default), `price_asc`, `price_desc`, `relevance` (needs `q`). Legacy `sortBy`/`sortOrder` map to these. |
| `limit` | Default 20, max 50. |
| `cursor` | Opaque; pass back `nextCursor`. Keyset on (createdAt, id) or (price, id): stable and duplicate-free even when new items arrive. Relevance uses an offset cursor. Legacy `page` still does offset paging. |

Every invalid parameter is a 400 with `fields`.

```json
{
  "items": [ /* cards */ ],
  "nextCursor": "eyJzIjoi…",
  "total": 1000, "totalCapped": true,
  "didYouMean": "laptop",
  "fromOtherCampuses": false,
  "moreFromNearby": [],
  "data": [ /* same as items (legacy) */ ], "page": 1, "limit": 20
}
```

- `total` is capped at 1000; show "1000+" when `totalCapped` is true.
- `didYouMean` is set when a word was corrected (e.g. `laptpo` → `laptop`);
  results already use the correction.
- When `campus` is set and the first page has fewer than 4 items,
  `fromOtherCampuses: true` and `moreFromNearby` holds up to 8 items from
  other campuses (same city first): "Nothing on your campus yet. Here's
  what's nearby."
- Logged-in viewers never see items from users they blocked or who blocked them.

**Card shape** (list, wishlist, similar, feed): `id, title, description`
(**now a ≤ 160-char excerpt**; the full text is on the item endpoint)`,
excerpt, price, previousPrice, droppedAt, condition, quantity, status,
isAvailable, isSold, isFeatured, viewCount, tags, sellerId, categoryId,
campusId, category{id,name,slug}, images[] (cover first), seller{id,
firstName, avatar, campus{id,name,shortName}, profile{…legacy}},
createdAt, updatedAt`, plus `isWishlisted` when logged in.
**Removed:** `seller.email` (never needed in cards; private).

### `GET /products/:id` (public)

Full product: everything in the card plus the full `description`,
`priceHistory`, `lastBumpedAt`, and ISO 8601 `createdAt`/`updatedAt`.
`seller` adds `memberSince`, `itemsSold`, `lastActiveAt`, `verifiedStudent`
(true only for a confirmed email on an `.edu.ng`/`.edu` domain). Email and
phone appear only for the owner. Logged in: `isOwner`, `isWishlisted`; owner
only: `wishlistCount` (a number, never who saved it).

- Sold or inactive: 200 with `status` (show "This item is no longer available").
- Deleted, under review (non-owner) or blocked: 404.
- Anonymous: `Cache-Control: public, max-age=60` and `ETag` (304 on `If-None-Match`).
  Logged in: `private, no-store`.

### `GET /products/:id/similar?limit=8`

Same category, same campus first, price 50–200% of the item, excluding the
item, the viewer's own items and blocked users. `{ items: [cards] }`, limit ≤ 20.

### Search

- Matches title (weight A), tags (B), description (D) with PostgreSQL full
  text search (English stemming: plurals, case) plus trigram similarity on
  titles, plus category names. Typo correction uses a vocabulary of live
  title/tag words (edit distance ≤ 2 or trigram match).
- Synonyms and protected words: `data/search-synonyms.json` ("fone" → phone;
  "tokunbo", "fan", "ac" are never dropped or corrected).
- `GET /search/suggest?q=` → `{ suggestions: [{ type: "category"|"title", text, slug? }] }`,
  up to 8, cached 60 s per query.
- Zero-result queries are stored in `search_misses` (text only, no user).
  `npm run search:misses` prints the weekly top 50.

### `GET /feed` (auth)

`{ items: [cards], nextCursor }`. Ranked by `src/feed/feed-score.ts`:
recency (14-day decay), same campus +0.6, interest category +0.4, price drop
in the last 7 days +0.3, seller active in the last 3 days +0.2, older than
60 days −0.5. Never the viewer's own or blocked users' items; at most 3 in a
row from one seller. Logged-out users use `GET /products` (newest).

### `GET /me/interests`, `PATCH /me/interests`

`{ interests: ["electronics", "books-textbooks"] }` (0–8 category slugs;
aliases accepted). Onboarding already saves interests to the same place.

### Wishlist (B3 changes)

- `GET /wishlist` → `items`: cards plus `available`, `status` (`active`,
  `sold`, `inactive`, `deleted`), `unavailableMessage`, `wishlistedAt`. Legacy
  `data` is unchanged.
- `POST /wishlist/:productId` → 200 `{ isInWishlist: true, added }`, idempotent.
- `DELETE /wishlist/:productId` → 204, idempotent (no 404 when not saved).

### Share previews

`GET /share/item/:id` (at the API root, not under `/api`) returns minimal HTML
with Open Graph and Twitter tags (title with ₦ price, excerpt, cover image)
and redirects people to `{FRONTEND_URL}/item/:id`. `GET /share` does the same
for the landing page.

Routing: Render static sites can't route by User-Agent, so **use the share
URL itself as the link people copy** (the "Share" button should copy
`https://<api-host>/share/item/<id>`). Bots read the tags; people land on the
item page. If you later put a CDN in front of the site (for example Cloudflare),
you can instead route known bot user agents on `/item/*` to
`/share/item/*`.

---

## 9. Auth (B2)

Full design and deployment notes: [docs/security.md](security.md).

### Session model

- `accessToken` (15 min) comes back in the JSON body. Keep it in memory and
  send `Authorization: Bearer …`.
- The refresh token is the `cs_refresh` cookie (HttpOnly, Secure,
  SameSite=Lax, Path=/api/auth, 30 days). Call every `/api/auth/*` endpoint
  with `credentials: 'include'`.
- On a 401 from any API call: `POST /api/auth/refresh` once; if that also
  returns 401, send the user to login.

Session response (signup, login, refresh):

```json
{ "accessToken": "…", "tokenType": "Bearer", "expiresIn": 900,
  "user": { "id": "…", "email": "…", "fullName": "…", "emailVerified": false,
            "verifyBy": "2026-11-08T12:00:00.000Z", "userType": "student", "…": "…" } }
```

While `AUTH_LEGACY_TOKENS=true` (until **2027-01-31**) the body also has
`refreshToken`, and `/refresh` and `/logout` accept `{ "refreshToken": "…" }`.

### Endpoints

| Method & path | Auth | Body | Success | Errors |
| --- | --- | --- | --- | --- |
| `POST /auth/signup` | – | `email`, `username`, `password`, `confirmPassword?`, `campus?` (or `schoolId?`), `acceptedTerms: true`, `acceptedTermsVersion`, `name?` | 201 session + cookie; verification email sent | 400 `VALIDATION_FAILED` fields · 400 `TERMS_VERSION_MISMATCH` · 409 email taken · 429 |
| `POST /auth/register` | – | Alias of `/auth/signup` (same body and rules). While legacy mode is on, the two terms fields may be omitted. | as signup | as signup |
| `POST /auth/login` | – | `email`, `password` | 200 session + cookie | 401 `INVALID_CREDENTIALS` · 429 + `retryAfterSeconds` |
| `POST /auth/refresh` | cookie | – | 200 session + new cookie | 401 `UNAUTHENTICATED` |
| `POST /auth/logout` | cookie | – | 204, cookie cleared | – |
| `POST /auth/logout-all` | bearer | – | 204 | 401 |
| `POST /auth/change-password` | bearer (+ cookie to keep this session) | `currentPassword`, `newPassword` | 200 `{ message, accessToken, expiresIn }` | 400 `fields.currentPassword` / `fields.newPassword` |
| `POST /auth/forgot-password` | – | `email` | 200 `{ message: "If that email has an account, we've sent a link." }` (always) | 400 bad email format |
| `POST /auth/reset-password` | – | `token`, `newPassword` | 200 `{ message }` | 400 `TOKEN_INVALID` · `TOKEN_EXPIRED` · `fields.newPassword` |
| `POST /auth/verify-email` | – | `token` | 200 `{ message, user }` | 400 `TOKEN_INVALID` · `TOKEN_EXPIRED` |
| `POST /auth/resend-verification` | bearer | – | 200 `{ message }` | 429 (3/hour) |
| `GET /auth/me` | bearer | – | user (with `emailVerified`) | 401 |

### Password rule (identical to the frontend checklist)

- at least 8 characters
- at least one number
- at most 72 bytes (bcrypt limit)

Messages (`fields.password` / `fields.newPassword`): "Enter a password." ·
"Use at least 8 characters, including a number." · "That password is too
long. Use 72 characters or fewer."

### Links in emails

- `{FRONTEND_URL}/reset-password?token=…` (30 minutes, single use)
- `{FRONTEND_URL}/verify-email?token=…` (24 hours, single use)

### Legal versions

`GET /legal/versions` (public, no auth, `Cache-Control: public, max-age=300`):

```json
{ "termsVersion": "2026-11-01", "privacyVersion": "2026-11-01",
  "termsUrl": "https://…/terms", "privacyUrl": "https://…/privacy" }
```

Source of truth: `src/config/legal.ts` (`TERMS_VERSION`, `PRIVACY_VERSION`).

### Sign-up fields (H1)

Field names match the sign-up form. Every problem comes back at once in
`error.fields`; a field the client did not send (such as `name`) is never
mentioned.

| Field | Rule | Message (`fields.<field>`) |
| --- | --- | --- |
| `email` | valid email, stored lowercase | "Enter a valid email address." · 409 "An account with this email already exists. Log in instead." |
| `username` | required; trimmed; 2–30 of letters, numbers, `.`, `_`; unique ignoring case. Public: shown to other users (chat, listings, blocks). | "Choose a username." · "Usernames are 2 to 30 letters, numbers, dots or underscores." · "That username is taken. Try another one." |
| `name` | optional, 2–80 characters; defaults to the username | "Enter your name (2 to 80 characters)." (only if sent) |
| `password` | at least 8 characters, including a number (exactly the form's rule); at most 72 bytes | "Enter a password." · "Use at least 8 characters, including a number." · "That password is too long. Use 72 characters or fewer." |
| `confirmPassword` | optional; when sent must equal `password` | "Those passwords don't match." |
| `campus` | optional; school id or name/short name from `GET /api/schools`; stored as the school id (`user.signupSchoolId`) | "Choose your school from the list." |
| `schoolId` | optional alternative to `campus` (id only) | "Choose your school from the list." |
| `acceptedTerms` | must be `true` | "Please accept the Terms and Privacy Policy to continue." |
| `acceptedTermsVersion` | must equal `termsVersion` from `GET /legal/versions`; checked only when `acceptedTerms` is `true` | "We updated our Terms. Please review them and try again." |

On success the user stores `acceptedTermsVersion`/`acceptedTermsAt` and
`acceptedPrivacyVersion`/`acceptedPrivacyAt` (one checkbox covers both).

When the terms version is the only problem the response is:

```json
{
  "error": {
    "code": "TERMS_VERSION_MISMATCH",
    "message": "We updated our Terms. Please review them and try again.",
    "fields": { "acceptedTermsVersion": "We updated our Terms. Please review them and try again." },
    "details": { "termsVersion": "2026-11-01", "privacyVersion": "2026-11-01",
                 "termsUrl": "https://…/terms", "privacyUrl": "https://…/privacy" }
  }
}
```

Show the new terms, then retry with `details.termsVersion`. If other fields
also fail, the code is `VALIDATION_FAILED` with all fields (and `details`).

The legacy top-level `message` (kept for one release) is a list of the field
messages; clients must not join it into one sentence. Use `error.fields`.

User objects never contain password hashes, token hashes or internal flags.

## 10. Moderation, reports, blocks, chat, notifications, privacy (B4)

Full rules and thresholds: [docs/moderation.md](moderation.md). Notification
copy rules: [docs/notifications.md](notifications.md).

### Listings

- Create/edit/relist can return **400 `MODERATION_REJECTED`** with the reason
  in `error.message` and `error.fields.title` (prohibited items, contact
  details in the title).
- Held listings come back with `status: "needs_review"`,
  `moderationStatus: "needs_review"`, `moderationReasons[]` and
  `moderationNote: "Under review. This usually takes under 24 hours."`. Only
  the owner sees them. `activate`/`relist` return 409 while held.
- Suspended sellers get **403 `ACCOUNT_SUSPENDED`** on create/relist.

### Reports and blocks

| Method & path | Body | Success | Errors |
| --- | --- | --- | --- |
| `POST /reports` | `targetType` (listing / user / message), `targetId`, `reason` (scam / fake_item / prohibited / spam / harassment / other), `details?` ≤ 1000 | 201 `{ id, status, message, hiddenForYou: true }`. Drop the item from the UI at once | 400 fields · 404 · 409 already reported (24 h) · 429 (20/day) |
| `POST /blocks` | `{ userId }` | 200 `{ userId, blocked: true }` (idempotent) | 400 self · 404 |
| `DELETE /blocks/:userId` | – | 204 (idempotent) | |
| `GET /blocks` | – | `{ items: [{ userId, username, firstName, avatar, blockedAt }] }` | |

Messaging or starting a chat with a blocked user (either direction): **403
`BLOCKED`**, message "You can't interact with this account."

### Chat

- Conversations: `{ id, type, participants[{ userId, lastReadAt, user }],
  otherUser, listing: { productId, title, coverImageUrl, priceAtStart },
  closed, closedAt, closedReason, createdAt, updatedAt }`. No email or phone.
- `POST /chat/conversations` with `productId` attaches the listing snapshot.
- Messages: `{ id, conversationId, senderId, sender, content, type
  (text / image / file / system), status, attachmentUrl, replyTo, product,
  safetyTip, createdAt }`. Render `system` messages as banners; show a
  safety tip when `safetyTip` is true.
- Limits: content trimmed, 1–1000 characters; 30 messages/minute; 10 new
  conversations/hour (429 with `retryAfterSeconds`). Sockets emit
  `message:error { code, error, fields?, retryAfterSeconds? }`.
- `GET /chat/conversations` items add `listing`, `closed`, `closedReason`;
  the response adds `totalUnread`. All times are ISO 8601 UTC.

### Notifications

`{ id, type, title, body, createdAt, readAt, link: { kind, id } | null }`
(+ legacy `text`, `isRead`, `metadata`). `GET /notifications?limit&cursor`,
`POST /notifications/:id/read`, `POST /notifications/read-all`.

### Privacy (needs legal review)

| Method & path | Notes |
| --- | --- |
| `GET /me/export` | JSON of your data (3/day) |
| `DELETE /me/account` | `{ "confirm": "DELETE" }`; 30-day grace, log in to cancel |
| `POST /me/consents` | `{ termsVersion?, privacyVersion? }` |

### Admin

`/api/admin/*` needs an admin user **and** `X-Admin-Key`. See docs/moderation.md §4.

## 11. Deprecations (remove after one release)

| What | Replace with |
| --- | --- |
| Error body `statusCode`, `message`, `errorCode`, `timestamp`, `path`, `method` | `error.*` (remove 2027-01-31) |
| `PATCH /products/:id/sold` | `POST /products/:id/sold` |
| `PATCH /products/:id/unavailable` | `POST /products/:id/deactivate` / `activate` |
| `isAvailable`, `isSold` on products | `status` |
| Onboarding `phoneNumber`, `universityId`, `universityName` | `phone`, `school` |
| `PATCH /users/me` `phoneNumber` | `phone` |
| Level alias `Graduate`; interest aliases from the old onboarding picker | canonical values |
| `refreshToken` in auth bodies, `POST /auth/register` | cookie, `POST /auth/signup` (remove 2027-01-31) |
| List response `data`, `page`; params `page`, `search`, `categoryId`, `universityId`, `sortBy`, `sortOrder` | `items`, `cursor`, `q`, `category`, `campus`, `sort` |
| Wishlist `data` | `items` |
| Notification `text`, `isRead`, `metadata`; `PATCH /notifications/read-all`, `PATCH /notifications/:id/read` | `body`, `readAt`, `link`; `POST` routes |
| `DELETE /users/me` (instant deactivation) | `DELETE /me/account` |

## 12. Performance, bootstrap, uploads, analytics, health (B5)

### Bootstrap (frontend F5, behind its own flag; old endpoints unchanged)

| Method & path | Auth | Returns |
| --- | --- | --- |
| `GET /api/bootstrap` | Bearer (401 → refresh and retry) | `{ user, counts: { unreadNotifications, unreadMessages }, wishlist: { productIds }, categories: [{ id, slug, name, iconUrl, count }], schools: { version, count }, flags, config: { cloudinaryCloudName, uploads }, feed: { source: "personal", items, nextCursor }, generatedAt }` |
| `GET /api/bootstrap/public` | none | same with `user`, `counts`, `wishlist` = `null` and `feed.source = "latest"`; `Cache-Control: public, max-age=30` |

- `feed.items` holds the first 12 cards; page on with `GET /api/feed?cursor=<nextCursor>`
  (logged in) or `GET /api/products?cursor=` (public). Responses stay under 50 KB.
- `schools.version` changes when the school list changes: keep the list in
  local storage and refetch `GET /api/schools` only when the version differs.
- `flags` (`bootstrap`, `signedUploads`, `analytics`, `searchSuggestions`) come
  from defaults overridden by the `FEATURE_FLAGS` env var (JSON).

### Signed direct uploads (photos never pass through the API)

1. `POST /api/uploads/sign` `{ kind?: "product" | "avatar" | "chat", count?: 1..5 }` →
   `{ uploads: [{ uploadId, publicId, uploadUrl, fields, expiresAt }], maxBytes, formats }`.
2. **Check `file.size <= maxBytes` (3 MB) on the phone first**, then
   `POST uploadUrl` as `multipart/form-data` with `file` plus **every** key in
   `fields`, unchanged (they are signed; changing one makes Cloudinary refuse).
3. `POST /api/uploads/complete` `{ uploadId, publicId, version, signature }`
   using `public_id`, `version`, `signature` from Cloudinary's response →
   `{ id, publicId, version, url, width, height, size, responsive: { thumb, card, full } }`.
4. Put `url` in the listing's `images` as before.

Over 3 MB → `400 VALIDATION_FAILED`, `fields.image = "This photo is over 3 MB…"`
(the legacy multipart routes answer `413` with the same shape). Cards and
items now include `publicId` and `version` per image; build responsive URLs as
`https://res.cloudinary.com/<cloud>/image/upload/f_auto,q_auto,c_limit,w_<n>/v<version>/<publicId>`
(`config.cloudinaryCloudName` in bootstrap). `imageUrl` is unchanged.

### Product analytics

`POST /api/events` `{ events: [{ name, ts, anonId, props }] }` (or a bare
array), at most 20 per call, optional Bearer token → **204** immediately.

- `name` is one of: landing_view, signup_start, signup_complete,
  onboarding_step_view, onboarding_step_complete, onboarding_error, feed_view,
  search, search_zero_results, filter_change, item_view, message_start,
  wishlist_add, sell_open, photo_added, post_error, post_success, report_open,
  report_submit, block_user, share_click.
- `props` keys: screen, source, referrer, section, position, page, variant,
  step, field, errorCode, method, itemId, productId, sellerId, category,
  condition, campusId, sort, filter, value, query, resultCount, priceBucket,
  photoCount, hasDidYouMean, reason, targetType, channel, durationMs, network.
  Values: text up to 60 characters, numbers, true/false, null.
- `400 VALIDATION_FAILED` (whole batch) for unknown names or keys, emails,
  phone numbers, long text, nested values, timestamps older than 7 days.
- `anonId`: random id the client generates once and keeps (8–64 of
  `A-Z a-z 0-9 - _`). Never derive it from the user, device or email.
- Dropped silently (still 204) with `DNT: 1` / `Sec-GPC: 1`, or when the user
  turned off **Share usage data** (`PATCH /api/users/me { "shareUsageData": false }`;
  default on; returned on `/auth/me`).

### Health, caching, limits, timing

| What | Contract |
| --- | --- |
| `GET /health` | liveness, no I/O (outside `/api`) |
| `GET /health/ready` | `200` when the database answers within 2 s, `503` otherwise or while shutting down |
| Cache-Control | public anonymous GETs (`/products`, `/products/:id`, `/products/:id/similar`, `/categories`, `/schools`, `/search/suggest`, `/bootstrap/public`): `public, max-age=…, stale-while-revalidate=…` + ETag (send `If-None-Match` for a `304`). Everything else and every logged-in response: `private, no-store`. Errors: `no-store`. |
| Rate limits | every route: 120 requests/min per client (IP + token); auth 30, uploads 30, events 60, reports 10, messages 40. Over the limit: `429 RATE_LIMITED` + `Retry-After`. Login/reset limits from B2 still apply on top. Headers `X-RateLimit-Limit` / `-Remaining`. |
| Timeouts | 15 s per request → `504` `{ error: { code: "TIMEOUT" } }` |
| Server-Timing | outside production: `db;dur=…;desc="N queries", app;dur=…, total;dur=…` (visible in DevTools → Network → Timing) |
| Admin | `GET /api/admin/metrics` (per-route p50/p95/p99, pool, cache), `POST /api/admin/uploads/cleanup?dryRun=true`, `POST /api/admin/alerts/test` |
