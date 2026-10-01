/**
 * Deliberately constructed edge cases. Each row states the history, the
 * exercise settings and the exact recommendation the engine must produce.
 * The same table is printed as a verification report by `npm run edge-report`.
 */
import { describe, expect, it } from 'vitest';
import type { ProgressionConfig, RecommendationAction, RecommendationFlag } from '../src/domain/types';
import { recommendNext, type EngineExercise, type EngineHistoryEntry } from '../src/engine';
import { ex, hist, LOW_READINESS } from './helpers';

export interface EdgeCase {
  name: string;
  exercise: EngineExercise;
  history: () => EngineHistoryEntry[];
  expect: {
    ruleId: string;
    action: RecommendationAction;
    load: number | null;
    reps: number[];
    sets?: number;
    targetRir?: number;
    flags?: RecommendationFlag[];
    reasonMatch?: RegExp;
  };
}

const lf = (cfg: Partial<ProgressionConfig> = {}) => ex({ strategy: 'load-first', minReps: 5, maxReps: 8, ...cfg });
const plank = (cfg: Partial<ProgressionConfig> = {}) =>
  ex({ strategy: 'time-based', minReps: 30, maxReps: 60, loadIncrement: 0, timeIncrementSeconds: 5, ...cfg }, { equipment: 'bodyweight' });

