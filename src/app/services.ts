/**
 * App services: every user action is a pure function (dataset, input, ctx) → Change.
 * They enforce data rules; the engine makes progression decisions.
 *
 * History rules:
 *  - Only the single in-progress workout can be edited.
 *  - Completed workouts are read-only. Editing a completed exercise *inside the
 *    active workout* reopens it and discards its provisional recommendation/PRs,
 *    which are recalculated when it is completed again.
 */
import { applyChange, emptyChange, mergeChanges, putRecords, removeRecords, type Change } from '../domain/change';
import { EQUIPMENT_TYPES, MUSCLE_GROUPS } from '../domain/defaults';
import type {
  Dataset,
  Exercise,
  ExerciseSession,
  PainLevel,
  PrescribedTarget,
  ProgressionConfig,
  ProgressionRecommendation,
  ReadinessRecord,
  Routine,
  RoutineDay,
  SetPerformance,
  SetStatus,
  UserSettings,
  WorkoutSession,
} from '../domain/types';
import {
  applyReadiness,
  assessReadiness,
  detectPersonalRecords,
  evaluateSession,
  recommendNext,
  RULES,
  validateProgressionConfig,
  validateSetEntry,
  type EngineResult,
} from '../engine';
import { activeWorkout, byId, engineOptions, historyFor, lastCompletedSession, readinessForWorkout, sessionsForWorkout } from './selectors';

export interface Ctx {
  now: string;
  newId: (prefix: string) => string;
}

export class ServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServiceError';
  }
}

const fail = (msg: string): never => {
  throw new ServiceError(msg);
};

// ───────────────────────── lookups ─────────────────────────

function getExercise(ds: Dataset, id: string): Exercise {
  return ds.exercises.find((e) => e.id === id) ?? fail('That exercise no longer exists.');
}
function getExerciseSession(ds: Dataset, id: string): ExerciseSession {
  return ds.exerciseSessions.find((s) => s.id === id) ?? fail('That exercise is not part of a workout anymore.');
}
function getWorkout(ds: Dataset, id: string): WorkoutSession {
  return ds.workoutSessions.find((w) => w.id === id) ?? fail('That workout no longer exists.');
}
function editableSession(ds: Dataset, exerciseSessionId: string): { es: ExerciseSession; workout: WorkoutSession } {
  const es = getExerciseSession(ds, exerciseSessionId);
  const workout = getWorkout(ds, es.workoutSessionId);
  if (workout.status !== 'in-progress') fail('Completed workouts are read-only, so history stays exactly as logged.');
  return { es, workout };
}

const recIdFor = (exerciseSessionId: string) => `rec_${exerciseSessionId}`;
const prIdFor = (exerciseSessionId: string, type: string) => `pr_${exerciseSessionId}_${type}`;

// ───────────────────────── prescriptions ─────────────────────────

export function toRecommendation(result: EngineResult, exerciseId: string, basedOn: string | null, ctx: Ctx, id?: string): ProgressionRecommendation {
  return {
    id: id ?? (basedOn ? recIdFor(basedOn) : ctx.newId('rec')),
    exerciseId,
    basedOnExerciseSessionId: basedOn,
    createdAt: ctx.now,
    action: result.action,
    direction: result.direction,
    previous: result.previous,
    target: result.target,
    summary: result.summary,
    reasons: result.reasons,
    ruleId: result.ruleId,
    flags: result.flags,
    trend: result.trend,
    warnings: result.warnings,
    engineVersion: RULES.engineVersion,
  };
}

