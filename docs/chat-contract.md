# Chat contract (C1)

**The frontend builds against this file.** Any change to a shape, code or event name here needs a PR that updates this file first.
Background and operations: [chat.md](chat.md).

Conventions:
- **Base and auth:** REST lives under `/api`, with `Authorization: Bearer <accessToken>`. Sockets use the Socket.IO namespace `/chat` on the same host.
- **Ids and times:** ids are UUIDs. Times are ISO 8601 UTC with milliseconds (`2026-11-10T11:10:16.821Z`).
- **Strings:** enum values (`type`, `status`, error `code`) are always lowercase in responses, except error codes, which are UPPER_SNAKE.
- **Sequence numbers:** `seq` is a per-conversation integer starting at 1 and strictly increasing. Order by `seq`, never by time.
- **Privacy:** no payload ever contains an email address or phone number.

---

## 1. Shapes

### Message

```ts
type Message = {
  id: string;
  conversationId: string;
  seq: number;
  clientMessageId: string | null;      // what the sender sent; null for old clients and system messages
  senderId: string;
  type: 'text' | 'image' | 'system';
  text: string | null;                 // null when deleted or deletedForMe
  attachments: Array<{ url: string; thumbUrl: string; width?: number; height?: number }>;
  status: 'sent' | 'delivered' | 'read'; // from the viewer's point of view
  deleted: boolean;                    // sender deleted it for everyone: show "Message deleted"
  deletedForMe: boolean;               // the viewer hid it
  safetyTip: boolean;                  // show the scam safety tip
  createdAt: string;
  // legacy, removed after one release: content, attachmentUrl, sender, replyToId, replyTo, productId, product
};
```

### Conversation item (list, get, create)

```ts
type Conversation = {
  id: string;
  participant: { id: string; username: string; name: string | null; avatar: string | null;
                 lastActiveAt: string | null; online: boolean | null } | null; // null presence = hidden by that user
  product: { id: string; title: string; cover: string | null; price: number;
             status: 'active' | 'inactive' | 'sold' | 'needs_review' | 'deleted' } | null;
  lastMessage: { id: string; seq: number; text: string | null; type: 'text' | 'image' | 'system';
                 senderId: string; hasAttachments: boolean; deleted: boolean; createdAt: string } | null;
  unreadCount: number;
  lastSeq: number;
  lastReadSeq: number;        // the viewer's read pointer
  otherReadSeq: number;       // the other person's read pointer (your messages <= it are "read")
  otherDeliveredSeq: number;
  archived: boolean;
  muted: boolean;
  closed: boolean;
  closedReason: 'sold' | 'deleted' | 'removed' | null;
  updatedAt: string;          // last message time (or creation). Show as "5 min ago"; never "Posted …"
  createdAt: string;
  // legacy, removed after one release: type, otherUser, listing
};
```

### Error

REST error body:

```json
{ "error": { "code": "TOO_LONG", "message": "Messages can be up to 1000 characters.",
             "fields": { "text": "Messages can be up to 1000 characters." }, "retryAfterSeconds": 12 } }
```

`fields` and `retryAfterSeconds` appear only when relevant. A 429 also sends the `Retry-After` header.

Socket acks:

```ts
type Ack<T> = { ok: true; data: T }
            | { ok: false; error: { code: string; message: string; fields?: Record<string, string>;
                                    retryAfterSeconds?: number; reason?: AuthReason;
                                    conversationId?: string | null; clientMessageId?: string | null } };
type AuthReason = 'missing' | 'invalid' | 'expired' | 'revoked';
```

### Error codes

| Code | HTTP | Meaning |
| --- | --- | --- |
| `VALIDATION_FAILED` | 400 | See `fields`, e.g. `text: "Type a message."`, `type: "Choose text or image."`, or `attachments`. |
| `TOO_LONG` | 400 | Text is over 1000 characters after trimming. |
| `UNAUTHENTICATED` | 401 | Missing or invalid token. Sockets get `auth:expired` instead (§2). |
| `FORBIDDEN` | 403 | Deleting someone else's message for everyone, deleting after 10 minutes, or `auth:refresh` with another account's token. |
| `BLOCKED` | 403 | Either person has blocked the other. |
| `CONVERSATION_NOT_FOUND` | 404 | No such chat, or the caller is not in it. |
| `NOT_FOUND` | 404 | Message, person or product not found. |
| `RATE_LIMITED` | 429 | More than 30 messages a minute or 10 new chats an hour. Includes `retryAfterSeconds`. |
| `EMAIL_NOT_VERIFIED` | 403 | REST send or create after the 24 h unverified grace period. |
| `SERVER_ERROR` | 500 | Retry with the same `clientMessageId`. |

