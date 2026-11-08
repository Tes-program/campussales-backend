/**
 * In-process metrics for alerting and for docs/perf-baseline.md reports.
 *
 * Keeps the last 15 minutes of request samples (route, status, duration, db
 * time) in a ring buffer, plus simple counters for business failures (signup,
 * onboarding, email). Each API instance has its own view; with one instance
 * on Railway that is the whole picture. Exposed to admins at
 * GET /api/admin/metrics and evaluated every minute by AlertsService.
 */
export interface RequestSample {
  at: number;
  route: string;
  status: number;
  ms: number;
  dbMs: number;
  bytes: number;
}

export interface RouteStats {
  route: string;
  count: number;
  errors5xx: number;
  p50: number;
  p95: number;
  p99: number;
  avgDbMs: number;
  avgBytes: number;
}

const WINDOW_MS = 15 * 60_000;
const MAX_SAMPLES = 50_000;

export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[i];
}

const round = (v: number) => Math.round(v * 10) / 10;

export class MetricsRegistry {
  private samples: RequestSample[] = [];
  private head = 0;
  private counters = new Map<string, number[]>();

  record(sample: RequestSample): void {
    if (this.samples.length < MAX_SAMPLES) this.samples.push(sample);
    else {
      this.samples[this.head] = sample;
      this.head = (this.head + 1) % MAX_SAMPLES;
    }
  }

  /** Counts a named event (e.g. 'email_failed') at the current time. */
  count(name: string, at = Date.now()): void {
    const list = this.counters.get(name) ?? [];
    list.push(at);
    // keep the window bounded
    while (list.length && list[0] < at - WINDOW_MS) list.shift();
    this.counters.set(name, list);
  }

  countSince(name: string, windowMs: number, now = Date.now()): number {
    return (this.counters.get(name) ?? []).filter((t) => t > now - windowMs)
      .length;
  }

  since(windowMs: number, now = Date.now()): RequestSample[] {
    const from = now - Math.min(windowMs, WINDOW_MS);
    return this.samples.filter((s) => s.at > from);
  }

  summary(windowMs: number, now = Date.now()) {
    const samples = this.since(windowMs, now);
    const all = samples.map((s) => s.ms).sort((a, b) => a - b);
    const errors = samples.filter((s) => s.status >= 500).length;
    return {
      windowMinutes: Math.round(windowMs / 60_000),
      requests: samples.length,
      errorRate: samples.length ? errors / samples.length : 0,
      p50: round(percentile(all, 50)),
      p95: round(percentile(all, 95)),
      p99: round(percentile(all, 99)),
    };
  }

  byRoute(windowMs: number, now = Date.now()): RouteStats[] {
    const groups = new Map<string, RequestSample[]>();
    for (const s of this.since(windowMs, now)) {
      const g = groups.get(s.route) ?? [];
      g.push(s);
      groups.set(s.route, g);
    }
    return [...groups.entries()]
      .map(([route, list]) => {
        const ms = list.map((s) => s.ms).sort((a, b) => a - b);
        return {
          route,
          count: list.length,
          errors5xx: list.filter((s) => s.status >= 500).length,
          p50: round(percentile(ms, 50)),
          p95: round(percentile(ms, 95)),
          p99: round(percentile(ms, 99)),
          avgDbMs: round(list.reduce((a, s) => a + s.dbMs, 0) / list.length),
          avgBytes: Math.round(
            list.reduce((a, s) => a + s.bytes, 0) / list.length,
          ),
        };
      })
      .sort((a, b) => b.count - a.count);
  }

  reset(): void {
    this.samples = [];
    this.head = 0;
    this.counters.clear();
  }
}

export const metrics = new MetricsRegistry();

/** Business failure counters the alerts watch. */
export const METRIC = {
  signupFailed: 'signup_failed',
  onboardingFailed: 'onboarding_failed',
  emailFailed: 'email_failed',
  emailSent: 'email_sent',
  eventsDropped: 'events_dropped',
} as const;