/** Today's prescription: the engine's recommendation, then a today-only readiness adjustment. */
export function buildPrescription(ds: Dataset, exercise: Exercise, readiness: ReadinessRecord | null): PrescribedTarget {
  const rec = recommendNext({ exercise, history: historyFor(ds, exercise.id), options: engineOptions(ds) });
  const last = lastCompletedSession(ds, exercise.id);
  const stored = last ? ds.recommendations.find((r) => r.basedOnExerciseSessionId === last.id) : undefined;
  const adj = applyReadiness(rec.target, { action: rec.action, previous: rec.previous }, assessReadiness(readiness), exercise.progression);
  return {
    ...adj.target,
    action: rec.action,
    summary: rec.summary,
    reasons: rec.reasons,
    recommendationId: stored?.id ?? null,
    readinessAdjusted: adj.adjusted,
    readinessNotes: adj.notes,
  };
}

function pendingSets(n: number, unit: Exercise['unit'], ctx: Ctx): SetPerformance[] {
  return Array.from({ length: n }, (_, index) => ({ id: ctx.newId('set'), index, load: null, unit, reps: null, rir: null, rirConfidence: null, status: 'pending' as const, note: '' }));
}

function newExerciseSession(ds: Dataset, workout: WorkoutSession, exercise: Exercise, order: number, readiness: ReadinessRecord | null, ctx: Ctx, substitutedFrom: string | null = null): ExerciseSession {
  const prescribed = buildPrescription(ds, exercise, readiness);
  return {
    id: ctx.newId('es'),
    workoutSessionId: workout.id,
    exerciseId: exercise.id,
    order,
    status: 'pending',
    prescribed,
    sets: pendingSets(prescribed.sets, exercise.unit, ctx),
    pain: 'none',
    note: '',
    completedAt: null,
    substitutedFromExerciseId: substitutedFrom,
  };
}

// ───────────────────────── workouts ─────────────────────────

export interface ReadinessInput {
  readiness: number | null;
  energy: number | null;
  sleepHours: number | null;
  fatigue: number | null;
  pain: boolean;
  note?: string;
}

function validateReadiness(r: ReadinessInput): void {
  for (const [k, v] of [['Readiness', r.readiness], ['Energy', r.energy], ['Fatigue', r.fatigue]] as const) {
    if (v !== null && !(Number.isInteger(v) && v >= 1 && v <= 5)) fail(`${k} must be 1–5.`);
  }
  if (r.sleepHours !== null && !(Number.isFinite(r.sleepHours) && r.sleepHours >= 0 && r.sleepHours <= 24)) fail('Sleep must be between 0 and 24 hours.');
}

export function startWorkout(ds: Dataset, input: { routineDayId: string | null; name?: string; readiness: ReadinessInput | null }, ctx: Ctx): { change: Change; workoutId: string } {
  if (activeWorkout(ds)) fail('A workout is already in progress. Finish or discard it first.');
  const day = input.routineDayId ? (ds.routineDays.find((d) => d.id === input.routineDayId) ?? fail('That routine day no longer exists.')) : null;
  const workoutId = ctx.newId('w');
  let readiness: ReadinessRecord | null = null;
  if (input.readiness) {
    validateReadiness(input.readiness);
    readiness = { id: ctx.newId('rd'), workoutSessionId: workoutId, recordedAt: ctx.now, note: input.readiness.note ?? '', ...input.readiness };
  }
  const name = (input.name ?? day?.name ?? 'Workout').trim().slice(0, 60) || 'Workout';
  const workout: WorkoutSession = {
    id: workoutId,
    routineId: day?.routineId ?? null,
    routineDayId: day?.id ?? null,
    name,
    status: 'in-progress',
    startedAt: ctx.now,
    completedAt: null,
    readinessId: readiness?.id ?? null,
    notes: '',
  };
  const exercises = byId(ds.exercises);
  const sessions = (day?.exerciseIds ?? [])
    .map((id) => exercises.get(id))
    .filter((e): e is Exercise => Boolean(e && !e.archived))
    .map((e, i) => newExerciseSession(ds, workout, e, i, readiness, ctx));
  const change = emptyChange();
  putRecords(change, 'workoutSessions', [workout]);
  putRecords(change, 'exerciseSessions', sessions);
  if (readiness) putRecords(change, 'readiness', [readiness]);
  return { change, workoutId };
}

