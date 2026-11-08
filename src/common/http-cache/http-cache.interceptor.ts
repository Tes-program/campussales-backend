import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';

export const PUBLIC_CACHE = 'publicCache';

export interface PublicCacheOptions {
  /** Seconds browsers and CDNs may reuse the response. */
  maxAge: number;
  /** Seconds a stale copy may be shown while revalidating in the background. */
  staleWhileRevalidate?: number;
}

/**
 * Marks an anonymous GET route as publicly cacheable. Only applies when the
 * request carries no Authorization header; logged-in responses (which may
 * include isWishlisted, isOwner...) are always private, no-store.
 */
export const PublicCache = (maxAge: number, staleWhileRevalidate = maxAge) =>
  SetMetadata(PUBLIC_CACHE, { maxAge, staleWhileRevalidate });

/**
 * HTTP caching policy for every GET:
 *  - @PublicCache route + anonymous request: `public, max-age=N,
 *    stale-while-revalidate=M` and `Vary: Authorization`
 *  - everything else: `private, no-store` (personal or not worth caching)
 * A handler that sets Cache-Control itself wins. Express adds a weak ETag to
 * every JSON body and answers If-None-Match with 304, so revalidation of
 * public responses costs no body bytes.
 */
@Injectable()
export class HttpCacheInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest<Request>();
    if (req.method !== 'GET' && req.method !== 'HEAD') return next.handle();
    const res = context.switchToHttp().getResponse<Response>();
    const opts = this.reflector.getAllAndOverride<PublicCacheOptions>(
      PUBLIC_CACHE,
      [context.getHandler(), context.getClass()],
    );
    return next.handle().pipe(
      tap(() => {
        if (res.headersSent || res.getHeader('Cache-Control')) return;
        if (opts && !req.headers.authorization) {
          res.setHeader(
            'Cache-Control',
            `public, max-age=${opts.maxAge}, stale-while-revalidate=${opts.staleWhileRevalidate ?? opts.maxAge}`,
          );
          res.setHeader('Vary', 'Authorization, Accept-Encoding');
        } else {
          res.setHeader('Cache-Control', 'private, no-store');
        }
      }),
    );
  }
}
