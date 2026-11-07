/**
 * Typo-tolerant, case- and accent-insensitive school matching. Pure function
 * so it can be unit tested without a database.
 */
export interface SearchableSchool {
  id: string;
  name: string;
  shortName: string | null;
  city: string | null;
}

export const SCHOOL_SEARCH_LIMIT = 20;

export function normaliseForSearch(s: string | null | undefined): string {
  return (s ?? '')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Optimal string alignment distance (Levenshtein + adjacent swaps). */
export function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  const d: number[][] = Array.from({ length: m + 1 }, (_, i) => {
    const row = new Array<number>(n + 1).fill(0);
    row[0] = i;
    return row;
  });
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[m][n];
}

const allowedTypos = (len: number) => (len <= 4 ? 1 : len <= 8 ? 2 : 3);

/** 0 = no match; higher is better. */
export function scoreSchool(query: string, school: SearchableSchool): number {
  const q = normaliseForSearch(query);
  if (!q) return 0;
  const short = normaliseForSearch(school.shortName);
  const name = normaliseForSearch(school.name);
  const city = normaliseForSearch(school.city);

  if (short && short === q) return 100;
  if (name === q) return 98;
  if (short && short.startsWith(q)) return 90;
  if (name.startsWith(q)) return 88;

  const qTokens = q.split(' ');
  const targets = [
    ...name.split(' '),
    ...(short ? [short] : []),
    ...(city ? city.split(' ') : []),
  ];

  if (qTokens.every((qt) => targets.some((t) => t.startsWith(qt)))) return 80;
  if (name.includes(q)) return 75;

  let totalTypos = 0;
  for (const qt of qTokens) {
    if (qt.length < 3) {
      if (!targets.some((t) => t.startsWith(qt))) return 0;
      continue;
    }
    let best = Infinity;
    for (const t of targets) {
      // A typo against a word prefix (still typing) ranks a little below a
      // typo against a whole word.
      best = Math.min(
        best,
        editDistance(qt, t),
        editDistance(qt, t.slice(0, qt.length)) + 0.5,
      );
      if (best === 0) break;
    }
    if (best > allowedTypos(qt.length)) return 0;
    totalTypos += best;
  }
  return Math.max(1, 60 - totalTypos * 5);
}

export function searchSchools<T extends SearchableSchool>(
  query: string,
  schools: T[],
  limit = SCHOOL_SEARCH_LIMIT,
): T[] {
  const byName = (a: T, b: T) => a.name.localeCompare(b.name);
  if (!normaliseForSearch(query))
    return [...schools].sort(byName).slice(0, limit);
  return schools
    .map((s) => ({ s, score: scoreSchool(query, s) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || byName(a.s, b.s))
    .slice(0, limit)
    .map((x) => x.s);
}
