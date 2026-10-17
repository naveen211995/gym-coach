/**
 * Within-session autoregulation — pure and deterministic.
 *
 * The prescribed load is a prediction made before the session. When the first
 * working set comes in well under or well over its target, carrying the same
 * load through the remaining sets is the one thing we know is wrong. Adjusting
 * mid-session (the idea behind APRE-style protocols) keeps the remaining sets
 * in the intended rep range and effort zone.
 *
 * This only ever SUGGESTS: the lifter applies it or ignores it, and the
 * session-to-session engine still judges whatever was actually logged.
 */
import { clampInt } from './metrics';
import { RULES } from './rules';
import type { EngineExercise } from './sessionEval';
import { LOAD_EPS } from './sessionEval';
import { addLoad, formatLoad, formatNumber, roundTo } from './units';

export type AutoregAction = 'reduce-load' | 'add-load';

export interface AutoregSuggestion {
  action: AutoregAction;
  /** Suggested load for the sets that are still pending. */
  load: number;
  /** Rep target to expect at that load. */
  reps: number;
  summary: string;
  reason: string;
}

export interface AutoregSet {
  index: number;
  load: number | null;
  reps: number | null;
  rir: number | null;
  status: 'pending' | 'completed' | 'failed' | 'skipped';
}

export interface AutoregInput {
  exercise: EngineExercise;
  /** What this session prescribed. */
  prescribed: { load: number | null; repTargets: readonly number[]; targetRir: number };
  sets: readonly AutoregSet[];
}

const performed = (s: AutoregSet) => s.status === 'completed' || s.status === 'failed';

/**
 * A suggestion for the still-pending sets, or null when the session is on
 * track, finished, or has nothing comparable to judge.
 */
export function autoregulateRemaining(input: AutoregInput): AutoregSuggestion | null {
  const { exercise, prescribed } = input;
  const c = exercise.progression;
  if (c.strategy === 'time-based' || !(c.loadIncrement > 0)) return null;

  const sets = [...input.sets].sort((a, b) => a.index - b.index);
  const pending = sets.filter((s) => s.status === 'pending');
  if (pending.length === 0) return null;

  const done = sets.filter(performed);
  const last = done[done.length - 1];
  if (!last || last.reps === null || last.load === null || !(last.load > 0)) return null;

  // Only judge a set that was performed at the prescribed load: a set the
  // lifter already adjusted is their decision, not a miss.
  const target = prescribed.repTargets[last.index] ?? prescribed.repTargets[prescribed.repTargets.length - 1];
  if (target === undefined) return null;
  if (prescribed.load !== null && Math.abs(last.load - prescribed.load) > LOAD_EPS) return null;

  const miss = target - last.reps;
  const rir = last.rir;

  // Short of target and at or near failure: the load is too heavy for today.
  if (miss >= RULES.autoregMissReps && (rir === null || rir <= 1 || last.status === 'failed')) {
    const floor = c.minLoad ?? 0;
    const reduced = roundTo(Math.max(floor, addLoad(last.load, -c.loadIncrement)), 4);
    if (reduced >= last.load - LOAD_EPS) return null;
    const reps = clampInt(target, c.minReps, c.maxReps);
    return {
      action: 'reduce-load',
      load: reduced,
      reps,
      summary: `Drop to ${formatLoad(reduced, exercise.unit)} for the remaining ${pending.length === 1 ? 'set' : `${pending.length} sets`}`,
      reason: `Set ${last.index + 1} came in ${miss} ${miss === 1 ? 'rep' : 'reps'} under its target of ${target}${rir === null ? '' : ` at RIR ${formatNumber(rir)}`}. Taking ${formatNumber(c.loadIncrement)} ${exercise.unit} off keeps the rest of the sets inside ${c.minReps}-${c.maxReps} reps instead of grinding them out.`,
    };
  }

  // Past target with reps still in reserve: the load is too light for today.
  if (-miss >= RULES.autoregBeatReps && rir !== null && rir >= prescribed.targetRir && rir > 0) {
    if (c.maxLoad !== null && last.load >= c.maxLoad - LOAD_EPS) return null;
    let raised = addLoad(last.load, c.loadIncrement);
    if (c.maxLoad !== null && raised > c.maxLoad) raised = c.maxLoad;
    if (raised <= last.load + LOAD_EPS) return null;
    const reps = clampInt(target, c.minReps, c.maxReps);
    return {
      action: 'add-load',
      load: raised,
      reps,
      summary: `Try ${formatLoad(raised, exercise.unit)} for the remaining ${pending.length === 1 ? 'set' : `${pending.length} sets`}`,
      reason: `Set ${last.index + 1} beat its target of ${target} by ${-miss} and still left RIR ${formatNumber(rir)}. Today's load is light, so the remaining sets can carry more.`,
    };
  }

  return null;
}
