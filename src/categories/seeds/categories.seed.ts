// src/categories/seeds/categories.seed.ts
// Derived from the single source of truth in common/constants/categories.ts.
import { CreateCategoryDto } from '../dto/create-category.dto';
import { CATEGORIES } from '../../common/constants/categories';

export const defaultCategories: CreateCategoryDto[] = CATEGORIES.map((c) => ({
  name: c.name,
  slug: c.slug,
  description: c.description,
  iconUrl: c.icon,
}));
