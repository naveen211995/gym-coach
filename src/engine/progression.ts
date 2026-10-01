/**
 * Progression engine — pure, deterministic, rule-based.
 *
 * recommendNext(history) → the next-session target plus the rule that produced it
 * and plain-language reasons. No I/O, no clock, no randomness: the same input
 * always yields the same output.
 *
 * Decision order (first match wins):
 *   invalid config → no usable data → pain → post-deload resume → deload
 *   → strategy rules (below range / top of range / RIR modifiers / add reps)
 *   → mild-pain guard → bounds.
 */
import type {
  Direction,
  ExerciseSession,
  NextTarget,
  ReadinessRecord,
  RecommendationAction,
  RecommendationFlag,
  TrendSnapshot,
} from '../domain/types';
import { clampInt, mean } from './metrics';
import { isLowReadiness } from './readiness';
import { RULES } from './rules';
import { evaluateSession, LOAD_EPS, type EngineExercise, type EvaluationOptions, type SessionEvaluation } from './sessionEval';
import { analyzeTrend, toTrendPoints, type TrendAnalysis } from './trend';
import { addLoad, formatLoad, formatNumber, roundTo, snapToStep } from './units';
import { validateProgressionConfig } from './validation';

export interface EngineHistoryEntry {
  session: ExerciseSession;
  readiness: ReadinessRecord | null;
}

export interface EngineInput {
  exercise: EngineExercise;
  /** Completed sessions of this exercise. Order doesn't matter; the engine sorts by completion time. */
  history: readonly EngineHistoryEntry[];
  options?: Partial<EvaluationOptions>;
}

export interface EngineResult {
  action: RecommendationAction;
  direction: Direction;
  target: NextTarget;
  previous: { load: number | null; reps: number[]; unit: EngineExercise['unit'] } | null;
  summary: string;
  reasons: string[];
  ruleId: string;
  flags: RecommendationFlag[];
  trend: TrendSnapshot;
  warnings: string[];
  evaluation: SessionEvaluation | null;
}

interface Draft {
  action: RecommendationAction;
  ruleId: string;
  load: number | null;
  repTargets: number[];
  sets: number;
  targetRir: number;
  reasons: string[];
  summary?: string;
}

interface Ctx {
  exercise: EngineExercise;
  ev: SessionEvaluation;
  prev: SessionEvaluation | undefined;
  trend: TrendAnalysis;
  lowReadinessLatest: boolean;
  /** Working load used as the base for the next target (snapped if it came from a unit conversion). */
  load: number;
  flags: Set<RecommendationFlag>;
}

const DEFAULT_OPTIONS: EvaluationOptions = { defaultRirConfidence: 4 };
const EMPTY_TREND: TrendSnapshot = { label: 'insufficient-data', windowSize: 0, changePct: null, stallCount: 0, regressionCount: 0 };

// ───────────────────────── formatting helpers ─────────────────────────

const isTime = (x: EngineExercise) => x.progression.strategy === 'time-based';
const fmtReps = (x: EngineExercise, reps: readonly number[]) => reps.map((r) => (isTime(x) ? `${r}s` : `${r}`)).join('/');
const fmtLoad = (x: EngineExercise, load: number | null) => formatLoad(load, x.unit);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

function perfText(x: EngineExercise, ev: SessionEvaluation): string {
  const reps = ev.working.map((s) => s.reps);
  const rir = ev.working.every((s) => s.rir !== null) && ev.working.length > 0 ? ` @ RIR ${ev.working.map((s) => formatNumber(s.rir as number)).join('/')}` : '';
  return `${fmtLoad(x, ev.workingLoad)} × ${fmtReps(x, reps)}${rir}`;
}

function rirNote(ctx: Ctx): string {
  const { ev, exercise } = ctx;
  const r = ev.rir;
  const t = exercise.progression.targetRir;
  if (r.average === null) return 'No RIR was logged, so the decision uses reps and load only.';
  if (r.coverage + 1e-9 < RULES.rirMinCoverage) return 'RIR was logged on too few sets to count; the decision uses reps and load.';
  if (!r.reliable) {
    if (r.inconsistent) {
      ctx.flags.add('inconsistent-rir');
      return `RIR looked inconsistent across sets (${r.values.map((v) => formatNumber(v)).join(' → ')}), so it carried little weight.`;
    }
    ctx.flags.add('low-rir-confidence');
    return `RIR confidence was low (${formatNumber(r.averageConfidence ?? 0, 1)}/5), so RIR didn't drive this decision.`;
  }
  const extras: string[] = [];
  if (r.inconsistent) {
    ctx.flags.add('inconsistent-rir');
    extras.push('inconsistent, counted at reduced weight');
  } else if (r.weight < 1) extras.push(`${Math.round(r.weight * 100)}% weight from confidence`);
  return `Average RIR ${formatNumber(r.average, 1)} vs target ${formatNumber(t)}${extras.length ? ` (${extras.join('; ')})` : ''}.`;
}

