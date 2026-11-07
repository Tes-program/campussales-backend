/**
 * SINGLE SOURCE OF TRUTH for listing categories and onboarding interests.
 *
 * - The categories table is seeded from this list (npm run seed:categories).
 * - Product `category` / `categoryId` and onboarding `interests` are validated
 *   against it.
 * - `aliases` are older values still sent by the deployed frontend
 *   (onboarding interests picker). They are normalised to `slug` on write.
 *   Remove an alias once no client sends it.
 */
export interface CategoryDefinition {
  slug: string;
  name: string;
  description: string;
  icon: string;
  aliases: string[];
}

export const CATEGORIES: readonly CategoryDefinition[] = [
  // Slugs and names match the categories live in the database (and the
  // deployed frontend). The older seed-file slugs are kept as aliases.
  {
    slug: 'electronics',
    name: 'Electronics',
    description: 'Laptops, phones, tablets, and electronic accessories',
    icon: '📱',
    aliases: [],
  },
  {
    slug: 'books-textbooks',
    name: 'Books & Textbooks',
    description: 'Textbooks, novels, course materials, and study notes',
    icon: '📚',
    aliases: ['books', 'books-notes', 'books-stationery', 'textbooks'],
  },
  {
    slug: 'school-supplies',
    name: 'School Supplies',
    description: 'Calculators, lab coats, stationery, and study tools',
    icon: '✏️',
    aliases: ['stationery', 'supplies'],
  },
  {
    slug: 'clothing-apparel',
    name: 'Clothing & Apparel',
    description: 'Clothes, shoes, bags, and fashion accessories',
    icon: '👕',
    aliases: ['clothing', 'clothing-fashion', 'fashion', 'apparel'],
  },
  {
    slug: 'furniture',
    name: 'Furniture',
    description: 'Desks, chairs, beds, and room furniture',
    icon: '🛋️',
    aliases: [],
  },
  {
    slug: 'home-kitchen',
    name: 'Home & Kitchen',
    description: 'Cooking utensils, small appliances, and home items',
    icon: '🍳',
    aliases: ['kitchen-appliances', 'kitchen', 'home'],
  },
  {
    slug: 'sports-outdoors',
    name: 'Sports & Outdoors',
    description: 'Sports equipment, gym gear, and outdoor gear',
    icon: '⚽',
    aliases: ['sports', 'sports-fitness', 'fitness'],
  },
  {
    slug: 'gaming',
    name: 'Gaming',
    description: 'Consoles, video games, board games, and accessories',
    icon: '🎮',
    aliases: ['games', 'games-entertainment', 'toys-games'],
  },
  {
    slug: 'musical-instruments',
    name: 'Musical Instruments',
    description: 'Guitars, keyboards, drums, and other instruments',
    icon: '🎸',
    aliases: ['music'],
  },
  {
    slug: 'art-crafts',
    name: 'Art & Crafts',
    description: 'Art supplies, craft materials, and creative tools',
    icon: '🎨',
    aliases: [],
  },
  {
    slug: 'bikes-transportation',
    name: 'Bikes & Transportation',
    description: 'Bicycles, scooters, helmets, and locks',
    icon: '🚲',
    aliases: ['bicycles-accessories', 'bikes', 'bicycles'],
  },
  {
    slug: 'beauty-personal-care',
    name: 'Beauty & Personal Care',
    description: 'Skincare, haircare, fragrance, and grooming',
    icon: '💄',
    aliases: ['beauty'],
  },
  {
    slug: 'other',
    name: 'Other',
    description: 'Anything that does not fit another category',
    icon: '📦',
    aliases: ['others', 'miscellaneous'],
  },
];

export const CATEGORY_SLUGS: readonly string[] = CATEGORIES.map((c) => c.slug);

const LOOKUP = new Map<string, string>();
for (const c of CATEGORIES) {
  for (const key of [c.slug, c.name, ...c.aliases]) {
    LOOKUP.set(normaliseKey(key), c.slug);
  }
}

function normaliseKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/&/g, ' ')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Returns the canonical slug for a slug, name or alias; null if unknown. */
export function resolveCategorySlug(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  return LOOKUP.get(normaliseKey(value)) ?? null;
}

/** Canonical slug plus every alias, for matching rows in older databases. */
export function categorySlugVariants(slug: string): string[] {
  const c = CATEGORIES.find((x) => x.slug === slug);
  return c ? [c.slug, ...c.aliases] : [slug];
}
