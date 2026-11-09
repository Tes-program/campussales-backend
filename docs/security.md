# Security (B2: auth and tokens)

## Sessions

| Piece | Where it lives | Lifetime |
| --- | --- | --- |
| Access token (JWT, HS256) | JSON response body only. The frontend keeps it **in memory** (not localStorage). | 15 minutes |
| Refresh token (32 random bytes) | `cs_refresh` cookie: `HttpOnly; Secure; SameSite=Lax; Path=/api/auth` | 30 days, rotated on every use |

- Only the SHA-256 of a refresh token is stored (`refresh_tokens.tokenHash`).
- Every `POST /api/auth/refresh` exchanges the cookie for a new one in the
  same **family**. Presenting an already-rotated token is treated as theft:
  the whole family is revoked and the user must log in again. A 10-second
  grace window avoids logging people out when two tabs refresh at once.
- `POST /api/auth/logout` revokes the family and clears the cookie (works
  with an expired access token). `POST /api/auth/logout-all` revokes every
  family and, through `users.tokensValidAfter`, every live access token.
- Changing or resetting the password revokes all other sessions, rejects
  access tokens issued before the change, and emails the user.

### Cross-site deployment: read this before going live

`SameSite=Lax` cookies are **not sent** on cross-site `fetch`/XHR. Today the
frontend (`campus-sales.onrender.com`) and the API (Railway) are on different
sites, so with `Lax` the browser will not send the refresh cookie and every
refresh will return 401. Choose one:

1. **Recommended:** serve both from one registrable domain (for example
   `campussales.ng` and `api.campussales.ng`). `Lax` then works, and you can
   set `AUTH_COOKIE_DOMAIN` if needed.
2. Keep separate domains and set `AUTH_COOKIE_SAMESITE=none` (forces
   `Secure`). This is weaker against CSRF. The refresh endpoint only issues
   tokens to the JSON response (readable only by allowed CORS origins), which
   limits the damage.

Until then, `AUTH_LEGACY_TOKENS=true` keeps the deployed frontend working
with body tokens.

### Legacy mode (`AUTH_LEGACY_TOKENS=true`)

For one release, so the deployed frontend keeps working while it migrates:

- `refreshToken` is also returned in the JSON body of signup, login and refresh;
- `POST /auth/refresh` and `POST /auth/logout` accept `{ refreshToken }` in the body;
- `POST /auth/register` accepts a body without the terms fields.

**Removal date: 2027-01-31.** After that, unset the variable and delete the
legacy branches (`legacyTokensEnabled` call sites, `LegacyRegisterDto`).

Sessions created before B2 (JWT refresh tokens) keep working: they are found
by hash and treated as their own family.

## Passwords

One rule (`src/auth/password-policy.ts`) at sign-up, reset and change. It
is exactly the rule the frontend form shows, with the same text:

- at least 8 characters, including a number
  ("Use at least 8 characters, including a number.");
- at most 72 bytes (the bcrypt limit; a technical bound, not a strength rule).

H1 removed the B2 extras (a letter required, the common-password list, no
email/name in the password). The form never showed them, so students were
rejected without knowing why. If the rule is tightened again, change the
server and the form checklist in the same release.

Hashing: bcrypt, cost 12 (already in use). Hashes below cost 12 are upgraded
on the next successful login.

## Login protection

- Failure message is always "Email or password is incorrect."
  (`INVALID_CREDENTIALS`), with the same bcrypt work for unknown emails.
- 5 failures per account or 20 per IP in 15 minutes, then **progressive
  delays** (30 s, 60 s, 120 s ... capped at 15 min) returned as 429 with
  `retryAfterSeconds` and `Retry-After`. There is no permanent lock-out, so a
  bully can only slow an account down, not lock its owner out for good.
- Counters live in Redis (hashed keys, no emails or IPs in clear text). If
  Redis is down, limits fall back to per-instance memory.
- `TRUST_PROXY` defaults to `1` in production so the limits see the
  student's IP rather than Railway's proxy.

## Sign-up decisions

- **Existing email → 409** "An account with this email already exists. Log
  in instead." We accepted this enumeration trade-off because sign-up logs
  the user in immediately, so a neutral flow would need email-first
  activation. Mitigation: 10 sign-ups per IP per hour.
- Clients can no longer choose `userType` (previously anyone could register
  as `admin`). Every new account is a student.
- `acceptedTerms` must be `true`, and `acceptedTermsVersion` must equal
  `TERMS_VERSION` in `src/config/legal.ts` (served by `GET /api/legal/versions`);
  otherwise 400 `TERMS_VERSION_MISMATCH` with the current versions. The terms
  and privacy versions and timestamps are stored on the user.
