import {
  ArgumentsHost,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { QueryFailedError } from 'typeorm';
import { HttpExceptionFilter } from './http-exception.filter';
import { ValidationFailed, conflict } from '../errors/app-errors';

function run(exception: unknown) {
  const res: Record<string, unknown> = {};
  const headers: Record<string, string> = {};
  const response = {
    headersSent: false,
    status(code: number): unknown {
      res.status = code;
      return response;
    },
    json(body: unknown): unknown {
      res.body = body;
      return response;
    },
    setHeader(k: string, v: string) {
      headers[k] = v;
    },
    getHeader: (k: string) => headers[k],
  };
  const request = {
    method: 'POST',
    url: '/api/products',
    requestId: 'req-12345678',
  };
  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => request,
    }),
  } as unknown as ArgumentsHost;
  const filter = new HttpExceptionFilter();
  (filter as unknown as { logger: object }).logger = {
    error: jest.fn(),
    warn: jest.fn(),
  };
  filter.catch(exception, host);
  return { status: res.status as number, body: res.body as any, headers };
}

describe('HttpExceptionFilter', () => {
  it('formats validation errors with fields and keeps legacy fields', () => {
    const { status, body, headers } = run(
      new ValidationFailed({ price: 'Price must be at least ₦50.' }),
    );
    expect(status).toBe(400);
    expect(body.error).toEqual({
      code: 'VALIDATION_FAILED',
      message: 'Please fix the highlighted fields.',
      fields: { price: 'Price must be at least ₦50.' },
      requestId: 'req-12345678',
    });
    expect(body.statusCode).toBe(400);
    expect(body.message).toEqual(['Price must be at least ₦50.']);
    expect(body.errorCode).toBe('VALIDATION_FAILED');
    expect(headers['X-Request-Id']).toBe('req-12345678');
  });

  it.each([
    [
      new UnauthorizedException(),
      401,
      'UNAUTHENTICATED',
      'Please log in to continue.',
    ],
    [
      new ForbiddenException(),
      403,
      'FORBIDDEN',
      'You do not have permission to perform this action.',
    ],
    [
      new NotFoundException('Cannot GET /api/nope'),
      404,
      'NOT_FOUND',
      "We couldn't find what you're looking for.",
    ],
    [
      new ThrottlerException(),
      429,
      'RATE_LIMITED',
      "You're doing that too often. Please wait a moment and try again.",
    ],
    [
      conflict('That number is already used on another account.'),
      409,
      'CONFLICT',
      'That number is already used on another account.',
    ],
  ])('maps %p to %p %p', (exception, status, code, message) => {
    const r = run(exception);
    expect(r.status).toBe(status);
    expect(r.body.error.code).toBe(code);
    expect(r.body.error.message).toBe(message);
  });

  it('keeps friendly messages from services', () => {
    expect(
      run(new NotFoundException('This item is no longer available.')).body.error
        .message,
    ).toBe('This item is no longer available.');
  });

  it('hides messages that contain internal ids', () => {
    const r = run(
      new NotFoundException(
        'Product 9f1e6a2c-3b4d-4e5f-8a9b-0c1d2e3f4a5b missing',
      ),
    );
    expect(r.body.error.message).not.toMatch(/9f1e6a2c/);
  });

  it('turns a default class-validator array into fields', () => {
    const r = run(
      new BadRequestException([
        'property foo should not exist',
        'price must be a number',
      ]),
    );
    expect(r.body.error.fields).toEqual({
      foo: "This field isn't accepted here.",
      price: "This value isn't valid.",
    });
  });

  it('never leaks stack traces or messages on 500', () => {
    const r = run(
      new Error('relation "secret_table" does not exist at /app/src/x.ts:12'),
    );
    expect(r.status).toBe(500);
    expect(r.body.error).toEqual({
      code: 'SERVER_ERROR',
      message:
        'Something went wrong on our side. Please try again in a moment.',
      requestId: 'req-12345678',
    });
    expect(JSON.stringify(r.body)).not.toMatch(/secret_table|\.ts:|stack/);
  });

  it('maps unique violations to 409 and unknown DB errors to 500', () => {
    const unique = Object.assign(
      new QueryFailedError('INSERT', [], new Error('dup')),
      { code: '23505' },
    );
    expect(run(unique).status).toBe(409);
    const other = Object.assign(
      new QueryFailedError('SELECT', [], new Error('boom')),
      { code: '42P01' },
    );
    expect(run(other).status).toBe(500);
  });

  it('handles malformed JSON bodies as 400', () => {
    const err = Object.assign(new SyntaxError('Unexpected token } in JSON'), {
      status: 400,
      type: 'entity.parse.failed',
    });
    const r = run(err);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('VALIDATION_FAILED');
    expect(r.body.error.message).toBe(
      "We couldn't read that request. Please try again.",
    );
  });
});
