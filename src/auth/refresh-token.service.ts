import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { DataSource, IsNull, Repository } from 'typeorm';
import { AppError } from '../common/errors/app-errors';
import { ErrorCode } from '../common/errors/error-codes';
import { AUTH, rotationGraceMs } from './auth.config';
import { RefreshToken } from './entities/refresh-token.entity';

export const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');

const unauthenticated = () =>
  new AppError(
    ErrorCode.UNAUTHENTICATED,
    'Your session has ended. Please log in again.',
  );

/**
 * Opaque refresh tokens with rotation and reuse detection.
 *
 * - Each token is 32 random bytes; only its SHA-256 is stored.
 * - Every refresh exchanges the token for a new one in the same family.
 * - Presenting an already-rotated token (outside a short grace window for
 *   parallel tabs) is treated as theft: the whole family is revoked.
 * - Tokens issued before B2 (JWT strings) are still found by hash and are
 *   treated as their own family, so existing sessions keep working.
 */
@Injectable()
export class RefreshTokenService {
  private readonly logger = new Logger(RefreshTokenService.name);

  constructor(
    @InjectRepository(RefreshToken)
    private readonly tokens: Repository<RefreshToken>,
    @InjectDataSource() private readonly ds: DataSource,
  ) {}

  async issue(
    userId: string,
    opts: { familyId?: string; userAgent?: string } = {},
  ): Promise<{ token: string; familyId: string }> {
    const token = randomBytes(32).toString('base64url');
    const familyId = opts.familyId ?? randomUUID();
    await this.tokens.save(
      this.tokens.create({
        userId,
        tokenHash: sha256(token),
        familyId,
        expiresAt: new Date(Date.now() + AUTH.refreshTtlDays * 86_400_000),
        userAgent: opts.userAgent?.slice(0, 255) ?? null,
      }),
    );
    return { token, familyId };
  }

  /** Exchanges a refresh token for a new one. Throws 401 UNAUTHENTICATED. */
  async rotate(
    raw: string | undefined,
    userAgent?: string,
  ): Promise<{ userId: string; token: string; familyId: string }> {
    if (!raw) throw unauthenticated();
    const hash = sha256(raw);

    const outcome = await this.ds.transaction(async (m) => {
      const row = await m.getRepository(RefreshToken).findOne({
        where: { tokenHash: hash },
        lock: { mode: 'pessimistic_write' },
      });
      if (!row) return { kind: 'missing' as const };
      const familyId = row.familyId ?? row.id;

      if (row.isRevoked) {
        const rotatedRecently =
          row.revokedReason === 'rotated' &&
          row.rotatedAt &&
          Date.now() - row.rotatedAt.getTime() < rotationGraceMs();
        if (row.revokedReason === 'rotated' && !rotatedRecently) {
          return { kind: 'reuse' as const, familyId, userId: row.userId };
        }
        return { kind: 'revoked' as const };
      }
      if (row.expiresAt.getTime() <= Date.now())
        return { kind: 'expired' as const };

      row.isRevoked = true;
      row.revokedReason = 'rotated';
      row.rotatedAt = new Date();
      row.revokedAt = row.rotatedAt;
      await m.save(row);
      return { kind: 'ok' as const, familyId, userId: row.userId };
    });

    if (outcome.kind === 'reuse') {
      this.logger.warn(
        `Refresh token reuse detected for user ${outcome.userId}; revoking family ${outcome.familyId}`,
      );
      await this.revokeFamily(outcome.familyId, 'reuse');
      throw unauthenticated();
    }
    if (outcome.kind !== 'ok') throw unauthenticated();

    const next = await this.issue(outcome.userId, {
      familyId: outcome.familyId,
      userAgent,
    });
    return { userId: outcome.userId, ...next };
  }

  /** Family of a presented token, without rotating it (used by logout). */
  async familyOf(
    raw: string | undefined,
  ): Promise<{ familyId: string; userId: string } | null> {
    if (!raw) return null;
    const row = await this.tokens.findOne({
      where: { tokenHash: sha256(raw) },
    });
    return row
      ? { familyId: row.familyId ?? row.id, userId: row.userId }
      : null;
  }

  async revokeFamily(familyId: string, reason: string): Promise<void> {
    const now = new Date();
    await this.tokens.update(
      { familyId, isRevoked: false },
      { isRevoked: true, revokedAt: now, revokedReason: reason },
    );
    // Pre-B2 rows: the family is the row itself.
    await this.tokens.update(
      { id: familyId, familyId: IsNull(), isRevoked: false },
      { isRevoked: true, revokedAt: now, revokedReason: reason },
    );
  }

  /** Revokes every session of a user, optionally keeping one family. */
  async revokeAllForUser(
    userId: string,
    reason: string,
    exceptFamilyId?: string,
  ): Promise<void> {
    const qb = this.tokens
      .createQueryBuilder()
      .update(RefreshToken)
      .set({ isRevoked: true, revokedAt: () => 'now()', revokedReason: reason })
      .where('"userId" = :userId AND "isRevoked" = false', { userId });
    if (exceptFamilyId) {
      qb.andWhere('COALESCE("familyId", "id") <> :keep', {
        keep: exceptFamilyId,
      });
    }
    await qb.execute();
  }
}
