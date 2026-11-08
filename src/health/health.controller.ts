import { Controller, Get, Header, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import type { Response } from 'express';
import { DataSource } from 'typeorm';
import { RateLimitService } from '../common/rate-limit/rate-limit.service';
import { SkipRateLimit } from '../common/rate-limit/rate-limit.decorator';
import { poolStats } from './db-pool';
import { lifecycle } from './lifecycle';

const DB_CHECK_TIMEOUT_MS = 2000;

export async function checkDatabase(
  ds: DataSource,
): Promise<{ ok: boolean; ms: number; error?: string }> {
  const start = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    if (!ds.isInitialized) throw new Error('not initialised');
    await Promise.race([
      ds.query('SELECT 1'),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('timed out')),
          DB_CHECK_TIMEOUT_MS,
        );
      }),
    ]);
    return { ok: true, ms: Date.now() - start };
  } catch (e) {
    return {
      ok: false,
      ms: Date.now() - start,
      error: (e as Error).message.slice(0, 120),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Served at the root (outside /api) for the host's health checks and uptime
 * monitors:
 *  - GET /health        process is up (cheap, no I/O): use for liveness/keep-warm
 *  - GET /health/ready  database reachable and not shutting down: use for
 *                       readiness and alerting
 */
@ApiTags('Health')
@Controller('health')
@SkipRateLimit()
export class HealthController {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly rateLimit: RateLimitService,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Liveness: the process is up.' })
  live() {
    return {
      status: 'ok',
      uptimeSeconds: Math.round((Date.now() - lifecycle.startedAt) / 1000),
      version: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
    };
  }

  @Get('ready')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Readiness: database reachable. 503 when it is not.',
  })
  async ready(@Res({ passthrough: true }) res: Response) {
    const database = await checkDatabase(this.ds);
    const redis = { ok: this.rateLimit.redisHealthy() };
    const ok = database.ok && !lifecycle.draining;
    res.status(ok ? 200 : 503);
    return {
      status: ok ? 'ok' : 'fail',
      draining: lifecycle.draining,
      checks: { database, redis },
      pool: poolStats(this.ds),
    };
  }
}
