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
}

export class AppError extends HttpException {
  constructor(code: ErrorCode, message?: string, fields?: FieldErrors) {
    const payload: AppErrorPayload = {
      code,
      message: message ?? DEFAULT_MESSAGES[code],
      ...(fields && Object.keys(fields).length ? { fields } : {}),
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
export const rateLimited = (message?: string) =>
  new AppError(ErrorCode.RATE_LIMITED, message);
