// Query schema for GET /api/products (B3). Legacy parameters from the
// deployed frontend (page, search, categoryId, universityId, sortBy,
// sortOrder, sellerId) are still accepted.
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { isUUID } from 'class-validator';
import {
  CATEGORY_SLUGS,
  resolveCategorySlug,
} from '../../common/constants/categories';
import {
  LISTING_LIMITS,
  ProductCondition,
} from '../../common/constants/listing';
import { Normalise, OptionalRule } from '../../common/validation/decorators';
import { normaliseCondition } from '../../common/validation/rules';

export const SORTS = [
  'newest',
  'price_asc',
  'price_desc',
  'relevance',
] as const;
export type Sort = (typeof SORTS)[number];
export const LIST_LIMIT_DEFAULT = 20;
export const LIST_LIMIT_MAX = 50;

const M = {
  q: 'Search must be 100 characters or fewer.',
  campus: 'Choose a school from the list, or "all".',
  category: 'Choose categories from the list.',
  condition: 'Condition must be New, Like New, Used or Fair.',
  price: 'Enter a whole number of naira.',
  priceRange: 'Maximum price must be at least the minimum price.',
  tag: 'Tags are 2 to 24 characters.',
  status: 'Status must be active or sold.',
  sort: 'Sort must be newest, price_asc, price_desc or relevance.',
  relevance: 'Relevance sorting needs a search term.',
  limit: `Show between 1 and ${LIST_LIMIT_MAX} items.`,
  cursor: 'This page link has expired. Please reload.',
  page: 'Page must be a whole number from 1.',
  id: 'Choose a valid option.',
} as const;

const list = (v: unknown): string[] | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  const arr: unknown[] = Array.isArray(v)
    ? v
    : typeof v === 'string'
      ? v.split(',')
      : [v];
  return arr
    .map((x) =>
      typeof x === 'string' ? x.trim() : typeof x === 'number' ? String(x) : '',
    )
    .filter(Boolean);
};
const int = (v: unknown) =>
  typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : v;
const isInt = (v: unknown, max: number) =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max;

export class ListProductsQueryDto {
  @ApiPropertyOptional({
    description: 'Search text (alias: search).',
    maxLength: 100,
  })
  @Transform(({ obj }: { obj: Record<string, unknown> }) => {
    const v = obj.q ?? obj.search;
    return typeof v === 'string' ? v.trim() || undefined : v;
  })
  @OptionalRule((v) => (typeof v === 'string' && v.length <= 100 ? null : M.q))
  q?: string;

  @ApiPropertyOptional({ deprecated: true, description: 'Alias of q.' })
  @OptionalRule((v) => (typeof v === 'string' ? null : M.q))
  search?: string;

  @ApiPropertyOptional({
    description:
      'School id, or "all". Never defaulted by the server (alias: universityId).',
  })
  @Transform(
    ({ obj }: { obj: Record<string, unknown> }) =>
      obj.campus ?? obj.universityId,
  )
  @OptionalRule((v) =>
    v === 'all' || (typeof v === 'string' && isUUID(v)) ? null : M.campus,
  )
  campus?: string;

  @ApiPropertyOptional({ deprecated: true })
  @OptionalRule((v) => (typeof v === 'string' && isUUID(v) ? null : M.campus))
  universityId?: string;

  @ApiPropertyOptional({
    description: 'Category slug(s): repeat or comma-separate.',
    enum: CATEGORY_SLUGS,
    isArray: true,
  })
  @Normalise((v) => {
    const arr = list(v);
    return Array.isArray(arr)
      ? arr.map((x) => resolveCategorySlug(x) ?? x)
      : arr;
  })
  @OptionalRule((v) =>
    Array.isArray(v) &&
    v.length <= 13 &&
    v.every((x) => CATEGORY_SLUGS.includes(x as string))
      ? null
      : M.category,
  )
  category?: string[];

  @ApiPropertyOptional({ deprecated: true, format: 'uuid' })
  @OptionalRule((v) => (typeof v === 'string' && isUUID(v) ? null : M.id))
  categoryId?: string;

  @ApiPropertyOptional({ enum: ProductCondition, isArray: true })
  @Normalise((v) => {
    const arr = list(v);
    return Array.isArray(arr) ? arr.map((x) => normaliseCondition(x)) : arr;
  })
  @OptionalRule((v) =>
    Array.isArray(v) &&
    v.every((x) =>
      Object.values(ProductCondition).includes(x as ProductCondition),
    )
      ? null
      : M.condition,
  )
  condition?: ProductCondition[];

