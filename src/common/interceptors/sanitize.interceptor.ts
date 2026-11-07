import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

/**
 * Last line of defence: strips secrets and internal flags from EVERY response
 * body, however deeply nested (users inside products inside wishlists...).
 * Services should not return these in the first place; this makes sure a
 * future endpoint can't leak them by accident.
 */
const SENSITIVE_KEY =
  /password|^tokenHash$|^tokensValidAfter$|^resetToken$|^verificationToken$/i;

export function sanitize(
  value: unknown,
  seen = new WeakSet<object>(),
): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date || Buffer.isBuffer(value)) return value;
  if (seen.has(value)) return undefined; // break cycles
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => sanitize(v, seen));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY.test(k)) continue;
    out[k] = sanitize(v, seen);
  }
  return out;
}

@Injectable()
export class SanitizeInterceptor implements NestInterceptor {
  intercept(_ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map((data) => sanitize(data)));
  }
}
