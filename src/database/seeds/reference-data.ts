/**
 * Idempotent sync of reference data from code into the database.
 * Only INSERTs missing rows and fills empty columns. Never deletes, renames or
 * deactivates anything, so it is safe to run repeatedly against production.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { DataSource, ILike, In } from 'typeorm';
import {
  CATEGORIES,
  categorySlugVariants,
} from '../../common/constants/categories';
import { Category } from '../../products/entities/category.entity';
import { University } from '../../users/entities/university.entity';

export interface SchoolSeed {
  shortName: string;
  name: string;
  city: string | null;
  state: string | null;
}

export function loadSchoolsFile(
  path = join(process.cwd(), 'data', 'schools.json'),
): SchoolSeed[] {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
    schools: SchoolSeed[];
  };
  const seen = new Set<string>();
  for (const s of parsed.schools) {
    const key = s.shortName.toUpperCase();
    if (seen.has(key))
      throw new Error(`Duplicate shortName in schools.json: ${s.shortName}`);
    seen.add(key);
  }
  return parsed.schools;
}

export async function syncCategories(
  ds: DataSource,
): Promise<{ inserted: string[] }> {
  const repo = ds.getRepository(Category);
  const inserted: string[] = [];
  for (const c of CATEGORIES) {
    // A row with the slug or any alias counts as present (older databases).
    const existing = await repo.findOne({
      where: { slug: In(categorySlugVariants(c.slug)) },
    });
    if (existing) continue;
    await repo.save(
      repo.create({
        slug: c.slug,
        name: c.name,
        description: c.description,
        iconUrl: c.icon,
        isActive: true,
      }),
    );
    inserted.push(c.slug);
  }
  return { inserted };
}

export async function syncSchools(
  ds: DataSource,
  schools: SchoolSeed[] = loadSchoolsFile(),
): Promise<{ inserted: string[]; updated: string[] }> {
  const repo = ds.getRepository(University);
  const inserted: string[] = [];
  const updated: string[] = [];
  for (const s of schools) {
    const location = [s.city, s.state].filter(Boolean).join(', ') || null;
    let row =
      (await repo.findOne({ where: { code: ILike(s.shortName) } })) ??
      (await repo.findOne({ where: { name: ILike(s.name) } }));
    if (!row) {
      await repo.save(
        repo.create({
          name: s.name,
          code: s.shortName,
          city: s.city,
          location: location ?? undefined,
          isActive: true,
        }),
      );
      inserted.push(s.shortName);
      continue;
    }
    let changed = false;
    if (!row.code) {
      row.code = s.shortName;
      changed = true;
    }
    if (!row.city && s.city) {
      row.city = s.city;
      changed = true;
    }
    if (!row.location && location) {
      row.location = location;
      changed = true;
    }
    if (changed) {
      row = await repo.save(row);
      updated.push(s.shortName);
    }
  }
  return { inserted, updated };
}
