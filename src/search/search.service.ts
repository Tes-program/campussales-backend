import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  CATEGORIES,
  resolveCategorySlug,
} from '../common/constants/categories';
import {
  isProtected,
  normaliseQuery,
  synonyms,
  tokenise,
} from './query-parser';

export interface CorrectedQuery {
  /** Tokens actually searched (after typo correction). */
  tokens: string[];
  /** Corrected query text when at least one word was corrected. */
  didYouMean: string | null;
}

export interface Suggestion {
  type: 'category' | 'title';
  text: string;
  slug?: string;
}

const SUGGEST_TTL_MS = 60_000;
const SUGGEST_CACHE_MAX = 500;
const VOCAB_REFRESH_MS = 10 * 60_000;

@Injectable()
export class SearchService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SearchService.name);
  private readonly suggestCache = new Map<
    string,
    { at: number; value: Suggestion[] }
  >();
  private timer: NodeJS.Timeout | null = null;
  private refreshing: Promise<void> | null = null;
  private dirty = false;

  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => {
      if (this.dirty) void this.refreshVocabulary();
    }, VOCAB_REFRESH_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Call after listings change; the vocabulary is rebuilt on the next tick. */
  markDirty() {
    this.dirty = true;
  }

  /** Rebuilds the word list used for "did you mean". Safe to call concurrently. */
  async refreshVocabulary(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.dirty = false;
    this.refreshing = this.ds
      .query(`REFRESH MATERIALIZED VIEW CONCURRENTLY "search_vocabulary"`)
      .then(() => undefined)
      .catch((e: Error) =>
        this.logger.warn(`Vocabulary refresh failed: ${e.message}`),
      )
      .finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  /**
   * One query: for each word, is it known (exact, prefix of a known word, or
   * same stem)? If not, the closest known word by edit distance / trigram.
   */
  async correct(q: string): Promise<CorrectedQuery> {
    const tokens = tokenise(q);
    // Synonym words ("fone"), protected words and category names are never corrected.
    const candidates = tokens.filter(
      (t) =>
        !isProtected(t) && !resolveCategorySlug(t) && !synonyms().map.has(t),
    );
    if (!candidates.length) return { tokens, didYouMean: null };

    const rows: { tok: string; known: boolean; word: string | null }[] =
      await this.ds.query(
        `SELECT t.tok,
              EXISTS (
                SELECT 1 FROM "search_vocabulary" v
                 WHERE v.word = t.tok
                    OR v.word LIKE t.tok || '%'
                    OR to_tsvector('english', v.word) @@ plainto_tsquery('english', t.tok)
              ) AS known,
              c.word
         FROM unnest($1::text[]) AS t(tok)
         LEFT JOIN LATERAL (
           SELECT v.word FROM "search_vocabulary" v
            WHERE v.word % t.tok
               OR (left(v.word, 1) = left(t.tok, 1)
                   AND abs(length(v.word) - length(t.tok)) <= 2
                   AND levenshtein(v.word, t.tok) <= 2)
            ORDER BY levenshtein(v.word, t.tok), similarity(v.word, t.tok) DESC, v.ndoc DESC
            LIMIT 1
         ) c ON true`,
        [candidates],
      );
    const fixes = new Map<string, string>();
    for (const r of rows) {
      if (!r.known && r.word && r.word !== r.tok) fixes.set(r.tok, r.word);
    }
    if (!fixes.size) return { tokens, didYouMean: null };
    const corrected = tokens.map((t) => fixes.get(t) ?? t);
    return { tokens: corrected, didYouMean: corrected.join(' ') };
  }

  /** Up to 8 suggestions: categories first, then popular live titles. Cached 60s. */
  async suggest(q: string): Promise<Suggestion[]> {
    const key = normaliseQuery(q);
    if (key.length < 2) return [];
    const hit = this.suggestCache.get(key);
    if (hit && Date.now() - hit.at < SUGGEST_TTL_MS) return hit.value;

    const categories: Suggestion[] = CATEGORIES.filter((c) =>
      [c.name, c.slug, ...c.aliases].some((n) => n.toLowerCase().includes(key)),
    )
      .slice(0, 3)
      .map((c) => ({ type: 'category', text: c.name, slug: c.slug }));

    const titles: { title: string }[] = await this.ds.query(
      `SELECT "title" FROM (
         SELECT DISTINCT ON (lower(p."title")) p."title", p."viewCount",
                word_similarity($1, lower(p."title")) AS ws
           FROM "products" p
          WHERE p."status" = 'active' AND p."deletedAt" IS NULL
            AND (lower(p."title") LIKE $2 OR $1 <% lower(p."title"))
          ORDER BY lower(p."title"), p."viewCount" DESC
       ) t
       ORDER BY t.ws DESC, t."viewCount" DESC
       LIMIT $3`,
      [key, `%${key.replace(/[%_\\]/g, '\\$&')}%`, 8 - categories.length],
    );
    const value: Suggestion[] = [
      ...categories,
      ...titles.map((t) => ({ type: 'title' as const, text: t.title })),
    ].slice(0, 8);

    if (this.suggestCache.size >= SUGGEST_CACHE_MAX) {
      const oldest = this.suggestCache.keys().next().value;
      if (oldest !== undefined) this.suggestCache.delete(oldest);
    }
    this.suggestCache.set(key, { at: Date.now(), value });
    return value;
  }

  /** Records a zero-result search. Query text only (no user, no IP). */
  async logMiss(q: string): Promise<void> {
    const text = normaliseQuery(q);
    if (text.length < 2) return;
    await this.ds
      .query(`INSERT INTO "search_misses" ("query") VALUES ($1)`, [text])
      .catch(() => undefined);
  }
}