export const EDGE_CASES: EdgeCase[] = [
  {
    name: 'Significant pain at the top of the range never adds load',
    exercise: ex(),
    history: () => hist(['135x12@2, 135x12@2, 135x12@2', { pain: 'significant', note: 'elbow' }]),
    expect: { ruleId: 'PAIN_REVIEW', action: 'review', load: 135, reps: [12, 12, 12], flags: ['pain-review'], reasonMatch: /elbow/ },
  },
  {
    name: 'Mild pain turns a load increase into a hold and shows the plan it replaced',
    exercise: ex(),
    history: () => hist(['135x12@2, 135x12@2, 135x12@2', { pain: 'mild' }]),
    expect: { ruleId: 'PAIN_CAUTION', action: 'maintain', load: 135, reps: [12, 12, 12], flags: ['pain-caution'], reasonMatch: /increase to 140 lb/ },
  },
  {
    name: 'Top of range at the configured max load holds the load',
    exercise: ex({ maxLoad: 135 }),
    history: () => hist('135x12@2, 135x12@2, 135x12@2'),
    expect: { ruleId: 'A_MAX_LOAD', action: 'maintain', load: 135, reps: [12, 12, 12], flags: ['max-load-reached'] },
  },
  {
    name: 'Increase is clamped to a max load that is less than one increment away',
    exercise: ex({ maxLoad: 138 }),
    history: () => hist('135x12@2, 135x12@2, 135x12@2'),
    expect: { ruleId: 'A_TOP_OF_RANGE', action: 'increase-load', load: 138, reps: [8, 8, 8] },
  },
  {
    name: 'Repeated below-range sessions at the minimum load hold instead of dropping',
    exercise: ex({ minLoad: 135 }),
    history: () => hist('135x6@2, 135x6@2, 135x6@2', '135x6@2, 135x6@2, 135x5@2'),
    expect: { ruleId: 'C_REPEATED_BELOW', action: 'maintain', load: 135, reps: [8, 8, 8], flags: ['min-load-reached'] },
  },
  {
    name: 'Load increment 0 at the top of the range suggests a harder variation',
    exercise: ex({ loadIncrement: 0 }, { equipment: 'bodyweight' }),
    history: () => hist('nullx12@2, nullx12@2, nullx12@2'),
    expect: { ruleId: 'A_MAX_LOAD', action: 'maintain', load: 0, reps: [12, 12, 12], flags: ['progress-variation'] },
  },
  {
    name: 'Load-first: every set reached the minimum → +1 increment',
    exercise: lf(),
    history: () => hist('225x5@2, 225x5@2, 225x5@2'),
    expect: { ruleId: 'LF_MIN_REACHED', action: 'increase-load', load: 230, reps: [5, 5, 5] },
  },
  {
    name: 'Load-first: one set one rep short is within tolerance',
    exercise: lf(),
    history: () => hist('225x5@2, 225x5@2, 225x4@2'),
    expect: { ruleId: 'LF_MIN_REACHED', action: 'increase-load', load: 230, reps: [5, 5, 5] },
  },
  {
    name: 'Load-first: one set two reps short keeps building at the same load',
    exercise: lf(),
    history: () => hist('225x5@2, 225x5@2, 225x3@2'),
    expect: { ruleId: 'LF_BUILD', action: 'maintain', load: 225, reps: [5, 5, 5] },
  },
  {
    name: 'Load-first: top of range on every set → two increments',
    exercise: lf(),
    history: () => hist('225x8@2, 225x8@2, 225x8@2'),
    expect: { ruleId: 'LF_MIN_REACHED', action: 'increase-load', load: 235, reps: [5, 5, 5] },
  },
  {
    name: 'Rep-first: first session at the top consolidates',
    exercise: ex({ strategy: 'rep-first', minReps: 10, maxReps: 15 }),
    history: () => hist('50x13@2, 50x14@2, 50x14@2', '50x15@2, 50x15@2, 50x15@2'),
    expect: { ruleId: 'REP_FIRST_CONSOLIDATE', action: 'maintain', load: 50, reps: [15, 15, 15] },
  },
  {
    name: 'Rep-first: second session at the top earns the increase',
    exercise: ex({ strategy: 'rep-first', minReps: 10, maxReps: 15 }),
    history: () => hist('50x15@2, 50x15@2, 50x15@2', '50x15@2, 50x15@2, 50x15@2'),
    expect: { ruleId: 'A_TOP_OF_RANGE', action: 'increase-load', load: 55, reps: [10, 10, 10] },
  },
  {
    name: 'Time-based: one short hold is an outlier; others add time',
    exercise: plank(),
    history: () => hist('nullx30, nullx30, nullx25'),
    expect: { ruleId: 'T_ADD_TIME', action: 'increase-reps', load: 0, reps: [35, 35, 30] },
  },
  {
    name: 'Time-based: max time with no load increment → harder variation',
    exercise: plank(),
    history: () => hist('nullx60, nullx60, nullx60'),
    expect: { ruleId: 'T_MAX_TIME', action: 'maintain', load: 0, reps: [60, 60, 60], flags: ['progress-variation'] },
  },
  {
    name: 'Time-based: max time with a load increment adds weight and restarts time',
    exercise: plank({ loadIncrement: 5 }),
    history: () => hist('nullx60, nullx60, nullx60'),
    expect: { ruleId: 'T_ADD_LOAD', action: 'increase-load', load: 5, reps: [30, 30, 30] },
  },
  {
    name: 'One bad set (rule F): the outlier set keeps its previous target',
    exercise: ex(),
    history: () => hist('135x10@2, 135x10@2, 135x10@2', '135x11@2, 135x11@2, 135x5@2'),
    expect: { ruleId: 'B_ADD_REPS', action: 'increase-reps', load: 135, reps: [12, 12, 10], flags: ['outlier-set'] },
  },
  {
    name: 'Extra sets beyond the plan count for records but not progression',
    exercise: ex(),
    history: () => hist('135x12@2, 135x12@2, 135x12@2, 135x7@1'),
    expect: { ruleId: 'A_TOP_OF_RANGE', action: 'increase-load', load: 140, reps: [8, 8, 8] },
  },
  {
    name: 'Mixed loads: judged at the most common load; the lighter set does not count as top',
    exercise: ex(),
    history: () => hist('135x12@2, 140x10@2, 140x10@2'),
    expect: { ruleId: 'B_ADD_REPS', action: 'increase-reps', load: 140, reps: [9, 11, 11], flags: ['mixed-loads'] },
  },
  {
    name: 'No RIR logged: decision uses reps and load only',
    exercise: ex(),
    history: () => hist('135x12, 135x12, 135x12'),
    expect: { ruleId: 'A_TOP_OF_RANGE', action: 'increase-load', load: 140, reps: [8, 8, 8], reasonMatch: /No RIR was logged/ },
  },
  {
    name: 'Very high RIR with confidence 1 does not earn a double jump',
    exercise: ex(),
    history: () => hist('135x12@5c1, 135x12@5c1, 135x12@5c1'),
    expect: { ruleId: 'A_TOP_OF_RANGE', action: 'increase-load', load: 140, reps: [8, 8, 8], flags: ['low-rir-confidence'] },
  },
  {
    name: 'Very high RIR with confidence 5 at the top → two increments',
    exercise: ex(),
    history: () => hist('135x12@5c5, 135x12@5c5, 135x12@5c5'),
    expect: { ruleId: 'D_TOP_HIGH_RIR_BIG', action: 'increase-load', load: 145, reps: [8, 8, 8] },
  },
  {
    name: 'Top of range on a low-readiness day still earns the increase (readiness only affects that day)',
    exercise: ex(),
    history: () => [{ ...hist('135x12@2, 135x12@2, 135x12@2')[0]!, readiness: LOW_READINESS }],
    expect: { ruleId: 'A_TOP_OF_RANGE', action: 'increase-load', load: 140, reps: [8, 8, 8], reasonMatch: /low-readiness/ },
  },
  {
    name: 'kg exercise logged in lb converts and snaps to the kg increment',
    exercise: ex({ loadIncrement: 2.5 }, { unit: 'kg' }),
    history: () => hist(['135lbx12@2, 135lbx12@2, 135lbx12@2', { unit: 'kg' }]),
    expect: { ruleId: 'A_TOP_OF_RANGE', action: 'increase-load', load: 62.5, reps: [8, 8, 8], flags: ['unit-converted'] },
  },
  {
    name: 'Reps above the maximum count as top of range',
    exercise: ex(),
    history: () => hist('135x15@2, 135x14@2, 135x13@2'),
    expect: { ruleId: 'A_TOP_OF_RANGE', action: 'increase-load', load: 140, reps: [8, 8, 8] },
  },
  {
    name: '0.5 kg micro-plate increments',
    exercise: ex({ loadIncrement: 0.5 }, { unit: 'kg' }),
    history: () => hist(['41.5x12@2, 41.5x12@2, 41.5x12@2', { unit: 'kg' }]),
    expect: { ruleId: 'A_TOP_OF_RANGE', action: 'increase-load', load: 42, reps: [8, 8, 8] },
  },
  {
    name: 'Deload strategy "none" flags a long stall but keeps normal targets',
    exercise: ex({ deloadStrategy: 'none' }),
    history: () => hist('135x10@2, 135x10@2, 135x10@2', '135x10@2, 135x10@2, 135x9@2', '135x10@2, 135x9@2, 135x10@2', '135x9@2, 135x10@2, 135x10@2'),
    expect: { ruleId: 'B_ADD_REPS', action: 'increase-reps', load: 135, reps: [10, 11, 11], flags: ['stall'], reasonMatch: /Deloads are off/ },
  },
  {
    name: 'Fewer reps right after a load jump is not counted as regression',
    exercise: ex(),
    history: () => hist('135x12@2, 135x12@2, 135x12@2', '140x9@2, 140x8@2, 140x8@2'),
    expect: { ruleId: 'B_ADD_REPS', action: 'increase-reps', load: 140, reps: [10, 9, 9] },
  },
  {
    name: 'Negative load and NaN reps are dropped; remaining sets decide',
    exercise: ex(),
    history: () => hist('135x10@2, -5x10@2, 135xNaN@2'),
    expect: { ruleId: 'INCOMPLETE_SESSION', action: 'maintain', load: 135, reps: [10, 10, 10], flags: ['data-warning', 'incomplete-session'] },
  },
  {
    name: 'Failed first attempt at a new load, far below range → back to the last load that worked',
    exercise: ex(),
    history: () => hist('135x12@2, 135x12@2, 135x12@2', '140x5F, 140x4F, 140x4F'),
    expect: { ruleId: 'C_FAR_BELOW', action: 'decrease-load', load: 135, reps: [8, 8, 8] },
  },
];

