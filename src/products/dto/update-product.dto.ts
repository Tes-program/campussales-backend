// Schema for PATCH /api/products/:id and the optional body of
// POST /api/products/:id/relist. Any subset of fields; same rules as create.
import { ApiPropertyOptional } from '@nestjs/swagger';
import { MSG } from '../../common/errors/messages';
import { CATEGORY_SLUGS } from '../../common/constants/categories';
import {
  LISTING_LIMITS as L,
  ProductCondition,
} from '../../common/constants/listing';
import { Normalise, OptionalRule } from '../../common/validation/decorators';
import {
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
import { categoryIdCheck } from './create-product.dto';

export class UpdateProductDto {
  @ApiPropertyOptional({ minLength: L.titleMin, maxLength: L.titleMax })
  @Normalise(normaliseText)
  @OptionalRule(validateTitle)
  title?: string;

  @ApiPropertyOptional({ maxLength: L.descriptionMax, nullable: true })
  @Normalise(normaliseText)
  @OptionalRule(validateDescription)
  description?: string | null;

  @ApiPropertyOptional({
    minimum: L.priceMin,
    maximum: L.priceMax,
    description: 'Whole naira.',
  })
  @Normalise(coerceIntegerString)
  @OptionalRule(validatePrice)
  price?: number;

  @ApiPropertyOptional({ minimum: L.quantityMin, maximum: L.quantityMax })
  @Normalise(coerceIntegerString)
  @OptionalRule((v) =>
    v === null ? MSG.quantityNotNumber : validateQuantity(v),
  )
  quantity?: number;

  @ApiPropertyOptional({ enum: CATEGORY_SLUGS })
  @Normalise(normaliseCategory)
  @OptionalRule(validateCategorySlug)
  category?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Legacy: category id.' })
  @OptionalRule(categoryIdCheck)
  categoryId?: string;

  @ApiPropertyOptional({ enum: ProductCondition })
  @Normalise(normaliseCondition)
  @OptionalRule(validateCondition)
  condition?: ProductCondition;

  @ApiPropertyOptional({
    type: [String],
    minItems: L.imagesMin,
    maxItems: L.imagesMax,
  })
  @Normalise(normaliseImages)
  @OptionalRule(validateImages)
  images?: string[];

  @ApiPropertyOptional({ type: [String], maxItems: L.tagsMax, nullable: true })
  @Normalise(normaliseTags)
  @OptionalRule(validateTags)
  tags?: string[] | null;
}

export const UPDATABLE_PRODUCT_FIELDS = [
  'title',
  'description',
  'price',
  'quantity',
  'category',
  'categoryId',
  'condition',
  'images',
  'tags',
] as const;
