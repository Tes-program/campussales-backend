import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { randomUUID } from 'crypto';
import { createTestApp } from './setup/app';
import { Product } from '../src/products/entities/product.entity';
import { User } from '../src/users/entities/user.entity';
import { UserProfile } from '../src/users/entities/user-profile.entity';
import { UserType } from '../src/common/enum/user.enums';

const ADMIN_KEY = 'test-admin-key-0123456789';
const img = (n: number | string) =>
  `https://res.cloudinary.com/campussales-test/image/upload/v1/b4/${n}.jpg`;

describe('B4 moderation, reports and chat safety (e2e)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let http: () => ReturnType<typeof request>;
  type U = Awaited<ReturnType<typeof ctx.createUser>>;

  beforeAll(async () => {
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    ctx = await createTestApp();
    ({ app, ds } = ctx);
    http = () => request(app.getHttpServer());
  });
  afterAll(() => app.close());

  let seq = 0;
  const listing = (o: Record<string, unknown> = {}) => ({
    title: `Study lamp ${randomUUID().slice(0, 6)} ${seq++}`,
    description: 'Works well.',
    price: 5000,
    category: 'electronics',
    condition: 'used',
    images: [img(seq)],
    ...o,
  });
  async function student(label = 'student'): Promise<U> {
    const u = await ctx.createUser(label);
    await ds
      .getRepository(UserProfile)
      .save({ userId: u.user.id, firstName: 'Kemi', lastName: 'Ola' });
    return u;
  }
  const post = (u: U, o: Record<string, unknown> = {}) =>
    http().post('/api/products').set(u.auth).send(listing(o));
  const visibleTo = async (u: U | null, id: string) => {
    const r = u
      ? await http().get('/api/products?limit=50').set(u.auth)
      : await http().get('/api/products?limit=50');
    return (r.body.items as { id: string }[]).some((x) => x.id === id);
  };
  const adminHeaders = (a: U) => ({ ...a.auth, 'X-Admin-Key': ADMIN_KEY });

  // ───────────────────────────── screening ─────────────────────────────

  describe('listing screening', () => {
    it('₦0 never gets in (validation) and "aaaaaaaa" is held for review, visible only to its owner', async () => {
      const s = await student();
      expect((await post(s, { price: 0 })).status).toBe(400);
      const res = await post(s, { title: 'aaaaaaaa' });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        status: 'needs_review',
        moderationStatus: 'needs_review',
        moderationNote: 'Under review. This usually takes under 24 hours.',
      });
      expect(await visibleTo(null, res.body.id)).toBe(false);
      expect((await http().get(`/api/products/${res.body.id}`)).status).toBe(
        404,
      );
      const own = await http().get(`/api/products/${res.body.id}`).set(s.auth);
      expect(own.status).toBe(200);
      expect(own.body.moderationNote).toBe(
        'Under review. This usually takes under 24 hours.',
      );
      // the owner can't push it live
      expect(
        (await http().post(`/api/products/${res.body.id}/activate`).set(s.auth))
          .status,
      ).toBe(409);
    });

    it('rejects clearly prohibited items with a friendly reason', async () => {
      const s = await student();
      const res = await post(s, { title: 'Pistol for sale cheap' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatchObject({
        code: 'MODERATION_REJECTED',
        message: "Weapons and ammunition can't be sold on CampusSales.",
        fields: {
          title: "Weapons and ammunition can't be sold on CampusSales.",
        },
      });
      const contact = await post(s, { title: 'iPhone 11 call 08031234567' });
      expect(contact.body.error.code).toBe('MODERATION_REJECTED');
    });

    it('sends borderline items to review, never rejects them', async () => {
      const s = await student();
      const res = await post(s, { title: 'Kitchen knife set' });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('needs_review');
    });

    it('re-screens on edit', async () => {
      const s = await student();
      const ok = await post(s);
      const bad = await http()
        .patch(`/api/products/${ok.body.id}`)
        .set(s.auth)
        .send({ title: 'Fake naira notes' });
      expect(bad.body.error.code).toBe('MODERATION_REJECTED');
      const held = await http()
        .patch(`/api/products/${ok.body.id}`)
        .set(s.auth)
        .send({ title: 'Replica jersey' });
      expect(held.body.status).toBe('needs_review');
      const fixed = await http()
        .patch(`/api/products/${ok.body.id}`)
        .set(s.auth)
        .send({ title: 'Original jersey' });
      expect(fixed.body.status).toBe('active');
    });

    it('more than 10 listings an hour go to review', async () => {
      const s = await student();
      for (let i = 0; i < 10; i++) {
        await ds.getRepository(Product).save({
          sellerId: s.user.id,
          title: `Bulk item ${i}`,
          description: '',
          price: 1000,
          quantity: 1,
          tags: [],
          priceHistory: [],
        });
      }
      process.env.MODERATION_SPAM_PER_HOUR = '10';
      try {
        const res = await post(s);
        expect(res.body.status).toBe('needs_review');
        expect(res.body.moderationReasons[0].code).toBe('posting_rate');
      } finally {
        process.env.MODERATION_SPAM_PER_HOUR = '100000';
      }
    });
  });

  // ───────────────────────────── reports ───────────────────────────────

  describe('reports', () => {
    it('the reporter stops seeing the listing at once; others still do; repeat report is 409', async () => {
      const seller = await student();
      const reporter = await student();
      const other = await student();
      const p = (await post(seller)).body;
      const res = await http().post('/api/reports').set(reporter.auth).send({
        targetType: 'listing',
        targetId: p.id,
        reason: 'fake_item',
        details: 'Photos are from Google',
      });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ status: 'open', hiddenForYou: true });
      expect(await visibleTo(reporter, p.id)).toBe(false);
      expect(await visibleTo(other, p.id)).toBe(true);
      expect(await visibleTo(null, p.id)).toBe(true);
      const again = await http()
        .post('/api/reports')
        .set(reporter.auth)
        .send({ targetType: 'listing', targetId: p.id, reason: 'spam' });
      expect(again.status).toBe(409);
    });

    it('reporting a user hides all their listings from the reporter', async () => {
      const seller = await student();
      const reporter = await student();
      const a = (await post(seller)).body;
      const b = (await post(seller)).body;
      await http()
        .post('/api/reports')
        .set(reporter.auth)
        .send({
          targetType: 'user',
          targetId: seller.user.id,
          reason: 'harassment',
        })
        .expect(201);
      expect(await visibleTo(reporter, a.id)).toBe(false);
      expect(await visibleTo(reporter, b.id)).toBe(false);
    });

    it('three reports from different users hide the listing for everyone, without naming reporters', async () => {
      const seller = await student();
      const p = (await post(seller)).body;
      const reporters: U[] = [];
      for (let i = 0; i < 3; i++) {
        const r = await student();
        reporters.push(r);
        await http()
          .post('/api/reports')
          .set(r.auth)
          .send({ targetType: 'listing', targetId: p.id, reason: 'spam' })
          .expect(201);
      }
      expect(await visibleTo(null, p.id)).toBe(false);
      const own = await http().get(`/api/products/${p.id}`).set(seller.auth);
      expect(own.body.status).toBe('needs_review');
      const ownJson = JSON.stringify(own.body);
      const notes = JSON.stringify(
        (await http().get('/api/notifications').set(seller.auth)).body,
      );
      for (const r of reporters) {
        expect(ownJson).not.toContain(r.user.id);
        expect(notes).not.toContain(r.user.id);
        expect(notes).not.toContain(r.user.username);
      }
    });

    it('one scam report from an account older than 7 days hides the listing', async () => {
      const seller = await student();
      const veteran = await student();
      await ds
        .getRepository(User)
        .update(
          { id: veteran.user.id },
          { createdAt: new Date(Date.now() - 10 * 86_400_000) },
        );
      const p = (await post(seller)).body;
      await http()
        .post('/api/reports')
        .set(veteran.auth)
        .send({ targetType: 'listing', targetId: p.id, reason: 'scam' })
        .expect(201);
      expect(await visibleTo(null, p.id)).toBe(false);

      // a brand-new account's scam report does not hide it on its own
      const p2 = (await post(seller)).body;
      const newbie = await student();
      await http()
        .post('/api/reports')
        .set(newbie.auth)
        .send({ targetType: 'listing', targetId: p2.id, reason: 'scam' })
        .expect(201);
      expect(await visibleTo(null, p2.id)).toBe(true);
    });

    it('validates and rate limits reports (20 per day)', async () => {
      const r = await student();
      const bad = await http()
        .post('/api/reports')
        .set(r.auth)
        .send({
          targetType: 'planet',
          targetId: 'x',
          reason: 'meh',
          details: 'x'.repeat(1001),
        });
      expect(bad.status).toBe(400);
      expect(Object.keys(bad.body.error.fields).sort()).toEqual([
        'details',
        'reason',
        'targetId',
        'targetType',
      ]);
      expect(
        (
          await http()
            .post('/api/reports')
            .set(r.auth)
            .send({ targetType: 'user', targetId: r.user.id, reason: 'spam' })
        ).status,
      ).toBe(400);
      for (let i = 0; i < 20; i++) {
        await ds.query(
          `INSERT INTO reports ("reporterId", "targetType", "targetId", reason) VALUES ($1, 'user', $2, 'spam')`,
          [r.user.id, randomUUID()],
        );
      }
      const target = await student();
      const res = await http()
        .post('/api/reports')
        .set(r.auth)
        .send({ targetType: 'user', targetId: target.user.id, reason: 'spam' });
      expect(res.status).toBe(429);
      expect(res.body.error.code).toBe('RATE_LIMITED');
    });
  });

  // ───────────────────────────── blocks ────────────────────────────────

  describe('blocks', () => {
    async function chatBetween(a: U, b: U, productId?: string) {
      const r = await http()
        .post('/api/chat/conversations')
        .set(a.auth)
        .send({ participantId: b.user.id, productId });
      return r;
    }

    it('hide listings, wishlist items and chats both ways; blocked users cannot message', async () => {
      const a = await student();
      const b = await student();
      const pa = (await post(a)).body;
      const pb = (await post(b)).body;
      await http().post(`/api/wishlist/${pb.id}`).set(a.auth).expect(200);
      const conv = (await chatBetween(a, b)).body;
      expect(conv.otherUser.id).toBe(b.user.id);

      const blk = await http()
        .post('/api/blocks')
        .set(a.auth)
        .send({ userId: b.user.id });
      expect(blk.status).toBe(200);
      await http()
        .post('/api/blocks')
        .set(a.auth)
        .send({ userId: b.user.id })
        .expect(200); // idempotent

      expect(await visibleTo(a, pb.id)).toBe(false);
      expect(await visibleTo(b, pa.id)).toBe(false);
      expect(
        (await http().get('/api/wishlist').set(a.auth)).body.items.some(
          (i: { id: string }) => i.id === pb.id,
        ),
      ).toBe(false);
      for (const u of [a, b]) {
        const list = await http().get('/api/chat/conversations').set(u.auth);
        expect(
          list.body.data.some((c: { id: string }) => c.id === conv.id),
        ).toBe(false);
      }
      for (const [from] of [[a], [b]]) {
        const m = await http()
          .post(`/api/chat/conversations/${conv.id}/messages`)
          .set(from.auth)
          .send({ content: 'hi' });
        expect(m.status).toBe(403);
        expect(m.body.error).toEqual(
          expect.objectContaining({
            code: 'BLOCKED',
            message: "You can't interact with this account.",
          }),
        );
      }
      expect((await chatBetween(b, a)).body.error.code).toBe('BLOCKED');
      expect(
        (await http().get(`/api/products/${pb.id}`).set(a.auth)).status,
      ).toBe(404);

      const mine = await http().get('/api/blocks').set(a.auth);
      expect(mine.body.items.map((x: { userId: string }) => x.userId)).toEqual([
        b.user.id,
      ]);
      await http().delete(`/api/blocks/${b.user.id}`).set(a.auth).expect(204);
      await http().delete(`/api/blocks/${b.user.id}`).set(a.auth).expect(204);
      expect(await visibleTo(a, pb.id)).toBe(true);
    });
  });

  // ───────────────────────────── admin ─────────────────────────────────

  describe('admin', () => {
    let admin: U;
    beforeAll(async () => {
      admin = await ctx.createUser('admin', { userType: UserType.ADMIN });
    });

    it('needs the admin role AND the admin key', async () => {
      const normal = await student();
      expect(
        (await http().get('/api/admin/reports').set(normal.auth)).status,
      ).toBe(403);
      expect(
        (
          await http()
            .get('/api/admin/reports')
            .set({ ...normal.auth, 'X-Admin-Key': ADMIN_KEY })
        ).status,
      ).toBe(403);
      expect(
        (await http().get('/api/admin/reports').set(admin.auth)).status,
      ).toBe(403);
      expect(
        (
          await http()
            .get('/api/admin/reports')
            .set({ ...admin.auth, 'X-Admin-Key': 'wrong' })
        ).status,
      ).toBe(403);
      expect((await http().get('/api/admin/reports')).status).toBe(401);
      const ok = await http()
        .get('/api/admin/reports?status=open')
        .set(adminHeaders(admin));
      expect(ok.status).toBe(200);
    });

    it('approve, reject and dismiss write audit logs and notify the owner', async () => {
      const s = await student();
      const held = (await post(s, { title: 'Replica watch' })).body;
      const queue = await http()
        .get('/api/admin/products?moderationStatus=needs_review')
        .set(adminHeaders(admin));
      expect(
        queue.body.items.some((x: { id: string }) => x.id === held.id),
      ).toBe(true);

      const approve = await http()
        .post('/api/admin/actions')
        .set(adminHeaders(admin))
        .send({ action: 'approve', targetId: held.id });
      expect(approve.status).toBe(200);
      expect(approve.body.status).toBe('active');
      expect(await visibleTo(null, held.id)).toBe(true);

      const noReason = await http()
        .post('/api/admin/actions')
        .set(adminHeaders(admin))
        .send({ action: 'reject', targetId: held.id });
      expect(noReason.status).toBe(400);
      await http()
        .post('/api/admin/actions')
        .set(adminHeaders(admin))
        .send({
          action: 'reject',
          targetId: held.id,
          reason: 'Counterfeit brand.',
        })
        .expect(200);
      expect(await visibleTo(null, held.id)).toBe(false);
      expect((await http().get(`/api/products/${held.id}`)).status).toBe(404);

      const notes = (await http().get('/api/notifications').set(s.auth)).body
        .items as { title: string; body: string }[];
      expect(
        notes.some(
          (n) =>
            n.title === 'Your listing was taken down' &&
            n.body.includes('Counterfeit brand.'),
        ),
      ).toBe(true);

      const log = await http()
        .get('/api/admin/audit-log')
        .set(adminHeaders(admin));
      const mine = (
        log.body.items as {
          action: string;
          targetId: string;
          adminId: string;
        }[]
      ).filter((x) => x.targetId === held.id);
      expect(mine.map((x) => x.action).sort()).toEqual(['approve', 'reject']);
      expect(mine.every((x) => x.adminId === admin.user.id)).toBe(true);
    });

    it('3 confirmed reports in 30 days suspend posting', async () => {
      const s = await student();
      for (let i = 0; i < 3; i++) {
        const p = (await post(s)).body;
        const r = await student();
        await http()
          .post('/api/reports')
          .set(r.auth)
          .send({ targetType: 'listing', targetId: p.id, reason: 'fake_item' })
          .expect(201);
        await http()
          .post('/api/admin/actions')
          .set(adminHeaders(admin))
          .send({ action: 'remove', targetId: p.id, reason: 'Fake item.' })
          .expect(200);
      }
      const res = await post(s);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('ACCOUNT_SUSPENDED');
      await ctx.nextEmail(s.user.email, 'notice');
      const users = await http()
        .get('/api/admin/users')
        .set(adminHeaders(admin));
      expect(
        users.body.items.some((u: { id: string }) => u.id === s.user.id),
      ).toBe(true);
    });

    it('dry-run runs the rules without saving', async () => {
      const r = await http()
        .post('/api/admin/moderation/dry-run')
        .set(adminHeaders(admin))
        .send({ title: 'c0caine' });
      expect(r.body.status).toBe('rejected');
    });
  });

  // ───────────────────────────── chat ──────────────────────────────────

  describe('chat safety', () => {
    it('pins listing context, closes the chat when sold, enforces length, hides private fields', async () => {
      const seller = await student();
      const buyer = await student();
      const p = (await post(seller, { price: 12000 })).body;
      const conv = await http()
        .post('/api/chat/conversations')
        .set(buyer.auth)
        .send({ participantId: seller.user.id, productId: p.id });
      expect(conv.status).toBe(201);
      expect(conv.body.listing).toEqual({
        productId: p.id,
        title: p.title,
        coverImageUrl: p.images[0].imageUrl,
        priceAtStart: 12000,
      });
      expect(JSON.stringify(conv.body)).not.toMatch(/"email"|"phoneNumber"/);

      const long = await http()
        .post(`/api/chat/conversations/${conv.body.id}/messages`)
        .set(buyer.auth)
        .send({ content: 'x'.repeat(1001) });
      expect(long.status).toBe(400);
      const empty = await http()
        .post(`/api/chat/conversations/${conv.body.id}/messages`)
        .set(buyer.auth)
        .send({ content: '    ' });
      expect(empty.body.error.fields.content).toBe('Type a message.');
      const sys = await http()
        .post(`/api/chat/conversations/${conv.body.id}/messages`)
        .set(buyer.auth)
        .send({ content: 'x', type: 'system' });
      expect(sys.status).toBe(400);

      const m = await http()
        .post(`/api/chat/conversations/${conv.body.id}/messages`)
        .set(buyer.auth)
        .send({ content: '  Is this available?  ' });
      expect(m.status).toBe(201);
      expect(m.body.content).toBe('Is this available?');
      expect(m.body.createdAt).toMatch(
        /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/,
      );
      expect(m.body.sender.email).toBeUndefined();

      await http()
        .post(`/api/products/${p.id}/sold`)
        .set(seller.auth)
        .expect(200);
      const after = await http()
        .get(`/api/chat/conversations/${conv.body.id}`)
        .set(buyer.auth);
      expect(after.body).toMatchObject({ closed: true, closedReason: 'sold' });
      const msgs = await http()
        .get(`/api/chat/conversations/${conv.body.id}/messages`)
        .set(buyer.auth);
      expect(msgs.body.data.at(-1)).toMatchObject({ type: 'system' });

      const list = await http().get('/api/chat/conversations').set(seller.auth);
      const row = list.body.data.find(
        (c: { id: string }) => c.id === conv.body.id,
      );
      expect(row.unreadCount).toBe(1);
      expect(list.body.totalUnread).toBeGreaterThanOrEqual(1);
    });

    it('rate limits messages (30/min) and new conversations (10/hour)', async () => {
      const a = await student();
      const b = await student();
      const conv = (
        await http()
          .post('/api/chat/conversations')
          .set(a.auth)
          .send({ participantId: b.user.id })
      ).body;
      for (let i = 0; i < 30; i++) {
        expect(
          (
            await http()
              .post(`/api/chat/conversations/${conv.id}/messages`)
              .set(a.auth)
              .send({ content: `m${i}` })
          ).status,
        ).toBe(201);
      }
      const over = await http()
        .post(`/api/chat/conversations/${conv.id}/messages`)
        .set(a.auth)
        .send({ content: 'one more' });
      expect(over.status).toBe(429);
      expect(over.body.error.retryAfterSeconds).toBeGreaterThan(0);

      for (let i = 0; i < 9; i++) {
        const other = await student();
        expect(
          (
            await http()
              .post('/api/chat/conversations')
              .set(a.auth)
              .send({ participantId: other.user.id })
          ).status,
        ).toBe(201);
      }
      const eleventh = await student();
      expect(
        (
          await http()
            .post('/api/chat/conversations')
            .set(a.auth)
            .send({ participantId: eleventh.user.id })
        ).status,
      ).toBe(429);
    });

    it('flags scam patterns without blocking, and surfaces repeat accounts to admins', async () => {
      const scammer = await student();
      let lastConv = '';
      for (let i = 0; i < 6; i++) {
        const victim = await student();
        const conv = (
          await http()
            .post('/api/chat/conversations')
            .set(scammer.auth)
            .send({ participantId: victim.user.id })
        ).body;
        lastConv = conv.id;
        const m = await http()
          .post(`/api/chat/conversations/${conv.id}/messages`)
          .set(scammer.auth)
          .send({ content: 'Pay first to 0123456789 then I send' });
        expect(m.status).toBe(201);
        expect(m.body.safetyTip).toBe(true);
        expect(m.body.content).toBe('Pay first to 0123456789 then I send');
      }
      expect(lastConv).toBeTruthy();
      await new Promise((r) => setTimeout(r, 200));
      const u = await ds
        .getRepository(User)
        .findOneByOrFail({ id: scammer.user.id });
      expect(u.needsReviewAt).toBeTruthy();
    });
  });

  // ───────────────────────────── notifications ─────────────────────────

  it('notifications use ISO times, readAt and a link object; read endpoints and cursor work', async () => {
    const s = await student();
    for (let i = 0; i < 3; i++) {
      await ds.query(
        `INSERT INTO notifications ("userId", type, title, body, metadata, "createdAt") VALUES ($1, 'listing', $2, 'b', $3, now() - ($4 || ' minutes')::interval)`,
        [
          s.user.id,
          `n${i}`,
          JSON.stringify({ productId: randomUUID() }),
          String(i),
        ],
      );
    }
    const p1 = await http().get('/api/notifications?limit=2').set(s.auth);
    expect(p1.body.items).toHaveLength(2);
    const n = p1.body.items[0];
    expect(n.createdAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(n.readAt).toBeNull();
    expect(n.link).toEqual({ kind: 'listing', id: expect.any(String) });
    expect(n.text).toBe(n.body); // legacy field kept
    const p2 = await http()
      .get(`/api/notifications?limit=2&cursor=${p1.body.nextCursor}`)
      .set(s.auth);
    expect(p2.body.items.map((x: { title: string }) => x.title)).toEqual([
      'n2',
    ]);

    await http()
      .post(`/api/notifications/${n.id}/read`)
      .set(s.auth)
      .expect(200);
    await http()
      .post(`/api/notifications/${n.id}/read`)
      .set(s.auth)
      .expect(200);
    const after = await http().get('/api/notifications').set(s.auth);
    expect(
      after.body.items.find((x: { id: string }) => x.id === n.id).readAt,
    ).toEqual(expect.any(String));
    await http().post('/api/notifications/read-all').set(s.auth).expect(200);
    expect(
      (await http().get('/api/notifications').set(s.auth)).body.unreadCount,
    ).toBe(0);
  });

  // ───────────────────────────── privacy ───────────────────────────────

  it('exports data, records consents and handles the deletion grace period', async () => {
    const s = await student();
    await post(s);
    const exp = await http().get('/api/me/export').set(s.auth);
    expect(exp.status).toBe(200);
    expect(exp.body.listings).toHaveLength(1);
    expect(JSON.stringify(exp.body)).not.toMatch(/passwordHash/);

    const c = await http()
      .post('/api/me/consents')
      .set(s.auth)
      .send({ termsVersion: '2026-11-01', privacyVersion: '2026-11-01' });
    expect(c.body).toMatchObject({
      acceptedTermsVersion: '2026-11-01',
      acceptedPrivacyVersion: '2026-11-01',
    });

    expect(
      (
        await http()
          .delete('/api/me/account')
          .set(s.auth)
          .send({ confirm: 'nope' })
      ).status,
    ).toBe(400);
    const del = await http()
      .delete('/api/me/account')
      .set(s.auth)
      .send({ confirm: 'DELETE' });
    expect(del.status).toBe(200);
    expect((await http().get('/api/auth/me').set(s.auth)).status).toBe(401);
  });
});
