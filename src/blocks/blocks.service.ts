import { ListingCacheInvalidator } from '../common/cache/listing-cache';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  AppError,
  notFound,
  ValidationFailed,
} from '../common/errors/app-errors';
import { ErrorCode } from '../common/errors/error-codes';
import { User } from '../users/entities/user.entity';
import { UserBlock } from './user-block.entity';

@Injectable()
export class BlocksService {
  constructor(
    @InjectRepository(UserBlock) private readonly blocks: Repository<UserBlock>,
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly listingCache: ListingCacheInvalidator,
  ) {}

  /** Idempotent. Blocking hides both users' listings, chats and messages from each other. */
  async block(blockerId: string, blockedId: string) {
    if (blockerId === blockedId) {
      throw new ValidationFailed({ userId: "You can't block yourself." });
    }
    if (!(await this.users.exist({ where: { id: blockedId } }))) {
      throw notFound("We couldn't find that person.");
    }
    await this.blocks
      .createQueryBuilder()
      .insert()
      .values({ blockerId, blockedId })
      .orIgnore()
      .execute();
    this.listingCache.viewerChanged(blockerId, blockedId);
    return { userId: blockedId, blocked: true };
  }

  /** Idempotent. */
  async unblock(blockerId: string, blockedId: string): Promise<void> {
    await this.blocks.delete({ blockerId, blockedId });
    this.listingCache.viewerChanged(blockerId, blockedId);
  }

  async list(blockerId: string) {
    const rows = await this.blocks.find({
      where: { blockerId },
      relations: ['blocked', 'blocked.profile'],
      order: { createdAt: 'DESC' },
    });
    return {
      items: rows.map((r) => ({
        userId: r.blockedId,
        username: r.blocked?.username ?? null,
        firstName: r.blocked?.profile?.firstName ?? null,
        avatar: r.blocked?.profile?.profilePictureUrl ?? null,
        blockedAt: r.createdAt.toISOString(),
      })),
    };
  }

  async isBlockedEitherWay(a: string, b: string): Promise<boolean> {
    return this.blocks.exist({
      where: [
        { blockerId: a, blockedId: b },
        { blockerId: b, blockedId: a },
      ],
    });
  }

  /** Throws 403 BLOCKED with a neutral message. */
  async assertNotBlocked(a: string, b: string): Promise<void> {
    if (await this.isBlockedEitherWay(a, b))
      throw new AppError(ErrorCode.BLOCKED);
  }
}
