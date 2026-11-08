/**
 * Work that must be flushed before the process exits (e.g. buffered
 * analytics events). Services register a callback; main.ts awaits them all
 * after the HTTP server has stopped accepting requests.
 */
const flushers = new Set<() => Promise<void>>();

export function onShutdownFlush(fn: () => Promise<void>): () => void {
  flushers.add(fn);
  return () => flushers.delete(fn);
}

export async function flushPendingWork(): Promise<void> {
  await Promise.allSettled([...flushers].map((fn) => fn()));
}
