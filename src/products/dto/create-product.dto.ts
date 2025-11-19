// src/products/dto/create-product.dto.ts
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

export class CreateProductDto {
  @ApiProperty({ example: 'iPhone 13 Pro Max' })
  @IsString()
  @MaxLength(200)
  title: string;

  @ApiProperty({ example: 'Excellent condition, barely used for 6 months' })
  @IsString()
  @MaxLength(2000)
  description: string;

  @ApiProperty({ example: 450000.0 })
  @IsNumber()
  @Min(0)
  price: number;

  @ApiProperty({ enum: ProductCondition, example: ProductCondition.LIKE_NEW })
  @IsEnum(ProductCondition)
  condition: ProductCondition;

  @ApiProperty({ example: 1, default: 1 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  quantity?: number = 1;

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
