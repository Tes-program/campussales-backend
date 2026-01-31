import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { QueryFailedError } from 'typeorm';

interface ErrorResponse {
  statusCode: number;
  timestamp: string;
  path: string;
  method: string;
  message: string | string[];
  error?: string;
  errorCode?: string;
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: string | string[] = 'Internal server error';
    let error = 'Internal Server Error';
    let errorCode: string | undefined;

    // Handle different exception types
    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      if (typeof exceptionResponse === 'string') {
        message = exceptionResponse;
      } else if (typeof exceptionResponse === 'object') {
        message = (exceptionResponse as any).message || exception.message;
        error = (exceptionResponse as any).error || exception.name;
        errorCode = (exceptionResponse as any).errorCode;
      }
    } else if (exception instanceof QueryFailedError) {
      // Handle TypeORM database errors
      status = HttpStatus.BAD_REQUEST;
      error = 'Database Error';

      // Handle specific database errors
      const dbError = exception as any;

      if (dbError.code === '23505') {
        // Unique constraint violation
        message = 'A record with this data already exists';
        errorCode = 'DUPLICATE_ENTRY';
      } else if (dbError.code === '23503') {
        // Foreign key constraint violation
        message = 'Referenced record does not exist';
        errorCode = 'FOREIGN_KEY_VIOLATION';
      } else if (dbError.code === '23502') {
        // Not null violation
        message = 'Required field is missing';
        errorCode = 'REQUIRED_FIELD_MISSING';
      } else {
        message = 'Database operation failed';
        errorCode = 'DATABASE_ERROR';
      }

      this.logger.error(
        `Database error: ${dbError.message}`,
        dbError.stack,
        'DatabaseError',
      );
    } else if (exception instanceof Error) {
      message = exception.message || 'An unexpected error occurred';
      error = exception.name;

      this.logger.error(
        `Unhandled error: ${exception.message}`,
        exception.stack,
        'UnhandledError',
      );
    }

    const errorResponse: ErrorResponse = {
      statusCode: status,
      timestamp: new Date().toISOString(),
      path: request.url,
      method: request.method,
      message,
      error,
    };

    if (errorCode) {
      errorResponse.errorCode = errorCode;
    }

    // Log error for monitoring
    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `${request.method} ${request.url}`,
        JSON.stringify(errorResponse),
        'HttpExceptionFilter',
      );
    } else if (status >= HttpStatus.BAD_REQUEST) {
      this.logger.warn(
        `${request.method} ${request.url}`,
        JSON.stringify(errorResponse),
      );
    }

    response.status(status).json(errorResponse);
  }
}
