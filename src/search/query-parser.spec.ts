import {
  buildTsQuery,
  isProtected,
  normaliseQuery,
  tokenise,
} from './query-parser';
import { decodeCursor, encodeCursor } from '../products/dto/list-products.dto';

describe('query parser', () => {
  it('normalises case, accents, punctuation and spaces', () => {
    expect(normaliseQuery('  iPhone!!   13  ')).toBe('iphone 13');
    expect(normaliseQuery('Àgbà   chair')).toBe('agba chair');
  });
  it('keeps short words (fan, ac)', () => {
    expect(tokenise('fan ac')).toEqual(['fan', 'ac']);
  });
  it('maps synonyms and prefix-matches the last word', () => {
    expect(buildTsQuery(['fone', 'case'])).toBe('(phone) & (case:*)');
    expect(buildTsQuery(['ac'])).toBe('(ac:* | (air <-> conditioner))');
  });
  it('protects kept words, numbers and short words from correction', () => {
    expect(isProtected('tokunbo')).toBe(true);
    expect(isProtected('ps5')).toBe(true);
    expect(isProtected('tv')).toBe(true);
    expect(isProtected('laptpo')).toBe(false);
  });
  it('returns null when nothing is searchable', () => {
    expect(buildTsQuery([])).toBeNull();
  });
});

describe('cursor', () => {
  it('round-trips and rejects tampering', () => {
    const c = {
      s: 'newest' as const,
      c: '2026-11-07T10:00:00.123456',
      i: '9f1e6a2c-3b4d-4e5f-8a9b-0c1d2e3f4a5b',
    };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
    expect(decodeCursor('junk')).toBeNull();
    expect(
      decodeCursor(encodeCursor({ s: 'newest', c: "x'; drop", i: c.i })),
    ).toBeNull();
    expect(decodeCursor(encodeCursor({ s: 'relevance', o: -1 }))).toBeNull();
  });
});
