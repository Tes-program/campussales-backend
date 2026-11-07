/**
 * Turns what a student typed into search terms. Pure: no database.
 *
 * - lowercases, trims, collapses spaces, strips punctuation
 * - maps synonyms from data/search-synonyms.json ("fone" -> phone)
 * - never drops short words ("fan", "ac" are real searches)
 * - builds a PostgreSQL tsquery: words are AND-ed, synonym alternatives
 *   OR-ed, multi-word alternatives use phrase (<->), and the last word is a
 *   prefix match so results appear while typing.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

interface SynonymFile {
  map: Record<string, string[]>;
  keep: string[];
}

let cached: { map: Map<string, string[]>; keep: Set<string> } | null = null;
export function synonyms() {
  if (!cached) {
    const file = JSON.parse(
      readFileSync(
        join(__dirname, '..', '..', 'data', 'search-synonyms.json'),
        'utf8',
      ),
    ) as SynonymFile;
    cached = {
      map: new Map(
        Object.entries(file.map).map(([k, v]) => [k.toLowerCase(), v]),
      ),
      keep: new Set(file.keep.map((w) => w.toLowerCase())),
    };
  }
  return cached;
}

export const MAX_QUERY_LENGTH = 100;
export const MAX_TOKENS = 8;

export function normaliseQuery(q: string): string {
  return q
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_QUERY_LENGTH);
}

export function tokenise(q: string): string[] {
  return normaliseQuery(q)
    .split(' ')
    .map((t) => t.replace(/^-+|-+$/g, ''))
    .filter(Boolean)
    .slice(0, MAX_TOKENS);
}

/** Tokens we never typo-correct: kept words, numbers, and very short words. */
export function isProtected(token: string): boolean {
  return synonyms().keep.has(token) || token.length < 3 || /\d/.test(token);
}

/** Alternatives for one token (the token itself first unless mapped away). */
export function alternatives(token: string): string[] {
  const mapped = synonyms().map.get(token);
  return mapped && mapped.length ? [...new Set(mapped)] : [token];
}

const lexeme = (w: string) => w.replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * tsquery text for to_tsquery('english', …). Returns null if nothing usable.
 * Example: "fone case" -> "(phone) & (case:*)".
 */
export function buildTsQuery(tokens: string[]): string | null {
  const groups: string[] = [];
  tokens.forEach((token, i) => {
    const last = i === tokens.length - 1;
    const alts = alternatives(token)
      .map((alt) => {
        const words = alt
          .split(/[\s-]+/)
          .map(lexeme)
          .filter(Boolean);
        if (!words.length) return null;
        if (words.length === 1) return last ? `${words[0]}:*` : words[0];
        return `(${words.join(' <-> ')})`;
      })
      .filter((x): x is string => !!x);
    if (alts.length) groups.push(`(${alts.join(' | ')})`);
  });
  return groups.length ? groups.join(' & ') : null;
}
