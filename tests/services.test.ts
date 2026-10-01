import { beforeEach, describe, expect, it } from 'vitest';
import { applyChange, emptyDataset, mergeChanges, putRecords, removeRecords, emptyChange } from '../src/domain/change';
import { defaultProgression, defaultSettings } from '../src/domain/defaults';
import type { Dataset } from '../src/domain/types';
import { activeWorkout, nextRoutineDay, sessionsForWorkout } from '../src/app/selectors';
import * as S from '../src/app/services';

let n = 0;
const ctx = (iso = '2026-09-01T18:00:00.000Z'): S.Ctx => ({ now: iso, newId: (p) => `${p}_${++n}` });
let ds: Dataset;
const apply = (c: ReturnType<typeof emptyChange>) => (ds = applyChange(ds, c));

function setup() {
  ds = emptyDataset(defaultSettings('2026-08-01T00:00:00.000Z'));
  const bench = S.createExercise(ds, { name: 'Bench', muscleGroup: 'chest', equipment: 'barbell', unit: 'lb', progression: defaultProgression(), notes: '' }, ctx());
  apply(bench.change);
  const dips = S.createExercise(ds, { name: 'Dip', muscleGroup: 'chest', equipment: 'bodyweight', unit: 'lb', progression: defaultProgression({ loadIncrement: 0 }), notes: '' }, ctx());
  apply(dips.change);
  const rt = S.createRoutine(ds, 'Push', ['Day 1', 'Day 2'], ctx());
  apply(rt.change);
  const day1 = ds.routineDays.find((d) => d.name === 'Day 1')!;
  apply(S.setDayExercises(ds, day1.id, [bench.id]));
  return { benchId: bench.id, dipId: dips.id, day1Id: day1.id };
}

const set = (load: number | null, reps: number, rir: number | null = 2) => ({ load, reps, rir, rirConfidence: null, note: '', status: 'completed' as const });

function doWorkout(day1Id: string, reps: [number, number, number], load = 135, iso = '2026-09-01T18:00:00.000Z') {
  const w = S.startWorkout(ds, { routineDayId: day1Id, readiness: null }, ctx(iso));
  apply(w.change);
  const es = sessionsForWorkout(ds, w.workoutId)[0]!;
  reps.forEach((r, i) => apply(S.logSet(ds, es.id, i, set(load, r))));
  const done = S.completeExercise(ds, es.id, ctx(iso));
  apply(done.change);
  apply(S.finishWorkout(ds, w.workoutId, ctx(iso)));
  return { workoutId: w.workoutId, esId: es.id, rec: done.recommendation };
}

describe('change model', () => {
  it('applies puts/removes immutably and merges in order', () => {
    const base = emptyDataset(defaultSettings('2026-01-01T00:00:00.000Z'));
    const r = { id: 'rt', name: 'A', dayIds: [], createdAt: '2026-01-01T00:00:00.000Z' };
    const c1 = putRecords(emptyChange(), 'routines', [r]);
    const c2 = removeRecords(emptyChange(), 'routines', ['rt']);
    expect(applyChange(base, c1).routines).toHaveLength(1);
    expect(base.routines).toHaveLength(0);
    expect(applyChange(base, mergeChanges(c1, c2)).routines).toHaveLength(0);
    expect(applyChange(base, mergeChanges(c2, c1)).routines).toHaveLength(1);
  });
});

