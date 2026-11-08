import { Global, Module } from '@nestjs/common';
import { CacheService } from './cache.service';
import {
  ListingCacheInvalidator,
  ProductCacheSubscriber,
} from './listing-cache';

@Global()
@Module({
  providers: [CacheService, ListingCacheInvalidator, ProductCacheSubscriber],
  exports: [CacheService, ListingCacheInvalidator],
})
export class AppCacheModule {}
