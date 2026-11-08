import { ListingCacheInvalidator } from '../common/cache/listing-cache';
import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, MoreThan, Repository } from 'typeorm';
import {
  conflict,
  notFound,
  rateLimited,
  ValidationFailed,
} from '../common/errors/app-errors';
import { Message } from '../chat/entities/message.entity';
import { ConversationParticipant } from '../chat/entities/conversation-participant.entity';
import { Product } from '../products/entities/product.entity';
import { User } from '../users/entities/user.entity';
import { CreateReportDto } from './reports.dto';
import { Report } from './report.entity';
import { ModerationService } from './moderation.service';

export const REPORT_LIMITS = {
  perUserPerDay: 20,
  /** Distinct reporters that auto-hide a listing. */
  autoHideReporters: 3,
  /** A single scam/prohibited report hides a listing if the reporter's account is older than this. */
  trustedReporterAgeDays: 7,
} as const;

export const REPORT_THANKS =
  "Thanks for telling us. We'll review it, and the person you reported won't be told who reported them.";

@Injectable()
export class ReportsService {
  constructor(
    @InjectRepository(Report) private readonly reports: Repository<Report>,
    @InjectDataSource() private readonly ds: DataSource,
    private readonly moderation: ModerationService,
    private readonly listingCache: ListingCacheInvalidator,
  ) {}

  async create(reporter: User, dto: CreateReportDto) {
    const since = new Date(Date.now() - 86_400_000);
    const today = await this.reports.count({
      where: { reporterId: reporter.id, createdAt: MoreThan(since) },
    });
    if (today >= REPORT_LIMITS.perUserPerDay) {
      throw rateLimited(
        "You've sent a lot of reports today. Please try again tomorrow.",
        3600,
      );
    }
    const dup = await this.reports.exist({
      where: {
        reporterId: reporter.id,
        targetType: dto.targetType,
        targetId: dto.targetId,
        createdAt: MoreThan(since),
      },
    });
    if (dup)
      throw conflict("You've already reported this. Our team will review it.");

    const targetUserId = await this.resolveTarget(reporter.id, dto);
    if (targetUserId === reporter.id) {
      throw new ValidationFailed({ targetId: "You can't report yourself." });
    }

    const report = await this.reports.save(
      this.reports.create({
        reporterId: reporter.id,
        targetType: dto.targetType,
        targetId: dto.targetId,
        targetUserId,
        reason: dto.reason,
        details: dto.details ?? null,
      }),
    );

    if (dto.targetType === 'listing')
      await this.maybeAutoHide(dto.targetId, reporter, dto.reason);

    this.listingCache.viewerChanged(reporter.id);
    // The reporter's own view: returned so the UI can drop the item at once.
    return {
      id: report.id,
      status: 'open',
      message: REPORT_THANKS,
      hiddenForYou: true,
    };
  }

  /** Who owns the target. 404 if it does not exist or the reporter can't see it. */
  private async resolveTarget(
    reporterId: string,
    dto: CreateReportDto,
  ): Promise<string> {
    if (dto.targetType === 'listing') {
      const p = await this.ds
        .getRepository(Product)
        .findOne({ where: { id: dto.targetId } });
      if (!p) throw notFound("We couldn't find that listing.");
      return p.sellerId;
    }
    if (dto.targetType === 'user') {
      const u = await this.ds
        .getRepository(User)
        .findOne({ where: { id: dto.targetId } });
      if (!u) throw notFound("We couldn't find that person.");
      return u.id;
    }
    const m = await this.ds
      .getRepository(Message)
      .findOne({ where: { id: dto.targetId } });
    if (!m) throw notFound("We couldn't find that message.");
    const isParticipant = await this.ds
      .getRepository(ConversationParticipant)
      .exist({
        where: { conversationId: m.conversationId, userId: reporterId },
      });
    if (!isParticipant) throw notFound("We couldn't find that message.");
    return m.senderId;
  }

  /**
   * Hide (needs_review) after 3 reports from different users, or after one
   * scam/prohibited report from an account older than 7 days.
   */
  private async maybeAutoHide(
    productId: string,
    reporter: User,
    reason: string,
  ): Promise<void> {
    const trusted =
      (reason === 'scam' || reason === 'prohibited') &&
      Date.now() - reporter.createdAt.getTime() >
        REPORT_LIMITS.trustedReporterAgeDays * 86_400_000;
    let hide = trusted;
    if (!hide) {
      const [row] = await this.ds.query<{ n: number }[]>(
        `SELECT count(DISTINCT "reporterId")::int AS n FROM "reports"
          WHERE "targetType" = 'listing' AND "targetId" = $1 AND "status" = 'open'`,
        [productId],
      );
      hide = (row?.n ?? 0) >= REPORT_LIMITS.autoHideReporters;
    }
    if (hide) await this.moderation.holdForReports(productId);
  }
}

/**
 * SQL fragment for list queries: hides listings the viewer reported, and all
 * listings of users the viewer reported. Use with a `:viewerId` parameter.
 */
export const reportedByViewer = (productAlias: string) =>
  `EXISTS (SELECT 1 FROM "reports" rr WHERE rr."reporterId" = :viewerId AND (` +
  `(rr."targetType" = 'listing' AND rr."targetId" = ${productAlias}.id) OR ` +
  `(rr."targetType" = 'user' AND rr."targetId" = ${productAlias}."sellerId")))`;
