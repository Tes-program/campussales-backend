import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { CACHE_TTL, CacheService, CK } from '../common/cache/cache.service';
import { CategoriesService } from '../categories/categories.service';
import { ChatService } from '../chat/chat.service';
import { FeedService } from '../feed/feed.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ListingService } from '../products/listing.service';
import { ListProductsQueryDto } from '../products/dto/list-products.dto';
import { ProductCard } from '../products/product-card';
import { SchoolsService } from '../universities/schools.service';
import { User } from '../users/entities/user.entity';
import { toPublicUser } from '../users/user.service';
import { UPLOAD_RULES } from '../uploads/upload-rules';
import { featureFlags } from './feature-flags';

/** First screen only: the frontend loads more with the normal endpoints. */
export const BOOTSTRAP_FEED_SIZE = 12;
export const BOOTSTRAP_WISHLIST_MAX = 200;

/**
 * Everything the first screen needs in one round trip. Each part is an
 * existing, independently cached read, run in parallel; the old endpoints
 * keep working for clients that don't use this yet (frontend F5 flag).
 */
@Injectable()
export class BootstrapService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly cache: CacheService,
    private readonly categories: CategoriesService,
    private readonly schools: SchoolsService,
    private readonly listing: ListingService,
    private readonly feed: FeedService,
    private readonly notifications: NotificationsService,
    private readonly chat: ChatService,
    private readonly config: ConfigService,
  ) {}

  /** Categories, school list version, flags, upload config: same for everyone. */
  private staticPart() {
    return this.cache.wrap(
      `${CK.bootstrap}static`,
      CACHE_TTL.bootstrapStatic,
      async () => {
        const [categories, schools] = await Promise.all([
          this.categories.listWithCounts(),
          this.schools.version(),
        ]);
        return {
          categories,
          schools,
          flags: featureFlags(),
          config: {
            cloudinaryCloudName:
              this.config.get<string>('CLOUDINARY_CLOUD_NAME') ?? null,
            uploads: {
              maxBytes: UPLOAD_RULES.maxBytes,
              formats: UPLOAD_RULES.formats,
              maxImagesPerListing: UPLOAD_RULES.maxImagesPerListing,
            },
          },
        };
      },
    );
  }

  private latestFeed(): Promise<{
    items: ProductCard[];
    nextCursor: string | null;
  }> {
    const dto = Object.assign(new ListProductsQueryDto(), {
      limit: BOOTSTRAP_FEED_SIZE,
    });
    return this.listing
      .list(dto)
      .then((r) => ({ items: r.items, nextCursor: r.nextCursor }));
  }

  async forVisitor() {
    const [s, feed] = await Promise.all([this.staticPart(), this.latestFeed()]);
    return {
      user: null,
      counts: null,
      wishlist: null,
      ...s,
      feed: { source: 'latest' as const, ...feed },
      generatedAt: new Date().toISOString(),
    };
  }

  async forUser(user: User) {
    const [s, feed, notifications, messages, wishlist] = await Promise.all([
      this.staticPart(),
      this.feed.feed(user, 0, BOOTSTRAP_FEED_SIZE),
      this.notifications.getUnreadCount(user.id),
      this.chat.getTotalUnreadCount(user.id),
      this.ds.query<{ productId: string }[]>(
        `SELECT w."productId" FROM "wishlists" w
          WHERE w."userId" = $1 ORDER BY w."createdAt" DESC LIMIT ${BOOTSTRAP_WISHLIST_MAX}`,
        [user.id],
      ),
    ]);
    return {
      user: toPublicUser(user),
      counts: {
        unreadNotifications: notifications.count,
        unreadMessages: messages,
      },
      wishlist: { productIds: wishlist.map((w) => w.productId) },
      ...s,
      feed: { source: 'personal' as const, ...feed },
      generatedAt: new Date().toISOString(),
    };
  }
}
