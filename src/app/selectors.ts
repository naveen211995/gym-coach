/**
 * Read-only queries over the dataset. Pure functions; the UI memoizes them per dataset version.
 * Anything that decides a target calls the engine — never re-implements a rule.
 */
import type {
  Dataset,
  Exercise,
  ExerciseSession,
  PersonalRecord,
  ProgressionRecommendation,
  ReadinessRecord,
  RoutineDay,
  WorkoutSession,
} from '../domain/types';
import {
  buildSeries,
  computeBests,
  evaluateSession,
  recommendNext,
  RULES,
  type EngineHistoryEntry,
  type EngineResult,
  type HistoricalBests,
  type SeriesPoint,
  type SessionEvaluation,
} from '../engine';

export const byId = <T extends { id: string }>(list: readonly T[]): Map<string, T> => new Map(list.map((x) => [x.id, x]));

export function activeWorkout(ds: Dataset): WorkoutSession | null {
  return ds.workoutSessions.find((w) => w.status === 'in-progress') ?? null;
}

export function completedWorkouts(ds: Dataset): WorkoutSession[] {
  return ds.workoutSessions.filter((w) => w.status === 'completed').sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''));
}

export function sessionsForWorkout(ds: Dataset, workoutId: string): ExerciseSession[] {
  return ds.exerciseSessions.filter((s) => s.workoutSessionId === workoutId).sort((a, b) => a.order - b.order);
}

export function readinessForWorkout(ds: Dataset, workout: WorkoutSession | undefined | null): ReadinessRecord | null {
  if (!workout?.readinessId) return null;
  return ds.readiness.find((r) => r.id === workout.readinessId) ?? null;
}

/** Completed sessions of one exercise with that day's readiness, oldest first. */
export function historyFor(ds: Dataset, exerciseId: string, excludeSessionId?: string): EngineHistoryEntry[] {
  const workouts = byId(ds.workoutSessions);
  const readiness = byId(ds.readiness);
  return ds.exerciseSessions
    .filter((s) => s.exerciseId === exerciseId && s.status === 'completed' && s.id !== excludeSessionId)
    .sort((a, b) => (a.completedAt ?? '').localeCompare(b.completedAt ?? ''))
    .map((session) => {
      const w = workouts.get(session.workoutSessionId);
      return { session, readiness: w?.readinessId ? (readiness.get(w.readinessId) ?? null) : null };
    });
}

export function engineOptions(ds: Dataset) {
  return { defaultRirConfidence: ds.settings.defaultRirConfidence };
}

/** The live next-session recommendation: always recomputed from full history + current settings. */
export function nextRecommendation(ds: Dataset, exercise: Exercise): EngineResult {
  return recommendNext({ exercise, history: historyFor(ds, exercise.id), options: engineOptions(ds) });
}

/** The stored recommendation that was produced after a given exercise session. */
export function recommendationAfter(ds: Dataset, exerciseSessionId: string): ProgressionRecommendation | null {
  return ds.recommendations.find((r) => r.basedOnExerciseSessionId === exerciseSessionId) ?? null;
}

export function lastCompletedSession(ds: Dataset, exerciseId: string, beforeIso?: string): ExerciseSession | null {
  let best: ExerciseSession | null = null;
  for (const s of ds.exerciseSessions) {
    if (s.exerciseId !== exerciseId || s.status !== 'completed' || !s.completedAt) continue;
    if (beforeIso && s.completedAt >= beforeIso) continue;
    if (!best || (best.completedAt ?? '') < s.completedAt) best = s;
  }
  return best;
}

export interface ExerciseStats {
  evaluations: SessionEvaluation[];
  bests: HistoricalBests;
  series: SeriesPoint[];
  records: PersonalRecord[];
  sessionCount: number;
}

export function exerciseStats(ds: Dataset, exercise: Exercise): ExerciseStats {
  const history = historyFor(ds, exercise.id);
  const evaluations = history.map((h) => evaluateSession(h.session, exercise, engineOptions(ds)));
  const timeBased = exercise.progression.strategy === 'time-based';
  return {
    evaluations,
    bests: computeBests(evaluations, timeBased),
    series: buildSeries(evaluations),
    records: ds.personalRecords.filter((p) => p.exerciseId === exercise.id).sort((a, b) => b.achievedAt.localeCompare(a.achievedAt)),
    sessionCount: history.length,
  };
}

export function activeRoutineDays(ds: Dataset): RoutineDay[] {
  const routine = ds.routines.find((r) => r.id === ds.settings.activeRoutineId) ?? ds.routines[0];
  if (!routine) return [];
  const days = byId(ds.routineDays);
  return routine.dayIds.map((id) => days.get(id)).filter((d): d is RoutineDay => Boolean(d));
}