export function addExerciseToWorkout(ds: Dataset, workoutId: string, exerciseId: string, ctx: Ctx): Change {
  const workout = getWorkout(ds, workoutId);
  if (workout.status !== 'in-progress') fail('Completed workouts are read-only.');
  const exercise = getExercise(ds, exerciseId);
  if (exercise.archived) fail('Archived exercises cannot be added to a workout.');
  const existing = sessionsForWorkout(ds, workoutId);
  if (existing.some((s) => s.exerciseId === exerciseId && s.status !== 'skipped')) fail(`${exercise.name} is already in this workout.`);
  const order = existing.length ? Math.max(...existing.map((s) => s.order)) + 1 : 0;
  return putRecords(emptyChange(), 'exerciseSessions', [newExerciseSession(ds, workout, exercise, order, readinessForWorkout(ds, workout), ctx)]);
}

/** Remove provisional results (recommendation + PRs) of a session that is being reopened or discarded. */
function discardResults(ds: Dataset, change: Change, exerciseSessionId: string): void {
  if (ds.recommendations.some((r) => r.id === recIdFor(exerciseSessionId))) removeRecords(change, 'recommendations', [recIdFor(exerciseSessionId)]);
  const prs = ds.personalRecords.filter((p) => p.exerciseSessionId === exerciseSessionId).map((p) => p.id);
  if (prs.length) removeRecords(change, 'personalRecords', prs);
}

export interface SetInput {
  load: number | null;
  reps: number | null;
  rir: number | null;
  rirConfidence: number | null;
  note: string;
  status: Extract<SetStatus, 'completed' | 'failed'>;
}

export function logSet(ds: Dataset, exerciseSessionId: string, setIndex: number, input: SetInput): Change {
  const { es } = editableSession(ds, exerciseSessionId);
  const exercise = getExercise(ds, es.exerciseId);
  const timeBased = exercise.progression.strategy === 'time-based';
  const bodyweight = exercise.equipment === 'bodyweight' || timeBased;
  const err = validateSetEntry({ load: input.load, reps: input.reps, rir: input.rir, bodyweight, timeBased });
  if (err) fail(err);
  if (input.rirConfidence !== null && !(Number.isInteger(input.rirConfidence) && input.rirConfidence >= 1 && input.rirConfidence <= 5)) fail('RIR confidence must be 1–5.');
  if (input.note.length > 200) fail('Set notes are limited to 200 characters.');
  const existing = es.sets.find((s) => s.index === setIndex) ?? fail('That set does not exist.');
  const updated: SetPerformance = {
    ...existing,
    load: input.load,
    unit: exercise.unit,
    reps: input.reps,
    rir: input.status === 'failed' ? 0 : input.rir,
    rirConfidence: input.rirConfidence,
    note: input.note.trim(),
    status: input.status,
  };
  const change = emptyChange();
  if (es.status === 'completed') discardResults(ds, change, es.id);
  putRecords(change, 'exerciseSessions', [{ ...es, status: 'in-progress', completedAt: null, sets: es.sets.map((s) => (s.index === setIndex ? updated : s)) }]);
  return change;
}

export function markSet(ds: Dataset, exerciseSessionId: string, setIndex: number, status: Extract<SetStatus, 'skipped' | 'pending'>): Change {
  const { es } = editableSession(ds, exerciseSessionId);
  if (!es.sets.some((s) => s.index === setIndex)) fail('That set does not exist.');
  const change = emptyChange();
  if (es.status === 'completed') discardResults(ds, change, es.id);
  const sets = es.sets.map((s) => (s.index === setIndex ? { ...s, status, load: null, reps: null, rir: null, rirConfidence: null } : s));
  putRecords(change, 'exerciseSessions', [{ ...es, status: 'in-progress', completedAt: null, sets }]);
  return change;
}

