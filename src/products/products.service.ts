// src/products/products.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import { applyStatus, Product, ProductStatus } from './entities/product.entity';
import { ProductImage } from './entities/product-image.entity';
import { Category } from './entities/category.entity';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { ProductDraft } from './entities/product-draft.entity';
import { CreateDraftDto } from './dto/create-draft.dto';
import { UpdateDraftDto } from './dto/update-draft.dto';
import { PublishDraftDto } from './dto/publish-draft.dto';
import { Wishlist } from '../wishlist/entities/wishlist.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { SearchService } from '../search/search.service';
import {
  categorySlugVariants,
  resolveCategorySlug,
} from '../common/constants/categories';
import { LISTING_LIMITS } from '../common/constants/listing';
import {
  conflict,
  forbidden,
  notFound,
  rateLimited,
  ValidationFailed,
} from '../common/errors/app-errors';
import { MSG } from '../common/errors/messages';
import { listingProblems } from '../common/validation/rules';
import { toFieldErrors } from '../common/validation/validation-errors';

const PRICE_HISTORY_MAX = 20;

@Injectable()
export class ProductsService {
  private readonly logger = new Logger(ProductsService.name);

  constructor(
    @InjectRepository(Product)
    private productsRepository: Repository<Product>,
    @InjectRepository(ProductImage)
    private productImagesRepository: Repository<ProductImage>,
    @InjectRepository(ProductDraft)
    private productDraftsRepository: Repository<ProductDraft>,
    @InjectRepository(Wishlist)
    private wishlistRepository: Repository<Wishlist>,
    @InjectRepository(Category)
    private categoriesRepository: Repository<Category>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly notificationsService: NotificationsService,
    private readonly search: SearchService,
  ) {}

  // ─── WRITES ──────────────────────────────────────────────────

  async create(sellerId: string, dto: CreateProductDto): Promise<Product> {
    const id = await this.dataSource.transaction(async (manager) => {
      const categoryId = await this.resolveCategoryId(dto, manager);
      const [profile] = await manager.query<{ universityId: string | null }[]>(
        `SELECT "universityId" FROM "user_profiles" WHERE "userId" = $1`,
        [sellerId],
      );
      const product = manager.create(Product, {
        sellerId,
        campusId: profile?.universityId ?? null,
        title: dto.title,
        description: dto.description ?? '',
        price: dto.price,
        condition: dto.condition,
        quantity: dto.quantity ?? 1,
        categoryId,
        tags: dto.tags ?? [],
        priceHistory: [],
      });
      applyStatus(product, ProductStatus.ACTIVE);
      const saved = await manager.save(product);
      await this.replaceImages(manager, saved.id, dto.images);
      return saved.id;
    });
    this.search.markDirty();
    return this.loadForResponse(id);
  }

  async update(
    id: string,
    userId: string,
    dto: UpdateProductDto,
  ): Promise<Product> {
    const product = await this.findOwnedForWrite(id, userId);
    if (product.status === ProductStatus.SOLD) {
      throw conflict(MSG.productSoldLocked);
    }
    const priceDrop = await this.dataSource.transaction((manager) =>
      this.applyEdits(manager, product, dto),
    );
    if (priceDrop) this.firePriceDrop(product.id, product.title, priceDrop);
    return this.loadForResponse(id);
  }

  /** Soft delete. Sold items can be deleted too. */
  async remove(id: string, userId: string): Promise<Product> {
    await this.findOwnedForWrite(id, userId);
    await this.productsRepository.softDelete({ id });
    return this.loadForResponse(id, { withDeleted: true });
  }

  /** Idempotent. */
  async markAsSold(id: string, userId: string): Promise<Product> {
    const product = await this.findOwnedForWrite(id, userId);
    if (product.status !== ProductStatus.SOLD) {
      applyStatus(product, ProductStatus.SOLD);
      await this.productsRepository.save(product);
    }
    return this.loadForResponse(id);
  }

