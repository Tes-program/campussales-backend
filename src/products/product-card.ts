import { parseCloudinaryUrl } from '../uploads/cloudinary-url';
import { Product } from './entities/product.entity';
import { ProductImage } from './entities/product-image.entity';

export const EXCERPT_LENGTH = 160;

export function excerpt(
  text: string | null | undefined,
  max = EXCERPT_LENGTH,
): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  if (Array.from(t).length <= max) return t;
  return (
    Array.from(t)
      .slice(0, max - 1)
      .join('')
      .replace(/\s+\S*$/, '') + '…'
  );
}

/** Last price drop that is still current: { previousPrice, droppedAt } or nulls. */
export function priceDropSummary(p: Pick<Product, 'price' | 'priceHistory'>): {
  previousPrice: number | null;
  droppedAt: string | null;
} {
  const last = (p.priceHistory ?? []).at(-1);
  if (
    last &&
    last.newPrice < last.oldPrice &&
    last.newPrice === Number(p.price)
  ) {
    return { previousPrice: last.oldPrice, droppedAt: last.changedAt };
  }
  return { previousPrice: null, droppedAt: null };
}

/**
 * Cover first (isPrimary), then sortOrder. Images whose file is missing
 * (`unavailable: true`) go last so the cover is always a working photo when
 * the listing has one; apps show a placeholder for them.
 */
export function orderedImages(images: ProductImage[] | undefined) {
  return [...(images ?? [])]
    .sort(
      (a, b) =>
        Number(!!a.unavailableAt) - Number(!!b.unavailableAt) ||
        Number(b.isPrimary) - Number(a.isPrimary) ||
        a.sortOrder - b.sortOrder,
    )
    .map((i) => {
      const ref = i.publicId ? i : parseCloudinaryUrl(i.imageUrl);
      return {
        id: i.id,
        imageUrl: i.imageUrl,
        // Build responsive URLs: res.cloudinary.com/<cloud>/image/upload/
        // f_auto,q_auto,c_limit,w_<n>/v<version>/<publicId>
        publicId: ref?.publicId ?? null,
        version: ref?.version ?? null,
        isPrimary: i.isPrimary,
        sortOrder: i.sortOrder,
        unavailable: !!i.unavailableAt,
      };
    });
}

export interface SellerCard {
  id: string;
  firstName: string | null;
  avatar: string | null;
  campus: { id: string; name: string; shortName: string | null } | null;
  /** Legacy shape used by the deployed frontend. */
  profile: {
    firstName: string | null;
    lastName: string | null;
    profilePictureUrl: string | null;
    universityId: string | null;
  } | null;
}

export function sellerCard(p: Product): SellerCard | null {
  const s = p.seller;
  if (!s) return null;
  const prof = s.profile;
  const uni = prof?.university;
  return {
    id: s.id,
    firstName: prof?.firstName ?? s.fullName?.split(' ')[0] ?? null,
    avatar: prof?.profilePictureUrl ?? null,
    campus: uni
      ? { id: uni.id, name: uni.name, shortName: uni.code ?? null }
      : null,
    profile: prof
      ? {
          firstName: prof.firstName ?? null,
          lastName: prof.lastName ?? null,
          profilePictureUrl: prof.profilePictureUrl ?? null,
          universityId: prof.universityId ?? null,
        }
      : null,
  };
}

/**
 * The list/card shape. Keeps every field older clients read; `description`
 * holds the short excerpt (the full text is on GET /products/:id).
 * Never includes the seller's email or phone.
 */
export function toCard(p: Product, extra: { isWishlisted?: boolean } = {}) {
  const short = excerpt(p.description);
  return {
    id: p.id,
    title: p.title,
    description: short,
    excerpt: short,
    price: Number(p.price),
    ...priceDropSummary(p),
    condition: p.condition,
    quantity: p.quantity,
    status: p.status,
    isAvailable: p.isAvailable,
    isSold: p.isSold,
    isFeatured: p.isFeatured,
    viewCount: p.viewCount,
    tags: p.tags ?? [],
    sellerId: p.sellerId,
    categoryId: p.categoryId ?? null,
    campusId: p.campusId ?? null,
    category: p.category
      ? { id: p.category.id, name: p.category.name, slug: p.category.slug }
      : null,
    images: orderedImages(p.images),
    seller: sellerCard(p),
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    ...(extra.isWishlisted !== undefined
      ? { isWishlisted: extra.isWishlisted }
      : {}),
  };
}

export type ProductCard = ReturnType<typeof toCard>;
