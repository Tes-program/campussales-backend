# Chat (C1): real-time, reliable

> The exact request/response shapes, error codes and event names live in
> **[chat-contract.md](chat-contract.md)**, which the frontend builds against. This file explains the design and operations.

All paths are under `/api`, and every route needs `Authorization: Bearer <access token>`.
Times are ISO 8601 UTC. Errors use the standard `{ error: { code, message, fields?, retryAfterSeconds? } }` shape.
Chat payloads never include an email address or phone number.

## 1. Model

- **One conversation per (buyer, seller, product).** There is also one general conversation per pair of people for chats with no product.
  The key is the sorted user pair plus the product, enforced by the unique index `UQ_conversations_pair_product`.
  `POST /chat/conversations` is find-or-create and safe to call in parallel.
- **`seq`:** every message gets a per-conversation sequence number: 1, 2, 3, and so on.
  Seq numbers are assigned under the conversation row lock, so commit order equals seq order. Clients order by `seq` and resume by `seq`.
- **Receipts and unread counts are stored per participant:** `lastReadSeq`, `lastDeliveredSeq` and `unreadCount`.
  The count goes up by one on each send and is recomputed on read, so counts never need a scan.
  Message `status` is derived from those pointers: `sent`, `delivered` or `read`.

## 2. REST

| Method & path | Body / query | Response |
| --- | --- | --- |
| `POST /chat/conversations` | `{ participantId, productId? }` | 201 when created, 200 when it already existed. Returns a conversation item. When `productId` is set, one of the two people must be the seller. |
| `GET /chat/conversations` | `?limit=20&cursor=&filter=all\|unread&archived=true\|false` | `{ items, nextCursor, totalUnread }`. Sorted by last message; pass `nextCursor` back as `cursor`. |
| `GET /chat/conversations/:id` | | One conversation item. |
| `PATCH /chat/conversations/:id` | `{ archived?, muted? }` | Item. A new message moves an archived chat back to the inbox. Muted chats send no push or email. |
| `DELETE /chat/conversations/:id` | | 204. Deletes the chat **for you only**: earlier messages are hidden from you, and the chat comes back on the next message. |
| `GET /chat/conversations/:id/messages` | `?limit=30&beforeSeq=` | `{ items (newest last), hasMore, nextCursor (pass as beforeSeq), lastSeq, lastReadSeq, otherReadSeq, otherDeliveredSeq }`. Loading the thread marks everything delivered. |
| `GET /chat/conversations/:id/messages` | `?afterSeq=<last seen>&limit=100` | **Resume:** missed messages, oldest first. While `hasMore` is true, call again with `afterSeq=nextAfterSeq`. |
| `POST /chat/conversations/:id/messages` | `{ clientMessageId, text, attachments?: [{ url }] }` | 201 with the saved message. A repeat of the same `clientMessageId` returns **200 with the original message**. |
| `POST /chat/conversations/:id/read` | `{ upToSeq? }` (default: everything) | `{ conversationId, lastReadSeq, unreadCount, totalUnread }`. Idempotent and never moves backwards. |
| `GET /chat/unread` | | `{ total, conversations: [{ conversationId, unreadCount }] }`. Answered from the stored counters in one query. |
| `DELETE /chat/conversations/:id/messages/:messageId` | `?for=me\|everyone` | `me`: hides the message for you. `everyone`: your own message, within 10 minutes; everyone then sees "Message deleted". |
| `POST /chat/conversations/:id/messages/:messageId/report` | `{ reason, details? }` | Goes into the B4 reports queue. |
| `GET` / `PATCH /chat/settings` | `{ showPresence }` | Whether people you chat with can see when you are online or last active. |
| `GET /chat/conversations/find` | `?participantId=&productId=` | Item, or 404 if you haven't chatted yet. |

Deprecated (kept for one release): `PATCH …/read` (use `POST`), `GET /chat/conversations/unread-count`, the `page` query parameter, and request fields `content`, `attachmentUrl`, `type` and `productId`.

### Conversation item

```json
{
  "id": "uuid",
  "participant": { "id": "uuid", "username": "kemi_o", "name": "Kemi Ola", "avatar": null,
                   "lastActiveAt": "…Z | null", "online": true },
  "product": { "id": "uuid", "title": "Desk lamp", "cover": "https://…", "price": 5000,
               "status": "active | sold | inactive | needs_review | deleted" },
  "lastMessage": { "id": "uuid", "seq": 12, "text": "Is it available?", "type": "text",
                   "senderId": "uuid", "hasAttachments": false, "deleted": false, "createdAt": "…Z" },
  "unreadCount": 2, "lastSeq": 12, "lastReadSeq": 10, "otherReadSeq": 12, "otherDeliveredSeq": 12,
  "archived": false, "muted": false, "closed": false, "closedReason": null,
  "updatedAt": "…Z (last message, or creation)", "createdAt": "…Z"
}
```