describe('constructed edge cases', () => {
  it('has at least 20 cases', () => {
    expect(EDGE_CASES.length).toBeGreaterThanOrEqual(20);
  });

  it.each(EDGE_CASES.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const r = recommendNext({ exercise: c.exercise, history: c.history() });
    expect(r.ruleId).toBe(c.expect.ruleId);
    expect(r.action).toBe(c.expect.action);
    expect(r.target.load).toBe(c.expect.load);
    expect(r.target.repTargets).toEqual(c.expect.reps);
    if (c.expect.sets !== undefined) expect(r.target.sets).toBe(c.expect.sets);
    if (c.expect.targetRir !== undefined) expect(r.target.targetRir).toBe(c.expect.targetRir);
    for (const f of c.expect.flags ?? []) expect(r.flags).toContain(f);
    if (c.expect.reasonMatch) expect(r.reasons.join(' ')).toMatch(c.expect.reasonMatch);
    // Every recommendation must be explainable.
    expect(r.reasons.length).toBeGreaterThan(0);
    expect(r.summary.length).toBeGreaterThan(0);
    // Invariants that hold for every output.
    expect(r.target.repTargets.length).toBe(r.target.sets);
    if (r.action === 'increase-load') expect(r.direction).toBe('up');
    if (r.action === 'decrease-load' || r.action === 'deload') expect(r.direction).toBe('down');
    if (r.action === 'review' || r.flags.includes('pain-caution')) expect(r.direction).not.toBe('up');
  });
});