export function addSet(ds: Dataset, exerciseSessionId: string, ctx: Ctx): Change {
  const { es } = editableSession(ds, exerciseSessionId);
  if (es.sets.length >= 12) fail('Up to 12 sets per exercise.');
  const exercise = getExercise(ds, es.exerciseId);
  const index = es.sets.length ? Math.max(...es.sets.map((s) => s.index)) + 1 : 0;
  const change = emptyChange();
  if (es.status === 'completed') discardResults(ds, change, es.id);
  const set: SetPerformance = { id: ctx.newId('set'), index, load: null, unit: exercise.unit, reps: null, rir: null, rirConfidence: null, status: 'pending', note: '' };
  putRecords(change, 'exerciseSessions', [{ ...es, status: es.status === 'pending' ? 'pending' : 'in-progress', completedAt: null, sets: [...es.sets, set] }]);
  return change;
}

/** Remove the last set if it hasn't been logged. Logged sets can be cleared, never silently deleted. */
export function removeLastSet(ds: Dataset, exerciseSessionId: string): Change {
  const { es } = editableSession(ds, exerciseSessionId);
  const last = [...es.sets].sort((a, b) => b.index - a.index)[0];
  if (!last) fail('There are no sets to remove.');
  if (last && (last.status === 'completed' || last.status === 'failed')) fail('Clear the logged set first, then remove it.');
  if (es.sets.length <= 1) fail('An exercise needs at least one set. Skip the exercise instead.');
  return putRecords(emptyChange(), 'exerciseSessions', [{ ...es, sets: es.sets.filter((s) => s.id !== last?.id) }]);
}

export function setPain(ds: Dataset, exerciseSessionId: string, pain: PainLevel, ctx: Ctx): Change {
  const { es } = editableSession(ds, exerciseSessionId);
  if (es.status === 'completed') {
    // Pain changes the recommendation, so recompute it (same completion time) right away.
    const withPain = { ...ds, exerciseSessions: ds.exerciseSessions.map((s) => (s.id === es.id ? { ...es, pain } : s)) };
    return completeExercise(withPain, es.id, { ...ctx, now: es.completedAt ?? ctx.now }).change;
  }
  return putRecords(emptyChange(), 'exerciseSessions', [{ ...es, pain }]);
}

export function setExerciseNote(ds: Dataset, exerciseSessionId: string, note: string): Change {
  const { es } = editableSession(ds, exerciseSessionId);
  if (note.length > 300) fail('Notes are limited to 300 characters.');
  return putRecords(emptyChange(), 'exerciseSessions', [{ ...es, note: note.trim() }]);
}

export interface CompletionResult {
  change: Change;
  recommendation: ProgressionRecommendation | null;
  records: Dataset['personalRecords'];
}

/**
 * Complete an exercise: freeze its sets, ask the engine for the next target and
 * detect PRs against everything logged before it. With no performed sets it is marked skipped.
 */
export function completeExercise(ds: Dataset, exerciseSessionId: string, ctx: Ctx): CompletionResult {
  const { es, workout } = editableSession(ds, exerciseSessionId);
  const exercise = getExercise(ds, es.exerciseId);
  const change = emptyChange();
  discardResults(ds, change, es.id);
  const performed = es.sets.filter((s) => s.status === 'completed' || s.status === 'failed');
  if (performed.length === 0) {
    putRecords(change, 'exerciseSessions', [{ ...es, status: 'skipped', completedAt: null }]);
    return { change, recommendation: null, records: [] };
  }
  const completed: ExerciseSession = { ...es, status: 'completed', completedAt: ctx.now };
  const next: Dataset = { ...ds, exerciseSessions: ds.exerciseSessions.map((s) => (s.id === es.id ? completed : s)) };
  const history = historyFor(next, exercise.id);
  const result = recommendNext({ exercise, history, options: engineOptions(next) });
  const recommendation = toRecommendation(result, exercise.id, es.id, ctx);

  const opts = engineOptions(next);
  const prior = history.filter((h) => h.session.id !== es.id).map((h) => evaluateSession(h.session, exercise, opts));
  const current = evaluateSession(completed, exercise, opts);
  const records = detectPersonalRecords(prior, current, exercise.progression.strategy === 'time-based').map((p) => ({
    id: prIdFor(es.id, p.type),
    exerciseId: exercise.id,
    exerciseSessionId: es.id,
    workoutSessionId: workout.id,
    type: p.type,
    value: p.value,
    load: p.load,
    reps: p.reps,
    unit: exercise.unit,
    previousValue: p.previousValue,
    achievedAt: ctx.now,
  }));
  putRecords(change, 'exerciseSessions', [completed]);
  putRecords(change, 'recommendations', [recommendation]);
  if (records.length) putRecords(change, 'personalRecords', records);
  return { change, recommendation, records };
}