- Show `updatedAt` (or `lastMessage.createdAt`) as "5 min ago". **Never** label it "Posted …".
- `lastActiveAt` and `online` are `null` when that person has turned presence off.
- `product` is `null` for the general chat.
- `title` and `price` are current values; `cover` is the snapshot taken when the chat started.
- `type`, `otherUser` and `listing` are legacy fields, kept for one release.

### Message

```json
{
  "id": "uuid", "conversationId": "uuid", "seq": 12, "clientMessageId": "…",
  "senderId": "uuid", "type": "text | image | system",
  "text": "trimmed text, or null when deleted",
  "attachments": [{ "url": "https://res.cloudinary.com/…/f_auto,q_auto/…",
                    "thumbUrl": "…/f_auto,q_auto,c_limit,w_400/…", "width": 800, "height": 600 }],
  "status": "sent | delivered | read", "deleted": false, "deletedForMe": false,
  "safetyTip": false, "createdAt": "…Z"
}
```

- `system` messages are banners, for example "This item has been sold".
- When `safetyTip` is true, show the scam safety tip. Flags never block a message.
- Legacy fields kept for one release: `content` ("Message deleted" once deleted), `attachmentUrl`, `sender`, `replyToId`, `replyTo`, `productId` and `product`.

### Send rules and error codes

- `text` is trimmed and must be 1–1000 characters. It may be empty only when photos are attached.
- Send at most 4 photos per message.
- Sending is idempotent on `(conversationId, sender, clientMessageId)`. Generate one UUID per message and reuse it on every retry.

| Code | HTTP | When |
| --- | --- | --- |
| `TOO_LONG` | 400 | Over 1000 characters (`fields.text`). |
| `VALIDATION_FAILED` | 400 | Empty message, bad photo, or bad `clientMessageId`. |
| `CONVERSATION_NOT_FOUND` | 404 | No such chat, or you are not in it. |
| `BLOCKED` | 403 | Either person has blocked the other. |
| `FORBIDDEN` | 403 | Deleting someone else's message for everyone, or deleting after 10 minutes. |
| `RATE_LIMITED` | 429 | More than 30 messages a minute, or 10 new conversations an hour (`retryAfterSeconds`). Retries of an already-saved message are never rate limited. |

### Photos

1. Call `POST /api/uploads/sign` with `{ kind: "chat" }`. Chat photos are restricted to JPEG, PNG or WebP, up to 3 MB, in the `campussales/chat/` folder.
2. Upload the file to Cloudinary.
3. Call `POST /api/uploads/complete`.
4. Send `attachments: [{ url }]`.

The server only accepts uploads that the sender completed in our cloud.
It returns `f_auto,q_auto` delivery URLs plus a 400 px thumbnail.
Metadata (EXIF and GPS) is stripped: the incoming transformation re-encodes the stored original, and every delivery URL is transformed again.

## 3. Socket.IO

Connect with `io(API_URL + "/chat", { auth: (cb) => cb({ token: latestAccessToken() }), transports: ["websocket"] })`.
The callback form makes every reconnect send the newest token.

Auth is **recoverable**. A missing, invalid or expired token (at connect, or when a live token expires) never closes the socket straight away:
- The server emits `auth:expired { reason, graceMs }` and keeps the connection open for 30 s (`CHAT_AUTH_GRACE_MS`). Other events are refused with `UNAUTHENTICATED` meanwhile.
- `auth:refresh { token }` continues the session.
- Without a valid token in time, the server emits `auth:failed` and disconnects.

On connect, the server emits `connected { userId, serverTime, heartbeatMs }`. Socket.IO pings every 25 s, and `heartbeat` (acked with `serverTime`) is available for clock sync.
Details are in chat-contract.md §2.

Every socket joins the private room `user:<id>`. Every client → server event is acked with `{ ok: true, data }` or `{ ok: false, error: { code, message, … } }`.

| Client → server | Body | Ack data |
| --- | --- | --- |
| `message:send` | `{ conversationId, clientMessageId, text, attachments? }` | `{ message, created }` |
| `message:delivered` | `{ conversationId, seq }` | `null` |
| `message:read` | `{ conversationId, upToSeq? }` | Same as `POST …/read` |
| `typing` | `{ conversationId, isTyping }`. Send about every 3 s while typing. | `null` |
| `presence:subscribe` | `{ userIds }` (up to 100) | `[{ userId, online, lastActiveAt }]`. Only for people you chat with who allow presence. |
| `presence:unsubscribe` | `{ userIds }` | `null` |
| `heartbeat` | | `{ serverTime }` |

