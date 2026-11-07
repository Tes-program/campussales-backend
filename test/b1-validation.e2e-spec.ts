import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { createTestApp } from './setup/app';
import { Category } from '../src/products/entities/category.entity';
import { Product } from '../src/products/entities/product.entity';
import { Wishlist } from '../src/wishlist/entities/wishlist.entity';
import { Message } from '../src/chat/entities/message.entity';
import { Conversation } from '../src/chat/entities/conversation.entity';
import { University } from '../src/users/entities/university.entity';
import { User } from '../src/users/entities/user.entity';
import { UserType } from '../src/common/enum/user.enums';

const img = (n: number) =>
  `https://res.cloudinary.com/campussales-test/image/upload/v1/campussales/${n}.jpg`;

interface ProductBody {
  id: string;
  images: { imageUrl: string; isPrimary: boolean }[];
  [key: string]: unknown;
}

let titleSeq = 0;
const listing = (o: Record<string, unknown> = {}) => ({
  title: `Casio fx-991ES calculator ${++titleSeq}`,
  description: 'Works perfectly.',
  price: 7500,
  quantity: 1,
  category: 'school-supplies',
  condition: 'used',
  images: [img(1), img(2)],
  tags: ['Calculator', 'casio', 'calculator'],
  ...o,
});

