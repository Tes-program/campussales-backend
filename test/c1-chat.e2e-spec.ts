/* eslint-disable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { randomUUID } from 'crypto';
import { AddressInfo } from 'net';
import { join } from 'path';
import { Client as PgClient } from 'pg';
import { io, Socket } from 'socket.io-client';
import { JwtService } from '@nestjs/jwt';
import { createTestApp } from './setup/app';
import { UserProfile } from '../src/users/entities/user-profile.entity';
import { chatMetrics } from '../src/chat/chat-metrics';

const img = (n: number | string) =>
  `https://res.cloudinary.com/campussales-test/image/upload/v1/c1/${n}.jpg`;

describe('C1 real-time, reliable chat (e2e)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let http: () => ReturnType<typeof request>;
  let url: string;
  const sockets: Socket[] = [];
  type U = Awaited<ReturnType<typeof ctx.createUser>>;

  beforeAll(async () => {
    ctx = await createTestApp();
    ({ app, ds } = ctx);
    await app.listen(0);
    const port = (app.getHttpServer().address() as AddressInfo).port;
    url = `http://127.0.0.1:${port}/chat`;
    http = () => request(app.getHttpServer());
  });
  afterEach(() => {
    while (sockets.length) sockets.pop()!.disconnect();
  });
  afterAll(() => app.close());

  async function student(first = 'Kemi'): Promise<U> {
    const u = await ctx.createUser('c1');
    await ds
      .getRepository(UserProfile)
      .save({ userId: u.user.id, firstName: first, lastName: 'Ola' });
    return u;
  }
  const token = (u: U) => u.auth.Authorization.slice('Bearer '.length);

  function connect(u: U | string): Promise<Socket> {
    const s = io(url, {
      auth: { token: typeof u === 'string' ? u : token(u) },
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
    });
    sockets.push(s);
    return new Promise((resolve, reject) => {
      s.once('connected', () => resolve(s));
      s.once('connect_error', reject);
    });
  }
  const next = <T = any>(s: Socket, event: string, ms = 2000) =>
    new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`no ${event}`)), ms);
      s.once(event, (data: T, ack?: (v: unknown) => void) => {
        clearTimeout(t);
        ack?.({ ok: true });
        resolve(data);
      });
    });
  const emit = (s: Socket, event: string, body: unknown) =>
    s.timeout(3000).emitWithAck(event, body) as Promise<any>;

  async function chat(a: U, b: U, productId?: string) {
    const r = await http()
      .post('/api/chat/conversations')
      .set(a.auth)
      .send({ participantId: b.user.id, productId });
    expect([200, 201]).toContain(r.status);
    return r.body as { id: string };
  }
  const send = (u: U, convId: string, body: Record<string, unknown>) =>
    http()
      .post(`/api/chat/conversations/${convId}/messages`)
      .set(u.auth)
      .send(body);
  async function listing(seller: U) {
    const r = await http()
      .post('/api/products')
      .set(seller.auth)
      .send({
        title: `Desk lamp ${randomUUID().slice(0, 6)}`,
        description: 'Works well.',
        price: 5000,
        category: 'electronics',
        condition: 'used',
        images: [img(randomUUID())],
      });
    expect(r.status).toBe(201);
    return r.body as { id: string; title: string };
  }

  // ─────────────────────────── conversations ───────────────────────────

  describe('conversations', () => {
    it('one per (pair, product) plus one general per pair; parallel creates never duplicate', async () => {
      const buyer = await student();
      const seller = await student();
      const p1 = await listing(seller);
      const p2 = await listing(seller);
      const general = await chat(buyer, seller);
      const a = await chat(buyer, seller, p1.id);
      const b = await chat(buyer, seller, p2.id);
      expect(new Set([general.id, a.id, b.id]).size).toBe(3);
      // either side, any order: same conversation
      expect((await chat(seller, buyer, p1.id)).id).toBe(a.id);
      expect((await chat(seller, buyer)).id).toBe(general.id);

      const p3 = await listing(seller);
      const parallel = await Promise.all(
        Array.from({ length: 5 }, () => chat(buyer, seller, p3.id)),
      );
      expect(new Set(parallel.map((c) => c.id)).size).toBe(1);
      const [n] = await ds.query(
        `SELECT count(*)::int AS n FROM conversations WHERE "productId" = $1`,
        [p3.id],
      );
      expect(n.n).toBe(1);

      // a product chat must involve the seller
      const stranger = await student();
      const bad = await http()
        .post('/api/chat/conversations')
        .set(buyer.auth)
        .send({ participantId: stranger.user.id, productId: p1.id });
      expect(bad.status).toBe(400);
    });

    it('list items: participant, product, lastMessage, unread, ISO times, cursor pagination, no private fields', async () => {
      const me = await student('Ada');
      const others = await Promise.all([1, 2, 3].map(() => student('Bola')));
      const convs: { id: string }[] = [];
      for (const o of others) {
        const c = await chat(o, me);
        await send(o, c.id, { clientMessageId: randomUUID(), text: 'Hi' });
        convs.push(c);
      }
      const page1 = await http()
        .get('/api/chat/conversations?limit=2')
        .set(me.auth);
      expect(page1.status).toBe(200);
      expect(page1.body.items).toHaveLength(2);
      expect(page1.body.nextCursor).toBeTruthy();
      expect(page1.body.totalUnread).toBe(3);
      const item = page1.body.items[0];
      expect(item).toMatchObject({
        id: convs[2].id,
        participant: {
          id: others[2].user.id,
          name: 'Bola Ola',
          avatar: null,
        },
        product: null,
        lastMessage: {
          text: 'Hi',
          type: 'text',
          senderId: others[2].user.id,
        },
        unreadCount: 1,
        archived: false,
        muted: false,
      });
      expect(item.updatedAt).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
      expect(item.lastMessage.createdAt).toMatch(/Z$/);
      expect(JSON.stringify(page1.body)).not.toMatch(
        /"email"|"phoneNumber"|passwordHash/,
      );
      const page2 = await http()
        .get(`/api/chat/conversations?limit=2&cursor=${page1.body.nextCursor}`)
        .set(me.auth);
      expect(page2.body.items.map((c: { id: string }) => c.id)).toEqual([
        convs[0].id,
      ]);
      expect(page2.body.nextCursor).toBeNull();
    });

    it('archive, mute and "delete chat" only affect the caller', async () => {
      const a = await student();
      const b = await student();
      const c = await chat(a, b);
      await send(b, c.id, { text: 'hello' }).expect(201);
      const arch = await http()
        .patch(`/api/chat/conversations/${c.id}`)
        .set(a.auth)
        .send({ archived: true, muted: true });
      expect(arch.body).toMatchObject({ archived: true, muted: true });
      const inbox = await http().get('/api/chat/conversations').set(a.auth);
      expect(inbox.body.items.some((x: any) => x.id === c.id)).toBe(false);
      const archived = await http()
        .get('/api/chat/conversations?archived=true')
        .set(a.auth);
      expect(archived.body.items.map((x: any) => x.id)).toContain(c.id);
      // a new message brings it back to the inbox
      await send(b, c.id, { text: 'still there?' }).expect(201);
      const back = await http().get('/api/chat/conversations').set(a.auth);
      expect(back.body.items.map((x: any) => x.id)).toContain(c.id);

      await http()
        .delete(`/api/chat/conversations/${c.id}`)
        .set(a.auth)
        .expect(204);
      const hidden = await http().get('/api/chat/conversations').set(a.auth);
      expect(hidden.body.items.some((x: any) => x.id === c.id)).toBe(false);
      const mine = await http()
        .get(`/api/chat/conversations/${c.id}/messages`)
        .set(a.auth);
      expect(mine.body.items).toHaveLength(0);
      const theirs = await http()
        .get(`/api/chat/conversations/${c.id}/messages`)
        .set(b.auth);
      expect(theirs.body.items).toHaveLength(2);
      const [n] = await ds.query(
        `SELECT count(*)::int AS n FROM messages WHERE "conversationId" = $1`,
        [c.id],
      );
      expect(n.n).toBe(2);
    });
  });

  // ─────────────────────────────── sending ───────────────────────────────

  describe('sending', () => {
    it('needs only the conversation id and text; the same clientMessageId returns the same message', async () => {
      const a = await student();
      const b = await student();
      const c = await chat(a, b);
      const clientMessageId = randomUUID();
      const first = await send(a, c.id, {
        clientMessageId,
        text: '  Is it still available?  ',
      });
      expect(first.status).toBe(201);
      expect(first.body).toMatchObject({
        conversationId: c.id,
        seq: 1,
        clientMessageId,
        senderId: a.user.id,
        type: 'text',
        text: 'Is it still available?',
        status: 'sent',
        deleted: false,
        deletedForMe: false,
        attachments: [],
      });
      expect(first.body.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(first.body.createdAt).toMatch(
        /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/,
      );
      const again = await send(a, c.id, {
        clientMessageId,
        text: 'Is it still available?',
      });
      expect(again.status).toBe(200);
      expect(again.body.id).toBe(first.body.id);
      expect(again.body.seq).toBe(1);
      // concurrent retries of one id: still one row
      const cid = randomUUID();
      const burst = await Promise.all(
        Array.from({ length: 5 }, () =>
          send(a, c.id, { clientMessageId: cid, text: 'x' }),
        ),
      );
      expect(new Set(burst.map((r) => r.body.id)).size).toBe(1);
      const [n] = await ds.query(
        `SELECT count(*)::int AS n FROM messages WHERE "conversationId" = $1`,
        [c.id],
      );
      expect(n.n).toBe(2);
    });

    it('orders concurrent sends with contiguous seq numbers; history is newest last and pages by seq', async () => {
      const a = await student();
      const b = await student();
      const c = await chat(a, b);
      const sent = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          send(i % 2 ? a : b, c.id, {
            clientMessageId: randomUUID(),
            text: `m${i}`,
          }),
        ),
      );
      expect(sent.every((r) => r.status === 201)).toBe(true);
      expect(sent.map((r) => r.body.seq).sort((x, y) => x - y)).toEqual(
        Array.from({ length: 20 }, (_, i) => i + 1),
      );
      const latest = await http()
        .get(`/api/chat/conversations/${c.id}/messages?limit=8`)
        .set(a.auth);
      expect(latest.body.items.map((m: any) => m.seq)).toEqual([
        13, 14, 15, 16, 17, 18, 19, 20,
      ]);
      expect(latest.body.hasMore).toBe(true);
      expect(latest.body.nextCursor).toBe(13);
      const older = await http()
        .get(`/api/chat/conversations/${c.id}/messages?limit=8&beforeSeq=13`)
        .set(a.auth);
      expect(older.body.items.map((m: any) => m.seq)).toEqual([
        5, 6, 7, 8, 9, 10, 11, 12,
      ]);
      const def = await http()
        .get(`/api/chat/conversations/${c.id}/messages`)
        .set(a.auth);
      expect(def.body.items).toHaveLength(20);
      // createdAt follows seq
      const times = def.body.items.map((m: any) => Date.parse(m.createdAt));
      expect([...times].sort((x, y) => x - y)).toEqual(times);
    });

    it('error codes: TOO_LONG, VALIDATION_FAILED, CONVERSATION_NOT_FOUND, BLOCKED, FORBIDDEN', async () => {
      const a = await student();
      const b = await student();
      const outsider = await student();
      const c = await chat(a, b);
      const long = await send(a, c.id, { text: 'é'.repeat(1001) });
      expect(long.status).toBe(400);
      expect(long.body.error).toMatchObject({
        code: 'TOO_LONG',
        fields: { text: 'Messages can be up to 1000 characters.' },
      });
      expect((await send(a, c.id, { text: 'é'.repeat(1000) })).status).toBe(
        201,
      );
      const empty = await send(a, c.id, { text: '   ' });
      expect(empty.body.error).toMatchObject({
        code: 'VALIDATION_FAILED',
        fields: { text: 'Type a message.' },
      });
      const nf = await send(outsider, c.id, { text: 'hi' });
      expect(nf.status).toBe(404);
      expect(nf.body.error.code).toBe('CONVERSATION_NOT_FOUND');
      expect(
        (await send(a, randomUUID(), { text: 'hi' })).body.error.code,
      ).toBe('CONVERSATION_NOT_FOUND');
      expect(
        (
          await http()
            .get(`/api/chat/conversations/${c.id}/messages`)
            .set(outsider.auth)
        ).body.error.code,
      ).toBe('CONVERSATION_NOT_FOUND');

      await http()
        .post('/api/blocks')
        .set(b.auth)
        .send({ userId: a.user.id })
        .expect(200);
      const blocked = await send(a, c.id, { text: 'hi' });
      expect(blocked.status).toBe(403);
      expect(blocked.body.error.code).toBe('BLOCKED');
      const sa = await connect(a);
      const ack = await emit(sa, 'message:send', {
        conversationId: c.id,
        clientMessageId: randomUUID(),
        text: 'hi',
      });
      expect(ack).toMatchObject({ ok: false, error: { code: 'BLOCKED' } });
      await http().delete(`/api/blocks/${a.user.id}`).set(b.auth).expect(204);

      const m = await send(a, c.id, { text: 'mine' });
      const del = await http()
        .delete(
          `/api/chat/conversations/${c.id}/messages/${m.body.id}?for=everyone`,
        )
        .set(b.auth);
      expect(del.status).toBe(403);
      expect(del.body.error.code).toBe('FORBIDDEN');
    });

    it('rate limits sends over sockets too (30/min shared with REST)', async () => {
      const a = await student();
      const b = await student();
      const c = await chat(a, b);
      for (let i = 0; i < 29; i++)
        await send(a, c.id, { text: `r${i}` }).expect(201);
      const sa = await connect(a);
      const ok = await emit(sa, 'message:send', {
        conversationId: c.id,
        clientMessageId: randomUUID(),
        text: '30th',
      });
      expect(ok.ok).toBe(true);
      const over = await emit(sa, 'message:send', {
        conversationId: c.id,
        clientMessageId: randomUUID(),
        text: '31st',
      });
      expect(over).toMatchObject({
        ok: false,
        error: { code: 'RATE_LIMITED' },
      });
      expect(over.error.retryAfterSeconds).toBeGreaterThan(0);
      // a retry of an already-saved message is never rate limited
      const retry = await emit(sa, 'message:send', {
        conversationId: c.id,
        clientMessageId: ok.data.message.clientMessageId,
        text: '30th',
      });
      expect(retry).toMatchObject({ ok: true, data: { created: false } });
    });

    it('photos: chat uploads only, with a thumbnail; other URLs are refused', async () => {
      const a = await student();
      const b = await student();
      const c = await chat(a, b);
      const pid = `campussales/chat/${randomUUID()}`;
      await ds.query(
        `INSERT INTO uploads ("userId", filename, "originalName", mimetype, size, url, "uploadType", "cloudinaryPublicId", status, version, width, height)
         VALUES ($1, $2, '', 'image/webp', 1000, '', 'product_image', $2, 'ready', 5, 800, 600)`,
        [a.user.id, pid],
      );
      const url = `https://res.cloudinary.com/campussales-test/image/upload/v5/${pid}.webp`;
      const m = await send(a, c.id, {
        clientMessageId: randomUUID(),
        attachments: [{ url }],
      });
      expect(m.status).toBe(201);
      expect(m.body.type).toBe('image');
      expect(m.body.attachments).toEqual([
        {
          url: `https://res.cloudinary.com/campussales-test/image/upload/f_auto,q_auto/v5/${pid}`,
          thumbUrl: `https://res.cloudinary.com/campussales-test/image/upload/f_auto,q_auto,c_limit,w_400/v5/${pid}`,
          width: 800,
          height: 600,
        },
      ]);
      for (const bad of [
        'https://evil.example.com/x.jpg',
        `https://res.cloudinary.com/other-cloud/image/upload/v5/${pid}.webp`,
        // someone else's upload
        `https://res.cloudinary.com/campussales-test/image/upload/v1/campussales/chat/${randomUUID()}.jpg`,
      ]) {
        const r = await send(a, c.id, { attachments: [{ url: bad }] });
        expect(r.status).toBe(400);
        expect(r.body.error.code).toBe('VALIDATION_FAILED');
      }
      const sign = await http()
        .post('/api/uploads/sign')
        .set(a.auth)
        .send({ kind: 'chat' });
      expect(sign.body.formats).toEqual(['jpg', 'jpeg', 'png', 'webp']);
      expect(sign.body.uploads[0].fields.allowed_formats).toBe(
        'jpg,jpeg,png,webp',
      );
    });
  });

  // ─────────────────────────────── real time ─────────────────────────────

  describe('real time', () => {
    it('rejects sockets without a valid token', async () => {
      await expect(connect('not-a-token')).rejects.toMatchObject({
        message: 'UNAUTHENTICATED',
      });
      const ghost = new JwtService({ secret: process.env.JWT_SECRET }).sign({
        sub: randomUUID(),
      });
      await expect(connect(ghost)).rejects.toMatchObject({
        message: 'UNAUTHENTICATED',
      });
    });

    it('delivers to the other client within 100 ms, acks mark delivered, POST /read marks read and drops unread counts', async () => {
      const a = await student('Ada');
      const b = await student('Bola');
      const c = await chat(a, b);
      const [sa, sb] = await Promise.all([connect(a), connect(b)]);

      const incoming = next<any>(sb, 'message:new');
      const delivered = next<any>(sa, 'message:status');
      const unreadB = next<any>(sb, 'unread:update');
      const t0 = Date.now();
      const ack = await emit(sa, 'message:send', {
        conversationId: c.id,
        clientMessageId: randomUUID(),
        text: 'Hello Bola',
      });
      expect(ack).toMatchObject({ ok: true, data: { created: true } });
      const msg = await incoming;
      const elapsed = Date.now() - t0;
      expect(elapsed).toBeLessThan(100);
      expect(msg).toMatchObject({
        id: ack.data.message.id,
        seq: 1,
        text: 'Hello Bola',
        senderId: a.user.id,
      });
      expect(JSON.stringify(msg)).not.toMatch(/"email"|"phoneNumber"/);
      expect(await unreadB).toMatchObject({
        conversationId: c.id,
        unreadCount: 1,
        total: 1,
      });
      expect(await delivered).toMatchObject({
        conversationId: c.id,
        upToSeq: 1,
        status: 'delivered',
        userId: b.user.id,
      });
      expect(chatMetrics.snapshot(60_000).deliveryMs.count).toBeGreaterThan(0);

      // REST sends are delivered in real time too
      const rest = next<any>(sb, 'message:new');
      await send(a, c.id, { clientMessageId: randomUUID(), text: 'via REST' });
      expect((await rest).seq).toBe(2);

      const before = await http().get('/api/chat/unread').set(b.auth);
      expect(before.body).toEqual({
        total: 2,
        conversations: [{ conversationId: c.id, unreadCount: 2 }],
      });

      const readStatus = next<any>(sa, 'message:status');
      const read1 = await http()
        .post(`/api/chat/conversations/${c.id}/read`)
        .set(b.auth)
        .send({ upToSeq: 1 });
      expect(read1.body).toEqual({
        conversationId: c.id,
        lastReadSeq: 1,
        unreadCount: 1,
        totalUnread: 1,
      });
      expect(await readStatus).toMatchObject({ status: 'read', upToSeq: 1 });
      // idempotent and never backwards
      const again = await http()
        .post(`/api/chat/conversations/${c.id}/read`)
        .set(b.auth)
        .send({ upToSeq: 0 });
      expect(again.body.lastReadSeq).toBe(1);
      const all = await http()
        .post(`/api/chat/conversations/${c.id}/read`)
        .set(b.auth)
        .send({});
      expect(all.body).toMatchObject({
        lastReadSeq: 2,
        unreadCount: 0,
        totalUnread: 0,
      });

      const list = await http().get('/api/chat/conversations').set(b.auth);
      expect(list.body.items[0]).toMatchObject({ id: c.id, unreadCount: 0 });
      expect(list.body.totalUnread).toBe(0);
      expect(
        (await http().get('/api/chat/unread').set(b.auth)).body.total,
      ).toBe(0);

      // the sender's history shows read receipts
      const hist = await http()
        .get(`/api/chat/conversations/${c.id}/messages`)
        .set(a.auth);
      expect(hist.body.items.map((m: any) => m.status)).toEqual([
        'read',
        'read',
      ]);
    });

    it('resumes after a disconnect with afterSeq (missed messages in order)', async () => {
      const a = await student();
      const b = await student();
      const c = await chat(a, b);
      const sb = await connect(b);
      const first = next<any>(sb, 'message:new');
      await send(a, c.id, { clientMessageId: randomUUID(), text: 'one' });
      const lastSeen = (await first).seq;
      sb.disconnect();
      for (const t of ['two', 'three', 'four'])
        await send(a, c.id, { clientMessageId: randomUUID(), text: t });
      await connect(b);
      const missed = await http()
        .get(
          `/api/chat/conversations/${c.id}/messages?afterSeq=${lastSeen}&limit=2`,
        )
        .set(b.auth);
      expect(missed.body.items.map((m: any) => m.text)).toEqual([
        'two',
        'three',
      ]);
      expect(missed.body.hasMore).toBe(true);
      const rest = await http()
        .get(
          `/api/chat/conversations/${c.id}/messages?afterSeq=${missed.body.nextAfterSeq}`,
        )
        .set(b.auth);
      expect(rest.body.items.map((m: any) => m.text)).toEqual(['four']);
      expect(rest.body.hasMore).toBe(false);
      // loading the thread marked everything delivered
      await new Promise((r) => setTimeout(r, 100));
      const [p] = await ds.query(
        `SELECT "lastDeliveredSeq"::int AS d FROM conversation_participants WHERE "conversationId" = $1 AND "userId" = $2`,
        [c.id, b.user.id],
      );
      expect(p.d).toBe(4);
    });

    it('typing reaches the other person and expires after 5 s; presence respects the setting', async () => {
      const a = await student();
      const b = await student();
      const c = await chat(a, b);
      const [sa, sb] = await Promise.all([connect(a), connect(b)]);
      const typing = next<any>(sb, 'typing');
      expect(
        (await emit(sa, 'typing', { conversationId: c.id, isTyping: true })).ok,
      ).toBe(true);
      expect(await typing).toMatchObject({
        conversationId: c.id,
        userId: a.user.id,
        isTyping: true,
      });
      const stopped = next<any>(sb, 'typing', 6000);
      expect(await stopped).toMatchObject({ isTyping: false });

      const outsider = await student();
      const so = await connect(outsider);
      expect(
        (await emit(so, 'typing', { conversationId: c.id, isTyping: true }))
          .error.code,
      ).toBe('CONVERSATION_NOT_FOUND');

      const pres = await emit(sb, 'presence:subscribe', {
        userIds: [a.user.id, outsider.user.id],
      });
      expect(pres.data).toEqual([
        { userId: a.user.id, online: true, lastActiveAt: expect.any(String) },
      ]);
      const offline = next<any>(sb, 'presence', 7000);
      sa.disconnect();
      expect(await offline).toMatchObject({ userId: a.user.id, online: false });

      await http()
        .patch('/api/chat/settings')
        .set(a.auth)
        .send({ showPresence: false })
        .expect(200);
      expect(
        (await emit(sb, 'presence:subscribe', { userIds: [a.user.id] })).data,
      ).toEqual([]);
      const item = await http()
        .get(`/api/chat/conversations/${c.id}`)
        .set(b.auth);
      expect(item.body.participant).toMatchObject({
        lastActiveAt: null,
        online: null,
      });
    }, 20000);

    it('posts a system message in real time when the item is sold', async () => {
      const seller = await student();
      const buyer = await student();
      const p = await listing(seller);
      const c = await chat(buyer, seller, p.id);
      const sb = await connect(buyer);
      const sys = next<any>(sb, 'message:new');
      await http()
        .post(`/api/products/${p.id}/sold`)
        .set(seller.auth)
        .expect(200);
      expect(await sys).toMatchObject({
        conversationId: c.id,
        type: 'system',
        seq: 1,
      });
      const item = await http()
        .get(`/api/chat/conversations/${c.id}`)
        .set(buyer.auth);
      expect(item.body.product).toMatchObject({ id: p.id, status: 'sold' });
      expect(item.body).toMatchObject({ closed: true, closedReason: 'sold' });
    });
  });

  // ─────────────────────── deletes, offline, reports ─────────────────────

  describe('deletes, offline notifications and reports', () => {
    it('delete for me hides one message for the caller; delete for everyone within 10 minutes', async () => {
      const a = await student();
      const b = await student();
      const c = await chat(a, b);
      const m1 = (await send(a, c.id, { text: 'first' })).body;
      const m2 = (await send(a, c.id, { text: 'second' })).body;

      const me = await http()
        .delete(`/api/chat/conversations/${c.id}/messages/${m1.id}`)
        .set(b.auth);
      expect(me.body).toMatchObject({ deletedForMe: true, text: null });
      const bView = await http()
        .get(`/api/chat/conversations/${c.id}/messages`)
        .set(b.auth);
      expect(bView.body.items[0]).toMatchObject({
        id: m1.id,
        deletedForMe: true,
        text: null,
      });
      const aView = await http()
        .get(`/api/chat/conversations/${c.id}/messages`)
        .set(a.auth);
      expect(aView.body.items[0]).toMatchObject({
        id: m1.id,
        deletedForMe: false,
        text: 'first',
      });

      const sb = await connect(b);
      const updated = next<any>(sb, 'message:updated');
      const everyone = await http()
        .delete(
          `/api/chat/conversations/${c.id}/messages/${m2.id}?for=everyone`,
        )
        .set(a.auth);
      expect(everyone.body).toMatchObject({
        deleted: true,
        text: null,
        content: 'Message deleted',
      });
      expect(await updated).toMatchObject({
        id: m2.id,
        deleted: true,
        text: null,
      });
      const unread = await http().get('/api/chat/unread').set(b.auth);
      expect(unread.body.total).toBe(1);

      const m3 = (await send(a, c.id, { text: 'old' })).body;
      await ds.query(
        `UPDATE messages SET "createdAt" = now() - interval '11 minutes' WHERE id = $1`,
        [m3.id],
      );
      const late = await http()
        .delete(
          `/api/chat/conversations/${c.id}/messages/${m3.id}?for=everyone`,
        )
        .set(a.auth);
      expect(late.status).toBe(403);
      // never hard-deleted
      const [n] = await ds.query(
        `SELECT count(*)::int AS n FROM messages WHERE "conversationId" = $1`,
        [c.id],
      );
      expect(n.n).toBe(3);
    });

    it('offline recipients get one in-app notification per chat, never with payment or link text', async () => {
      const a = await student('Ada');
      const b = await student();
      const c = await chat(a, b);
      await send(a, c.id, { text: 'Is the lamp still available?' }).expect(201);
      await send(a, c.id, { text: 'Pay into 0123456789 first' }).expect(201);
      await send(a, c.id, { text: 'see www.cheap-deals.xyz' }).expect(201);
      await new Promise((r) => setTimeout(r, 300));
      const rows = await ds.query(
        `SELECT title, body FROM notifications WHERE "userId" = $1 AND type = 'message'`,
        [b.user.id],
      );
      expect(rows).toEqual([
        { title: 'New message from Ada', body: 'Sent you a message' },
      ]);
    });

    it('report a message goes to the B4 reports queue', async () => {
      const a = await student();
      const b = await student();
      const c = await chat(a, b);
      const m = (await send(a, c.id, { text: 'send me your code' })).body;
      const r = await http()
        .post(`/api/chat/conversations/${c.id}/messages/${m.id}/report`)
        .set(b.auth)
        .send({ reason: 'scam' });
      expect(r.status).toBe(201);
      const [row] = await ds.query(
        `SELECT "targetType", "targetUserId" FROM reports WHERE "targetId" = $1`,
        [m.id],
      );
      expect(row).toEqual({ targetType: 'message', targetUserId: a.user.id });
    });
  });

  // ──────────────────────────── merge script ─────────────────────────────

  it('merges duplicate conversations without losing a message (dry run first)', async () => {
    const a = await student();
    const b = await student();
    const keep = await chat(a, b);
    await send(a, keep.id, { text: 'k1' }).expect(201);
    await send(b, keep.id, { text: 'k2' }).expect(201);
    await http()
      .post(`/api/chat/conversations/${keep.id}/read`)
      .set(b.auth)
      .send({})
      .expect(200);

    // Simulate legacy duplicates (created before the unique index existed).
    await ds.query(`DROP INDEX "UQ_conversations_pair_product"`);
    const [lo, hi] = [a.user.id, b.user.id].sort();
    const dupIds: string[] = [];
    for (let i = 0; i < 2; i++) {
      const [d] = await ds.query(
        `INSERT INTO conversations (type, "userLowId", "userHighId", "createdAt") VALUES ('direct', $1, $2, now() + interval '1 second') RETURNING id`,
        [lo, hi],
      );
      dupIds.push(d.id);
      await ds.query(
        `INSERT INTO conversation_participants ("conversationId", "userId", "lastMessageAt") VALUES ($1, $2, now()), ($1, $3, now())`,
        [d.id, a.user.id, b.user.id],
      );
      await send(a, d.id, { text: `d${i}` }).expect(201);
    }
    const total = async () =>
      (
        await ds.query(
          `SELECT count(*)::int AS n FROM messages WHERE "conversationId" = ANY($1::uuid[])`,
          [[keep.id, ...dupIds]],
        )
      )[0].n;
    expect(await total()).toBe(4);

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { run } = require(
      join(__dirname, '..', 'scripts', 'merge-duplicate-conversations.js'),
    );
    const pg = new PgClient({
      host: process.env.DATABASE_HOST || 'localhost',
      port: parseInt(process.env.DATABASE_PORT || '5432', 10),
      user: process.env.DATABASE_USERNAME,
      password: process.env.DATABASE_PASSWORD,
      database: process.env.DATABASE_NAME,
    });
    await pg.connect();
    try {
      const log = () => undefined;
      const dry = await run(pg, { apply: false, log });
      expect(dry).toMatchObject({ groups: 1, duplicates: 2, applied: false });
      expect(await total()).toBe(4);
      const applied = await run(pg, { apply: true, log });
      expect(applied).toMatchObject({ duplicates: 2, messagesMoved: 2 });
    } finally {
      await pg.end();
    }
    const msgs = await ds.query(
      `SELECT seq::int, content FROM messages WHERE "conversationId" = $1 ORDER BY seq`,
      [keep.id],
    );
    expect(msgs).toEqual([
      { seq: 1, content: 'k1' },
      { seq: 2, content: 'k2' },
      { seq: 3, content: 'd0' },
      { seq: 4, content: 'd1' },
    ]);
    const [{ n }] = await ds.query(
      `SELECT count(*)::int AS n FROM conversations WHERE "userLowId" = $1 AND "userHighId" = $2`,
      [lo, hi],
    );
    expect(n).toBe(1);
    // b had read k1..k2 and now has d0, d1 unread
    const unread = await http().get('/api/chat/unread').set(b.auth);
    expect(unread.body).toEqual({
      total: 2,
      conversations: [{ conversationId: keep.id, unreadCount: 2 }],
    });
    const [idx] = await ds.query(
      `SELECT 1 AS ok FROM pg_indexes WHERE indexname = 'UQ_conversations_pair_product'`,
    );
    expect(idx).toEqual({ ok: 1 });
  });
});
