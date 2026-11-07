import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ProductStatus } from '../common/constants/listing';
import { AppError } from '../common/errors/app-errors';
import { ErrorCode } from '../common/errors/error-codes';
import { EmailService } from '../common/services/email.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationType } from '../notifications/entities/notification.entity';
import { applyStatus, Product } from '../products/entities/product.entity';
import { User } from '../users/entities/user.entity';
import {
  ScreeningInput,
  ScreeningResult,
  screenListing,
  UNDER_REVIEW_NOTE,
} from './screening';

export const REPEAT_OFFENDER = { confirmedReports: 3, windowDays: 30 } as const;

/** Reasons that only a moderator can clear (editing the listing won't). */
export const HOLD_CODES = ['reported', 'admin_hold'];

/**
 * Glue between the pure screening rules and the database: gathers posting
 * counts, applies results to listings, hides reported listings and
 * suspends repeat offenders. Used by ProductsService, ReportsService and
 * the admin API.
 */
@Injectable()
export class ModerationService {
  private readonly logger = new Logger(ModerationService.name);

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly notifications: NotificationsService,
    private readonly email: EmailService,
    private readonly config: ConfigService,
  ) {}

  /** 403 ACCOUNT_SUSPENDED when posting is paused for this seller. */
  async assertCanPost(sellerId: string): Promise<void> {
    const [u] = await this.ds.query<
      {
        postingSuspendedAt: Date | null;
        postingSuspendedReason: string | null;
      }[]
    >(
      `SELECT "postingSuspendedAt", "postingSuspendedReason" FROM "users" WHERE "id" = $1`,
      [sellerId],
    );
    if (u?.postingSuspendedAt) {
      throw new AppError(
        ErrorCode.ACCOUNT_SUSPENDED,
        `Posting is paused on your account${u.postingSuspendedReason ? `: ${u.postingSuspendedReason}` : ''}. Check your email for how to appeal.`,
      );
    }
  }

  /** Screens a listing with the seller's recent posting activity. */
  async screen(
    input: ScreeningInput,
    sellerId: string,
    excludeProductId?: string,
  ): Promise<ScreeningResult> {
    const [ctx] = await this.ds.query<
      { hour: number; day: number; dup: boolean }[]
    >(
      `SELECT
         count(*) FILTER (WHERE "createdAt" > now() - interval '1 hour')::int AS hour,
         count(*)::int AS day,
         bool_or(lower(trim("title")) = lower(trim($2)) AND "status" = 'active') AS dup
         FROM "products"
        WHERE "sellerId" = $1 AND "createdAt" > now() - interval '24 hours'
          AND "deletedAt" IS NULL AND ($3::uuid IS NULL OR "id" <> $3::uuid)`,
      [sellerId, input.title ?? '', excludeProductId ?? null],
    );
    return screenListing(input, {
      postsLastHour: ctx?.hour ?? 0,
      postsLastDay: ctx?.day ?? 0,
      duplicateInLast24h: !!ctx?.dup,
    });
  }

  /** 400 MODERATION_REJECTED with the first reason as the message and per-field details. */
  static rejection(result: ScreeningResult): AppError {
    const fields: Record<string, string> = {};
    for (const r of result.reasons)
      if (r.field && !fields[r.field]) fields[r.field] = r.message;
    return new AppError(
      ErrorCode.MODERATION_REJECTED,
      result.reasons[0]?.message,
      fields,
    );
  }

  /**
   * Applies a needs_review/approved screening result to a listing object (not
   * saved). Moderator holds (reports, admin) survive edits.
   */
  static applyScreening(product: Product, result: ScreeningResult): void {
    const now = new Date().toISOString();
    const holds = (product.moderationReasons ?? []).filter((r) =>
      HOLD_CODES.includes(r.code),
    );
    if (result.status === 'needs_review') {
      product.moderationStatus = 'needs_review';
      product.moderationReasons = [
        ...holds,
        ...result.reasons.map((r) => ({
          code: r.code,
          message: r.message,
          at: now,
        })),
      ];
      if (product.status !== ProductStatus.SOLD)
        applyStatus(product, ProductStatus.NEEDS_REVIEW);
      return;
    }
    // approved by the rules
    if (holds.length) {
      product.moderationReasons = holds;
      return;
    }
    const wasHeldByScreening = product.moderationStatus === 'needs_review';
    product.moderationStatus = 'approved';
    product.moderationReasons = [];
    if (wasHeldByScreening && product.status === ProductStatus.NEEDS_REVIEW) {
      applyStatus(product, ProductStatus.ACTIVE);
    }
  }

  static ownerNote(p: Pick<Product, 'moderationStatus'>): string | null {
    if (p.moderationStatus === 'needs_review') return UNDER_REVIEW_NOTE;
    if (p.moderationStatus === 'rejected')
      return 'This listing was taken down by our team. Check your notifications for why.';
    return null;
  }

  /** Hides a listing pending review after reports. Idempotent. */
  async holdForReports(productId: string): Promise<boolean> {
    const repo = this.ds.getRepository(Product);
    const p = await repo.findOne({ where: { id: productId } });
    if (!p || p.status === ProductStatus.SOLD) return false;
    if ((p.moderationReasons ?? []).some((r) => r.code === 'reported'))
      return false;
    const previousStatus =
      p.status === ProductStatus.NEEDS_REVIEW ? ProductStatus.ACTIVE : p.status;
    p.moderationStatus = 'needs_review';
    p.moderationReasons = [
      ...(p.moderationReasons ?? []),
      {
        code: 'reported',
        message: `Hidden after reports (was ${previousStatus}).`,
        at: new Date().toISOString(),
      },
    ];
    applyStatus(p, ProductStatus.NEEDS_REVIEW);
    await repo.save(p);
    this.notifications
      .create({
        userId: p.sellerId,
        type: NotificationType.LISTING,
        title: 'Your listing is being reviewed',
        body: `"${p.title}" is hidden while our team takes a look. This usually takes under 24 hours.`,
        metadata: { productId: p.id },
      })
      .catch(() => undefined);
    return true;
  }

  /**
   * Suspends posting when a user's content has 3 confirmed reports in 30
   * days. Notifies in-app and by email with the reason and how to appeal.
   */
  async checkRepeatOffender(userId: string): Promise<boolean> {
    const [row] = await this.ds.query<{ n: number }[]>(
      `SELECT count(DISTINCT "targetId")::int AS n FROM "reports"
        WHERE "targetUserId" = $1 AND "status" = 'actioned'
          AND "resolvedAt" > now() - ($2 || ' days')::interval`,
      [userId, String(REPEAT_OFFENDER.windowDays)],
    );
    if ((row?.n ?? 0) < REPEAT_OFFENDER.confirmedReports) return false;
    const reason = `${row.n} of your listings or messages were removed after reports in the last ${REPEAT_OFFENDER.windowDays} days`;
    const res = await this.ds.query<{ id: string }[]>(
      `UPDATE "users" SET "postingSuspendedAt" = now(), "postingSuspendedReason" = $2
        WHERE "id" = $1 AND "postingSuspendedAt" IS NULL RETURNING "id"`,
      [userId, reason],
    );
    // RETURNING rows come back as [rows, count] for UPDATE in the pg driver.
    const updated = Array.isArray(res[0])
      ? (res[0] as unknown[]).length
      : res.length;
    if (!updated) return false;
    await this.notifySuspended(userId, reason);
    return true;
  }

  async notifySuspended(userId: string, reason: string): Promise<void> {
    const appeal = this.appealEmail();
    await this.notifications
      .create({
        userId,
        type: NotificationType.ACCOUNT,
        title: 'Posting is paused on your account',
        body: `${reason}. You can still browse and chat. To appeal, email ${appeal}.`,
        metadata: {},
      })
      .catch(() => undefined);
    const [u] = await this.ds.query<Pick<User, 'email'>[]>(
      `SELECT "email" FROM "users" WHERE "id" = $1`,
      [userId],
    );
    if (u) {
      await this.email.sendNotice(
        u.email,
        'Posting is paused on your CampusSales account',
        [
          `${reason}.`,
          'You can still browse and chat, but you cannot post new listings for now.',
          `If you think this is a mistake, reply to ${appeal} with your username and we will review it.`,
        ],
      );
    }
  }

  appealEmail(): string {
    return this.config.get<string>('APPEAL_EMAIL') || 'appeals@campussales.ng';
  }
}