// ───────────────────────── load helpers ─────────────────────────

function canIncrease(ctx: Ctx): boolean {
  const c = ctx.exercise.progression;
  return c.loadIncrement > 0 && (c.maxLoad === null || ctx.load < c.maxLoad - LOAD_EPS);
}

function increaseLoad(ctx: Ctx, increments: number): number {
  const c = ctx.exercise.progression;
  let next = addLoad(ctx.load, roundTo(c.loadIncrement * increments, 4));
  if (c.maxLoad !== null && next > c.maxLoad + LOAD_EPS) next = Math.max(ctx.load, c.maxLoad);
  return next;
}

/** Reduce by pct (at least one increment), snapped down to the increment, never below minLoad. */
export function reduceLoad(load: number, pct: number, cfg: EngineExercise['progression']): number {
  const inc = cfg.loadIncrement > 0 ? cfg.loadIncrement : null;
  const raw = load * (1 - pct / 100);
  let next = inc ? snapToStep(raw, inc, 'floor') : roundTo(raw, 1);
  if (inc && next > load - inc + LOAD_EPS) next = addLoad(load, -inc);
  const floor = cfg.minLoad ?? 0;
  if (next < floor) next = floor;
  if (next > load) next = load;
  return roundTo(next, 4);
}

/** Per-set rep targets from the last session plus `step`, clamped to the range. */
function repTargetsFrom(ctx: Ctx, step: number): number[] {
  const { ev, prev, exercise } = ctx;
  const c = exercise.progression;
  const atLoad = ev.working.map((s) => (s.atWorkingLoad ? s.reps : c.minReps));
  const fallback = atLoad.length ? Math.min(...atLoad) : c.minReps;
  const out: number[] = [];
  for (let i = 0; i < c.workingSets; i++) {
    let base = atLoad[i] ?? fallback;
    let add = step;
    if (ev.outlierPosition === i) {
      // Don't react to one bad set: keep the target it had before. Only reuse the
      // previous session's reps if that session was at the same load.
      const prevSameLoad = prev?.workingLoad != null && Math.abs(prev.workingLoad - ctx.load) < LOAD_EPS;
      base = prevSameLoad ? (prev?.working[i]?.reps ?? c.minReps) : c.minReps;
      add = 0;
    }
    out.push(clampInt(base + add, c.minReps, c.maxReps));
  }
  return out;
}

const fill = (n: number, v: number) => Array.from({ length: n }, () => v);

// ───────────────────────── rule groups ─────────────────────────

function decideBelowMin(ctx: Ctx): Draft {
  const { ev, prev, exercise } = ctx;
  const c = exercise.progression;
  const perf = perfText(exercise, ev);
  const minTargets = fill(c.workingSets, c.minReps);
  const unitWord = isTime(exercise) ? 'seconds' : 'reps';
  const base = { sets: c.workingSets, targetRir: c.targetRir };

  if (ctx.lowReadinessLatest) {
    ctx.flags.add('off-day');
    return {
      ...base,
      action: 'maintain',
      ruleId: 'C_OFF_DAY',
      load: ctx.load,
      repTargets: minTargets,
      reasons: [
        `Below the ${c.minReps}-${unitWord.slice(0, -1)} minimum (${perf}) on a low-readiness day.`,
        `Treated as an off day: same load, aim for ${c.minReps} ${unitWord} per set. It doesn't count toward a stall.`,
      ],
    };
  }

  const justIncreased = prev?.workingLoad != null && ctx.load > prev.workingLoad + LOAD_EPS;
  const prevAlsoBelow = prev?.workingLoad != null && Math.abs(prev.workingLoad - ctx.load) < LOAD_EPS && prev.clearlyBelowMin;
  const avgReps = mean(ev.working.map((s) => s.reps)) ?? 0;

  const decrease = (ruleId: string, newLoad: number, reasons: string[]): Draft => {
    if (newLoad >= ctx.load - LOAD_EPS) {
      ctx.flags.add('min-load-reached');
      return { ...base, action: 'maintain', ruleId, load: ctx.load, repTargets: minTargets, reasons: [...reasons.slice(0, 1), `${fmtLoad(exercise, ctx.load)} is already the minimum load, so hold it and rebuild reps.`] };
    }
    return { ...base, action: 'decrease-load', ruleId, load: newLoad, repTargets: minTargets, reasons };
  };

  if (prevAlsoBelow) {
    const newLoad = reduceLoad(ctx.load, RULES.decreasePercent, c);
    return decrease('C_REPEATED_BELOW', newLoad, [
      `Below the ${c.minReps}-rep minimum two sessions in a row at ${fmtLoad(exercise, ctx.load)} (latest ${perf}).`,
      `Drop to ${fmtLoad(exercise, newLoad)} and rebuild from ${c.minReps} reps.`,
    ]);
  }

  if (avgReps <= c.minReps - RULES.farBelowMinReps) {
    const newLoad = justIncreased && prev?.workingLoad != null ? prev.workingLoad : reduceLoad(ctx.load, RULES.decreasePercent, c);
    return decrease('C_FAR_BELOW', newLoad, [
      `Average ${formatNumber(avgReps, 1)} reps is far below the ${c.minReps}-rep minimum (${perf}).`,
      justIncreased ? `Go back to ${fmtLoad(exercise, newLoad)}, the last load that worked.` : `Drop to ${fmtLoad(exercise, newLoad)} and rebuild from ${c.minReps} reps.`,
    ]);
  }

  return {
    ...base,
    action: 'maintain',
    ruleId: 'C_FIRST_BELOW',
    load: ctx.load,
    repTargets: minTargets,
    reasons: [
      `Below the ${c.minReps}-rep minimum: ${perf}.`,
      justIncreased && prev?.workingLoad != null
        ? `First session at ${fmtLoad(exercise, ctx.load)} after moving up from ${fmtLoad(exercise, prev.workingLoad)}; give it one more try before backing off.`
        : 'First session below range at this load; repeat it before changing anything.',
      `Target ${c.minReps} reps on every set.`,
    ],
  };
}

