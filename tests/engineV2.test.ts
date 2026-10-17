/**
 * Engine 2.0 behaviours: proximity to failure drives progress detection, load
 * jumps are sized as a percentage of the current load, and rep targets at a new
 * load are predicted from the load-rep tradeoff instead of resetting.
 */
import { describe, expect, it } from 'vitest';
import {
  RULES,
  estimateMaxFromSet,
  estimateOneRepMax,
  evaluateSession,
  predictRepsAtLoad,
  recommendNext,
  repsToFailure,
  type EngineExercise,
  type EngineHistoryEntry,
} from '../src/engine';
import { ex, hist, session } from './helpers';

const run = (history: EngineHistoryEntry[], exercise: EngineExercise = ex()) => recommendNext({ exercise, history });
/** One full session: the same set spec three times over. */
const S = (spec: string) => `${spec},${spec},${spec}`;
const EVAL = { defaultRirConfidence: 4 };

describe('RIR-aware progress detection', () => {
  it('same reps getting EASIER is progress, not a stall', () => {
    const r = run(hist(S('100x10@0'), S('100x10@1'), S('100x10@2'), S('100x10@3')));
    expect(r.action).not.toBe('deload');
    expect(r.trend.stallCount).toBe(0);
    expect(r.trend.label).toBe('improving');
    expect(r.ruleId).toBe('B_ADD_REPS');
  });

  it('same reps getting HARDER is a regression, and says so', () => {
    const r = run(hist(S('100x10@3'), S('100x10@2'), S('100x10@1'), S('100x10@0')));
    expect(r.ruleId).toBe('DELOAD_RIR_REGRESSION');
    expect(r.action).toBe('deload');
    expect(r.flags).toContain('rir-regression');
    expect(r.reasons.join(' ')).toMatch(/closer to failure/);
  });

  it('no longer treats those two histories identically', () => {
    const easier = run(hist(S('100x10@0'), S('100x10@1'), S('100x10@2'), S('100x10@3')));
    const harder = run(hist(S('100x10@3'), S('100x10@2'), S('100x10@1'), S('100x10@0')));
    expect(easier.ruleId).not.toBe(harder.ruleId);
  });

  it('ignores capacity when RIR is missing on some working sets', () => {
    const r = run(hist(S('100x10@2'), S('100x10@2'), '100x10@2, 100x10, 100x10@0'));
    expect(r.flags).not.toContain('rir-regression');
  });

  it('needs more than a one-rep dip to call a regression', () => {
    const r = run(hist('100x10@2, 100x10@2, 100x10@2', '100x10@2, 100x10@2, 100x9@2', '100x10@2, 100x9@2, 100x9@2'));
    expect(r.trend.regressionCount).toBe(0);
    expect(r.action).not.toBe('deload');
  });

  it('still deloads on a genuine multi-rep drop', () => {
    const r = run(hist(S('100x12@2'), '100x9@1, 100x8@1, 100x8@1', '100x8@0, 100x7@0, 100x7@0'));
    expect(r.action).toBe('deload');
  });
});

describe('rep targets at a new load', () => {
  it('predicts reps from the load-rep tradeoff instead of resetting to the minimum', () => {
    const r = run(hist(S('100x12@2')), ex({ loadIncrement: 5 }));
    expect(r.target.load).toBe(105);
    expect(r.target.repTargets).toEqual([10, 10, 10]);
  });

  it('keeps the top of the range when the increment is tiny', () => {
    const r = run(hist(S('100x12@2')), ex({ loadIncrement: 0.5 }));
    expect(r.target.load).toBe(100.5);
    expect(r.target.repTargets).toEqual([12, 12, 12]);
  });

  it('never predicts below the configured minimum', () => {
    const r = run(hist(S('25x12@2')), ex({ loadIncrement: 5 }));
    expect(Math.min(...r.target.repTargets)).toBeGreaterThanOrEqual(8);
  });
});

