import { DataSource } from 'typeorm';

export interface PoolStats {
  max: number;
  total: number;
  idle: number;
  waiting: number;
}

/** Live numbers from node-postgres' pool behind TypeORM (null if unavailable). */
export function poolStats(ds: DataSource): PoolStats | null {
  const pool = (
    ds.driver as unknown as {
      master?: {
        totalCount: number;
        idleCount: number;
        waitingCount: number;
        options?: { max?: number };
      };
    }
  ).master;
  if (!pool || typeof pool.totalCount !== 'number') return null;
  return {
    max: pool.options?.max ?? 10,
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
  };
}

/** Saturated: every connection busy and requests queueing for one. */
export function poolSaturated(s: PoolStats | null): boolean {
  return !!s && s.total >= s.max && s.idle === 0 && s.waiting > 0;
}
