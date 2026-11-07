// src/products/products.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProductsService } from './products.service';
import { ProductsController } from './products.controller';
import { Product } from './entities/product.entity';
import { ProductImage } from './entities/product-image.entity';
import { Category } from './entities/category.entity';
import { ProductDraft } from './entities/product-draft.entity';
import { NotificationsModule } from '../notifications/notifications.module';
import { Wishlist } from '../wishlist/entities/wishlist.entity';
import { SearchModule } from '../search/search.module';
import { ListingService } from './listing.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Product,
      ProductImage,
      Category,
      ProductDraft,
      Wishlist,
    ]),
    NotificationsModule,
    SearchModule,
  ],
  controllers: [ProductsController],
  providers: [ProductsService, ListingService],
  exports: [ProductsService, ListingService],
})
export class ProductsModule {}
