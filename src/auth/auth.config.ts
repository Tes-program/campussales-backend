import { ConfigService } from '@nestjs/config';
import { CookieOptions } from 'express';

/** Every auth lifetime and switch in one place. See docs/security.md. */
export const AUTH = {
  accessTtlSeconds: 15 * 60,
  refreshTtlDays: 30,
  /** A just-rotated refresh token is not treated as reuse inside this window (parallel tabs). */
  rotationGraceMs: 10_000,
  resetTtlMinutes: 30,
  verifyLinkTtlHours: 24,
  verifyGraceHours: 24,
  cookieName: 'cs_refresh',
  cookiePath: '/api/auth',
  /** Legacy body tokens are removed after this date (see PR notes). */
  legacyRemovalDate: '2027-01-31',
  login: {
    windowMs: 15 * 60_000,
    perAccount: 5,
    perIp: 20,
    baseDelaySeconds: 30,
  },
  forgotPassword: { windowMs: 60 * 60_000, perEmail: 3, perIp: 20 },
  resendVerification: { windowMs: 60 * 60_000, perUser: 3 },
  signup: { windowMs: 60 * 60_000, perIp: 10 },
} as const;

/**
 * AUTH_LEGACY_TOKENS=true keeps the pre-B2 behaviour for the deployed
 * frontend: refreshToken in JSON bodies and accepted in request bodies, and
 * /auth/register without acceptedTerms. Remove after AUTH.legacyRemovalDate.
 */
/** Grace window for parallel refreshes; AUTH_ROTATION_GRACE_MS overrides (tests). */
export function rotationGraceMs(): number {
  const v = Number(process.env.AUTH_ROTATION_GRACE_MS);
  return Number.isFinite(v) &&
    v >= 0 &&
    process.env.AUTH_ROTATION_GRACE_MS !== undefined
    ? v
    : AUTH.rotationGraceMs;
}

export function legacyTokensEnabled(config: ConfigService): boolean {
  return config.get<string>('AUTH_LEGACY_TOKENS') === 'true';
}

export function refreshCookieOptions(config: ConfigService): CookieOptions {
  const sameSite = (
    config.get<string>('AUTH_COOKIE_SAMESITE') || 'lax'
  ).toLowerCase() as 'lax' | 'strict' | 'none';
  return {
    httpOnly: true,
    // Secure unless explicitly disabled (never disable in production).
    secure:
      config.get<string>('AUTH_COOKIE_SECURE') !== 'false' ||
      sameSite === 'none',
    sameSite,
    path: AUTH.cookiePath,
    maxAge: AUTH.refreshTtlDays * 24 * 60 * 60 * 1000,
    ...(config.get<string>('AUTH_COOKIE_DOMAIN')
      ? { domain: config.get<string>('AUTH_COOKIE_DOMAIN') }
      : {}),
  };
}

/** Reads one cookie from the raw header (no cookie-parser dependency). */
export function readCookie(
  header: string | undefined,
  name: string,
): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/**
 * FRONTEND_URL builds every link we email. Startup fails in production when
 * it is missing or not https (see config/env.validation.ts).
 */
export function frontendUrl(config: ConfigService): string {
  const url = config.get<string>('FRONTEND_URL');
  if (url) return url.replace(/\/+$/, '');
  if (config.get('NODE_ENV') === 'production') {
    throw new Error('FRONTEND_URL is not set');
  }
  return 'http://localhost:5173';
}
