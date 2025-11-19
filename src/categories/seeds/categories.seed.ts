// src/categories/seeds/categories.seed.ts
import { CreateCategoryDto } from '../dto/create-category.dto';

export const defaultCategories: CreateCategoryDto[] = [
  {
    name: 'Electronics',
    slug: 'electronics',
    description: 'Laptops, phones, tablets, and electronic accessories',
    iconUrl: '📱',
  },
  {
    name: 'Books & Notes',
    slug: 'books-notes',
    description: 'Textbooks, course materials, and study notes',
    iconUrl: '📚',
  },
  {
    name: 'Clothing & Fashion',
    slug: 'clothing-fashion',
    description: 'Clothes, shoes, bags, and fashion accessories',
    iconUrl: '👕',
  },
  {
    name: 'Furniture',
    slug: 'furniture',
    description: 'Desks, chairs, beds, and room furniture',
    iconUrl: '🛋️',
  },
  {
    name: 'Sports & Fitness',
    slug: 'sports-fitness',
    description: 'Sports equipment, gym gear, and fitness accessories',
    iconUrl: '⚽',
  },
  {
    name: 'Musical Instruments',
    slug: 'musical-instruments',
    description: 'Guitars, keyboards, drums, and other instruments',
    iconUrl: '🎸',
  },
  {
    name: 'Stationery',
    slug: 'stationery',
    description: 'Pens, notebooks, calculators, and office supplies',
    iconUrl: '✏️',
  },
  {
    name: 'Kitchen & Appliances',
    slug: 'kitchen-appliances',
    description: 'Cooking utensils, small appliances, and kitchenware',
    iconUrl: '🍳',
  },
  {
    name: 'Art & Crafts',
    slug: 'art-crafts',
    description: 'Art supplies, craft materials, and creative tools',
    iconUrl: '🎨',
  },
  {
    name: 'Games & Entertainment',
    slug: 'games-entertainment',
    description: 'Board games, video games, consoles, and entertainment items',
    iconUrl: '🎮',
  },
  {
    name: 'Bicycles & Accessories',
    slug: 'bicycles-accessories',
    description: 'Bikes, helmets, locks, and cycling gear',
    iconUrl: '🚲',
  },
  {
    name: 'Others',
    slug: 'others',
    description: 'Miscellaneous items and other products',
    iconUrl: '📦',
  },
];
