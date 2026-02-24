/* eslint-disable @typescript-eslint/no-unused-vars */
// src/products/products.service.ts
import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Product } from './entities/product.entity';
import { ProductImage } from './entities/product-image.entity';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { FilterProductDto } from './dto/filter-product.dto';
import { ProductDraft } from './entities/product-draft.entity';
import { CreateDraftDto } from './dto/create-draft.dto';
import { UpdateDraftDto } from './dto/update-draft.dto';
import { PublishDraftDto } from './dto/publish-draft.dto';

@Injectable()
export class ProductsService {
  constructor(
    @InjectRepository(Product)
    private productsRepository: Repository<Product>,
    @InjectRepository(ProductImage)
    private productImagesRepository: Repository<ProductImage>,
    @InjectRepository(ProductDraft)
    private productDraftsRepository: Repository<ProductDraft>,
  ) {}

  async create(
    sellerId: string,
    createProductDto: CreateProductDto,
  ): Promise<Product> {
    try {
      // Validate required fields
      if (!sellerId) {
        throw new ForbiddenException('Seller ID is required');
      }

      if (!createProductDto.title || !createProductDto.price) {
        throw new ForbiddenException('Title and price are required');
      }

      if (createProductDto.price < 0) {
        throw new ForbiddenException('Price must be a positive number');
      }

      if (createProductDto.quantity && createProductDto.quantity < 0) {
        throw new ForbiddenException('Quantity must be a positive number');
      }

      // Create product
      const product = this.productsRepository.create({
        sellerId,
        title: createProductDto.title,
        description: createProductDto.description,
        price: createProductDto.price,
        condition: createProductDto.condition,
        quantity: createProductDto.quantity || 1,
        categoryId: createProductDto.categoryId,
      });

      const savedProduct = await this.productsRepository.save(product);

      // Add images if provided
      if (createProductDto.images && createProductDto.images.length > 0) {
        const images = createProductDto.images.map((imageUrl, index) =>
          this.productImagesRepository.create({
            productId: savedProduct.id,
            imageUrl,
            isPrimary: index === 0,
            sortOrder: index,
          }),
        );

        await this.productImagesRepository.save(images);
        savedProduct.images = images;
      }

      return savedProduct;
    } catch (error) {
      if (error instanceof ForbiddenException) {
        throw error;
      }
      throw new ForbiddenException('Failed to create product');
    }
  }

  async findAll(
    filterDto: FilterProductDto,
  ): Promise<{ data: Product[]; total: number; page: number; limit: number }> {
    try {
      const {
        page = 1,
        limit = 10,
        categoryId,
        sellerId,
        condition,
        minPrice,
        maxPrice,
        search,
        sortBy = 'createdAt',
        sortOrder = 'DESC',
        universityId,
      } = filterDto;

      // Validate pagination
      const validPage = page < 1 ? 1 : page;
      const validLimit = limit < 1 || limit > 100 ? 10 : limit;

      const queryBuilder = this.productsRepository
        .createQueryBuilder('product')
        .leftJoinAndSelect('product.seller', 'seller')
        .leftJoinAndSelect('seller.profile', 'profile')
        .leftJoinAndSelect('profile.university', 'university')
        .leftJoinAndSelect('product.category', 'category')
        .leftJoinAndSelect('product.images', 'images')
        .where('product.isAvailable = :isAvailable', { isAvailable: true });

      // Apply filters
      if (categoryId) {
        queryBuilder.andWhere('product.categoryId = :categoryId', {
          categoryId,
        });
      }

      if (sellerId) {
        queryBuilder.andWhere('product.sellerId = :sellerId', { sellerId });
      }

      if (condition) {
        queryBuilder.andWhere('product.condition = :condition', { condition });
      }

      if (minPrice !== undefined && maxPrice !== undefined) {
        queryBuilder.andWhere('product.price BETWEEN :minPrice AND :maxPrice', {
          minPrice,
          maxPrice,
        });
      } else if (minPrice !== undefined) {
        queryBuilder.andWhere('product.price >= :minPrice', { minPrice });
      } else if (maxPrice !== undefined) {
        queryBuilder.andWhere('product.price <= :maxPrice', { maxPrice });
      }

      if (universityId) {
        queryBuilder.andWhere('university.id = :universityId', {
          universityId,
        });
      }

      if (search) {
        queryBuilder.andWhere(
          '(product.title ILIKE :search OR product.description ILIKE :search)',
          { search: `%${search}%` },
        );
      }

      // Sorting
      queryBuilder.orderBy(`product.${sortBy}`, sortOrder);

      // Pagination
      const skip = (validPage - 1) * validLimit;
      queryBuilder.skip(skip).take(validLimit);

      const [products, total] = await queryBuilder.getManyAndCount();

      return {
        data: products,
        total,
        page: validPage,
        limit: validLimit,
      };
    } catch (error) {
      throw new NotFoundException('Failed to fetch products');
    }
  }

