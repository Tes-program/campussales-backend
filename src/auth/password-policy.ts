/**
 * THE password rule, used at sign-up, reset and change (and documented in
 * docs/api.md so the frontend checklist matches):
 *
 *   - at least 8 characters
 *   - at least one letter and one number
 *   - at most 72 bytes in UTF-8 (bcrypt ignores anything longer)
 *   - not one of the ~1000 most common passwords (data/common-passwords.txt)
 *   - does not contain the account's email (local part) or name
 *
 * The rule before B2 was 8+ characters with a letter and a number, but only
 * for reset/change (sign-up allowed 6). It also limited characters to
 * A-Z, 0-9 and @$!%*#?&, which rejected spaces and most symbols without making
 * passwords stronger; that restriction is dropped.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

export const PASSWORD_RULE = {
  minLength: 8,
  maxBytes: 72,
  requiresLetter: true,
  requiresNumber: true,
} as const;

export const PASSWORD_MESSAGES = {
  required: 'Enter a password.',
  short: 'Use at least 8 characters.',
  long: 'That password is too long. Use 72 characters or fewer.',
  letterAndNumber: 'Use at least one letter and one number.',
  common: 'That password is too common. Pick something harder to guess.',
  personal: "Don't use your email or name in your password.",
} as const;

let common: Set<string> | null = null;
function commonPasswords(): Set<string> {
  if (!common) {
    const file = join(__dirname, '..', '..', 'data', 'common-passwords.txt');
    common = new Set(
      readFileSync(file, 'utf8')
        .split('\n')
        .map((l) => l.trim().toLowerCase())
        .filter((l) => l && !l.startsWith('#')),
    );
  }
  return common;
}

const squash = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/** Returns a student-facing message, or null when the password is acceptable. */
export function checkPassword(
  password: unknown,
  context: { email?: string | null; name?: string | null } = {},
): string | null {
  if (typeof password !== 'string' || password.length === 0) {
    return PASSWORD_MESSAGES.required;
  }
  if (Array.from(password).length < PASSWORD_RULE.minLength) {
    return PASSWORD_MESSAGES.short;
  }
  if (Buffer.byteLength(password, 'utf8') > PASSWORD_RULE.maxBytes) {
    return PASSWORD_MESSAGES.long;
  }
  if (!/\p{L}/u.test(password) || !/\p{N}/u.test(password)) {
    return PASSWORD_MESSAGES.letterAndNumber;
  }
  if (commonPasswords().has(password.toLowerCase())) {
    return PASSWORD_MESSAGES.common;
  }
  const pw = squash(password);
  const personal: string[] = [];
  if (context.email) {
    personal.push(squash(context.email));
    personal.push(squash(context.email.split('@')[0]));
  }
  if (context.name) {
    personal.push(squash(context.name));
    personal.push(...context.name.split(/\s+/).map(squash));
  }
  if (personal.some((p) => p.length >= 3 && pw.includes(p))) {
    return PASSWORD_MESSAGES.personal;
  }
  return null;
}
