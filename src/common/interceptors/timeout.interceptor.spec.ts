import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { lastValueFrom, of, timer } from 'rxjs';
import { map } from 'rxjs/operators';
import { AppError } from '../errors/app-errors';
import { TimeoutInterceptor } from './timeout.interceptor';

const ctx = {
  getType: () => 'http',
  getHandler: () => () => undefined,
  getClass: () => class {},
} as unknown as ExecutionContext;

describe('TimeoutInterceptor', () => {
  afterEach(() => delete process.env.REQUEST_TIMEOUT_MS);

  it('turns a slow handler into 504 TIMEOUT', async () => {
    process.env.REQUEST_TIMEOUT_MS = '20';
    const i = new TimeoutInterceptor(new Reflector());
    const slow = { handle: () => timer(200).pipe(map(() => 'late')) };
    const err = await lastValueFrom(i.intercept(ctx, slow)).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).getStatus()).toBe(504);
    expect((err as AppError).getResponse()).toEqual(
      expect.objectContaining({ code: 'TIMEOUT' }),
    );
  });

  it('passes fast handlers through', async () => {
    const i = new TimeoutInterceptor(new Reflector());
    await expect(
      lastValueFrom(i.intercept(ctx, { handle: () => of('ok') })),
    ).resolves.toBe('ok');
  });
});
