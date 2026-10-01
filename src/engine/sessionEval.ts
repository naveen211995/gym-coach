import type {
  EquipmentType,
  ExerciseSession,
  PainLevel,
  ProgressionConfig,
  RecommendationAction,
  Unit,
} from '../domain/types';
import { estimateOneRepMax, mean, median } from './metrics';
import { RULES } from './rules';
import { convertLoadRounded, roundTo } from './units';

export const LOAD_EPS = 1e-6;

/** The subset of an Exercise the engine needs. */
export interface EngineExercise {
  id: string;
  unit: Unit;
  equipment: EquipmentType;
  progression: ProgressionConfig;
}

export interface NormalizedSet {
  /** Original set index (0-based) in the session. */
  index: number;
  /** Load in the exercise unit. */
  load: number;
  reps: number;
  rir: number | null;
  confidence: number | null;
  failed: boolean;
  atWorkingLoad: boolean;
  e1rm: number;
}

export interface RirAssessment {
  average: number | null;
  coverage: number;
  averageConfidence: number | null;
  /** 0–1: how much RIR is allowed to influence the decision. */
  weight: number;
  /** average − target (raw). */
  deviation: number | null;
  /** deviation × weight. */
  effectiveDeviation: number | null;
  reliable: boolean;
  inconsistent: boolean;
  values: number[];
}

export interface SessionEvaluation {
  sessionId: string;
  completedAt: string;
  plannedSets: number;
  prescribedAction: RecommendationAction;
  /** First `plannedSets` performed sets — these drive progression. */
  working: NormalizedSet[];
  /** Performed sets beyond the plan (count for records, not for progression). */
  extras: NormalizedSet[];
  missingCount: number;
  skippedCount: number;
  failedCount: number;
  workingLoad: number | null;
  mixedLoads: boolean;
  unitConverted: boolean;
  topCount: number;
  belowMinCount: number;
  essentiallyAllTop: boolean;
  toleranceUsed: boolean;
  majorityTop: boolean;
  clearlyBelowMin: boolean;
  /** Position within `working` of a single low set that should not drive decisions. */
  outlierPosition: number | null;
  allAtLeastMin: boolean;
  totalReps: number;
  totalRepsAtLoad: number;
  volume: number;
  medianE1rm: number;
  bestE1rm: number;
  /** Trend indicator: median e1RM, or total reps/seconds when there is no external load. */
  performanceIndex: number;
  rir: RirAssessment;
  pain: PainLevel;
  warnings: string[];
}

export interface EvaluationOptions {
  defaultRirConfidence: number;
}

function validConfidence(c: number | null | undefined): c is number {
  return typeof c === 'number' && Number.isInteger(c) && c >= 1 && c <= 5;
}

