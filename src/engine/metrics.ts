import { roundTo } from './units';

/**
 * Epley estimate. A trend indicator, not a measurement: accuracy drops quickly
 * above ~15 reps and it ignores technique, fatigue and exercise specifics.
 */
export function estimateOneRepMax(load: number, reps: number): number {
  if (!(load > 0) || !(reps > 0)) return 0;
  if (reps === 1) return load;
  return roundTo(load * (1 + reps / 30), 2);
}

export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  let s = 0;
  for (const v of values) s += v;
  return s / values.length;
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const hi = sorted[mid] as number;
  if (sorted.length % 2 === 1) return hi;
  const lo = sorted[mid - 1] as number;
  return (lo + hi) / 2;
}

export function clampInt(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

export function pctChange(from: number, to: number): number | null {
  if (!(from > 0)) return null;
  return ((to - from) / from) * 100;
}
