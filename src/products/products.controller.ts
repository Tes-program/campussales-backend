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
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { ProductsService } from './products.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { FilterProductDto } from './dto/filter-product.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';

@ApiTags('Products')
@Controller('products')
export class ProductsController {
  private readonly logger = new Logger(ProductsController.name);

  constructor(private readonly productsService: ProductsService) {}

  @Post()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a new product' })
  @ApiResponse({ status: 201, description: 'Product created successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 400, description: 'Invalid product data' })
  async create(
    @CurrentUser() user: User,
    @Body() createProductDto: CreateProductDto,
  ) {
    this.logger.log(`User ${user.id} creating new product: ${createProductDto.title}`);
    return await this.productsService.create(user.id, createProductDto);
  }

  @Get()
  @ApiOperation({ summary: 'Get all products with filters' })
  @ApiResponse({ status: 200, description: 'Products retrieved successfully' })
  async findAll(@Query() filterDto: FilterProductDto) {
    this.logger.log('Fetching products with filters');
    return await this.productsService.findAll(filterDto);
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
    this.logger.log(`Fetching ${limit} recommended products for user ${user.id}`);
    return await this.productsService.getRecommendedProducts(user.id, limit);
  }

  @Get('my-products')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current user products' })
  @ApiResponse({ status: 200, description: 'User products retrieved' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getMyProducts(
    @CurrentUser() user: User,
    @Query('page') page: number = 1,
    @Query('limit') limit: number = 10,
  ) {
    this.logger.log(`User ${user.id} fetching own products`);
    return await this.productsService.findBySeller(user.id, page, limit);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get product by ID' })
  @ApiResponse({ status: 200, description: 'Product found' })
  @ApiResponse({ status: 404, description: 'Product not found' })
  @ApiResponse({ status: 400, description: 'Invalid product ID format' })
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    this.logger.log(`Fetching product with ID: ${id}`);
    return await this.productsService.findOne(id);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update product' })
  @ApiResponse({ status: 200, description: 'Product updated successfully' })
  @ApiResponse({ status: 403, description: 'Forbidden - Not the product owner' })
  @ApiResponse({ status: 404, description: 'Product not found' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: User,
    @Body() updateProductDto: UpdateProductDto,
  ) {
    this.logger.log(`User ${user.id} updating product: ${id}`);
    return await this.productsService.update(id, user.id, updateProductDto);
  }

  @Patch(':id/unavailable')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Mark product as unavailable' })
  @ApiResponse({ status: 200, description: 'Product marked as unavailable' })
  @ApiResponse({ status: 403, description: 'Forbidden - Not the product owner' })
  @ApiResponse({ status: 404, description: 'Product not found' })
  async markAsUnavailable(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: User,
  ) {
    this.logger.log(`User ${user.id} marking product ${id} as unavailable`);
    return await this.productsService.markAsUnavailable(id, user.id);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete product' })
  @ApiResponse({ status: 204, description: 'Product deleted successfully' })
  @ApiResponse({ status: 403, description: 'Forbidden - Not the product owner' })
  @ApiResponse({ status: 404, description: 'Product not found' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: User,
  ) {
    this.logger.log(`User ${user.id} deleting product: ${id}`);
    await this.productsService.remove(id, user.id);
  }
}
