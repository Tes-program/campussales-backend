import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, IsNull, Not, Repository } from 'typeorm';
import { ProductStatus } from '../common/constants/listing';
import { notFound, ValidationFailed } from '../common/errors/app-errors';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationType } from '../notifications/entities/notification.entity';
import { applyStatus, Product } from '../products/entities/product.entity';
import { closeConversationsForProduct } from '../chat/conversation-closer';
import { User } from '../users/entities/user.entity';
import { AdminAction } from './admin.dto';
import { ModerationService } from './moderation.service';
import { AdminAuditLog, Report } from './report.entity';

/**
 * The review queue. Every action writes an audit log row (who, what, when,
 * why) and notifies the owner from our own templates.
 */
@Injectable()
export class AdminService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    @InjectRepository(Report) private readonly reports: Repository<Report>,
    @InjectRepository(AdminAuditLog)
    private readonly audit: Repository<AdminAuditLog>,
    @InjectRepository(Product) private readonly products: Repository<Product>,
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly moderation: ModerationService,
    private readonly notifications: NotificationsService,
  ) {}

  async listReports(status: string, limit = 50) {
    const rows = await this.reports.find({
      where: status === 'all' ? {} : { status: status as Report['status'] },
      order: { createdAt: 'ASC' },
      take: Math.min(limit, 200),
    });
    return {
      items: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
    };
  }

  async listProducts(moderationStatus: string, limit = 50) {
    const rows = await this.products.find({
      where: {
        moderationStatus: moderationStatus as Product['moderationStatus'],
      },
      relations: ['images'],
      order: { updatedAt: 'ASC' },
      take: Math.min(limit, 200),
      withDeleted: false,
    });
    return {
      items: rows.map((p) => ({
        id: p.id,
        title: p.title,
        description: p.description,
        price: p.price,
        status: p.status,
        moderationStatus: p.moderationStatus,
        moderationReasons: p.moderationReasons,
        sellerId: p.sellerId,
        images: p.images?.map((i) => i.imageUrl) ?? [],
        createdAt: p.createdAt.toISOString(),
      })),
    };
  }

  async listUsersNeedingReview() {
    const rows = await this.users.find({
      where: [
        { needsReviewAt: Not(IsNull()) },
        { postingSuspendedAt: Not(IsNull()) },
      ],
      order: { needsReviewAt: 'ASC' },
      take: 200,
    });
    return {
      items: rows.map((u) => ({
        id: u.id,
        username: u.username,
        needsReviewAt: u.needsReviewAt?.toISOString() ?? null,
        needsReviewReason: u.needsReviewReason ?? null,
        postingSuspendedAt: u.postingSuspendedAt?.toISOString() ?? null,
        postingSuspendedReason: u.postingSuspendedReason ?? null,
      })),
    };
  }

  async auditLog(limit = 100) {
    const rows = await this.audit.find({
      order: { createdAt: 'DESC' },
      take: Math.min(limit, 500),
    });
    return {
      items: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
    };
  }

  async act(
    admin: User,
    action: AdminAction,
    targetId: string,
    reason?: string,
  ) {
    let targetType = 'listing';
    let result: Record<string, unknown> = {};
    switch (action) {
      case 'approve':
        result = await this.approve(targetId);
        break;
      case 'reject':
        result = await this.reject(targetId, reason, admin.id);
        break;
      case 'remove':
        result = await this.remove(targetId, reason, admin.id);
        break;
      case 'warn_user':
        targetType = 'user';
        result = await this.warn(targetId, reason, admin.id);
        break;
      case 'suspend_user':
        targetType = 'user';
        result = await this.suspend(targetId, reason, admin.id);
        break;
      case 'unsuspend_user':
        targetType = 'user';
        await this.mustUser(targetId);
        await this.users.update(
          { id: targetId },
          { postingSuspendedAt: null, postingSuspendedReason: null },
        );
        result = { userId: targetId, suspended: false };
        break;
      case 'clear_user_review':
        targetType = 'user';
        await this.mustUser(targetId);
        await this.users.update(
          { id: targetId },
          { needsReviewAt: null, needsReviewReason: null },
        );
        result = { userId: targetId, needsReview: false };
        break;
      case 'dismiss_report': {
        targetType = 'report';
        const r = await this.reports.findOne({ where: { id: targetId } });
        if (!r) throw notFound('Report not found.');
        await this.resolveReports([r.id], 'dismissed', 'dismissed', admin.id);
        result = { reportId: r.id, status: 'dismissed' };
        break;
      }
    }
    await this.audit.save(
      this.audit.create({
        adminId: admin.id,
        action,
        targetType,
        targetId,
        reason: reason ?? null,
        details: result,
      }),
    );
    return { action, targetId, ...result };
  }

  // ─────────────────────────────────────────────────────────────

  private async mustProduct(id: string): Promise<Product> {
    const p = await this.products.findOne({ where: { id } });
    if (!p) throw notFound('Listing not found.');
    return p;
  }

  private async mustUser(id: string): Promise<User> {
    const u = await this.users.findOne({ where: { id } });
    if (!u) throw notFound('User not found.');
    return u;
  }

  private async approve(id: string) {
    const p = await this.mustProduct(id);
    const reported = (p.moderationReasons ?? []).find(
      (r) => r.code === 'reported',
    );
    const previous = /was (active|inactive)/.exec(
      reported?.message ?? '',
    )?.[1] as ProductStatus | undefined;
    p.moderationStatus = 'approved';
    p.moderationReasons = [];
    if (p.status === ProductStatus.NEEDS_REVIEW)
      applyStatus(p, previous ?? ProductStatus.ACTIVE);
    await this.products.save(p);
    const open = await this.openReportIds('listing', id);
    await this.resolveReports(open, 'dismissed', 'approved');
    await this.notify(
      p.sellerId,
      NotificationType.LISTING,
      'Your listing is live',
      `"${p.title}" passed review and is visible again.`,
      { productId: p.id },
    );
    return {
      productId: p.id,
      status: p.status,
      moderationStatus: p.moderationStatus,
      reportsDismissed: open.length,
    };
  }

  private async reject(
    id: string,
    reason: string | undefined,
    adminId: string,
  ) {
    if (!reason)
      throw new ValidationFailed({ reason: 'Give the seller a reason.' });
    const p = await this.mustProduct(id);
    p.moderationStatus = 'rejected';
    p.moderationReasons = [
      { code: 'admin_rejected', message: reason, at: new Date().toISOString() },
    ];
    if (p.status !== ProductStatus.SOLD) applyStatus(p, ProductStatus.INACTIVE);
    await this.products.save(p);
    const open = await this.openReportIds('listing', id);
    await this.resolveReports(open, 'actioned', 'rejected', adminId);
    await this.notify(
      p.sellerId,
      NotificationType.LISTING,
      'Your listing was taken down',
      `"${p.title}" was taken down: ${reason}`,
      { productId: p.id },
    );
    const suspended = await this.moderation.checkRepeatOffender(p.sellerId);
    return {
      productId: p.id,
      moderationStatus: p.moderationStatus,
      sellerSuspended: suspended,
    };
  }

  private async remove(
    id: string,
    reason: string | undefined,
    adminId: string,
  ) {
    if (!reason)
      throw new ValidationFailed({ reason: 'Give the seller a reason.' });
    const p = await this.mustProduct(id);
    await this.products.update(
      { id },
      {
        moderationStatus: 'rejected',
        moderationReasons: [{ code: 'admin_removed', message: reason }],
      },
    );
    await this.products.softDelete({ id });
    await closeConversationsForProduct(this.ds, p.id, p.sellerId, 'removed');
    const open = await this.openReportIds('listing', id);
    await this.resolveReports(open, 'actioned', 'removed', adminId);
    await this.notify(
      p.sellerId,
      NotificationType.LISTING,
      'Your listing was removed',
      `"${p.title}" was removed: ${reason}`,
      { productId: p.id },
    );
    const suspended = await this.moderation.checkRepeatOffender(p.sellerId);
    return { productId: p.id, removed: true, sellerSuspended: suspended };
  }

  private async warn(
    userId: string,
    reason: string | undefined,
    adminId: string,
  ) {
    if (!reason)
      throw new ValidationFailed({ reason: 'Say what the warning is about.' });
    await this.mustUser(userId);
    const open = await this.openReportIds('user', userId);
    await this.resolveReports(open, 'actioned', 'warned', adminId);
    await this.notify(
      userId,
      NotificationType.ACCOUNT,
      'A note from the CampusSales team',
      `${reason} Please follow the community rules so your account stays in good standing.`,
      {},
    );
    const suspended = await this.moderation.checkRepeatOffender(userId);
    return { userId, warned: true, suspended };
  }

  private async suspend(
    userId: string,
    reason: string | undefined,
    adminId: string,
  ) {
    if (!reason)
      throw new ValidationFailed({ reason: 'Give the user a reason.' });
    await this.mustUser(userId);
    await this.users.update(
      { id: userId },
      { postingSuspendedAt: new Date(), postingSuspendedReason: reason },
    );
    const open = await this.openReportIds('user', userId);
    await this.resolveReports(open, 'actioned', 'suspended', adminId);
    await this.moderation.notifySuspended(userId, reason);
    return { userId, suspended: true };
  }

  private async openReportIds(
    targetType: string,
    targetId: string,
  ): Promise<string[]> {
    const rows = await this.reports.find({
      where: {
        targetType: targetType as Report['targetType'],
        targetId,
        status: 'open',
      },
      select: ['id'],
    });
    return rows.map((r) => r.id);
  }

  private async resolveReports(
    ids: string[],
    status: 'dismissed' | 'actioned',
    resolution: string,
    adminId?: string,
  ): Promise<void> {
    if (!ids.length) return;
    await this.reports.update(
      { id: In(ids) },
      {
        status,
        resolution,
        resolvedAt: new Date(),
        resolvedById: adminId ?? null,
      },
    );
  }

  private async notify(
    userId: string,
    type: NotificationType,
    title: string,
    body: string,
    metadata: Record<string, string>,
  ) {
    await this.notifications
      .create({ userId, type, title, body, metadata })
      .catch(() => undefined);
  }
}
