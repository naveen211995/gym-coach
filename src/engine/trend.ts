import type { TrendLabel, TrendSnapshot } from '../domain/types';
import { pctChange } from './metrics';
import { RULES } from './rules';
import { LOAD_EPS, type SessionEvaluation } from './sessionEval';
import { roundTo } from './units';

export interface TrendPoint {
  load: number | null;
  totalRepsAtLoad: number;
  performanceIndex: number;
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
      plannedReset,
      lowReadiness: lowReadiness[i] ?? false,
      incomplete: ev.missingCount > 0,
      outlier: ev.outlierPosition !== null,
    };
  });
}

const sameLoad = (a: number | null, b: number | null) => a !== null && b !== null && Math.abs(a - b) < LOAD_EPS;

/** Did session i beat everything before it in the current load block (or move up in load)? */
export function progressed(points: readonly TrendPoint[], i: number): boolean {
  const p = points[i];
  const q = points[i - 1];
  if (!p || !q || p.load === null || q.load === null) return false;
  if (p.load > q.load + LOAD_EPS) return true;
  if (p.load < q.load - LOAD_EPS) return false;
  let best = -Infinity;
  for (let k = i - 1; k >= 0; k--) {
    const pk = points[k] as TrendPoint;
    if (!sameLoad(pk.load, p.load)) break;
    best = Math.max(best, pk.totalRepsAtLoad);
    if (pk.plannedReset) break;
  }
  return p.totalRepsAtLoad > best;
}

function regressed(points: readonly TrendPoint[], i: number): boolean {
  const p = points[i];
  const q = points[i - 1];
  if (!p || !q || p.load === null || q.load === null) return false;
  if (p.load > q.load + LOAD_EPS) return false; // fewer reps after a load jump is expected
  if (sameLoad(p.load, q.load)) return p.totalRepsAtLoad < q.totalRepsAtLoad;
  const change = pctChange(q.performanceIndex, p.performanceIndex);
  return change !== null && change <= RULES.regressionPctAcrossLoads;
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
  for (let i = n - 1; i >= 1; i--) {
    const p = points[i] as TrendPoint;
    if (p.plannedReset) break;
    if ((p.lowReadiness || p.incomplete || p.outlier) && !progressed(points, i)) continue;
    if (regressed(points, i)) regressionCount++;
    else break;
  }

  const windowStart = Math.max(0, n - RULES.trendWindow);
  let progressedInWindow = 0;
  for (let i = Math.max(1, windowStart); i < n; i++) if (progressed(points, i)) progressedInWindow++;

  const first = points[windowStart];
  const last = points[n - 1];
  const changePct = first && last && n >= 2 ? pctChange(first.performanceIndex, last.performanceIndex) : null;

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
    notes,
  };
}
