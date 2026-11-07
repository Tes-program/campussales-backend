import { validateEnv } from './env.validation';

describe('validateEnv', () => {
  const base = { NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(40) };

  it('fails production startup without FRONTEND_URL', () => {
    expect(() => validateEnv({ ...base })).toThrow(/FRONTEND_URL is required/);
  });
  it('requires https and no path', () => {
    expect(() =>
      validateEnv({
        ...base,
        FRONTEND_URL: 'http://campus-sales.onrender.com',
      }),
    ).toThrow(/https/);
    expect(() =>
      validateEnv({ ...base, FRONTEND_URL: 'https://x.com/app' }),
    ).toThrow(/no path/);
  });
  it('accepts the production frontend', () => {
    expect(() =>
      validateEnv({
        ...base,
        FRONTEND_URL: 'https://campus-sales.onrender.com',
      }),
    ).not.toThrow();
  });
  it('requires JWT_SECRET in production', () => {
    expect(() =>
      validateEnv({
        NODE_ENV: 'production',
        FRONTEND_URL: 'https://campus-sales.onrender.com',
      }),
    ).toThrow(/JWT_SECRET/);
  });
  it('does nothing outside production', () => {
    expect(() => validateEnv({ NODE_ENV: 'development' })).not.toThrow();
  });
});
