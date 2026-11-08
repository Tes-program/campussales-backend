/**
 * Hook for an external error tracker. Sentry (or similar) is NOT installed:
 * adding a third-party SDK needs the owner's approval (see docs/runbook.md,
 * "Error tracking"). Until then 5xx errors are logged as structured JSON with
 * the request id, which Railway's log search can find.
 *
 * To wire one in after approval: call setErrorReporter() in main.ts with a
 * function that forwards to the SDK, tagging requestId/route/user (hashed).
 */
export interface ErrorReport {
  requestId?: string;
  route?: string;
  status: number;
  userHash?: string;
}

type Reporter = (error: unknown, report: ErrorReport) => void;

let reporter: Reporter | null = null;

export function setErrorReporter(fn: Reporter | null): void {
  reporter = fn;
}

export function reportError(error: unknown, report: ErrorReport): void {
  try {
    reporter?.(error, report);
  } catch {
    // never let the tracker break error handling
  }
}