  async findOne(id: string): Promise<Product> {
    if (!id) {
      throw new NotFoundException('Product ID is required');
    }

    const product = await this.productsRepository.findOne({
      where: { id },
      relations: [
        'seller',
        'seller.profile',
        'seller.profile.university',
        'category',
        'images',
      ],
    });

    if (!product) {
      throw new NotFoundException('Product not found or has been removed');
    }

    // Increment view count
    await this.productsRepository.increment({ id }, 'viewCount', 1);

    return product;
  }

  async findBySeller(
    sellerId: string,
    page: number = 1,
    limit: number = 10,
    status: 'all' | 'active' | 'inactive' = 'all',
  ): Promise<{
    data: Product[];
    total: number;
    page: number;
    limit: number;
    stats: {
      totalProducts: number;
      activeProducts: number;
      inactiveProducts: number;
      totalViews: number;
    };
  }> {
    try {
      const validPage = page < 1 ? 1 : page;
      const validLimit = limit < 1 || limit > 100 ? 10 : limit;

      // Build where condition based on status
      const where: any = { sellerId };

      if (status === 'active') {
        where.isAvailable = true;
      } else if (status === 'inactive') {
        where.isAvailable = false;
      }

      const [products, total] = await this.productsRepository.findAndCount({
        where,
        relations: ['category', 'images'],
        skip: (validPage - 1) * validLimit,
        take: validLimit,
        order: { createdAt: 'DESC' },
      });

      // Get full stats (all products, not just current page)
      const allProducts = await this.productsRepository.find({
        where: { sellerId },
        select: ['isAvailable', 'viewCount'],
      });

      const activeProducts = allProducts.filter((p) => p.isAvailable).length;
      const inactiveProducts = allProducts.filter((p) => !p.isAvailable).length;
      const totalViews = allProducts.reduce(
        (sum, p) => sum + (p.viewCount || 0),
        0,
      );

      return {
        data: products,
        total,
        page: validPage,
        limit: validLimit,
        stats: {
          totalProducts: allProducts.length,
          activeProducts,
          inactiveProducts,
          totalViews,
        },
      };
    } catch (error) {
      throw new NotFoundException('Failed to fetch user products');
    }
  }

  async update(
    id: string,
    userId: string,
    updateProductDto: UpdateProductDto,
  ): Promise<Product> {
    try {
      if (!id || !userId) {
        throw new ForbiddenException('Product ID and User ID are required');
      }

      // Validate price and quantity if provided
      if (updateProductDto.price !== undefined && updateProductDto.price < 0) {
        throw new ForbiddenException('Price must be a positive number');
      }

      if (
        updateProductDto.quantity !== undefined &&
        updateProductDto.quantity < 0
      ) {
        throw new ForbiddenException('Quantity must be a positive number');
      }

      const product = await this.productsRepository.findOne({
        where: { id },
        relations: ['images'],
      });

      if (!product) {
        throw new NotFoundException('Product not found or has been removed');
      }

      // Check ownership
      if (product.sellerId !== userId) {
        throw new ForbiddenException(
          'You do not have permission to update this product',
        );
      }

      // Update product fields
      Object.assign(product, updateProductDto);

      const updatedProduct = await this.productsRepository.save(product);

      // Update images if provided
      if (updateProductDto.images) {
        // Delete existing images
        await this.productImagesRepository.delete({ productId: id });

        // Add new images
        const images = updateProductDto.images.map((imageUrl, index) =>
          this.productImagesRepository.create({
            productId: id,
            imageUrl,
            isPrimary: index === 0,
            sortOrder: index,
          }),
        );

        await this.productImagesRepository.save(images);
        updatedProduct.images = images;
      }

      return updatedProduct;
    } catch (error) {
      if (
        error instanceof NotFoundException ||
        error instanceof ForbiddenException
      ) {
        throw error;
      }
      throw new ForbiddenException('Failed to update product');
    }
  }

