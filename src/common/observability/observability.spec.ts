import { MetricsRegistry, METRIC } from './metrics';
import { hashUserId, redact } from './redact';
import { evaluateAlerts } from '../../health/alerts.service';
import { CacheService } from '../cache/cache.service';
import {
  parseCloudinaryUrl,
  cloudinaryUrl,
} from '../../uploads/cloudinary-url';
import { featureFlags } from '../../bootstrap/feature-flags';

describe('redact', () => {
  it('masks tokens, bearer headers, reset links and emails', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop';
    const out = redact(
      `token=abc123 Bearer ${jwt} https://x.ng/reset-password?token=zzz ada@unilag.edu.ng {"password":"hunter2"}`,
    );
    expect(out).not.toMatch(/abc123|hunter2|zzz|ada@|eyJhbGci/);
    expect(out).toContain('[email]');
  });
  it('hashes user ids stably without revealing them', () => {
    expect(hashUserId('u1')).toBe(hashUserId('u1'));
    expect(hashUserId('u1')).not.toContain('u1');
    expect(hashUserId(undefined)).toBeUndefined();
  });
});

describe('metrics + alerts', () => {
  const now = Date.now();
  const fill = (m: MetricsRegistry, n: number, status: number, ms: number) => {
    for (let i = 0; i < n; i++)
      m.record({
        at: now - 1000,
        route: 'GET /api/products',
        status,
        ms,
        dbMs: 1,
        bytes: 10,
      });
  };
  const healthy = { dbFailures: 0, poolSaturatedStreak: 0, pool: null };

  it('computes per-route percentiles', () => {
    const m = new MetricsRegistry();
    for (let i = 1; i <= 100; i++)
      m.record({
        at: now,
        route: 'GET /x',
        status: 200,
        ms: i,
        dbMs: 0,
        bytes: 0,
      });
    const [r] = m.byRoute(60_000, now);
    expect([r.p50, r.p95, r.p99]).toEqual([50, 95, 99]);
  });
  it('fires on >2% errors over 5 minutes, not on tiny samples', () => {
    const m = new MetricsRegistry();
    fill(m, 5, 500, 10);
    expect(evaluateAlerts(m, healthy, now)).toEqual([]);
    fill(m, 95, 200, 10);
    expect(evaluateAlerts(m, healthy, now).map((a) => a.key)).toContain(
      'error_rate',
    );
  });
  it('fires on p95 over 1 s, db down, pool saturation and email failures', () => {
    const m = new MetricsRegistry();
    fill(m, 100, 200, 1500);
    for (let i = 0; i < 3; i++) m.count(METRIC.emailFailed, now);
    const keys = evaluateAlerts(
      m,
      {
        dbFailures: 2,
        poolSaturatedStreak: 3,
        pool: { max: 20, total: 20, idle: 0, waiting: 5 },
      },
      now,
    ).map((a) => a.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        'latency_p95',
        'db_down',
        'db_pool_saturated',
        'email_failures',
      ]),
    );
  });
});

describe('CacheService', () => {
  it('loads once for concurrent misses and invalidates by prefix', async () => {
    const c = new CacheService();
    let loads = 0;
    const load = () =>
      new Promise<number>((r) => setTimeout(() => r(++loads), 5));
    const [a, b] = await Promise.all([
      c.wrap('list:a', 1000, load),
      c.wrap('list:a', 1000, load),
    ]);
    expect([a, b, loads]).toEqual([1, 1, 1]);
    expect(await c.wrap('list:a', 1000, load)).toBe(1);
    c.delPrefix('list:');
    expect(await c.wrap('list:a', 1000, load)).toBe(2);
  });
  it('freezes values in tests so shared cached objects cannot be mutated', async () => {
    const c = new CacheService();
    const v = await c.wrap('k', 1000, () =>
      Promise.resolve({ items: [{ id: 1 }] }),
    );
    expect(() => {
      (v.items[0] as { id: number }).id = 2;
    }).toThrow();
  });
  it('expires entries', async () => {
    const c = new CacheService();
    c.set('k', 1, 1);
    await new Promise((r) => setTimeout(r, 5));
    expect(c.get('k')).toBeUndefined();
  });
});

describe('cloudinary urls', () => {
  it('parses public id and version and builds responsive urls', () => {
    const ref = parseCloudinaryUrl(
      'https://res.cloudinary.com/cs/image/upload/c_limit,w_1200/v1712/campussales/products/abc.jpg',
    );
    expect(ref).toEqual({
      cloudName: 'cs',
      version: 1712,
      publicId: 'campussales/products/abc',
      format: 'jpg',
    });
    expect(
      cloudinaryUrl('cs', 'campussales/products/abc', 1712, { width: 400 }),
    ).toBe(
      'https://res.cloudinary.com/cs/image/upload/f_auto,q_auto,c_limit,w_400/v1712/campussales/products/abc',
    );
    expect(parseCloudinaryUrl('https://example.com/a.jpg')).toBeNull();
  });
});

describe('feature flags', () => {
  it('uses defaults and only accepts known boolean overrides', () => {
    expect(featureFlags(undefined).bootstrap).toBe(true);
    const f = featureFlags(
      '{"signedUploads":false,"madeUp":true,"analytics":"no"}',
    );
    expect(f.signedUploads).toBe(false);
    expect(f.analytics).toBe(true);
    expect('madeUp' in f).toBe(false);
    expect(featureFlags('{oops').bootstrap).toBe(true);
  });
});