describe('load jumps are relative, not absolute', () => {
  it('spends an RIR surplus where one increment is a small percentage', () => {
    const r = run(hist(S('200x12@5c5')), ex({ loadIncrement: 5 }));
    expect(r.ruleId).toBe('D_TOP_HIGH_RIR_BIG');
    expect(r.target.load).toBe(215);
  });

  it('never exceeds the maximum jump percentage', () => {
    const r = run(hist(S('200x12@5c5')), ex({ loadIncrement: 5 }));
    const pct = (((r.target.load as number) - 200) / 200) * 100;
    expect(pct).toBeLessThanOrEqual(RULES.maxJumpPercent);
  });

  it('does not stack increments when one is already a big jump', () => {
    const r = run(hist(S('40x12@5c5')), ex({ loadIncrement: 5 }));
    expect(r.target.load).toBe(45);
  });

  it('warns when the increment is too coarse for the rep range', () => {
    const r = run(hist(S('25x12@2')), ex({ loadIncrement: 5, minReps: 8, maxReps: 12 }));
    expect(r.flags).toContain('coarse-increment');
    expect(r.reasons.join(' ')).toMatch(/smaller increment/);
  });

  it('does not warn when the range can absorb the increment', () => {
    const r = run(hist(S('100x12@2')), ex({ loadIncrement: 5, minReps: 8, maxReps: 12 }));
    expect(r.flags).not.toContain('coarse-increment');
  });
});

describe('high reported RIR is discounted, not trusted blindly', () => {
  it('weights a confident RIR 5 below its face value', () => {
    const evaluation = evaluateSession(session(S('100x12@5c5')), ex(), EVAL);
    expect(evaluation.rir.deviation).toBe(3);
    expect(evaluation.rir.taper).toBeLessThan(1);
    expect(evaluation.rir.effectiveDeviation as number).toBeLessThan(3);
  });

  it('leaves RIR inside the reliable window untouched', () => {
    const evaluation = evaluateSession(session(S('100x10@3c5')), ex(), EVAL);
    expect(evaluation.rir.taper).toBe(1);
  });
});

describe('estimated max uses proximity to failure', () => {
  it('separates sets that reps alone cannot', () => {
    expect(estimateMaxFromSet(100, 10, 0)).toBeLessThan(estimateMaxFromSet(100, 10, 4));
    expect(estimateMaxFromSet(100, 10, 0)).toBe(estimateOneRepMax(100, 10));
  });

  it('caps the reps it will estimate from', () => {
    expect(estimateMaxFromSet(100, 30, 0)).toBe(estimateOneRepMax(100, RULES.e1rmReliableMaxReps));
    expect(estimateMaxFromSet(100, 12, 10)).toBe(estimateOneRepMax(100, RULES.e1rmReliableMaxReps));
  });

  it('counts reps in reserve as reps that were available', () => {
    expect(repsToFailure(10, 3)).toBe(13);
    expect(repsToFailure(10, null)).toBe(10);
  });

  it('predicts reps across a load change in both directions', () => {
    expect(predictRepsAtLoad(12, 100, 105)).toBe(10);
    expect(predictRepsAtLoad(8, 100, 90)).toBe(12);
    expect(predictRepsAtLoad(12, 100, 100)).toBe(12);
  });
});

describe('deload sheds volume as well as load', () => {
  const stalled = (e: EngineExercise) => run(hist(S('100x10@2'), S('100x10@2'), S('100x10@2'), S('100x10@2')), e);

  it('drops a set on a three-set exercise', () => {
    const r = stalled(ex({ workingSets: 3 }));
    expect(r.action).toBe('deload');
    expect(r.target.sets).toBe(2);
    expect(r.target.targetRir).toBe(3);
  });

  it('keeps both sets on a two-set exercise', () => {
    const r = stalled(ex({ workingSets: 2 }));
    expect(r.action).toBe('deload');
    expect(r.target.sets).toBe(2);
  });

  it('restores full sets the session after a deload', () => {
    const deloaded = session(S('90x10@2'), { prescribedAction: 'deload', prescribedSets: 2, day: 9 });
    const r = run([...hist(S('100x10@2')), { session: deloaded, readiness: null }]);
    expect(r.ruleId).toBe('RESUME_AFTER_DELOAD');
    expect(r.target.sets).toBe(3);
  });
});

describe('working volume ignores extra sets', () => {
  it('counts only the planned sets', () => {
    const v = evaluateSession(session('100x10@2, 100x10@2, 100x10@2, 100x10@2'), ex(), EVAL);
    expect(v.volume).toBe(4000);
    expect(v.workingVolume).toBe(3000);
  });
});

describe('time-based exercises are untouched by the load-rep rules', () => {
  it('still adds seconds inside the range', () => {
    const plank = ex(
      { strategy: 'time-based', minReps: 30, maxReps: 60, loadIncrement: 0, timeIncrementSeconds: 5 },
      { equipment: 'bodyweight' },
    );
    const r = recommendNext({ exercise: plank, history: [{ session: session('0x40, 0x40, 0x40'), readiness: null }] });
    expect(r.ruleId).toBe('T_ADD_TIME');
    expect(r.target.repTargets).toEqual([45, 45, 45]);
  });
});
