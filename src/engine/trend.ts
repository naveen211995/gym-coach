import type { TrendLabel, TrendSnapshot } from '../domain/types';
import { pctChange } from './metrics';
import { RULES } from './rules';
import { LOAD_EPS, type SessionEvaluation } from './sessionEval';
import { roundTo } from './units';

export interface TrendPoint {
  load: number | null;
  totalRepsAtLoad: number;
  performanceIndex: number;
  /** Summed reps-to-failure at the working load, or null when RIR was not usable. */
  capacityAtLoad: number | null;
  /** Failure-adjusted performance index, or null when RIR was not usable. */
  capacityIndex: number | null;
  /** The user followed a planned reduction (deload / decrease): streaks restart here. */
  plannedReset: boolean;
  /** Low-readiness session: excluded from stall/regression counting unless it progressed. */
  lowReadiness: boolean;
  /** Fewer sets than planned were logged: totals aren't comparable, so it is neutral for streaks. */
  incomplete: boolean;
  /** One set fell below range on its own (rule F): not counted as a regression. */
  outlier: boolean;
}

export interface TrendAnalysis extends TrendSnapshot {
  progressedInWindow: number;
  /** The current regression streak was detected from RIR, not from lost reps. */
  regressionFromRir: boolean;
  notes: string[];
}

export function toTrendPoints(evals: readonly SessionEvaluation[], lowReadiness: readonly boolean[]): TrendPoint[] {
  return evals.map((ev, i) => {
    const prev = i > 0 ? evals[i - 1] : undefined;
    const reduced = prev && prev.workingLoad !== null && ev.workingLoad !== null && ev.workingLoad < prev.workingLoad - LOAD_EPS;
    const plannedReset =
      ev.prescribedAction === 'deload' || (ev.prescribedAction === 'decrease-load' && Boolean(reduced));
    return {
      load: ev.workingLoad,
      totalRepsAtLoad: ev.totalRepsAtLoad,
      performanceIndex: ev.performanceIndex,
      capacityAtLoad: ev.capacityAtLoad,
      capacityIndex: ev.capacityIndex,
      plannedReset,
      lowReadiness: lowReadiness[i] ?? false,
      incomplete: ev.missingCount > 0,
      outlier: ev.outlierPosition !== null,
    };
  });
}

const sameLoad = (a: number | null, b: number | null) => a !== null && b !== null && Math.abs(a - b) < LOAD_EPS;

/** Best reps, and best capacity, reached before session i inside its load block. */
function blockBestBefore(points: readonly TrendPoint[], i: number): { reps: number; capacity: number | null } {
  const p = points[i] as TrendPoint;
  let reps = -Infinity;
  let capacity: number | null = null;
  for (let k = i - 1; k >= 0; k--) {
    const pk = points[k] as TrendPoint;
    if (!sameLoad(pk.load, p.load)) break;
    reps = Math.max(reps, pk.totalRepsAtLoad);
    if (pk.capacityAtLoad !== null) capacity = capacity === null ? pk.capacityAtLoad : Math.max(capacity, pk.capacityAtLoad);
    if (pk.plannedReset) break;
  }
  return { reps, capacity };
}

/** Did session i beat everything before it in the current load block (or move up in load)? */
export function progressed(points: readonly TrendPoint[], i: number): boolean {
  const p = points[i];
  const q = points[i - 1];
  if (!p || !q || p.load === null || q.load === null) return false;
  if (p.load > q.load + LOAD_EPS) return true;
  if (p.load < q.load - LOAD_EPS) return false;
  const best = blockBestBefore(points, i);
  if (p.totalRepsAtLoad > best.reps) return true;
  // The same reps further from failure is real progress the rep count can't see,
  // but only when RIR was usable on both sides of the comparison.
  if (p.totalRepsAtLoad >= best.reps && p.capacityAtLoad !== null && best.capacity !== null) {
    return p.capacityAtLoad - best.capacity >= RULES.capacityGainReps;
  }
  return false;
}

export interface Regression {
  yes: boolean;
  /** Detected from lost capacity (reps + RIR) rather than from lost reps. */
  fromRir: boolean;
}

