import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Wishlist } from './entities/wishlist.entity';
import { Product } from '../products/entities/product.entity';
import { AddToWishlistDto } from './dto/add-to-wishlist.dto';

@Injectable()
export class WishlistService {
  constructor(
    @InjectRepository(Wishlist)
    private wishlistRepository: Repository<Wishlist>,
    @InjectRepository(Product)
    private productRepository: Repository<Product>,
  ) {}

  /**
   * Add product to user's wishlist
   */
  async addToWishlist(
    userId: string,
    addToWishlistDto: AddToWishlistDto,
  ): Promise<Wishlist> {
    try {
      const { productId } = addToWishlistDto;

      if (!userId || !productId) {
        throw new BadRequestException(
          'User ID and Product ID are required',
        );
      }

      // Check if product exists
      const product = await this.productRepository.findOne({
        where: { id: productId },
      });

      if (!product) {
        throw new NotFoundException(
          'Product not found or has been removed',
        );
      }

      if (!product.isAvailable) {
        throw new BadRequestException(
          'This product is no longer available',
        );
      }

      // Prevent users from adding their own products to wishlist
      if (product.sellerId === userId) {
        throw new BadRequestException(
          'You cannot add your own product to your wishlist',
        );
      }

      // Check if already in wishlist
      const existingWishlistItem = await this.wishlistRepository.findOne({
        where: { userId, productId },
      });

      if (existingWishlistItem) {
        throw new ConflictException(
          'This product is already in your wishlist',
        );
      }

      // Add to wishlist
      const wishlistItem = this.wishlistRepository.create({
        userId,
        productId,
      });

      return await this.wishlistRepository.save(wishlistItem);
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof NotFoundException ||
        error instanceof ConflictException
      ) {
        throw error;
      }
      throw new BadRequestException('Failed to add product to wishlist');
    }
  }

  /**
   * Remove product from wishlist
   */
  async removeFromWishlist(userId: string, productId: string): Promise<void> {
    if (!userId || !productId) {
      throw new BadRequestException('User ID and Product ID are required');
    }

    const wishlistItem = await this.wishlistRepository.findOne({
      where: { userId, productId },
    });

    if (!wishlistItem) {
      throw new NotFoundException(
        'Product not found in your wishlist',
      );
    }

    await this.wishlistRepository.remove(wishlistItem);
  }

  /**
   * Get user's wishlist with pagination
   */
  async getUserWishlist(
    userId: string,
    page: number = 1,
    limit: number = 10,
  ): Promise<{
    data: Wishlist[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const skip = (page - 1) * limit;

    const [wishlistItems, total] = await this.wishlistRepository.findAndCount({
      where: { userId },
      relations: [
        'product',
        'product.images',
        'product.seller',
        'product.seller.profile',
        'product.category',
      ],
      skip,
      take: limit,
      order: { createdAt: 'DESC' },
    });

    // Filter out products that are no longer available (soft deleted)
    const availableItems = wishlistItems.filter(
      (item) => item.product && item.product.isAvailable !== false,
    );

    return {
      data: availableItems,
      total: availableItems.length,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Check if product is in user's wishlist
   */
  async isInWishlist(userId: string, productId: string): Promise<boolean> {
    const wishlistItem = await this.wishlistRepository.findOne({
      where: { userId, productId },
    });

    return !!wishlistItem;
  }

  /**
   * Get wishlist count for user
   */
  async getWishlistCount(userId: string): Promise<number> {
    return await this.wishlistRepository.count({
      where: { userId },
    });
  }

  /**
   * Toggle product in wishlist (add if not exists, remove if exists)
   */
  async toggleWishlist(
    userId: string,
    productId: string,
  ): Promise<{ added: boolean; message: string }> {
    const existingItem = await this.wishlistRepository.findOne({
      where: { userId, productId },
    });

    if (existingItem) {
      await this.wishlistRepository.remove(existingItem);
      return {
        added: false,
        message: 'Product removed from wishlist',
      };
    } else {
      // Check if product exists
      const product = await this.productRepository.findOne({
        where: { id: productId },
      });

      if (!product) {
        throw new NotFoundException('Product not found');
      }

      // Prevent users from adding their own products
      if (product.sellerId === userId) {
        throw new BadRequestException(
          'You cannot add your own product to wishlist',
        );
      }

      const wishlistItem = this.wishlistRepository.create({
        userId,
        productId,
      });

      await this.wishlistRepository.save(wishlistItem);

      return {
        added: true,
        message: 'Product added to wishlist',
      };
    }
  }

  /**
   * Clear all wishlist items for user
   */
  async clearWishlist(userId: string): Promise<void> {
    await this.wishlistRepository.delete({ userId });
  }

  /**
   * Get wishlist items by product IDs (bulk check)
   */
  async checkMultipleProducts(
    userId: string,
    productIds: string[],
  ): Promise<{ [productId: string]: boolean }> {
    try {
      if (!userId) {
        throw new BadRequestException('User ID is required');
      }

      if (!productIds || productIds.length === 0) {
        return {};
      }

      const wishlistItems = await this.wishlistRepository.find({
        where: { userId },
        select: ['productId'],
      });

      const wishlistProductIds = new Set(
        wishlistItems.map((item) => item.productId),
      );

      const result: { [productId: string]: boolean } = {};
      productIds.forEach((productId) => {
        result[productId] = wishlistProductIds.has(productId);
      });

      return result;
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      throw new BadRequestException('Failed to check products in wishlist');
    }
  }

  /**
   * Get wishlist statistics for user
   */
  async getWishlistStats(userId: string): Promise<{
    totalItems: number;
    availableItems: number;
    unavailableItems: number;
    totalValue: number;
    categories: Array<{ categoryName: string; count: number }>;
  }> {
    const wishlistItems = await this.wishlistRepository.find({
      where: { userId },
      relations: ['product', 'product.category'],
    });

    const availableItems = wishlistItems.filter(
      (item) => item.product?.isAvailable === true,
    );
    const unavailableItems = wishlistItems.filter(
      (item) => !item.product || item.product.isAvailable === false,
    );

    const totalValue = availableItems.reduce((sum, item) => {
      return sum + (Number(item.product.price) || 0);
    }, 0);

    // Group by categories
    const categoryMap = new Map<string, number>();
    availableItems.forEach((item) => {
      const categoryName = item.product?.category?.name || 'Uncategorized';
      categoryMap.set(categoryName, (categoryMap.get(categoryName) || 0) + 1);
    });

    const categories = Array.from(categoryMap.entries())
      .map(([categoryName, count]) => ({ categoryName, count }))
      .sort((a, b) => b.count - a.count);

    return {
      totalItems: wishlistItems.length,
      availableItems: availableItems.length,
      unavailableItems: unavailableItems.length,
      totalValue,
      categories,
    };
  }

  /**
   * Get popular wishlist items (most wishlisted products)
   */
  async getPopularWishlistItems(limit: number = 10): Promise<
    Array<{
      product: Product;
      wishlistCount: number;
    }>
  > {
    const results = await this.wishlistRepository
      .createQueryBuilder('wishlist')
      .leftJoinAndSelect('wishlist.product', 'product')
      .leftJoinAndSelect('product.images', 'images')
      .leftJoinAndSelect('product.seller', 'seller')
      .leftJoinAndSelect('seller.profile', 'profile')
      .leftJoinAndSelect('product.category', 'category')
      .where('product.isAvailable = :isAvailable', { isAvailable: true })
      .select('product')
      .addSelect('COUNT(wishlist.id)', 'wishlistCount')
      .groupBy('product.id')
      .addGroupBy('images.id')
      .addGroupBy('seller.id')
      .addGroupBy('profile.id')
      .addGroupBy('category.id')
      .orderBy('wishlistCount', 'DESC')
      .limit(limit)
      .getRawAndEntities();

    return results.entities.map((wishlist, index) => ({
      product: wishlist.product,
      wishlistCount: parseInt(results.raw[index].wishlistCount) || 0,
    }));
  }

  /**
   * Remove unavailable products from all wishlists (cleanup job)
   */
  async removeUnavailableProducts(): Promise<number> {
    const unavailableWishlistItems = await this.wishlistRepository
      .createQueryBuilder('wishlist')
      .leftJoin('wishlist.product', 'product')
      .where('product.isAvailable = :isAvailable', { isAvailable: false })
      .orWhere('product.id IS NULL')
      .getMany();

    if (unavailableWishlistItems.length > 0) {
      await this.wishlistRepository.remove(unavailableWishlistItems);
    }

    return unavailableWishlistItems.length;
  }
}
