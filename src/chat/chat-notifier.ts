import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { NotificationsService } from '../notifications/notifications.service';
import { WebPushService } from '../notifications/web-push.service';
import { EmailService } from '../common/services/email.service';
import { RateLimitService } from '../common/rate-limit/rate-limit.service';
import { MessageView } from './chat-views';
import { MessageType } from './enums/chat.enums';

/** At most one push and one email per conversation per recipient in this window. */
export const CHAT_NOTIFY_WINDOW_MS = 15 * 60_000;

const LINKISH =
  /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|ng|net|org|io|me|co|xyz|link|app)\b)/i;
const LONG_NUMBER = /\d[\d\s-]{7,}\d/;

/**
 * Preview text for in-app notifications, following the B4 copy rules: we
 * never repeat anything that could be payment details or a link (flagged
 * messages, URLs, long numbers). Push and email never include message text.
 */
export function safePreview(m: MessageView): string {
  if (m.attachments.length && !m.text) return 'Sent a photo';
  const text = (m.text ?? '').replace(/\s+/g, ' ').trim();
  if (!text || m.safetyTip || LINKISH.test(text) || LONG_NUMBER.test(text))
    return 'Sent you a message';
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

/**
 * What happens when a recipient has no connected chat socket (C1):
 *  1. in-app notification, one per conversation while unread (updated in place),
 *  2. Web Push (CHAT_WEB_PUSH=true + VAPID keys), and
 *  3. an email digest (CHAT_EMAIL_DIGEST=true),
 * each of 2 and 3 at most once per conversation per 15 minutes, and never
 * for muted chats or system messages.
 */
@Injectable()
export class ChatNotifier {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly webPush: WebPushService,
    private readonly email: EmailService,
    private readonly rateLimit: RateLimitService,
    private readonly config: ConfigService,
    @InjectDataSource() private readonly ds: DataSource,
  ) {}

  async messageWhileOffline(
    recipientId: string,
    m: MessageView,
    muted: boolean,
  ): Promise<void> {
    if (m.type === MessageType.SYSTEM) return;
    const senderName =
      m.sender?.profile?.firstName || m.sender?.username || 'Someone';
    await this.notifications.upsertChatMessage(
      recipientId,
      `New message from ${senderName}`,
      safePreview(m),
      m.conversationId,
    );
    if (muted) return;

    const path = `/chat/${m.conversationId}`;
    if (
      this.webPush.enabled() &&
      (await this.once('chat-push', recipientId, m.conversationId))
    ) {
      await this.webPush.sendToUser(recipientId, {
        title: 'CampusSales',
        body: `New message from ${senderName}`,
        path,
        tag: `chat-${m.conversationId}`,
      });
    }

    if (
      this.config.get('CHAT_EMAIL_DIGEST') === 'true' &&
      (await this.once('chat-email', recipientId, m.conversationId))
    ) {
      const [u] = await this.ds.query<
        Array<{ email: string; firstName: string | null }>
      >(
        `SELECT u.email, p."firstName" FROM "users" u
           LEFT JOIN "user_profiles" p ON p."userId" = u.id WHERE u.id = $1`,
        [recipientId],
      );
      if (!u?.email) return;
      const base = (this.config.get<string>('FRONTEND_URL') || '').replace(
        /\/$/,
        '',
      );
      await this.email.sendNotice(
        u.email,
        `New message from ${senderName} on CampusSales`,
        [
          `${senderName} sent you a message on CampusSales.`,
          `Open your chats to reply: ${base}${path}`,
          'CampusSales staff will never ask for your password or a code in a chat.',
        ],
        u.firstName,
      );
    }
  }

  /** True the first time per (kind, recipient, conversation) in the window. */
  private async once(
    kind: string,
    recipientId: string,
    conversationId: string,
  ): Promise<boolean> {
    const r = await this.rateLimit.consume(
      RateLimitService.key(kind, recipientId, conversationId),
      1,
      CHAT_NOTIFY_WINDOW_MS,
    );
    return r.allowed;
  }
}
