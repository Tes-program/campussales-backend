// src/categories/categories.service.ts
import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Category } from '../products/entities/category.entity';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { CACHE_TTL, CacheService, CK } from '../common/cache/cache.service';
import { ListingCacheInvalidator } from '../common/cache/listing-cache';

export interface CategoryWithCount {
  id: string;
  slug: string;
  name: string;
  iconUrl: string | null;
  count: number;
}

@Injectable()
export class CategoriesService {
  constructor(
    @InjectRepository(Category)
    private categoriesRepository: Repository<Category>,
    private readonly cache: CacheService,
    private readonly invalidator: ListingCacheInvalidator,
  ) {}

  /**
   * Active categories with the number of live listings in each (one
   * grouped query, cached 60 s; invalidated by listing writes).
   */
  async listWithCounts(): Promise<CategoryWithCount[]> {
    return this.cache.wrap(
      `${CK.categories}counts`,
      CACHE_TTL.categoryCounts,
      async () => {
        const rows = await this.categoriesRepository.query(
          `SELECT c."id", c."slug", c."name", c."iconUrl",
                  count(p."id")::int AS "count"
             FROM "categories" c
             LEFT JOIN "products" p
               ON p."categoryId" = c."id" AND p."status" = 'active'
              AND p."deletedAt" IS NULL AND p."moderationStatus" = 'approved'
            WHERE c."isActive" = true
            GROUP BY c."id"
            ORDER BY c."name" ASC`,
        );
        return (rows as CategoryWithCount[]).map((r) => ({
          id: r.id,
          slug: r.slug,
          name: r.name,
          iconUrl: r.iconUrl ?? null,
          count: Number(r.count),
        }));
      },
    );
  }

  /**
   * Create a new category
   */
  async create(createCategoryDto: CreateCategoryDto): Promise<Category> {
    // Check if slug already exists
    const existingCategory = await this.findBySlug(createCategoryDto.slug);
    if (existingCategory) {
      throw new ConflictException('Category with this slug already exists');
    }

    const category = this.categoriesRepository.create(createCategoryDto);
    const saved = await this.categoriesRepository.save(category);
    this.invalidator.categoriesChanged();
    return saved;
  }

  /**
   * Get all categories with optional filtering
   */
  async findAll(includeInactive: boolean = false): Promise<Category[]> {
    const whereCondition = includeInactive ? {} : { isActive: true };
    return this.cache.wrap(
      `${CK.categories}all:${includeInactive}`,
      CACHE_TTL.categories,
      () =>
        this.categoriesRepository.find({
          where: whereCondition,
          order: { name: 'ASC' },
        }),
    );
  }

  /**
   * Get active categories only (for public display)
   */
  async findActive(): Promise<Category[]> {
    return this.findAll(false);
  }

  /**
   * Get category by ID
   */
  async findOne(id: string): Promise<Category> {
    const category = await this.categoriesRepository.findOne({
      where: { id },
      relations: ['products'],
    });

    if (!category) {
      throw new NotFoundException('Category not found');
    }

    return category;
  }

  /**
   * Get category by slug
   */
  async findBySlug(slug: string): Promise<Category | null> {
    return await this.categoriesRepository.findOne({
      where: { slug },
      relations: ['products'],
    });
  }

  /**
   * Get category by slug or throw error
   */
  async findBySlugOrFail(slug: string): Promise<Category> {
    const category = await this.findBySlug(slug);

    if (!category) {
      throw new NotFoundException('Category not found');
    }

    return category;
  }

  /**
   * Update category
   */
  async update(
    id: string,
    updateCategoryDto: UpdateCategoryDto,
  ): Promise<Category> {
    const category = await this.findOne(id);

    // Check if new slug conflicts with existing category
    if (updateCategoryDto.slug && updateCategoryDto.slug !== category.slug) {
      const existingCategory = await this.findBySlug(updateCategoryDto.slug);
      if (existingCategory && existingCategory.id !== id) {
        throw new ConflictException('Category with this slug already exists');
      }
    }

    Object.assign(category, updateCategoryDto);
    const saved = await this.categoriesRepository.save(category);
    this.invalidator.categoriesChanged();
    return saved;
  }

