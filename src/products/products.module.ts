// src/products/products.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProductsService } from './products.service';
import { ProductsController } from './products.controller';
import { Product } from './entities/product.entity';
import { ProductImage } from './entities/product-image.entity';
import { Category } from './entities/category.entity';
import { ProductDraft } from './entities/product-draft.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([Product, ProductImage, Category, ProductDraft]),
  ],
  controllers: [ProductsController],
  providers: [ProductsService],
  exports: [ProductsService],
})
export class ProductsModule {}
