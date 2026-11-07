// Schema for POST /api/products. Rules live in common/validation/rules.ts and
// are shared with UpdateProductDto, publish-draft and the data scripts.
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { isUUID } from 'class-validator';
import { MSG } from '../../common/errors/messages';
import { CATEGORY_SLUGS } from '../../common/constants/categories';
import {
  LISTING_LIMITS as L,
  ProductCondition,
} from '../../common/constants/listing';
import { Normalise, Rule } from '../../common/validation/decorators';
import {
  Check,
  coerceIntegerString,
  normaliseCategory,
  normaliseCondition,
  normaliseImages,
  normaliseTags,
  normaliseText,
  validateCategorySlug,
  validateCondition,
  validateDescription,
  validateImages,
  validatePrice,
  validateQuantity,
  validateTags,
  validateTitle,
} from '../../common/validation/rules';

const blankToUndefined = (v: unknown) =>
  typeof v === 'string' && v.trim() === '' ? undefined : v;

/** `category` (slug) or `categoryId` (uuid) — at least one is required. */
export const categoryOnCreate: Check = (v, obj) => {
  if (v === undefined || v === null) {
    return obj?.categoryId === undefined || obj?.categoryId === null
      ? MSG.categoryRequired
      : null;
  }
  return validateCategorySlug(v);
};

export const categoryIdCheck: Check = (v) =>
  v === undefined
    ? null
    : typeof v === 'string' && isUUID(v)
      ? null
      : MSG.categoryInvalid;

export class CreateProductDto {
  @ApiProperty({
    example: 'iPhone 13 Pro Max',
    minLength: L.titleMin,
    maxLength: L.titleMax,
  })
  @Normalise(normaliseText)
  @Rule(validateTitle)
  title: string;

  @ApiPropertyOptional({
    example: 'Barely used, comes with charger',
    maxLength: L.descriptionMax,
  })
  @Normalise(normaliseText)
  @Rule(validateDescription)
  description?: string;

  @ApiProperty({
    example: 450000,
    description: 'Whole naira (integer).',
    minimum: L.priceMin,
    maximum: L.priceMax,
  })
  @Normalise(coerceIntegerString)
  @Rule(validatePrice)
  price: number;

  @ApiPropertyOptional({
    example: 1,
    default: 1,
    minimum: L.quantityMin,
    maximum: L.quantityMax,
  })
  @Normalise(coerceIntegerString)
  @Rule(validateQuantity)
  quantity?: number;

  @ApiPropertyOptional({
    enum: CATEGORY_SLUGS,
    description: 'Category slug. Send this or categoryId.',
  })
  @Normalise((v) => normaliseCategory(blankToUndefined(v)))
  @Rule(categoryOnCreate)
  category?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Legacy: category id.' })
  @Normalise(blankToUndefined)
  @Rule(categoryIdCheck)
  categoryId?: string;

  @ApiProperty({
    enum: ProductCondition,
    description: 'Also accepts labels: New, Like New, Used, Fair.',
  })
  @Normalise(normaliseCondition)
  @Rule(validateCondition)
  condition: ProductCondition;

  @ApiProperty({
    type: [String],
    minItems: L.imagesMin,
    maxItems: L.imagesMax,
    example: [
      'https://res.cloudinary.com/<cloud>/image/upload/v1/campussales/a.jpg',
    ],
  })
  @Normalise(normaliseImages)
  @Rule(validateImages)
  images: string[];

  @ApiPropertyOptional({
    type: [String],
    maxItems: L.tagsMax,
    example: ['iphone', 'apple'],
  })
  @Normalise(normaliseTags)
  @Rule(validateTags)
  tags?: string[];
}
