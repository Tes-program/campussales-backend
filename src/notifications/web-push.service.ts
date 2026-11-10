import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import webpush from 'web-push';
import { hashUserId } from '../common/observability/redact';

export interface PushPayload {
  title: string;
  body: string;
  /** In-app path only (e.g. /chat/<id>); never an external link. */
  path: string;
  tag?: string;
}

/**
 * Web Push (C1), off unless CHAT_WEB_PUSH=true and VAPID_PUBLIC_KEY /
 * VAPID_PRIVATE_KEY / VAPID_SUBJECT are set. Generate keys once with
 * `npx web-push generate-vapid-keys`. Payloads follow the notification copy
 * rules (docs/notifications.md): our templates only, no message text that
 * could carry payment details or links.
 */
@Injectable()
export class WebPushService {
  private readonly logger = new Logger(WebPushService.name);
  private configured = false;

  constructor(
    private readonly config: ConfigService,
    @InjectDataSource() private readonly ds: DataSource,
  ) {
    const pub = config.get<string>('VAPID_PUBLIC_KEY');
    const priv = config.get<string>('VAPID_PRIVATE_KEY');
    if (pub && priv) {
      try {
        webpush.setVapidDetails(
          config.get<string>('VAPID_SUBJECT') ||
            'mailto:support@campussales.ng',
          pub,
          priv,
        );
        this.configured = true;
      } catch (e) {
        this.logger.warn(`Web Push disabled: ${(e as Error).message}`);
      }
    }
  }

  enabled(): boolean {
    return this.configured && this.config.get('CHAT_WEB_PUSH') === 'true';
  }

  publicKey(): string | null {
    return this.enabled()
      ? (this.config.get<string>('VAPID_PUBLIC_KEY') ?? null)
      : null;
  }

  /** Idempotent per endpoint; an endpoint moves to the latest user who registers it. */
  async subscribe(
    userId: string,
    sub: { endpoint: string; keys: { p256dh: string; auth: string } },
  ): Promise<void> {
    await this.ds.query(
      `INSERT INTO "push_subscriptions" ("userId", "endpoint", "p256dh", "auth")
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (md5("endpoint")) DO UPDATE
         SET "userId" = EXCLUDED."userId", "p256dh" = EXCLUDED."p256dh", "auth" = EXCLUDED."auth"`,
      [userId, sub.endpoint, sub.keys.p256dh, sub.keys.auth],
    );
  }

  async unsubscribe(userId: string, endpoint: string): Promise<void> {
    await this.ds.query(
      `DELETE FROM "push_subscriptions" WHERE "userId" = $1 AND md5("endpoint") = md5($2)`,
      [userId, endpoint],
    );
  }

  /** Never throws. Returns how many devices accepted it. */
  async sendToUser(userId: string, payload: PushPayload): Promise<number> {
    if (!this.enabled()) return 0;
    const subs = await this.ds.query<
      Array<{ id: string; endpoint: string; p256dh: string; auth: string }>
    >(
      `SELECT id, endpoint, p256dh, auth FROM "push_subscriptions" WHERE "userId" = $1`,
      [userId],
    );
    let sent = 0;
    for (const s of subs) {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify(payload),
          { TTL: 3600, urgency: 'normal' },
        );
        sent++;
        await this.ds.query(
          `UPDATE "push_subscriptions" SET "lastUsedAt" = now() WHERE id = $1`,
          [s.id],
        );
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          await this.ds.query(
            `DELETE FROM "push_subscriptions" WHERE id = $1`,
            [s.id],
          );
        } else {
          this.logger.warn(
            `Web Push failed for user ${hashUserId(userId)}: ${status ?? (e as Error).message}`,
          );
        }
      }
    }
    return sent;
  }
}
