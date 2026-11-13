// pg ships without type declarations in this repo, so query rows are untyped.
/* eslint-disable @typescript-eslint/no-unsafe-return */
import { INestApplication } from '@nestjs/common';
import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { v2 as cloudinary } from 'cloudinary';
import { UserProfile } from '../src/users/entities/user-profile.entity';
import { CloudinaryClient } from '../src/uploads/cloudinary.client';
import { createTestApp } from './setup/app';

const ROOT = join(__dirname, '..');
const TOO_SMALL = 'This photo is too small. Use one at least 400x300.';

function png(w: number, h: number) {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

const cloudSign = (publicId: string, version: number) =>
  cloudinary.utils.api_sign_request(
    { public_id: publicId, version },
    'test-secret',
  );

describe('Image data integrity (e2e)', () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let app: INestApplication;
  let ds: DataSource;
  let http: () => ReturnType<typeof request>;
  const destroyed: string[] = [];
  const resources = new Map<
    string,
    { width: number; height: number; format?: string }
  >();

  beforeAll(async () => {
    ctx = await createTestApp();
    ({ app, ds } = ctx);
    http = () => request(app.getHttpServer());
    const cloud = app.get(CloudinaryClient);
    cloud.resource = (publicId: string) => {
      const r = resources.get(publicId);
      return Promise.resolve(
        r
          ? {
              publicId,
              version: 1700000000,
              format: r.format ?? 'jpg',
              bytes: 200_000,
              width: r.width,
              height: r.height,
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

  async function verifiedUser(label = 'img') {
    const u = await ctx.createUser(label, { emailVerifiedAt: new Date() });
    await ds.getRepository(UserProfile).save({
      userId: u.user.id,
      firstName: 'Ada',
      lastName: 'Obi',
    });
    return u;
  }

  async function signedUpload(
    auth: Record<string, string>,
    kind: 'product' | 'avatar' | 'chat',
    width: number,
    height: number,
  ) {
    const [u] = (
      await http()
        .post('/api/uploads/sign')
        .set(auth)
        .send({ kind })
        .expect(200)
    ).body.uploads;
    resources.set(u.publicId, { width, height });
    const res = await http()
      .post('/api/uploads/complete')
      .set(auth)
      .send({
        uploadId: u.uploadId,
        publicId: u.publicId,
        version: 1700000000,
        signature: cloudSign(u.publicId, 1700000000),
      });
    return { res, publicId: u.publicId as string, uploadId: u.uploadId };
  }

  describe('minimum photo size on upload', () => {
    it('rejects a listing photo under 400x300 with the agreed message and removes it', async () => {
      const { auth } = await verifiedUser();
      const { res, publicId, uploadId } = await signedUpload(
        auth,
        'product',
        399,
        300,
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toEqual(
        expect.objectContaining({
          code: 'VALIDATION_FAILED',
          message: TOO_SMALL,
          fields: { image: TOO_SMALL },
        }),
      );
      expect(destroyed).toContain(publicId);
      const [row] = await ds.query(`SELECT status FROM uploads WHERE id = $1`, [
        uploadId,
      ]);
      expect(row.status).toBe('deleted');
    });

    it('accepts exactly 400x300 and a 300x400 portrait', async () => {
      const { auth } = await verifiedUser();
      expect((await signedUpload(auth, 'product', 400, 300)).res.status).toBe(
        200,
      );
      expect((await signedUpload(auth, 'product', 300, 400)).res.status).toBe(
        200,
      );
    });

    it('does not apply to avatars or chat photos', async () => {
      const { auth } = await verifiedUser();
      expect((await signedUpload(auth, 'avatar', 200, 200)).res.status).toBe(
        200,
      );
      expect((await signedUpload(auth, 'chat', 120, 80)).res.status).toBe(200);
    });
  });

  describe('unavailable images in the API', () => {
    it('returns unavailable photos last with a flag, and editing the listing keeps the mark', async () => {
      const { auth } = await verifiedUser('seller');
      const url = (id: string) =>
        `https://res.cloudinary.com/campussales-test/image/upload/v1/campussales/products/${id}.jpg`;
      const [a, b] = [url(randomUUID()), url(randomUUID())];
      const created = await http()
        .post('/api/products')
        .set(auth)
        .send({
          title: 'Desk lamp with bulb',
          price: 8000,
          condition: 'used',
          category: 'electronics',
          images: [a, b],
        })
        .expect(201);
      await ds.query(
        `UPDATE product_images SET "unavailableAt" = now() WHERE "productId" = $1 AND "imageUrl" = $2`,
        [created.body.id, a],
      );
      const item = await http()
        .get(`/api/products/${created.body.id}`)
        .set(auth)
        .expect(200);
      expect(
        item.body.images.map(
          (i: { imageUrl: string; unavailable: boolean }) => [
            i.imageUrl,
            i.unavailable,
          ],
        ),
      ).toEqual([
        [b, false],
        [a, true],
      ]);

      await http()
        .patch(`/api/products/${created.body.id}`)
        .set(auth)
        .send({ images: [a, b] })
        .expect(200);
      const [still] = await ds.query(
        `SELECT "unavailableAt" FROM product_images WHERE "productId" = $1 AND "imageUrl" = $2`,
        [created.body.id, a],
      );
      expect(still.unavailableAt).not.toBeNull();
    });
  });

  describe('scripts', () => {
    let dir: string;
    let seller: Awaited<ReturnType<typeof verifiedUser>>;
    let productId: string;
    const files = {
      ok: `images-ok-${randomUUID()}.png`,
      small: `images-small-${randomUUID()}.png`,
      wide: `images-wide-${randomUUID()}.png`,
      gone: `images-gone-${randomUUID()}.png`,
    };
    const localUrl = (f: string) => `http://localhost:3000/uploads/${f}`;

    const run = (script: string, args: string[] = []) =>
      execFileSync(
        'node',
        [
          join(ROOT, 'scripts', script),
          `--uploads-dir=${dir}`,
          '--cloudinary=off',
          ...args,
        ],
        { cwd: ROOT, env: { ...process.env }, encoding: 'utf8' },
      );

    const checksum = async () => {
      const [r] = await ds.query(`
        SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t.id), '')) AS images,
               (SELECT md5(coalesce(string_agg(n.id::text, '|' ORDER BY n.id), '')) FROM notifications n) AS notes,
               (SELECT count(*) FROM products) AS products
          FROM product_images t`);
      return r;
    };

    beforeAll(async () => {
      dir = mkdtempSync(join(tmpdir(), 'cs-uploads-'));
      writeFileSync(join(dir, files.ok), png(800, 600));
      writeFileSync(join(dir, files.small), png(320, 200));
      writeFileSync(join(dir, files.wide), png(1500, 500));
      seller = await verifiedUser('localseller');
      const [p] = await ds.query(
        `INSERT INTO products ("sellerId", title, description, price, quantity, status, "isAvailable")
         VALUES ($1, 'Old fridge', 'Works fine', 40000, 1, 'active', true) RETURNING id`,
        [seller.user.id],
      );
      productId = p.id;
      const order = [files.ok, files.small, files.wide, files.gone];
      for (const [i, f] of order.entries()) {
        await ds.query(
          `INSERT INTO product_images ("productId", "imageUrl", "isPrimary", "sortOrder") VALUES ($1, $2, $3, $4)`,
          [productId, localUrl(f), i === 0, i],
        );
      }
    });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it('audit-uploads.js reports missing, too small and extreme aspect in a CSV and changes nothing', async () => {
      const before = await checksum();
      const out = run('audit-uploads.js');
      expect(out).toContain('No data was modified');
      expect(await checksum()).toEqual(before);

      const csvPath = /Report written to (.+images\.csv)/.exec(out)![1];
      const lines = readFileSync(csvPath, 'utf8').trim().split('\n');
      expect(lines[0]).toBe(
        'productId,sellerId,productTitle,productStatus,imageId,imageUrl,storage,exists,width,height,aspectRatio,issues,markedUnavailableAt,note',
      );
      const byFile = (f: string) => {
        const line = lines.find((l) => l.includes(f))!;
        const cols = line.split(',');
        return {
          exists: cols[7],
          width: cols[8],
          height: cols[9],
          issues: cols[11],
        };
      };
      expect(byFile(files.ok)).toEqual({
        exists: 'yes',
        width: '800',
        height: '600',
        issues: '',
      });
      expect(byFile(files.small).issues).toBe('too_small');
      expect(byFile(files.wide)).toMatchObject({
        width: '1500',
        height: '500',
        issues: 'extreme_aspect',
      });
      expect(byFile(files.gone)).toMatchObject({
        exists: 'no',
        issues: 'missing',
      });
    });

    it('mark-missing-images.js: dry run changes nothing; --apply marks the photo, keeps the listing and notifies the seller once', async () => {
      const before = await checksum();
      const dry = run('mark-missing-images.js');
      expect(dry).toContain('DRY RUN');
      expect(dry).toContain(`${productId}  "Old fridge"  1 missing`);
      expect(dry).toContain('nothing was changed');
      expect(await checksum()).toEqual(before);

      const applied = run('mark-missing-images.js', ['--apply']);
      expect(applied).toContain('No listing was deleted');
      const imgs = await ds.query(
        `SELECT "imageUrl", "unavailableAt" FROM product_images WHERE "productId" = $1`,
        [productId],
      );
      expect(imgs).toHaveLength(4);
      for (const i of imgs)
        expect(i.unavailableAt === null).toBe(!i.imageUrl.includes(files.gone));
      const [p] = await ds.query(
        `SELECT status, "deletedAt" FROM products WHERE id = $1`,
        [productId],
      );
      expect(p).toEqual({ status: 'active', deletedAt: null });

      // The seller sees it in the app, linked to the listing.
      const notes = (
        await http().get('/api/notifications').set(seller.auth).expect(200)
      ).body;
      const items = notes.items ?? notes.data ?? notes;
      const mine = items.filter(
        (n: { link?: { id: string } }) => n.link?.id === productId,
      );
      expect(mine).toHaveLength(1);
      expect(mine[0]).toEqual(
        expect.objectContaining({
          type: 'listing',
          title: 'Add new photos to your listing',
          link: { kind: 'listing', id: productId },
        }),
      );
      expect(mine[0].body).toContain('"Old fridge"');

      // Visitors still see the listing; the missing photo is flagged and last.
      const item = await http().get(`/api/products/${productId}`).expect(200);
      expect(item.body.images.at(-1)).toEqual(
        expect.objectContaining({
          imageUrl: localUrl(files.gone),
          unavailable: true,
        }),
      );

      // Re-running sends nothing new.
      const again = await checksum();
      run('mark-missing-images.js', ['--apply']);
      expect(await checksum()).toEqual(again);
    });

    it('checks Cloudinary photos with one listing call and treats lookup failures as unknown, never missing', async () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const checks = require('../scripts/lib/image-checks');
      const calls: string[] = [];
      const api = {
        resources: (o: { prefix: string; next_cursor?: string }) => {
          calls.push(`list:${o.prefix}:${o.next_cursor ?? ''}`);
          return Promise.resolve(
            o.next_cursor
              ? {
                  resources: [
                    {
                      public_id: 'campussales/products/b',
                      width: 300,
                      height: 200,
                    },
                  ],
                }
              : {
                  resources: [
                    {
                      public_id: 'campussales/products/a',
                      width: 1200,
                      height: 900,
                    },
                  ],
                  next_cursor: 'p2',
                },
          );
        },
        resource: (id: string) => {
          calls.push(`get:${id}`);
          // The Cloudinary SDK rejects with { error: { http_code, message } }.
          return Promise.reject(
            Object.assign(new Error('Cloudinary error'), {
              error:
                id === 'legacy/gone'
                  ? { http_code: 404 }
                  : { http_code: 420, message: 'Rate limited' },
            }),
          );
        },
      };
      const u = (id: string) =>
        `https://res.cloudinary.com/campussales-test/image/upload/v1/${id}.jpg`;
      const rows = [
        'campussales/products/a',
        'campussales/products/b',
        'campussales/products/c',
        'legacy/gone',
        'legacy/flaky',
      ].map((id, i) => ({
        imageId: String(i),
        productId: 'p',
        imageUrl: u(id),
      }));
      rows.push({
        imageId: 'x',
        productId: 'p',
        imageUrl:
          'https://res.cloudinary.com/someone-else/image/upload/v1/z.jpg',
      });
      const { results } = await checks.checkImages(rows, {
        uploadsDir: dir,
        cloudinary: checks.cloudinaryLookup({ api }),
      });
      const by = (i: string) =>
        results.find((r: { imageId: string }) => r.imageId === i);
      expect(by('0')).toMatchObject({ exists: 'yes', issues: '' });
      expect(by('1')).toMatchObject({ exists: 'yes', issues: 'too_small' });
      expect(by('2')).toMatchObject({ exists: 'no', issues: 'missing' });
      expect(by('3')).toMatchObject({ exists: 'no', issues: 'missing' });
      expect(by('4')).toMatchObject({ exists: 'unknown', issues: '' });
      expect(by('x')).toMatchObject({ storage: 'other', exists: 'unknown' });
      expect(calls).toEqual([
        'list:campussales/:',
        'list:campussales/:p2',
        'get:legacy/gone',
        'get:legacy/flaky',
      ]);
    });

    it('un-marks a photo whose file is back', async () => {
      writeFileSync(join(dir, files.gone), png(640, 480));
      const out = run('mark-missing-images.js', ['--apply']);
      expect(out).toMatch(/restored [1-9]/);
      const [row] = await ds.query(
        `SELECT "unavailableAt" FROM product_images WHERE "productId" = $1 AND "imageUrl" = $2`,
        [productId, localUrl(files.gone)],
      );
      expect(row.unavailableAt).toBeNull();
    });
  });
});