  /**
   * Soft delete - mark as inactive
   */
  async softDelete(id: string): Promise<void> {
    const category = await this.findOne(id);
    category.isActive = false;
    await this.categoriesRepository.save(category);
    this.invalidator.categoriesChanged();
  }

  /**
   * Hard delete - permanent removal
   */
  async hardDelete(id: string): Promise<void> {
    const category = await this.findOne(id);

    // Check if category has products
    const productCount = await this.categoriesRepository
      .createQueryBuilder('category')
      .leftJoin('category.products', 'product')
      .where('category.id = :id', { id })
      .getCount();

    if (productCount > 0) {
      throw new BadRequestException(
        'Cannot delete category with existing products. Please reassign or delete products first.',
      );
    }

    await this.categoriesRepository.remove(category);
    this.invalidator.categoriesChanged();
  }

  /**
   * Get categories with product count
   */
  async getCategoriesWithStats(): Promise<
    Array<{
      id: string;
      name: string;
      slug: string;
      description: string;
      iconUrl: string;
      isActive: boolean;
      productCount: number;
      activeProductCount: number;
    }>
  > {
    const categories = await this.categoriesRepository
      .createQueryBuilder('category')
      .leftJoin('category.products', 'product')
      .select('category.id', 'id')
      .addSelect('category.name', 'name')
      .addSelect('category.slug', 'slug')
      .addSelect('category.description', 'description')
      .addSelect('category.iconUrl', 'iconUrl')
      .addSelect('category.isActive', 'isActive')
      .addSelect('COUNT(product.id)', 'productCount')
      .addSelect(
        'COUNT(CASE WHEN product.isAvailable = true THEN 1 END)',
        'activeProductCount',
      )
      .groupBy('category.id')
      .orderBy('category.name', 'ASC')
      .getRawMany();

    return categories.map((cat) => ({
      id: cat.id,
      name: cat.name,
      slug: cat.slug,
      description: cat.description,
      iconUrl: cat.iconUrl,
      isActive: cat.isActive,
      productCount: parseInt(cat.productCount) || 0,
      activeProductCount: parseInt(cat.activeProductCount) || 0,
    }));
  }

  /**
   * Search categories by name
   */
  async searchCategories(query: string): Promise<Category[]> {
    try {
      if (!query || query.trim().length === 0) {
        return [];
      }

      return await this.categoriesRepository
        .createQueryBuilder('category')
        .where('category.isActive = :isActive', { isActive: true })
        .andWhere(
          '(category.name ILIKE :query OR category.description ILIKE :query)',
          { query: `%${query}%` },
        )
        .orderBy('category.name', 'ASC')
        .getMany();
    } catch {
      throw new NotFoundException('Failed to search categories');
    }
  }

  /**
   * Toggle category active status
   */
  async toggleActive(id: string): Promise<Category> {
    const category = await this.findOne(id);
    category.isActive = !category.isActive;
    const saved = await this.categoriesRepository.save(category);
    this.invalidator.categoriesChanged();
    return saved;
  }

  /**
   * Get popular categories based on product count
   */
  async getPopularCategories(limit: number = 10): Promise<
    Array<{
      category: Category;
      productCount: number;
    }>
  > {
    const results = await this.categoriesRepository
      .createQueryBuilder('category')
      .leftJoin(
        'category.products',
        'product',
        'product.isAvailable = :isAvailable',
        {
          isAvailable: true,
        },
      )
      .where('category.isActive = :isActive', { isActive: true })
      .select('category')
      .addSelect('COUNT(product.id)', 'productCount')
      .groupBy('category.id')
      .orderBy('productCount', 'DESC')
      .limit(limit)
      .getRawAndEntities();

    return results.entities.map((category, index) => ({
      category,
      productCount: parseInt(results.raw[index].productCount) || 0,
    }));
  }

  /**
   * Bulk create categories (useful for seeding)
   */
  async bulkCreate(categories: CreateCategoryDto[]): Promise<Category[]> {
    const createdCategories: Category[] = [];

    for (const categoryDto of categories) {
      try {
        const category = await this.create(categoryDto);
        createdCategories.push(category);
      } catch (error) {
        // Skip if already exists
        if (error instanceof ConflictException) {
          continue;
        }
        throw error;
      }
    }

    return createdCategories;
  }
}
