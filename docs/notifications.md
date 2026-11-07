# Notifications (B4)

## Payload

```json
{
  "id": "uuid",
  "type": "listing",
  "title": "Your listing is live",
  "body": "\"Casio calculator\" passed review and is visible again.",
  "createdAt": "2026-11-07T10:15:00.000Z",
  "readAt": null,
  "link": { "kind": "listing", "id": "uuid" },
  "text": "…same as body (legacy, one release)",
  "isRead": false,
  "metadata": { "productId": "uuid" }
}
```

- Times are ISO 8601 in UTC. Format "7 minutes ago" in the client.
- `link.kind`: `conversation`, `listing` or `user`; `null` when there is nothing to open.
- `isRead`, `metadata` and `text` are kept for one release.

## Endpoints

| Method & path | Notes |
| --- | --- |
| `GET /api/notifications?limit=20&cursor=…&type=all\|unread` | `{ items, nextCursor, unreadCount }` (+ legacy `data`, `total`, `page`, `limit`) |
| `POST /api/notifications/:id/read` | idempotent; sets `readAt` |
| `POST /api/notifications/read-all` | sets `readAt` on all unread |
| `GET /api/notifications/unread-count` | unchanged |
| `PATCH …/read-all`, `PATCH …/:id/read` | deprecated aliases |

Notifications older than 90 days are deleted daily.

## Copy rules

So nothing we send can be mistaken for phishing:

1. **Only from templates in code.** Every title and body is written in the
   backend (`NotificationsService` helpers, `AdminService`,
   `ModerationService`). User-supplied text is only ever quoted (a listing
   title in quotes, a short message preview), never used as the whole message.
2. **No urgency or money language.** Avoid "urgent", "act now", "immediately",
   "verify your account", "payment", "send", "transfer", "win", "prize". We
   never ask for money, passwords, codes or bank details in a notification.
3. **No external links.** `link` only points inside the app (conversation,
   listing, user). Emails link only to `FRONTEND_URL`.
4. **Plain and specific.** Say what happened and what the person can do:
   "Your listing was taken down: <reason>". No ALL CAPS, at most one
   exclamation mark, no emoji in moderation or account notices.
5. **Moderation and account notices never name a reporter** and never say
   how many people reported.
6. **Appeals** go to the published appeal address (`APPEAL_EMAIL`), never a
   personal address or phone number.

Checklist for a new notification: template in code ✓, in-app link only ✓, no
money or urgency words ✓, no reporter details ✓, reviewed by a second person ✓.
