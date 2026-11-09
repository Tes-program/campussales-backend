import { UPLOAD_RULES } from '../../uploads/upload-rules';
import { reportError } from '../observability/error-reporter';
import { hashUserId } from '../observability/redact';
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
  PayloadTooLargeException,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { QueryFailedError } from 'typeorm';
import { codeForStatus, ErrorCode, isErrorCode } from '../errors/error-codes';
import { DEFAULT_MESSAGES, MSG } from '../errors/messages';
import { FieldErrors } from '../errors/app-errors';
import { REQUEST_ID_HEADER } from '../middleware/request-id.middleware';

/** Public error body. See docs/api.md "Errors". */
export interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    fields?: FieldErrors;
    /** Only on 429 RATE_LIMITED. Same value as the Retry-After header. */
    retryAfterSeconds?: number;
    /** Extra machine-readable context, e.g. current versions on TERMS_VERSION_MISMATCH. */
    details?: Record<string, unknown>;
    requestId?: string;
  };
  // ---- Legacy fields, kept for one release (remove in B2+1) ----
  /** @deprecated use HTTP status */
  statusCode: number;
  /** @deprecated use error.message / error.fields */
  message: string | string[];
  /** @deprecated use error.code */
  errorCode: string;
  /** @deprecated */
  timestamp: string;
  /** @deprecated */
  path: string;
  /** @deprecated */
  method: string;
}

interface Normalised {
  status: number;
  code: ErrorCode;
  message: string;
  fields?: FieldErrors;
  retryAfterSeconds?: number;
  details?: Record<string, unknown>;
  /** Original framework message, only for logs. */
  logDetail?: string;
}

/**
 * Framework/default messages that are written for developers. When an
 * exception carries one of these we show the student-facing default instead.
 */
const DEV_MESSAGE_PATTERNS: RegExp[] = [
  /^(Unauthorized|Forbidden|Forbidden resource|Not Found|Bad Request|Conflict|Internal server error|Internal Server Error|Too Many Requests|Request Timeout|Payload Too Large|Unsupported Media Type)$/i,
  /^ThrottlerException/i,
  /^Cannot (GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) /,
  /^Validation failed/i, // ParseUUIDPipe, ParseIntPipe...
  /^Unexpected token/i, // body-parser JSON errors
  /JSON/,
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, // ids
];

function isDevMessage(message: string): boolean {
  return DEV_MESSAGE_PATTERNS.some((re) => re.test(message));
}

/**
 * Best-effort conversion of class-validator's default string array
 * ("price must be a number") into field errors, for any pipe that was not
 * created with our exceptionFactory.
 */
