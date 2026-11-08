import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  metrics,
  METRIC,
  MetricsRegistry,
} from '../common/observability/metrics';
import { EmailService } from '../common/services/email.service';
import { poolSaturated, poolStats, PoolStats } from './db-pool';
import { checkDatabase } from './health.controller';

export interface AlertRule {
  key: string;
  /** Human-readable summary when firing, or null when healthy. */
  check: () => string | null;
}

export const ALERT_THRESHOLDS = {
  errorRate: 0.02, // > 2% 5xx ...
  errorRateWindowMs: 5 * 60_000, // ... over 5 minutes
  errorRateMinRequests: 50, // ignore tiny samples (one 500 out of 10 requests)
  p95Ms: 1000, // p95 > 1 s ...
  p95WindowMs: 10 * 60_000, // ... over 10 minutes
  p95MinRequests: 50,
  signupFailures: 10, // failed signups / onboarding submits per 15 min
  emailFailures: 3, // failed sends per 15 min
  poolSaturatedChecks: 3, // consecutive minutes with requests waiting for a connection
  dbDownChecks: 2, // consecutive failed readiness checks
  repeatAfterMs: 30 * 60_000, // re-alert while still firing
} as const;

/**
 * Pure evaluation, separated for unit tests. Returns the alerts that should
 * fire given the metrics and the latest infrastructure checks.
 */
export function evaluateAlerts(
  m: MetricsRegistry,
  state: {
    dbFailures: number;
    poolSaturatedStreak: number;
    pool: PoolStats | null;
  },
  now = Date.now(),
): Array<{ key: string; message: string }> {
  const T = ALERT_THRESHOLDS;
  const out: Array<{ key: string; message: string }> = [];

  const err = m.summary(T.errorRateWindowMs, now);
  if (err.requests >= T.errorRateMinRequests && err.errorRate > T.errorRate) {
    out.push({
      key: 'error_rate',
      message: `Error rate ${(err.errorRate * 100).toFixed(1)}% over the last 5 minutes (${err.requests} requests).`,
    });
  }
  const lat = m.summary(T.p95WindowMs, now);
  if (lat.requests >= T.p95MinRequests && lat.p95 > T.p95Ms) {
    const slowest = m
      .byRoute(T.p95WindowMs, now)
      .filter((r) => r.count >= 5)
      .sort((a, b) => b.p95 - a.p95)
      .slice(0, 3)
      .map((r) => `${r.route} p95 ${r.p95}ms`)
      .join('; ');
    out.push({
      key: 'latency_p95',
      message: `p95 latency ${lat.p95}ms over the last 10 minutes. Slowest: ${slowest}`,
    });
  }
  const signup =
    m.countSince(METRIC.signupFailed, 15 * 60_000, now) +
    m.countSince(METRIC.onboardingFailed, 15 * 60_000, now);
  if (signup >= T.signupFailures) {
    out.push({
      key: 'signup_failures',
      message: `${signup} signup/onboarding submissions failed in the last 15 minutes.`,
    });
  }
  const email = m.countSince(METRIC.emailFailed, 15 * 60_000, now);
  if (email >= T.emailFailures) {
    out.push({
      key: 'email_failures',
      message: `${email} emails failed to send in the last 15 minutes. Check the SMTP provider.`,
    });
  }
  if (state.poolSaturatedStreak >= T.poolSaturatedChecks && state.pool) {
    out.push({
      key: 'db_pool_saturated',
      message: `Database pool saturated for ${state.poolSaturatedStreak} minutes (${state.pool.total}/${state.pool.max} busy, ${state.pool.waiting} waiting).`,
    });
  }
  if (state.dbFailures >= T.dbDownChecks) {
    out.push({
      key: 'db_down',
      message: `Database unreachable for ${state.dbFailures} consecutive checks. /health/ready is failing.`,
    });
  }
  return out;
}

/**
 * Checks the alert rules every minute and notifies ALERT_WEBHOOK_URL (a
 * Slack incoming webhook) and/or ADMIN_ALERT_EMAIL. Each alert repeats at
 * most every 30 minutes while it keeps firing, and a "resolved" message is
 * sent when it clears. Per instance; an external uptime monitor on
 * /health/ready covers the case where the whole service is down.
 */
@Injectable()
export class AlertsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Alerts');
  private timer: NodeJS.Timeout | null = null;
  private dbFailures = 0;
  private poolSaturatedStreak = 0;
  private readonly firing = new Map<string, number>();

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly email: EmailService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.tick(), 60_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(now = Date.now()): Promise<string[]> {
    const db = await checkDatabase(this.ds);
    this.dbFailures = db.ok ? 0 : this.dbFailures + 1;
    const pool = poolStats(this.ds);
    this.poolSaturatedStreak = poolSaturated(pool)
      ? this.poolSaturatedStreak + 1
      : 0;
    const active = evaluateAlerts(
      metrics,
      {
        dbFailures: this.dbFailures,
        poolSaturatedStreak: this.poolSaturatedStreak,
        pool,
      },
      now,
    );
    const sent: string[] = [];
    for (const a of active) {
      const last = this.firing.get(a.key);
      if (last && now - last < ALERT_THRESHOLDS.repeatAfterMs) continue;
      this.firing.set(a.key, now);
      await this.notify(`[ALERT] ${a.key}`, a.message);
      sent.push(a.key);
    }
    for (const key of [...this.firing.keys()]) {
      if (!active.some((a) => a.key === key)) {
        this.firing.delete(key);
        await this.notify(`[RESOLVED] ${key}`, `${key} is back to normal.`);
        sent.push(`resolved:${key}`);
      }
    }
    return sent;
  }

  async notify(subject: string, message: string): Promise<void> {
    const env = this.config.get<string>('NODE_ENV') || 'development';
    const text = `CampusSales ${env}: ${subject} ${message}`;
    this.logger.warn(text);
    const webhook = this.config.get<string>('ALERT_WEBHOOK_URL');
    if (webhook) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 5000);
        await fetch(webhook, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text }),
          signal: ctrl.signal,
        });
        clearTimeout(t);
      } catch (e) {
        this.logger.error(`Alert webhook failed: ${(e as Error).message}`);
      }
    }
    const to =
      this.config.get<string>('ALERT_EMAIL') ||
      this.config.get<string>('ADMIN_ALERT_EMAIL');
    if (to) {
      await this.email.sendNotice(to, `CampusSales ${env} ${subject}`, [
        message,
        'Runbook: docs/runbook.md',
      ]);
    }
  }
}
