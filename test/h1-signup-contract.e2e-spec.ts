import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { createTestApp } from './setup/app';
import { User } from '../src/users/entities/user.entity';
import { PRIVACY_VERSION, TERMS_VERSION } from '../src/config/legal';

let ipSeq = 1;
const freshIp = () => `10.81.${Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}`;
const PW = 'mango-tree-77';
const uname = (p = 'stu') => `${p}_${randomUUID().slice(0, 8)}`;
const email = () => `h1-${randomUUID().slice(0, 8)}@unilag.edu.ng`;

describe('H1 sign-up contract (e2e)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let http: () => ReturnType<typeof request>;
  let campusId: string;

  beforeAll(async () => {
    ({ app, ds } = await createTestApp());
    http = () => request(app.getHttpServer());
    const schools = await http().get('/api/schools?query=unilag');
    campusId = schools.body[0].id;
  });
  afterAll(() => app.close());
  afterEach(() => delete process.env.AUTH_LEGACY_TOKENS);

  /** Exactly what the live form sends, plus the terms fields. */
  const formBody = (extra: Record<string, unknown> = {}) => ({
    email: email(),
    username: uname(),
    password: PW,
    confirmPassword: PW,
    campus: campusId,
    acceptedTerms: true,
    acceptedTermsVersion: TERMS_VERSION,
    ...extra,
  });
  const post = (body: Record<string, unknown>, path = '/api/auth/signup') =>
    http().post(path).set('X-Forwarded-For', freshIp()).send(body);

  const expectFields = (
    res: request.Response,
    fields: Record<string, string>,
    code = 'VALIDATION_FAILED',
  ) => {
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(code);
    expect(res.body.error.fields).toEqual(fields);
    // Never mention fields the client didn't send, never leak internals.
    expect(JSON.stringify(res.body)).not.toMatch(/"name"|\bname\b/);
    expect(JSON.stringify(res.body)).not.toMatch(/stack|\.ts:|mango-tree/);
  };

  it.each(['/api/auth/signup', '/api/auth/register'])(
    '%s: the form fields plus terms create an account',
    async (path) => {
      const body = formBody({ username: uname('Ada') });
      const res = await post(body, path);
      expect(res.status).toBe(201);
      expect(res.body.user).toMatchObject({
        email: body.email,
        username: body.username,
        fullName: body.username, // name defaults to the username
        signupSchoolId: campusId,
        acceptedTermsVersion: TERMS_VERSION,
        acceptedPrivacyVersion: PRIVACY_VERSION,
      });
      expect(res.body.user.acceptedTermsAt).toBeTruthy();
      expect(JSON.stringify(res.body)).not.toMatch(/mango-tree|passwordHash/);
    },
  );

  it('stores the canonical school id when campus is a name', async () => {
    const res = await post(formBody({ campus: 'University of Lagos' }));
    expect(res.status).toBe(201);
    expect(res.body.user.signupSchoolId).toBe(campusId);
  });

  it('keeps an explicit name', async () => {
    const res = await post(formBody({ name: 'Ada Okafor' }));
    expect(res.status).toBe(201);
    expect(res.body.user.fullName).toBe('Ada Okafor');
  });

  it('old-form payload: one acceptedTerms error, no mention of name', async () => {
    const body = formBody();
    delete (body as Record<string, unknown>).acceptedTerms;
    delete (body as Record<string, unknown>).acceptedTermsVersion;
    const res = await post(body, '/api/auth/register');
    expectFields(res, {
      acceptedTerms: 'Please accept the Terms and Privacy Policy to continue.',
    });
    expect(res.body.error.message).toBe('Please fix the highlighted fields.');
    // Legacy `message` (one release) is a list, never one joined string.
    expect(res.body.message).toEqual([
      'Please accept the Terms and Privacy Policy to continue.',
    ]);
  });

  it('acceptedTerms false is refused', async () => {
    expectFields(await post(formBody({ acceptedTerms: false })), {
      acceptedTerms: 'Please accept the Terms and Privacy Policy to continue.',
    });
  });

  it.each([
    ['missing', undefined],
    ['old', '2020-01-01'],
    ['non-string', 20261101],
  ])(
    '%s terms version: TERMS_VERSION_MISMATCH with current versions',
    async (_l, v) => {
      const res = await post(formBody({ acceptedTermsVersion: v }));
      expectFields(
        res,
        {
          acceptedTermsVersion:
            'We updated our Terms. Please review them and try again.',
        },
        'TERMS_VERSION_MISMATCH',
      );
      expect(res.body.error.message).toBe(
        'We updated our Terms. Please review them and try again.',
      );
      expect(res.body.error.details).toEqual({
        termsVersion: TERMS_VERSION,
        privacyVersion: PRIVACY_VERSION,
        termsUrl: 'https://campus-sales.test/terms',
        privacyUrl: 'https://campus-sales.test/privacy',
      });
      // Retrying with the version from the error succeeds.
      const retry = await post(
        formBody({ acceptedTermsVersion: res.body.error.details.termsVersion }),
      );
      expect(retry.status).toBe(201);
    },
  );

  describe('username', () => {
    it('missing', async () => {
      const body = formBody();
      delete (body as Record<string, unknown>).username;
      expectFields(await post(body), { username: 'Choose a username.' });
      expectFields(await post(formBody({ username: '   ' })), {
        username: 'Choose a username.',
      });
    });

    it.each(['a', 'x'.repeat(31), 'ada okafor', 'ada-okafor', 'adé'])(
      'invalid %p',
      async (username) => {
        expectFields(await post(formBody({ username })), {
          username:
            'Usernames are 2 to 30 letters, numbers, dots or underscores.',
        });
      },
    );

    it('is trimmed and accepts 2 and 30 characters', async () => {
      const two = `q${randomUUID().slice(0, 1)}`;
      await ds.getRepository(User).delete({ username: two });
      const r2 = await post(formBody({ username: `  ${two}  ` }));
      expect(r2.status).toBe(201);
      expect(r2.body.user.username).toBe(two);
      const thirty = `a.b_${randomUUID().replace(/-/g, '').slice(0, 26)}`;
      expect((await post(formBody({ username: thirty }))).status).toBe(201);
    });

    it('duplicate in a different case', async () => {
      const u = uname('Kemi');
      expect((await post(formBody({ username: u }))).status).toBe(201);
      expectFields(await post(formBody({ username: u.toUpperCase() })), {
        username: 'That username is taken. Try another one.',
      });
    });
  });

  it('unknown campus', async () => {
    expectFields(await post(formBody({ campus: 'Hogwarts Polytechnic' })), {
      campus: 'Choose your school from the list.',
    });
    expectFields(await post(formBody({ campus: randomUUID() })), {
      campus: 'Choose your school from the list.',
    });
  });

  it('password: same rule and text as the form', async () => {
    for (const pw of ['abc1', 'abcdefgh']) {
      expectFields(
        await post(formBody({ password: pw, confirmPassword: pw })),
        { password: 'Use at least 8 characters, including a number.' },
      );
    }
    expectFields(await post(formBody({ confirmPassword: 'other-pass-1' })), {
      confirmPassword: "Those passwords don't match.",
    });
  });

  it('several errors at once, all in fields', async () => {
    const res = await post({
      email: 'not-an-email',
      username: 'a',
      password: 'short',
      confirmPassword: 'nope',
      campus: 'Hogwarts Polytechnic',
    });
    expectFields(res, {
      email: 'Enter a valid email address.',
      username: 'Usernames are 2 to 30 letters, numbers, dots or underscores.',
      password: 'Use at least 8 characters, including a number.',
      confirmPassword: "Those passwords don't match.",
      campus: 'Choose your school from the list.',
      acceptedTerms: 'Please accept the Terms and Privacy Policy to continue.',
    });
  });

  it('a version problem alongside others is VALIDATION_FAILED with details', async () => {
    const res = await post(
      formBody({ username: 'a', acceptedTermsVersion: 'old' }),
    );
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(Object.keys(res.body.error.fields).sort()).toEqual([
      'acceptedTermsVersion',
      'username',
    ]);
    expect(res.body.error.details.termsVersion).toBe(TERMS_VERSION);
  });

  it('existing email is still 409', async () => {
    const body = formBody();
    expect((await post(body)).status).toBe(201);
    const res = await post(formBody({ email: body.email }));
    expect(res.status).toBe(409);
    expect(res.body.error.fields).toEqual({
      email: 'An account with this email already exists. Log in instead.',
    });
  });

  it('GET /api/legal/versions is public and cacheable for 5 minutes', async () => {
    const res = await http().get('/api/legal/versions');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      termsVersion: TERMS_VERSION,
      privacyVersion: PRIVACY_VERSION,
      termsUrl: 'https://campus-sales.test/terms',
      privacyUrl: 'https://campus-sales.test/privacy',
    });
    expect(res.headers['cache-control']).toMatch(/public, max-age=300/);
  });
});