export function reopenExercise(ds: Dataset, exerciseSessionId: string): Change {
  const { es } = editableSession(ds, exerciseSessionId);
  const change = emptyChange();
  discardResults(ds, change, es.id);
  const performed = es.sets.some((s) => s.status === 'completed' || s.status === 'failed');
  putRecords(change, 'exerciseSessions', [{ ...es, status: performed ? 'in-progress' : 'pending', completedAt: null }]);
  return change;
}

export function skipExercise(ds: Dataset, exerciseSessionId: string): Change {
  const { es } = editableSession(ds, exerciseSessionId);
  if (es.sets.some((s) => s.status === 'completed' || s.status === 'failed')) fail('Sets are already logged. Complete the exercise instead, or clear the sets first.');
  const change = emptyChange();
  discardResults(ds, change, es.id);
  putRecords(change, 'exerciseSessions', [{ ...es, status: 'skipped', completedAt: null }]);
  return change;
}

export function substituteExercise(ds: Dataset, exerciseSessionId: string, substituteExerciseId: string, reason: string, ctx: Ctx): { change: Change; newSessionId: string } {
  const { es, workout } = editableSession(ds, exerciseSessionId);
  if (es.sets.some((s) => s.status === 'completed' || s.status === 'failed')) fail('Sets are already logged for this exercise. Complete it, then add the replacement.');
  const original = getExercise(ds, es.exerciseId);
  const sub = getExercise(ds, substituteExerciseId);
  if (sub.id === original.id) fail('Pick a different exercise.');
  if (sub.archived) fail('Archived exercises cannot be used.');
  if (sessionsForWorkout(ds, workout.id).some((s) => s.exerciseId === sub.id && s.status !== 'skipped')) fail(`${sub.name} is already in this workout.`);
  const created = newExerciseSession(ds, workout, sub, es.order + 0.5, readinessForWorkout(ds, workout), ctx, original.id);
  const change = emptyChange();
  discardResults(ds, change, es.id);
  putRecords(change, 'exerciseSessions', [{ ...es, status: 'skipped', completedAt: null }, created]);
  putRecords(change, 'substitutions', [
    { id: ctx.newId('sub'), workoutSessionId: workout.id, originalExerciseSessionId: es.id, originalExerciseId: original.id, substituteExerciseId: sub.id, reason: reason.trim().slice(0, 200), createdAt: ctx.now },
  ]);
  return { change, newSessionId: created.id };
}

/** Finish: complete everything that has logged sets, skip the rest. Requires at least one completed exercise. */
export function finishWorkout(ds: Dataset, workoutId: string, ctx: Ctx): Change {
  const workout = getWorkout(ds, workoutId);
  if (workout.status !== 'in-progress') fail('This workout is already finished.');
  let current = ds;
  const parts: Change[] = [];
  for (const es of sessionsForWorkout(ds, workoutId)) {
    const live = current.exerciseSessions.find((s) => s.id === es.id) as ExerciseSession;
    if (live.status === 'completed' || live.status === 'skipped') continue;
    const performed = live.sets.some((s) => s.status === 'completed' || s.status === 'failed');
    const part = performed ? completeExercise(current, live.id, ctx).change : putRecords(emptyChange(), 'exerciseSessions', [{ ...live, status: 'skipped', completedAt: null }]);
    parts.push(part);
    current = applyChange(current, part);
  }
  const anyCompleted = current.exerciseSessions.some((s) => s.workoutSessionId === workoutId && s.status === 'completed');
  if (!anyCompleted) fail('Nothing has been logged in this workout. Log a set or discard the workout.');
  parts.push(putRecords(emptyChange(), 'workoutSessions', [{ ...workout, status: 'completed', completedAt: ctx.now }]));
  return mergeChanges(...parts);
}