| Server → client | Payload |
| --- | --- |
| `message:new` | Message. **Ack it** (callback): the ack marks it delivered. Dedupe by `id` or `clientMessageId`, because the sender's own devices receive it too. |
| `message:status` | `{ conversationId, upToSeq, status: "delivered" \| "read", userId }`: everything up to `upToSeq` from you. |
| `message:updated` | Message, for example deleted for everyone. |
| `conversation:updated` | `{ id, lastSeq, unreadCount, updatedAt, lastMessage }`. Merge into the list. |
| `unread:update` | `{ conversationId, unreadCount, total }` |
| `typing` | `{ conversationId, userId, isTyping, expiresInMs }`. Typing expires after 5 s. |
| `presence` | `{ userId, online, lastActiveAt }`. Offline is announced after a 5 s grace period, so reconnects don't flicker. |

**Reconnect and resume.**
1. Keep the highest `seq` you have seen per open conversation.
2. On `connect`, call `GET …/messages?afterSeq=<that seq>` and repeat while `hasMore`.
3. Refresh the list with `GET /chat/conversations`.

Nothing is lost while the socket is down, because messages are stored before they are emitted.

**Delivery.** The server saves the message and acks the sender. It then emits `message:new` to the recipient's devices and waits up to 10 s for an ack.
- **Ack received:** the message is marked delivered, and the sender gets `message:status`.
- **No ack, or no devices:** the recipient counts as offline (see §4).

**More than one instance.** `main.ts` installs the Redis adapter (`@socket.io/redis-adapter`) when `REDIS_HOST` is reachable. Rooms, acks and `fetchSockets` then work across instances.
A **single instance needs no adapter**: the app falls back to the in-memory adapter and logs a warning.
Typing and presence state is in memory per instance. Presence queries fall back to the adapter (`fetchSockets`), so they stay correct across instances.

## 4. Offline notifications

When a recipient doesn't ack a message (no connected device):

1. **In-app notification.** There is one per conversation while it is unread; later messages update it in place instead of adding rows.
   The preview follows the B4 copy rules. Anything that looks like payment details or a link becomes "Sent you a message": flagged messages, URLs, domains, and numbers of 9 or more digits. Photos read "Sent a photo".
