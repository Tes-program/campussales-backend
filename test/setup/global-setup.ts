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
}
