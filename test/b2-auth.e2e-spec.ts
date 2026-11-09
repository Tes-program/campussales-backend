import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { randomUUID } from 'crypto';
import { createTestApp } from './setup/app';
import { User } from '../src/users/entities/user.entity';
import { PasswordReset } from '../src/auth/entities/password-reset.entity';

const PW = 'mango-tree-77';

/** Every test uses its own client IP so per-IP limits don't interfere. */
let ipSeq = 1;
const freshIp = () => `10.20.${Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}`;

const cookieOf = (res: request.Response): string | undefined => {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  return raw?.find((c) => c.startsWith('cs_refresh='));
};
const cookiePair = (res: request.Response) =>
  cookieOf(res)?.split(';')[0] ?? '';

/** Collects every JSON key, at any depth. */
function keysDeep(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => keysDeep(x, out));
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      keysDeep(x, out);
    }
  }
  return out;
}
const assertNoSecrets = (body: unknown) => {
  expect(
    keysDeep(body).filter((k) =>
      /password|tokenHash|tokensValidAfter/i.test(k),
    ),
  ).toEqual([]);
  expect(JSON.stringify(body)).not.toMatch(/\$2[aby]\$\d\d\$/); // bcrypt hashes
};

describe('B2 auth and tokens (e2e)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let http: () => ReturnType<typeof request>;

  beforeAll(async () => {
    ctx = await createTestApp();
    ({ app, ds } = ctx);
    http = () => request(app.getHttpServer());
  });
  afterAll(() => app.close());
  afterEach(() => {
    delete process.env.AUTH_LEGACY_TOKENS;
  });

  const email = () => `student-${randomUUID().slice(0, 8)}@unilag.edu.ng`;
  const signup = (body: Record<string, unknown> = {}, ip = freshIp()) =>
    http()
      .post('/api/auth/signup')
      .set('X-Forwarded-For', ip)
      .send({
        name: 'Ada Okafor',
        username: `ada_${randomUUID().slice(0, 8)}`,
        email: email(),
        password: PW,
        acceptedTerms: true,
        acceptedTermsVersion: '2026-11-01',
        ...body,
      });
  const login = (e: string, password = PW, ip = freshIp()) =>
    http()
      .post('/api/auth/login')
      .set('X-Forwarded-For', ip)
      .send({ email: e, password });

  // ───────────────────────────── sign-up ─────────────────────────────

  describe('sign-up', () => {
    it('creates the account, sets an HttpOnly Secure SameSite=Lax cookie and sends a verification email', async () => {
      const e = email();
      const res = await signup({ email: e });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ tokenType: 'Bearer', expiresIn: 900 });
      expect(res.body.accessToken).toEqual(expect.any(String));
      expect(res.body.refreshToken).toBeUndefined(); // legacy off
      expect(res.body.user).toMatchObject({
        email: e,
        fullName: 'Ada Okafor',
        emailVerified: false,
        userType: 'student',
        acceptedTermsVersion: '2026-11-01',
      });
      expect(res.body.user.acceptedTermsAt).toBeTruthy();
      assertNoSecrets(res.body);

      const cookie = cookieOf(res)!;
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/Secure/i);
      expect(cookie).toMatch(/SameSite=Lax/i);
      expect(cookie).toMatch(/Path=\/api\/auth/);
      expect(cookie).toMatch(/Max-Age=2592000/); // 30 days

      const mail = await ctx.nextEmail(e, 'email_verification');
      expect(mail.text).toMatch(
        /https:\/\/campus-sales\.test\/verify-email\?token=/,
      );
    });

    it('requires acceptedTerms', async () => {
      const res = await signup({ acceptedTerms: undefined });
      expect(res.status).toBe(400);
      expect(res.body.error.fields.acceptedTerms).toBe(
        'Please accept the Terms and Privacy Policy to continue.',
      );
      const f = await signup({ acceptedTerms: false });
      expect(f.body.error.fields.acceptedTerms).toBeDefined();
    });

    it('applies the shared password rule (the form rule, no stricter)', async () => {
      const cases: [string, string][] = [
        ['short1', 'Use at least 8 characters, including a number.'],
        ['onlyletters', 'Use at least 8 characters, including a number.'],
      ];
      for (const [password, message] of cases) {
        const res = await signup({ password });
        expect(res.status).toBe(400);
        expect(res.body.error.fields.password).toBe(message);
      }
      // Rules the form never showed are no longer enforced.
      for (const password of ['12345678', 'password1', 'AdaOkafor2026']) {
        expect((await signup({ password })).status).toBe(201);
      }
    });

    it('existing email returns 409 with a clear message', async () => {
      const e = email();
      await signup({ email: e }).expect(201);
      const res = await signup({ email: e.toUpperCase() });
      expect(res.status).toBe(409);
      expect(res.body.error.fields.email).toBe(
        'An account with this email already exists. Log in instead.',
      );
    });

    it('stores a school picked at sign-up and rejects unknown ones', async () => {
      const ok = await signup({ campus: 'unilag' });
      expect(ok.status).toBe(201);
      expect(ok.body.user.signupSchoolId).toEqual(expect.any(String));
      const bad = await signup({ schoolId: randomUUID() });
      expect(bad.body.error.fields.schoolId).toBe(
        'Choose your school from the list.',
      );
    });

    it('never lets a client choose its role', async () => {
      process.env.AUTH_LEGACY_TOKENS = 'true';
      const res = await http()
        .post('/api/auth/register')
        .set('X-Forwarded-For', freshIp())
        .send({
          email: email(),
          password: PW,
          username: `u${Date.now()}`,
          userType: 'admin',
        });
      expect(res.status).toBe(201);
      expect(res.body.user.userType).toBe('student');
      expect(res.body.user.acceptedTermsAt).toBeNull();
    });

    it('/auth/register behaves like /auth/signup when legacy mode is off', async () => {
      const res = await http()
        .post('/api/auth/register')
        .set('X-Forwarded-For', freshIp())
        .send({ email: email(), password: PW, username: `u${Date.now()}` });
      expect(res.status).toBe(400);
      expect(res.body.error.fields.acceptedTerms).toBeDefined();
    });

    it('social login endpoints do not exist', async () => {
      for (const p of ['google', 'apple', 'google/callback']) {
        expect((await http().get(`/api/auth/${p}`)).status).toBe(404);
        expect((await http().post(`/api/auth/${p}`)).status).toBe(404);
      }
    });
  });

  // ───────────────────────────── login ────────────────────────────────

  describe('login', () => {
    it('succeeds and returns the session', async () => {
      const e = email();
      await signup({ email: e }).expect(201);
      const res = await login(e.toUpperCase());
      expect(res.status).toBe(200);
      expect(res.body.user.email).toBe(e);
      expect(cookieOf(res)).toBeTruthy();
      assertNoSecrets(res.body);
    });

    it('wrong email and wrong password give identical responses and similar timing', async () => {
      const e = email();
      await signup({ email: e }).expect(201);
      const strip = (b: Record<string, any>) => ({
        ...b,
        error: { ...b.error, requestId: undefined },
        timestamp: undefined,
      });
      const timeIt = async (fn: () => Promise<request.Response>) => {
        const t = process.hrtime.bigint();
        const r = await fn();
        return { r, ms: Number(process.hrtime.bigint() - t) / 1e6 };
      };
      const wrongPw: { r: request.Response; ms: number }[] = [];
      const wrongEmail: { r: request.Response; ms: number }[] = [];
      for (let i = 0; i < 3; i++) {
        wrongPw.push(await timeIt(() => login(e, 'wrong-pass-1')));
        wrongEmail.push(await timeIt(() => login(email(), 'wrong-pass-1')));
      }
      for (const { r } of [...wrongPw, ...wrongEmail]) {
        expect(r.status).toBe(401);
        expect(r.body.error).toMatchObject({
          code: 'INVALID_CREDENTIALS',
          message: 'Email or password is incorrect.',
        });
      }
      expect(strip(wrongPw[0].r.body)).toEqual(strip(wrongEmail[0].r.body));
      const avg = (xs: { ms: number }[]) =>
        xs.reduce((a, b) => a + b.ms, 0) / xs.length;
      expect(Math.abs(avg(wrongPw) - avg(wrongEmail))).toBeLessThan(150);
    });

    it('six wrong logins in a row return 429 with retryAfterSeconds', async () => {
      const e = email();
      await signup({ email: e }).expect(201);
      for (let i = 0; i < 5; i++) {
        expect((await login(e, 'nope-nope-1')).status).toBe(401);
      }
      const sixth = await login(e, 'nope-nope-1');
      expect(sixth.status).toBe(429);
      expect(sixth.body.error.code).toBe('RATE_LIMITED');
      expect(sixth.body.error.retryAfterSeconds).toBeGreaterThan(0);
      expect(sixth.body.error.retryAfterSeconds).toBeLessThanOrEqual(30);
      expect(sixth.headers['retry-after']).toBe(
        String(sixth.body.error.retryAfterSeconds),
      );
    });

    it('limits failures per IP to 20 in 15 minutes', async () => {
      const ip = freshIp();
      for (let i = 0; i < 20; i++) {
        expect((await login(email(), 'nope-nope-1', ip)).status).toBe(401);
      }
      expect((await login(email(), 'nope-nope-1', ip)).status).toBe(429);
    });
  });

  // ───────────────────────────── sessions ──────────────────────────────

  describe('refresh, rotation and logout', () => {
    it('rotates the cookie on every use and detects reuse', async () => {
      const s = await signup();
      const c1 = cookiePair(s);
      const r1 = await http().post('/api/auth/refresh').set('Cookie', c1);
      expect(r1.status).toBe(200);
      expect(r1.body.accessToken).toEqual(expect.any(String));
      const c2 = cookiePair(r1);
      expect(c2).not.toBe(c1);

      // c1 was already used: reuse revokes the whole family, including c2.
      const reuse = await http().post('/api/auth/refresh').set('Cookie', c1);
      expect(reuse.status).toBe(401);
      expect(reuse.body.error.code).toBe('UNAUTHENTICATED');
      expect(
        (await http().post('/api/auth/refresh').set('Cookie', c2)).status,
      ).toBe(401);
    });

    it('returns 401 when the cookie is missing', async () => {
      const res = await http().post('/api/auth/refresh');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    });

    it('ignores a body token unless legacy mode is on', async () => {
      process.env.AUTH_LEGACY_TOKENS = 'true';
      const s = await signup();
      expect(s.body.refreshToken).toEqual(expect.any(String));
      delete process.env.AUTH_LEGACY_TOKENS;
      const off = await http()
        .post('/api/auth/refresh')
        .send({ refreshToken: s.body.refreshToken });
      expect(off.status).toBe(401);
    });

    it('legacy mode: the deployed frontend keeps logging in and refreshing with body tokens', async () => {
      process.env.AUTH_LEGACY_TOKENS = 'true';
      const e = email();
      await signup({ email: e }).expect(201);
      const l = await login(e);
      expect(l.status).toBe(200);
      expect(l.body.refreshToken).toEqual(expect.any(String));
      const r = await http()
        .post('/api/auth/refresh')
        .send({ refreshToken: l.body.refreshToken });
      expect(r.status).toBe(200);
      expect(r.body.refreshToken).toEqual(expect.any(String));
      expect(r.body.refreshToken).not.toBe(l.body.refreshToken);
      const out = await http()
        .post('/api/auth/logout')
        .send({ refreshToken: r.body.refreshToken });
      expect(out.status).toBe(204);
      expect(
        (
          await http()
            .post('/api/auth/refresh')
            .send({ refreshToken: r.body.refreshToken })
        ).status,
      ).toBe(401);
    });

    it('logout clears the cookie and revokes the family', async () => {
      const s = await signup();
      const c = cookiePair(s);
      const out = await http().post('/api/auth/logout').set('Cookie', c);
      expect(out.status).toBe(204);
      expect(cookieOf(out)).toMatch(/cs_refresh=;/);
      expect(
        (await http().post('/api/auth/refresh').set('Cookie', c)).status,
      ).toBe(401);
    });

    it('logout-all ends every session and live access tokens', async () => {
      const e = email();
      const s = await signup({ email: e });
      const other = await login(e);
      await new Promise((r) => setTimeout(r, 1100)); // iat granularity is 1s
      await http()
        .post('/api/auth/logout-all')
        .set('Authorization', `Bearer ${s.body.accessToken}`)
        .expect(204);
      expect(
        (
          await http()
            .post('/api/auth/refresh')
            .set('Cookie', cookiePair(other))
        ).status,
      ).toBe(401);
      expect(
        (
          await http()
            .get('/api/auth/me')
            .set('Authorization', `Bearer ${other.body.accessToken}`)
        ).status,
      ).toBe(401);
    });
  });

  // ───────────────────────────── passwords ─────────────────────────────

  describe('password reset', () => {
    it('full flow: request, email link, reset, old link fails, sessions revoked', async () => {
      const e = email();
      const s = await signup({ email: e });
      const known = await http()
        .post('/api/auth/forgot-password')
        .set('X-Forwarded-For', freshIp())
        .send({ email: e });
      const unknown = await http()
        .post('/api/auth/forgot-password')
        .set('X-Forwarded-For', freshIp())
        .send({ email: email() });
      expect(known.status).toBe(200);
      expect(known.body).toEqual({
        message: "If that email has an account, we've sent a link.",
      });
      expect(unknown.body).toEqual(known.body);

      const mail = await ctx.nextEmail(e, 'password_reset');
      expect(mail.text).toMatch(/expires in 30 minutes/);
      expect(mail.text).toMatch(
        /If you didn't ask for this, ignore this email/,
      );
      const link =
        /https:\/\/campus-sales\.test\/reset-password\?token=([A-Za-z0-9_-]+)/.exec(
          mail.text,
        );
      expect(link).not.toBeNull();
      const token = decodeURIComponent(link![1]);

      const weak = await http()
        .post('/api/auth/reset-password')
        .send({ token, newPassword: 'abc' });
      expect(weak.body.error.fields.newPassword).toBe(
        'Use at least 8 characters, including a number.',
      );

      const ok = await http()
        .post('/api/auth/reset-password')
        .send({ token, newPassword: 'new-orange-55' });
      expect(ok.status).toBe(200);

      const again = await http()
        .post('/api/auth/reset-password')
        .send({ token, newPassword: 'new-orange-56' });
      expect(again.status).toBe(400);
      expect(again.body.error.code).toBe('TOKEN_INVALID');

      expect((await login(e, 'new-orange-55')).status).toBe(200);
      expect((await login(e, PW)).status).toBe(401);
      expect(
        (await http().post('/api/auth/refresh').set('Cookie', cookiePair(s)))
          .status,
      ).toBe(401);
      await ctx.nextEmail(e, 'password_changed');
    });

    it('expired tokens return TOKEN_EXPIRED; a newer link supersedes an older one', async () => {
      const e = email();
      await signup({ email: e });
      await http()
        .post('/api/auth/forgot-password')
        .set('X-Forwarded-For', freshIp())
        .send({ email: e });
      const first = await ctx.nextEmail(e, 'password_reset');
      const t1 = /token=([A-Za-z0-9_-]+)/.exec(first.text)![1];
      ctx.outbox.length = 0;
      await http()
        .post('/api/auth/forgot-password')
        .set('X-Forwarded-For', freshIp())
        .send({ email: e });
      const second = await ctx.nextEmail(e, 'password_reset');
      const t2 = /token=([A-Za-z0-9_-]+)/.exec(second.text)![1];

      expect(
        (
          await http()
            .post('/api/auth/reset-password')
            .send({ token: t1, newPassword: 'pear-tree-41' })
        ).body.error.code,
      ).toBe('TOKEN_INVALID');

      const user = await ds.getRepository(User).findOneByOrFail({ email: e });
      await ds
        .getRepository(PasswordReset)
        .update(
          { userId: user.id, isUsed: false },
          { expiresAt: new Date(Date.now() - 60_000) },
        );
      const expired = await http()
        .post('/api/auth/reset-password')
        .send({ token: t2, newPassword: 'pear-tree-41' });
      expect(expired.status).toBe(400);
      expect(expired.body.error.code).toBe('TOKEN_EXPIRED');
      expect(expired.body.error.message).toBe(
        'This link has expired. Please request a new one.',
      );
    });

    it('limits reset emails to 3 per hour per email, still answering 200', async () => {
      const e = email();
      await signup({ email: e });
      ctx.outbox.length = 0;
      for (let i = 0; i < 4; i++) {
        const r = await http()
          .post('/api/auth/forgot-password')
          .set('X-Forwarded-For', freshIp())
          .send({ email: e });
        expect(r.status).toBe(200);
      }
      await new Promise((r) => setTimeout(r, 300));
      expect(
        ctx.outbox.filter((m) => m.to === e && m.kind === 'password_reset'),
      ).toHaveLength(3);
    });

    it('change password revokes other sessions, keeps this one, and emails the user', async () => {
      const e = email();
      const here = await signup({ email: e });
      const elsewhere = await login(e);
      await new Promise((r) => setTimeout(r, 1100));

      const wrong = await http()
        .post('/api/auth/change-password')
        .set('Authorization', `Bearer ${here.body.accessToken}`)
        .send({ currentPassword: 'not-it-123', newPassword: 'grape-vine-63' });
      expect(wrong.status).toBe(400);
      expect(wrong.body.error.fields.currentPassword).toBe(
        'Your current password is incorrect.',
      );

      const ok = await http()
        .post('/api/auth/change-password')
        .set('Authorization', `Bearer ${here.body.accessToken}`)
        .set('Cookie', cookiePair(here))
        .send({ currentPassword: PW, newPassword: 'grape-vine-63' });
      expect(ok.status).toBe(200);
      expect(ok.body.accessToken).toEqual(expect.any(String));

      expect(
        (
          await http()
            .post('/api/auth/refresh')
            .set('Cookie', cookiePair(elsewhere))
        ).status,
      ).toBe(401);
      expect(
        (
          await http()
            .get('/api/auth/me')
            .set('Authorization', `Bearer ${elsewhere.body.accessToken}`)
        ).status,
      ).toBe(401);
      expect(
        (
          await http()
            .get('/api/auth/me')
            .set('Authorization', `Bearer ${ok.body.accessToken}`)
        ).status,
      ).toBe(200);
      expect(
        (await http().post('/api/auth/refresh').set('Cookie', cookiePair(here)))
          .status,
      ).toBe(200);
      await ctx.nextEmail(e, 'password_changed');
    });
  });

  // ─────────────────────────── verification ────────────────────────────

  describe('email verification', () => {
    it('verifies with the emailed link; the link is single use', async () => {
      const e = email();
      const s = await signup({ email: e });
      const mail = await ctx.nextEmail(e, 'email_verification');
      const token = /token=([A-Za-z0-9_-]+)/.exec(mail.text)![1];
      const ok = await http().post('/api/auth/verify-email').send({ token });
      expect(ok.status).toBe(200);
      expect(ok.body.user.emailVerified).toBe(true);
      const again = await http().post('/api/auth/verify-email').send({ token });
      expect(again.body.error.code).toBe('TOKEN_INVALID');
      const me = await http()
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${s.body.accessToken}`);
      expect(me.body.emailVerified).toBe(true);
    });

    it('resend is limited to 3 per hour', async () => {
      const s = await signup();
      const auth = { Authorization: `Bearer ${s.body.accessToken}` };
      for (let i = 0; i < 3; i++) {
        expect(
          (await http().post('/api/auth/resend-verification').set(auth)).status,
        ).toBe(200);
      }
      const fourth = await http()
        .post('/api/auth/resend-verification')
        .set(auth);
      expect(fourth.status).toBe(429);
      expect(fourth.body.error.retryAfterSeconds).toBeGreaterThan(0);
    });

    it('after the 24h grace, unverified users cannot post', async () => {
      const s = await signup();
      await ds
        .getRepository(User)
        .update(
          { id: s.body.user.id },
          { verifyBy: new Date(Date.now() - 1000) },
        );
      const res = await http()
        .post('/api/products')
        .set('Authorization', `Bearer ${s.body.accessToken}`)
        .send({});
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('EMAIL_NOT_VERIFIED');
      // reading still works
      expect(
        (
          await http()
            .get('/api/auth/me')
            .set('Authorization', `Bearer ${s.body.accessToken}`)
        ).status,
      ).toBe(200);
    });
  });

  // ───────────────────────────── no leaks ──────────────────────────────

  it('no endpoint returns password hashes or token fields', async () => {
    const s = await signup({ campus: 'unilag' });
    const auth = { Authorization: `Bearer ${s.body.accessToken}` };
    const uid = s.body.user.id;
    const requests = [
      () => http().get('/api/auth/me').set(auth),
      () => http().get('/api/users/me').set(auth),
      () => http().get('/api/users/me/profile').set(auth),
      () => http().get(`/api/users/${uid}`).set(auth),
      () => http().get('/api/products?limit=50'),
      () => http().get('/api/products/featured'),
      () => http().get('/api/products/recommended').set(auth),
      () => http().get('/api/wishlist').set(auth),
      () => http().get('/api/chat/conversations').set(auth),
      () => http().get('/api/notifications').set(auth),
      () =>
        http()
          .patch('/api/users/me')
          .set(auth)
          .send({ profile: { bio: 'hi' } }),
    ];
    const responses: request.Response[] = [];
    for (const make of requests) responses.push(await make());
    for (const r of responses) {
      expect(r.status).toBeLessThan(500);
      assertNoSecrets(r.body);
    }
    // the bodies really did contain user objects
    expect(responses[0].body.id).toBe(uid);
  });
});