  /** Idempotent. Sold, inactive and needs_review items are left as they are. */
  async deactivate(id: string, userId: string): Promise<Product> {
    const product = await this.findOwnedForWrite(id, userId);
    if (product.status === ProductStatus.ACTIVE) {
      applyStatus(product, ProductStatus.INACTIVE);
      await this.productsRepository.save(product);
    }
    return this.loadForResponse(id);
  }

  /**
   * Idempotent. Re-checks the listing first so items hidden by the data
   * clean-up (needs_review) only go live once they meet the rules.
   */
  async activate(id: string, userId: string): Promise<Product> {
    const product = await this.findOwnedForWrite(id, userId);
    if (product.status === ProductStatus.ACTIVE)
      return this.loadForResponse(id);
    if (product.status === ProductStatus.SOLD) {
      throw conflict(MSG.productSoldActivate);
    }
    await this.assertListable(product);
    applyStatus(product, ProductStatus.ACTIVE);
    await this.productsRepository.save(product);
    return this.loadForResponse(id);
  }

  /** Legacy PATCH /:id/unavailable — toggles active/inactive. */
  async markAsUnavailable(id: string, userId: string): Promise<Product> {
    const product = await this.findOwnedForWrite(id, userId);
    if (product.status === ProductStatus.ACTIVE)
      return this.deactivate(id, userId);
    if (product.status === ProductStatus.SOLD) return this.loadForResponse(id);
    return this.activate(id, userId);
  }

  /**
   * Makes a sold/inactive/needs_review item active again, optionally applying
   * edits in the same call (the only way to edit a sold item). createdAt is
   * bumped to now at most once per 24 hours. Relisting an item that is already
   * active only bumps it, and returns 429 inside the 24h window.
   */
  async relist(
    id: string,
    userId: string,
    dto?: UpdateProductDto,
  ): Promise<Product> {
    const product = await this.findOwnedForWrite(id, userId);
    const wasActive = product.status === ProductStatus.ACTIVE;
    if (wasActive && !(await this.canBump(id))) {
      throw rateLimited(MSG.relistTooSoon);
    }

    const priceDrop = await this.dataSource.transaction(async (manager) => {
      const drop = dto ? await this.applyEdits(manager, product, dto) : null;
      await this.assertListable(product, manager);
      applyStatus(product, ProductStatus.ACTIVE);
      await manager.save(product);
      await manager.query(
        `UPDATE "products"
            SET "createdAt" = now(), "lastBumpedAt" = now()
          WHERE "id" = $1
            AND ("lastBumpedAt" IS NULL
                 OR "lastBumpedAt" <= now() - ($2 || ' hours')::interval)`,
        [id, String(LISTING_LIMITS.bumpIntervalHours)],
      );
      return drop;
    });
    if (priceDrop) this.firePriceDrop(product.id, product.title, priceDrop);
    return this.loadForResponse(id);
  }

  // ─── READS ───────────────────────────────────────────────────

  async findBySeller(
    sellerId: string,
    page: number = 1,
    limit: number = 10,
    status: 'all' | 'active' | 'inactive' | 'sold' = 'all',
  ): Promise<{
    data: Product[];
    total: number;
    page: number;
    limit: number;
    stats: {
      totalProducts: number;
      activeProducts: number;
      inactiveProducts: number;
      soldProducts: number;
      totalViews: number;
    };
  }> {
    const validPage = page < 1 ? 1 : page;
    const validLimit = limit < 1 || limit > 100 ? 10 : limit;

    const where: Record<string, unknown> = { sellerId };
    if (status === 'active') {
      where.isAvailable = true;
      where.isSold = false;
    } else if (status === 'inactive') {
      where.isAvailable = false;
      where.isSold = false;
    } else if (status === 'sold') {
      where.isSold = true;
    }

    const [products, total] = await this.productsRepository.findAndCount({
      where,
      relations: ['category', 'images'],
      skip: (validPage - 1) * validLimit,
      take: validLimit,
      order: { createdAt: 'DESC' },
    });

    const allProducts = await this.productsRepository.find({
      where: { sellerId },
      select: ['isAvailable', 'isSold', 'viewCount'],
    });

    return {
      data: products,
      total,
      page: validPage,
      limit: validLimit,
      stats: {
        totalProducts: allProducts.length,
        activeProducts: allProducts.filter((p) => p.isAvailable && !p.isSold)
          .length,
        inactiveProducts: allProducts.filter((p) => !p.isAvailable && !p.isSold)
          .length,
        soldProducts: allProducts.filter((p) => p.isSold).length,
        totalViews: allProducts.reduce((sum, p) => sum + (p.viewCount || 0), 0),
      },
    };
  }

