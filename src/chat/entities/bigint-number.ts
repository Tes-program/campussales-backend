import { ValueTransformer } from 'typeorm';

/** Postgres bigint arrives as a string; sequence numbers fit in a JS number. */
export const bigintNumber: ValueTransformer = {
  to: (v: unknown) => v,
  from: (v: unknown) => (v === null || v === undefined ? v : Number(v)),
};