---

## 2. Socket connection and auth

```ts
const socket = io(`${API_URL}/chat`, {
  auth: (cb) => cb({ token: getLatestAccessToken() }),   // callback form: every reconnect sends the newest token
  transports: ['websocket'],
});
```

1. **Valid token:** the server emits `connected { userId, serverTime, heartbeatMs }`, and the socket receives events for that user.
2. **Missing, invalid, expired or revoked token** (at connect, or when a live token expires): the connection is **not** closed.
   - The server emits `auth:expired { code: "UNAUTHENTICATED", reason, message, graceMs: 30000 }` and starts a 30 s grace period.
   - Every other client event is acked with `UNAUTHENTICATED` until auth succeeds. A live socket keeps receiving events during the grace period.
3. **Recover:** refresh the access token over REST, then `emit('auth:refresh', { token }, ack)`.
   - Success: `{ ok: true, data: { userId, expiresAt: string | null } }`. A socket that was never authenticated then gets `connected`.
   - Failure: `{ ok: false, error: { code: "UNAUTHENTICATED", reason } }`. The grace timer keeps running, so you can try again.
   - A token for a different account: `FORBIDDEN`. Disconnect and reconnect instead.
   - `auth:refresh` also works before expiry, to rotate the token without dropping the connection.
4. **No valid token within `graceMs`:** the server emits `auth:failed { code, reason, message }` and disconnects (`"io server disconnect"`). Send the user to login if refresh is impossible; otherwise reconnect.
5. **`reason` values:**
   - `missing`: no token sent.
   - `invalid`: bad signature or format.
   - `expired`: the token has expired.
   - `revoked`: account inactive, deleted, or signed out everywhere. Refreshing won't help, so log the user in again.

The old `error:auth` event and the immediate disconnect are gone.

---

## 3. REST

### Send: `POST /api/chat/conversations/:id/messages`

Only the conversation id and the token are needed; the server knows the other participant.

```json
{ "clientMessageId": "6f1c…", "text": "Is it still available?", "attachments": [{ "url": "https://res.cloudinary.com/…" }] }
```

**Body fields**

- **`clientMessageId`:** optional for now, but **send it on every message**. It must match `[A-Za-z0-9_.:-]{1,64}` (a UUID works). Without it, a retry creates a duplicate.
- **`text`:** trimmed, 1–1000 characters. It may be empty when attachments are present.
- **`attachments`:** 0–4 items, each the URL of a completed `kind: "chat"` signed upload (JPEG, PNG or WebP, up to 3 MB).
- **`type`:** optional and case-insensitive (`"TEXT"`, `"text"`, `"Image"`). Responses are lowercase.
- **Legacy, still accepted:** `content` (alias of `text`), `attachmentUrl`, `replyToId` and `productId`.

**Responses**

- **201:** `Message`, newly saved.
- **200:** `Message`, the original, when this `clientMessageId` was already used in this conversation by this sender.
- **Errors:** `VALIDATION_FAILED`, `TOO_LONG`, `CONVERSATION_NOT_FOUND`, `BLOCKED`, `RATE_LIMITED` and `EMAIL_NOT_VERIFIED`.

### History: `GET /api/chat/conversations/:id/messages`

| Query | Meaning |
| --- | --- |
| *(none)* | Latest `limit` messages (default 30, maximum 100). |
| `beforeSeq=N` | Older page: messages with `seq < N`. |
| `afterSeq=N` | Resume: messages with `seq > N`, oldest first. |

```ts
{
  items: Message[];            // always ascending by seq (newest last)
  hasMore: boolean;
  nextCursor: number | null;   // beforeSeq for the next older page (history mode)
  nextAfterSeq: number | null; // afterSeq for the next resume page (resume mode)
  lastSeq: number; lastReadSeq: number; otherReadSeq: number; otherDeliveredSeq: number;
}
```

Loading history marks the viewer's received messages as delivered. The sender then gets `message:status`.

### Read: `POST /api/chat/conversations/:id/read`

Body: `{ "upToSeq": 42 }`. Leave out `upToSeq` to mark everything read. The call is idempotent; a lower value never moves the pointer back.

Response:

```json
{ "conversationId": "…", "lastReadSeq": 42, "unreadCount": 0, "totalUnread": 3 }
```

The other person gets `message:status { status: "read" }`, and the reader's other devices get `unread:update`.