describe('workout lifecycle', () => {
  let ids: ReturnType<typeof setup>;
  beforeEach(() => (ids = setup()));

  it('first workout prescribes a baseline and completion recommends the next target', () => {
    const { rec } = doWorkout(ids.day1Id, [12, 12, 12]);
    expect(rec?.ruleId).toBe('A_TOP_OF_RANGE');
    expect(rec?.target.load).toBe(140);
    expect(ds.recommendations).toHaveLength(1);
  });

  it('next workout is prescribed from history and links the stored recommendation', () => {
    const first = doWorkout(ids.day1Id, [12, 12, 12]);
    const w = S.startWorkout(ds, { routineDayId: ids.day1Id, readiness: null }, ctx('2026-09-03T18:00:00.000Z'));
    apply(w.change);
    const es = sessionsForWorkout(ds, w.workoutId)[0]!;
    expect(es.prescribed.load).toBe(140);
    expect(es.prescribed.repTargets).toEqual([8, 8, 8]);
    expect(es.prescribed.recommendationId).toBe(first.rec?.id);
    expect(es.sets.every((s) => s.status === 'pending')).toBe(true);
  });

  it('only one workout can be in progress', () => {
    apply(S.startWorkout(ds, { routineDayId: ids.day1Id, readiness: null }, ctx()).change);
    expect(() => S.startWorkout(ds, { routineDayId: null, readiness: null }, ctx())).toThrow(/already in progress/);
  });

  it('completed workouts are read-only (history is never overwritten)', () => {
    const { esId, workoutId } = doWorkout(ids.day1Id, [10, 10, 10]);
    expect(() => S.logSet(ds, esId, 0, set(135, 12))).toThrow(/read-only/);
    expect(() => S.discardWorkout(ds, workoutId)).toThrow(/cannot be discarded/);
    expect(() => S.addSet(ds, esId, ctx())).toThrow(/read-only/);
  });

  it('editing a completed exercise in the active workout reopens it and drops its provisional results', () => {
    const w = S.startWorkout(ds, { routineDayId: ids.day1Id, readiness: null }, ctx());
    apply(w.change);
    const es = sessionsForWorkout(ds, w.workoutId)[0]!;
    [12, 12, 12].forEach((r, i) => apply(S.logSet(ds, es.id, i, set(135, r))));
    apply(S.completeExercise(ds, es.id, ctx()).change);
    expect(ds.recommendations).toHaveLength(1);
    apply(S.logSet(ds, es.id, 2, set(135, 9)));
    expect(ds.exerciseSessions.find((s) => s.id === es.id)?.status).toBe('in-progress');
    expect(ds.recommendations).toHaveLength(0);
    const again = S.completeExercise(ds, es.id, ctx());
    expect(again.recommendation?.ruleId).toBe('B_ADD_REPS');
  });

  it('pain logged after completion recomputes the recommendation', () => {
    const w = S.startWorkout(ds, { routineDayId: ids.day1Id, readiness: null }, ctx());
    apply(w.change);
    const es = sessionsForWorkout(ds, w.workoutId)[0]!;
    [12, 12, 12].forEach((r, i) => apply(S.logSet(ds, es.id, i, set(135, r))));
    apply(S.completeExercise(ds, es.id, ctx()).change);
    apply(S.setPain(ds, es.id, 'significant', ctx()));
    expect(ds.recommendations[0]?.ruleId).toBe('PAIN_REVIEW');
  });

  it('validates set input', () => {
    const w = S.startWorkout(ds, { routineDayId: ids.day1Id, readiness: null }, ctx());
    apply(w.change);
    const es = sessionsForWorkout(ds, w.workoutId)[0]!;
    expect(() => S.logSet(ds, es.id, 0, set(null, 10))).toThrow(/weight/);
    expect(() => S.logSet(ds, es.id, 0, set(135, -1))).toThrow(/whole number/);
    expect(() => S.logSet(ds, es.id, 0, { ...set(135, 10), rirConfidence: 9 })).toThrow(/confidence/);
    expect(() => S.logSet(ds, es.id, 9, set(135, 10))).toThrow(/does not exist/);
  });

  it('finish completes logged exercises, skips untouched ones, and refuses an empty workout', () => {
    const w = S.startWorkout(ds, { routineDayId: ids.day1Id, readiness: null }, ctx());
    apply(w.change);
    apply(S.addExerciseToWorkout(ds, w.workoutId, ids.dipId, ctx()));
    expect(() => S.finishWorkout(ds, w.workoutId, ctx())).toThrow(/Nothing has been logged/);
    const [bench, dip] = sessionsForWorkout(ds, w.workoutId);
    apply(S.logSet(ds, bench!.id, 0, set(135, 10)));
    apply(S.finishWorkout(ds, w.workoutId, ctx()));
    expect(ds.exerciseSessions.find((s) => s.id === bench!.id)?.status).toBe('completed');
    expect(ds.exerciseSessions.find((s) => s.id === dip!.id)?.status).toBe('skipped');
    expect(activeWorkout(ds)).toBeNull();
    // Two sets never logged → the engine repeats instead of progressing.
    expect(ds.recommendations[0]?.ruleId).toBe('INCOMPLETE_SESSION');
  });

  it('discard removes the in-progress workout and everything it created', () => {
    const w = S.startWorkout(ds, { routineDayId: ids.day1Id, readiness: { readiness: 3, energy: 3, fatigue: 3, sleepHours: 7, pain: false } }, ctx());
    apply(w.change);
    const es = sessionsForWorkout(ds, w.workoutId)[0]!;
    apply(S.logSet(ds, es.id, 0, set(135, 10)));
    apply(S.discardWorkout(ds, w.workoutId));
    expect(ds.workoutSessions).toHaveLength(0);
    expect(ds.exerciseSessions).toHaveLength(0);
    expect(ds.readiness).toHaveLength(0);
  });

  it('substitution skips the original and adds the replacement with its own prescription', () => {
    const w = S.startWorkout(ds, { routineDayId: ids.day1Id, readiness: null }, ctx());
    apply(w.change);
    const es = sessionsForWorkout(ds, w.workoutId)[0]!;
    apply(S.substituteExercise(ds, es.id, ids.dipId, 'Shoulder niggle', ctx()).change);
    const list = sessionsForWorkout(ds, w.workoutId);
    expect(list.map((s) => s.status)).toEqual(['skipped', 'pending']);
    expect(list[1]?.substitutedFromExerciseId).toBe(ids.benchId);
    expect(ds.substitutions).toHaveLength(1);
  });

  it('readiness adjusts today only; the stored recommendation is untouched', () => {
    doWorkout(ids.day1Id, [12, 12, 12]);
    const w = S.startWorkout(ds, { routineDayId: ids.day1Id, readiness: { readiness: 1, energy: 2, fatigue: 5, sleepHours: 4.5, pain: false } }, ctx('2026-09-03T18:00:00.000Z'));
    apply(w.change);
    const es = sessionsForWorkout(ds, w.workoutId)[0]!;
    expect(es.prescribed.readinessAdjusted).toBe(true);
    expect(es.prescribed.load).toBe(135);
    expect(es.prescribed.sets).toBe(2);
    expect(ds.recommendations[0]?.target.load).toBe(140);
  });

  it('rotation advances through routine days', () => {
    expect(nextRoutineDay(ds)?.name).toBe('Day 1');
    doWorkout(ids.day1Id, [10, 10, 10]);
    expect(nextRoutineDay(ds)?.name).toBe('Day 2');
  });

  it('exercises with history can only be archived; archiving removes them from routine days', () => {
    doWorkout(ids.day1Id, [10, 10, 10]);
    expect(() => S.deleteExercise(ds, ids.benchId)).toThrow(/Archive/);
    apply(S.setExerciseArchived(ds, ids.benchId, true, ctx()));
    expect(ds.routineDays.find((d) => d.id === ids.day1Id)?.exerciseIds).toEqual([]);
    expect(ds.exerciseSessions.length).toBeGreaterThan(0);
    apply(S.deleteExercise(ds, ids.dipId));
    expect(ds.exercises.some((e) => e.id === ids.dipId)).toBe(false);
  });

  it('accepts the plates unit and rejects unknown units', () => {
    const ok = S.validateExerciseInput(ds, { name: 'Pin Press', muscleGroup: 'chest', equipment: 'machine', unit: 'plt', progression: defaultProgression({ loadIncrement: 1 }), notes: '' });
    expect(ok.unit).toBeUndefined();
    const bad = S.validateExerciseInput(ds, { name: 'Pin Press', muscleGroup: 'chest', equipment: 'machine', unit: 'stone' as never, progression: defaultProgression(), notes: '' });
    expect(bad.unit).toBe('Unit must be lb, kg or plt.');
    expect(() => S.updateSettings(ds, { defaultUnit: 'stone' as never }, ctx())).toThrow(/lb, kg or plt/);
  });

  it('validates exercise input', () => {
    const bad = S.validateExerciseInput(ds, { name: 'bench', muscleGroup: 'chest', equipment: 'barbell', unit: 'lb', progression: defaultProgression({ minReps: 12, maxReps: 8 }), notes: '' });
    expect(bad.name).toMatch(/already exists/);
    expect(bad.maxReps).toMatch(/lower than the minimum/);
  });
});
