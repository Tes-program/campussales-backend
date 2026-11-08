import { validateEnv } from './env.validation';

describe('validateEnv', () => {
  const db = {
    DATABASE_HOST: 'db.internal',
    DATABASE_NAME: 'railway',
    DATABASE_USERNAME: 'postgres',
    DATABASE_PASSWORD: 'secret',
  };
  const base = { NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(40), ...db };

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
        ...db,
      }),
    ).toThrow(/JWT_SECRET/);
  });
  it('lists every missing variable at once', () => {
    let message = '';
    try {
      validateEnv({ NODE_ENV: 'production', STORAGE_TYPE: 'cloudinary' });
    } catch (e) {
      message = (e as Error).message;
    }
    for (const name of [
      'FRONTEND_URL',
      'JWT_SECRET',
      'DATABASE_HOST',
      'DATABASE_PASSWORD',
      'CLOUDINARY_API_SECRET',
    ])
      expect(message).toContain(name);
  });
  it('rejects malformed B5 settings', () => {
    const env = {
      ...base,
      FRONTEND_URL: 'https://campus-sales.onrender.com',
      DB_POOL_MAX: 'lots',
      FEATURE_FLAGS: '{bad',
      UPLOAD_CLEANUP_MODE: 'yes',
    };
    expect(() => validateEnv(env)).toThrow(/DB_POOL_MAX/);
    expect(() => validateEnv(env)).toThrow(/FEATURE_FLAGS/);
    expect(() => validateEnv(env)).toThrow(/UPLOAD_CLEANUP_MODE/);
  });
  it('does nothing outside production', () => {
    expect(() => validateEnv({ NODE_ENV: 'development' })).not.toThrow();
  });
});
