// src/products/products.controller.ts
import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  UseGuards,
  ParseUUIDPipe,
  Logger,
  HttpCode,
  HttpStatus,
  Res,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { ProductsService } from './products.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { ListProductsQueryDto } from './dto/list-products.dto';
import { ListingService } from './listing.service';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import { ValidationFailed } from '../common/errors/app-errors';
import { createHash } from 'crypto';
import type { Response } from 'express';
import { ProductDraft } from './entities/product-draft.entity';
import { CreateDraftDto } from './dto/create-draft.dto';
import { UpdateDraftDto } from './dto/update-draft.dto';
import { PublishDraftDto } from './dto/publish-draft.dto';
import { AutoSaveDraftDto } from './dto/auto-save-draft.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { EmailVerifiedGuard } from '../auth/guards/email-verified.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';
import { Product } from './entities/product.entity';

@ApiTags('Products')
@Controller('products')
export class ProductsController {
  private readonly logger = new Logger(ProductsController.name);

  constructor(
    private readonly productsService: ProductsService,
    private readonly listing: ListingService,
  ) {}

  @Post()
  @UseGuards(JwtAuthGuard, EmailVerifiedGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a new product' })
  @ApiResponse({ status: 201, description: 'Product created successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 400, description: 'Invalid product data' })
  async create(
    @CurrentUser() user: User,
    @Body() createProductDto: CreateProductDto,
  ) {
    this.logger.log(
      `User ${user.id} creating new product: ${createProductDto.title}`,
    );
    return await this.productsService.create(user.id, createProductDto);
  }

  @Get()
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOperation({
    summary:
      'List and search listings. Public. Cursor pagination; legacy page/search/categoryId params still work.',
  })
  @ApiResponse({
    status: 200,
    description:
      '{ items, nextCursor, total, totalCapped, didYouMean, fromOtherCampuses, moreFromNearby, data, page, limit }',
  })
  @ApiResponse({ status: 400, description: 'VALIDATION_FAILED with fields' })
  async findAll(
    @Query() query: ListProductsQueryDto,
    @CurrentUser() viewer?: User,
  ) {
    return this.listing.list(query, viewer);
  }

  @Get('featured')
  @ApiOperation({ summary: 'Get featured products' })
  @ApiResponse({ status: 200, description: 'Featured products retrieved' })
  async getFeaturedProducts(@Query('limit') limit: number = 10) {
    this.logger.log(`Fetching ${limit} featured products`);
    return await this.productsService.getFeaturedProducts(limit);
  }

  @Get('recommended')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get recommended products for user' })
  @ApiResponse({ status: 200, description: 'Recommended products retrieved' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getRecommendedProducts(
    @CurrentUser() user: User,
    @Query('limit') limit: number = 10,
  ) {
    this.logger.log(
      `Fetching ${limit} recommended products for user ${user.id}`,
    );
    return await this.productsService.getRecommendedProducts(user.id, limit);
  }

  // --- Static & draft routes BEFORE parameterized :id routes ---

  @Get('my-products')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current user products' })
  @ApiQuery({ name: 'page', required: false, example: 1 })
  @ApiQuery({ name: 'limit', required: false, example: 10 })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['all', 'active', 'inactive', 'sold'],
    example: 'all',
  })
  @ApiResponse({ status: 200, description: 'User products retrieved' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getMyProducts(
    @CurrentUser() user: User,
    @Query('page') page: number = 1,
    @Query('limit') limit: number = 10,
    @Query('status') status: 'all' | 'active' | 'inactive' | 'sold' = 'all',
  ) {
    this.logger.log(
      `User ${user.id} fetching own products (status: ${status})`,
    );
    return await this.productsService.findBySeller(
      user.id,
      page,
      limit,
      status,
    );
  }

  @Get('my-products/stats')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current user product statistics' })
  @ApiResponse({ status: 200, description: 'Product stats retrieved' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getMyProductStats(@CurrentUser() user: User) {
    this.logger.log(`User ${user.id} fetching product stats`);
    return await this.productsService.getMyProductStats(user.id);
  }

  @Post('drafts')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a new product draft' })
  @ApiResponse({ status: 201, description: 'Draft created successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async createDraft(
    @CurrentUser() user: User,
    @Body() createDraftDto: CreateDraftDto,
  ): Promise<ProductDraft> {
    this.logger.log(`User ${user.id} creating product draft`);
    return await this.productsService.createDraft(user.id, createDraftDto);
  }

  @Post('drafts/auto-save')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Auto-save draft (create or update)' })
  @ApiResponse({ status: 200, description: 'Draft auto-saved successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async autoSaveDraft(
    @CurrentUser() user: User,
    @Body() body: AutoSaveDraftDto,
  ): Promise<ProductDraft> {
    this.logger.log(`User ${user.id} auto-saving draft`);
    return await this.productsService.autoSaveDraft(
      user.id,
      body.draftId || null,
      body.data,
    );
  }

  @Get('drafts')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get user drafts' })
  @ApiResponse({ status: 200, description: 'Drafts retrieved successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getUserDrafts(
    @CurrentUser() user: User,
    @Query('page') page: number = 1,
    @Query('limit') limit: number = 10,
  ) {
    this.logger.log(`User ${user.id} fetching drafts`);
    return await this.productsService.getUserDrafts(user.id, page, limit);
  }

  @Get('drafts/stats')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get draft statistics' })
  @ApiResponse({ status: 200, description: 'Draft stats retrieved' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getDraftStats(@CurrentUser() user: User) {
    return await this.productsService.getDraftStats(user.id);
  }

  @Get('drafts/:id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get draft by ID' })
  @ApiResponse({ status: 200, description: 'Draft found' })
  @ApiResponse({ status: 404, description: 'Draft not found' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getDraft(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ProductDraft> {
    this.logger.log(`User ${user.id} fetching draft ${id}`);
    return await this.productsService.getDraftById(id, user.id);
  }

  @Patch('drafts/:id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update draft' })
  @ApiResponse({ status: 200, description: 'Draft updated successfully' })
  @ApiResponse({ status: 404, description: 'Draft not found' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async updateDraft(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateDraftDto: UpdateDraftDto,
  ): Promise<ProductDraft> {
    this.logger.log(`User ${user.id} updating draft ${id}`);
    return await this.productsService.updateDraft(id, user.id, updateDraftDto);
  }

  @Delete('drafts/:id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete draft' })
  @ApiResponse({ status: 204, description: 'Draft deleted successfully' })
  @ApiResponse({ status: 404, description: 'Draft not found' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async deleteDraft(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    this.logger.log(`User ${user.id} deleting draft ${id}`);
    await this.productsService.deleteDraft(id, user.id);
  }

  @Post('drafts/:id/publish')
  @UseGuards(JwtAuthGuard, EmailVerifiedGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Publish draft as product' })
  @ApiResponse({ status: 201, description: 'Draft published successfully' })
  @ApiResponse({
    status: 400,
    description: 'Draft incomplete - missing required fields',
  })
  @ApiResponse({ status: 404, description: 'Draft not found' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async publishDraft(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body()
    publishDraftDto?: PublishDraftDto,
  ): Promise<Product> {
    this.logger.log(`User ${user.id} publishing draft ${id}`);
    return await this.productsService.publishDraft(
      id,
      user.id,
      publishDraftDto,
    );
  }

  // --- Parameterized :id routes LAST ---

  @Get(':id')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOperation({
    summary:
      'Public item page. Sold/inactive return 200 with status; deleted 404. Adds isOwner/isWishlisted when logged in.',
  })
  @ApiResponse({
    status: 200,
    description: 'Product with seller block and ISO dates',
  })
  @ApiResponse({ status: 304, description: 'Not modified (If-None-Match)' })
  @ApiResponse({ status: 404, description: 'NOT_FOUND' })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) res: Response,
    @CurrentUser() viewer?: User,
  ) {
    const item = await this.listing.item(id, viewer);
    if (viewer) {
      res.setHeader('Cache-Control', 'private, no-store');
    } else {
      // viewCount changes on every view; leave it out of the validator.
      const stable: Partial<typeof item> = { ...item };
      delete stable.viewCount;
      res.setHeader(
        'ETag',
        `W/"${createHash('sha1').update(JSON.stringify(stable)).digest('base64url')}"`,
      );
      res.setHeader('Cache-Control', 'public, max-age=60');
    }
    return item;
  }

  @Get(':id/similar')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOperation({
    summary: 'Similar items: same category, same campus first, 50-200% price.',
  })
  async similar(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('limit') limitRaw?: string,
    @CurrentUser() viewer?: User,
  ) {
    const limit = limitRaw === undefined ? 8 : Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
      throw new ValidationFailed({ limit: 'Show between 1 and 20 items.' });
    }
    return { items: await this.listing.similar(id, limit, viewer) };
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Edit a listing (any subset of fields). Records priceHistory on price change.',
  })
  @ApiResponse({ status: 200, description: 'Updated product' })
  @ApiResponse({ status: 400, description: 'VALIDATION_FAILED' })
  @ApiResponse({ status: 403, description: 'FORBIDDEN - not the owner' })
  @ApiResponse({ status: 404, description: 'NOT_FOUND - missing or deleted' })
  @ApiResponse({
    status: 409,
    description: 'CONFLICT - item is sold; relist instead',
  })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: User,
    @Body() updateProductDto: UpdateProductDto,
  ) {
    this.logger.log(`User ${user.id} updating product: ${id}`);
    return this.productsService.update(id, user.id, updateProductDto);
  }

  @Post(':id/relist')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, EmailVerifiedGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Make a sold/inactive item active again (optional edits in body). Bumps createdAt at most once per 24h.',
  })
  @ApiResponse({ status: 200, description: 'Updated product' })
  @ApiResponse({
    status: 429,
    description: 'RATE_LIMITED - already bumped in last 24h',
  })
  async relist(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: User,
    @Body() body: UpdateProductDto,
  ) {
    return this.productsService.relist(id, user.id, body);
  }

  @Post(':id/sold')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Mark as sold (idempotent)' })
  @ApiResponse({ status: 200, description: 'Updated product' })
  async markSold(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: User,
  ) {
    return this.productsService.markAsSold(id, user.id);
  }

  @Post(':id/deactivate')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Hide an active listing (idempotent)' })
  @ApiResponse({ status: 200, description: 'Updated product' })
  async deactivate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: User,
  ) {
    return this.productsService.deactivate(id, user.id);
  }

  @Post(':id/activate')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Show an inactive listing again (idempotent). Sold items need relist.',
  })
  @ApiResponse({ status: 200, description: 'Updated product' })
  @ApiResponse({ status: 409, description: 'CONFLICT - item is sold' })
  async activate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: User,
  ) {
    return this.productsService.activate(id, user.id);
  }

  /** @deprecated use POST /:id/deactivate or /:id/activate */
  @Patch(':id/unavailable')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Deprecated: toggle active/inactive',
    deprecated: true,
  })
  async markAsUnavailable(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: User,
  ) {
    return this.productsService.markAsUnavailable(id, user.id);
  }

  /** @deprecated use POST /:id/sold */
  @Patch(':id/sold')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Deprecated: mark as sold', deprecated: true })
  async markAsSold(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: User,
  ) {
    return this.productsService.markAsSold(id, user.id);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Soft delete. Removed from every list and search; wishlists show it as no longer available.',
  })
  @ApiResponse({ status: 200, description: 'Deleted product (deletedAt set)' })
  @ApiResponse({ status: 403, description: 'FORBIDDEN - not the owner' })
  @ApiResponse({ status: 404, description: 'NOT_FOUND' })
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: User,
  ) {
    this.logger.log(`User ${user.id} deleting product: ${id}`);
    return this.productsService.remove(id, user.id);
  }
}