  async getMyProductStats(sellerId: string): Promise<{
    total: number;
    active: number;
    inactive: number;
    sold: number;
  }> {
    const products = await this.productsRepository.find({
      where: { sellerId },
      select: ['isAvailable', 'isSold'],
    });
    return {
      total: products.length,
      active: products.filter((p) => p.isAvailable && !p.isSold).length,
      inactive: products.filter((p) => !p.isAvailable && !p.isSold).length,
      sold: products.filter((p) => p.isSold).length,
    };
  }

  async getFeaturedProducts(limit: number = 10): Promise<Product[]> {
    return this.productsRepository.find({
      where: { isFeatured: true, isAvailable: true },
      relations: ['seller', 'seller.profile', 'category', 'images'],
      take: limit,
      order: { createdAt: 'DESC' },
    });
  }

  async getRecommendedProducts(
    userId: string,
    limit: number = 10,
  ): Promise<Product[]> {
    return this.productsRepository
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

  // ─── DRAFTS ──────────────────────────────────────────────────

  async createDraft(
    sellerId: string,
    createDraftDto: CreateDraftDto,
  ): Promise<ProductDraft> {
    const draft = this.productDraftsRepository.create({
      sellerId,
      ...(await this.draftColumns(createDraftDto)),
    });
    return this.productDraftsRepository.save(draft);
  }

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
    const validPage = page < 1 ? 1 : page;
    const validLimit = limit < 1 || limit > 100 ? 10 : limit;
    const [drafts, total] = await this.productDraftsRepository.findAndCount({
      where: { sellerId },
      skip: (validPage - 1) * validLimit,
      take: validLimit,
      order: { updatedAt: 'DESC' },
    });
    return { data: drafts, total, page: validPage, limit: validLimit };
  }

  async getDraftById(id: string, sellerId: string): Promise<ProductDraft> {
    const draft = await this.productDraftsRepository.findOne({
      where: { id, sellerId },
    });
    if (!draft) throw notFound('We couldn’t find that draft.');
    return draft;
  }

  async updateDraft(
    id: string,
    sellerId: string,
    updateDraftDto: UpdateDraftDto,
  ): Promise<ProductDraft> {
    const draft = await this.getDraftById(id, sellerId);
    Object.assign(draft, await this.draftColumns(updateDraftDto));
    return this.productDraftsRepository.save(draft);
  }

  async deleteDraft(id: string, sellerId: string): Promise<void> {
    const draft = await this.getDraftById(id, sellerId);
    await this.productDraftsRepository.remove(draft);
  }

  /**
   * Publishes a draft. The merged data goes through exactly the same schema
   * as POST /products, so drafts can't bypass the listing rules.
   */
  async publishDraft(
    draftId: string,
    sellerId: string,
    publishData?: PublishDraftDto,
  ): Promise<Product> {
    const draft = await this.getDraftById(draftId, sellerId);
    const draftPrice =
      draft.price === undefined || draft.price === null
        ? undefined
        : Number(draft.price);

    const merged = {
      title: publishData?.title ?? draft.title,
      description: publishData?.description ?? draft.description,
      price: publishData?.price ?? draftPrice,
      condition: publishData?.condition ?? draft.condition,
      quantity: publishData?.quantity ?? draft.quantity ?? 1,
      category: publishData?.category,
      categoryId: publishData?.category
        ? undefined
        : (publishData?.categoryId ?? draft.categoryId),
      images: publishData?.images ?? draft.images ?? [],
      tags: publishData?.tags ?? draft.tags ?? [],
    };
    const plain = Object.fromEntries(
      Object.entries(merged).filter(([, v]) => v !== undefined && v !== null),
    );
    const dto = plainToInstance(CreateProductDto, plain);
    const errors = await validate(dto, { whitelist: true });
    if (errors.length) {
      throw new ValidationFailed(toFieldErrors(errors), MSG.draftIncomplete);
    }

    const product = await this.create(sellerId, dto);
    await this.productDraftsRepository.remove(draft);
    return product;
  }

