// Schema for POST /api/products/drafts. Drafts may be incomplete, so every
// field is optional, but any field that is present must pass the same rule as
// a listing (common/validation/rules.ts). Publishing re-checks the whole thing.
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsObject, IsOptional } from 'class-validator';
import { CATEGORY_SLUGS } from '../../common/constants/categories';
import {
  LISTING_LIMITS as L,
  ProductCondition,
} from '../../common/constants/listing';
import { MSG } from '../../common/errors/messages';
import { Normalise, OptionalRule } from '../../common/validation/decorators';
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
  validatePrice,
  validateQuantity,
  validateTags,
  validateTitle,
  makeValidateImages,
} from '../../common/validation/rules';
import { categoryIdCheck } from './create-product.dto';

/** Drafts may have zero photos; otherwise the listing image rule applies. */
const validateDraftImages: Check = (v) =>
  Array.isArray(v) && v.length === 0 ? null : makeValidateImages()(v);

/** Drafts may hold a short work-in-progress title; only length/characters are checked. */
const validateDraftTitle: Check = (v) => {
  const m = validateTitle(v);
  return m === MSG.titleShort || m === MSG.titleRequired ? null : m;
};

const nullable =
  (check: Check): Check =>
  (v, o) =>
    v === null ? null : check(v, o);

export class CreateDraftDto {
  @ApiPropertyOptional({ maxLength: L.titleMax })
  @Normalise(normaliseText)
  @OptionalRule(nullable(validateDraftTitle))
  title?: string;

  @ApiPropertyOptional({ maxLength: L.descriptionMax })
  @Normalise(normaliseText)
  @OptionalRule(validateDescription)
  description?: string;

  @ApiPropertyOptional({ minimum: L.priceMin, maximum: L.priceMax })
  @Normalise(coerceIntegerString)
  @OptionalRule(nullable(validatePrice))
  price?: number;

  @ApiPropertyOptional({ enum: ProductCondition })
  @Normalise(normaliseCondition)
  @OptionalRule(nullable(validateCondition))
  condition?: ProductCondition;

  @ApiPropertyOptional({ minimum: L.quantityMin, maximum: L.quantityMax })
  @Normalise(coerceIntegerString)
  @OptionalRule(nullable(validateQuantity))
  quantity?: number;

  @ApiPropertyOptional({ enum: CATEGORY_SLUGS })
  @Normalise(normaliseCategory)
  @OptionalRule(nullable(validateCategorySlug))
  category?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @OptionalRule(nullable(categoryIdCheck))
  categoryId?: string;

  @ApiPropertyOptional({ type: [String], maxItems: L.imagesMax })
  @Normalise(normaliseImages)
  @OptionalRule(nullable(validateDraftImages))
  images?: string[];

  @ApiPropertyOptional({ type: [String], maxItems: L.tagsMax })
  @Normalise(normaliseTags)
  @OptionalRule(validateTags)
  tags?: string[];

  @ApiPropertyOptional({ example: { step: 'details', progress: 50 } })
  @IsOptional()
  @IsObject({ message: MSG.invalidValue })
  metadata?: Record<string, unknown>;
}
