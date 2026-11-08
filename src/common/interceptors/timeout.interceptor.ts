import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, throwError, TimeoutError } from 'rxjs';
import { catchError, timeout } from 'rxjs/operators';
import { AppError } from '../errors/app-errors';
import { ErrorCode } from '../errors/error-codes';

export const REQUEST_TIMEOUT_KEY = 'requestTimeoutMs';

/** Longer budget for a route that legitimately needs it (legacy multipart uploads). */
export const RequestTimeout = (ms: number) =>
  SetMetadata(REQUEST_TIMEOUT_KEY, ms);

export function defaultTimeoutMs(): number {
  const v = Number(process.env.REQUEST_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 15_000;
}

/**
 * Every HTTP request gets 15 seconds (REQUEST_TIMEOUT_MS). After that the
 * client gets 504 TIMEOUT in the standard error shape instead of hanging;
 * Postgres statement_timeout (database.config.ts) stops the query too.
 */
@Injectable()
export class TimeoutInterceptor implements NestInterceptor {
  constructor(private readonly reflector?: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const ms =
      this.reflector?.getAllAndOverride<number>(REQUEST_TIMEOUT_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? defaultTimeoutMs();
    return next.handle().pipe(
      timeout(ms),
      catchError((err: unknown) =>
        throwError(() =>
          err instanceof TimeoutError ? new AppError(ErrorCode.TIMEOUT) : err,
        ),
      ),
    );
  }
}
