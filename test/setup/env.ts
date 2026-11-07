// Loaded before every e2e test file and by global-setup. Points the app at a
// throwaway local database. dotenv never overrides variables already set here.
process.env.NODE_ENV = 'test';
process.env.DATABASE_NAME = process.env.E2E_DATABASE_NAME || 'campussales_test';
process.env.CLOUDINARY_CLOUD_NAME = 'campussales-test';
process.env.STORAGE_TYPE = 'cloudinary';
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
