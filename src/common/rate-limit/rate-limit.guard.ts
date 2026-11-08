import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { rateLimited } from '../errors/app-errors';
import {
  RATE_LIMIT_TIER,
  RATE_LIMIT_TIERS,
  RateLimitTier,
  SKIP_RATE_LIMIT,
} from './rate-limit.decorator';
import { RateLimitService } from './rate-limit.service';

const WINDOW_MS = 60_000;

export function rateLimitScale(): number {
  const v = Number(process.env.RATE_LIMIT_SCALE);
  return Number.isFinite(v) && v > 0 ? v : 1;
}

/**
 * Global per-minute limit on every HTTP route (default 120/min), stricter
 * tiers via @RateLimit(). Over the limit: 429 RATE_LIMITED with Retry-After.
 * Fixed one-minute windows in Redis (one round trip per request), falling
 * back to memory when Redis is down.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly limiter: RateLimitService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(SKIP_RATE_LIMIT, targets))
      return true;
    const tier =
      this.reflector.getAllAndOverride<RateLimitTier>(
        RATE_LIMIT_TIER,
        targets,
      ) ?? 'default';
    const limit = Math.max(
      1,
      Math.round(RATE_LIMIT_TIERS[tier] * rateLimitScale()),
    );

    const req = context.switchToHttp().getRequest<Request>();
    const auth = req.headers.authorization;
    const client = RateLimitService.key(
      req.ip ?? 'unknown',
      auth && auth.length < 4096 ? auth : '',
    );
    const r = await this.limiter.fixedWindow(
      `rpm:${tier}:${client}`,
      limit,
      WINDOW_MS,
    );
    const res = context.switchToHttp().getResponse<Response>();
    if (!res.headersSent) {
      res.setHeader('X-RateLimit-Limit', String(limit));
      res.setHeader(
        'X-RateLimit-Remaining',
        String(Math.max(0, limit - r.count)),
      );
    }
    if (!r.allowed) {
      throw rateLimited(
        'Too many requests. Please wait a moment and try again.',
        r.retryAfterSeconds,
      );
    }
    return true;
  }
}
