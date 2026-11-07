import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { rateLimited, ValidationFailed } from '../common/errors/app-errors';
import { RateLimitService } from '../common/rate-limit/rate-limit.service';
import { User } from '../users/entities/user.entity';
import { toPublicUser } from '../users/user.service';
import { ACCOUNT_DELETION_GRACE_DAYS } from '../moderation/maintenance.service';

@Injectable()
export class PrivacyService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly rateLimit: RateLimitService,
  ) {}

  /**
   * Everything we hold about the person, in one JSON document. Reports they
   * filed are included; reports ABOUT them are not (reporters stay private).
   */
  async export(user: User) {
    const limit = await this.rateLimit.consume(
      RateLimitService.key('export', user.id),
      3,
      86_400_000,
    );
    if (!limit.allowed)
      throw rateLimited(
        'You can download your data 3 times a day.',
        limit.retryAfterSeconds,
      );
    const q = <T>(sql: string) => this.ds.query<T[]>(sql, [user.id]);
    const [listings, wishlist, messages, reports, notifications, blocks] =
      await Promise.all([
        q(
          `SELECT id, title, description, price, condition, quantity, status, tags, "createdAt", "updatedAt", "deletedAt" FROM products WHERE "sellerId" = $1`,
        ),
        q(`SELECT "productId", "createdAt" FROM wishlists WHERE "userId" = $1`),
        q(
          `SELECT id, "conversationId", content, type, "createdAt" FROM messages WHERE "senderId" = $1 AND type <> 'system'`,
        ),
        q(
          `SELECT id, "targetType", "targetId", reason, details, status, "createdAt" FROM reports WHERE "reporterId" = $1`,
        ),
        q(
          `SELECT id, type, title, body, "isRead", "createdAt" FROM notifications WHERE "userId" = $1`,
        ),
        q(
          `SELECT "blockedId", "createdAt" FROM user_blocks WHERE "blockerId" = $1`,
        ),
      ]);
    return {
      exportedAt: new Date().toISOString(),
      account: toPublicUser(user),
      listings,
      wishlist,
      messagesSent: messages,
      reportsFiled: reports,
      notifications,
      blockedUsers: blocks,
    };
  }

  async requestDeletion(user: User, confirm: string) {
    if (confirm !== 'DELETE') {
      throw new ValidationFailed({ confirm: 'Type DELETE to confirm.' });
    }
    await this.ds.transaction(async (m) => {
      await m.query(
        `UPDATE users SET "deletionRequestedAt" = now(), "tokensValidAfter" = now() WHERE id = $1`,
        [user.id],
      );
      await m.query(
        `UPDATE products SET status = 'inactive', "isAvailable" = false WHERE "sellerId" = $1 AND status = 'active'`,
        [user.id],
      );
      await m.query(
        `UPDATE refresh_tokens SET "isRevoked" = true, "revokedAt" = now(), "revokedReason" = 'account_deletion' WHERE "userId" = $1 AND "isRevoked" = false`,
        [user.id],
      );
    });
    const deleteAfter = new Date(
      Date.now() + ACCOUNT_DELETION_GRACE_DAYS * 86_400_000,
    );
    return {
      message: `Your account will be deleted on ${deleteAfter.toISOString().slice(0, 10)}. Log in before then to cancel.`,
      deleteAfter: deleteAfter.toISOString(),
    };
  }

  async recordConsents(
    user: User,
    dto: { termsVersion?: string; privacyVersion?: string },
  ) {
    if (!dto.termsVersion && !dto.privacyVersion) {
      throw new ValidationFailed({
        termsVersion: 'Send termsVersion and/or privacyVersion.',
      });
    }
    const sets: string[] = [];
    const params: unknown[] = [user.id];
    if (dto.termsVersion) {
      params.push(dto.termsVersion);
      sets.push(
        `"acceptedTermsVersion" = $${params.length}, "acceptedTermsAt" = now()`,
      );
    }
    if (dto.privacyVersion) {
      params.push(dto.privacyVersion);
      sets.push(
        `"acceptedPrivacyVersion" = $${params.length}, "acceptedPrivacyAt" = now()`,
      );
    }
    await this.ds.query(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $1`,
      params,
    );
    const [row] = await this.ds.query<Record<string, unknown>[]>(
      `SELECT "acceptedTermsVersion", "acceptedTermsAt", "acceptedPrivacyVersion", "acceptedPrivacyAt" FROM users WHERE id = $1`,
      [user.id],
    );
    return row;
  }
}
