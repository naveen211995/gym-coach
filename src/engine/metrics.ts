import { RULES } from './rules';
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

/** Reps a set could have reached: what was performed plus what was left in reserve. */
export function repsToFailure(reps: number, rir: number | null): number {
  if (!(reps > 0)) return 0;
  const reserve = rir !== null && Number.isFinite(rir) && rir > 0 ? rir : 0;
  return reps + reserve;
}

/**
 * Estimated max from a set, accounting for how close it came to failure.
 *
 * A set stopped with reps in reserve was not a maximal effort: 100 x 10 @ RIR 0
 * and 100 x 10 @ RIR 4 are very different performances, and estimating both
 * from 10 reps makes them identical. The estimate therefore uses reps + RIR,
 * capped at RULES.e1rmReliableMaxReps because Epley drifts badly past ~15.
 */
export function estimateMaxFromSet(load: number, reps: number, rir: number | null): number {
  if (!(load > 0) || !(reps > 0)) return 0;
  return estimateOneRepMax(load, Math.min(repsToFailure(reps, rir), RULES.e1rmReliableMaxReps));
}

/**
 * Reps expected at a different load, from the load-rep tradeoff: rep-max tables
 * put one rep at roughly 2.5-3% of load, so moving the load costs or returns
 * reps at RULES.repsPerPercentLoad per percent. A prediction, not a promise —
 * the engine clamps it into the configured rep range.
 */
export function predictRepsAtLoad(reps: number, fromLoad: number, toLoad: number): number | null {
  if (!(reps > 0) || !(fromLoad > 0) || !(toLoad > 0)) return null;
  const pct = ((toLoad - fromLoad) / fromLoad) * 100;
  return Math.round(reps - pct * RULES.repsPerPercentLoad);
}

/** Load change as a percentage of the starting load. */
export function loadChangePercent(from: number, to: number): number | null {
  if (!(from > 0)) return null;
  return roundTo(((to - from) / from) * 100, 2);
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