function decideDeload(ctx: Ctx, cause: 'stall' | 'regression'): Draft {
  const { ev, exercise, trend } = ctx;
  const c = exercise.progression;
  const repeat = repTargetsFrom(ctx, 0);
  const why =
    cause === 'stall'
      ? `No progress for ${plural(trend.stallCount, 'session')} in a row at ${fmtLoad(exercise, ctx.load)} (no load increase and no new rep best).`
      : `Performance dropped ${plural(trend.regressionCount, 'session')} in a row (latest ${perfText(exercise, ev)}).`;
  ctx.flags.add(cause === 'stall' ? 'stall' : 'regression');
  const ruleId = cause === 'stall' ? 'DELOAD_STALL' : 'DELOAD_REGRESSION';

  if (c.deloadStrategy === 'reduce-load') {
    const newLoad = reduceLoad(ctx.load, c.deloadPercent, c);
    if (newLoad < ctx.load - LOAD_EPS) {
      return {
        action: 'deload',
        ruleId,
        load: newLoad,
        sets: c.workingSets,
        repTargets: repeat,
        targetRir: c.targetRir,
        reasons: [why, `Deload about ${formatNumber(c.deloadPercent)}% to ${fmtLoad(exercise, newLoad)} with similar reps; progression restarts from there.`],
      };
    }
    ctx.flags.add('min-load-reached');
  }
  const sets = Math.max(1, Math.ceil(c.workingSets / 2));
  const rir = Math.min(5, c.targetRir + 2);
  return {
    action: 'deload',
    ruleId,
    load: ctx.load,
    sets,
    repTargets: repeat.slice(0, sets),
    targetRir: rir,
    summary: `Deload: ${plural(sets, 'set')} of ${fmtLoad(exercise, ctx.load)} × ${fmtReps(exercise, repeat.slice(0, sets))} @ RIR ${formatNumber(rir)}`,
    reasons: [why, `One lighter session: ${plural(sets, 'set')} at RIR ${formatNumber(rir)}. Full sets return next time.`],
  };
}