function fieldsFromLegacyArray(messages: string[]): FieldErrors {
  const fields: FieldErrors = {};
  for (const m of messages) {
    const notAllowed = /^property (\S+) should not exist$/.exec(m);
    if (notAllowed) {
      fields[notAllowed[1]] ??= MSG.fieldNotAllowed;
      continue;
    }
    const match = /^(?:each value in )?([A-Za-z0-9_.]+) /.exec(m);
    if (match) fields[match[1]] ??= MSG.invalidValue;
  }
  return fields;
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpError');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request & { requestId?: string }>();
    const requestId =
      request.requestId ?? (response.getHeader(REQUEST_ID_HEADER) as string);

    const n = this.normalise(exception);

    // Path only: query strings can carry tokens (verify/reset links) or emails.
    const path = (request.originalUrl ?? request.url ?? '').split('?')[0];
    if (n.status >= 500) {
      const err = exception as Error;
      reportError(exception, {
        requestId,
        route: `${request.method} ${path}`,
        status: n.status,
        userHash: hashUserId((request as { user?: { id?: string } }).user?.id),
      });
      this.logger.error(
        `[${requestId}] ${request.method} ${path} -> ${n.status} ${err?.name ?? ''}: ${err?.message ?? String(exception)}`,
        err?.stack,
      );
    } else {
      this.logger.warn(
        `[${requestId}] ${request.method} ${path} -> ${n.status} ${n.code}${n.logDetail ? ` (${n.logDetail})` : ''}`,
      );
    }

    const legacyMessage: string | string[] = n.fields
      ? Object.values(n.fields)
      : n.message;

    const body: ErrorBody = {
      error: {
        code: n.code,
        message: n.message,
        ...(n.fields && Object.keys(n.fields).length
          ? { fields: n.fields }
          : {}),
        ...(n.retryAfterSeconds
          ? { retryAfterSeconds: n.retryAfterSeconds }
          : {}),
        ...(n.details ? { details: n.details } : {}),
        ...(requestId ? { requestId } : {}),
      },
      statusCode: n.status,
      message: legacyMessage,
      errorCode: n.code,
      timestamp: new Date().toISOString(),
      path,
      method: request.method,
    };

    if (requestId && !response.headersSent) {
      response.setHeader(REQUEST_ID_HEADER, requestId);
    }
    if (!response.headersSent) {
      // Errors are never cached, even on routes that are public when they succeed.
      response.setHeader('Cache-Control', 'no-store');
    }
    if (n.retryAfterSeconds && !response.headersSent) {
      response.setHeader('Retry-After', String(n.retryAfterSeconds));
    }
    response.status(n.status).json(body);
  }

  private normalise(exception: unknown): Normalised {
    if (exception instanceof ThrottlerException) {
      return {
        status: HttpStatus.TOO_MANY_REQUESTS,
        code: ErrorCode.RATE_LIMITED,
        message: DEFAULT_MESSAGES[ErrorCode.RATE_LIMITED],
      };
    }

    // Multer's file size limit (legacy multipart uploads): friendly message.
    if (exception instanceof PayloadTooLargeException) {
      return {
        status: HttpStatus.PAYLOAD_TOO_LARGE,
        code: ErrorCode.VALIDATION_FAILED,
        message: UPLOAD_RULES.tooLargeMessage,
        fields: { images: UPLOAD_RULES.tooLargeMessage },
        logDetail: 'file too large',
      };
    }

    if (exception instanceof HttpException) {
      return this.fromHttpException(exception);
    }

    if (exception instanceof QueryFailedError) {
      const pg = exception as QueryFailedError & { code?: string };
      switch (pg.code) {
        case '23505': // unique_violation
          return {
            status: HttpStatus.CONFLICT,
            code: ErrorCode.CONFLICT,
            message: DEFAULT_MESSAGES[ErrorCode.CONFLICT],
            logDetail: `pg ${pg.code}`,
          };
        case '23503': // foreign_key_violation
        case '22P02': // invalid_text_representation
        case '23514': // check_violation
          return {
            status: HttpStatus.BAD_REQUEST,
            code: ErrorCode.VALIDATION_FAILED,
            message: MSG.invalidRequest,
            logDetail: `pg ${pg.code}`,
          };
      }
      // Fall through to 500: everything else is our bug, not the student's.
    }

    // body-parser errors (malformed JSON, payload too large) are plain errors
    // with a status property.
    const maybe = exception as {
      status?: number;
      statusCode?: number;
      type?: string;
    };
    const rawStatus = maybe?.status ?? maybe?.statusCode;
    if (typeof rawStatus === 'number' && rawStatus >= 400 && rawStatus < 500) {
      return {
        status: rawStatus,
        code: codeForStatus(rawStatus),
        message:
          maybe.type === 'entity.parse.failed'
            ? MSG.invalidJson
            : DEFAULT_MESSAGES[codeForStatus(rawStatus)],
        logDetail: maybe.type,
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: ErrorCode.SERVER_ERROR,
      message: DEFAULT_MESSAGES[ErrorCode.SERVER_ERROR],
    };
  }

  private fromHttpException(exception: HttpException): Normalised {
    const status = exception.getStatus();
    const res = exception.getResponse() as
      | string
      | {
          code?: unknown;
          message?: unknown;
          fields?: FieldErrors;
          errorCode?: unknown;
          retryAfterSeconds?: unknown;
          details?: unknown;
        };

    // 5xx never leak their message.
    if (status >= 500) {
      return {
        status,
        code: ErrorCode.SERVER_ERROR,
        message: DEFAULT_MESSAGES[ErrorCode.SERVER_ERROR],
      };
    }

    const code =
      typeof res === 'object' && isErrorCode(res.code)
        ? res.code
        : codeForStatus(status);
    if (status === (HttpStatus.REQUEST_TIMEOUT as number)) {
      return {
        status,
        code: ErrorCode.SERVER_ERROR,
        message: MSG.requestTimeout,
      };
    }

    let message: string | undefined;
    let fields: FieldErrors | undefined;

    if (typeof res === 'string') {
      message = res;
    } else if (res && typeof res === 'object') {
      fields = res.fields;
      if (Array.isArray(res.message)) {
        // Default ValidationPipe output from a pipe without our factory.
        fields = {
          ...fieldsFromLegacyArray(res.message as string[]),
          ...fields,
        };
        message = undefined;
      } else if (typeof res.message === 'string') {
        message = res.message;
      }
    }

    const logDetail = message;
    if (!message || isDevMessage(message)) {
      message =
        code === ErrorCode.VALIDATION_FAILED && !fields
          ? MSG.invalidRequest
          : DEFAULT_MESSAGES[code];
    }

    const retryAfterSeconds =
      typeof res === 'object' && typeof res.retryAfterSeconds === 'number'
        ? res.retryAfterSeconds
        : undefined;

    const details =
      typeof res === 'object' &&
      res.details &&
      typeof res.details === 'object' &&
      !Array.isArray(res.details)
        ? (res.details as Record<string, unknown>)
        : undefined;

    return {
      status,
      code,
      message,
      ...(fields && Object.keys(fields).length ? { fields } : {}),
      ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
      ...(details ? { details } : {}),
      logDetail,
    };
  }
}