/** Rotation: the day after the most recently completed day of the active routine. */
export function nextRoutineDay(ds: Dataset): RoutineDay | null {
  const days = activeRoutineDays(ds);
  if (days.length === 0) return null;
  const ids = days.map((d) => d.id);
  const last = completedWorkouts(ds).find((w) => w.routineDayId && ids.includes(w.routineDayId));
  if (!last?.routineDayId) return days[0] ?? null;
  return days[(ids.indexOf(last.routineDayId) + 1) % days.length] ?? null;
}

export interface AttentionItem {
  exercise: Exercise;
  rec: EngineResult;
  kind: 'pain' | 'deload' | 'decrease' | 'stall' | 'caution' | 'config';
  text: string;
}

/** Exercises whose next recommendation needs the lifter's attention before the session. */
export function attentionItems(ds: Dataset): AttentionItem[] {
  const out: AttentionItem[] = [];
  for (const exercise of ds.exercises) {
    if (exercise.archived) continue;
    const rec = nextRecommendation(ds, exercise);
    if (rec.action === 'establish-baseline') continue;
    let kind: AttentionItem['kind'] | null = null;
    let text = '';
    if (rec.ruleId === 'INVALID_CONFIG') {
      kind = 'config';
      text = 'Progression settings need fixing';
    } else if (rec.flags.includes('pain-review')) {
      kind = 'pain';
      text = 'Pain logged: review, replace or skip';
    } else if (rec.action === 'deload') {
      kind = 'deload';
      text = rec.ruleId === 'DELOAD_REGRESSION' ? 'Regressing: deload recommended' : 'Stalled: deload recommended';
    } else if (rec.action === 'decrease-load') {
      kind = 'decrease';
      text = 'Below range: load comes down';
    } else if (rec.flags.includes('pain-caution')) {
      kind = 'caution';
      text = 'Mild pain: holding progression';
    } else if (rec.flags.includes('plateau-warning') || rec.flags.includes('stall')) {
      kind = 'stall';
      text = `No progress in ${rec.trend.stallCount} sessions`;
    } else if (rec.ruleId === 'C_FIRST_BELOW') {
      kind = 'caution';
      text = 'Below the rep range last time';
    }
    if (kind) out.push({ exercise, rec, kind, text });
  }
  const order: AttentionItem['kind'][] = ['config', 'pain', 'deload', 'decrease', 'caution', 'stall'];
  return out.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
}

export interface WeekSummary {
  workouts: number;
  sets: number;
  reps: number;
  volumeByUnit: { lb: number; kg: number; plt: number };
  prs: number;
}

export function weekSummary(ds: Dataset, nowIso: string): WeekSummary {
  const since = new Date(Date.parse(nowIso) - 7 * 86400000).toISOString();
  const ws = completedWorkouts(ds).filter((w) => (w.completedAt ?? '') >= since);
  const ids = new Set(ws.map((w) => w.id));
  const summary: WeekSummary = { workouts: ws.length, sets: 0, reps: 0, volumeByUnit: { lb: 0, kg: 0, plt: 0 }, prs: 0 };
  const exercises = byId(ds.exercises);
  for (const s of ds.exerciseSessions) {
    if (!ids.has(s.workoutSessionId) || s.status !== 'completed') continue;
    const timeBased = exercises.get(s.exerciseId)?.progression.strategy === 'time-based';
    for (const set of s.sets) {
      if (set.status !== 'completed' && set.status !== 'failed') continue;
      summary.sets++;
      if (!timeBased) summary.reps += set.reps ?? 0;
      if (!timeBased && set.load) summary.volumeByUnit[set.unit] += set.load * (set.reps ?? 0);
    }
  }
  summary.prs = ds.personalRecords.filter((p) => ids.has(p.workoutSessionId)).length;
  return summary;
}

export function recentRecords(ds: Dataset, limit = 5): PersonalRecord[] {
  return [...ds.personalRecords].sort((a, b) => b.achievedAt.localeCompare(a.achievedAt)).slice(0, limit);
}

export function substituteCandidates(ds: Dataset, exercise: Exercise, excludeIds: readonly string[]): Exercise[] {
  const ex = new Set([exercise.id, ...excludeIds]);
  return ds.exercises
    .filter((e) => !e.archived && !ex.has(e.id))
    .sort((a, b) => Number(b.muscleGroup === exercise.muscleGroup) - Number(a.muscleGroup === exercise.muscleGroup) || a.name.localeCompare(b.name));
}

export const ENGINE_VERSION = RULES.engineVersion;
