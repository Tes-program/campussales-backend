// Recreates the local test database and builds it by running the real
// migrations (so the migrations themselves are exercised), then seeds the
// reference data from code.
import { Client } from 'pg';
import { assertSafeTestDatabase } from './env';

export default async function globalSetup() {
  assertSafeTestDatabase();
  const name = process.env.DATABASE_NAME as string;
  const admin = new Client({
    host: process.env.DATABASE_HOST || 'localhost',
    port: parseInt(process.env.DATABASE_PORT || '5432', 10),
    user: process.env.DATABASE_USERNAME || 'postgres',
    password: process.env.DATABASE_PASSWORD || '',
    database: 'postgres',
  });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();

  // Required lazily so env.ts has set DATABASE_NAME before the data source reads it.
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { AppDataSource } = require('../../src/database/data-source');
  const {
    syncCategories,
    syncSchools,
  } = require('../../src/database/seeds/reference-data');
  /* eslint-enable @typescript-eslint/no-require-imports */
  await AppDataSource.initialize();
  try {
    await AppDataSource.runMigrations({ transaction: 'each' });
    await syncCategories(AppDataSource);
    await syncSchools(AppDataSource);
  } finally {
    await AppDataSource.destroy();
  }

  // Fresh rate-limit counters for this run.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Redis } = require('ioredis');
  const redis = new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: Number(process.env.REDIS_PORT || 6379),
    password: process.env.REDIS_PASSWORD || undefined,
    lazyConnect: true,
  });
  try {
    await redis.connect();
    const keys: string[] = await redis.keys('cs:test:*');
    if (keys.length) await redis.del(...keys);
  } catch {
    // Redis down: the service falls back to memory, nothing to clear.
  } finally {
    redis.disconnect();
  }
}