  async getDraftStats(sellerId: string): Promise<{
    totalDrafts: number;
    completeDrafts: number;
    incompleteDrafts: number;
  }> {
    const drafts = await this.productDraftsRepository.find({
      where: { sellerId },
    });
    const complete = drafts.filter(
      (d) => d.title && d.price && d.condition && d.images?.length,
    ).length;
    return {
      totalDrafts: drafts.length,
      completeDrafts: complete,
      incompleteDrafts: drafts.length - complete,
    };
  }

  async autoSaveDraft(
    sellerId: string,
    draftId: string | null,
    draftData: CreateDraftDto | UpdateDraftDto,
  ): Promise<ProductDraft> {
    if (draftId) {
      const existing = await this.productDraftsRepository.findOne({
        where: { id: draftId, sellerId },
      });
      if (existing) return this.updateDraft(draftId, sellerId, draftData);
    }
    return this.createDraft(sellerId, draftData as CreateDraftDto);
  }

  // ─── HELPERS ─────────────────────────────────────────────────

  /** Maps a validated draft DTO onto draft columns (category slug -> id). */
  private async draftColumns(
    dto: CreateDraftDto | UpdateDraftDto,
  ): Promise<Partial<ProductDraft>> {
    const { category, ...rest } = dto;
    const columns: Partial<ProductDraft> = { ...rest };
    if (category) {
      columns.categoryId = await this.resolveCategoryId(
        { category },
        this.dataSource.manager,
      );
    }
    return columns;
  }

  /** Loads a live (not deleted) product and checks ownership: 404, then 403. */
  private async findOwnedForWrite(
    id: string,
    userId: string,
  ): Promise<Product> {
    const product = await this.productsRepository.findOne({
      where: { id },
      relations: ['images'],
    });
    if (!product) throw notFound(MSG.productNotFound);
    if (product.sellerId !== userId) throw forbidden(MSG.productNotOwner);
    return product;
  }

  /** The object every write returns, so the UI never has to refetch. */
  private async loadForResponse(
    id: string,
    opts: { withDeleted?: boolean } = {},
  ): Promise<Product> {
    const product = await this.productsRepository.findOne({
      where: { id },
      relations: ['category', 'images'],
      order: { images: { sortOrder: 'ASC' } },
      withDeleted: opts.withDeleted ?? false,
    });
    if (!product) throw notFound(MSG.productNotFound);
    return product;
  }

  /**
   * Applies a validated partial update. Returns the price drop (if any) so the
   * caller can notify wishlisters after the transaction commits.
   */
  private async applyEdits(
    manager: EntityManager,
    product: Product,
    dto: UpdateProductDto,
  ): Promise<{ oldPrice: number; newPrice: number } | null> {
    if (dto.title !== undefined) product.title = dto.title;
    if (dto.description !== undefined)
      product.description = dto.description ?? '';
    if (dto.condition !== undefined) product.condition = dto.condition;
    if (dto.quantity !== undefined) product.quantity = dto.quantity;
    if (dto.tags !== undefined) product.tags = dto.tags ?? [];
    if (dto.category !== undefined || dto.categoryId !== undefined) {
      product.categoryId = await this.resolveCategoryId(dto, manager);
      product.category = undefined;
    }

    let drop: { oldPrice: number; newPrice: number } | null = null;
    if (dto.price !== undefined && dto.price !== Number(product.price)) {
      const oldPrice = Number(product.price);
      product.priceHistory = [
        ...(product.priceHistory ?? []),
        { oldPrice, newPrice: dto.price, changedAt: new Date().toISOString() },
      ].slice(-PRICE_HISTORY_MAX);
      product.price = dto.price;
      if (dto.price < oldPrice) drop = { oldPrice, newPrice: dto.price };
    }

    const images = product.images;
    delete (product as Partial<Product>).images;
    await manager.save(product);
    if (dto.images !== undefined) {
      product.images = await this.replaceImages(
        manager,
        product.id,
        dto.images,
      );
    } else {
      product.images = images;
    }
    return drop;
  }