- `username` is the public name and is unique ignoring case (checked in code,
  plus the `UQ_users_username_lower` index from the H1 migration). `name` is
  optional and defaults to the username.
- There are no social login endpoints (no Google or Apple code existed), so
  nothing was removed. Tests assert these routes return 404.

## Email verification

A link is emailed at sign-up (`{FRONTEND_URL}/verify-email?token=…`, valid
24 h). Unverified users can use the app for 24 hours (`users.verifyBy`).
After that, creating listings, relisting, publishing drafts, starting chats
and sending messages return 403 `EMAIL_NOT_VERIFIED`; reading still works.
`POST /auth/resend-verification` is limited to 3 per hour. Accounts created
before B2 have no deadline (`verifyBy = null`). Decide whether to give them
one later.

## Password reset links

- `{FRONTEND_URL}/reset-password?token=<token>`. `FRONTEND_URL` must be
  `https://campus-sales.onrender.com` on Railway. **Production startup fails**
  if it is missing, not https, or has a path. I could not check the Railway
  dashboard; please confirm the variable there.
- 32 random bytes, stored hashed, 30-minute expiry, single use. Issuing a new
  link, or any password change, invalidates older links.
- `POST /auth/forgot-password` always answers 200 with "If that email has an
  account, we've sent a link." 3 per hour per email and 20 per hour per IP are
  enforced silently. The email goes out in the background so timing reveals
  nothing.
- `POST /auth/reset-password` returns `TOKEN_INVALID` (unknown, used or
  superseded), `TOKEN_EXPIRED`, or `fields.newPassword`.
- Template: plain, one brand colour, one button, the expiry time, "If you
  didn't ask for this, ignore this email", direct link only (no tracking
  redirects, no images). Names are HTML-escaped. Delivery failures are logged
  with a masked address and the error code, never the link.
- **Frontend hosting:** `/reset-password` and `/verify-email` are client
  routes. The static host needs a catch-all rewrite to `index.html` so a
  freshly opened link doesn't 404. On Render: Static Site → Redirects/Rewrites
  → add `/*` → `/index.html`, action **Rewrite**.

## Data leaving the API

- A global interceptor strips any key containing `password`, plus
  `tokenHash` and `tokensValidAfter`, from every response at any depth. An
  integration test calls the user, product, wishlist, chat and notification
  endpoints and fails if any key matches `/password|tokenHash/` or any value
  looks like a bcrypt hash.
- Passwords, tokens and links are never logged. The request logger already
  redacted password and token fields; the old simulated-email path that
  printed the reset URL was removed.

## HTTP hardening

- CORS: only the origins in `CORS_ORIGIN` (set it to
  `https://campus-sales.onrender.com` in production), plus localhost dev
  servers outside production. `credentials: true`.
- Helmet (already enabled) sets HSTS, `X-Content-Type-Options`,
  `X-Frame-Options`, `Referrer-Policy` and more on API responses.
- Auth responses send `Cache-Control: no-store`.

### Suggested Content Security Policy for the frontend

Set as a response header on the static host (Render → Headers):

```
Content-Security-Policy:
  default-src 'self';
  script-src 'self';
  style-src 'self' 'unsafe-inline';
  img-src 'self' data: https://res.cloudinary.com;
  font-src 'self' data:;
  connect-src 'self' https://<api-host> wss://<api-host>;
  frame-ancestors 'none';
  base-uri 'self';
  form-action 'self';
  object-src 'none';
  upgrade-insecure-requests
```

Start with `Content-Security-Policy-Report-Only` for a week, then enforce.
Drop `'unsafe-inline'` from `style-src` if the build no longer injects inline
styles.

## Environment variables

| Variable | Required | Notes |
| --- | --- | --- |
| `FRONTEND_URL` | production | `https://campus-sales.onrender.com` |
| `JWT_SECRET` | production | ≥ 32 characters recommended |
| `CORS_ORIGIN` | production | comma-separated origins |
| `AUTH_LEGACY_TOKENS` | until 2027-01-31 | `true` while the old frontend is live |
| `AUTH_COOKIE_SAMESITE` | optional | `lax` (default) / `none` (see above) |
| `AUTH_COOKIE_DOMAIN` | optional | e.g. `.campussales.ng` |
| `AUTH_COOKIE_SECURE` | optional | never `false` in production (startup fails) |
| `TRUST_PROXY` | optional | defaults to `1` in production |
| `RATE_LIMIT_STORE` | optional | `memory` to skip Redis |