  @ApiPropertyOptional({ minimum: 0 })
  @Normalise(int)
  @OptionalRule((v) => (isInt(v, LISTING_LIMITS.priceMax) ? null : M.price))
  minPrice?: number;

  @ApiPropertyOptional({ minimum: 0 })
  @Normalise(int)
  @OptionalRule((v, o) => {
    if (!isInt(v, LISTING_LIMITS.priceMax)) return M.price;
    return typeof o?.minPrice === 'number' && (v as number) < o.minPrice
      ? M.priceRange
      : null;
  })
  maxPrice?: number;

  @ApiPropertyOptional()
  @Normalise((v) => (typeof v === 'string' ? v.trim().toLowerCase() : v))
  @OptionalRule((v) =>
    typeof v === 'string' && v.length >= 2 && v.length <= 24 ? null : M.tag,
  )
  tag?: string;

  @ApiPropertyOptional({ enum: ['active', 'sold'], default: 'active' })
  @OptionalRule((v) => (v === 'active' || v === 'sold' ? null : M.status))
  status?: 'active' | 'sold';

  @ApiPropertyOptional({ enum: SORTS, default: 'newest' })
  @OptionalRule((v, o) => {
    if (!SORTS.includes(v as Sort)) return M.sort;
    return v === 'relevance' && !o?.q && !o?.search ? M.relevance : null;
  })
  sort?: Sort;

  @ApiPropertyOptional({ default: LIST_LIMIT_DEFAULT, maximum: LIST_LIMIT_MAX })
  @Normalise(int)
  @OptionalRule((v) =>
    typeof v === 'number' &&
    Number.isInteger(v) &&
    v >= 1 &&
    v <= LIST_LIMIT_MAX
      ? null
      : M.limit,
  )
  limit?: number;

  @ApiPropertyOptional({ description: 'Opaque cursor from nextCursor.' })
  @OptionalRule((v) =>
    typeof v === 'string' && v.length <= 500 && decodeCursor(v)
      ? null
      : M.cursor,
  )
  cursor?: string;

  // ---- legacy ----
  @ApiPropertyOptional({
    deprecated: true,
    description: 'Offset paging (use cursor).',
  })
  @Normalise(int)
  @OptionalRule((v) =>
    typeof v === 'number' && Number.isInteger(v) && v >= 1 ? null : M.page,
  )
  page?: number;

  @ApiPropertyOptional({ format: 'uuid' })
  @OptionalRule((v) => (typeof v === 'string' && isUUID(v) ? null : M.id))
  sellerId?: string;

  @ApiPropertyOptional({
    deprecated: true,
    enum: ['createdAt', 'price', 'viewCount', 'title', 'updatedAt'],
  })
  @OptionalRule((v) =>
    ['createdAt', 'price', 'viewCount', 'title', 'updatedAt'].includes(
      v as string,
    )
      ? null
      : M.sort,
  )
  sortBy?: string;

  @ApiPropertyOptional({ deprecated: true, enum: ['asc', 'desc'] })
  @Normalise((v) => (typeof v === 'string' ? v.toLowerCase() : v))
  @OptionalRule((v) => (v === 'asc' || v === 'desc' ? null : M.sort))
  sortOrder?: 'asc' | 'desc';
}

// ---------------------------------------------------------------- cursor --

export interface Cursor {
  s: Sort;
  /** createdAt as text with microseconds (keyset on newest). */
  c?: string;
  /** price (keyset on price sorts). */
  p?: number;
  /** last id (tie-breaker). */
  i?: string;
  /** offset (relevance). */
  o?: number;
}

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c)).toString('base64url');
}

export function decodeCursor(raw: string): Cursor | null {
  try {
    const c = JSON.parse(
      Buffer.from(raw, 'base64url').toString('utf8'),
    ) as Cursor;
    if (!SORTS.includes(c.s)) return null;
    if (c.s === 'relevance')
      return Number.isInteger(c.o) && (c.o as number) >= 0 ? c : null;
    if (!c.i || !isUUID(c.i)) return null;
    if (c.s === 'newest') {
      return typeof c.c === 'string' &&
        /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,6})?$/.test(c.c)
        ? c
        : null;
    }
    return Number.isInteger(c.p) ? c : null;
  } catch {
    return null;
  }
}
