import { metrics, percentile } from '../common/observability/metrics';

/**
 * Chat observability (C1), per instance, last 15 minutes:
 *  - messages sent, send failures (server errors) and refusals by error code
 *  - send duration (server side, p50/p95) and delivery latency (saved ->
 *    recipient socket ack, p50/p95)
 *  - socket connections (current), connects, reconnects, disconnects
 * Exposed at GET /api/admin/metrics (`chat`) and watched by AlertsService
 * (send failure rate over 2%). Never holds message text.
 */
export const CHAT_METRIC = {
  sent: 'chat_sent',
  failed: 'chat_send_failed',
  refused: 'chat_send_refused',
  connect: 'chat_socket_connect',
  reconnect: 'chat_socket_reconnect',
  disconnect: 'chat_socket_disconnect',
} as const;

const WINDOW_MS = 15 * 60_000;
const MAX = 20_000;
const round = (v: number) => Math.round(v * 10) / 10;

class Samples {
  private list: Array<{ at: number; ms: number }> = [];
  add(ms: number, at = Date.now()) {
    this.list.push({ at, ms });
    if (this.list.length > MAX) this.list.splice(0, this.list.length - MAX);
  }
  stats(windowMs: number, now = Date.now()) {
    const ms = this.list
      .filter((s) => s.at > now - Math.min(windowMs, WINDOW_MS))
      .map((s) => s.ms)
      .sort((a, b) => a - b);
    return {
      count: ms.length,
      p50: round(percentile(ms, 50)),
      p95: round(percentile(ms, 95)),
    };
  }
  reset() {
    this.list = [];
  }
}

class ChatMetrics {
  readonly sendMs = new Samples();
  readonly deliveryMs = new Samples();
  readonly errorCodes = new Map<string, number[]>();
  connections = 0;

  sent(ms: number) {
    metrics.count(CHAT_METRIC.sent);
    this.sendMs.add(ms);
  }

  /** Expected refusals (BLOCKED, RATE_LIMITED, TOO_LONG...) vs real failures (5xx). */
  sendError(code: string, serverError: boolean) {
    metrics.count(serverError ? CHAT_METRIC.failed : CHAT_METRIC.refused);
    const now = Date.now();
    const list = (this.errorCodes.get(code) ?? []).filter(
      (t) => t > now - WINDOW_MS,
    );
    list.push(now);
    this.errorCodes.set(code, list);
  }

  delivered(ms: number) {
    this.deliveryMs.add(Math.max(0, ms));
  }

  snapshot(windowMs: number, now = Date.now()) {
    const sent = metrics.countSince(CHAT_METRIC.sent, windowMs, now);
    const failed = metrics.countSince(CHAT_METRIC.failed, windowMs, now);
    const errors: Record<string, number> = {};
    for (const [code, list] of this.errorCodes) {
      const n = list.filter((t) => t > now - windowMs).length;
      if (n) errors[code] = n;
    }
    return {
      messagesSent: sent,
      sendFailures: failed,
      failureRate: sent + failed ? failed / (sent + failed) : 0,
      sendErrorsByCode: errors,
      sendMs: this.sendMs.stats(windowMs, now),
      deliveryMs: this.deliveryMs.stats(windowMs, now),
      sockets: {
        connected: this.connections,
        connects: metrics.countSince(CHAT_METRIC.connect, windowMs, now),
        reconnects: metrics.countSince(CHAT_METRIC.reconnect, windowMs, now),
        disconnects: metrics.countSince(CHAT_METRIC.disconnect, windowMs, now),
      },
    };
  }

  reset() {
    this.sendMs.reset();
    this.deliveryMs.reset();
    this.errorCodes.clear();
    this.connections = 0;
  }
}

export const chatMetrics = new ChatMetrics();