describe('B1 validation and data integrity (e2e)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let createUser: Awaited<ReturnType<typeof createTestApp>>['createUser'];
  let seller: Awaited<ReturnType<typeof createUser>>;
  let other: Awaited<ReturnType<typeof createUser>>;
  let http: () => ReturnType<typeof request>;

  beforeAll(async () => {
    ({ app, ds, createUser } = await createTestApp());
    http = () => request(app.getHttpServer());
    seller = await createUser('seller');
    other = await createUser('buyer');
  });
  afterAll(() => app.close());

  const createListing = async (o: Record<string, unknown> = {}) => {
    const res = await http()
      .post('/api/products')
      .set(seller.auth)
      .send(listing(o));
    expect(res.status).toBe(201);
    return res.body as ProductBody;
  };

  // ───────────────────────────── error format ─────────────────────────────

  describe('error format', () => {
    it('price 0 returns 400 with fields.price, request id and legacy fields', async () => {
      const res = await http()
        .post('/api/products')
        .set(seller.auth)
        .send(listing({ price: 0 }));
      expect(res.status).toBe(400);
      expect(res.body.error).toMatchObject({
        code: 'VALIDATION_FAILED',
        message: 'Please fix the highlighted fields.',
        fields: { price: 'Price must be at least ₦50.' },
      });
      expect(res.headers['x-request-id']).toBeTruthy();
      expect(res.body.error.requestId).toBe(res.headers['x-request-id']);
      // legacy fields for the deployed frontend
      expect(res.body.statusCode).toBe(400);
      expect(res.body.message).toEqual(['Price must be at least ₦50.']);
    });

    it('quantity -3 returns 400 with fields.quantity', async () => {
      const res = await http()
        .post('/api/products')
        .set(seller.auth)
        .send(listing({ quantity: -3 }));
      expect(res.status).toBe(400);
      expect(res.body.error.fields).toEqual({
        quantity: 'Quantity must be at least 1.',
      });
    });

    it('rejects images from another host', async () => {
      const res = await http()
        .post('/api/products')
        .set(seller.auth)
        .send(listing({ images: ['https://i.imgur.com/x.jpg'] }));
      expect(res.body.error.fields.images).toBe(
        'Photos must be uploaded through CampusSales.',
      );
    });

    it('401 without a token uses UNAUTHENTICATED and still has a request id', async () => {
      const res = await http().post('/api/products').send(listing());
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
      expect(res.body.error.message).toBe('Please log in to continue.');
      expect(res.headers['x-request-id']).toBeTruthy();
    });

    it('reuses a well-formed incoming X-Request-Id', async () => {
      const res = await http()
        .get('/api/products/not-a-uuid')
        .set('X-Request-Id', 'trace-abc12345');
      expect(res.status).toBe(400);
      expect(res.headers['x-request-id']).toBe('trace-abc12345');
      expect(res.body.error.message).toBe(
        'Please check your details and try again.',
      );
    });

    it('malformed JSON is a 400, not a 500', async () => {
      const res = await http()
        .post('/api/products')
        .set(seller.auth)
        .set('Content-Type', 'application/json')
        .send('{"title": ');
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('a category that is not in the database is a field error, not a 500', async () => {
      const res = await http()
        .post('/api/products')
        .set(seller.auth)
        .send(
          listing({
            category: undefined,
            categoryId: '00000000-0000-4000-8000-000000000000',
          }),
        );
      expect(res.status).toBe(400);
      expect(res.body.error.fields).toEqual({
        categoryId: 'Choose a category from the list.',
      });
    });
  });

  describe('categories (single source of truth in code)', () => {
    it('accepts a category row stored under an older alias slug', async () => {
      const legacy = await ds.getRepository(Category).save({
        name: 'Stationery (old seed)',
        slug: 'stationery',
        isActive: true,
      });
      const res = await http()
        .post('/api/products')
        .set(seller.auth)
        .send(listing({ category: undefined, categoryId: legacy.id }));
      expect(res.status).toBe(201);
    });

    it('rejects a category row that is not in the shared list', async () => {
      const rogue = await ds.getRepository(Category).save({
        name: 'Weapons',
        slug: 'weapons',
        isActive: true,
      });
      const res = await http()
        .post('/api/products')
        .set(seller.auth)
        .send(listing({ category: undefined, categoryId: rogue.id }));
      expect(res.status).toBe(400);
      expect(res.body.error.fields).toEqual({
        categoryId: 'Choose a category from the list.',
      });
    });
  });

  // ───────────────────────────── create / edit ────────────────────────────

  describe('create and edit', () => {
    it('creates a listing and returns the full object', async () => {
      const p = await createListing();
      expect(p.title).toMatch(/^Casio fx-991ES calculator \d+$/);
      expect(p).toMatchObject({
        price: 7500,
        status: 'active',
        isAvailable: true,
        isSold: false,
        tags: ['calculator', 'casio'],
        priceHistory: [],
        category: { slug: 'school-supplies' },
      });
      expect(p.images.map((i: { imageUrl: string }) => i.imageUrl)).toEqual([
        img(1),
        img(2),
      ]);
      expect(p.images[0].isPrimary).toBe(true);
    });

    it('accepts the payload shape the deployed frontend sends (categoryId, like_new)', async () => {
      const cat = await ds
        .getRepository(Category)
        .findOneByOrFail({ slug: 'electronics' });
      const res = await http()
        .post('/api/products')
        .set(seller.auth)
        .send({
          title: 'iPhone 13',
          description: 'Clean',
          price: 450000,
          condition: 'like_new',
          quantity: 1,
          categoryId: cat.id,
          images: [img(3)],
          tags: ['iphone'],
        });
      expect(res.status).toBe(201);
      expect(res.body.categoryId).toBe(cat.id);
    });

    it('PATCH accepts any subset, records priceHistory and returns the product', async () => {
      const p = await createListing();
      const res = await http()
        .patch(`/api/products/${p.id}`)
        .set(seller.auth)
        .send({ price: 6000, title: 'Casio calculator (price drop)' });
      expect(res.status).toBe(200);
      expect(res.body.price).toBe(6000);
      expect(res.body.title).toBe('Casio calculator (price drop)');
      expect(res.body.priceHistory).toHaveLength(1);
      expect(res.body.priceHistory[0]).toMatchObject({
        oldPrice: 7500,
        newPrice: 6000,
      });

      const same = await http()
        .patch(`/api/products/${p.id}`)
        .set(seller.auth)
        .send({ price: 6000 });
      expect(same.body.priceHistory).toHaveLength(1);

      const imgs = await http()
        .patch(`/api/products/${p.id}`)
        .set(seller.auth)
        .send({ images: [img(9)], category: 'electronics', tags: [] });
      expect(
        imgs.body.images.map((i: { imageUrl: string }) => i.imageUrl),
      ).toEqual([img(9)]);
      expect(imgs.body.category.slug).toBe('electronics');
      expect(imgs.body.tags).toEqual([]);
    });

    it('PATCH validates with the same rules', async () => {
      const p = await createListing();
      const res = await http()
        .patch(`/api/products/${p.id}`)
        .set(seller.auth)
        .send({ price: 49, quantity: 0 });
      expect(res.status).toBe(400);
      expect(Object.keys(res.body.error.fields).sort()).toEqual([
        'price',
        'quantity',
      ]);
    });

    it('a non-owner PATCH returns 403', async () => {
      const p = await createListing();
      const res = await http()
        .patch(`/api/products/${p.id}`)
        .set(other.auth)
        .send({ price: 100 });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      expect(res.body.error.message).toBe(
        'Only the seller can change this item.',
      );
    });

    it('non-owners cannot sell, delete, relist or deactivate', async () => {
      const p = await createListing();
      for (const [method, path] of [
        ['post', 'sold'],
        ['post', 'relist'],
        ['post', 'deactivate'],
        ['post', 'activate'],
      ] as const) {
        expect(
          (
            await http()
              [method](`/api/products/${p.id}/${path}`)
              .set(other.auth)
          ).status,
        ).toBe(403);
      }
      expect(
        (await http().delete(`/api/products/${p.id}`).set(other.auth)).status,
      ).toBe(403);
    });
  });

  // ─────────────────────────── lifecycle actions ──────────────────────────

  describe('sold, activate, deactivate, relist', () => {
    it('mark as sold twice returns 200 both times', async () => {
      const p = await createListing();
      const a = await http()
        .post(`/api/products/${p.id}/sold`)
        .set(seller.auth);
      const b = await http()
        .post(`/api/products/${p.id}/sold`)
        .set(seller.auth);
      expect([a.status, b.status]).toEqual([200, 200]);
      expect(b.body).toMatchObject({
        status: 'sold',
        isSold: true,
        isAvailable: false,
      });
      // legacy route still works and is idempotent too
      expect(
        (await http().patch(`/api/products/${p.id}/sold`).set(seller.auth))
          .status,
      ).toBe(200);
    });

    it('sold items cannot be edited or activated, only relisted', async () => {
      const p = await createListing();
      await http().post(`/api/products/${p.id}/sold`).set(seller.auth);
      const edit = await http()
        .patch(`/api/products/${p.id}`)
        .set(seller.auth)
        .send({ price: 9000 });
      expect(edit.status).toBe(409);
      expect(edit.body.error.code).toBe('CONFLICT');
      expect(
        (await http().post(`/api/products/${p.id}/activate`).set(seller.auth))
          .status,
      ).toBe(409);
      expect(
        (await http().post(`/api/products/${p.id}/deactivate`).set(seller.auth))
          .body.status,
      ).toBe('sold');
    });

    it('deactivate and activate are idempotent', async () => {
      const p = await createListing();
      for (let i = 0; i < 2; i++) {
        const r = await http()
          .post(`/api/products/${p.id}/deactivate`)
          .set(seller.auth);
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({
          status: 'inactive',
          isAvailable: false,
        });
      }
      for (let i = 0; i < 2; i++) {
        const r = await http()
          .post(`/api/products/${p.id}/activate`)
          .set(seller.auth);
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ status: 'active', isAvailable: true });
      }
    });

    it('legacy PATCH /unavailable still toggles', async () => {
      const p = await createListing();
      expect(
        (
          await http()
            .patch(`/api/products/${p.id}/unavailable`)
            .set(seller.auth)
        ).body.isAvailable,
      ).toBe(false);
      expect(
        (
          await http()
            .patch(`/api/products/${p.id}/unavailable`)
            .set(seller.auth)
        ).body.isAvailable,
      ).toBe(true);
    });

    it('relist makes a sold item active, can apply edits, and bumps createdAt once per 24h', async () => {
      const p = await createListing();
      await ds.query(
        `UPDATE products SET "createdAt" = now() - interval '10 days' WHERE id = $1`,
        [p.id],
      );
      await http().post(`/api/products/${p.id}/sold`).set(seller.auth);

      const res = await http()
        .post(`/api/products/${p.id}/relist`)
        .set(seller.auth)
        .send({ price: 5000 });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        status: 'active',
        isSold: false,
        isAvailable: true,
        price: 5000,
      });
      expect(Date.now() - new Date(res.body.createdAt).getTime()).toBeLessThan(
        60_000,
      );
      expect(res.body.lastBumpedAt).toBeTruthy();

      // Already active and bumped just now: 429
      const again = await http()
        .post(`/api/products/${p.id}/relist`)
        .set(seller.auth);
      expect(again.status).toBe(429);
      expect(again.body.error.code).toBe('RATE_LIMITED');

      // Sold again within 24h: relist reactivates but does not bump
      const createdAt = res.body.createdAt;
      await http().post(`/api/products/${p.id}/sold`).set(seller.auth);
      const third = await http()
        .post(`/api/products/${p.id}/relist`)
        .set(seller.auth);
      expect(third.status).toBe(200);
      expect(third.body.status).toBe('active');
      expect(third.body.createdAt).toBe(createdAt);
    });

    it('relist validates the whole listing', async () => {
      const p = await createListing();
      await http().post(`/api/products/${p.id}/sold`).set(seller.auth);
      const res = await http()
        .post(`/api/products/${p.id}/relist`)
        .set(seller.auth)
        .send({ price: 10 });
      expect(res.status).toBe(400);
      expect(res.body.error.fields.price).toBe('Price must be at least ₦50.');
    });
  });

  // ─────────────────────────────── delete ─────────────────────────────────

  describe('soft delete', () => {
    it('removes the item from every list, search, wishlist and chat header', async () => {
      const p = await createListing({
        title: 'Unique deletable lamp',
        category: 'furniture',
      });
      await http()
        .post('/api/wishlist')
        .set(other.auth)
        .send({ productId: p.id })
        .expect(201);

      // a chat message that references the product
      const conv = await ds.getRepository(Conversation).save({});
      await ds.getRepository(Message).save({
        conversationId: conv.id,
        senderId: other.user.id,
        content: 'Is this available?',
        productId: p.id,
      });

      const del = await http().delete(`/api/products/${p.id}`).set(seller.auth);
      expect(del.status).toBe(200);
      expect(del.body.id).toBe(p.id);
      expect(del.body.deletedAt).toBeTruthy();

      expect((await http().get(`/api/products/${p.id}`)).status).toBe(404);
      expect((await http().get(`/api/products/${p.id}`)).body.error.code).toBe(
        'NOT_FOUND',
      );

      const ids = (r: request.Response): string[] => {
        const body = r.body as { data?: { id: string }[] } | { id: string }[];
        const list = Array.isArray(body) ? body : (body.data ?? []);
        return list.map((x) => x.id);
      };
      expect(ids(await http().get('/api/products?limit=100'))).not.toContain(
        p.id,
      );
      expect(
        ids(await http().get('/api/products?search=deletable')),
      ).not.toContain(p.id);
      expect(
        ids(
          await http()
            .get('/api/products/my-products?limit=100')
            .set(seller.auth),
        ),
      ).not.toContain(p.id);
      expect(
        ids(await http().get('/api/products/recommended').set(other.auth)),
      ).not.toContain(p.id);

      // wishlist keeps it, marked unavailable, instead of a broken card
      const wl = await http().get('/api/wishlist').set(other.auth);
      const entry = wl.body.data.find((w: Wishlist) => w.productId === p.id);
      expect(entry).toMatchObject({
        isUnavailable: true,
        unavailableMessage: 'No longer available',
      });
      expect(entry.product.title).toBe('Unique deletable lamp');

      // chat header: the product relation is no longer loaded
      const msg = await ds.getRepository(Message).findOne({
        where: { conversationId: conv.id },
        relations: ['product'],
      });
      expect(msg?.product).toBeNull();

      // cannot be wishlisted, edited or deleted again
      await http()
        .post('/api/wishlist')
        .set(seller.auth)
        .send({ productId: p.id })
        .expect(404);
      expect(
        (
          await http()
            .patch(`/api/products/${p.id}`)
            .set(seller.auth)
            .send({ price: 100 })
        ).status,
      ).toBe(404);
      expect(
        (await http().delete(`/api/products/${p.id}`).set(seller.auth)).status,
      ).toBe(404);

      // the row still exists
      const row = await ds
        .getRepository(Product)
        .findOne({ where: { id: p.id }, withDeleted: true });
      expect(row?.deletedAt).toBeTruthy();
    });

    it('sold items can be deleted too', async () => {
      const p = await createListing();
      await http().post(`/api/products/${p.id}/sold`).set(seller.auth);
      expect(
        (await http().delete(`/api/products/${p.id}`).set(seller.auth)).status,
      ).toBe(200);
    });
  });

  // ─────────────────────────── needs_review / drafts ──────────────────────

  it('needs_review items are hidden from the feed and only re-activate once valid', async () => {
    const p = await createListing({ title: 'Reviewable desk fan' });
    await ds.query(
      `UPDATE products SET status = 'needs_review', "isAvailable" = false, price = 10 WHERE id = $1`,
      [p.id],
    );
    const feed = await http().get('/api/products?search=Reviewable');
    expect(feed.body.data.map((x: { id: string }) => x.id)).not.toContain(p.id);

    const blocked = await http()
      .post(`/api/products/${p.id}/activate`)
      .set(seller.auth);
    expect(blocked.status).toBe(400);
    expect(blocked.body.error.fields.price).toBe('Price must be at least ₦50.');

    await http()
      .patch(`/api/products/${p.id}`)
      .set(seller.auth)
      .send({ price: 8000 })
      .expect(200);
    const ok = await http()
      .post(`/api/products/${p.id}/activate`)
      .set(seller.auth);
    expect(ok.body.status).toBe('active');
  });

  it('publishing a draft goes through the same listing rules', async () => {
    const draft = await http()
      .post('/api/products/drafts')
      .set(seller.auth)
      .send({
        title: 'Draft chair',

        condition: 'used',
        images: [img(5)],
      });
    expect(draft.status).toBe(201);
    const res = await http()
      .post(`/api/products/drafts/${draft.body.id}/publish`)
      .set(seller.auth)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe(
      'Finish the highlighted fields before publishing.',
    );
    expect(res.body.error.fields).toMatchObject({
      price: 'Enter a price.',
      category: 'Please select a category.',
    });

    const ok = await http()
      .post(`/api/products/drafts/${draft.body.id}/publish`)
      .set(seller.auth)
      .send({
        price: 12000,
        categoryId: (
          await ds
            .getRepository(Category)
            .findOneByOrFail({ slug: 'furniture' })
        ).id,
      });
    expect(ok.status).toBe(201);
    expect(ok.body.status).toBe('active');
  });

  describe('remaining write endpoints validate input', () => {
    it('draft fields follow the listing rules but may be incomplete', async () => {
      const ok = await http()
        .post('/api/products/drafts')
        .set(seller.auth)
        .send({ title: 'Ch', images: [] });
      expect(ok.status).toBe(201);
      const bad = await http()
        .post('/api/products/drafts')
        .set(seller.auth)
        .send({
          price: 10.5,
          quantity: -3,
          images: ['https://evil.example/x.jpg'],
        });
      expect(bad.status).toBe(400);
      expect(bad.body.error.fields).toEqual({
        price: 'Price must be a whole number of naira (no kobo).',
        quantity: 'Quantity must be at least 1.',
        images: 'Photos must be uploaded through CampusSales.',
      });
    });

    it('a draft can store a category slug', async () => {
      const res = await http()
        .post('/api/products/drafts')
        .set(seller.auth)
        .send({ category: 'Books & Textbooks' });
      const cat = await ds
        .getRepository(Category)
        .findOneByOrFail({ slug: 'books-textbooks' });
      expect(res.body.categoryId).toBe(cat.id);
    });

    it('auto-save validates its body', async () => {
      const missing = await http()
        .post('/api/products/drafts/auto-save')
        .set(seller.auth)
        .send({});
      expect(missing.status).toBe(400);
      expect(missing.body.error.fields.data).toBe('This field is required.');
      const nested = await http()
        .post('/api/products/drafts/auto-save')
        .set(seller.auth)
        .send({ draftId: 'nope', data: { price: 0 } });
      expect(nested.body.error.fields).toEqual({
        draftId: "This value isn't valid.",
        'data.price': 'Price must be at least ₦50.',
      });
      const ok = await http()
        .post('/api/products/drafts/auto-save')
        .set(seller.auth)
        .send({ data: { title: 'Desk lamp' } });
      expect(ok.status).toBe(201);
    });

    it('wishlist check-multiple validates ids', async () => {
      const bad = await http()
        .post('/api/wishlist/check-multiple')
        .set(other.auth)
        .send({ productIds: ['x'] });
      expect(bad.status).toBe(400);
      expect(bad.body.error.fields.productIds).toBe(
        'Each item id must be valid.',
      );
    });

    it('admin status and bulk endpoints validate input', async () => {
      const admin = await createUser('admin', { userType: UserType.ADMIN });
      const status = await http()
        .patch(`/api/users/${other.user.id}/status`)
        .set(admin.auth)
        .send({ status: 'banana' });
      expect(status.status).toBe(400);
      expect(status.body.error.fields.status).toBe(
        'Status must be active, inactive or suspended.',
      );
      const bulk = await http()
        .post('/api/categories/bulk')
        .set(admin.auth)
        .send([{ name: 'X' }]);
      expect(bulk.status).toBe(400);
      expect(bulk.body.error.code).toBe('VALIDATION_FAILED');
      const notArray = await http()
        .post('/api/universities/bulk')
        .set(admin.auth)
        .send({ name: 'X' });
      expect(notArray.status).toBe(400);
    });
  });

  // ─────────────────────────────── onboarding ─────────────────────────────

  describe('onboarding', () => {
    let unilag: University;
    beforeAll(async () => {
      unilag = await ds
        .getRepository(University)
        .findOneByOrFail({ code: 'UNILAG' });
    });
    const payload = (o: Record<string, unknown> = {}) => ({
      firstName: 'Ada',
      lastName: 'Okafor',
      phone: '08031234567',
      school: unilag.id,
      level: '300',
      gender: 'Female',
      interests: ['electronics', 'books'],
      ...o,
    });

    it('phone "123" returns 400 with fields.phone and the friendly message', async () => {
      const u = await createUser();
      const res = await http()
        .post('/api/users/onboarding/complete')
        .set(u.auth)
        .send(payload({ phone: '123' }));
      expect(res.status).toBe(400);
      expect(res.body.error.fields).toEqual({
        phone: 'Enter a valid Nigerian phone number, like 0803 123 4567.',
      });
    });

    it('08031234567 returns 200, stores +2348031234567 and is idempotent', async () => {
      const u = await createUser();
      const first = await http()
        .post('/api/users/onboarding/complete')
        .set(u.auth)
        .send(payload());
      expect(first.status).toBe(200);
      expect(first.body.phoneNumber).toBe('+2348031234567');
      expect(first.body.school).toEqual({
        id: unilag.id,
        name: 'University of Lagos',
        shortName: 'UNILAG',
        city: 'Lagos',
      });
      expect(first.body.profile).toMatchObject({
        universityId: unilag.id,
        universityName: 'University of Lagos',
        level: '300',
        gender: 'Female',
        interests: ['electronics', 'books-textbooks'],
      });
      expect(JSON.stringify(first.body)).not.toMatch(/password/i);

      const stored = await ds
        .getRepository(User)
        .findOneByOrFail({ id: u.user.id });
      expect(stored.phoneNumber).toBe('+2348031234567');

      const second = await http()
        .post('/api/users/onboarding/complete')
        .set(u.auth)
        .send(payload());
      expect(second.status).toBe(200);
      expect(second.body.profile).toEqual(
        first.body.profile && {
          ...first.body.profile,
          updatedAt: second.body.profile.updatedAt,
        },
      );

      // same number on another account -> 409
      const v = await createUser();
      const dup = await http()
        .post('/api/users/onboarding/complete')
        .set(v.auth)
        .send(payload({ phone: '+234 803 123 4567' }));
      expect(dup.status).toBe(409);
      expect(dup.body.error).toMatchObject({
        code: 'CONFLICT',
        message: 'That number is already used on another account.',
        fields: { phone: 'That number is already used on another account.' },
      });
    });

    it('accepts the exact payload the deployed frontend sends', async () => {
      const u = await createUser();
      const res = await http()
        .post('/api/users/onboarding/complete')
        .set(u.auth)
        .send({
          firstName: 'Tunde',
          lastName: 'Bello',
          phoneNumber: '0909 555 1234',
          gender: 'male',
          universityId: unilag.id,
          level: 'Graduate',
          interests: ['clothing', 'beauty'],
        });
      expect(res.status).toBe(200);
      expect(res.body.phoneNumber).toBe('+2349095551234');
      expect(res.body.profile.level).toBe('Alumnus');
      expect(res.body.profile.interests).toEqual([
        'clothing-apparel',
        'beauty-personal-care',
      ]);
    });

    it('accepts a school by short name and rejects unknown schools', async () => {
      const u = await createUser();
      const ok = await http()
        .post('/api/users/onboarding/complete')
        .set(u.auth)
        .send(payload({ phone: '07011112222', school: 'unilag' }));
      expect(ok.status).toBe(200);
      expect(ok.body.school.id).toBe(unilag.id);
      const bad = await http()
        .post('/api/users/onboarding/complete')
        .set(u.auth)
        .send(payload({ phone: '07011112222', school: 'Hogwarts' }));
      expect(bad.status).toBe(400);
      expect(bad.body.error.fields).toEqual({
        school: 'Choose your school from the list.',
      });
    });

    it('profile update uses the same validators and 409 on a taken number', async () => {
      const a = await createUser();
      const b = await createUser();
      await http()
        .patch('/api/users/me')
        .set(a.auth)
        .send({ phone: '08055556666' })
        .expect(200);
      const bad = await http()
        .patch('/api/users/me')
        .set(b.auth)
        .send({ phone: '123' });
      expect(bad.body.error.fields.phone).toBe(
        'Enter a valid Nigerian phone number, like 0803 123 4567.',
      );
      const taken = await http()
        .patch('/api/users/me')
        .set(b.auth)
        .send({ phoneNumber: '0805 555 6666' });
      expect(taken.status).toBe(409);
      expect(taken.body.error.message).toBe(
        'That number is already used on another account.',
      );
      const role = await http()
        .patch('/api/users/me')
        .set(b.auth)
        .send({ userType: 'admin' });
      expect(role.status).toBe(400);
      expect(role.body.error.fields.userType).toBeDefined();
    });
  });

  // ─────────────────────────────── schools ────────────────────────────────

  describe('GET /api/schools', () => {
    it('is typo tolerant and returns id, name, shortName, city', async () => {
      const res = await http().get('/api/schools?query=unilg').expect(200);
      expect(res.body[0]).toEqual({
        id: expect.any(String),
        name: 'University of Lagos',
        shortName: 'UNILAG',
        city: 'Lagos',
      });
    });
    it('caps results at 20', async () => {
      expect(
        (await http().get('/api/schools?query=university')).body,
      ).toHaveLength(20);
      expect((await http().get('/api/schools')).body).toHaveLength(20);
    });
    it('validates the query length', async () => {
      const res = await http().get(`/api/schools?query=${'x'.repeat(101)}`);
      expect(res.status).toBe(400);
      expect(res.body.error.fields.query).toBeDefined();
    });
  });
});
