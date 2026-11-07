import { Injectable } from '@nestjs/common';
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

const CACHE_MS = 60_000;

/**
 * "Schools" are the rows of the universities table, seeded from
 * data/schools.json. This service is the read side used by onboarding and
 * GET /api/schools.
 */
@Injectable()
export class SchoolsService {
  private cache: { at: number; schools: PublicSchool[] } | null = null;

  constructor(
    @InjectRepository(University)
    private readonly universities: Repository<University>,
  ) {}

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
    this.cache = null;
  }

  private async all(): Promise<PublicSchool[]> {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS)
      return this.cache.schools;
    const rows = await this.universities.find({
      where: { isActive: true },
      order: { name: 'ASC' },
    });
    const schools = rows.map((r) => SchoolsService.toPublic(r));
    this.cache = { at: Date.now(), schools };
    return schools;
  }
}
