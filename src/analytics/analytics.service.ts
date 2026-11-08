import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { metrics, METRIC } from '../common/observability/metrics';
import { onShutdownFlush } from '../common/observability/shutdown';
import { RateLimitService } from '../common/rate-limit/rate-limit.service';
import { ValidEvent } from './event-schema';

export const ANALYTICS_RETENTION_DAYS = 396; // 13 months
const FLUSH_EVERY_MS = 2_000;
const FLUSH_AT = 200;
const BUFFER_MAX = 5_000;

interface Row extends ValidEvent {
  userId: string | null;
}

/**
 * Buffers accepted events in memory and writes them in multi-row INSERTs
 * every 2 s (or every 200 events), so POST /api/events returns 204 without
 * waiting for the database. Flushed on shutdown. If the database is down
 * the buffer is capped and the oldest events are dropped (counted in
 * metrics): analytics must never take the API down with it.
 */
@Injectable()
export class AnalyticsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Analytics');
  private buffer: Row[] = [];
  private timer: NodeJS.Timeout | null = null;
  private retentionTimer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;
  private unregister: (() => void) | null = null;

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly rateLimit: RateLimitService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.flush(), FLUSH_EVERY_MS);
    this.timer.unref();
    this.unregister = onShutdownFlush(() => this.flush());
    if (process.env.NODE_ENV !== 'test') {
      this.retentionTimer = setInterval(
        () => void this.retentionTick(),
        60 * 60_000,
      );
      this.retentionTimer.unref();
    }
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    if (this.retentionTimer) clearInterval(this.retentionTimer);
    this.unregister?.();
    await this.flush();
  }

  enqueue(events: ValidEvent[], userId: string | null): void {
    for (const e of events) this.buffer.push({ ...e, userId });
    if (this.buffer.length > BUFFER_MAX) {
      const drop = this.buffer.length - BUFFER_MAX;
      this.buffer.splice(0, drop);
      for (let i = 0; i < drop; i++) metrics.count(METRIC.eventsDropped);
      this.logger.warn(`Analytics buffer full; dropped ${drop} event(s)`);
    }
    if (this.buffer.length >= FLUSH_AT) void this.flush();
  }

  pending(): number {
    return this.buffer.length;
  }

  async flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    if (!this.buffer.length || !this.ds.isInitialized) return;
    const batch = this.buffer.splice(0, 1000);
    this.flushing = this.write(batch)
      .catch((e) => {
        // Put them back (bounded by enqueue's cap) and retry next tick.
        this.buffer.unshift(...batch);
        if (this.buffer.length > BUFFER_MAX)
          this.buffer.splice(0, this.buffer.length - BUFFER_MAX);
        this.logger.error(`Analytics write failed: ${(e as Error).message}`);
      })
      .finally(() => (this.flushing = null));
    await this.flushing;
    if (this.buffer.length >= FLUSH_AT) await this.flush();
  }

  private async write(rows: Row[]): Promise<void> {
    const params: unknown[] = [];
    const values = rows.map((r, i) => {
      params.push(
        r.name,
        r.occurredAt,
        r.anonId,
        r.userId,
        JSON.stringify(r.props),
      );
      const b = i * 5;
      return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}::jsonb)`;
    });
    await this.ds.query(
      `INSERT INTO "analytics_events" ("name", "occurredAt", "anonId", "userId", "props") VALUES ${values.join(',')}`,
      params,
    );
  }

  private async retentionTick(): Promise<void> {
    const lock = await this.rateLimit.consume(
      RateLimitService.key('daily-job', 'analytics-retention'),
      1,
      24 * 3_600_000,
    );
    if (!lock.allowed) return;
    try {
      const n = await this.purgeExpired();
      if (n)
        this.logger.log(`Deleted ${n} analytics event(s) older than 13 months`);
    } catch (e) {
      this.logger.error(`Analytics retention failed: ${(e as Error).message}`);
    }
  }

  /** Deletes events older than 13 months in batches. Returns the count. */
  async purgeExpired(): Promise<number> {
    let total = 0;
    for (;;) {
      // TypeORM returns [rows, rowCount] for DELETE on Postgres.
      const res = await this.ds.query<[unknown[], number]>(
        `DELETE FROM "analytics_events" WHERE "id" IN (
           SELECT "id" FROM "analytics_events"
            WHERE "receivedAt" < now() - ($1 || ' days')::interval LIMIT 10000)
         RETURNING 1`,
        [String(ANALYTICS_RETENTION_DAYS)],
      );
      const n = Array.isArray(res[0]) ? Number(res[1]) : res.length;
      total += n;
      if (n < 10000) return total;
    }
  }
}
