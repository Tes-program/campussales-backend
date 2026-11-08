import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { randomUUID } from 'crypto';
import { v2 as cloudinary } from 'cloudinary';
import { createTestApp } from './setup/app';
import { Category } from '../src/products/entities/category.entity';
import { UserProfile } from '../src/users/entities/user-profile.entity';
import { User } from '../src/users/entities/user.entity';
import { CloudinaryClient } from '../src/uploads/cloudinary.client';
import { UploadCleanupService } from '../src/uploads/upload-cleanup.service';
import { AnalyticsService } from '../src/analytics/analytics.service';
import { lifecycle } from '../src/health/lifecycle';
import { CacheService } from '../src/common/cache/cache.service';

const img = (n: string) =>
  `https://res.cloudinary.com/campussales-test/image/upload/v1/b5/${n}.jpg`;
const anonId = () => randomUUID();

describe('B5 performance, analytics and observability (e2e)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let http: () => ReturnType<typeof request>;
  let electronics: Category;
  const destroyed: string[] = [];
  const resources = new Map<string, { bytes: number; format: string }>();

  beforeAll(async () => {
    ctx = await createTestApp();
    ({ app, ds } = ctx);
    http = () => request(app.getHttpServer());
    electronics = (await ds
      .getRepository(Category)
      .findOne({ where: { slug: 'electronics' } }))!;
    // Fake Cloudinary Admin API: no network in tests.
    const cloud = app.get(CloudinaryClient);
    cloud.resource = (publicId: string) => {
      const r = resources.get(publicId);
      return Promise.resolve(
        r
          ? {
              publicId,
              version: 1700000000,
              format: r.format,
              bytes: r.bytes,
              width: 1200,
              height: 900,
              secureUrl: '',
            }
          : null,
      );
    };
    cloud.destroy = (ids: string[]) => {
      destroyed.push(...ids);
      return Promise.resolve();
    };
  });
  afterAll(() => app.close());

  async function verifiedUser(label = 'b5') {
    const u = await ctx.createUser(label, { emailVerifiedAt: new Date() });
    await ds.getRepository(UserProfile).save({
      userId: u.user.id,
      firstName: 'Ada',
      lastName: 'Obi',
    });
    return u;
  }

  async function createListing(auth: Record<string, string>, title: string) {
    const res = await http()
      .post('/api/products')
      .set(auth)
      .send({
        title,
        description: 'Clean and working',
        price: 25000,
        condition: 'used',
        category: 'electronics',
        images: [img(randomUUID())],
      })
      .expect(201);
    return res.body as { id: string };
  }

  // ───────────────────────────── health ─────────────────────────────

  describe('health', () => {
    it('/health is up and /health/ready checks the database', async () => {
      const live = await request(app.getHttpServer())
        .get('/health')
        .expect(200);
      expect(live.body.status).toBe('ok');
      expect(live.headers['cache-control']).toBe('no-store');
      const ready = await http().get('/health/ready').expect(200);
      expect(ready.body.checks.database.ok).toBe(true);
      expect(ready.body.pool).toEqual(
        expect.objectContaining({ max: expect.any(Number) }),
      );
    });

    it('/health/ready returns 503 when the database is unreachable', async () => {
      const spy = jest
        .spyOn(ds, 'query')
        .mockRejectedValueOnce(new Error('connection refused'));
      const res = await http().get('/health/ready').expect(503);
      expect(res.body.status).toBe('fail');
      expect(res.body.checks.database.ok).toBe(false);
      spy.mockRestore();
    });

    it('/health/ready fails while draining for shutdown', async () => {
      lifecycle.draining = true;
      try {
        await http().get('/health/ready').expect(503);
      } finally {
        lifecycle.draining = false;
      }
    });
  });

  // ───────────────────────────── timing ─────────────────────────────

  describe('timing and HTTP caching', () => {
    it('sends Server-Timing and query counts outside production', async () => {
      const res = await http().get('/api/products?limit=1').expect(200);
      expect(res.headers['server-timing']).toMatch(
        /db;dur=[\d.]+;desc="\d+ queries", app;dur=[\d.]+, total;dur=[\d.]+/,
      );
      expect(res.headers['x-query-count']).toMatch(/^\d+$/);
      expect(res.headers['x-request-id']).toBeTruthy();
    });

    it('public anonymous GETs are cacheable with an ETag; personal data is no-store', async () => {
      const pub = await http().get('/api/categories').expect(200);
      expect(pub.headers['cache-control']).toMatch(/^public, max-age=300/);
      expect(pub.headers.etag).toBeTruthy();
      await http()
        .get('/api/categories')
        .set('If-None-Match', pub.headers.etag)
        .expect(304);

      const { auth } = await verifiedUser();
      const me = await http().get('/api/auth/me').set(auth).expect(200);
      expect(me.headers['cache-control']).toBe('private, no-store');
      const list = await http()
        .get('/api/products?limit=1')
        .set(auth)
        .expect(200);
      expect(list.headers['cache-control']).toBe('private, no-store');
    });

    it('errors are never cached', async () => {
      const res = await http().get(`/api/products/${randomUUID()}`).expect(404);
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('anonymous list cache is invalidated when a listing is created', async () => {
      const { auth } = await verifiedUser('seller');
      const before = await http().get('/api/products?limit=50').expect(200);
      const created = await createListing(
        auth,
        `Cache probe ${randomUUID().slice(0, 6)}`,
      );
      const after = await http().get('/api/products?limit=50').expect(200);
      expect(before.body.items.map((i: { id: string }) => i.id)).not.toContain(
        created.id,
      );
      expect(after.body.items.map((i: { id: string }) => i.id)).toContain(
        created.id,
      );

      // Item reads are cached for visitors and dropped on edit.
      await http().get(`/api/products/${created.id}`).expect(200);
      await http()
        .patch(`/api/products/${created.id}`)
        .set(auth)
        .send({ title: 'Cache probe renamed' })
        .expect(200);
      const item = await http().get(`/api/products/${created.id}`).expect(200);
      expect(item.body.title).toBe('Cache probe renamed');
    });
  });

  // ───────────────────────────── rate limits ─────────────────────────────

  describe('rate limiting', () => {
    it('returns 429 with Retry-After over the per-minute limit', async () => {
      const prev = process.env.RATE_LIMIT_SCALE;
      process.env.RATE_LIMIT_SCALE = '0.05'; // default 120/min -> 6/min
      const ip = `10.55.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
      try {
        const first = await http()
          .get('/api/schools?q=lag')
          .set('X-Forwarded-For', ip);
        expect(first.status).toBe(200);
        expect(first.headers['x-ratelimit-limit']).toBe('6');
        let res = first;
        for (let i = 0; i < 6 && res.status !== 429; i++)
          res = await http()
            .get('/api/schools?q=lag')
            .set('X-Forwarded-For', ip);
        expect(res.status).toBe(429);
        expect(res.body.error.code).toBe('RATE_LIMITED');
        expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
      } finally {
        process.env.RATE_LIMIT_SCALE = prev;
      }
    });

    it('auth routes have a stricter tier than the default', async () => {
      const prev = process.env.RATE_LIMIT_SCALE;
      process.env.RATE_LIMIT_SCALE = '0.1'; // auth 30 -> 3/min, default 120 -> 12/min
      const ip = `10.66.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
      try {
        const statuses: number[] = [];
        for (let i = 0; i < 4; i++) {
          const res = await http()
            .post('/api/auth/login')
            .set('X-Forwarded-For', ip)
            .send({
              email: `nobody${i}-${randomUUID()}@test.ng`,
              password: 'Wrong-pass-123',
            });
          statuses.push(res.status);
          if (i === 0) expect(res.headers['x-ratelimit-limit']).toBe('3');
        }
        expect(statuses.slice(0, 3)).toEqual([401, 401, 401]);
        expect(statuses[3]).toBe(429);
        const { auth } = await verifiedUser();
        const me = await http()
          .get('/api/auth/me')
          .set(auth)
          .set('X-Forwarded-For', ip);
        expect(me.status).toBe(200);
        expect(me.headers['x-ratelimit-limit']).toBe('12');
      } finally {
        process.env.RATE_LIMIT_SCALE = prev;
      }
    });

    it('health checks are never rate limited', async () => {
      const prev = process.env.RATE_LIMIT_SCALE;
      process.env.RATE_LIMIT_SCALE = '0.001';
      try {
        for (let i = 0; i < 5; i++) await http().get('/health').expect(200);
      } finally {
        process.env.RATE_LIMIT_SCALE = prev;
      }
    });
  });

  // ───────────────────────────── bootstrap ─────────────────────────────

  describe('GET /api/bootstrap', () => {
    it('returns the whole first screen for a logged-in user in one response under 50 KB', async () => {
      const { auth: sellerAuth } = await verifiedUser('seller');
      const listing = await createListing(
        sellerAuth,
        `Bootstrap item ${randomUUID().slice(0, 6)}`,
      );
      const { user, auth } = await verifiedUser('viewer');
      await http().post(`/api/wishlist/${listing.id}`).set(auth);

      const res = await http().get('/api/bootstrap').set(auth).expect(200);
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect(Buffer.byteLength(JSON.stringify(res.body))).toBeLessThan(
        50 * 1024,
      );
      const b = res.body;
      expect(b.user.id).toBe(user.id);
      expect(b.user.passwordHash).toBeUndefined();
      expect(b.counts).toEqual({
        unreadNotifications: expect.any(Number),
        unreadMessages: expect.any(Number),
      });
      expect(b.wishlist.productIds).toEqual(expect.any(Array));
      expect(b.categories.length).toBeGreaterThan(5);
      expect(b.categories[0]).toEqual(
        expect.objectContaining({
          slug: expect.any(String),
          count: expect.any(Number),
        }),
      );
      expect(
        b.categories.find((c: { slug: string }) => c.slug === 'electronics')
          .count,
      ).toBeGreaterThan(0);
      expect(b.schools).toEqual({
        version: expect.any(String),
        count: expect.any(Number),
      });
      expect(b.flags).toEqual(expect.objectContaining({ bootstrap: true }));
      expect(b.config.uploads.maxBytes).toBe(3 * 1024 * 1024);
      expect(b.feed.source).toBe('personal');
      expect(b.feed.items.length).toBeLessThanOrEqual(12);
    });

    it('requires a token; logged-out visitors use /bootstrap/public', async () => {
      await http().get('/api/bootstrap').expect(401);
      const res = await http().get('/api/bootstrap/public').expect(200);
      expect(res.body.user).toBeNull();
      expect(res.body.feed.source).toBe('latest');
      expect(res.headers['cache-control']).toMatch(/^public, max-age=30/);
      expect(Buffer.byteLength(JSON.stringify(res.body))).toBeLessThan(
        50 * 1024,
      );
    });
  });

  // ───────────────────────────── analytics ─────────────────────────────

  describe('POST /api/events', () => {
    const analytics = () => app.get(AnalyticsService);
    const ev = (over: Record<string, unknown> = {}) => ({
      name: 'search',
      ts: Date.now(),
      anonId: 'anon-test-1234',
      props: { query: 'laptop', resultCount: 0 },
      ...over,
    });

    it('accepts an allowlisted batch with 204 and stores it without an IP', async () => {
      const id = anonId();
      const { user, auth } = await verifiedUser();
      await http()
        .post('/api/events')
        .set(auth)
        .send({
          events: [
            ev({ anonId: id }),
            ev({ anonId: id, name: 'feed_view', props: {} }),
          ],
        })
        .expect(204);
      await analytics().flush();
      const rows = await ds.query(
        `SELECT * FROM analytics_events WHERE "anonId" = $1 ORDER BY id`,
        [id],
      );
      expect(rows).toHaveLength(2);
      expect(rows[0].userId).toBe(user.id);
      expect(rows[0].props).toEqual({ query: 'laptop', resultCount: 0 });
      expect(Object.keys(rows[0])).not.toEqual(expect.arrayContaining(['ip']));
    });

    it('anonymous events have no user id', async () => {
      const id = anonId();
      await http()
        .post('/api/events')
        .send([ev({ anonId: id })])
        .expect(204);
      await analytics().flush();
      const [row] = await ds.query(
        `SELECT "userId" FROM analytics_events WHERE "anonId" = $1`,
        [id],
      );
      expect(row.userId).toBeNull();
    });

    it('rejects an unknown event name with 400', async () => {
      const res = await http()
        .post('/api/events')
        .send({ events: [ev({ name: 'mouse_move' })] })
        .expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.fields['events[0].name']).toBe(
        'Unknown event name.',
      );
    });

    it('rejects an email address or phone number in a property with 400', async () => {
      const email = await http()
        .post('/api/events')
        .send({ events: [ev({ props: { query: 'tolu@unilag.edu.ng' } })] })
        .expect(400);
      expect(email.body.error.fields['events[0].props.query']).toMatch(/Email/);
      await http()
        .post('/api/events')
        .send({ events: [ev({ props: { query: '0803 123 4567' } })] })
        .expect(400);
      await http()
        .post('/api/events')
        .send({ events: [ev({ props: { message: 'hi' } })] })
        .expect(400);
    });

    it('drops events with Do Not Track or when "Share usage data" is off', async () => {
      const id = anonId();
      await http()
        .post('/api/events')
        .set('DNT', '1')
        .send([ev({ anonId: id })])
        .expect(204);
      const { user, auth } = await verifiedUser();
      await http()
        .patch('/api/users/me')
        .set(auth)
        .send({ shareUsageData: false })
        .expect(200);
      expect(
        (await ds.getRepository(User).findOneByOrFail({ id: user.id }))
          .shareUsageData,
      ).toBe(false);
      await http()
        .post('/api/events')
        .set(auth)
        .send([ev({ anonId: id })])
        .expect(204);
      await analytics().flush();
      const rows = await ds.query(
        `SELECT 1 FROM analytics_events WHERE "anonId" = $1`,
        [id],
      );
      expect(rows).toHaveLength(0);
    });

    it('deletes events older than 13 months', async () => {
      const id = anonId();
      await ds.query(
        `INSERT INTO analytics_events ("name","occurredAt","receivedAt","anonId") VALUES ('feed_view', now() - interval '14 months', now() - interval '14 months', $1)`,
        [id],
      );
      expect(await analytics().purgeExpired()).toBeGreaterThanOrEqual(1);
      expect(
        await ds.query(`SELECT 1 FROM analytics_events WHERE "anonId" = $1`, [
          id,
        ]),
      ).toHaveLength(0);
    });
  });

  // ───────────────────────────── uploads ─────────────────────────────

  describe('signed direct uploads', () => {
    const cloudSign = (publicId: string, version: number) =>
      cloudinary.utils.api_sign_request(
        { public_id: publicId, version },
        process.env.CLOUDINARY_API_SECRET!,
      );

    it('signs an upload restricted to our folder, formats and transformations', async () => {
      const { auth } = await verifiedUser();
      const res = await http()
        .post('/api/uploads/sign')
        .set(auth)
        .send({ count: 2 })
        .expect(200);
      expect(res.body.maxBytes).toBe(3 * 1024 * 1024);
      expect(res.body.uploads).toHaveLength(2);
      const u = res.body.uploads[0];
      expect(u.uploadUrl).toBe(
        'https://api.cloudinary.com/v1_1/campussales-test/image/upload',
      );
      expect(u.publicId).toMatch(/^campussales\/products\/[0-9a-f-]{36}$/);
      expect(u.fields).toEqual(
        expect.objectContaining({
          public_id: u.publicId,
          allowed_formats: 'jpg,jpeg,png,webp,heic',
          transformation: expect.stringContaining('w_1600'),
          api_key: 'test-key',
          signature: expect.stringMatching(/^[0-9a-f]{40}$/),
        }),
      );
      // The signature covers every signed field (Cloudinary recomputes it).
      const signed = { ...u.fields };
      delete signed.api_key;
      const signature = signed.signature;
      delete signed.signature;
      expect(cloudinary.utils.api_sign_request(signed, 'test-secret')).toBe(
        signature,
      );
    });

    it('completes an upload, returns responsive URLs, and the URL can be used in a listing', async () => {
      const { auth } = await verifiedUser();
      const [u] = (
        await http().post('/api/uploads/sign').set(auth).send({}).expect(200)
      ).body.uploads;
      resources.set(u.publicId, { bytes: 480_000, format: 'jpg' });
      const done = await http()
        .post('/api/uploads/complete')
        .set(auth)
        .send({
          uploadId: u.uploadId,
          publicId: u.publicId,
          version: 1700000000,
          signature: cloudSign(u.publicId, 1700000000),
        })
        .expect(200);
      expect(done.body).toEqual(
        expect.objectContaining({
          publicId: u.publicId,
          version: 1700000000,
          url: `https://res.cloudinary.com/campussales-test/image/upload/v1700000000/${u.publicId}.jpg`,
        }),
      );
      expect(done.body.responsive.thumb).toContain(
        'f_auto,q_auto,c_limit,w_400/v1700000000/',
      );

      const listing = await http()
        .post('/api/products')
        .set(auth)
        .send({
          title: 'Direct upload phone',
          price: 50000,
          condition: 'used',
          category: 'electronics',
          images: [done.body.url],
        })
        .expect(201);
      const item = await http()
        .get(`/api/products/${listing.body.id}`)
        .expect(200);
      expect(item.body.images[0]).toEqual(
        expect.objectContaining({
          imageUrl: done.body.url,
          publicId: u.publicId,
          version: 1700000000,
        }),
      );
    });

    it('rejects a forged Cloudinary response and images over 3 MB with the standard error', async () => {
      const { auth } = await verifiedUser();
      const [a, b] = (
        await http()
          .post('/api/uploads/sign')
          .set(auth)
          .send({ count: 2 })
          .expect(200)
      ).body.uploads;
      const forged = await http()
        .post('/api/uploads/complete')
        .set(auth)
        .send({
          uploadId: a.uploadId,
          publicId: a.publicId,
          version: 1,
          signature: 'a'.repeat(40),
        })
        .expect(400);
      expect(forged.body.error.code).toBe('VALIDATION_FAILED');

      resources.set(b.publicId, { bytes: 4 * 1024 * 1024, format: 'jpg' });
      const big = await http()
        .post('/api/uploads/complete')
        .set(auth)
        .send({
          uploadId: b.uploadId,
          publicId: b.publicId,
          version: 2,
          signature: cloudSign(b.publicId, 2),
        })
        .expect(400);
      expect(big.body.error).toEqual(
        expect.objectContaining({
          code: 'VALIDATION_FAILED',
          message: expect.stringContaining('over 3 MB'),
          fields: { image: expect.stringContaining('over 3 MB') },
        }),
      );
      expect(destroyed).toContain(b.publicId);
    });

    it("someone else's upload can't be completed", async () => {
      const { auth } = await verifiedUser();
      const { auth: other } = await verifiedUser();
      const [u] = (
        await http().post('/api/uploads/sign').set(auth).send({}).expect(200)
      ).body.uploads;
      await http()
        .post('/api/uploads/complete')
        .set(other)
        .send({
          uploadId: u.uploadId,
          publicId: u.publicId,
          version: 3,
          signature: cloudSign(u.publicId, 3),
        })
        .expect(404);
    });

    it('orphan clean-up: dry run lists unattached uploads older than 24 h and keeps attached ones', async () => {
      const { user, auth } = await verifiedUser();
      const orphanId = `campussales/products/${randomUUID()}`;
      const attachedId = `campussales/products/${randomUUID()}`;
      const attachedUrl = `https://res.cloudinary.com/campussales-test/image/upload/v5/${attachedId}.jpg`;
      for (const pid of [orphanId, attachedId]) {
        await ds.query(
          `INSERT INTO uploads ("userId", filename, "originalName", mimetype, size, url, "uploadType", "cloudinaryPublicId", status, "createdAt")
           VALUES ($1, $2, '', 'image/jpeg', 1, $3, 'product_image', $2, 'ready', now() - interval '25 hours')`,
          [user.id, pid, pid === attachedId ? attachedUrl : ''],
        );
      }
      await http()
        .post('/api/products')
        .set(auth)
        .send({
          title: 'Attached photo item',
          price: 9000,
          condition: 'used',
          category: 'electronics',
          images: [attachedUrl],
        })
        .expect(201);

      const cleanup = app.get(UploadCleanupService);
      const dry = await cleanup.run('dry-run');
      expect(dry.mode).toBe('dry-run');
      expect(dry.publicIds).toContain(orphanId);
      expect(dry.publicIds).not.toContain(attachedId);
      expect(destroyed).not.toContain(orphanId);

      const real = await cleanup.run('delete');
      expect(real.deleted).toBeGreaterThan(0);
      expect(destroyed).toContain(orphanId);
      const [row] = await ds.query(
        `SELECT status FROM uploads WHERE "cloudinaryPublicId" = $1`,
        [orphanId],
      );
      expect(row.status).toBe('deleted');
    });

    it('deletes images of listings deleted more than 30 days ago', async () => {
      const { auth } = await verifiedUser();
      const pid = `campussales/products/${randomUUID()}`;
      const url = `https://res.cloudinary.com/campussales-test/image/upload/v9/${pid}.jpg`;
      const res = await http()
        .post('/api/products')
        .set(auth)
        .send({
          title: 'Old deleted item',
          price: 9000,
          condition: 'used',
          category: 'electronics',
          images: [url],
        })
        .expect(201);
      await ds.query(
        `UPDATE products SET "deletedAt" = now() - interval '31 days' WHERE id = $1`,
        [res.body.id],
      );
      const report = await app.get(UploadCleanupService).run('delete');
      expect(report.publicIds).toContain(pid);
      expect(
        await ds.query(`SELECT 1 FROM product_images WHERE "productId" = $1`, [
          res.body.id,
        ]),
      ).toHaveLength(0);
    });
  });

  // ───────────────────────────── categories ─────────────────────────────

  it('category counts include live listings (cached, invalidated on writes)', async () => {
    app.get(CacheService).clear();
    const { auth } = await verifiedUser('seller');
    const before = (
      await http().get('/api/bootstrap/public').expect(200)
    ).body.categories.find(
      (c: { slug: string }) => c.slug === electronics.slug,
    ).count;
    await createListing(auth, `Count probe ${randomUUID().slice(0, 6)}`);
    const after = (
      await http().get('/api/bootstrap/public').expect(200)
    ).body.categories.find(
      (c: { slug: string }) => c.slug === electronics.slug,
    ).count;
    expect(after).toBe(before + 1);
  });
});
