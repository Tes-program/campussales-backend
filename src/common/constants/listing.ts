/** Stored values (unchanged from before B1 so existing rows stay valid). */
export enum ProductCondition {
  NEW = 'new',
  LIKE_NEW = 'like_new',
  USED = 'used',
  FAIR = 'fair',
}

export const CONDITION_LABELS: Record<ProductCondition, string> = {
  [ProductCondition.NEW]: 'New',
  [ProductCondition.LIKE_NEW]: 'Like New',
  [ProductCondition.USED]: 'Used',
  [ProductCondition.FAIR]: 'Fair',
};

/**
 * Lifecycle status. `isAvailable` / `isSold` are kept in sync for one release
 * so older clients and queries keep working (see applyStatus).
 */
export enum ProductStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  SOLD = 'sold',
  /** Hidden from the feed until the seller fixes it (set by fix-data). */
  NEEDS_REVIEW = 'needs_review',
}

export const LISTING_LIMITS = {
  titleMin: 3,
  titleMax: 80,
  descriptionMax: 600,
  priceMin: 50,
  priceMax: 100_000_000,
  quantityMin: 1,
  quantityMax: 999,
  imagesMin: 1,
  imagesMax: 5,
  tagsMax: 10,
  tagMin: 2,
  tagMax: 24,
  bumpIntervalHours: 24,
} as const;