function decideRepRange(ctx: Ctx): Draft {
  const { ev, prev, exercise } = ctx;
  const c = exercise.progression;
  const strategy = c.strategy;
  const perf = perfText(exercise, ev);
  const r = ev.rir;
  const high = r.reliable && (r.effectiveDeviation ?? 0) >= RULES.rirSubstantiallyHigh;
  const low = r.reliable && (r.effectiveDeviation ?? 0) <= RULES.rirSubstantiallyLow;
  const base = { sets: c.workingSets, targetRir: c.targetRir };
  const topTargets = fill(c.workingSets, c.maxReps);
  const minTargets = fill(c.workingSets, c.minReps);
  const loadTxt = fmtLoad(exercise, ctx.load);

  if (ev.clearlyBelowMin) return decideBelowMin(ctx);

  if (ev.essentiallyAllTop) {
    const topLine = `All ${ev.plannedSets} sets reached the top of ${c.minReps}–${c.maxReps} reps: ${perf}.${
      ev.toleranceUsed ? ` One set was ${c.maxReps - RULES.topToleranceReps}, within the 1-rep tolerance.` : ''
    }`;
    if (low) {
      return {
        ...base,
        action: 'maintain',
        ruleId: 'E_TOP_LOW_RIR',
        load: ctx.load,
        repTargets: topTargets,
        reasons: [
          `Top of range reached (${perf}), but average RIR ${formatNumber(r.average ?? 0, 1)} is well under the target of ${formatNumber(c.targetRir)}.`,
          `Repeat ${loadTxt} and hit ${c.maxReps} reps with about ${formatNumber(c.targetRir)} in reserve before adding load.`,
        ],
      };
    }
    if (c.loadIncrement <= 0) {
      ctx.flags.add('progress-variation');
      return { ...base, action: 'maintain', ruleId: 'A_MAX_LOAD', load: ctx.load, repTargets: topTargets, reasons: [topLine, "Load increments are 0 for this exercise, so load can't go up.", 'Hold the top of the range, or move to a harder variation.'] };
    }
    if (!canIncrease(ctx)) {
      ctx.flags.add('max-load-reached');
      return {
        ...base,
        action: 'maintain',
        ruleId: 'A_MAX_LOAD',
        load: ctx.load,
        repTargets: topTargets,
        reasons: [topLine, `${loadTxt} is the configured maximum load.`, 'Hold here and progress with an extra set, a slower tempo, or a harder variation.'],
      };
    }
    if (strategy === 'rep-first') {
      const prevTopSameLoad = prev?.essentiallyAllTop && prev.workingLoad !== null && Math.abs(prev.workingLoad - ctx.load) < LOAD_EPS;
      if (!prevTopSameLoad) {
        return {
          ...base,
          action: 'maintain',
          ruleId: 'REP_FIRST_CONSOLIDATE',
          load: ctx.load,
          repTargets: topTargets,
          reasons: [topLine, 'Rep-first: the top of the range has to be reached two sessions in a row before load goes up.', `Repeat ${loadTxt} × ${c.maxReps} on every set to earn +${formatNumber(c.loadIncrement)} ${exercise.unit}.`],
        };
      }
    }
    const big = r.reliable && (r.effectiveDeviation ?? 0) >= RULES.rirBigJump;
    const newLoad = increaseLoad(ctx, big ? 2 : 1);
    const reasons = [topLine, rirNote(ctx)];
    if (strategy === 'rep-first') reasons.push('Top of range held for two sessions in a row.');
    if (big) reasons.push('Sets were far from failure, so the jump is two increments.');
    reasons.push(`New load ${fmtLoad(exercise, newLoad)}; reps restart at ${c.minReps} and build back up.`);
    return { ...base, action: 'increase-load', ruleId: big ? 'D_TOP_HIGH_RIR_BIG' : 'A_TOP_OF_RANGE', load: newLoad, repTargets: minTargets, reasons };
  }

  if (high && strategy !== 'rep-first' && ev.majorityTop && ev.missingCount === 0 && ev.belowMinCount === 0 && canIncrease(ctx)) {
    const newLoad = increaseLoad(ctx, 1);
    return {
      ...base,
      action: 'increase-load',
      ruleId: 'D_HIGH_RIR_EARLY_INCREASE',
      load: newLoad,
      repTargets: minTargets,
      reasons: [
        `${ev.topCount} of ${ev.plannedSets} sets hit ${c.maxReps} reps and RIR was well above target: ${perf}.`,
        rirNote(ctx),
        `That margin says ${loadTxt} is light. Move to ${fmtLoad(exercise, newLoad)} now; reps restart at ${c.minReps}.`,
      ],
    };
  }

  if (ev.missingCount > 0) {
    ctx.flags.add('incomplete-session');
    const skipped = ev.skippedCount ? ` (${ev.skippedCount} skipped)` : '';
    return {
      ...base,
      action: 'maintain',
      ruleId: 'INCOMPLETE_SESSION',
      load: ctx.load,
      repTargets: repTargetsFrom(ctx, 0),
      reasons: [`Only ${ev.working.length} of ${ev.plannedSets} planned sets were logged${skipped}: ${perf}.`, 'Load and reps progress only after a full session, so repeat these targets.'],
    };
  }

  if (low) {
    return {
      ...base,
      action: 'maintain',
      ruleId: 'E_LOW_RIR_HOLD',
      load: ctx.load,
      repTargets: repTargetsFrom(ctx, 0),
      reasons: [
        `Inside the range (${perf}), but average RIR ${formatNumber(r.average ?? 0, 1)} is well below the target of ${formatNumber(c.targetRir)}.`,
        'You went closer to failure than planned. Repeat the same reps with more in reserve before adding reps.',
      ],
    };
  }

  const step = high ? 2 : 1;
  const targets = repTargetsFrom(ctx, step);
  const reasons = [`Inside the ${c.minReps}–${c.maxReps} range at ${loadTxt}: ${perf}.`, rirNote(ctx)];
  if (ev.outlierPosition !== null) {
    const s = ev.working[ev.outlierPosition];
    ctx.flags.add('outlier-set');
    reasons.push(`Set ${ev.outlierPosition + 1} (${s?.reps ?? 0} reps) looks like a one-off, so its target stays at ${targets[ev.outlierPosition] ?? c.minReps} instead of reacting to it.`);
  }
  reasons.push(
    high
      ? `RIR was well above target, so aim for +2 reps on each set below ${c.maxReps}.`
      : `Add 1 rep to each set below ${c.maxReps}. Load goes up once every set reaches ${c.maxReps}.`,
  );
  return { ...base, action: 'increase-reps', ruleId: high ? 'B_ADD_REPS_HIGH_RIR' : 'B_ADD_REPS', load: ctx.load, repTargets: targets, reasons };
}

