import { ClassConstructor, plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { FieldErrors } from '../errors/app-errors';
import { toFieldErrors } from './validation-errors';

/**
 * Runs a DTO class exactly like the global ValidationPipe does (transform,
 * whitelist, forbidNonWhitelisted) and returns the normalised value plus the
 * field errors the API would send. Used by unit tests and services.
 */
export async function runSchema<T extends object>(
  cls: ClassConstructor<T>,
  plain: Record<string, unknown>,
): Promise<{ value: T; fields: FieldErrors; ok: boolean }> {
  const value = plainToInstance(cls, plain);
  const errors = await validate(value, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  const fields = toFieldErrors(errors);
  return { value, fields, ok: Object.keys(fields).length === 0 };
}
