import { sanitize } from './sanitize.interceptor';

describe('sanitize', () => {
  it('removes password-like keys and internal flags at any depth', () => {
    const date = new Date();
    const out = sanitize({
      id: 1,
      passwordHash: 'x',
      password: 'y',
      tokensValidAfter: date,
      seller: {
        passwordHash: 'z',
        profile: { firstName: 'A', newPassword: 'q' },
      },
      list: [{ tokenHash: 'h', ok: true }],
      createdAt: date,
    });
    expect(out).toEqual({
      id: 1,
      seller: { profile: { firstName: 'A' } },
      list: [{ ok: true }],
      createdAt: date,
    });
  });

  it('survives cycles', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    expect(sanitize(a)).toEqual({ name: 'a', self: undefined });
  });
});