const NO_REGRESSION: Regression = { yes: false, fromRir: false };

/**
 * A regression is a real drop, not a one-rep wobble: at the same load the reps
 * must fall by more than RULES.regressionRepTolerance, or the same reps must
 * have come appreciably closer to failure.
 */
function regressed(points: readonly TrendPoint[], i: number): Regression {
  const p = points[i];
  const q = points[i - 1];
  if (!p || !q || p.load === null || q.load === null) return NO_REGRESSION;
  if (p.load > q.load + LOAD_EPS) return NO_REGRESSION; // fewer reps after a load jump is expected
  if (sameLoad(p.load, q.load)) {
    if (p.totalRepsAtLoad < q.totalRepsAtLoad - RULES.regressionRepTolerance) return { yes: true, fromRir: false };
    if (
      p.capacityAtLoad !== null &&
      q.capacityAtLoad !== null &&
      p.totalRepsAtLoad <= q.totalRepsAtLoad &&
      q.capacityAtLoad - p.capacityAtLoad >= RULES.capacityDropReps
    ) {
      return { yes: true, fromRir: true };
    }
    return NO_REGRESSION;
  }
  // Across loads: compare like with like — failure-adjusted only if both sides have it.
  const bothCapacity = q.capacityIndex !== null && p.capacityIndex !== null;
  const change = bothCapacity
    ? pctChange(q.capacityIndex as number, p.capacityIndex as number)
    : pctChange(q.performanceIndex, p.performanceIndex);
  const yes = change !== null && change <= RULES.regressionPctAcrossLoads;
  return yes ? { yes, fromRir: bothCapacity } : NO_REGRESSION;
}

export function analyzeTrend(points: readonly TrendPoint[]): TrendAnalysis {
  const n = points.length;
  const notes: string[] = [];

  let stallCount = 0;
  for (let i = n - 1; i >= 1; i--) {
    const p = points[i] as TrendPoint;
    if (p.plannedReset) break;
    if (progressed(points, i)) break;
    if (p.lowReadiness || p.incomplete) continue;
    stallCount++;
  }

  let regressionCount = 0;
  let regressionFromRir = false;
  for (let i = n - 1; i >= 1; i--) {
    const p = points[i] as TrendPoint;
    if (p.plannedReset) break;
    if ((p.lowReadiness || p.incomplete || p.outlier) && !progressed(points, i)) continue;
    const r = regressed(points, i);
    if (!r.yes) break;
    if (regressionCount === 0) regressionFromRir = r.fromRir;
    regressionCount++;
  }

  const windowStart = Math.max(0, n - RULES.trendWindow);
  let progressedInWindow = 0;
  for (let i = Math.max(1, windowStart); i < n; i++) if (progressed(points, i)) progressedInWindow++;

  const first = points[windowStart];
  const last = points[n - 1];
  const bothCapacity = Boolean(first && last && first.capacityIndex !== null && last.capacityIndex !== null);
  const changePct =
    first && last && n >= 2
      ? bothCapacity
        ? pctChange(first.capacityIndex as number, last.capacityIndex as number)
        : pctChange(first.performanceIndex, last.performanceIndex)
      : null;

  let label: TrendLabel;
  if (n < 2) label = 'insufficient-data';
  else if (regressionCount >= RULES.regressionSessionsBeforeDeload) label = 'regressing';
  else if (stallCount >= RULES.plateauWarningAt) label = 'plateau';
  else if (progressedInWindow > 0) label = 'improving';
  else label = 'plateau';

  if (points.some((p, i) => i >= windowStart && p.lowReadiness)) notes.push('Low-readiness sessions are excluded from stall and regression counts.');
  if (points.some((p, i) => i >= windowStart && p.incomplete)) notes.push('Incomplete sessions are excluded from stall and regression counts.');

  return {
    label,
    windowSize: Math.min(n, RULES.trendWindow),
    changePct: changePct === null ? null : roundTo(changePct, 1),
    stallCount,
    regressionCount,
    progressedInWindow,
    regressionFromRir,
    notes,
  };
}
