// npm run seed:schools — idempotent sync of data/schools.json into universities.
// Inserts missing schools and fills empty code/city/location. Never deletes or renames.
import { AppDataSource } from '../data-source';
import { syncSchools } from './reference-data';

async function main() {
  const o = AppDataSource.options as { host?: string; database?: string };
  console.log(`Seeding schools into ${o.host}/${o.database}`);
  await AppDataSource.initialize();
  try {
    const { inserted, updated } = await syncSchools(AppDataSource);
    console.log(`Inserted ${inserted.length}: ${inserted.join(', ') || '-'}`);
    console.log(`Updated ${updated.length}: ${updated.join(', ') || '-'}`);
  } finally {
    await AppDataSource.destroy();
  }
}

main().catch((e) => {
  console.error('Failed to seed schools:', e);
  process.exit(1);
});
