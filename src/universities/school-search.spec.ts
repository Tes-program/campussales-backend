import {
  editDistance,
  searchSchools,
  SCHOOL_SEARCH_LIMIT,
} from './school-search';
import { loadSchoolsFile } from '../database/seeds/reference-data';

const schools = loadSchoolsFile().map((s, i) => ({
  id: String(i),
  name: s.name,
  shortName: s.shortName,
  city: s.city,
}));

const top = (q: string) => searchSchools(q, schools)[0]?.shortName;

describe('school search', () => {
  it('matches short names and names case-insensitively', () => {
    expect(top('unilag')).toBe('UNILAG');
    expect(top('UNILAG')).toBe('UNILAG');
    expect(top('university of lagos')).toBe('UNILAG');
    expect(top('Covenant')).toBe('CU');
  });

  it('tolerates typos', () => {
    expect(top('unilg')).toBe('UNILAG');
    expect(top('univeristy of ibadan')).toBe('UI');
    expect(top('covenent')).toBe('CU');
    expect(top('obafemi awolowo univrsity')).toBe('OAU');
    expect(top('babcok')).toBe('BABCOCK');
  });

  it('matches word prefixes and cities', () => {
    expect(searchSchools('lagos', schools).map((s) => s.shortName)).toEqual(
      expect.arrayContaining(['UNILAG', 'LASU']),
    );
    expect(top('ife')).toBe('OAU');
  });

  it('ignores accents and punctuation', () => {
    expect(top("Redeemer's")).toBe('REDEEMERS');
    expect(top('redeemers')).toBe('REDEEMERS');
  });

  it('returns nothing for nonsense', () => {
    expect(searchSchools('zzzzqqqq', schools)).toEqual([]);
  });

  it(`caps results at ${SCHOOL_SEARCH_LIMIT}`, () => {
    expect(searchSchools('university', schools)).toHaveLength(
      SCHOOL_SEARCH_LIMIT,
    );
    expect(searchSchools('', schools)).toHaveLength(SCHOOL_SEARCH_LIMIT);
  });

  it('edit distance counts swaps as one edit', () => {
    expect(editDistance('ab', 'ba')).toBe(1);
    expect(editDistance('lagos', 'lagos')).toBe(0);
    expect(editDistance('', 'abc')).toBe(3);
  });

  it('schools.json has unique short names', () => {
    expect(new Set(schools.map((s) => s.shortName)).size).toBe(schools.length);
  });
});
