// Loaded before every e2e test file and by global-setup. Points the app at a
// throwaway local database. dotenv never overrides variables already set here.
process.env.NODE_ENV = 'test';
process.env.DATABASE_NAME = process.env.E2E_DATABASE_NAME || 'campussales_test';
process.env.CLOUDINARY_CLOUD_NAME = 'campussales-test';
process.env.STORAGE_TYPE = 'cloudinary';
process.env.FRONTEND_URL = 'https://campus-sales.test';
// Lets tests vary the client IP with X-Forwarded-For.
process.env.TRUST_PROXY = '1';
process.env.AUTH_ROTATION_GRACE_MS = '0';
// Fixtures create many listings per seller; the B4 spam test restores the defaults.
process.env.MODERATION_SPAM_PER_HOUR = '100000';
process.env.MODERATION_SPAM_PER_DAY = '100000';
// Never send real email from tests.
process.env.EMAIL_USER = '';
process.env.EMAIL_PASSWORD = '';
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('dotenv').config({ quiet: true });
process.env.JWT_SECRET = process.env.JWT_SECRET || 'e2e-secret';

export function assertSafeTestDatabase() {
  const host = process.env.DATABASE_HOST || 'localhost';
  const name = process.env.DATABASE_NAME || '';
  if (
    !['localhost', '127.0.0.1', '::1'].includes(host) ||
    !name.endsWith('_test')
  ) {
    throw new Error(
      `Refusing to run e2e tests against ${host}/${name}: only local *_test databases are allowed.`,
    );
  }
}
// B5: tests make hundreds of requests from one IP; rate-limit tests lower this.
process.env.RATE_LIMIT_SCALE = process.env.RATE_LIMIT_SCALE || '1000';
process.env.CLOUDINARY_API_KEY = 'test-key';
process.env.CLOUDINARY_API_SECRET = 'test-secret';