function decideLoadFirst(ctx: Ctx): Draft {
  const { ev, exercise } = ctx;
  const c = exercise.progression;
  const perf = perfText(exercise, ev);
  const r = ev.rir;
  const low = r.reliable && (r.effectiveDeviation ?? 0) <= RULES.rirSubstantiallyLow;
  const base = { sets: c.workingSets, targetRir: c.targetRir };
  const minTargets = fill(c.workingSets, c.minReps);

  if (ev.clearlyBelowMin) return decideBelowMin(ctx);
  if (ev.missingCount > 0) {
    ctx.flags.add('incomplete-session');
    return { ...base, action: 'maintain', ruleId: 'INCOMPLETE_SESSION', load: ctx.load, repTargets: minTargets, reasons: [`Only ${ev.working.length} of ${ev.plannedSets} planned sets were logged: ${perf}.`, 'Complete every set at this load before adding weight.'] };
  }
  if (ev.allAtLeastMin) {
    if (low) {
      return { ...base, action: 'maintain', ruleId: 'E_TOP_LOW_RIR', load: ctx.load, repTargets: minTargets, reasons: [`Every set reached ${c.minReps} reps (${perf}), but average RIR ${formatNumber(r.average ?? 0, 1)} is well under target.`, `Repeat ${fmtLoad(exercise, ctx.load)} with more in reserve before adding load.`] };
    }
    if (!canIncrease(ctx)) {
      ctx.flags.add(c.loadIncrement <= 0 ? 'progress-variation' : 'max-load-reached');
      return { ...base, action: 'maintain', ruleId: 'A_MAX_LOAD', load: ctx.load, repTargets: minTargets, reasons: [`Every set reached ${c.minReps} reps: ${perf}.`, "Load can't go higher (maximum load or no increment). Add reps or a harder variation."] };
    }
    const allTop = ev.topCount >= ev.plannedSets;
    const big = allTop || (r.reliable && (r.effectiveDeviation ?? 0) >= RULES.rirBigJump);
    const newLoad = increaseLoad(ctx, big ? 2 : 1);
    return {
      ...base,
      action: 'increase-load',
      ruleId: 'LF_MIN_REACHED',
      load: newLoad,
      repTargets: minTargets,
      reasons: [
        `Load-first: every set reached at least ${c.minReps} reps: ${perf}.`,
        rirNote(ctx),
        big ? `Well past the minimum, so add two increments: ${fmtLoad(exercise, newLoad)}.` : `Add ${formatNumber(c.loadIncrement)} ${exercise.unit}: ${fmtLoad(exercise, newLoad)} × ${c.minReps}.`,
      ],
    };
  }
  return { ...base, action: 'maintain', ruleId: 'LF_BUILD', load: ctx.load, repTargets: minTargets, reasons: [`Load-first: not every set reached ${c.minReps} reps at ${fmtLoad(exercise, ctx.load)} yet (${perf}).`, `Target ${c.minReps} reps on every set; load goes up once they all get there.`] };
}