  async remove(id: string, userId: string): Promise<void> {
    if (!id || !userId) {
      throw new ForbiddenException('Product ID and User ID are required');
    }

    const product = await this.productsRepository.findOne({ where: { id } });

    if (!product) {
      throw new NotFoundException(
        'Product not found or has already been deleted',
      );
    }

    // Check ownership
    if (product.sellerId !== userId) {
      throw new ForbiddenException(
        'You do not have permission to delete this product',
      );
    }

    await this.productsRepository.remove(product);
  }

  async markAsUnavailable(id: string, userId: string): Promise<Product> {
    if (!id || !userId) {
      throw new ForbiddenException('Product ID and User ID are required');
    }

    const product = await this.productsRepository.findOne({ where: { id } });

    if (!product) {
      throw new NotFoundException('Product not found');
    }

    // Check ownership
    if (product.sellerId !== userId) {
      throw new ForbiddenException(
        'You do not have permission to modify this product',
      );
    }

    product.isAvailable = false;
    return await this.productsRepository.save(product);
  }

  async getFeaturedProducts(limit: number = 10): Promise<Product[]> {
    return await this.productsRepository.find({
      where: { isFeatured: true, isAvailable: true },
      relations: ['seller', 'seller.profile', 'category', 'images'],
      take: limit,
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Create a new draft
   */
  async createDraft(
    sellerId: string,
    createDraftDto: CreateDraftDto,
  ): Promise<ProductDraft> {
    try {
      if (!sellerId) {
        throw new ForbiddenException('Seller ID is required');
      }

      const draft = this.productDraftsRepository.create({
        sellerId,
        ...createDraftDto,
      });

      return await this.productDraftsRepository.save(draft);
    } catch (error) {
      if (error instanceof ForbiddenException) {
        throw error;
      }
      throw new ForbiddenException('Failed to create draft');
    }
  }

  /**
   * Get all drafts for a user
   */
  async getUserDrafts(
    sellerId: string,
    page: number = 1,
    limit: number = 10,
  ): Promise<{
    data: ProductDraft[];
    total: number;
    page: number;
    limit: number;
  }> {
    try {
      const validPage = page < 1 ? 1 : page;
      const validLimit = limit < 1 || limit > 100 ? 10 : limit;

      const [drafts, total] = await this.productDraftsRepository.findAndCount({
        where: { sellerId },
        skip: (validPage - 1) * validLimit,
        take: validLimit,
        order: { updatedAt: 'DESC' },
      });

      return {
        data: drafts,
        total,
        page: validPage,
        limit: validLimit,
      };
    } catch (error) {
      throw new NotFoundException('Failed to fetch drafts');
    }
  }

  /**
   * Get draft by ID
   */
  async getDraftById(id: string, sellerId: string): Promise<ProductDraft> {
    if (!id || !sellerId) {
      throw new NotFoundException('Draft ID and Seller ID are required');
    }

    const draft = await this.productDraftsRepository.findOne({
      where: { id, sellerId },
    });

    if (!draft) {
      throw new NotFoundException('Draft not found or access denied');
    }

    return draft;
  }

  /**
   * Update draft
   */
  async updateDraft(
    id: string,
    sellerId: string,
    updateDraftDto: UpdateDraftDto,
  ): Promise<ProductDraft> {
    try {
      const draft = await this.getDraftById(id, sellerId);

      Object.assign(draft, updateDraftDto);

      return await this.productDraftsRepository.save(draft);
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      throw new ForbiddenException('Failed to update draft');
    }
  }

  /**
   * Delete draft
   */
  async deleteDraft(id: string, sellerId: string): Promise<void> {
    const draft = await this.getDraftById(id, sellerId);
    await this.productDraftsRepository.remove(draft);
  }

  /**
   * Publish draft (convert draft to product)
   */
  async publishDraft(
    draftId: string,
    sellerId: string,
    publishData?: PublishDraftDto,
  ): Promise<Product> {
    try {
      const draft = await this.getDraftById(draftId, sellerId);

      // Merge publish data with draft data (publish data overrides draft)
      const productData = {
        title: publishData?.title ?? draft.title,
        description: publishData?.description ?? draft.description,
        price: publishData?.price ?? draft.price,
        condition: publishData?.condition ?? draft.condition,
        quantity: publishData?.quantity ?? draft.quantity ?? 1,
        categoryId: publishData?.categoryId ?? draft.categoryId,
        images: publishData?.images ?? draft.images,
        tags: publishData?.tags ?? draft.tags,
      };

      // Validate required fields
      if (
        !productData.title ||
        !productData.description ||
        !productData.price ||
        !productData.condition
      ) {
        throw new ForbiddenException(
          'Cannot publish incomplete draft. Missing required fields: title, description, price, or condition',
        );
      }

      // Create product from draft
      const product = this.productsRepository.create({
        sellerId,
        title: productData.title,
        description: productData.description,
        price: productData.price,
        condition: productData.condition,
        quantity: productData.quantity || 1,
        categoryId: productData.categoryId,
      });

      const savedProduct = await this.productsRepository.save(product);

      // Add images if provided
      if (productData.images && productData.images.length > 0) {
        const images = productData.images.map((imageUrl, index) =>
          this.productImagesRepository.create({
            productId: savedProduct.id,
            imageUrl,
            isPrimary: index === 0,
            sortOrder: index,
          }),
        );

        await this.productImagesRepository.save(images);
        savedProduct.images = images;
      }

      // Delete the draft after successful publication
      await this.productDraftsRepository.remove(draft);

      return savedProduct;
    } catch (error) {
      if (
        error instanceof NotFoundException ||
        error instanceof ForbiddenException
      ) {
        throw error;
      }
      throw new ForbiddenException('Failed to publish draft');
    }
  }

  /**
   * Get draft statistics
   */
  async getDraftStats(sellerId: string): Promise<{
    totalDrafts: number;
    completeDrafts: number;
    incompleteDrafts: number;
  }> {
    const drafts = await this.productDraftsRepository.find({
      where: { sellerId },
    });

    const completeDrafts = drafts.filter(
      (draft) =>
        draft.title && draft.description && draft.price && draft.condition,
    );

    return {
      totalDrafts: drafts.length,
      completeDrafts: completeDrafts.length,
      incompleteDrafts: drafts.length - completeDrafts.length,
    };
  }

  /**
   * Auto-save draft (upsert operation)
   * Creates if doesn't exist, updates if exists
   */
  async autoSaveDraft(
    sellerId: string,
    draftId: string | null,
    draftData: CreateDraftDto | UpdateDraftDto,
  ): Promise<ProductDraft> {
    try {
      if (draftId) {
        // Update existing draft
        return await this.updateDraft(draftId, sellerId, draftData);
      } else {
        // Create new draft
        return await this.createDraft(sellerId, draftData as CreateDraftDto);
      }
    } catch (error) {
      if (error instanceof NotFoundException) {
        // If draft not found, create new one
        return await this.createDraft(sellerId, draftData as CreateDraftDto);
      }
      throw error;
    }
  }

  async getRecommendedProducts(
    userId: string,
    limit: number = 10,
  ): Promise<Product[]> {
    // Simple recommendation based on user's university
    // You can enhance this with more sophisticated algorithms later
    return await this.productsRepository
      .createQueryBuilder('product')
      .leftJoinAndSelect('product.seller', 'seller')
      .leftJoinAndSelect('seller.profile', 'profile')
      .leftJoinAndSelect('product.category', 'category')
      .leftJoinAndSelect('product.images', 'images')
      .where('product.isAvailable = :isAvailable', { isAvailable: true })
      .andWhere('product.sellerId != :userId', { userId })
      .orderBy('product.viewCount', 'DESC')
      .take(limit)
      .getMany();
  }
}
