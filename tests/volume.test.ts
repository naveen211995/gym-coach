/** Weekly volume / frequency reporting and within-session autoregulation. */
import { describe, expect, it } from 'vitest';
import { RULES, autoregulateRemaining, evaluateSession, volumeReport, type VolumeSession } from '../src/engine';
import type { MuscleGroup } from '../src/domain/types';
import { ex, session } from './helpers';

const EVAL = { defaultRirConfidence: 4 };

function vs(muscleGroup: MuscleGroup, spec: string, workoutSessionId: string, exerciseId = `ex-${muscleGroup}`): VolumeSession {
  return { muscleGroup, exerciseId, workoutSessionId, evaluation: evaluateSession(session(spec), ex(), EVAL) };
}

describe('weekly volume per muscle group', () => {
  it('counts performed working sets and distinct workouts', () => {
    const r = volumeReport([
      vs('chest', '100x10@2, 100x10@2, 100x10@2', 'w1'),
      vs('chest', '100x10@2, 100x10@2, 100x10@2', 'w2', 'ex-chest-2'),
      vs('back', '100x10@2, 100x10@2, 100x10@2', 'w1'),
    ]);
    const chest = r.entries.find((e) => e.muscleGroup === 'chest');
    expect(chest?.sets).toBe(6);
    expect(chest?.sessions).toBe(2);
    expect(chest?.exercises).toBe(2);
    expect(r.totalSets).toBe(9);
  });

  it('does not count sets that were never logged', () => {
    const r = volumeReport([vs('chest', '100x10@2, pending, pending', 'w1')]);
    expect(r.entries[0]?.sets).toBe(1);
  });

  it('does not count skipped sets', () => {
    const r = volumeReport([vs('chest', '100x10@2, skip, skip', 'w1')]);
    expect(r.entries[0]?.sets).toBe(1);
  });

  it('counts a failed set as work done', () => {
    const r = volumeReport([vs('chest', '100x10@2, 100x6F', 'w1')]);
    expect(r.entries[0]?.sets).toBe(2);
    expect(r.entries[0]?.hardSets).toBe(2);
  });

  it('excludes sets taken far from failure from the hard-set count', () => {
    const r = volumeReport([vs('chest', '100x10@2, 100x10@8, 100x10@9', 'w1')]);
    expect(r.entries[0]?.sets).toBe(3);
    expect(r.entries[0]?.hardSets).toBe(1);
  });

  it('treats an unlogged RIR as a hard set', () => {
    const r = volumeReport([vs('chest', '100x10, 100x10, 100x10', 'w1')]);
    expect(r.entries[0]?.hardSets).toBe(3);
  });

  it('labels low, in-band and high weekly volume', () => {
    const many = (n: number, group: MuscleGroup) =>
      Array.from({ length: n }, (_, i) => vs(group, '100x10@2, 100x10@2, 100x10@2', `w${i}`));
    const r = volumeReport([...many(1, 'biceps'), ...many(5, 'chest'), ...many(8, 'back')]);
    expect(r.entries.find((e) => e.muscleGroup === 'biceps')?.level).toBe('low'); // 3 sets
    expect(r.entries.find((e) => e.muscleGroup === 'chest')?.level).toBe('in-band'); // 15 sets
    expect(r.entries.find((e) => e.muscleGroup === 'back')?.level).toBe('high'); // 24 sets
  });

  it('scales the bands by the window length', () => {
    const sessions = Array.from({ length: 4 }, (_, i) => vs('chest', '100x10@2, 100x10@2, 100x10@2', `w${i}`));
    expect(volumeReport(sessions, 1).entries[0]?.level).toBe('in-band'); // 12 sets in a week
    expect(volumeReport(sessions, 4).entries[0]?.level).toBe('low'); // 12 sets in a month
  });

  it('flags a muscle group trained only once a week', () => {
    const r = volumeReport([
      vs('quads', '100x10@2, 100x10@2, 100x10@2', 'w1'),
      vs('chest', '100x10@2, 100x10@2, 100x10@2', 'w1'),
      vs('chest', '100x10@2, 100x10@2, 100x10@2', 'w2'),
    ]);
    expect(r.entries.find((e) => e.muscleGroup === 'quads')?.lowFrequency).toBe(true);
    expect(r.entries.find((e) => e.muscleGroup === 'chest')?.lowFrequency).toBe(false);
  });

  it('is empty when nothing was logged', () => {
    expect(volumeReport([]).entries).toEqual([]);
    expect(volumeReport([vs('chest', 'pending, pending, pending', 'w1')]).entries).toEqual([]);
  });

  it('keeps the band constants in the report helper', () => {
    expect(RULES.weeklySetsLow).toBeLessThan(RULES.weeklySetsHigh);
  });
});

