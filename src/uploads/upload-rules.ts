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
};
