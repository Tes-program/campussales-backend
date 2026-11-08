import { AsyncLocalStorage } from 'async_hooks';

/**
 * Per-request state that follows the request through async code (guards,
 * services, TypeORM callbacks) without being passed around: the request id
 * for log lines, and database time/query counts for the timing log and the
 * Server-Timing header.
 */
export interface RequestContext {
  requestId?: string;
  startedAt: bigint;
  queries: number;
  dbMs: number;
  /** Set by the JWT strategy once the user is known (raw id, hashed when logged). */
  userId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function currentContext(): RequestContext | undefined {
  return storage.getStore();
}

export function newContext(requestId?: string): RequestContext {
  return {
    requestId,
    startedAt: process.hrtime.bigint(),
    queries: 0,
    dbMs: 0,
  };
}

export function elapsedMs(ctx: RequestContext): number {
  return Number(process.hrtime.bigint() - ctx.startedAt) / 1e6;
}
