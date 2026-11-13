import { LISTING_LIMITS } from '../common/constants/listing';

/** One source of truth for upload limits (signing, legacy multipart, bootstrap). */
export const UPLOAD_RULES = {
  maxBytes: 3 * 1024 * 1024,
  formats: ['jpg', 'jpeg', 'png', 'webp', 'heic'] as string[],
  mimeTypes: [
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/webp',
    'image/heic',
  ] as string[],
  maxImagesPerListing: LISTING_LIMITS.imagesMax,
  /** Longest side stored after Cloudinary's incoming transformation. */
  maxWidth: 1600,
  /** How long a signature may be used (Cloudinary itself allows up to 1 hour). */
  signatureTtlSeconds: 10 * 60,
  /** Uploads not attached to a listing (or avatar) after this are deleted. */
  orphanAfterHours: 24,
  /** Images of deleted listings are kept this long (undo, disputes), then deleted. */
  deletedListingImageDays: 30,
  /** Chat photos (C1): no HEIC, so every phone and browser can show them. */
  chatFormats: ['jpg', 'jpeg', 'png', 'webp'] as string[],
  chatFolder: 'campussales/chat/',
  tooLargeMessage:
    'This photo is over 3 MB. Choose a smaller photo or take a new one with your camera.',
  /**
   * Smallest listing photo: 400x300 in either orientation (a 300x400
   * portrait is as big as a 400x300 landscape), so the short side must be
   * at least 300 and the long side at least 400.
   */
  minLongSide: 400,
  minShortSide: 300,
  tooSmallMessage: 'This photo is too small. Use one at least 400x300.',
  /** Wider than 2:1 or taller than 1:2 is flagged by the audit. */
  maxAspectRatio: 2,
};

/** True when a photo is under 400x300 (either orientation). */
export function isTooSmall(width: number, height: number): boolean {
  return (
    Math.max(width, height) < UPLOAD_RULES.minLongSide ||
    Math.min(width, height) < UPLOAD_RULES.minShortSide
  );
}

/** True when a photo is wider than 2:1 or taller than 1:2. */
export function isExtremeAspect(width: number, height: number): boolean {
  if (width <= 0 || height <= 0) return false;
  return (
    Math.max(width, height) / Math.min(width, height) >
    UPLOAD_RULES.maxAspectRatio
  );
}
