import { AsyncLocalStorage } from 'async_hooks';
import { NextFunction, Request, Response } from 'express';
import {
  AdvancedConsoleLogger,
  Logger as TypeOrmLogger,
  LoggerOptions,
  QueryRunner,
} from 'typeorm';

/**
 * Counts SQL queries per HTTP request so list endpoints can be held to a
 * budget (B3: <= 5). Outside production the count is sent back as the
 * X-Query-Count header and logged in development.
 */
const store = new AsyncLocalStorage<{ count: number }>();

export function queryCountMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const ctx = { count: 0 };
  store.run(ctx, () => {
    if (process.env.NODE_ENV !== 'production') {
      const writeHead = res.writeHead.bind(res) as Response['writeHead'];
      res.writeHead = ((...args: Parameters<Response['writeHead']>) => {
        if (!res.headersSent) res.setHeader('X-Query-Count', String(ctx.count));
        return writeHead(...args);
      }) as Response['writeHead'];
    }
    next();
  });
}

export function currentQueryCount(): number | undefined {
  return store.getStore()?.count;
}

/** TypeORM logger that counts every query and otherwise behaves like 'advanced-console'. */
export class CountingQueryLogger implements TypeOrmLogger {
  private readonly inner: AdvancedConsoleLogger;
  constructor(options: LoggerOptions) {
    this.inner = new AdvancedConsoleLogger(options);
  }
  logQuery(query: string, parameters?: unknown[], queryRunner?: QueryRunner) {
    const ctx = store.getStore();
    if (ctx) ctx.count++;
    this.inner.logQuery(query, parameters, queryRunner);
  }
  logQueryError(
    error: string | Error,
    query: string,
    parameters?: unknown[],
    qr?: QueryRunner,
  ) {
    this.inner.logQueryError(String(error), query, parameters, qr);
  }
  logQuerySlow(
    time: number,
    query: string,
    parameters?: unknown[],
    qr?: QueryRunner,
  ) {
    this.inner.logQuerySlow(time, query, parameters, qr);
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
