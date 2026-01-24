// src/wishlist/wishlist.controller.ts
import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { WishlistService } from './wishlist.service';
import { AddToWishlistDto } from './dto/add-to-wishlist.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';

@ApiTags('Wishlist')
@Controller('wishlist')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class WishlistController {
  private readonly logger = new Logger(WishlistController.name);

  constructor(private readonly wishlistService: WishlistService) {}

  @Post()
  @ApiOperation({ summary: 'Add product to wishlist' })
  @ApiResponse({
    status: 201,
    description: 'Product added to wishlist successfully',
  })
  @ApiResponse({
    status: 400,
    description: 'Cannot add own product to wishlist',
  })
  @ApiResponse({ status: 404, description: 'Product not found' })
  @ApiResponse({ status: 409, description: 'Product already in wishlist' })
  async addToWishlist(
    @CurrentUser() user: User,
    @Body() addToWishlistDto: AddToWishlistDto,
  ) {
    this.logger.log(`User ${user.id} adding product ${addToWishlistDto.productId} to wishlist`);
    return await this.wishlistService.addToWishlist(user.id, addToWishlistDto);
  }

  @Get()
  @ApiOperation({ summary: 'Get user wishlist' })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 10 })
  @ApiResponse({ status: 200, description: 'Wishlist retrieved successfully' })
  async getUserWishlist(
    @CurrentUser() user: User,
    @Query('page') page: number = 1,
    @Query('limit') limit: number = 10,
  ) {
    return await this.wishlistService.getUserWishlist(user.id, page, limit);
  }

  @Get('count')
  @ApiOperation({ summary: 'Get wishlist item count' })
  @ApiResponse({ status: 200, description: 'Wishlist count retrieved' })
  async getWishlistCount(@CurrentUser() user: User) {
    const count = await this.wishlistService.getWishlistCount(user.id);
    return { count };
  }

  @Get('stats')
  @ApiOperation({ summary: 'Get wishlist statistics' })
  @ApiResponse({ status: 200, description: 'Wishlist statistics retrieved' })
  async getWishlistStats(@CurrentUser() user: User) {
    return await this.wishlistService.getWishlistStats(user.id);
  }

  @Get('check/:productId')
  @ApiOperation({ summary: 'Check if product is in wishlist' })
  @ApiResponse({ status: 200, description: 'Check result returned' })
  async checkWishlist(
    @CurrentUser() user: User,
    @Param('productId', ParseUUIDPipe) productId: string,
  ) {
    const isInWishlist = await this.wishlistService.isInWishlist(
      user.id,
      productId,
    );
    return { isInWishlist };
  }

  @Post('check-multiple')
  @ApiOperation({ summary: 'Check multiple products in wishlist' })
  @ApiResponse({ status: 200, description: 'Bulk check completed' })
  async checkMultipleProducts(
    @CurrentUser() user: User,
    @Body() body: { productIds: string[] },
  ) {
    return await this.wishlistService.checkMultipleProducts(
      user.id,
      body.productIds,
    );
  }

  @Post('toggle/:productId')
  @ApiOperation({ summary: 'Toggle product in wishlist (add/remove)' })
  @ApiResponse({ status: 200, description: 'Product toggled in wishlist' })
  @ApiResponse({ status: 404, description: 'Product not found' })
  async toggleWishlist(
    @CurrentUser() user: User,
    @Param('productId', ParseUUIDPipe) productId: string,
  ) {
    return await this.wishlistService.toggleWishlist(user.id, productId);
  }

  @Delete('clear')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Clear entire wishlist' })
  @ApiResponse({ status: 204, description: 'Wishlist cleared successfully' })
  async clearWishlist(@CurrentUser() user: User) {
    await this.wishlistService.clearWishlist(user.id);
  }

  @Delete(':productId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove product from wishlist' })
  @ApiResponse({ status: 204, description: 'Product removed from wishlist' })
  @ApiResponse({ status: 404, description: 'Product not found in wishlist' })
  async removeFromWishlist(
    @CurrentUser() user: User,
    @Param('productId', ParseUUIDPipe) productId: string,
  ) {
    this.logger.log(`User ${user.id} removing product ${productId} from wishlist`);
    await this.wishlistService.removeFromWishlist(user.id, productId);
  }
}
