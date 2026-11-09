import { HttpStatus } from '@nestjs/common';

/**
 * The only error codes the API returns. Every non-2xx response carries one of
 * these in `error.code`. See docs/api.md for the contract.
 */
export enum ErrorCode {
  VALIDATION_FAILED = 'VALIDATION_FAILED',
  UNAUTHENTICATED = 'UNAUTHENTICATED',
  FORBIDDEN = 'FORBIDDEN',
  NOT_FOUND = 'NOT_FOUND',
  CONFLICT = 'CONFLICT',
  RATE_LIMITED = 'RATE_LIMITED',
  SERVER_ERROR = 'SERVER_ERROR',
  // B2 auth
  /** 401: login failed. Never says whether the email or password was wrong. */
  INVALID_CREDENTIALS = 'INVALID_CREDENTIALS',
  /** 400: reset/verification token was valid but has expired. */
  TOKEN_EXPIRED = 'TOKEN_EXPIRED',
  /** 400: reset/verification token is unknown, used or superseded. */
  TOKEN_INVALID = 'TOKEN_INVALID',
  /** 403: the 24h unverified grace period is over. */
  EMAIL_NOT_VERIFIED = 'EMAIL_NOT_VERIFIED',
  // B4 moderation
  /** 403: one of the two users has blocked the other. Neutral message. */
  BLOCKED = 'BLOCKED',
  /** 400: listing screening rejected the item. */
  MODERATION_REJECTED = 'MODERATION_REJECTED',
  /** 403: posting is suspended for this account. */
  ACCOUNT_SUSPENDED = 'ACCOUNT_SUSPENDED',
  // B5
  /** 504: the request took longer than 15 seconds. Safe to retry reads. */
  TIMEOUT = 'TIMEOUT',
  // H1
  /** 400: sign-up sent an outdated (or no) acceptedTermsVersion. error.details has the current versions. */
  TERMS_VERSION_MISMATCH = 'TERMS_VERSION_MISMATCH',
}

export const ERROR_CODE_STATUS: Record<ErrorCode, number> = {
  [ErrorCode.VALIDATION_FAILED]: HttpStatus.BAD_REQUEST,
  [ErrorCode.UNAUTHENTICATED]: HttpStatus.UNAUTHORIZED,
  [ErrorCode.FORBIDDEN]: HttpStatus.FORBIDDEN,
  [ErrorCode.NOT_FOUND]: HttpStatus.NOT_FOUND,
  [ErrorCode.CONFLICT]: HttpStatus.CONFLICT,
  [ErrorCode.RATE_LIMITED]: HttpStatus.TOO_MANY_REQUESTS,
  [ErrorCode.SERVER_ERROR]: HttpStatus.INTERNAL_SERVER_ERROR,
  [ErrorCode.INVALID_CREDENTIALS]: HttpStatus.UNAUTHORIZED,
  [ErrorCode.TOKEN_EXPIRED]: HttpStatus.BAD_REQUEST,
  [ErrorCode.TOKEN_INVALID]: HttpStatus.BAD_REQUEST,
  [ErrorCode.EMAIL_NOT_VERIFIED]: HttpStatus.FORBIDDEN,
  [ErrorCode.BLOCKED]: HttpStatus.FORBIDDEN,
  [ErrorCode.MODERATION_REJECTED]: HttpStatus.BAD_REQUEST,
  [ErrorCode.ACCOUNT_SUSPENDED]: HttpStatus.FORBIDDEN,
  [ErrorCode.TIMEOUT]: HttpStatus.GATEWAY_TIMEOUT,
  [ErrorCode.TERMS_VERSION_MISMATCH]: HttpStatus.BAD_REQUEST,
};

/** Maps any HTTP status to the closest contract code. */
export function codeForStatus(status: number): ErrorCode {
  switch (status) {
    case 400:
      return ErrorCode.VALIDATION_FAILED;
    case 401:
      return ErrorCode.UNAUTHENTICATED;
    case 403:
      return ErrorCode.FORBIDDEN;
    case 404:
      return ErrorCode.NOT_FOUND;
    case 409:
      return ErrorCode.CONFLICT;
    case 429:
      return ErrorCode.RATE_LIMITED;
    default:
      // Other 4xx (413 payload too large, 415, 422...) are input problems.
      if (status >= 400 && status < 500 && status !== 408) {
        return ErrorCode.VALIDATION_FAILED;
      }
      return ErrorCode.SERVER_ERROR;
  }
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return (
    typeof value === 'string' &&
    (Object.values(ErrorCode) as string[]).includes(value)
  );
}