  private async replaceImages(
    manager: EntityManager,
    productId: string,
    urls: string[],
  ): Promise<ProductImage[]> {
    await manager.delete(ProductImage, { productId });
    const images = urls.map((imageUrl, index) =>
      manager.create(ProductImage, {
        productId,
        imageUrl,
        isPrimary: index === 0,
        sortOrder: index,
      }),
    );
    return manager.save(images);
  }

  /**
   * Resolves `category` (slug) or legacy `categoryId` to an active category
   * row that belongs to the shared list (common/constants/categories.ts).
   * Matching is alias-aware so databases seeded with older slugs still work.
   */
  private async resolveCategoryId(
    dto: { category?: string; categoryId?: string },
    manager: EntityManager,
  ): Promise<string> {
    const repo = manager.getRepository(Category);
    if (dto.category) {
      const rows = await repo.find({
        where: { slug: In(categorySlugVariants(dto.category)), isActive: true },
      });
      const row = rows.find((r) => r.slug === dto.category) ?? rows[0] ?? null;
      if (!row) {
        this.logger.warn(
          `Category "${dto.category}" is in the shared list but not in the database. Run npm run seed:categories.`,
        );
        throw new ValidationFailed({ category: MSG.categoryUnavailable });
      }
      return row.id;
    }
    const row = dto.categoryId
      ? await repo.findOne({ where: { id: dto.categoryId } })
      : null;
    if (!row || !row.isActive || !resolveCategorySlug(row.slug)) {
      throw new ValidationFailed({ categoryId: MSG.categoryInvalid });
    }
    return row.id;
  }

  private async assertListable(
    product: Product,
    manager?: EntityManager,
  ): Promise<void> {
    const imageCount = await (manager ?? this.dataSource.manager).count(
      ProductImage,
      {
        where: { productId: product.id },
      },
    );
    const problems = listingProblems({
      title: product.title,
      description: product.description,
      price: product.price,
      quantity: product.quantity,
      imageCount,
    });
    if (Object.keys(problems).length) throw new ValidationFailed(problems);
  }

  private async canBump(id: string): Promise<boolean> {
    const rows: unknown[] = await this.productsRepository.query(
      `SELECT 1 FROM "products"
        WHERE "id" = $1
          AND ("lastBumpedAt" IS NULL
               OR "lastBumpedAt" <= now() - ($2 || ' hours')::interval)`,
      [id, String(LISTING_LIMITS.bumpIntervalHours)],
    );
    return rows.length > 0;
  }

  private firePriceDrop(
    productId: string,
    title: string,
    drop: { oldPrice: number; newPrice: number },
  ): void {
    this.notifyWishlistersOfPriceDrop(
      productId,
      title,
      drop.oldPrice,
      drop.newPrice,
    ).catch((err) =>
      this.logger.error('Failed to send price drop notifications', err.stack),
    );
  }

  private async notifyWishlistersOfPriceDrop(
    productId: string,
    productTitle: string,
    oldPrice: number,
    newPrice: number,
  ): Promise<void> {
    const wishlistEntries = await this.wishlistRepository.find({
      where: { productId },
    });
    for (const entry of wishlistEntries) {
      await this.notificationsService.notifyPriceDrop(
        entry.userId,
        productTitle,
        oldPrice,
        newPrice,
        productId,
      );
    }
    if (wishlistEntries.length > 0) {
      this.logger.log(
        `Sent price drop notifications to ${wishlistEntries.length} users for product ${productId}`,
      );
    }
  }
}
