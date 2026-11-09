/**
 * THE password rule, used at sign-up, reset and change. It is exactly the rule
 * the frontend form shows (Campus-Sales src/lib/validators.ts PASSWORD_RULE),
 * with the same text, so the server never rejects a password the checklist
 * marked as fine:
 *
 *   - at least 8 characters (counted like JavaScript's String.length)
 *   - at least one number (0-9)
 *
 * The only extra bound is technical, not a strength rule: bcrypt ignores
 * anything past 72 bytes, so longer passwords are refused rather than silently
 * truncated.
 *
 * H1: the B2 rule also required a letter, rejected common passwords and
 * rejected passwords containing the email or name. The form never showed
 * those, so students were rejected with no way to know why; they were removed
 * to match the form. Change both sides together if the rule is tightened.
 */
export const PASSWORD_RULE = {
  minLength: 8,
  maxBytes: 72,
  requiresNumber: true,
} as const;

export const PASSWORD_MESSAGES = {
  required: 'Enter a password.',
  rule: 'Use at least 8 characters, including a number.',
  long: 'That password is too long. Use 72 characters or fewer.',
} as const;

/** Returns a student-facing message, or null when the password is acceptable. */
export function checkPassword(password: unknown): string | null {
  if (typeof password !== 'string' || password.length === 0) {
    return PASSWORD_MESSAGES.required;
  }
  if (password.length < PASSWORD_RULE.minLength || !/\d/.test(password)) {
    return PASSWORD_MESSAGES.rule;
  }
  if (Buffer.byteLength(password, 'utf8') > PASSWORD_RULE.maxBytes) {
    return PASSWORD_MESSAGES.long;
  }
  return null;
}