### Unread: `GET /api/chat/unread`

```json
{ "total": 3, "conversations": [{ "conversationId": "…", "unreadCount": 3 }] }
```

Only conversations with unread messages are listed, newest first.

### Other REST endpoints

| Method & path | Body / query | Response |
| --- | --- | --- |
| `POST /api/chat/conversations` | `{ participantId, productId? }` | 201 or 200 `Conversation` |
| `GET /api/chat/conversations` | `limit` (≤50), `cursor`, `filter=all\|unread`, `archived=true\|false` | `{ items: Conversation[], nextCursor: string \| null, totalUnread: number }` |
| `GET /api/chat/conversations/:id` | | `Conversation` |
| `PATCH /api/chat/conversations/:id` | `{ archived?, muted? }` | `Conversation` |
| `DELETE /api/chat/conversations/:id` | | 204 (hidden for you only) |
| `DELETE /api/chat/conversations/:id/messages/:messageId` | `?for=me\|everyone` | `Message` |
| `POST /api/chat/conversations/:id/messages/:messageId/report` | `{ reason, details? }` | `{ id, status, message, hiddenForYou }` |
| `GET` / `PATCH /api/chat/settings` | `{ showPresence }` | `{ showPresence }` |

---

## 4. Socket events

### Client → server

Every client → server event takes an ack callback that receives `Ack<T>`.

| Event | Payload | Ack `data` |
| --- | --- | --- |
| `auth:refresh` | `{ token }` | `{ userId, expiresAt }` |
| `message:send` | `{ conversationId, clientMessageId?, text?, attachments?, type? }` (same rules as REST) | `{ message: Message, created: boolean }` |
| `message:delivered` | `{ conversationId, seq }` | `null` |
| `message:read` | `{ conversationId, upToSeq? }` | `{ conversationId, lastReadSeq, unreadCount, totalUnread }` |
| `typing` | `{ conversationId, isTyping }`. Send about every 3 s while typing. | `null` |
| `presence:subscribe` | `{ userIds: string[] }` (up to 100) | `Array<{ userId, online, lastActiveAt }>` |
| `presence:unsubscribe` | `{ userIds }` | `null` |
| `heartbeat` | `{}` | `{ serverTime }` |

A failed `message:send` acks `{ ok: false, error: { code, message, fields?, retryAfterSeconds?, conversationId, clientMessageId } }`.
It **also** emits `message:error` with the same fields, so clients that don't use acks can fail the right message.

### Server → client

| Event | Payload |
| --- | --- |
| `connected` | `{ userId, serverTime, heartbeatMs }` |
| `auth:expired` | `{ code: "UNAUTHENTICATED", reason, message, graceMs }` |
| `auth:failed` | `{ code: "UNAUTHENTICATED", reason, message }`, sent just before the server disconnects. |
| `message:new` | `Message`. **Call the ack callback**; that marks it delivered. The sender's own devices get it too, so dedupe by `id` or `clientMessageId`. |
| `message:error` | `{ code, message, error /* legacy copy of message */, fields?, retryAfterSeconds?, conversationId, clientMessageId }` |
| `message:status` | `{ conversationId, upToSeq, status: "delivered" \| "read", userId }`: all of your messages with `seq <= upToSeq`. |
| `message:updated` | `Message`, e.g. deleted for everyone. |
| `conversation:updated` | `{ id, lastSeq, unreadCount, updatedAt, lastMessage }`. Merge into the list item. |
| `unread:update` | `{ conversationId, unreadCount, total }` |
| `typing` | `{ conversationId, userId, isTyping, expiresInMs }`. Treat it as stopped after `expiresInMs` (5000). |
| `presence` | `{ userId, online, lastActiveAt }` |

### Resume after reconnect

1. On `connected`, call `GET …/messages?afterSeq=<highest seq seen>` for each open conversation, repeating while `hasMore`.
2. Then refetch `GET /api/chat/conversations` and `GET /api/chat/unread`.
3. Retry any unsent bubbles with the **same** `clientMessageId`.

---

## 5. Compatibility (old clients keep working until the frontend ships)

These still work:
- `clientMessageId` is optional. Without it, every send creates a new message (201).
- `content` instead of `text`, `attachmentUrl`, and uppercase or mixed-case `type`.
- A socket `message:send` without an ack callback. Watch `message:new` and `message:error`.
- `PATCH …/read`, `GET /api/chat/conversations/unread-count`, the `page` query parameter, and the legacy fields listed in §1.

These are removed: the `message:queued` reply and the `error:auth` event.
