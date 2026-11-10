import { NextFunction, Request, Response } from 'express';
import { writeJson } from './json-logger';
import { metrics, METRIC } from './metrics';
import { elapsedMs, newContext, runWithContext } from './request-context';
import { hashUserId } from './redact';

const round = (v: number) => Math.round(v * 10) / 10;

/** Route template, never the raw URL: query strings can hold tokens or emails. */
export function routeLabel(req: Request): string {
  const route = (req as Request & { route?: { path?: string } }).route;
  if (route?.path) return `${req.method} ${req.baseUrl || ''}${route.path}`;
  return `${req.method} (unmatched)`;
}

/**
 * Failed signups/onboarding submits feed the signup alert. 409 (email taken)
 * and 429 (rate limited) are normal; validation errors are counted because a
 * frontend regression shows up as a wave of them.
 */
function countBusinessFailure(route: string, status: number) {
  if (status < 400 || status === 409 || status === 429) return;
  if (/^POST \/api\/auth\/(signup|register)$/.test(route))
    metrics.count(METRIC.signupFailed);
  else if (/^(POST|PATCH|PUT) \/api\/users\/.*onboarding/.test(route))
    metrics.count(METRIC.onboardingFailed);
}

/** LOG_REQUESTS, default on outside tests. Shared with chat.send logs. */
export function logRequests(): boolean {
  const v = process.env.LOG_REQUESTS;
  if (v !== undefined) return v === 'true';
  return process.env.NODE_ENV !== 'test';
}

/**
 * Times every request. On finish it records a metrics sample and writes one
 * structured log line: route, status, duration, database time, query count,
 * response size (bytes on the wire) and the hashed user id.
 *
 * Outside production it also sends Server-Timing (db, app, total) and
 * X-Query-Count so the frontend team can see where time goes in DevTools.
 */
export function timingMiddleware(
  req: Request & { requestId?: string; user?: { id?: string } },
  res: Response,
  next: NextFunction,
) {
  const ctx = newContext(req.requestId);
  let bytes = 0;

  const write = res.write.bind(res) as Response['write'];
  const end = res.end.bind(res) as Response['end'];
  const size = (chunk: unknown, encoding?: unknown) =>
    chunk == null || typeof chunk === 'function'
      ? 0
      : typeof chunk !== 'string'
        ? ((chunk as { length?: number }).length ?? 0)
        : Buffer.byteLength(
            chunk,
            typeof encoding === 'string'
              ? (encoding as BufferEncoding)
              : undefined,
          );
  res.write = ((chunk: unknown, ...rest: unknown[]) => {
    bytes += size(chunk, rest[0]);
    return (write as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as Response['write'];
  res.end = ((chunk?: unknown, ...rest: unknown[]) => {
    bytes += size(chunk, rest[0]);
    return (end as (...a: unknown[]) => Response)(chunk, ...rest);
  }) as Response['end'];

  if (process.env.NODE_ENV !== 'production') {
    const writeHead = res.writeHead.bind(res) as Response['writeHead'];
    res.writeHead = ((...args: Parameters<Response['writeHead']>) => {
      if (!res.headersSent) {
        const total = elapsedMs(ctx);
        res.setHeader('X-Query-Count', String(ctx.queries));
        res.setHeader('Timing-Allow-Origin', '*');
        res.setHeader(
          'Server-Timing',
          `db;dur=${round(ctx.dbMs)};desc="${ctx.queries} queries", app;dur=${round(Math.max(0, total - ctx.dbMs))}, total;dur=${round(total)}`,
        );
      }
      return writeHead(...args);
    }) as Response['writeHead'];
  }

  res.on('finish', () => {
    const ms = elapsedMs(ctx);
    const route = routeLabel(req);
    const userId = ctx.userId ?? req.user?.id;
    metrics.record({
      at: Date.now(),
      route,
      status: res.statusCode,
      ms,
      dbMs: ctx.dbMs,
      bytes,
    });
    countBusinessFailure(route, res.statusCode);
    if (!logRequests() || route.endsWith('/health')) return;
    writeJson(
      res.statusCode >= 500 ? 'error' : 'info',
      'request',
      {
        ...(ctx.requestId ? { requestId: ctx.requestId } : {}),
        method: req.method,
        route,
        status: res.statusCode,
        durationMs: round(ms),
        dbMs: round(ctx.dbMs),
        queries: ctx.queries,
        bytes,
        ...(userId ? { user: hashUserId(userId) } : {}),
      },
      'HTTP',
    );
  });

  runWithContext(ctx, () => next());
}