describe('within-session autoregulation', () => {
  const exercise = ex({ minReps: 8, maxReps: 12, loadIncrement: 5, targetRir: 2 });
  const prescribed = { load: 100, repTargets: [10, 10, 10], targetRir: 2 };
  const set = (index: number, load: number | null, reps: number | null, rir: number | null, status: 'completed' | 'failed' | 'pending' = 'completed') => ({ index, load, reps, rir, status });

  it('suggests less load when the first set falls well short at failure', () => {
    const s = autoregulateRemaining({ exercise, prescribed, sets: [set(0, 100, 7, 0), set(1, null, null, null, 'pending'), set(2, null, null, null, 'pending')] });
    expect(s?.action).toBe('reduce-load');
    expect(s?.load).toBe(95);
    expect(s?.summary).toMatch(/remaining 2 sets/);
  });

  it('suggests more load when the first set beats target with reps left over', () => {
    const s = autoregulateRemaining({ exercise, prescribed, sets: [set(0, 100, 12, 3), set(1, null, null, null, 'pending')] });
    expect(s?.action).toBe('add-load');
    expect(s?.load).toBe(105);
  });

  it('says nothing when the set lands on target', () => {
    expect(autoregulateRemaining({ exercise, prescribed, sets: [set(0, 100, 10, 2), set(1, null, null, null, 'pending')] })).toBeNull();
  });

  it('says nothing when a miss was not actually hard', () => {
    expect(autoregulateRemaining({ exercise, prescribed, sets: [set(0, 100, 7, 3), set(1, null, null, null, 'pending')] })).toBeNull();
  });

  it('says nothing once every set is logged', () => {
    expect(autoregulateRemaining({ exercise, prescribed, sets: [set(0, 100, 6, 0), set(1, 100, 6, 0), set(2, 100, 6, 0)] })).toBeNull();
  });

  it('leaves a load the lifter already changed alone', () => {
    expect(autoregulateRemaining({ exercise, prescribed, sets: [set(0, 90, 7, 0), set(1, null, null, null, 'pending')] })).toBeNull();
  });

  it('treats a failed set as a miss', () => {
    const s = autoregulateRemaining({ exercise, prescribed, sets: [set(0, 100, 8, null, 'failed'), set(1, null, null, null, 'pending')] });
    expect(s?.action).toBe('reduce-load');
  });

  it('respects the minimum load', () => {
    const bounded = ex({ minReps: 8, maxReps: 12, loadIncrement: 5, minLoad: 100 });
    expect(autoregulateRemaining({ exercise: bounded, prescribed, sets: [set(0, 100, 7, 0), set(1, null, null, null, 'pending')] })).toBeNull();
  });

  it('respects the maximum load', () => {
    const bounded = ex({ minReps: 8, maxReps: 12, loadIncrement: 5, maxLoad: 100 });
    expect(autoregulateRemaining({ exercise: bounded, prescribed, sets: [set(0, 100, 12, 3), set(1, null, null, null, 'pending')] })).toBeNull();
  });

  it('stays out of time-based exercises', () => {
    const plank = ex({ strategy: 'time-based', minReps: 30, maxReps: 60, loadIncrement: 0 }, { equipment: 'bodyweight' });
    expect(autoregulateRemaining({ exercise: plank, prescribed: { load: 0, repTargets: [45, 45], targetRir: 2 }, sets: [set(0, 0, 20, null), set(1, null, null, null, 'pending')] })).toBeNull();
  });
});
