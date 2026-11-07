import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsUUID } from 'class-validator';

/** Schema for POST /api/wishlist/check-multiple. */
export class CheckWishlistDto {
  @ApiProperty({ type: [String], maxItems: 100 })
  @IsArray({ message: 'Send a list of item ids.' })
  @ArrayMaxSize(100, { message: 'Check up to 100 items at a time.' })
  @IsUUID('all', { each: true, message: 'Each item id must be valid.' })
  productIds: string[];
}
