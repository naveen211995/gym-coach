/**
 * Weekly schedule: Mon/Tue/Thu/Fri by default, explicit rest days, a workout
 * allowed on more than one weekday, and the old rotation kept as the fallback
 * for routines that have no schedule.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { applyChange, emptyChange, emptyDataset } from '../src/domain/change';
import { DEFAULT_SPLIT, defaultProgression, defaultSettings, hasSchedule, scheduleOf } from '../src/domain/defaults';
import type { Dataset, RoutineDay } from '../src/domain/types';
import { activeRoutine, plannedWorkout, weekdayOf } from '../src/app/selectors';
import * as S from '../src/app/services';

let n = 0;
const ctx = (iso = '2026-10-12T18:00:00.000Z'): S.Ctx => ({ now: iso, newId: (p) => `${p}_${++n}` });
let ds: Dataset;
const apply = (c: ReturnType<typeof emptyChange>) => (ds = applyChange(ds, c));
const dayNamed = (name: string): RoutineDay => ds.routineDays.find((d) => d.name === name) as RoutineDay;

/** Local dates in October 2026: the 12th is a Monday. */
const MON = new Date(2026, 9, 12, 18, 0);
const TUE = new Date(2026, 9, 13, 18, 0);
const WED = new Date(2026, 9, 14, 18, 0);
const THU = new Date(2026, 9, 15, 18, 0);
const FRI = new Date(2026, 9, 16, 18, 0);
const SUN = new Date(2026, 9, 18, 18, 0);

function exercise(name: string) {
  const r = S.createExercise(ds, { name, muscleGroup: 'chest', equipment: 'barbell', unit: 'lb', progression: defaultProgression(), notes: '' }, ctx());
  apply(r.change);
  return r.id;
}

beforeEach(() => {
  ds = emptyDataset(defaultSettings('2026-10-01T00:00:00.000Z'));
});

describe('weekday mapping', () => {
  it('is Monday-first', () => {
    expect(weekdayOf(MON)).toBe('mon');
    expect(weekdayOf(THU)).toBe('thu');
    expect(weekdayOf(SUN)).toBe('sun');
  });
});

describe('a new routine gets the default split', () => {
  beforeEach(() => {
    apply(S.createRoutine(ds, 'My split', DEFAULT_SPLIT.map((d) => ({ name: d.name, weekdays: d.weekdays })), ctx()).change);
  });

  it('creates the four named days', () => {
    expect(ds.routineDays.map((d) => d.name)).toEqual(['Push', 'Pull', 'Legs', 'Delts + Width + Arms']);
  });

  it('puts them on Monday, Tuesday, Thursday and Friday', () => {
    const s = scheduleOf(activeRoutine(ds));
    expect(s.mon).toBe(dayNamed('Push').id);
    expect(s.tue).toBe(dayNamed('Pull').id);
    expect(s.thu).toBe(dayNamed('Legs').id);
    expect(s.fri).toBe(dayNamed('Delts + Width + Arms').id);
  });

  it('leaves Wednesday, Saturday and Sunday as rest', () => {
    const s = scheduleOf(activeRoutine(ds));
    expect([s.wed, s.sat, s.sun]).toEqual([null, null, null]);
  });

  it('plans the right workout for each day of the week', () => {
    expect(plannedWorkout(ds, MON).day?.name).toBe('Push');
    expect(plannedWorkout(ds, TUE).day?.name).toBe('Pull');
    expect(plannedWorkout(ds, THU).day?.name).toBe('Legs');
    expect(plannedWorkout(ds, FRI).day?.name).toBe('Delts + Width + Arms');
    expect(plannedWorkout(ds, MON).source).toBe('schedule');
  });

  it('calls a rest day a rest day, and points at the next workout', () => {
    const wed = plannedWorkout(ds, WED);
    expect(wed.rest).toBe(true);
    expect(wed.day).toBeNull();
    expect(wed.next).toMatchObject({ weekday: 'thu', inDays: 1 });
    expect(wed.next?.day.name).toBe('Legs');
  });

  it('wraps to next week from a Sunday', () => {
    const sun = plannedWorkout(ds, SUN);
    expect(sun.rest).toBe(true);
    expect(sun.next).toMatchObject({ weekday: 'mon', inDays: 1 });
  });
});

