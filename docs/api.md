# CampusSales API contract

Base URL: `/api`. JSON in, JSON out. Authenticated routes need
`Authorization: Bearer <accessToken>`.

This file is the contract the frontend builds against. It covers the endpoints
changed in **B1 (validation and data integrity)**. Interactive docs for every
route are at `/api/docs` (Swagger).

---

## 1. Errors

Every non-2xx response has this body:

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

These legacy fields will be removed in the release after B2. See section 8.

---

## 2. Listings (products)

### Field rules

Used by `POST /products`, `PATCH /products/:id`, `POST /products/:id/relist`
and draft publishing. All rules come from
`src/common/validation/rules.ts`.

| Field | Type | Rule | Messages (`fields.<name>`) |
| --- | --- | --- | --- |
| `title` | string | Required on create. Trimmed. 3–80 characters (emoji/accents count as one). No control or invisible formatting characters (tabs, newlines, zero-width space, RTL override…). | "Enter a title for your item." · "Title must be at least 3 characters." · "Title must be 80 characters or fewer." · "Title contains characters we can’t display. Please retype it." |
| `description` | string | Optional. Trimmed. ≤ 600 characters. Newlines and tabs allowed. `null` on PATCH clears it. | "Description must be 600 characters or fewer." |
| `price` | integer | Required on create. **Whole naira**, 50–100,000,000. Numeric strings like `"2500"` are accepted; `0`, negatives, decimals, `"abc"`, booleans are rejected. | "Enter a price." · "Price must be a number, like 2500." · "Price must be a whole number of naira (no kobo)." · "Price must be at least ₦50." · "Price can’t be more than ₦100,000,000." |
| `quantity` | integer | Optional, default 1. 1–999. | "Quantity must be at least 1." · "Quantity can’t be more than 999." · "Quantity must be a whole number." |
| `category` | string | Slug from the shared list (below). Names and old slugs are accepted and normalised. Send this **or** `categoryId`; one is required on create. | "Choose a category." · "Choose a category from the list." |
| `categoryId` | uuid | Legacy alternative to `category`. Must be an active category in the shared list. | "Choose a category from the list." |
| `condition` | string | `new`, `like_new`, `used`, `fair`. UI labels `New`, `Like New`, `Used`, `Fair` are accepted (any case). Responses use the stored values. | "Choose the item’s condition." · "Condition must be New, Like New, Used or Fair." |
| `images` | string[] | Required on create. 1–5 unique URLs of the form `https://res.cloudinary.com/<our cloud name>/…`. Other hosts are rejected. (Local development with `STORAGE_TYPE=local` also accepts `<BACKEND_URL>/uploads/…`.) First image is the cover. | "Add at least one photo." · "You can add up to 5 photos." · "Photos must be uploaded through CampusSales." · "Each photo can only be added once." |
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

| Field | Rule | Messages |
| --- | --- | --- |
| `firstName`, `lastName` | Required, trimmed, 2–50 characters. | "First name must be 2 to 50 characters." / "Last name …" |
| `phone` (alias: `phoneNumber`) | Required. Nigerian mobile: `0XXXXXXXXXX` (11 digits starting 070, 080, 081, 090, 091), `+234XXXXXXXXXX` or `234XXXXXXXXXX`. Spaces, dashes, dots and brackets are ignored. **Saved as `+234XXXXXXXXXX`.** Errors are reported under `fields.phone` even when `phoneNumber` was sent. | "Enter your phone number." · "Enter a valid Nigerian phone number, like 0803 123 4567." |
| `school` (alias: `universityId`) | Required. A school `id` from `GET /schools`, or its exact name / short name (case-insensitive). Never fuzzy-matched. | "Choose your school." · "Choose your school from the list." |
| `level` | Required. `100`, `200`, `300`, `400`, `500`, `600`, `Postgraduate`, `Alumnus`. Also accepts `300L`, `300 Level`, numbers, any case. `Graduate` is read as `Alumnus`. | "Choose your level." · "Level must be 100 to 600, Postgraduate or Alumnus." |
| `gender` | Optional. `Male`, `Female`, `Prefer not to say` (any case; `prefer_not_to_say` ok). | "Gender must be Male, Female or Prefer not to say." |
| `interests` | Optional. 0–8 category slugs (aliases accepted and normalised, duplicates removed). | "You can pick up to 8 interests." · "Pick interests from the categories list." |
| `dateOfBirth`, `bio` (≤ 500), `profilePictureUrl` | Optional, unchanged. | |
| `universityName` | Accepted and ignored: the canonical school name is stored. | |

Responses:

- **200**: the user (no `passwordHash`) with `phoneNumber` in +234 form,
  `profile` (including `level`, `universityId`, canonical `universityName`)
  and `school: { id, name, shortName, city }`.
- **400** `VALIDATION_FAILED` with `fields`.
- **409** `CONFLICT` with `fields.phone`: "That number is already used on another account."

Idempotent: sending the same data again returns 200 and changes nothing.

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

## 8. Deprecations (remove after one release)

| What | Replace with |
| --- | --- |
| Error body `statusCode`, `message`, `errorCode`, `timestamp`, `path`, `method` | `error.*` |
| `PATCH /products/:id/sold` | `POST /products/:id/sold` |
| `PATCH /products/:id/unavailable` | `POST /products/:id/deactivate` / `activate` |
| `isAvailable`, `isSold` on products | `status` |
| Onboarding `phoneNumber`, `universityId`, `universityName` | `phone`, `school` |
| `PATCH /users/me` `phoneNumber` | `phone` |
| Level alias `Graduate`; interest aliases from the old onboarding picker | canonical values |
