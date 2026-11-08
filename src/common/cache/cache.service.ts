import { Injectable } from '@nestjs/common';

interface Entry {
  value: unknown;
  expiresAt: number;
}

/** Deep-freezes cached values in tests so accidental mutation fails loudly. */
function freeze<T>(v: T): T {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) freeze((v as Record<string, unknown>)[k]);
  }
  return v;
}

export const CACHE_TTL = {
  categories: 5 * 60_000,
  categoryCounts: 60_000,
  schools: 10 * 60_000,
  publicFeed: 30_000,
  suggestions: 60_000,
  item: 30_000,
  bootstrapStatic: 60_000,
  /** Per-user ranked feed candidates (pagination, bootstrap + feed). */
  feedPool: 30_000,
} as const;

/**
 * Small in-process TTL cache for hot, mostly-static reads (categories,
 * schools, the anonymous first feed page, search suggestions, popular items).
 *
 *  - wrap() de-duplicates concurrent misses (one DB query per key, not 50)
 *  - bounded (LRU-ish eviction) so it can't grow without limit
 *  - writes invalidate by key or prefix; with several instances the short
 *    TTLs bound staleness (at most 30-60 s for listings)
 *
 * Cached values are shared between requests: treat them as read-only.
 */
@Injectable()
export class CacheService {
  private readonly store = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly max = Number(process.env.CACHE_MAX_ENTRIES || 5000);
  private readonly freezeValues = process.env.NODE_ENV === 'test';
  private hits = 0;
  private misses = 0;
  private disabled = process.env.CACHE_DISABLED === 'true';

  get<T>(key: string): T | undefined {
    if (this.disabled) return undefined;
    const e = this.store.get(key);
    if (!e) return undefined;
    if (e.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    // refresh recency
    this.store.delete(key);
    this.store.set(key, e);
    return e.value as T;
  }

  set<T>(key: string, value: T, ttlMs: number): T {
    if (this.disabled) return value;
    if (this.freezeValues) freeze(value);
    this.store.delete(key);
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
    while (this.store.size > this.max) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      this.store.delete(oldest);
    }
    return value;
  }

  async wrap<T>(
    key: string,
    ttlMs: number,
    load: () => Promise<T>,
  ): Promise<T> {
    const hit = this.get<T>(key);
    if (hit !== undefined) {
      this.hits++;
      return hit;
    }
    this.misses++;
    const pending = this.inflight.get(key) as Promise<T> | undefined;
    if (pending) return pending;
    const p = load()
      .then((v) => this.set(key, v, ttlMs))
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  del(key: string): void {
    this.store.delete(key);
  }

  delPrefix(prefix: string): void {
    for (const k of this.store.keys())
      if (k.startsWith(prefix)) this.store.delete(k);
  }

  clear(): void {
    this.store.clear();
  }

  setDisabled(disabled: boolean): void {
    this.disabled = disabled;
    if (disabled) this.store.clear();
  }

  stats() {
    return { entries: this.store.size, hits: this.hits, misses: this.misses };
  }
}

/** Cache key prefixes, so writers know what to invalidate. */
export const CK = {
  categories: 'categories:',
  schools: 'schools:',
  list: 'list:',
  item: (id: string) => `item:${id}`,
  suggest: 'suggest:',
  bootstrap: 'bootstrap:',
  feed: (userId: string) => `feed:${userId}:`,
} as const;
