import { createHmac } from 'crypto';

/**
 * Last line of defence for log output: even if a caller passes something
 * sensitive into a log message, these patterns are masked before it is
 * written. Never log passwords, tokens, message text or reset links in the
 * first place; this only catches mistakes.
 */
const PATTERNS: Array<[RegExp, string]> = [
  // JWTs (access tokens, signed links)
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[jwt]'],
  // Authorization headers
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]'],
  // token / password / secret style query or JSON values
  [
    /((?:token|password|passwd|secret|signature|api_key|apikey|code)["']?\s*[=:]\s*["']?)[^"'&\s,}]+/gi,
    '$1[redacted]',
  ],
  // reset / verify links: keep the path, drop the query
  [/(\/(?:reset-password|verify-email)[^\s?"']*)\?[^\s"']*/gi, '$1?[redacted]'],
  // email addresses
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]'],
];

export function redact(text: string): string {
  let out = text;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

/** Stable pseudonymous id for logs: lets us follow one user without storing their id. */
export function hashUserId(id: string | undefined | null): string | undefined {
  if (!id) return undefined;
  const salt =
    process.env.LOG_HASH_SALT || process.env.JWT_SECRET || 'campussales';
  return createHmac('sha256', salt).update(id).digest('hex').slice(0, 16);
}
