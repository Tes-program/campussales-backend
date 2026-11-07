import {
  ValidationError,
  ValidationPipe,
  ValidationPipeOptions,
} from '@nestjs/common';
import { FieldErrors, ValidationFailed } from '../errors/app-errors';
import { MSG } from '../errors/messages';

/**
 * Friendly fallbacks for built-in class-validator constraints used by DTOs that
 * don't set their own message (older modules such as auth and chat).
 */
const CONSTRAINT_MESSAGES: Record<string, string> = {
  whitelistValidation: MSG.fieldNotAllowed,
  isNotEmpty: MSG.required,
  isDefined: MSG.required,
  isEmail: 'Enter a valid email address.',
  isUuid: 'Choose a valid option.',
  isString: 'This must be text.',
  isBoolean: 'This must be true or false.',
  isNumber: 'This must be a number.',
  isInt: 'This must be a whole number.',
  isArray: 'This must be a list.',
  isEnum: 'Choose one of the allowed options.',
  isIn: 'Choose one of the allowed options.',
  isDateString: 'Enter a valid date.',
  isUrl: 'Enter a valid link.',
  minLength: 'This is too short.',
  maxLength: 'This is too long.',
  min: 'This number is too small.',
  max: 'This number is too large.',
};

/**
 * class-validator's own default messages start with the property name
 * ("price must be a number"). Ours never do, so this tells them apart.
 */
function isDefaultMessage(property: string, message: string): boolean {
  return (
    message.startsWith(`${property} `) ||
    message.startsWith('each value in ') ||
    message.startsWith('property ') ||
    message.startsWith('nested property ')
  );
}

function pickMessage(error: ValidationError): string | undefined {
  const constraints = error.constraints;
  if (!constraints) return undefined;
  const entries = Object.entries(constraints);
  if (!entries.length) return undefined;
  // Prefer a hand-written message when several constraints failed.
  const custom = entries.find(([, m]) => !isDefaultMessage(error.property, m));
  if (custom) return custom[1];
  const [name] = entries[0];
  return CONSTRAINT_MESSAGES[name] ?? MSG.invalidValue;
}

/**
 * Flattens a class-validator error tree into `{ field: message }`.
 * Nested objects use dot paths (profile.firstName). Array items collapse onto
 * the array field (images.2 -> images) so the UI highlights one input.
 */
export function toFieldErrors(
  errors: ValidationError[],
  parentPath = '',
): FieldErrors {
  const fields: FieldErrors = {};
  for (const error of errors) {
    const isIndex = /^\d+$/.test(error.property);
    const path = isIndex
      ? parentPath
      : parentPath
        ? `${parentPath}.${error.property}`
        : error.property;
    const message = pickMessage(error);
    if (message && path && !fields[path]) fields[path] = message;
    if (error.children?.length) {
      const nested = toFieldErrors(error.children, path);
      for (const [k, v] of Object.entries(nested)) {
        if (!fields[k]) fields[k] = v;
      }
    }
  }
  return fields;
}

export function validationExceptionFactory(errors: ValidationError[]) {
  return new ValidationFailed(toFieldErrors(errors));
}

export const VALIDATION_PIPE_OPTIONS: ValidationPipeOptions = {
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  validationError: { target: false, value: false },
  exceptionFactory: validationExceptionFactory,
};

/** The one ValidationPipe configuration used across the API. */
export function createValidationPipe(
  overrides: Partial<ValidationPipeOptions> = {},
): ValidationPipe {
  return new ValidationPipe({ ...VALIDATION_PIPE_OPTIONS, ...overrides });
}
