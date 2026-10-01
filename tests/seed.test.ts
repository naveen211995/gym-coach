import { describe, expect, it } from 'vitest';
import { buildSeedDataset, EXPECTED_SEED_RULES, SEED_EXERCISES } from '../src/app/seed';
import { activeWorkout, attentionItems, completedWorkouts, nextRecommendation, nextRoutineDay } from '../src/app/selectors';

let n = 0;
const ds = buildSeedDataset(new Date(2026, 8, 25, 9, 0), (p) => `${p}_${++n}`);

describe('seed dataset', () => {
  it('has 20 completed workouts and none in progress', () => {
    expect(completedWorkouts(ds)).toHaveLength(20);
    expect(activeWorkout(ds)).toBeNull();
  });
  it('rotation says Lower B is next', () => {
    expect(nextRoutineDay(ds)?.name).toBe('Lower B');
  });
  it('last workout was yesterday', () => {
    const last = completedWorkouts(ds)[0];
    expect(new Date(last?.completedAt ?? '').getDate()).toBe(24);
  });
  it('stores a recommendation for every completed exercise session', () => {
    const done = ds.exerciseSessions.filter((s) => s.status === 'completed');
    expect(done).toHaveLength(80);
    for (const s of done) expect(ds.recommendations.some((r) => r.basedOnExerciseSessionId === s.id)).toBe(true);
  });
  it('produces personal records', () => {
    expect(ds.personalRecords.length).toBeGreaterThan(10);
  });
  it.each(SEED_EXERCISES.map((s) => [s.key, s] as const))('%s → expected next recommendation', (key, s) => {
    const ex = ds.exercises.find((e) => e.name === s.name);
    expect(ex).toBeDefined();
    const rec = nextRecommendation(ds, ex!);
    const want = EXPECTED_SEED_RULES[key]!;
    expect({ ruleId: rec.ruleId, load: rec.target.load, reps: rec.target.repTargets }).toEqual(want);
  });
  it('live recommendation equals the one stored after the latest session', () => {
    for (const ex of ds.exercises) {
      const live = nextRecommendation(ds, ex);
      const latest = ds.exerciseSessions.filter((s) => s.exerciseId === ex.id && s.status === 'completed').sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''))[0];
      const stored = ds.recommendations.find((r) => r.basedOnExerciseSessionId === latest?.id);
      expect(stored?.ruleId).toBe(live.ruleId);
      expect(stored?.target).toEqual(live.target);
    }
  });
  it('dashboard attention list surfaces pain, deloads and below-range', () => {
    const kinds = attentionItems(ds).map((a) => `${a.exercise.name}:${a.kind}`);
    expect(kinds).toContain('Lying Leg Curl:pain');
    expect(kinds).toContain('Back Squat:deload');
    expect(kinds).toContain('Seated Dumbbell Shoulder Press:deload');
    expect(kinds).toContain('Standing Calf Raise:caution');
  });
  it('the low-readiness Lower B had adjusted prescriptions', () => {
    const lowWorkout = ds.workoutSessions.find((w) => w.readinessId && ds.readiness.find((r) => r.id === w.readinessId)?.readiness === 2);
    const adjusted = ds.exerciseSessions.filter((s) => s.workoutSessionId === lowWorkout?.id && s.prescribed.readinessAdjusted);
    expect(adjusted.length).toBeGreaterThan(0);
  });
});
