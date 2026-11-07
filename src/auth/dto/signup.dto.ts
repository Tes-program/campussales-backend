// Schemas for POST /api/auth/signup (strict) and the legacy
// POST /api/auth/register (deployed frontend; terms optional while
// AUTH_LEGACY_TOKENS=true).
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Allow, IsEmail, IsOptional } from 'class-validator';
import {
  Normalise,
  OptionalRule,
  Rule,
} from '../../common/validation/decorators';
import {
  normaliseText,
  hasControlChars,
  charLength,
} from '../../common/validation/rules';
import { checkPassword, PASSWORD_RULE } from '../password-policy';

export const SIGNUP_MESSAGES = {
  name: 'Enter your name (2 to 80 characters).',
  email: 'Enter a valid email address.',
  emailTaken: 'An account with this email already exists. Log in instead.',
  terms: 'Please accept the Terms and Privacy Policy to continue.',
  termsVersion: 'Please review the latest Terms and try again.',
  school: 'Choose your school from the list.',
  username: 'Usernames are 3 to 30 letters, numbers, dots or underscores.',
  usernameTaken: 'That username is taken. Try another one.',
} as const;

const normaliseEmail = (v: unknown) =>
  typeof v === 'string' ? v.trim().toLowerCase() : v;

const validateName = (v: unknown) =>
  typeof v === 'string' &&
  !hasControlChars(v) &&
  charLength(v.trim()) >= 2 &&
  charLength(v.trim()) <= 80
    ? null
    : SIGNUP_MESSAGES.name;

const validateUsername = (v: unknown) =>
  typeof v === 'string' && /^[A-Za-z0-9._]{3,30}$/.test(v)
    ? null
    : SIGNUP_MESSAGES.username;

const validatePasswordField = (v: unknown, o?: Record<string, unknown>) =>
  checkPassword(v, {
    email: typeof o?.email === 'string' ? o.email : null,
    name:
      typeof o?.name === 'string'
        ? o.name
        : typeof o?.username === 'string'
          ? o.username
          : null,
  });

const validateTermsVersion = (v: unknown) => {
  if (typeof v !== 'string' || !v.trim() || v.length > 32)
    return SIGNUP_MESSAGES.termsVersion;
  const current = process.env.CURRENT_TERMS_VERSION;
  return current && v !== current ? SIGNUP_MESSAGES.termsVersion : null;
};

const isUuidLike = (v: unknown) =>
  typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v);

class SignupBase {
  @ApiProperty({ example: 'ada@unilag.edu.ng' })
  @Normalise(normaliseEmail)
  @IsEmail({}, { message: SIGNUP_MESSAGES.email })
  email: string;

  @ApiProperty({
    description: `≥ ${PASSWORD_RULE.minLength} characters, a letter and a number, ≤ ${PASSWORD_RULE.maxBytes} bytes, not common, not your email or name.`,
  })
  @Rule(validatePasswordField)
  password: string;

  @ApiPropertyOptional({
    description: 'School id from GET /api/schools (optional until onboarding).',
  })
  @OptionalRule((v) =>
    v === null || isUuidLike(v) ? null : SIGNUP_MESSAGES.school,
  )
  schoolId?: string | null;

  @ApiPropertyOptional({
    description: 'School name or short name, instead of schoolId.',
  })
  @Normalise(normaliseText)
  @OptionalRule((v) =>
    v === null || (typeof v === 'string' && v.length <= 150)
      ? null
      : SIGNUP_MESSAGES.school,
  )
  campus?: string | null;

  @ApiPropertyOptional({ description: 'Generated from the email if omitted.' })
  @Normalise(normaliseText)
  @OptionalRule(validateUsername)
  username?: string;
}

export class SignupDto extends SignupBase {
  @ApiProperty({ example: 'Ada Okafor' })
  @Normalise(normaliseText)
  @Rule(validateName)
  name: string;

  @ApiProperty({ example: true, description: 'Must be true.' })
  @Rule((v) => (v === true ? null : SIGNUP_MESSAGES.terms))
  acceptedTerms: boolean;

  @ApiProperty({ example: '2026-11-01' })
  @Rule(validateTermsVersion)
  acceptedTermsVersion: string;
}

/** What the deployed frontend sends today: { email, password, username, userType? }. */
export class LegacyRegisterDto extends SignupBase {
  @ApiPropertyOptional()
  @Normalise(normaliseText)
  @OptionalRule(validateName)
  name?: string;

  @ApiPropertyOptional()
  @OptionalRule((v) => (v === true ? null : SIGNUP_MESSAGES.terms))
  acceptedTerms?: boolean;

  @ApiPropertyOptional()
  @OptionalRule(validateTermsVersion)
  acceptedTermsVersion?: string;

  /** Accepted for compatibility and ignored: every new account is a student. */
  @ApiPropertyOptional({ deprecated: true })
  @IsOptional()
  @Allow()
  userType?: string;
}