/** Delete an in-progress workout and everything it created. Completed workouts can't be discarded. */
export function discardWorkout(ds: Dataset, workoutId: string): Change {
  const workout = getWorkout(ds, workoutId);
  if (workout.status !== 'in-progress') fail('Completed workouts are kept as history and cannot be discarded.');
  const sessions = ds.exerciseSessions.filter((s) => s.workoutSessionId === workoutId);
  const change = emptyChange();
  for (const s of sessions) discardResults(ds, change, s.id);
  removeRecords(change, 'exerciseSessions', sessions.map((s) => s.id));
  removeRecords(change, 'workoutSessions', [workoutId]);
  const rd = ds.readiness.filter((r) => r.workoutSessionId === workoutId).map((r) => r.id);
  if (rd.length) removeRecords(change, 'readiness', rd);
  const subs = ds.substitutions.filter((r) => r.workoutSessionId === workoutId).map((r) => r.id);
  if (subs.length) removeRecords(change, 'substitutions', subs);
  return change;
}

export function setWorkoutNote(ds: Dataset, workoutId: string, notes: string): Change {
  const workout = getWorkout(ds, workoutId);
  if (workout.status !== 'in-progress') fail('Completed workouts are read-only.');
  if (notes.length > 500) fail('Workout notes are limited to 500 characters.');
  return putRecords(emptyChange(), 'workoutSessions', [{ ...workout, notes }]);
}

// ───────────────────────── exercises ─────────────────────────

export interface ExerciseInput {
  name: string;
  muscleGroup: Exercise['muscleGroup'];
  equipment: Exercise['equipment'];
  unit: Exercise['unit'];
  progression: ProgressionConfig;
  notes: string;
}

export interface FieldErrors {
  [field: string]: string;
}

export function validateExerciseInput(ds: Dataset, input: ExerciseInput, id?: string): FieldErrors {
  const errors: FieldErrors = {};
  const name = input.name.trim();
  if (!name) errors.name = 'Give the exercise a name.';
  else if (name.length > 60) errors.name = 'Keep the name under 60 characters.';
  else if (ds.exercises.some((e) => e.id !== id && !e.archived && e.name.trim().toLowerCase() === name.toLowerCase())) errors.name = 'An exercise with this name already exists.';
  if (!MUSCLE_GROUPS.some((m) => m.value === input.muscleGroup)) errors.muscleGroup = 'Pick a muscle group.';
  if (!EQUIPMENT_TYPES.some((m) => m.value === input.equipment)) errors.equipment = 'Pick the equipment.';
  if (input.unit !== 'lb' && input.unit !== 'kg' && input.unit !== 'plt') errors.unit = 'Unit must be lb, kg or plt.';
  if (input.notes.length > 500) errors.notes = 'Notes are limited to 500 characters.';
  for (const e of validateProgressionConfig(input.progression).errors) errors[e.field] ??= e.message;
  return errors;
}

export function createExercise(ds: Dataset, input: ExerciseInput, ctx: Ctx): { change: Change; id: string } {
  const errors = validateExerciseInput(ds, input);
  const first = Object.values(errors)[0];
  if (first) fail(first);
  const exercise: Exercise = { id: ctx.newId('ex'), ...input, name: input.name.trim(), notes: input.notes.trim(), archived: false, createdAt: ctx.now, updatedAt: ctx.now };
  return { change: putRecords(emptyChange(), 'exercises', [exercise]), id: exercise.id };
}

