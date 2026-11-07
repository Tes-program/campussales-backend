import { HttpException } from '@nestjs/common';
import { ERROR_CODE_STATUS, ErrorCode } from './error-codes';
import { DEFAULT_MESSAGES } from './messages';

export type FieldErrors = Record<string, string>;

/**
 * The payload every HttpException we throw carries. The global filter turns it
 * into the public `{ error: { code, message, fields } }` body.
 */
export interface AppErrorPayload {
  code: ErrorCode;
  message: string;
  fields?: FieldErrors;
  /** Only on 429s. Also sent as the Retry-After header. */
  retryAfterSeconds?: number;
}

export class AppError extends HttpException {
  constructor(
    code: ErrorCode,
    message?: string,
    fields?: FieldErrors,
    extra: { retryAfterSeconds?: number } = {},
  ) {
    const payload: AppErrorPayload = {
      code,
      message: message ?? DEFAULT_MESSAGES[code],
      ...(fields && Object.keys(fields).length ? { fields } : {}),
      ...(extra.retryAfterSeconds !== undefined
        ? { retryAfterSeconds: Math.max(1, Math.ceil(extra.retryAfterSeconds)) }
        : {}),
    };
    super(payload, ERROR_CODE_STATUS[code]);
  }
}

export class ValidationFailed extends AppError {
  constructor(fields: FieldErrors, message?: string) {
    super(ErrorCode.VALIDATION_FAILED, message, fields);
  }
}

export const notFound = (message?: string) =>
  new AppError(ErrorCode.NOT_FOUND, message);
export const forbidden = (message?: string) =>
  new AppError(ErrorCode.FORBIDDEN, message);
export const conflict = (message?: string, fields?: FieldErrors) =>
  new AppError(ErrorCode.CONFLICT, message, fields);
export const rateLimited = (message?: string, retryAfterSeconds?: number) =>
  new AppError(ErrorCode.RATE_LIMITED, message, undefined, {
    retryAfterSeconds,
  });