describe('editing the schedule', () => {
  beforeEach(() => {
    apply(S.createRoutine(ds, 'My split', DEFAULT_SPLIT.map((d) => ({ name: d.name, weekdays: d.weekdays })), ctx()).change);
  });

  it('moves a workout to another weekday', () => {
    const routine = activeRoutine(ds)!;
    apply(S.setRoutineSchedule(ds, routine.id, 'wed', dayNamed('Legs').id));
    apply(S.setRoutineSchedule(ds, routine.id, 'thu', null));
    expect(plannedWorkout(ds, WED).day?.name).toBe('Legs');
    expect(plannedWorkout(ds, THU).rest).toBe(true);
  });

  it('allows the same workout on two weekdays', () => {
    const routine = activeRoutine(ds)!;
    apply(S.setRoutineSchedule(ds, routine.id, 'sat', dayNamed('Push').id));
    expect(plannedWorkout(ds, MON).day?.name).toBe('Push');
    expect(plannedWorkout(ds, new Date(2026, 9, 17, 18, 0)).day?.name).toBe('Push');
  });

  it('refuses a day from another routine', () => {
    const other = S.createRoutine(ds, 'Other', ['Full body'], ctx());
    apply(other.change);
    const routine = ds.routines.find((r) => r.name === 'My split')!;
    expect(() => S.setRoutineSchedule(ds, routine.id, 'sat', dayNamed('Full body').id)).toThrow(/not part of this routine/);
  });

  it('turns a deleted day into rest rather than a dangling reference', () => {
    const routine = activeRoutine(ds)!;
    apply(S.removeRoutineDay(ds, dayNamed('Legs').id));
    expect(scheduleOf(ds.routines.find((r) => r.id === routine.id)).thu).toBeNull();
    expect(plannedWorkout(ds, THU).rest).toBe(true);
  });
});

describe('applying the split to a routine that already exists', () => {
  let benchId: string;
  beforeEach(() => {
    benchId = exercise('Bench');
    apply(S.createRoutine(ds, 'Old routine', ['Day 1'], ctx()).change);
    apply(S.setDayExercises(ds, dayNamed('Day 1').id, [benchId]));
  });

  it('is what the old behaviour looked like: always the first day', () => {
    expect(hasSchedule(activeRoutine(ds))).toBe(false);
    expect(plannedWorkout(ds, MON).day?.name).toBe('Day 1');
    expect(plannedWorkout(ds, WED).day?.name).toBe('Day 1');
    expect(plannedWorkout(ds, MON).source).toBe('rotation');
  });

  it('adds the four days and schedules them', () => {
    const routine = activeRoutine(ds)!;
    const res = S.applyDefaultSplit(ds, routine.id, ctx());
    apply(res.change);
    expect(res.created).toEqual(['Push', 'Pull', 'Legs', 'Delts + Width + Arms']);
    expect(plannedWorkout(ds, THU).day?.name).toBe('Legs');
  });

  it('never touches the day the lifter already built', () => {
    const routine = activeRoutine(ds)!;
    apply(S.applyDefaultSplit(ds, routine.id, ctx()).change);
    const old = dayNamed('Day 1');
    expect(old).toBeTruthy();
    expect(old.exerciseIds).toEqual([benchId]);
    expect(ds.routines.find((r) => r.id === routine.id)?.dayIds).toContain(old.id);
  });

  it('reuses a day that already has the right name, keeping its exercises', () => {
    const routine = activeRoutine(ds)!;
    apply(S.renameRoutineDay(ds, dayNamed('Day 1').id, 'Push'));
    const res = S.applyDefaultSplit(ds, routine.id, ctx());
    apply(res.change);
    expect(res.created).toEqual(['Pull', 'Legs', 'Delts + Width + Arms']);
    expect(ds.routineDays.filter((d) => d.name === 'Push')).toHaveLength(1);
    expect(dayNamed('Push').exerciseIds).toEqual([benchId]);
    expect(plannedWorkout(ds, MON).day?.name).toBe('Push');
  });

  it('refuses rather than overflowing the seven-day limit', () => {
    const routine = activeRoutine(ds)!;
    for (const name of ['A', 'B', 'C', 'D', 'E']) apply(S.addRoutineDay(ds, routine.id, name, ctx()));
    expect(() => S.applyDefaultSplit(ds, routine.id, ctx())).toThrow(/room for/);
  });
});

describe('what the lifter has already done today', () => {
  beforeEach(() => {
    const id = exercise('Bench');
    apply(S.createRoutine(ds, 'My split', DEFAULT_SPLIT.map((d) => ({ name: d.name, weekdays: d.weekdays })), ctx()).change);
    apply(S.setDayExercises(ds, dayNamed('Push').id, [id]));
  });

  /** A full logged workout, so finishWorkout has something to save. */
  const trainPush = (when: Date) => {
    const iso = when.toISOString();
    const w = S.startWorkout(ds, { routineDayId: dayNamed('Push').id, readiness: null }, ctx(iso));
    apply(w.change);
    const es = ds.exerciseSessions.find((e) => e.workoutSessionId === w.workoutId)!;
    apply(S.logSet(ds, es.id, 0, { load: 135, reps: 10, rir: 2, rirConfidence: null, note: '', status: 'completed' }));
    apply(S.finishWorkout(ds, w.workoutId, ctx(iso)));
  };

  it('reports a workout finished on the same local date', () => {
    trainPush(MON);
    expect(plannedWorkout(ds, MON).trainedToday).toHaveLength(1);
    expect(plannedWorkout(ds, TUE).trainedToday).toHaveLength(0);
  });

  it('still names the scheduled workout after training it', () => {
    trainPush(MON);
    expect(plannedWorkout(ds, MON).day?.name).toBe('Push');
  });
});

describe('no routine at all', () => {
  it('plans nothing without inventing a day', () => {
    const p = plannedWorkout(ds, MON);
    expect(p.day).toBeNull();
    expect(p.source).toBe('none');
    expect(p.rest).toBe(false);
  });
});
