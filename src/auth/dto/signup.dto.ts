// Schemas for POST /api/auth/signup and POST /api/auth/register (the deployed
// frontend's endpoint; identical unless AUTH_LEGACY_TOKENS=true, which makes
// the terms fields optional during the B2 transition).
//
// Field names match the sign-up form: email, username, password,
// confirmPassword, campus, plus acceptedTerms / acceptedTermsVersion. `name`
// is optional (it defaults to the username), so an error never mentions it
// unless the client sent it.
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
import { TERMS_VERSION } from '../../config/legal';
import { checkPassword, PASSWORD_MESSAGES } from '../password-policy';

export const USERNAME_RULE = {
  minLength: 2,
  maxLength: 30,
  pattern: /^[A-Za-z0-9._]+$/,
} as const;

export const SIGNUP_MESSAGES = {
  name: 'Enter your name (2 to 80 characters).',
  email: 'Enter a valid email address.',
  emailTaken: 'An account with this email already exists. Log in instead.',
  terms: 'Please accept the Terms and Privacy Policy to continue.',
  termsVersion: 'We updated our Terms. Please review them and try again.',
  school: 'Choose your school from the list.',
  usernameRequired: 'Choose a username.',
  username: 'Usernames are 2 to 30 letters, numbers, dots or underscores.',
  usernameTaken: 'That username is taken. Try another one.',
  confirmPassword: "Those passwords don't match.",
} as const;

const normaliseEmail = (v: unknown) =>
  typeof v === 'string' ? v.trim().toLowerCase() : v;

const trim = (v: unknown) => (typeof v === 'string' ? v.trim() : v);

/** A blank optional field counts as "not sent". */
const blankToUndefined = (v: unknown) => {
  const t = normaliseText(v);
  return t === null || t === '' ? undefined : t;
};

const validateName = (v: unknown) =>
  typeof v === 'string' &&
  !hasControlChars(v) &&
  charLength(v) >= 2 &&
  charLength(v) <= 80
    ? null
    : SIGNUP_MESSAGES.name;

export const validateUsername = (v: unknown) => {
  if (v === undefined || v === null || v === '')
    return SIGNUP_MESSAGES.usernameRequired;
  return typeof v === 'string' &&
    v.length >= USERNAME_RULE.minLength &&
    v.length <= USERNAME_RULE.maxLength &&
    USERNAME_RULE.pattern.test(v)
    ? null
    : SIGNUP_MESSAGES.username;
};

/**
 * Only checked once the terms box is ticked, so an old client that sends
 * neither field gets one clear error (acceptedTerms), not two.
 */
const validateTermsVersion = (v: unknown, o?: Record<string, unknown>) => {
  if (o?.acceptedTerms !== true) return null;
  return v === TERMS_VERSION ? null : SIGNUP_MESSAGES.termsVersion;
};

const isUuidLike = (v: unknown) =>
  typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v);

class SignupBase {
  @ApiProperty({ example: 'ada@unilag.edu.ng' })
  @Normalise(normaliseEmail)
  @IsEmail({}, { message: SIGNUP_MESSAGES.email })
  email: string;

  @ApiProperty({
    example: 'ada_okafor',
    description:
      'Public name shown to other users. 2–30 letters, numbers, dots or underscores; trimmed; unique ignoring case.',
  })
  @Normalise(trim)
  @Rule(validateUsername)
  username: string;

  @ApiPropertyOptional({
    description:
      'Optional display name (2–80 characters). Defaults to the username.',
  })
  @Normalise(blankToUndefined)
  @OptionalRule(validateName)
  name?: string;

  @ApiProperty({
    description: `At least 8 characters, including a number. "${PASSWORD_MESSAGES.rule}"`,
  })
  @Rule((v) => checkPassword(v))
  password: string;

  @ApiPropertyOptional({ description: 'When sent, must equal password.' })
  @OptionalRule((v, o) =>
    v === o?.password ? null : SIGNUP_MESSAGES.confirmPassword,
  )
  confirmPassword?: string;

  @ApiPropertyOptional({
    description:
      'School id or name/short name from GET /api/schools. Stored as the school id.',
  })
  @Normalise(blankToUndefined)
  @OptionalRule((v) =>
    typeof v === 'string' && v.length <= 150 ? null : SIGNUP_MESSAGES.school,
  )
  campus?: string;

  @ApiPropertyOptional({ description: 'School id; alternative to campus.' })
  @Normalise(blankToUndefined)
  @OptionalRule((v) => (isUuidLike(v) ? null : SIGNUP_MESSAGES.school))
  schoolId?: string;

  /** Accepted for compatibility and ignored: every new account is a student. */
  @ApiPropertyOptional({ deprecated: true })
  @IsOptional()
  @Allow()
  userType?: string;
}

export class SignupDto extends SignupBase {
  @ApiProperty({ example: true, description: 'Must be true.' })
  @Rule((v) => (v === true ? null : SIGNUP_MESSAGES.terms))
  acceptedTerms: boolean;

  @ApiProperty({
    example: TERMS_VERSION,
    description: 'Must equal termsVersion from GET /api/legal/versions.',
  })
  @Rule(validateTermsVersion)
  acceptedTermsVersion: string;
}

/** Only while AUTH_LEGACY_TOKENS=true: terms may be omitted. */
export class LegacyRegisterDto extends SignupBase {
  @ApiPropertyOptional()
  @OptionalRule((v) => (v === true ? null : SIGNUP_MESSAGES.terms))
  acceptedTerms?: boolean;

  @ApiPropertyOptional()
  @OptionalRule(validateTermsVersion)
  acceptedTermsVersion?: string;
}