function decideTime(ctx: Ctx): Draft {
  const { ev, exercise } = ctx;
  const c = exercise.progression;
  const perf = perfText(exercise, ev);
  const base = { sets: c.workingSets, targetRir: c.targetRir };
  if (ev.clearlyBelowMin) {
    if (ctx.lowReadinessLatest) ctx.flags.add('off-day');
    return { ...base, action: 'maintain', ruleId: 'T_BELOW_MIN', load: ctx.load, repTargets: fill(c.workingSets, c.minReps), reasons: [`Holds fell below the ${c.minReps}-second minimum: ${perf}.`, `Repeat with ${c.minReps}-second targets.`] };
  }
  if (ev.missingCount > 0) {
    ctx.flags.add('incomplete-session');
    return { ...base, action: 'maintain', ruleId: 'INCOMPLETE_SESSION', load: ctx.load, repTargets: repTargetsFrom(ctx, 0), reasons: [`Only ${ev.working.length} of ${ev.plannedSets} planned holds were logged.`, 'Repeat these targets before progressing.'] };
  }
  if (ev.essentiallyAllTop) {
    if (canIncrease(ctx)) {
      const newLoad = increaseLoad(ctx, 1);
      return { ...base, action: 'increase-load', ruleId: 'T_ADD_LOAD', load: newLoad, repTargets: fill(c.workingSets, c.minReps), reasons: [`Every hold reached ${c.maxReps} s: ${perf}.`, `Add load (${fmtLoad(exercise, newLoad)}) and restart at ${c.minReps} s.`] };
    }
    ctx.flags.add('progress-variation');
    return { ...base, action: 'maintain', ruleId: 'T_MAX_TIME', load: ctx.load, repTargets: fill(c.workingSets, c.maxReps), reasons: [`Every hold reached the ${c.maxReps}-second maximum: ${perf}.`, 'Move to a harder variation, or raise the maximum time in the exercise settings.'] };
  }
  const targets = repTargetsFrom(ctx, c.timeIncrementSeconds);
  return { ...base, action: 'increase-reps', ruleId: 'T_ADD_TIME', load: ctx.load, repTargets: targets, reasons: [`Holds inside ${c.minReps}–${c.maxReps} s: ${perf}.`, `Add ${c.timeIncrementSeconds} s to each hold below ${c.maxReps} s.`] };
}

// ───────────────────────── assembly ─────────────────────────

function autoSummary(x: EngineExercise, d: Draft): string {
  const load = fmtLoad(x, d.load);
  const reps = fmtReps(x, d.repTargets);
  const c = x.progression;
  switch (d.action) {
    case 'establish-baseline':
      return d.load === null
        ? `Pick a load you can lift ${c.minReps}–${c.maxReps} ${isTime(x) ? 'seconds' : 'times'} with ${formatNumber(c.targetRir)} in reserve`
        : `Start at ${load} × ${reps}`;
    case 'increase-load':
      return `Increase to ${load} × ${reps}`;
    case 'increase-reps':
      return `Keep ${load}, aim for ${reps}`;
    case 'maintain':
      return `Repeat ${load} × ${reps}`;
    case 'decrease-load':
      return `Drop to ${load} × ${reps}`;
    case 'deload':
      return `Deload to ${load} × ${reps}`;
    case 'review':
      return 'Review this exercise before loading it again';
  }
}

function finalize(exercise: EngineExercise, draft: Draft, ev: SessionEvaluation | null, trend: TrendSnapshot, flags: Set<RecommendationFlag>, warnings: string[]): EngineResult {
  const c = exercise.progression;
  const sets = Math.max(1, Math.min(10, Math.round(draft.sets)));
  const cap = isTime(exercise) ? 3600 : 100;
  const reps: number[] = [];
  for (let i = 0; i < sets; i++) reps.push(clampInt(draft.repTargets[i] ?? draft.repTargets[draft.repTargets.length - 1] ?? c.minReps, 1, cap));
  let load = draft.load;
  if (load !== null) {
    if (c.maxLoad !== null && load > c.maxLoad + LOAD_EPS) load = c.maxLoad;
    if (c.minLoad !== null && load < c.minLoad - LOAD_EPS) load = c.minLoad;
    load = roundTo(load, 4);
  }
  const d: Draft = { ...draft, sets, repTargets: reps, load };
  const prevLoad = ev?.workingLoad ?? null;
  let direction: Direction = 'same';
  if (load !== null && prevLoad !== null) direction = load > prevLoad + LOAD_EPS ? 'up' : load < prevLoad - LOAD_EPS ? 'down' : 'same';
  if (d.action === 'deload' || d.action === 'decrease-load') direction = 'down';
  if (warnings.length) flags.add('data-warning');
  return {
    action: d.action,
    direction,
    target: { load, unit: exercise.unit, sets, repTargets: reps, targetRir: d.targetRir },
    previous: ev && ev.working.length ? { load: ev.workingLoad, reps: ev.working.map((s) => s.reps), unit: exercise.unit } : null,
    summary: d.summary ?? autoSummary(exercise, d),
    reasons: d.reasons.filter((s) => s.length > 0),
    ruleId: d.ruleId,
    flags: [...flags],
    trend,
    warnings,
    evaluation: ev,
  };
}

