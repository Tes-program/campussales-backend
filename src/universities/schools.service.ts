import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { CACHE_TTL, CacheService, CK } from '../common/cache/cache.service';
import { InjectRepository } from '@nestjs/typeorm';
import { isUUID } from 'class-validator';
import { Repository } from 'typeorm';
import { University } from '../users/entities/university.entity';
import {
  normaliseForSearch,
  searchSchools,
  SearchableSchool,
} from './school-search';

export type PublicSchool = SearchableSchool;

/**
 * "Schools" are the rows of the universities table, seeded from
 * data/schools.json. This service is the read side used by onboarding and
 * GET /api/schools.
 */
@Injectable()
export class SchoolsService {
  constructor(
    @InjectRepository(University)
    private readonly universities: Repository<University>,
    private readonly cache: CacheService,
  ) {}

  /**
   * Changes whenever the school list changes, so the frontend can keep its
   * copy (localStorage) and refetch GET /api/schools only on a new version.
   */
  async version(): Promise<{ version: string; count: number }> {
    const { version, schools } = await this.loadAll();
    return { version, count: schools.length };
  }

  static toPublic(u: University): PublicSchool {
    return {
      id: u.id,
      name: u.name,
      shortName: u.code ?? null,
      city: u.city ?? null,
    };
  }

  async search(query: string): Promise<PublicSchool[]> {
    return searchSchools(query ?? '', await this.all());
  }

  /**
   * Resolves an onboarding `school` value: an id, or an exact (case and
   * accent-insensitive) name or short name. Never fuzzy, so a typo can't
   * silently attach a student to the wrong school.
   */
  async resolve(ref: string): Promise<PublicSchool | null> {
    if (isUUID(ref)) {
      const row = await this.universities.findOne({
        where: { id: ref, isActive: true },
      });
      return row ? SchoolsService.toPublic(row) : null;
    }
    const key = normaliseForSearch(ref);
    if (!key) return null;
    return (
      (await this.all()).find(
        (s) =>
          normaliseForSearch(s.name) === key ||
          normaliseForSearch(s.shortName) === key,
      ) ?? null
    );
  }

  clearCache() {
    this.cache.delPrefix(CK.schools);
  }

  private async all(): Promise<PublicSchool[]> {
    return (await this.loadAll()).schools;
  }

  /** The seed script runs in another process, so changes show within 10 minutes. */
  private loadAll(): Promise<{ version: string; schools: PublicSchool[] }> {
    return this.cache.wrap(`${CK.schools}all`, CACHE_TTL.schools, async () => {
      const rows = await this.universities.find({
        where: { isActive: true },
        order: { name: 'ASC' },
      });
      const schools = rows.map((r) => SchoolsService.toPublic(r));
      const version = createHash('sha1')
        .update(JSON.stringify(schools))
        .digest('hex')
        .slice(0, 12);
      return { version, schools };
    });
  }
}
