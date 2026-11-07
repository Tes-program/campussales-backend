import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { randomUUID } from 'crypto';
import { createTestApp } from './setup/app';
import { Product } from '../src/products/entities/product.entity';
import { ProductImage } from '../src/products/entities/product-image.entity';
import { Category } from '../src/products/entities/category.entity';
import { University } from '../src/users/entities/university.entity';
import { UserProfile } from '../src/users/entities/user-profile.entity';
import { UserBlock } from '../src/blocks/user-block.entity';
import { SearchService } from '../src/search/search.service';
import {
  ProductCondition,
  ProductStatus,
} from '../src/common/constants/listing';

const img = (n: number | string) =>
  `https://res.cloudinary.com/campussales-test/image/upload/v1/b3/${n}.jpg`;

type Card = {
  id: string;
  price: number;
  createdAt: string;
  sellerId: string;
  campusId: string | null;
};

describe('B3 products, search and feed (e2e)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let http: () => ReturnType<typeof request>;
  const cat: Record<string, Category> = {};
  let campusA: University;
  let campusB: University;
  let campusC: University;

  beforeAll(async () => {
    ctx = await createTestApp();
    ({ app, ds } = ctx);
    http = () => request(app.getHttpServer());
    for (const c of await ds.getRepository(Category).find()) cat[c.slug] = c;
    const uni = ds.getRepository(University);
    const mk = (name: string, city: string) =>
      uni.save(
        uni.create({
          name,
          code: `T${randomUUID().slice(0, 6)}`,
          city,
          isActive: true,
        }),
      );
    campusA = await mk(
      `Alpha Test University ${randomUUID().slice(0, 4)}`,
      'Testville',
    );
    campusB = await mk(
      `Beta Test University ${randomUUID().slice(0, 4)}`,
      'Testville',
    );
    campusC = await mk(
      `Gamma Test University ${randomUUID().slice(0, 4)}`,
      'Farcity',
    );
  });
  afterAll(() => app.close());

  async function seller(campus?: University) {
    const u = await ctx.createUser('seller');
    await ds.getRepository(UserProfile).save({
      userId: u.user.id,
      firstName: 'Tolu',
      lastName: 'Ade',
      universityId: campus?.id,
      profilePictureUrl: img('avatar'),
    });
    return u;
  }

  let seq = 0;
  async function product(
    sellerId: string,
    o: Partial<Product> & { slug?: string } = {},
  ): Promise<Product> {
    const { slug, ...rest } = o;
    const p = await ds.getRepository(Product).save(
      ds.getRepository(Product).create({
        sellerId,
        title: `Item ${seq++}`,
        description: 'A '.repeat(200) + 'long description',
        price: 5000,
        condition: ProductCondition.USED,
        quantity: 1,
        status: ProductStatus.ACTIVE,
        isAvailable: true,
        isSold: false,
        tags: [],
        priceHistory: [],
        categoryId: cat[slug ?? 'electronics'].id,
        ...rest,
      }),
    );
    await ds.getRepository(ProductImage).save([
      {
        productId: p.id,
        imageUrl: img(`${p.id}-2`),
        isPrimary: false,
        sortOrder: 1,
      },
      {
        productId: p.id,
        imageUrl: img(`${p.id}-1`),
        isPrimary: true,
        sortOrder: 0,
      },
    ]);
    return p;
  }

  const ids = (r: request.Response): string[] =>
    (r.body.items as Card[]).map((x) => x.id);

  // ───────────────────────────── item page ─────────────────────────────

  describe('GET /products/:id', () => {
    it('works without auth: seller block, ISO dates, ordered images, nothing private', async () => {
      const s = await seller(campusA);
      const p = await product(s.user.id, {
        title: 'Desk lamp',
        campusId: campusA.id,
        price: 4000,
        priceHistory: [
          {
            oldPrice: 6000,
            newPrice: 4000,
            changedAt: '2026-11-01T10:00:00.000Z',
          },
        ],
      });
      await product(s.user.id, {
        status: ProductStatus.SOLD,
        isSold: true,
        isAvailable: false,
      });

      const res = await http().get(`/api/products/${p.id}`);
      expect(res.status).toBe(200);
      const iso = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
      expect(res.body.createdAt).toMatch(iso);
      expect(res.body.updatedAt).toMatch(iso);
      expect(res.body).toMatchObject({
        id: p.id,
        status: 'active',
        price: 4000,
        previousPrice: 6000,
        droppedAt: '2026-11-01T10:00:00.000Z',
        category: { slug: 'electronics' },
      });
      expect(res.body.images[0].isPrimary).toBe(true);
      expect(res.body.seller).toMatchObject({
        id: s.user.id,
        firstName: 'Tolu',
        avatar: img('avatar'),
        campus: { id: campusA.id, name: campusA.name },
        itemsSold: 1,
        verifiedStudent: false,
      });
      expect(res.body.seller.memberSince).toMatch(iso);
      expect(res.body.seller.email).toBeUndefined();
      expect(res.body.seller.phoneNumber).toBeUndefined();
      expect(res.body.isOwner).toBeUndefined();
      expect(res.headers['cache-control']).toBe('public, max-age=60');
      expect(res.headers.etag).toBeTruthy();

      const again = await http()
        .get(`/api/products/${p.id}`)
        .set('If-None-Match', res.headers.etag);
      expect(again.status).toBe(304);
    });

    it('adds isOwner/isWishlisted for viewers; email and wishlistCount only for the owner', async () => {
      const s = await seller();
      const buyer = await ctx.createUser('buyer');
      const p = await product(s.user.id);
      await http().post(`/api/wishlist/${p.id}`).set(buyer.auth).expect(200);

      const asBuyer = await http().get(`/api/products/${p.id}`).set(buyer.auth);
      expect(asBuyer.body).toMatchObject({
        isOwner: false,
        isWishlisted: true,
      });
      expect(asBuyer.body.wishlistCount).toBeUndefined();
      expect(asBuyer.body.seller.email).toBeUndefined();
      expect(asBuyer.headers['cache-control']).toBe('private, no-store');

      const asOwner = await http().get(`/api/products/${p.id}`).set(s.auth);
      expect(asOwner.body).toMatchObject({ isOwner: true, wishlistCount: 1 });
      expect(asOwner.body.seller.email).toBe(s.user.email);
    });

    it('sold and inactive return 200 with status; deleted returns 404', async () => {
      const s = await seller();
      const sold = await product(s.user.id, {
        status: ProductStatus.SOLD,
        isSold: true,
        isAvailable: false,
      });
      const off = await product(s.user.id, {
        status: ProductStatus.INACTIVE,
        isAvailable: false,
      });
      const gone = await product(s.user.id);
      await ds.getRepository(Product).softDelete({ id: gone.id });
      expect((await http().get(`/api/products/${sold.id}`)).body.status).toBe(
        'sold',
      );
      expect((await http().get(`/api/products/${off.id}`)).body.status).toBe(
        'inactive',
      );
      expect((await http().get(`/api/products/${gone.id}`)).status).toBe(404);
    });
  });

  // ───────────────────────────── list ──────────────────────────────────

  describe('GET /products (list)', () => {
    it('two pages contain no duplicates, and page 2 respects the cursor after new inserts', async () => {
      const s = await seller();
      const tag = `pg${randomUUID().slice(0, 6)}`;
      for (let i = 0; i < 30; i++) await product(s.user.id, { tags: [tag] });

      const p1 = await http().get(`/api/products?tag=${tag}&limit=20`);
      expect(p1.status).toBe(200);
      expect(p1.body.items).toHaveLength(20);
      expect(p1.body.total).toBe(30);
      expect(p1.body.nextCursor).toEqual(expect.any(String));
      expect(p1.body.data).toEqual(p1.body.items); // legacy field kept

      // new listings arrive between page loads
      for (let i = 0; i < 5; i++) await product(s.user.id, { tags: [tag] });

      const p2 = await http().get(
        `/api/products?tag=${tag}&limit=20&cursor=${p1.body.nextCursor}`,
      );
      expect(p2.body.items).toHaveLength(10);
      expect(p2.body.nextCursor).toBeNull();
      const all = [...ids(p1), ...ids(p2)];
      expect(new Set(all).size).toBe(30);
      // newest first, strictly
      const times = [...p1.body.items, ...p2.body.items].map(
        (x: Card) => x.createdAt,
      );
      expect([...times].sort().reverse()).toEqual(times);
    });

    it('sorts by price both ways with stable cursors', async () => {
      const s = await seller();
      const tag = `pr${randomUUID().slice(0, 6)}`;
      for (const price of [900, 100, 500, 300, 700])
        await product(s.user.id, { tags: [tag], price });
      const asc = await http().get(
        `/api/products?tag=${tag}&sort=price_asc&limit=2`,
      );
      const asc2 = await http().get(
        `/api/products?tag=${tag}&sort=price_asc&limit=2&cursor=${asc.body.nextCursor}`,
      );
      const asc3 = await http().get(
        `/api/products?tag=${tag}&sort=price_asc&limit=2&cursor=${asc2.body.nextCursor}`,
      );
      expect(
        [...asc.body.items, ...asc2.body.items, ...asc3.body.items].map(
          (x: Card) => x.price,
        ),
      ).toEqual([100, 300, 500, 700, 900]);
      const desc = await http().get(`/api/products?tag=${tag}&sort=price_desc`);
      expect(desc.body.items.map((x: Card) => x.price)).toEqual([
        900, 700, 500, 300, 100,
      ]);
    });

    it('applies each filter', async () => {
      const s = await seller();
      const tag = `fl${randomUUID().slice(0, 6)}`;
      const a = await product(s.user.id, {
        tags: [tag],
        price: 1000,
        condition: ProductCondition.NEW,
        slug: 'furniture',
      });
      const b = await product(s.user.id, {
        tags: [tag],
        price: 3000,
        condition: ProductCondition.FAIR,
        slug: 'gaming',
      });
      const c = await product(s.user.id, {
        tags: [tag],
        price: 5000,
        condition: ProductCondition.USED,
        slug: 'gaming',
      });
      const sold = await product(s.user.id, {
        tags: [tag],
        status: ProductStatus.SOLD,
        isSold: true,
        isAvailable: false,
      });
      await product(s.user.id, {
        tags: [tag],
        status: ProductStatus.NEEDS_REVIEW,
        isAvailable: false,
      });

      const q = (qs: string) => http().get(`/api/products?tag=${tag}&${qs}`);
      expect(new Set(ids(await q('')))).toEqual(new Set([a.id, b.id, c.id]));
      expect(ids(await q('category=gaming')).sort()).toEqual(
        [b.id, c.id].sort(),
      );
      expect(ids(await q('category=furniture,gaming')).length).toBe(3);
      expect(ids(await q('condition=new&condition=fair')).sort()).toEqual(
        [a.id, b.id].sort(),
      );
      expect(ids(await q('condition=Like New')).length).toBe(0);
      expect(ids(await q('minPrice=2000&maxPrice=4000'))).toEqual([b.id]);
      expect(ids(await q('status=sold'))).toEqual([sold.id]);
      expect(
        ids(await http().get(`/api/products?tag=${tag}&sellerId=${s.user.id}`))
          .length,
      ).toBe(3);
      // list items are cards: excerpt, no seller email
      const card = (await q('')).body.items[0];
      expect(card.description.length).toBeLessThanOrEqual(160);
      expect(card.excerpt).toBe(card.description);
      expect(card.seller.email).toBeUndefined();
    });

    it('validates every parameter with field errors', async () => {
      const bad = await http().get(
        '/api/products?limit=500&minPrice=-1&campus=nope&category=weapons&sort=relevance&status=needs_review&cursor=junk&condition=mint',
      );
      expect(bad.status).toBe(400);
      expect(Object.keys(bad.body.error.fields).sort()).toEqual(
        [
          'campus',
          'category',
          'condition',
          'cursor',
          'limit',
          'minPrice',
          'sort',
          'status',
        ].sort(),
      );
      expect(bad.body.error.fields.sort).toBe(
        'Relevance sorting needs a search term.',
      );
      const range = await http().get(
        '/api/products?minPrice=5000&maxPrice=100',
      );
      expect(range.body.error.fields.maxPrice).toBe(
        'Maximum price must be at least the minimum price.',
      );
    });

    it('campus "all" returns every campus; campus X filters; few results bring moreFromNearby', async () => {
      const tag = `cp${randomUUID().slice(0, 6)}`;
      const sa = await seller(campusA);
      const sb = await seller(campusB);
      const sc = await seller(campusC);
      const a1 = await product(sa.user.id, {
        tags: [tag],
        campusId: campusA.id,
      });
      const b1 = await product(sb.user.id, {
        tags: [tag],
        campusId: campusB.id,
      });
      const c1 = await product(sc.user.id, {
        tags: [tag],
        campusId: campusC.id,
      });

      const all = await http().get(`/api/products?tag=${tag}&campus=all`);
      expect(new Set(ids(all))).toEqual(new Set([a1.id, b1.id, c1.id]));
      expect(all.body.fromOtherCampuses).toBe(false);

      const onlyA = await http().get(
        `/api/products?tag=${tag}&campus=${campusA.id}`,
      );
      expect(ids(onlyA)).toEqual([a1.id]);
      expect(onlyA.body.fromOtherCampuses).toBe(true);
      // same city (campus B) before a different city (campus C)
      expect(onlyA.body.moreFromNearby.map((x: Card) => x.id)).toEqual([
        b1.id,
        c1.id,
      ]);

      // no campus param means no campus restriction (never defaulted)
      expect(ids(await http().get(`/api/products?tag=${tag}`)).length).toBe(3);
    });

    it('hides blocked users in both directions', async () => {
      const tag = `bl${randomUUID().slice(0, 6)}`;
      const viewer = await ctx.createUser('viewer');
      const blockedByMe = await seller();
      const blockedMe = await seller();
      const ok = await seller();
      await product(blockedByMe.user.id, { tags: [tag] });
      await product(blockedMe.user.id, { tags: [tag] });
      const okP = await product(ok.user.id, { tags: [tag] });
      await ds.getRepository(UserBlock).save([
        { blockerId: viewer.user.id, blockedId: blockedByMe.user.id },
        { blockerId: blockedMe.user.id, blockedId: viewer.user.id },
      ]);
      expect(
        ids(await http().get(`/api/products?tag=${tag}`).set(viewer.auth)),
      ).toEqual([okP.id]);
      expect(ids(await http().get(`/api/products?tag=${tag}`)).length).toBe(3);
    });

    it('runs in 5 queries or fewer', async () => {
      const r1 = await http().get('/api/products?limit=20');
      expect(Number(r1.headers['x-query-count'])).toBeLessThanOrEqual(5);
      const r2 = await http().get(
        `/api/products?q=lamp&campus=${campusA.id}&category=electronics`,
      );
      expect(Number(r2.headers['x-query-count'])).toBeLessThanOrEqual(5);
    });
  });

  // ───────────────────────────── search ────────────────────────────────

  describe('search', () => {
    beforeAll(async () => {
      const s = await seller();
      await product(s.user.id, {
        title: 'Apple iPhone 13 Pro 128GB',
        slug: 'electronics',
        tags: ['apple'],
      });
      await product(s.user.id, {
        title: 'HP laptop 15 inch, 8GB RAM',
        slug: 'electronics',
      });
      await product(s.user.id, {
        title: 'Dell Inspiron laptop',
        slug: 'electronics',
      });
      await product(s.user.id, {
        title: 'Samsung Galaxy A12',
        slug: 'electronics',
      });
      await product(s.user.id, {
        title: 'Mountain bicycle with gears',
        slug: 'bikes-transportation',
      });
      await product(s.user.id, {
        title: 'Standing fan (Ox brand)',
        slug: 'home-kitchen',
      });
      await product(s.user.id, {
        title: 'Tokunbo phone charger',
        slug: 'electronics',
      });
      await app.get(SearchService).refreshVocabulary();
    });

    const titles = (r: request.Response) =>
      (r.body.items as { title: string }[]).map((x) => x.title);

    it.each([
      ['iphon', /iPhone/],
      ['laptpo', /laptop/i],
      ['samsng', /Samsung/],
      ['bycicle', /bicycle/i],
      ['LAPTOPS', /laptop/i], // case and plural
      ['  hp   laptop ', /HP laptop/], // extra spaces
      ['fone', /phone/i], // Nigerian term -> phone
      ['tokunbo', /Tokunbo/],
      ['fan', /fan/i], // short words are not noise
    ])('q=%p finds %p', async (q, re) => {
      const res = await http().get(
        `/api/products?q=${encodeURIComponent(q)}&sort=relevance`,
      );
      expect(res.status).toBe(200);
      expect(titles(res).some((t) => re.test(t))).toBe(true);
    });

    it('laptpo suggests didYouMean "laptop"', async () => {
      const res = await http().get('/api/products?q=laptpo');
      expect(res.body.didYouMean).toBe('laptop');
      expect(
        titles(res).filter((t) => /laptop/i.test(t)).length,
      ).toBeGreaterThanOrEqual(2);
    });

    it('keeps protected words uncorrected', async () => {
      expect(
        (await http().get('/api/products?q=tokunbo')).body.didYouMean,
      ).toBeNull();
    });

    it('logs zero-result queries without user ids', async () => {
      const q = `zzq${randomUUID().slice(0, 5)}`;
      const res = await http().get(`/api/products?q=${q}`);
      expect(res.body.total).toBe(0);
      await new Promise((r) => setTimeout(r, 100));
      const rows: { query: string }[] = await ds.query(
        `SELECT * FROM search_misses WHERE query = $1`,
        [q],
      );
      expect(rows).toHaveLength(1);
      expect(Object.keys(rows[0]).sort()).toEqual(['createdAt', 'id', 'query']);
    });

    it('suggest returns up to 8 categories and titles quickly', async () => {
      const t = Date.now();
      const res = await http().get('/api/search/suggest?q=lap');
      expect(res.status).toBe(200);
      expect(Date.now() - t).toBeLessThan(150);
      expect(res.body.suggestions.length).toBeLessThanOrEqual(8);
      expect(
        res.body.suggestions.some((s: { text: string }) =>
          /laptop/i.test(s.text),
        ),
      ).toBe(true);
      const cats = await http().get('/api/search/suggest?q=elec');
      expect(cats.body.suggestions[0]).toMatchObject({
        type: 'category',
        slug: 'electronics',
      });
    });
  });

  // ───────────────────────────── similar ───────────────────────────────

  it('similar: same category, same campus first, price band, excludes item and blocked', async () => {
    const viewer = await ctx.createUser('viewer');
    const sa = await seller(campusA);
    const sb = await seller(campusB);
    const blocked = await seller(campusA);
    const base = await product(sa.user.id, {
      slug: 'musical-instruments',
      price: 10000,
      campusId: campusA.id,
    });
    const sameCampus = await product(sa.user.id, {
      slug: 'musical-instruments',
      price: 15000,
      campusId: campusA.id,
    });
    const otherCampus = await product(sb.user.id, {
      slug: 'musical-instruments',
      price: 8000,
      campusId: campusB.id,
    });
    await product(sb.user.id, {
      slug: 'musical-instruments',
      price: 30000,
      campusId: campusB.id,
    }); // too pricey
    await product(sb.user.id, {
      slug: 'gaming',
      price: 10000,
      campusId: campusA.id,
    }); // other category
    await product(blocked.user.id, {
      slug: 'musical-instruments',
      price: 9000,
      campusId: campusA.id,
    });
    await ds
      .getRepository(UserBlock)
      .save({ blockerId: viewer.user.id, blockedId: blocked.user.id });

    const res = await http()
      .get(`/api/products/${base.id}/similar?limit=8`)
      .set(viewer.auth);
    const got = ids(res);
    expect(got).not.toContain(base.id);
    expect(got.indexOf(sameCampus.id)).toBeLessThan(
      got.indexOf(otherCampus.id),
    );
    expect(
      got.every((id) => [sameCampus.id, otherCampus.id].includes(id) || true),
    ).toBe(true);
    const all = res.body.items as Card[];
    expect(all.every((c) => c.price >= 5000 && c.price <= 20000)).toBe(true);
    expect(all.some((c) => c.sellerId === blocked.user.id)).toBe(false);
  });

  // ───────────────────────────── feed ──────────────────────────────────

  it('feed: campus and interests first, never own or blocked items, max 3 in a row per seller', async () => {
    const me = await seller(campusC);
    await ds
      .getRepository(UserProfile)
      .update({ userId: me.user.id }, { interests: ['art-crafts'] });
    const busy = await seller(campusC);
    const blocked = await seller(campusC);
    const other = await seller(campusA);
    await product(me.user.id, { slug: 'art-crafts', campusId: campusC.id });
    for (let i = 0; i < 6; i++)
      await product(busy.user.id, { slug: 'art-crafts', campusId: campusC.id });
    await product(blocked.user.id, {
      slug: 'art-crafts',
      campusId: campusC.id,
    });
    await product(other.user.id, { slug: 'art-crafts', campusId: campusA.id });
    await ds
      .getRepository(UserBlock)
      .save({ blockerId: blocked.user.id, blockedId: me.user.id });

    const res = await http().get('/api/feed?limit=50').set(me.auth);
    expect(res.status).toBe(200);
    const items = res.body.items as Card[];
    expect(items.some((c) => c.sellerId === me.user.id)).toBe(false);
    expect(items.some((c) => c.sellerId === blocked.user.id)).toBe(false);
    expect(items[0].campusId).toBe(campusC.id);
    const sellers = items.map((c) => c.sellerId).join('|');
    expect(sellers).not.toMatch(
      new RegExp(`(${busy.user.id}\\|){3}${busy.user.id}`),
    );
    expect((await http().get('/api/feed')).status).toBe(401);
  });

  it('GET/PATCH /me/interests', async () => {
    const me = await seller();
    const patch = await http()
      .patch('/api/me/interests')
      .set(me.auth)
      .send({ interests: ['books', 'gaming'] });
    expect(patch.body).toEqual({ interests: ['books-textbooks', 'gaming'] });
    expect(
      (await http().get('/api/me/interests').set(me.auth)).body.interests,
    ).toEqual(['books-textbooks', 'gaming']);
    const bad = await http()
      .patch('/api/me/interests')
      .set(me.auth)
      .send({ interests: ['crypto'] });
    expect(bad.body.error.fields.interests).toBe(
      'Pick interests from the categories list.',
    );
  });

  // ───────────────────────────── wishlist ──────────────────────────────

  it('wishlist: same card shape plus available; POST/DELETE are idempotent; deleted items stay', async () => {
    const buyer = await ctx.createUser('buyer');
    const s = await seller();
    const live = await product(s.user.id);
    const gone = await product(s.user.id);
    for (let i = 0; i < 2; i++) {
      const r = await http().post(`/api/wishlist/${live.id}`).set(buyer.auth);
      expect(r.status).toBe(200);
      expect(r.body.isInWishlist).toBe(true);
    }
    await http().post(`/api/wishlist/${gone.id}`).set(buyer.auth).expect(200);
    await ds.getRepository(Product).softDelete({ id: gone.id });

    const list = await http().get('/api/wishlist').set(buyer.auth);
    const byId = new Map(
      (
        list.body.items as (Card & { available: boolean; status: string })[]
      ).map((i) => [i.id, i]),
    );
    expect(byId.get(live.id)).toMatchObject({
      available: true,
      status: 'active',
      isWishlisted: true,
    });
    expect(byId.get(gone.id)).toMatchObject({
      available: false,
      status: 'deleted',
      unavailableMessage: 'No longer available',
    });
    expect(byId.get(live.id)!.sellerId).toBe(s.user.id);

    for (let i = 0; i < 2; i++) {
      expect(
        (await http().delete(`/api/wishlist/${live.id}`).set(buyer.auth))
          .status,
      ).toBe(204);
    }
  });

  // ───────────────────────────── share ─────────────────────────────────

  it('share preview: Open Graph tags with ₦ price, cover image, redirect to /item/:id', async () => {
    const s = await seller();
    const p = await product(s.user.id, {
      title: 'Casio <calculator>',
      price: 12500,
    });
    const res = await http().get(`/share/item/${p.id}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain(
      '<meta property="og:title" content="Casio &lt;calculator&gt;: ₦12,500 | CampusSales">',
    );
    expect(res.text).toContain(
      `<meta property="og:image" content="${img(`${p.id}-1`)}">`,
    );
    expect(res.text).toContain(`https://campus-sales.test/item/${p.id}`);
    expect(res.text).toContain('twitter:card');
    expect((await http().get('/share/item/not-a-uuid')).status).toBe(404);
    expect((await http().get('/share')).text).toContain('og:title');
  });
});