/** Settings changes apply to future recommendations. Logged sets keep their own unit, so history is never rewritten. */
export function updateExercise(ds: Dataset, id: string, input: ExerciseInput, ctx: Ctx): Change {
  const existing = getExercise(ds, id);
  const errors = validateExerciseInput(ds, input, id);
  const first = Object.values(errors)[0];
  if (first) fail(first);
  return putRecords(emptyChange(), 'exercises', [{ ...existing, ...input, name: input.name.trim(), notes: input.notes.trim(), updatedAt: ctx.now }]);
}

export function setExerciseArchived(ds: Dataset, id: string, archived: boolean, ctx: Ctx): Change {
  const existing = getExercise(ds, id);
  if (!archived && ds.exercises.some((e) => e.id !== id && !e.archived && e.name.trim().toLowerCase() === existing.name.trim().toLowerCase())) fail('Another active exercise has the same name.');
  const change = putRecords(emptyChange(), 'exercises', [{ ...existing, archived, updatedAt: ctx.now }]);
  if (archived) {
    const days = ds.routineDays.filter((d) => d.exerciseIds.includes(id)).map((d) => ({ ...d, exerciseIds: d.exerciseIds.filter((x) => x !== id) }));
    if (days.length) putRecords(change, 'routineDays', days);
  }
  return change;
}

/** Hard delete is only allowed for exercises that were never logged; otherwise archive. */
export function deleteExercise(ds: Dataset, id: string): Change {
  getExercise(ds, id);
  if (ds.exerciseSessions.some((s) => s.exerciseId === id)) fail('This exercise has history. Archive it instead so the history is kept.');
  const change = removeRecords(emptyChange(), 'exercises', [id]);
  const days = ds.routineDays.filter((d) => d.exerciseIds.includes(id)).map((d) => ({ ...d, exerciseIds: d.exerciseIds.filter((x) => x !== id) }));
  if (days.length) putRecords(change, 'routineDays', days);
  const recs = ds.recommendations.filter((r) => r.exerciseId === id).map((r) => r.id);
  if (recs.length) removeRecords(change, 'recommendations', recs);
  return change;
}

// ───────────────────────── routines ─────────────────────────

const cleanName = (n: string, what: string) => {
  const s = n.trim();
  if (!s) fail(`Give the ${what} a name.`);
  if (s.length > 40) fail(`Keep the ${what} name under 40 characters.`);
  return s;
};

export function createRoutine(ds: Dataset, name: string, dayNames: string[], ctx: Ctx): { change: Change; id: string } {
  const routine: Routine = { id: ctx.newId('rt'), name: cleanName(name, 'routine'), dayIds: [], createdAt: ctx.now };
  const days: RoutineDay[] = dayNames.map((n) => ({ id: ctx.newId('day'), routineId: routine.id, name: cleanName(n, 'day'), exerciseIds: [] }));
  routine.dayIds = days.map((d) => d.id);
  const change = putRecords(emptyChange(), 'routines', [routine]);
  putRecords(change, 'routineDays', days);
  if (!ds.settings.activeRoutineId) change.settings = { ...ds.settings, activeRoutineId: routine.id, updatedAt: ctx.now };
  return { change, id: routine.id };
}

function getRoutine(ds: Dataset, id: string): Routine {
  return ds.routines.find((r) => r.id === id) ?? fail('That routine no longer exists.');
}
function getDay(ds: Dataset, id: string): RoutineDay {
  return ds.routineDays.find((d) => d.id === id) ?? fail('That day no longer exists.');
}

export function renameRoutine(ds: Dataset, id: string, name: string): Change {
  return putRecords(emptyChange(), 'routines', [{ ...getRoutine(ds, id), name: cleanName(name, 'routine') }]);
}

