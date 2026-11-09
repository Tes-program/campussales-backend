import { INestApplication, Logger } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { createTestApp } from './setup/app';
import { University } from '../src/users/entities/university.entity';
import { LEVELS } from '../src/common/constants/profile';

const URL = '/api/users/onboarding/complete';

describe('H2 onboarding (e2e)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let http: () => ReturnType<typeof request>;
  let unilagId: string;
  let phoneSeq = 1000;
  /** A fresh valid number per test so the "phone taken" rule never interferes. */
  const phone = () => `0807${String(phoneSeq++).padStart(7, '0')}`;

  beforeAll(async () => {
    ctx = await createTestApp();
    ({ app, ds } = ctx);
    http = () => request(app.getHttpServer());
    unilagId = (
      await ds.getRepository(University).findOneByOrFail({ code: 'UNILAG' })
    ).id;
  });
  afterAll(() => app.close());

  /** Exactly what the live frontend sends (src/pages/auth/Onboarding.tsx). */
  const livePayload = (o: Record<string, unknown> = {}) => ({
    firstName: 'Tunde',
    lastName: 'Bello',
    phoneNumber: phone(),
    gender: 'Male',
    universityId: unilagId,
    interests: ['Clothing & Apparel', 'Electronics'],
    ...o,
  });
  const post = (auth: Record<string, string>, body: Record<string, unknown>) =>
    http().post(URL).set(auth).send(body);

  it('the live frontend payload (no level) returns 200 with the saved profile', async () => {
    const { auth } = await ctx.createUser('h2');
    const body = livePayload();
    const res = await post(auth, body);
    expect(res.status).toBe(200);
    expect(res.body.profile).toMatchObject({
      firstName: 'Tunde',
      lastName: 'Bello',
      universityId: unilagId,
      universityName: 'University of Lagos',
      level: null,
      gender: 'Male',
      interests: ['clothing-apparel', 'electronics'],
    });
    expect(res.body.school.id).toBe(unilagId);
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash/);
  });

  it('a valid payload returns 200 twice in a row with the same profile', async () => {
    const { auth } = await ctx.createUser('h2');
    const body = livePayload({ level: '200' });
    const first = await post(auth, body);
    const second = await post(auth, body);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const strip = (p: Record<string, unknown>) => ({ ...p, updatedAt: null });
    expect(strip(second.body.profile)).toEqual(strip(first.body.profile));
    expect(second.body.profile.level).toBe('200');
  });

  it('a repeat without level keeps the level already saved; null clears it', async () => {
    const { auth } = await ctx.createUser('h2');
    const body = livePayload({ level: '400' });
    await post(auth, body).expect(200);
    const again = await post(auth, { ...body, level: undefined });
    expect(again.body.profile.level).toBe('400');
    const cleared = await post(auth, { ...body, level: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.profile.level).toBeNull();
  });

  it('two simultaneous first calls (double tap) both return 200', async () => {
    const { auth } = await ctx.createUser('h2');
    const body = livePayload();
    const [a, b] = await Promise.all([post(auth, body), post(auth, body)]);
    expect([a.status, b.status]).toEqual([200, 200]);
  });

  it('an invalid level returns fields.level and allowedValues', async () => {
    const { auth } = await ctx.createUser('h2');
    const res = await post(auth, livePayload({ level: 'Year 7' }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({
      code: 'VALIDATION_FAILED',
      message: 'Please fix the highlighted fields.',
      fields: { level: 'Level must be 100 to 600, Postgraduate or Alumnus.' },
      details: { allowedValues: { level: [...LEVELS] } },
    });
  });

  it.each([
    [
      'invalid phone',
      { phoneNumber: '123' },
      { phone: 'Enter a valid Nigerian phone number, like 0803 123 4567.' },
    ],
    [
      'unknown universityId',
      { universityId: randomUUID() },
      { school: 'Choose your school from the list.' },
    ],
    [
      'bad interest',
      { interests: ['Spaceships'] },
      { interests: 'Pick interests from the categories list.' },
    ],
  ])('%s returns the matching fields entry', async (_l, o, fields) => {
    const { auth } = await ctx.createUser('h2');
    const res = await post(auth, livePayload(o));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.fields).toEqual(fields);
  });

  it('reports every problem at once, school lookup included', async () => {
    const { auth } = await ctx.createUser('h2');
    const res = await post(
      auth,
      livePayload({
        phoneNumber: '123',
        universityId: randomUUID(),
        interests: ['Spaceships'],
      }),
    );
    expect(Object.keys(res.body.error.fields).sort()).toEqual([
      'interests',
      'phone',
      'school',
    ]);
    expect(res.body.error.details.allowedValues.interests).toContain(
      'electronics',
    );
    // Legacy duplicates kept until 2027-01-31.
    expect(res.body.statusCode).toBe(400);
    expect(res.body.message).toHaveLength(3);
  });

  it('logs the requestId and failing field names, never the values', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn');
    try {
      const { auth } = await ctx.createUser('h2');
      const res = await post(
        auth,
        livePayload({ phoneNumber: '0801-SECRET-99', firstName: 'X' }),
      );
      expect(res.status).toBe(400);
      const line = warn.mock.calls
        .map((c) => String(c[0]))
        .find((l) => l.includes(URL));
      expect(line).toContain(res.body.error.requestId);
      expect(line).toMatch(/fields=(firstName,phone|phone,firstName)/);
      expect(line).not.toMatch(/SECRET|0801/);
    } finally {
      warn.mockRestore();
    }
  });
});
