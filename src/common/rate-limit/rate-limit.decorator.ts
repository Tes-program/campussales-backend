import { SetMetadata } from '@nestjs/common';

export const RATE_LIMIT_TIER = 'rateLimitTier';
export const SKIP_RATE_LIMIT = 'skipRateLimit';

/**
 * Requests per minute per client (IP, plus the bearer token when present so
 * students behind one carrier/campus NAT don't share a budget). Scaled by
 * RATE_LIMIT_SCALE (tests use a large scale). Endpoint-specific abuse limits
 * (login attempts, reset emails, report caps) still apply on top.
 */
export const RATE_LIMIT_TIERS = {
  default: 120,
  auth: 30,
  reports: 10,
  messages: 40,
  uploads: 30,
  events: 60,
} as const;

export type RateLimitTier = keyof typeof RATE_LIMIT_TIERS;

/** Stricter (or looser) per-minute budget for a controller or route. */
export const RateLimit = (tier: RateLimitTier) =>
  SetMetadata(RATE_LIMIT_TIER, tier);

/** Health checks and other routes the host polls. */
export const SkipRateLimit = () => SetMetadata(SKIP_RATE_LIMIT, true);