2. **Web Push**, when `CHAT_WEB_PUSH=true` and the VAPID keys are set.
   The body is "New message from <first name>" and the payload carries the in-app path `/chat/<id>`. It never contains message text.
   Endpoints: `GET /api/notifications/push/public-key`, `POST /api/notifications/push/subscriptions` (the browser's `PushSubscription.toJSON()`), and `POST /api/notifications/push/subscriptions/remove { endpoint }`.
3. **Email digest**, when `CHAT_EMAIL_DIGEST=true`. It says who wrote and links to `FRONTEND_URL/chat/<id>`. It never contains message text.

Push and email are each sent **at most once per conversation per recipient every 15 minutes**. Muted chats and system messages never trigger either.

## 5. Safety (reuses B4)

- Every send is block-checked inside the same query that loads the conversation.
- Rate limits: 30 messages a minute, shared by REST and sockets, and 10 new conversations an hour.
- Scam signals (`account_number`, `payment_request`, `external_link`) are stored on the message as `flags`.
  They never block a message; they surface a safety tip, and repeat senders go to the admin review queue.
- Reports: `POST …/messages/:messageId/report`.
- When an item is sold, deleted or removed, its chats close and get a `system` message, delivered in real time.

## 6. Performance

Indexes:
- `messages ("conversationId", seq DESC)` (unique), used for history, resume and the list's last message.
- `messages ("conversationId", "senderId", "clientMessageId")` (unique, partial), used for idempotency.
- `conversation_participants ("userId", "lastMessageAt" DESC, "conversationId" DESC)`, used for the list.
- The unique pair + product index.

What each operation costs:
- **List:** one query, with no N+1. The last message comes from a LATERAL lookup on the seq index.
- **Send:** one statement that bumps `lastSeq`, inserts the message and updates both participant rows. Around it are one context query (participant, block, profiles) and the rate-limit check.
- **Compression:** HTTP responses over 1 KB are compressed. Socket per-message deflate is off, because the payloads are small.

Measured locally (PG 14, Redis adapter on, `scripts/chat-load-test.js`, 200 sockets, 50 messages/s for 30 s):
- 1500 of 1500 messages delivered, with 0 lost and 0 errors.
- Send ack p50 9 ms, p95 12 ms, p99 21 ms.
- Delivery from send to the other client's `message:new`: p50 9 ms, p95 12 ms, p99 21 ms.
- `GET /chat/conversations` took about 15 ms server-side (4 queries). `GET …/messages` took about 12 ms (4 queries).
- In the e2e suite, a REST send takes 6–16 ms server-side.

Targets were send ack under 300 ms, list and messages under 200 ms, and delivery under 100 ms. Production adds the API ↔ database round trip to each query; keep both in the same region (docs/infra.md).

Re-run with `npm run chat:load-test -- --url=http://localhost:3000 --sockets=200 --rate=50 --seconds=30`. It only runs against a local database.

## 7. Observability

- **Logs:** every send logs one `chat.send` line (or `chat.send failed` with the error `code`). Each line carries the request id (socket sends get their own), the hashed user id, the conversation id, `seq` and `durationMs`.
  Message text is **never** logged, and failed SQL is logged without its parameters.
- **Metrics:** `GET /api/admin/metrics` → `chat` reports, per instance over the last 15 minutes:
  - messages sent, send failures and failure rate
  - refusals by error code
  - send ms and delivery ms (p50 and p95)
  - sockets connected, plus connects, reconnects and disconnects
- **Alert:** `chat_send_failures` fires when more than 2% of sends fail with server errors over 5 minutes (minimum 50 sends). Refusals such as `BLOCKED` and `RATE_LIMITED` don't count as failures.

## 8. Duplicate conversations: merge runbook

1. Run `npm run chat:merge-duplicates` (dry run). It lists the groups, the conversations to merge and the message counts.
2. Take a database backup.
3. Run `npm run chat:merge-duplicates -- --apply`. Non-local hosts also need `--confirm-host=<host>`.

What the merge does:
- Keeps the oldest conversation of each (pair, product) group.
- Moves every message into it; message ids are unchanged, so reports and replies still work.
- Renumbers `seq` by time and carries read and delivery receipts over per message.
- Repoints notifications to the kept conversation.
- Removes the emptied duplicate rows only after checking they hold no messages. **No message is ever deleted.**
- Creates the unique index, so duplicates can't come back, and writes `scripts/out/merge-conversations-<ts>/merges.csv`.

If the migration finds duplicates, it skips the unique index with a warning; the merge script then creates it.

## 9. Privacy, retention and export (for legal review)

- **Payloads:** chat payloads expose `id`, `username`, name and avatar only, never an email address or phone number.
  Logs use hashed user ids and never contain message text.
- **Presence** is on by default and can be turned off (`PATCH /chat/settings { showPresence: false }`).
  When off, nobody sees your `online` or `lastActiveAt` status.
  *Legal: decide whether this should be opt-in (default off) under NDPR consent rules.*
- **Delete for me** hides the message for one person only. **Delete for everyone** (sender, within 10 minutes) hides the text from both people, but the row and its text **are kept in the database** so reports about it can still be reviewed.
  **Delete chat** hides the history from one person only. **Proposed retention, needing a legal decision:**
  - purge the text of deleted-for-everyone messages after 30 days unless a report is open;
  - keep other messages for as long as both accounts exist;
  - when an account is deleted (after the 30-day grace), its messages are deleted with it (cascade).
  - Today, nothing is purged automatically except account deletion.
- **Export:** `GET /api/me/export` includes every message the person sent (`id`, `conversationId`, `seq`, `content`, `type`, `attachments`, `createdAt`, `deletedAt`). It excludes messages they received, which are the other person's data.
  *Legal: confirm that received messages should stay out of the export.*
- **Photos** sent in chat are never cleaned up by the orphan job, and their metadata is stripped (§2).
- **Moderation access:** admins see reported messages through the reports queue only.

## 10. Out of scope: end-to-end encryption options

E2EE is out of scope for C1. These options are proposed for the PR discussion:

1. **Signal protocol (libsignal; Double Ratchet with X3DH).** This is the gold standard, with forward secrecy and multi-device support through per-device sessions.
   - Cost: key distribution endpoints (prekey bundles), device management, and a web client that must store keys in IndexedDB.
   - Tradeoff: the server can no longer scan for scams, show previews, or support reports without the reporter re-uploading the plaintext.
2. **MLS (RFC 9420).** This standard is designed for groups and multi-device use, with less mature JavaScript libraries.
   It is a better fit if group chats arrive later.
3. **Encryption at rest only** (column-level with KMS-managed keys). This is not E2EE, but it protects against database dump leaks while keeping safety features.
   It is the recommended next step for a marketplace where scam detection and reports matter.

Recommendation: do option 3 now. Revisit option 1 only if users ask for private chats, and pair it with client-side scam warnings and "report with evidence" (the reporter shares the decrypted messages).