export function deleteRoutine(ds: Dataset, id: string, ctx: Ctx): Change {
  const routine = getRoutine(ds, id);
  const change = removeRecords(emptyChange(), 'routines', [id]);
  removeRecords(change, 'routineDays', routine.dayIds);
  if (ds.settings.activeRoutineId === id) change.settings = { ...ds.settings, activeRoutineId: ds.routines.find((r) => r.id !== id)?.id ?? null, updatedAt: ctx.now };
  return change;
}

export function addRoutineDay(ds: Dataset, routineId: string, name: string, ctx: Ctx): Change {
  const routine = getRoutine(ds, routineId);
  if (routine.dayIds.length >= 7) fail('Up to 7 days per routine.');
  const day: RoutineDay = { id: ctx.newId('day'), routineId, name: cleanName(name, 'day'), exerciseIds: [] };
  const change = putRecords(emptyChange(), 'routineDays', [day]);
  putRecords(change, 'routines', [{ ...routine, dayIds: [...routine.dayIds, day.id] }]);
  return change;
}

export function renameRoutineDay(ds: Dataset, dayId: string, name: string): Change {
  return putRecords(emptyChange(), 'routineDays', [{ ...getDay(ds, dayId), name: cleanName(name, 'day') }]);
}

/** Past workouts keep a snapshot of the day name, so removing a day never changes history. */
export function removeRoutineDay(ds: Dataset, dayId: string): Change {
  const day = getDay(ds, dayId);
  const routine = getRoutine(ds, day.routineId);
  const change = removeRecords(emptyChange(), 'routineDays', [dayId]);
  putRecords(change, 'routines', [{ ...routine, dayIds: routine.dayIds.filter((d) => d !== dayId) }]);
  return change;
}

export function moveRoutineDay(ds: Dataset, dayId: string, delta: -1 | 1): Change {
  const day = getDay(ds, dayId);
  const routine = getRoutine(ds, day.routineId);
  return putRecords(emptyChange(), 'routines', [{ ...routine, dayIds: move(routine.dayIds, dayId, delta) }]);
}

export function setDayExercises(ds: Dataset, dayId: string, exerciseIds: string[]): Change {
  const day = getDay(ds, dayId);
  const known = new Set(ds.exercises.filter((e) => !e.archived).map((e) => e.id));
  const ids = [...new Set(exerciseIds)].filter((id) => known.has(id));
  if (ids.length > 15) fail('Up to 15 exercises per day.');
  return putRecords(emptyChange(), 'routineDays', [{ ...day, exerciseIds: ids }]);
}

export function moveDayExercise(ds: Dataset, dayId: string, exerciseId: string, delta: -1 | 1): Change {
  const day = getDay(ds, dayId);
  return putRecords(emptyChange(), 'routineDays', [{ ...day, exerciseIds: move(day.exerciseIds, exerciseId, delta) }]);
}

function move(list: readonly string[], id: string, delta: -1 | 1): string[] {
  const out = [...list];
  const i = out.indexOf(id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= out.length) return out;
  [out[i], out[j]] = [out[j] as string, out[i] as string];
  return out;
}

// ───────────────────────── settings ─────────────────────────

export function updateSettings(ds: Dataset, patch: Partial<Omit<UserSettings, 'id' | 'createdAt' | 'updatedAt'>>, ctx: Ctx): Change {
  const next: UserSettings = { ...ds.settings, ...patch, updatedAt: ctx.now };
  if (next.defaultUnit !== 'lb' && next.defaultUnit !== 'kg' && next.defaultUnit !== 'plt') fail('Unit must be lb, kg or plt.');
  if (!(Number.isInteger(next.defaultRirConfidence) && next.defaultRirConfidence >= 1 && next.defaultRirConfidence <= 5)) fail('Default RIR confidence must be 1–5.');
  if (next.activeRoutineId && !ds.routines.some((r) => r.id === next.activeRoutineId)) fail('That routine no longer exists.');
  return { put: {}, remove: {}, settings: next };
}