function baseline(exercise: EngineExercise, warnings: string[], note?: string): EngineResult {
  const c = exercise.progression;
  const load = c.startingLoad ?? c.minLoad ?? (exercise.equipment === 'bodyweight' || isTime(exercise) ? 0 : null);
  const unitWord = isTime(exercise) ? 'seconds' : 'reps';
  const draft: Draft = {
    action: 'establish-baseline',
    ruleId: 'BASELINE',
    load,
    sets: c.workingSets,
    repTargets: fill(c.workingSets, c.minReps),
    targetRir: c.targetRir,
    reasons: [
      note ?? 'No history yet for this exercise.',
      load === null
        ? `Choose a load you can lift for ${c.minReps}–${c.maxReps} ${unitWord} with about ${formatNumber(c.targetRir)} in reserve.`
        : `Start at ${fmtLoad(exercise, load)} and aim for ${c.minReps} ${unitWord} per set at RIR ${formatNumber(c.targetRir)}.`,
      'This session sets the baseline; progression starts from what you log.',
    ],
  };
  return finalize(exercise, draft, null, EMPTY_TREND, new Set(), warnings);
}

export function recommendNext(input: EngineInput): EngineResult {
  const exercise = input.exercise;
  const c = exercise.progression;
  const opts: EvaluationOptions = { ...DEFAULT_OPTIONS, ...input.options };
  if (!(Number.isInteger(opts.defaultRirConfidence) && opts.defaultRirConfidence >= 1 && opts.defaultRirConfidence <= 5)) opts.defaultRirConfidence = DEFAULT_OPTIONS.defaultRirConfidence;
  const warnings: string[] = [];

  const relevant = input.history.filter((h) => h.session.exerciseId === exercise.id && h.session.status === 'completed');
  if (relevant.length < input.history.length) warnings.push(`${input.history.length - relevant.length} session(s) ignored (different exercise or not completed).`);
  const history = relevant
    .map((h, i) => ({ h, i }))
    .sort((a, b) => (a.h.session.completedAt ?? '').localeCompare(b.h.session.completedAt ?? '') || a.i - b.i)
    .map((x) => x.h);

  const check = validateProgressionConfig(c);
  if (!check.ok) {
    const flags = new Set<RecommendationFlag>(['invalid-config']);
    const draft: Draft = {
      action: 'review',
      ruleId: 'INVALID_CONFIG',
      load: c.startingLoad,
      sets: Number.isInteger(c.workingSets) && c.workingSets >= 1 ? Math.min(10, c.workingSets) : 3,
      repTargets: [Number.isInteger(c.minReps) && c.minReps > 0 ? c.minReps : 8],
      targetRir: Number.isFinite(c.targetRir) ? Math.max(0, Math.min(5, c.targetRir)) : 2,
      summary: 'Fix this exercise’s progression settings',
      reasons: ['The progression settings are invalid, so no target can be calculated:', ...check.errors.map((e) => e.message)],
    };
    return finalize(exercise, draft, null, EMPTY_TREND, flags, warnings);
  }

  const evalsAll = history.map((h) => evaluateSession(h.session, exercise, opts));
  const lowAll = history.map((h) => isLowReadiness(h.readiness));
  for (const e of evalsAll.slice(-1)) warnings.push(...e.warnings);

  const usableIdx = evalsAll.map((e, i) => (e.working.length > 0 ? i : -1)).filter((i) => i >= 0);
  if (usableIdx.length === 0) return baseline(exercise, warnings, history.length ? 'No usable sets have been logged yet for this exercise.' : undefined);

  const evals = usableIdx.map((i) => evalsAll[i] as SessionEvaluation);
  const low = usableIdx.map((i) => lowAll[i] ?? false);
  const trend = analyzeTrend(toTrendPoints(evals, low));
  const trendSnap: TrendSnapshot = { label: trend.label, windowSize: trend.windowSize, changePct: trend.changePct, stallCount: trend.stallCount, regressionCount: trend.regressionCount };
  const ev = evals[evals.length - 1] as SessionEvaluation;
  const prev = evals.length > 1 ? evals[evals.length - 2] : undefined;
  const flags = new Set<RecommendationFlag>();

  const latestEval = evalsAll[evalsAll.length - 1] as SessionEvaluation;
  if (latestEval.working.length === 0) {
    const ctx0: Ctx = { exercise, ev, prev, trend, lowReadinessLatest: false, load: ev.workingLoad as number, flags };
    return finalize(
      exercise,
      {
        action: 'maintain',
        ruleId: 'NO_SETS_LOGGED',
        load: ev.workingLoad,
        sets: c.workingSets,
        repTargets: repTargetsFrom(ctx0, 0),
        targetRir: c.targetRir,
        reasons: ['The last session had no usable sets.', `Repeat the last known performance: ${perfText(exercise, ev)}.`],
      },
      ev,
      trendSnap,
      flags,
      warnings,
    );
  }

  const workingLoad = ev.workingLoad as number;
  if (ev.unitConverted) flags.add('unit-converted');
  if (ev.mixedLoads) flags.add('mixed-loads');
  const load = ev.unitConverted && c.loadIncrement > 0 ? snapToStep(workingLoad, c.loadIncrement, 'nearest') : workingLoad;
  const ctx: Ctx = { exercise, ev, prev, trend, lowReadinessLatest: low[low.length - 1] ?? false, load, flags };

  let draft: Draft;
  if (ev.pain === 'significant') {
    flags.add('pain-review');
    const note = history[history.length - 1]?.session.note;
    draft = {
      action: 'review',
      ruleId: 'PAIN_REVIEW',
      load,
      sets: c.workingSets,
      repTargets: repTargetsFrom(ctx, 0),
      targetRir: c.targetRir,
      reasons: [
        `Significant pain was logged last session${note ? ` ("${note}")` : ''}.`,
        'Load will not be increased. Check setup and technique, replace the exercise, or skip it until it is pain-free.',
        `If you train it, stay at or below ${fmtLoad(exercise, load)} × ${fmtReps(exercise, repTargetsFrom(ctx, 0))}.`,
      ],
    };
  } else if (ev.prescribedAction === 'deload' && ev.plannedSets < c.workingSets) {
    const before = prev?.working.map((s) => s.reps) ?? [];
    draft = {
      action: 'maintain',
      ruleId: 'RESUME_AFTER_DELOAD',
      load,
      sets: c.workingSets,
      repTargets: before.length ? Array.from({ length: c.workingSets }, (_, i) => clampInt(before[i] ?? before[before.length - 1] ?? c.minReps, c.minReps, c.maxReps)) : fill(c.workingSets, c.minReps),
      targetRir: c.targetRir,
      reasons: ['Last session was a reduced-volume deload.', `Return to ${plural(c.workingSets, 'set')} at ${fmtLoad(exercise, load)} with your pre-deload reps.`],
    };
  } else if (!isTime(exercise) && c.deloadStrategy !== 'none' && trend.stallCount >= c.stallSessionsBeforeDeload) {
    draft = decideDeload(ctx, 'stall');
  } else if (!isTime(exercise) && c.deloadStrategy !== 'none' && trend.regressionCount >= RULES.regressionSessionsBeforeDeload) {
    draft = decideDeload(ctx, 'regression');
  } else if (c.strategy === 'load-first') {
    draft = decideLoadFirst(ctx);
  } else if (c.strategy === 'time-based') {
    draft = decideTime(ctx);
  } else {
    draft = decideRepRange(ctx);
  }

  // Mild pain: never push load or reps.
  if (ev.pain === 'mild' && (draft.action === 'increase-load' || draft.action === 'increase-reps')) {
    const original = autoSummary(exercise, draft);
    flags.add('pain-caution');
    draft = {
      action: 'maintain',
      ruleId: 'PAIN_CAUTION',
      load,
      sets: c.workingSets,
      repTargets: repTargetsFrom(ctx, 0),
      targetRir: c.targetRir,
      reasons: ['Mild pain was logged, so load and reps hold until a pain-free session.', `Without the pain flag the plan would have been: ${original.charAt(0).toLowerCase()}${original.slice(1)}.`],
    };
  }

  // Trend context notes (never change the decision; skipped for deloads and pain reviews, which explain themselves).
  if (draft.action !== 'deload' && draft.action !== 'review') {
    if (trend.stallCount >= RULES.plateauWarningAt) {
      flags.add(trend.stallCount >= c.stallSessionsBeforeDeload ? 'stall' : 'plateau-warning');
      draft.reasons.push(
        c.deloadStrategy === 'none' || isTime(exercise)
          ? `No progress in the last ${plural(trend.stallCount, 'session')}. Deloads are off for this exercise; consider a new variation or rep range.`
          : `No progress in the last ${plural(trend.stallCount, 'session')}; a deload triggers at ${c.stallSessionsBeforeDeload}.`,
      );
    } else if (trend.regressionCount === 1 && !['C_FIRST_BELOW', 'C_REPEATED_BELOW', 'C_FAR_BELOW', 'C_OFF_DAY'].includes(draft.ruleId)) {
      draft.reasons.push("Slightly down from the previous session; a single dip doesn't change the plan.");
    }
    if (ctx.lowReadinessLatest && draft.ruleId !== 'C_OFF_DAY') draft.reasons.push('Last session was logged as a low-readiness day.');
  }
  if (ev.unitConverted) draft.reasons.push(`Sets logged in another unit were converted to ${exercise.unit}.`);
  if (ev.mixedLoads) draft.reasons.push(`Mixed loads were logged; progression is judged at ${fmtLoad(exercise, workingLoad)}, the most common one.`);

  return finalize(exercise, draft, ev, trendSnap, flags, warnings);
}
