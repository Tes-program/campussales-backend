// npm run seed:categories — idempotent: inserts missing categories only.
import { AppDataSource } from '../data-source';
import { syncCategories } from './reference-data';

async function main() {
  const o = AppDataSource.options as { host?: string; database?: string };
  console.log(`Seeding categories into ${o.host}/${o.database}`);
  await AppDataSource.initialize();
  try {
    const { inserted } = await syncCategories(AppDataSource);
    console.log(
      inserted.length
        ? `Inserted: ${inserted.join(', ')}`
        : 'Nothing to insert.',
    );
  } finally {
    await AppDataSource.destroy();
  }
}

main().catch((e) => {
  console.error('Failed to seed categories:', e);
  process.exit(1);
});
