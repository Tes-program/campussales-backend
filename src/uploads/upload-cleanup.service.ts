import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { RateLimitService } from '../common/rate-limit/rate-limit.service';
import { CloudinaryClient } from './cloudinary.client';
import { parseCloudinaryUrl } from './cloudinary-url';
import { UPLOAD_RULES } from './upload-rules';

export type CleanupMode = 'dry-run' | 'delete' | 'off';

export interface CleanupReport {
  mode: CleanupMode;
  orphanUploads: number;
  deletedListingImages: number;
  publicIds: string[];
  deleted: number;
}

const BATCH = 500;

export function cleanupMode(): CleanupMode {
  const v = process.env.UPLOAD_CLEANUP_MODE;
  return v === 'delete' || v === 'off' ? v : 'dry-run';
}

/**
 * Hourly image housekeeping (one instance per hour via a Redis lock):
 *  - uploads (signed or legacy) not attached to any listing, draft, avatar or chat message
 *    24 hours after upload are deleted from Cloudinary
 *  - images of listings soft-deleted more than 30 days ago are deleted
 *
 * UPLOAD_CLEANUP_MODE=dry-run (the default) only logs what would be deleted;
 * set it to `delete` after reviewing a dry run in production, or `off`.
 */
@Injectable()
export class UploadCleanupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('UploadCleanup');
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly cloud: CloudinaryClient,
    private readonly rateLimit: RateLimitService,
  ) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.tick(), 60 * 60_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (cleanupMode() === 'off') return;
    const lock = await this.rateLimit.consume(
      RateLimitService.key('hourly-job', 'upload-cleanup'),
      1,
      55 * 60_000,
    );
    if (!lock.allowed) return;
    try {
      await this.run(cleanupMode());
    } catch (e) {
      this.logger.error(`Upload clean-up failed: ${(e as Error).message}`);
    }
  }

  /** Uploads nothing points at, older than 24 h. */
  private findOrphans() {
    return this.ds.query<
      { id: string; publicId: string | null; url: string }[]
    >(
      `SELECT u."id", u."cloudinaryPublicId" AS "publicId", u."url"
         FROM "uploads" u
        WHERE u."status" <> 'deleted'
          AND u."createdAt" < now() - ($1 || ' hours')::interval
          AND NOT EXISTS (SELECT 1 FROM "product_images" pi
                           WHERE pi."publicId" = u."cloudinaryPublicId"
                              OR (u."url" <> '' AND pi."imageUrl" = u."url"))
          AND NOT EXISTS (SELECT 1 FROM "user_profiles" up
                           WHERE u."url" <> '' AND up."profilePictureUrl" = u."url")
          -- C1: completed chat photos are referenced by public id inside
          -- messages.attachments; they are never cleaned up.
          AND NOT (u."status" = 'ready' AND coalesce(u."cloudinaryPublicId", '') LIKE 'campussales/chat/%')
          -- legacy chat photos: the client sends the image URL as the message
          -- content or attachmentUrl (equality, so Postgres can hash-join)
          AND NOT EXISTS (SELECT 1 FROM "messages" m
                           WHERE u."url" <> ''
                             AND (m."attachmentUrl" = u."url" OR m."content" = u."url"))
          AND NOT EXISTS (SELECT 1 FROM "product_drafts" d
                           WHERE d."images" IS NOT NULL
                             AND strpos(d."images", coalesce(u."cloudinaryPublicId", u."url")) > 0)
        ORDER BY u."createdAt"
        LIMIT ${BATCH}`,
      [String(UPLOAD_RULES.orphanAfterHours)],
    );
  }

  /** Images of listings deleted more than 30 days ago. */
  private findDeletedListingImages() {
    return this.ds.query<
      { id: string; publicId: string | null; imageUrl: string }[]
    >(
      `SELECT pi."id", pi."publicId", pi."imageUrl"
         FROM "product_images" pi
         JOIN "products" p ON p."id" = pi."productId"
        WHERE p."deletedAt" IS NOT NULL
          AND p."deletedAt" < now() - ($1 || ' days')::interval
        LIMIT ${BATCH}`,
      [String(UPLOAD_RULES.deletedListingImageDays)],
    );
  }

  async run(mode: CleanupMode): Promise<CleanupReport> {
    const cloud = this.cloud.cloudName;
    // Only ever delete files in our own Cloudinary account.
    const ours = (publicId: string | null, url: string) => {
      if (publicId) return publicId;
      const ref = parseCloudinaryUrl(url);
      return ref && ref.cloudName === cloud ? ref.publicId : null;
    };
    const orphans = await this.findOrphans();
    const listingImages = await this.findDeletedListingImages();
    const publicIds = [
      ...new Set(
        [
          ...orphans.map((o) => ours(o.publicId, o.url)),
          ...listingImages.map((i) => ours(i.publicId, i.imageUrl)),
        ].filter((x): x is string => !!x),
      ),
    ];
    const report: CleanupReport = {
      mode,
      orphanUploads: orphans.length,
      deletedListingImages: listingImages.length,
      publicIds,
      deleted: 0,
    };
    if (mode !== 'delete') {
      this.logger.log(
        `[dry run] would delete ${orphans.length} orphan upload(s) and ${listingImages.length} image(s) of deleted listings: ${publicIds.slice(0, 20).join(', ')}${publicIds.length > 20 ? ` (+${publicIds.length - 20} more)` : ''}`,
      );
      return report;
    }
    if (publicIds.length) {
      if (!this.cloud.configured()) {
        this.logger.warn('Cloudinary not configured; skipping file deletion');
        return report;
      }
      await this.cloud.destroy(publicIds);
    }
    if (orphans.length) {
      await this.ds.query(
        `UPDATE "uploads" SET "status" = 'deleted' WHERE "id" = ANY($1)`,
        [orphans.map((o) => o.id)],
      );
    }
    if (listingImages.length) {
      await this.ds.query(`DELETE FROM "product_images" WHERE "id" = ANY($1)`, [
        listingImages.map((i) => i.id),
      ]);
      await this.ds.query(
        `UPDATE "uploads" SET "status" = 'deleted' WHERE "cloudinaryPublicId" = ANY($1)`,
        [publicIds],
      );
    }
    report.deleted = publicIds.length;
    this.logger.log(
      `Deleted ${publicIds.length} image(s): ${orphans.length} orphan upload(s), ${listingImages.length} from deleted listings`,
    );
    return report;
  }
}