function workingLoadOf(sets: readonly NormalizedSet[]): number | null {
  if (sets.length === 0) return null;
  const counts = new Map<number, number>();
  for (const s of sets) {
    const k = roundTo(s.load, 3);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  let best: number | null = null;
  let bestCount = -1;
  for (const [load, count] of counts) {
    // Most common load; ties resolve to the LOWER load (conservative).
    if (count > bestCount || (count === bestCount && best !== null && load < best)) {
      best = load;
      bestCount = count;
    }
  }
  return best;
}

function assessRir(working: readonly NormalizedSet[], targetRir: number): RirAssessment {
  const withRir = working.filter((s) => s.rir !== null);
  const values = withRir.map((s) => s.rir as number);
  const coverage = working.length ? withRir.length / working.length : 0;
  const average = mean(values);
  const averageConfidence = mean(withRir.map((s) => s.confidence ?? 0));

  let inconsistent = false;
  if (values.length >= 2) {
    const spread = Math.max(...values) - Math.min(...values);
    if (spread >= RULES.rirInconsistentSpread) inconsistent = true;
    for (let i = 0; i < withRir.length && !inconsistent; i++) {
      for (let j = i + 1; j < withRir.length; j++) {
        const a = withRir[i] as NormalizedSet;
        const b = withRir[j] as NormalizedSet;
        if (Math.abs(a.load - b.load) < LOAD_EPS && (b.rir as number) - (a.rir as number) >= RULES.rirInconsistentJump && b.reps <= a.reps) {
          inconsistent = true;
          break;
        }
      }
    }
  }

  const baseWeight = averageConfidence === null ? 0 : Math.max(0, Math.min(1, (averageConfidence - 1) / 4));
  const weight = coverage + 1e-9 >= RULES.rirMinCoverage ? baseWeight * (inconsistent ? RULES.rirInconsistentPenalty : 1) : 0;
  const deviation = average === null ? null : average - targetRir;
  const effectiveDeviation = deviation === null ? null : roundTo(deviation * weight, 4);
  return {
    average: average === null ? null : roundTo(average, 2),
    coverage,
    averageConfidence: averageConfidence === null ? null : roundTo(averageConfidence, 2),
    weight: roundTo(weight, 4),
    deviation: deviation === null ? null : roundTo(deviation, 2),
    effectiveDeviation,
    reliable: weight + 1e-9 >= RULES.rirMinWeight && average !== null,
    inconsistent,
    values,
  };
}

/**
 * Turn a raw ExerciseSession into normalized facts. Never throws: bad values are
 * dropped with a warning so one typo can't break the recommendation.
 */
export function evaluateSession(
  session: ExerciseSession,
  exercise: EngineExercise,
  options: EvaluationOptions,
): SessionEvaluation {
  const cfg = exercise.progression;
  const warnings: string[] = [];
  const presSets = session.prescribed?.sets;
  const plannedSets = typeof presSets === 'number' && Number.isInteger(presSets) && presSets >= 1 && presSets <= 10 ? presSets : cfg.workingSets;
  const bodyweight = exercise.equipment === 'bodyweight' || cfg.strategy === 'time-based';

  let skippedCount = 0;
  let failedCount = 0;
  let unitConverted = false;
  const performed: NormalizedSet[] = [];
  const sorted = [...(session.sets ?? [])].sort((a, b) => a.index - b.index);

  sorted.forEach((set, pos) => {
    const label = `Set ${pos + 1}`;
    if (set.status === 'skipped') {
      skippedCount++;
      return;
    }
    if (set.status !== 'completed' && set.status !== 'failed') return; // pending → missing
    const failed = set.status === 'failed';

    const reps = set.reps;
    if (reps === null || typeof reps !== 'number' || !Number.isFinite(reps) || reps < 0) {
      warnings.push(`${label} has no valid reps and was ignored.`);
      return;
    }
    let load = set.load;
    if (load === null || load === undefined) {
      if (!bodyweight) {
        warnings.push(`${label} has no weight and was ignored.`);
        return;
      }
      load = 0;
    }
    if (typeof load !== 'number' || !Number.isFinite(load) || load < 0) {
      warnings.push(`${label} has an invalid weight and was ignored.`);
      return;
    }
    if (set.unit && set.unit !== exercise.unit) {
      load = convertLoadRounded(load, set.unit, exercise.unit);
      unitConverted = true;
    }

    let rir: number | null = null;
    if (failed) {
      rir = 0; // a failed set is by definition at (or past) failure
    } else if (typeof set.rir === 'number' && Number.isFinite(set.rir)) {
      if (set.rir < 0 || set.rir > 10) warnings.push(`${label} RIR ${set.rir} was clamped to 0–10.`);
      rir = Math.max(0, Math.min(10, set.rir));
    }
    const confidence = rir === null ? null : validConfidence(set.rirConfidence) ? set.rirConfidence : failed ? 5 : options.defaultRirConfidence;
    if (failed) failedCount++;
    const r = Math.round(reps);
    performed.push({ index: set.index, load, reps: r, rir, confidence, failed, atWorkingLoad: false, e1rm: estimateOneRepMax(load, r) });
  });

  const working = performed.slice(0, plannedSets);
  const extras = performed.slice(plannedSets);
  if (extras.length) warnings.push(`${extras.length} extra set${extras.length > 1 ? 's' : ''} beyond the plan counted for records only.`);

  const workingLoad = workingLoadOf(working);
  for (const s of working) s.atWorkingLoad = workingLoad !== null && s.load >= workingLoad - LOAD_EPS;
  const mixedLoads = new Set(working.map((s) => roundTo(s.load, 3))).size > 1;

  const topCount = working.filter((s) => s.atWorkingLoad && s.reps >= cfg.maxReps).length;
  const belowMinCount = working.filter((s) => s.reps < cfg.minReps).length;
  const complete = working.length >= plannedSets;

  let essentiallyAllTop = false;
  let toleranceUsed = false;
  if (complete) {
    if (topCount >= plannedSets) essentiallyAllTop = true;
    else if (plannedSets >= RULES.topToleranceMinSets && topCount === plannedSets - 1) {
      const other = working.find((s) => !(s.atWorkingLoad && s.reps >= cfg.maxReps));
      if (other && other.atWorkingLoad && other.reps >= cfg.maxReps - RULES.topToleranceReps) {
        essentiallyAllTop = true;
        toleranceUsed = true;
      }
    }
  }

  const majorityTop = plannedSets >= 2 && topCount >= Math.ceil(plannedSets / 2);
  const clearlyBelowMin = working.length > 0 && belowMinCount >= Math.max(1, Math.ceil(plannedSets / 2));
  let outlierPosition: number | null = null;
  if (!clearlyBelowMin && belowMinCount === 1 && working.length >= 2) {
    outlierPosition = working.findIndex((s) => s.reps < cfg.minReps);
  }

  let allAtLeastMin = false;
  if (complete && working.every((s) => s.atWorkingLoad)) {
    const short = working.filter((s) => s.reps < cfg.minReps);
    allAtLeastMin =
      short.length === 0 ||
      (plannedSets >= RULES.topToleranceMinSets && short.length === 1 && (short[0] as NormalizedSet).reps >= cfg.minReps - RULES.topToleranceReps);
  }

  const totalReps = working.reduce((a, s) => a + s.reps, 0);
  const totalRepsAtLoad = working.filter((s) => s.atWorkingLoad).reduce((a, s) => a + s.reps, 0);
  const volume = roundTo(performed.reduce((a, s) => a + s.load * s.reps, 0), 2);
  const e1rms = working.map((s) => s.e1rm);
  const medianE1rm = roundTo(median(e1rms) ?? 0, 2);
  const bestE1rm = roundTo(Math.max(0, ...performed.map((s) => s.e1rm)), 2);
  const performanceIndex = cfg.strategy === 'time-based' || !(workingLoad !== null && workingLoad > 0) ? totalReps : medianE1rm;

  return {
    sessionId: session.id,
    completedAt: session.completedAt ?? '',
    plannedSets,
    prescribedAction: session.prescribed?.action ?? 'maintain',
    working,
    extras,
    missingCount: Math.max(0, plannedSets - working.length),
    skippedCount,
    failedCount,
    workingLoad,
    mixedLoads,
    unitConverted,
    topCount,
    belowMinCount,
    essentiallyAllTop,
    toleranceUsed,
    majorityTop,
    clearlyBelowMin,
    outlierPosition,
    allAtLeastMin,
    totalReps,
    totalRepsAtLoad,
    volume,
    medianE1rm,
    bestE1rm,
    performanceIndex,
    rir: assessRir(working, cfg.targetRir),
    pain: session.pain ?? 'none',
    warnings,
  };
}
