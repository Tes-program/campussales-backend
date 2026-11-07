import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { RateLimitService } from '../common/rate-limit/rate-limit.service';
import { EmailService } from '../common/services/email.service';

export const NOTIFICATION_RETENTION_DAYS = 90;
export const ACCOUNT_DELETION_GRACE_DAYS = 30;

/**
 * Daily housekeeping, run hourly with a once-a-day lock in Redis so only one
 * API instance does each job:
 *  - email ADMIN_ALERT_EMAIL a summary of reports/listings open > 24h
 *  - delete notifications older than 90 days
 *  - anonymise accounts whose 30-day deletion grace has ended
 */
@Injectable()
export class MaintenanceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MaintenanceService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly rateLimit: RateLimitService,
    private readonly email: EmailService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.tick(), 60 * 60_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async onceADay(job: string): Promise<boolean> {
    const r = await this.rateLimit.consume(
      RateLimitService.key('daily-job', job),
      1,
      24 * 3_600_000,
    );
    return r.allowed;
  }

  async tick(): Promise<void> {
    try {
      if (await this.onceADay('summary')) await this.sendDailySummary();
      if (await this.onceADay('notifications'))
        await this.purgeOldNotifications();
      if (await this.onceADay('deletions')) await this.purgeDeletedAccounts();
    } catch (e) {
      this.logger.error(`Maintenance failed: ${(e as Error).message}`);
    }
  }

  async sendDailySummary(force = false): Promise<{
    sent: boolean;
    openReports: number;
    listingsToReview: number;
    usersToReview: number;
  }> {
    const [c] = await this.ds.query<
      { reports: number; listings: number; users: number }[]
    >(
      `SELECT
         (SELECT count(*)::int FROM "reports" WHERE "status" = 'open' AND "createdAt" < now() - interval '24 hours') AS reports,
         (SELECT count(*)::int FROM "products" WHERE "moderationStatus" = 'needs_review' AND "deletedAt" IS NULL AND "updatedAt" < now() - interval '24 hours') AS listings,
         (SELECT count(*)::int FROM "users" WHERE "needsReviewAt" < now() - interval '24 hours') AS users`,
    );
    const to = this.config.get<string>('ADMIN_ALERT_EMAIL');
    const any = c.reports + c.listings + c.users > 0;
    let sent = false;
    if (to && (any || force)) {
      sent = await this.email.sendNotice(
        to,
        'CampusSales review queue: items waiting over 24 hours',
        [
          `Open reports older than 24 hours: ${c.reports}`,
          `Listings waiting for review: ${c.listings}`,
          `Accounts flagged for review: ${c.users}`,
          'Open the admin API (GET /api/admin/reports, /api/admin/products, /api/admin/users) to act on them.',
        ],
      );
    }
    return {
      sent,
      openReports: c.reports,
      listingsToReview: c.listings,
      usersToReview: c.users,
    };
  }

  async purgeOldNotifications(): Promise<number> {
    const raw = await this.ds.query(
      `DELETE FROM "notifications" WHERE "createdAt" < now() - ($1 || ' days')::interval`,
      [String(NOTIFICATION_RETENTION_DAYS)],
    );
    return Array.isArray(raw) ? Number(raw[1] ?? 0) : 0;
  }

  /**
   * Anonymises accounts whose deletion grace ended: personal data is wiped,
   * listings, wishlists, notifications, sessions and blocks are deleted, and
   * the person's chat messages are replaced so the other side keeps a
   * coherent history without the content. Needs legal review (NDPA).
   */
  async purgeDeletedAccounts(): Promise<number> {
    const users = await this.ds.query<{ id: string }[]>(
      `SELECT "id" FROM "users" WHERE "deletionRequestedAt" < now() - ($1 || ' days')::interval AND "email" NOT LIKE 'deleted-%@deleted.invalid'`,
      [String(ACCOUNT_DELETION_GRACE_DAYS)],
    );
    for (const { id } of users) {
      await this.ds.transaction(async (m) => {
        await m.query(
          `UPDATE "messages" SET "content" = 'Message removed (account deleted)', "attachmentUrl" = NULL, "flags" = '[]' WHERE "senderId" = $1 AND "type" <> 'system'`,
          [id],
        );
        await m.query(
          `DELETE FROM "product_images" WHERE "productId" IN (SELECT "id" FROM "products" WHERE "sellerId" = $1)`,
          [id],
        );
        await m.query(
          `UPDATE "products" SET "deletedAt" = coalesce("deletedAt", now()), "title" = 'Deleted listing', "description" = '', "tags" = '[]' WHERE "sellerId" = $1`,
          [id],
        );
        for (const t of [
          'wishlists',
          'notifications',
          'refresh_tokens',
          'password_resets',
          'email_verifications',
          'product_drafts',
          'uploads',
        ]) {
          const col = t === 'product_drafts' ? 'sellerId' : 'userId';
          await m
            .query(`DELETE FROM "${t}" WHERE "${col}" = $1`, [id])
            .catch(() => undefined);
        }
        await m.query(
          `DELETE FROM "user_blocks" WHERE "blockerId" = $1 OR "blockedId" = $1`,
          [id],
        );
        await m.query(
          `UPDATE "user_profiles" SET "firstName" = 'Deleted', "lastName" = 'user', "bio" = NULL, "profilePictureUrl" = NULL, "dateOfBirth" = NULL, "gender" = NULL, "interest" = NULL WHERE "userId" = $1`,
          [id],
        );
        await m.query(
          `UPDATE "users" SET "email" = 'deleted-' || "id" || '@deleted.invalid', "username" = 'deleted_' || substr("id"::text, 1, 8),
                  "phoneNumber" = NULL, "fullName" = NULL, "passwordHash" = 'deleted', "isActive" = false, "status" = 'inactive'
            WHERE "id" = $1`,
          [id],
        );
      });
    }
    return users.length;
  }
}
