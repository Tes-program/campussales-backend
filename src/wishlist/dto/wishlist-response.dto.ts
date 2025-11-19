// src/wishlist/dto/wishlist-response.dto.ts
import { ApiProperty } from '@nestjs/swagger';

export class WishlistItemResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  userId: string;

  @ApiProperty()
  productId: string;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  product?: {
    id: string;
    title: string;
    description: string;
    price: number;
    condition: string;
    isAvailable: boolean;
    images?: Array<{
      imageUrl: string;
      isPrimary: boolean;
    }>;
    seller?: {
      id: string;
      email: string;
      profile?: {
        firstName: string;
        lastName: string;
      };
    };
  };
}
