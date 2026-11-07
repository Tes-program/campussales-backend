import { runSchema } from '../../common/validation/run-schema';
import { CreateProductDto } from './create-product.dto';
import { UpdateProductDto } from './update-product.dto';

const CLOUD = 'campussales-test';
const img = (n = 1) =>
  `https://res.cloudinary.com/${CLOUD}/image/upload/v1/campussales/${n}.jpg`;

const valid = () => ({
  title: 'Casio fx-991ES calculator',
  description: 'Works perfectly. Comes with cover.',
  price: 7500,
  quantity: 1,
  category: 'school-supplies',
  condition: 'used',
  images: [img(1)],
  tags: ['calculator'],
});

beforeAll(() => {
  process.env.CLOUDINARY_CLOUD_NAME = CLOUD;
  process.env.STORAGE_TYPE = 'cloudinary';
});

const create = (overrides: Record<string, unknown>) =>
  runSchema(CreateProductDto, { ...valid(), ...overrides });

describe('CreateProductDto', () => {
  it('accepts a valid listing', async () => {
    const r = await create({});
    expect(r.fields).toEqual({});
  });

  describe('price', () => {
    it.each([
      [49, 'Price must be at least ₦50.'],
      [0, 'Price must be at least ₦50.'],
      [-3, 'Price must be at least ₦50.'],
      [1.5, 'Price must be a whole number of naira (no kobo).'],
      [50.01, 'Price must be a whole number of naira (no kobo).'],
      ['abc', 'Price must be a number, like 2500.'],
      ['12.5', 'Price must be a number, like 2500.'],
      [true, 'Price must be a number, like 2500.'],
      [100_000_001, 'Price can’t be more than ₦100,000,000.'],
      [undefined, 'Enter a price.'],
      ['', 'Enter a price.'],
    ])('rejects %p', async (price, message) => {
      const r = await create({ price });
      expect(r.fields.price).toBe(message);
    });

    it.each([50, 100_000_000, 2500])('accepts %p', async (price) => {
      expect((await create({ price })).fields.price).toBeUndefined();
    });

    it('accepts a numeric string and stores a number', async () => {
      const r = await create({ price: '2500' });
      expect(r.ok).toBe(true);
      expect(r.value.price).toBe(2500);
    });
  });

  describe('quantity', () => {
    it.each([
      [0, 'Quantity must be at least 1.'],
      [-3, 'Quantity must be at least 1.'],
      [1000, 'Quantity can’t be more than 999.'],
      [1.5, 'Quantity must be a whole number.'],
      ['two', 'Quantity must be a number.'],
    ])('rejects %p', async (quantity, message) => {
      expect((await create({ quantity })).fields.quantity).toBe(message);
    });

    it.each([1, 999])('accepts %p', async (quantity) => {
      expect((await create({ quantity })).fields.quantity).toBeUndefined();
    });

    it('is optional', async () => {
      const rest: Record<string, unknown> = valid();
      delete rest.quantity;
      expect((await runSchema(CreateProductDto, rest)).ok).toBe(true);
    });
  });

  describe('title', () => {
    it.each([
      ['', 'Enter a title for your item.'],
      ['   ', 'Enter a title for your item.'],
      ['ab', 'Title must be at least 3 characters.'],
      ['  ab  ', 'Title must be at least 3 characters.'],
      ['x'.repeat(81), 'Title must be 80 characters or fewer.'],
      [
        'Bad\u0000title',
        'Title contains characters we can’t display. Please retype it.',
      ],
      [
        'Line\nbreak',
        'Title contains characters we can’t display. Please retype it.',
      ],
      [
        'Sneaky \u202Eevil',
        'Title contains characters we can’t display. Please retype it.',
      ],
      [12345, 'Title must be text.'],
    ])('rejects %j', async (title, message) => {
      expect((await create({ title })).fields.title).toBe(message);
    });

    it('accepts exactly 3 and 80 characters', async () => {
      expect((await create({ title: 'abc' })).ok).toBe(true);
      expect((await create({ title: 'x'.repeat(80) })).ok).toBe(true);
    });

    it('trims whitespace', async () => {
      const r = await create({ title: '   Lab coat  ' });
      expect(r.value.title).toBe('Lab coat');
    });

    it('accepts unicode and emoji, counting each as one character', async () => {
      expect((await create({ title: 'Ìyá Àgbà’s wooden stool' })).ok).toBe(
        true,
      );
      expect((await create({ title: '📚📚📚' })).ok).toBe(true);
      expect((await create({ title: '😀'.repeat(80) })).ok).toBe(true);
      expect((await create({ title: '😀'.repeat(81) })).fields.title).toBe(
        'Title must be 80 characters or fewer.',
      );
      expect((await create({ title: 'Family 👨‍👩‍👧 photo frame' })).ok).toBe(true);
    });
  });

  describe('description', () => {
    it('is optional', async () => {
      expect((await create({ description: undefined })).ok).toBe(true);
    });
    it('allows 600 and rejects 601 characters', async () => {
      expect((await create({ description: 'd'.repeat(600) })).ok).toBe(true);
      expect(
        (await create({ description: 'd'.repeat(601) })).fields.description,
      ).toBe('Description must be 600 characters or fewer.');
    });
    it('allows newlines but not other control characters', async () => {
      expect(
        (await create({ description: 'Line one\nLine two\ttabbed' })).ok,
      ).toBe(true);
      expect(
        (await create({ description: 'bell\u0007' })).fields.description,
      ).toMatch(/characters we can’t display/);
    });
  });

  describe('category', () => {
    it('requires category or categoryId', async () => {
      expect((await create({ category: undefined })).fields.category).toBe(
        'Choose a category.',
      );
    });
    it('rejects a category outside the shared list', async () => {
      expect((await create({ category: 'weapons' })).fields.category).toBe(
        'Choose a category from the list.',
      );
    });
    it('normalises names and aliases to the slug', async () => {
      expect((await create({ category: 'Books & Textbooks' })).value.category).toBe(
        'books-textbooks',
      );
      expect((await create({ category: 'books-notes' })).value.category).toBe(
        'books-textbooks',
      );
      expect((await create({ category: 'clothing' })).value.category).toBe(
        'clothing-apparel',
      );
    });
    it('accepts a legacy categoryId instead', async () => {
      const r = await create({
        category: undefined,
        categoryId: '0b5d2d8e-6b52-4a8f-9a55-3f1c2f1d9a10',
      });
      expect(r.ok).toBe(true);
    });
    it('rejects a malformed categoryId', async () => {
      const r = await create({ category: undefined, categoryId: 'nope' });
      expect(r.fields.categoryId).toBe('Choose a category from the list.');
    });
  });

  describe('condition', () => {
    it.each([
      ['New', 'new'],
      ['Like New', 'like_new'],
      ['like_new', 'like_new'],
      ['USED', 'used'],
      ['fair', 'fair'],
    ])('accepts %p', async (condition, stored) => {
      const r = await create({ condition });
      expect(r.ok).toBe(true);
      expect(r.value.condition).toBe(stored);
    });
    it('rejects anything else', async () => {
      expect((await create({ condition: 'Mint' })).fields.condition).toBe(
        'Condition must be New, Like New, Used or Fair.',
      );
    });
  });

  describe('images', () => {
    it.each([
      [[], 'Add at least one photo.'],
      [undefined, 'Add at least one photo.'],
      [[1, 2, 3, 4, 5, 6].map(img), 'You can add up to 5 photos.'],
      [
        ['https://evil.example.com/a.jpg'],
        'Photos must be uploaded through CampusSales.',
      ],
      [
        ['https://res.cloudinary.com/someone-else/image/upload/a.jpg'],
        'Photos must be uploaded through CampusSales.',
      ],
      [
        [`http://res.cloudinary.com/${CLOUD}/image/upload/a.jpg`],
        'Photos must be uploaded through CampusSales.',
      ],
      [
        [`https://res.cloudinary.com.evil.com/${CLOUD}/a.jpg`],
        'Photos must be uploaded through CampusSales.',
      ],
      [['not a url'], 'Photos must be uploaded through CampusSales.'],
      [[img(1), img(1)], 'Each photo can only be added once.'],
      [
        'https://res.cloudinary.com/x.jpg',
        'Photos must be a list of uploaded images.',
      ],
    ])('rejects %j', async (images, message) => {
      expect((await create({ images })).fields.images).toBe(message);
    });
    it('accepts 1 to 5 of our Cloudinary URLs', async () => {
      expect((await create({ images: [1, 2, 3, 4, 5].map(img) })).ok).toBe(
        true,
      );
    });
    it('accepts local /uploads URLs only when storage is local', async () => {
      process.env.STORAGE_TYPE = 'local';
      process.env.BACKEND_URL = 'http://localhost:3000';
      expect(
        (await create({ images: ['http://localhost:3000/uploads/a.jpg'] })).ok,
      ).toBe(true);
      process.env.STORAGE_TYPE = 'cloudinary';
      expect(
        (await create({ images: ['http://localhost:3000/uploads/a.jpg'] }))
          .fields.images,
      ).toBe('Photos must be uploaded through CampusSales.');
    });
  });

  describe('tags', () => {
    it('lowercases, trims and de-duplicates', async () => {
      const r = await create({
        tags: ['  Apple ', 'apple', 'IPHONE', 'Space  Grey'],
      });
      expect(r.ok).toBe(true);
      expect(r.value.tags).toEqual(['apple', 'iphone', 'space grey']);
    });
    it('rejects more than 10 after de-duplication', async () => {
      const tags = Array.from({ length: 11 }, (_, i) => `tag${i}`);
      expect((await create({ tags })).fields.tags).toBe(
        'You can add up to 10 tags.',
      );
      expect((await create({ tags: [...tags.slice(0, 10), 'TAG0'] })).ok).toBe(
        true,
      );
    });
    it.each([
      [['a'], 'Each tag must be 2 to 24 characters.'],
      [['x'.repeat(25)], 'Each tag must be 2 to 24 characters.'],
      [['<script>'], 'Tags can only use letters, numbers, spaces and hyphens.'],
      [[1], 'Tags must be a list of words.'],
    ])('rejects %j', async (tags, message) => {
      expect((await create({ tags })).fields.tags).toBe(message);
    });
    it('accepts unicode and 2/24 char boundaries', async () => {
      expect((await create({ tags: ['àgbà', 'ab', 'x'.repeat(24)] })).ok).toBe(
        true,
      );
    });
  });

  it('rejects unknown fields', async () => {
    expect((await create({ isFeatured: true })).fields.isFeatured).toBe(
      "This field isn't accepted here.",
    );
  });

  it('reports every bad field at once', async () => {
    const r = await create({ price: 0, quantity: -3 });
    expect(Object.keys(r.fields).sort()).toEqual(['price', 'quantity']);
  });
});

describe('UpdateProductDto', () => {
  it('accepts an empty body and any subset', async () => {
    expect((await runSchema(UpdateProductDto, {})).ok).toBe(true);
    expect((await runSchema(UpdateProductDto, { price: 6000 })).ok).toBe(true);
  });

  it('applies the same rules as create', async () => {
    const r = await runSchema(UpdateProductDto, {
      price: 0,
      quantity: -3,
      images: [],
    });
    expect(r.fields).toEqual({
      price: 'Price must be at least ₦50.',
      quantity: 'Quantity must be at least 1.',
      images: 'Add at least one photo.',
    });
  });

  it('rejects null for required fields but allows clearing description', async () => {
    const r = await runSchema(UpdateProductDto, {
      title: null,
      price: null,
      description: null,
    });
    expect(r.fields.title).toBe('Enter a title for your item.');
    expect(r.fields.price).toBe('Enter a price.');
    expect(r.fields.description).toBeUndefined();
  });

  it('no longer accepts isFeatured / isAvailable', async () => {
    const r = await runSchema(UpdateProductDto, {
      isFeatured: true,
      isAvailable: false,
    });
    expect(Object.keys(r.fields).sort()).toEqual(['isAvailable', 'isFeatured']);
  });
});
