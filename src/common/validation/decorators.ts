import { Transform } from 'class-transformer';
import {
  registerDecorator,
  ValidateIf,
  ValidationArguments,
} from 'class-validator';
import { MSG } from '../errors/messages';
import { Check } from './rules';

/**
 * Runs one rule from rules.ts and reports its exact message. One rule per
 * property keeps the message deterministic (class-validator does not order
 * multiple constraint messages).
 */
export function Rule(check: Check): PropertyDecorator {
  return (target: object, propertyName: string | symbol) => {
    registerDecorator({
      name: 'rule',
      target: target.constructor,
      propertyName: propertyName as string,
      validator: {
        validate: (value: unknown, args: ValidationArguments) =>
          check(value, args.object as Record<string, unknown>) === null,
        defaultMessage: (args: ValidationArguments) =>
          check(args.value, args.object as Record<string, unknown>) ??
          MSG.invalidValue,
      },
    });
  };
}

/** Like Rule, but skips the field when it is absent (PATCH semantics). */
export function OptionalRule(check: Check): PropertyDecorator {
  return (target: object, propertyName: string | symbol) => {
    ValidateIf((_o, v) => v !== undefined)(target, propertyName as string);
    Rule(check)(target, propertyName);
  };
}

/** Applies a normaliser before validation. */
export function Normalise(fn: (value: unknown) => unknown): PropertyDecorator {
  return Transform(({ value }) => fn(value));
}
