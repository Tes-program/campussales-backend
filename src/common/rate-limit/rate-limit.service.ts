import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'crypto';
import { Redis } from 'ioredis';

/**
 * Sliding-window counters for abuse limits (login attempts, reset emails...).
 *
 * Uses Redis sorted sets so limits hold across API instances. If Redis is
 * unreachable it falls back to process memory and logs a warning: limits then
 * apply per instance, which is weaker but never blocks students.
 *
 * Keys are hashed, so emails and IPs never appear in Redis in clear text.
 */
@Injectable()
export class RateLimitService implements OnModuleDestroy {
  private readonly logger = new Logger(RateLimitService.name);
  private readonly prefix: string;
  private redis: Redis | null = null;
  private redisDown = false;
  private readonly memory = new Map<string, number[]>();
  private readonly fixed = new Map<string, number>();

  constructor(config: ConfigService) {
    this.prefix = `cs:${config.get('NODE_ENV') || 'development'}:rl:`;
    if (config.get('RATE_LIMIT_STORE') === 'memory') return;
    this.redis = new Redis({
      host: config.get<string>('REDIS_HOST', 'localhost'),
      port: Number(config.get('REDIS_PORT', 6379)),
      password: config.get<string>('REDIS_PASSWORD') || undefined,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    this.redis.on('error', (e: Error) => {
      if (!this.redisDown) {
        this.logger.warn(
          `Redis unavailable, using in-memory limits: ${e.message}`,
        );
      }
      this.redisDown = true;
    });
    this.redis.on('ready', () => (this.redisDown = false));
    this.redis.connect().catch(() => (this.redisDown = true));
  }

  async onModuleDestroy() {
    await this.redis?.quit().catch(() => undefined);
  }

  /** Stable, non-reversible key part for emails, IPs, user ids. */
  static key(...parts: string[]): string {
    return createHash('sha256')
      .update(parts.join('|').toLowerCase())
      .digest('hex')
      .slice(0, 32);
  }

  /** Records one event and returns the count inside the window (including it). */
  async hit(key: string, windowMs: number): Promise<number> {
    const now = Date.now();
    const k = this.prefix + key;
    if (this.useRedis()) {
      try {
        const res = await this.redis!.multi()
          .zremrangebyscore(k, 0, now - windowMs)
          .zadd(k, now, `${now}:${randomUUID()}`)
          .zcard(k)
          .pexpire(k, windowMs)
          .exec();
        return Number(res?.[2]?.[1] ?? 0);
      } catch {
        this.redisDown = true;
      }
    }
    const list = this.prune(k, windowMs, now);
    list.push(now);
    this.memory.set(k, list);
    return list.length;
  }

  /** Events inside the window, oldest first (epoch ms). */
  async events(key: string, windowMs: number): Promise<number[]> {
    const now = Date.now();
    const k = this.prefix + key;
    if (this.useRedis()) {
      try {
        await this.redis!.zremrangebyscore(k, 0, now - windowMs);
        const members = await this.redis!.zrange(k, 0, -1, 'WITHSCORES');
        const out: number[] = [];
        for (let i = 1; i < members.length; i += 2)
          out.push(Number(members[i]));
        return out;
      } catch {
        this.redisDown = true;
      }
    }
    return this.prune(k, windowMs, now);
  }

  /**
   * Fixed-window counter: one Redis round trip (INCR + PEXPIRE). Used by the
   * global per-minute limiter, where the sliding window's precision isn't
   * worth a second round trip on every request.
   */
  async fixedWindow(
    key: string,
    limit: number,
    windowMs: number,
  ): Promise<{ allowed: boolean; count: number; retryAfterSeconds: number }> {
    const now = Date.now();
    const windowStart = Math.floor(now / windowMs) * windowMs;
    const k = `${this.prefix}${key}:${windowStart}`;
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((windowStart + windowMs - now) / 1000),
    );
    let count: number | null = null;
    if (this.useRedis()) {
      try {
        const res = await this.redis!.multi()
          .incr(k)
          .pexpire(k, windowMs)
          .exec();
        count = Number(res?.[0]?.[1] ?? 0);
      } catch {
        this.redisDown = true;
      }
    }
    if (count === null) {
      const entry = this.fixed.get(k);
      count = (entry ?? 0) + 1;
      this.fixed.set(k, count);
      if (this.fixed.size > 50_000) this.pruneFixed(now, windowMs);
    }
    return { allowed: count <= limit, count, retryAfterSeconds };
  }

  redisHealthy(): boolean {
    return this.useRedis();
  }

  private pruneFixed(now: number, windowMs: number) {
    for (const k of this.fixed.keys()) {
      const start = Number(k.slice(k.lastIndexOf(':') + 1));
      if (start + windowMs < now) this.fixed.delete(k);
    }
  }

  async reset(key: string): Promise<void> {
    const k = this.prefix + key;
    this.memory.delete(k);
    if (this.useRedis()) await this.redis!.del(k).catch(() => undefined);
  }

  /**
   * Convenience: counts an event and says whether it is over `limit`. When it
   * is, `retryAfterSeconds` is when the oldest event leaves the window.
   */
  async consume(
    key: string,
    limit: number,
    windowMs: number,
  ): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
    const existing = await this.events(key, windowMs);
    if (existing.length >= limit) {
      const retry =
        (existing[existing.length - limit] + windowMs - Date.now()) / 1000;
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil(retry)),
      };
    }
    await this.hit(key, windowMs);
    return { allowed: true, retryAfterSeconds: 0 };
  }

  private useRedis(): boolean {
    return !!this.redis && !this.redisDown;
  }

  private prune(k: string, windowMs: number, now: number): number[] {
    const list = (this.memory.get(k) ?? []).filter((t) => t > now - windowMs);
    this.memory.set(k, list);
    return list;
  }
}
