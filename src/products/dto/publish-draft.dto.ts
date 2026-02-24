// src/products/dto/publish-draft.dto.ts
import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  IsNumber,
  IsEnum,
  IsOptional,
  IsArray,
  IsUUID,
  Min,
  MaxLength,
} from 'class-validator';
import { ProductCondition } from '../entities/product.entity';

/**
 * DTO for publishing a draft.
 * All fields are optional - if not provided, draft data will be used.
 * Use this to override specific fields from the draft before publishing.
 */
export class PublishDraftDto {
  @ApiProperty({ example: 'iPhone 13 Pro Max', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @ApiProperty({
    example: 'Excellent condition, barely used for 6 months',
    required: false,
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiProperty({ example: 450000.0, required: false })
  @IsOptional()
  @IsNumber()
  @Min(0)
  price?: number;

  @ApiProperty({
    enum: ProductCondition,
    example: ProductCondition.LIKE_NEW,
    required: false,
  })
  @IsOptional()
  @IsEnum(ProductCondition)
  condition?: ProductCondition;

  @ApiProperty({ example: 1, default: 1, required: false })
  @IsOptional()
  @IsNumber()
  @Min(1)
  quantity?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiProperty({
    type: [String],
    example: [
      'https://example.com/image1.jpg',
      'https://example.com/image2.jpg',
    ],
    required: false,
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  images?: string[];

  @ApiProperty({
    type: [String],
    example: ['electronics', 'phone', 'apple'],
    required: false,
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];
}
