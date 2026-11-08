import {
  AdvancedConsoleLogger,
  EntitySubscriberInterface,
  EventSubscriber,
  Logger as TypeOrmLogger,
  LoggerOptions,
  QueryRunner,
} from 'typeorm';
import type { AfterQueryEvent } from 'typeorm/subscriber/event/QueryEvent';
import { currentContext } from './observability/request-context';

/**
 * Counts SQL queries and database time per HTTP request (B3 query budget,
 * B5 timing log and Server-Timing). The per-request state lives in
 * observability/request-context.ts and is created by the timing middleware.
 */
export function currentQueryCount(): number | undefined {
  return currentContext()?.queries;
}

@EventSubscriber()
export class QueryTimingSubscriber implements EntitySubscriberInterface {
  afterQuery(event: AfterQueryEvent<unknown>): void {
    const ctx = currentContext();
    if (!ctx) return;
    ctx.queries++;
    if (typeof event.executionTime === 'number')
      ctx.dbMs += event.executionTime;
  }
}

const SLOW_QUERY_MS = Number(process.env.SLOW_QUERY_MS || 500);

/**
 * TypeORM logger: 'advanced-console' behaviour, but slow queries are logged
 * without their parameters (they can hold emails or message text).
 */
export class CountingQueryLogger implements TypeOrmLogger {
  private readonly inner: AdvancedConsoleLogger;
  constructor(options: LoggerOptions) {
    this.inner = new AdvancedConsoleLogger(options);
  }
  logQuery(query: string, parameters?: unknown[], queryRunner?: QueryRunner) {
    this.inner.logQuery(query, parameters, queryRunner);
  }
  logQueryError(
    error: string | Error,
    query: string,
    parameters?: unknown[],
    qr?: QueryRunner,
  ) {
    // Parameters may contain personal data; the query text is enough to debug.
    this.inner.logQueryError(String(error), query, undefined, qr);
  }
  logQuerySlow(time: number, query: string, _p?: unknown[], qr?: QueryRunner) {
    if (time >= SLOW_QUERY_MS)
      this.inner.logQuerySlow(time, query, undefined, qr);
  }
  logSchemaBuild(message: string, qr?: QueryRunner) {
    this.inner.logSchemaBuild(message, qr);
  }
  logMigration(message: string, qr?: QueryRunner) {
    this.inner.logMigration(message, qr);
  }
  log(level: 'log' | 'info' | 'warn', message: unknown, qr?: QueryRunner) {
    this.inner.log(level, message, qr);
  }
}
