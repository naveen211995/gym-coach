import { describe, expect, it } from 'vitest';
import { recommendNext, type EngineHistoryEntry } from '../src/engine';
import { ex, hist, LOW_READINESS, session } from './helpers';

const run = (history: EngineHistoryEntry[], exercise = ex()) => recommendNext({ exercise, history });

describe('beginner exercise with no history', () => {
  it('asks for a baseline with no load when nothing is known', () => {
    const r = run([]);
    expect(r.action).toBe('establish-baseline');
    expect(r.ruleId).toBe('BASELINE');
    expect(r.target.load).toBeNull();
    expect(r.target.repTargets).toEqual([8, 8, 8]);
    expect(r.target.targetRir).toBe(2);
    expect(r.summary).toMatch(/Pick a load you can lift 8–12 times/);
    expect(r.reasons[0]).toMatch(/No history/);
  });
  it('uses the configured starting load when there is one', () => {
    const r = run([], ex({ startingLoad: 95 }));
    expect(r.target.load).toBe(95);
    expect(r.summary).toBe('Start at 95 lb × 8/8/8');
  });
  it('starts bodyweight exercises at 0 load', () => {
    const r = run([], ex({}, { equipment: 'bodyweight' }));
    expect(r.target.load).toBe(0);
  });
});

describe('normal progression', () => {
  it('keeps load and adds a rep to each set inside the range', () => {
    const r = run(hist('135x10@2, 135x9@2, 135x8@2'));
    expect(r.ruleId).toBe('B_ADD_REPS');
    expect(r.action).toBe('increase-reps');
    expect(r.direction).toBe('same');
    expect(r.target.load).toBe(135);
    expect(r.target.repTargets).toEqual([11, 10, 9]);
    expect(r.summary).toBe('Keep 135 lb, aim for 11/10/9');
  });
  it('labels a rising trend as improving', () => {
    const r = run(hist('135x9@2, 135x8@2, 135x8@2', '135x10@2, 135x9@2, 135x8@2'));
    expect(r.trend.label).toBe('improving');
  });
});

describe('top-of-range progression', () => {
  it('adds one increment and resets reps when every set hits the top at target RIR', () => {
    const r = run(hist('135x12@2, 135x12@2, 135x12@2'));
    expect(r.ruleId).toBe('A_TOP_OF_RANGE');
    expect(r.action).toBe('increase-load');
    expect(r.direction).toBe('up');
    expect(r.target.load).toBe(140);
    expect(r.target.repTargets).toEqual([8, 8, 8]);
  });
  it('tolerates one set being a single rep short (rule F)', () => {
    const r = run(hist('135x12@2, 135x12@2, 135x11@2'));
    expect(r.ruleId).toBe('A_TOP_OF_RANGE');
    expect(r.target.load).toBe(140);
    expect(r.reasons.join(' ')).toMatch(/within the 1-rep tolerance/);
  });
});

describe('partial progression', () => {
  it('fills lower sets toward the top without adding load', () => {
    const r = run(hist('135x12@2, 135x11@2, 135x9@2'));
    expect(r.ruleId).toBe('B_ADD_REPS');
    expect(r.target.load).toBe(135);
    expect(r.target.repTargets).toEqual([12, 12, 10]);
  });
  it('does not treat two sets short as top of range', () => {
    const r = run(hist('135x12@2, 135x11@2, 135x11@2'));
    expect(r.action).toBe('increase-reps');
    expect(r.target.repTargets).toEqual([12, 12, 12]);
  });
});

describe('low-rep performance', () => {
  it('repeats the load after the first session below range', () => {
    const r = run(hist('135x9@2, 135x8@2, 135x8@2', '135x7@1, 135x7@1, 135x6@0'));
    expect(r.ruleId).toBe('C_FIRST_BELOW');
    expect(r.action).toBe('maintain');
    expect(r.target.load).toBe(135);
    expect(r.target.repTargets).toEqual([8, 8, 8]);
  });
  it('reduces load after a second below-range session at the same load', () => {
    const r = run(hist('135x7@1, 135x7@1, 135x6@1', '135x7@1, 135x7@1, 135x7@1'));
    expect(r.ruleId).toBe('C_REPEATED_BELOW');
    expect(r.action).toBe('decrease-load');
    expect(r.target.load).toBe(125); // 135 × 0.95 = 128.25 → floored to the 5 lb step
    expect(r.direction).toBe('down');
  });
  it('goes back to the previous load when a jump was far too heavy', () => {
    const r = run(hist('130x12@2, 130x12@2, 130x12@2', '135x4@0, 135x4@0, 135x4@0'));
    expect(r.ruleId).toBe('C_FAR_BELOW');
    expect(r.target.load).toBe(130);
  });
  it('gives a fresh load increase one more try', () => {
    const r = run(hist('130x12@2, 130x12@2, 130x12@2', '135x7@1, 135x7@1, 135x6@1'));
    expect(r.ruleId).toBe('C_FIRST_BELOW');
    expect(r.reasons.join(' ')).toMatch(/after moving up from 130 lb/);
  });
  it('treats a below-range session on a low-readiness day as an off day', () => {
    const h = hist('135x10@2, 135x10@2, 135x10@2', '135x7@1, 135x7@1, 135x6@0');
    (h[1] as EngineHistoryEntry).readiness = LOW_READINESS;
    const r = run(h);
    expect(r.ruleId).toBe('C_OFF_DAY');
    expect(r.flags).toContain('off-day');
    expect(r.trend.stallCount).toBe(0);
    expect(r.trend.regressionCount).toBe(0);
  });
});

describe('high-RIR performance', () => {
  it('adds two reps per set when RIR is well above target inside the range', () => {
    const r = run(hist('135x10@4, 135x10@4, 135x9@4'));
    expect(r.ruleId).toBe('B_ADD_REPS_HIGH_RIR');
    expect(r.target.repTargets).toEqual([12, 12, 11]);
  });
  it('adds two increments at the top of the range when sets were far from failure', () => {
    const r = run(hist('135x12@5c5, 135x12@5c5, 135x12@5c5'));
    expect(r.ruleId).toBe('D_TOP_HIGH_RIR_BIG');
    expect(r.target.load).toBe(145);
  });
  it('adds load early when most sets hit the top with RIR well above target (rule D)', () => {
    const r = run(hist('135x12@4c5, 135x12@4c5, 135x10@4c5'));
    expect(r.ruleId).toBe('D_HIGH_RIR_EARLY_INCREASE');
    expect(r.target.load).toBe(140);
    expect(r.target.repTargets).toEqual([8, 8, 8]);
  });
});

describe('low-RIR performance', () => {
  it('holds reps inside the range when sets were much closer to failure than planned', () => {
    const r = run(hist('135x10@0, 135x9@0, 135x8@0'));
    expect(r.ruleId).toBe('E_LOW_RIR_HOLD');
    expect(r.action).toBe('maintain');
    expect(r.target.repTargets).toEqual([10, 9, 8]);
  });
  it('does not add load at the top of the range when grinding', () => {
    const r = run(hist('135x12@0, 135x12@0, 135x12@0'));
    expect(r.ruleId).toBe('E_TOP_LOW_RIR');
    expect(r.target.load).toBe(135);
    expect(r.target.repTargets).toEqual([12, 12, 12]);
  });
  it('ignores a small RIR shortfall', () => {
    const r = run(hist('135x10@1, 135x9@1, 135x8@1'));
    expect(r.ruleId).toBe('B_ADD_REPS');
  });
});

describe('inconsistent RIR', () => {
  it('reduces RIR influence when a later set reports much more RIR with no more reps', () => {
    const inconsistent = run(hist('135x10@5c5, 135x10@1c5, 135x10@5c5'));
    expect(inconsistent.flags).toContain('inconsistent-rir');
    expect(inconsistent.ruleId).toBe('B_ADD_REPS'); // half weight → not "substantially easier"
    expect(inconsistent.target.repTargets).toEqual([11, 11, 11]);

    const consistent = run(hist('135x10@4c5, 135x10@4c5, 135x10@3c5'));
    expect(consistent.ruleId).toBe('B_ADD_REPS_HIGH_RIR');
  });
  it('does not flag normal fatigue (RIR falling across sets)', () => {
    const r = run(hist('135x12@3, 135x12@2, 135x12@0'));
    expect(r.flags).not.toContain('inconsistent-rir');
  });
  it('ignores RIR entirely at low confidence', () => {
    const r = run(hist('135x12@0c1, 135x12@0c1, 135x12@0c1'));
    expect(r.ruleId).toBe('A_TOP_OF_RANGE');
    expect(r.flags).toContain('low-rir-confidence');
  });
});

describe('missing, skipped and failed sets', () => {
  it('missing set: no progression until the full session is logged', () => {
    const r = run(hist('135x12@2, 135x12@2'));
    expect(r.ruleId).toBe('INCOMPLETE_SESSION');
    expect(r.target.load).toBe(135);
    expect(r.target.repTargets).toEqual([12, 12, 12]);
    expect(r.flags).toContain('incomplete-session');
  });
  it('pending (never logged) sets count as missing', () => {
    const r = run(hist('135x12@2, 135x12@2, pending'));
    expect(r.ruleId).toBe('INCOMPLETE_SESSION');
  });
  it('skipped set: repeats targets and says the set was skipped', () => {
    const r = run(hist('135x10@2, 135x9@2, skip'));
    expect(r.ruleId).toBe('INCOMPLETE_SESSION');
    expect(r.target.repTargets).toEqual([10, 9, 9]);
    expect(r.reasons[0]).toMatch(/1 skipped/);
  });
  it('failed set counts as performed at RIR 0 and a single bad one is an outlier', () => {
    const r = run(hist('135x10@2, 135x9@1, 135x6F'));
    expect(r.evaluation?.failedCount).toBe(1);
    expect(r.evaluation?.working[2]?.rir).toBe(0);
    expect(r.ruleId).toBe('B_ADD_REPS');
    expect(r.flags).toContain('outlier-set');
    expect(r.target.repTargets).toEqual([11, 10, 8]);
  });
  it('all failed below range: repeat the load', () => {
    const r = run(hist('135x7F, 135x6F, 135x6F'));
    expect(r.ruleId).toBe('C_FIRST_BELOW');
  });
});

describe('plateau, regression and deload', () => {
  it('plateau: warns after two sessions without a new best', () => {
    const r = run(hist('135x10@2, 135x9@2, 135x8@2', '135x10@2, 135x9@2, 135x8@2', '135x10@2, 135x9@2, 135x8@2'));
    expect(r.trend.stallCount).toBe(2);
    expect(r.trend.label).toBe('plateau');
    expect(r.flags).toContain('plateau-warning');
    expect(r.ruleId).toBe('B_ADD_REPS');
  });
  it('oscillating performance still counts as a stall', () => {
    const r = run(hist('135x10@2, 135x10@2, 135x10@2', '135x10@2, 135x9@2, 135x9@2', '135x10@2, 135x10@2, 135x9@2', '135x10@2, 135x9@2, 135x9@2'));
    expect(r.trend.stallCount).toBe(3);
    expect(r.ruleId).toBe('DELOAD_STALL');
  });
  it('regression: two consecutive drops trigger a deload', () => {
    const r = run(hist('135x10@2, 135x10@2, 135x9@2', '135x10@2, 135x9@2, 135x8@2', '135x9@1, 135x8@1, 135x8@1'));
    expect(r.trend.regressionCount).toBe(2);
    expect(r.trend.label).toBe('regressing');
    expect(r.ruleId).toBe('DELOAD_REGRESSION');
    expect(r.target.load).toBe(120); // 135 × 0.9 = 121.5 → floored to 120
    expect(r.target.repTargets).toEqual([9, 8, 8]);
    expect(r.flags).toContain('regression');
  });
  it('a single dip does not trigger anything', () => {
    const r = run(hist('135x10@2, 135x10@2, 135x10@2', '135x10@2, 135x9@2, 135x9@2'));
    expect(r.trend.regressionCount).toBe(1);
    expect(r.ruleId).toBe('B_ADD_REPS');
  });
  const stalled = ['135x10@2, 135x9@2, 135x8@2', '135x10@2, 135x9@2, 135x8@2', '135x10@2, 135x9@2, 135x8@2', '135x10@2, 135x9@2, 135x8@2'];
  it('deload (reduce load) after the configured stall count', () => {
    const r = run(hist(...stalled));
    expect(r.trend.stallCount).toBe(3);
    expect(r.ruleId).toBe('DELOAD_STALL');
    expect(r.action).toBe('deload');
    expect(r.target.load).toBe(120);
  });
  it('deload (reduce sets) keeps load, halves sets and raises RIR', () => {
    const r = run(hist(...stalled), ex({ deloadStrategy: 'reduce-sets' }));
    expect(r.action).toBe('deload');
    expect(r.target.load).toBe(135);
    expect(r.target.sets).toBe(2);
    expect(r.target.targetRir).toBe(4);
  });
  it('deload strategy "none" only flags the stall', () => {
    const r = run(hist(...stalled), ex({ deloadStrategy: 'none' }));
    expect(r.action).toBe('increase-reps');
    expect(r.flags).toContain('stall');
  });
  it('the stall streak restarts after a followed deload', () => {
    const h = hist(...stalled, ['120x12@2, 120x12@2, 120x12@2', { prescribedAction: 'deload' }]);
    const r = run(h);
    expect(r.trend.stallCount).toBe(0);
    expect(r.ruleId).toBe('A_TOP_OF_RANGE');
    expect(r.target.load).toBe(125);
  });
  it('resumes full sets after a reduced-sets deload', () => {
    const h = hist(...stalled, ['135x10@4, 135x9@4', { prescribedAction: 'deload', prescribedSets: 2 }]);
    const r = run(h, ex({ deloadStrategy: 'reduce-sets' }));
    expect(r.ruleId).toBe('RESUME_AFTER_DELOAD');
    expect(r.target.sets).toBe(3);
    expect(r.target.repTargets).toEqual([10, 9, 8]);
  });
});

describe('decimal load increments', () => {
  it('kg 2.5 increments', () => {
    const r = run(hist(['57.5x12@2, 57.5x12@2, 57.5x12@2', { unit: 'kg' }]), ex({ loadIncrement: 2.5 }, { unit: 'kg' }));
    expect(r.target.load).toBe(60);
    expect(r.summary).toBe('Increase to 60 kg × 8/8/8');
  });
  it('1.25 increments without float noise', () => {
    const r = run(hist(['18.75x12@2, 18.75x12@2, 18.75x12@2', { unit: 'kg' }]), ex({ loadIncrement: 1.25 }, { unit: 'kg' }));
    expect(r.target.load).toBe(20);
  });
  it('2.5 lb dumbbell steps', () => {
    const r = run(hist('22.5x12@2, 22.5x12@2, 22.5x12@2'), ex({ loadIncrement: 2.5 }));
    expect(r.target.load).toBe(25);
  });
  it('deload snaps down to the decimal step', () => {
    const r = run(hist(...Array(4).fill('57.5x10@2, 57.5x9@2, 57.5x8@2').map((s: string) => [s, { unit: 'kg' }] as [string, { unit: 'kg' }])), ex({ loadIncrement: 2.5 }, { unit: 'kg' }));
    expect(r.ruleId).toBe('DELOAD_STALL');
    expect(r.target.load).toBe(50); // 57.5 × 0.9 = 51.75 → 50
  });
});

describe('plates unit', () => {
  it('adds one whole plate at the top of the range', () => {
    const r = run(hist(['3x12@2, 3x12@2, 3x12@2', { unit: 'plt' }]), ex({ loadIncrement: 1 }, { unit: 'plt' }));
    expect(r.ruleId).toBe('A_TOP_OF_RANGE');
    expect(r.target.load).toBe(4);
    expect(r.target.unit).toBe('plt');
    expect(r.summary).toBe('Increase to 4 plt × 8/8/8');
  });
  it('does not rescale lb history on a plates exercise', () => {
    const r = run(hist(['3lbx12@2, 3lbx12@2, 3lbx12@2', { unit: 'plt' }]), ex({ loadIncrement: 1 }, { unit: 'plt' }));
    expect(r.evaluation?.workingLoad).toBe(3);
    expect(r.target.load).toBe(4);
  });
});

describe('kg/lb conversion', () => {
  it('normalizes sets logged in kg into a lb exercise and snaps to the increment', () => {
    const r = run(hist('60kgx12@2, 60kgx12@2, 60kgx12@2'));
    expect(r.evaluation?.workingLoad).toBeCloseTo(132.28, 2);
    expect(r.flags).toContain('unit-converted');
    expect(r.target.load).toBe(135); // 132.28 → 130 (nearest 5) → +5
    expect(r.target.unit).toBe('lb');
  });
});

describe('different rep ranges and set counts', () => {
  it('5–8 range', () => {
    const r = run(hist('225x8@2, 225x8@2, 225x8@2'), ex({ minReps: 5, maxReps: 8 }));
    expect(r.target.load).toBe(230);
    expect(r.target.repTargets).toEqual([5, 5, 5]);
  });
  it('15–20 range', () => {
    const r = run(hist('50x20@2, 50x20@2, 50x19@2'), ex({ minReps: 15, maxReps: 20 }));
    expect(r.target.load).toBe(55);
    expect(r.target.repTargets).toEqual([15, 15, 15]);
  });
  it('1 set', () => {
    const r = run(hist(['135x12@2', { prescribedSets: 1 }]), ex({ workingSets: 1 }));
    expect(r.ruleId).toBe('A_TOP_OF_RANGE');
    expect(r.target.repTargets).toEqual([8]);
  });
  it('2 sets get no one-rep tolerance', () => {
    const r = run(hist(['135x12@2, 135x11@2', { prescribedSets: 2 }]), ex({ workingSets: 2 }));
    expect(r.action).toBe('increase-reps');
    expect(r.target.repTargets).toEqual([12, 12]);
  });
  it('5 sets with one set a rep short', () => {
    const r = run(hist(['135x12@2, 135x12@2, 135x12@2, 135x12@2, 135x11@2', { prescribedSets: 5 }]), ex({ workingSets: 5 }));
    expect(r.ruleId).toBe('A_TOP_OF_RANGE');
    expect(r.target.repTargets).toHaveLength(5);
  });
  it('4 sets, two short', () => {
    const r = run(hist(['135x12@2, 135x12@2, 135x11@2, 135x11@2', { prescribedSets: 4 }]), ex({ workingSets: 4 }));
    expect(r.target.repTargets).toEqual([12, 12, 12, 12]);
  });
});

describe('incorrect or missing inputs', () => {
  it('invalid config returns a review with the validation errors', () => {
    const r = run(hist('135x12@2, 135x12@2, 135x12@2'), ex({ minReps: 12, maxReps: 8 }));
    expect(r.action).toBe('review');
    expect(r.ruleId).toBe('INVALID_CONFIG');
    expect(r.flags).toContain('invalid-config');
    expect(r.reasons.join(' ')).toMatch(/can't be lower than the minimum/);
  });
  it('drops invalid sets with warnings instead of throwing', () => {
    const h = hist('135x12@2, 135xNaN@2, -5x10@2');
    const r = run(h);
    expect(r.warnings.length).toBeGreaterThanOrEqual(2);
    expect(r.flags).toContain('data-warning');
    expect(r.ruleId).toBe('INCOMPLETE_SESSION');
  });
  it('missing weight on a barbell set is ignored; on bodyweight it means 0', () => {
    expect(run(hist('nullx10@2, 135x10@2, 135x10@2')).warnings.join(' ')).toMatch(/no weight/);
    const bw = run(hist('nullx10@2, nullx10@2, nullx10@2'), ex({ loadIncrement: 0 }, { equipment: 'bodyweight' }));
    expect(bw.evaluation?.workingLoad).toBe(0);
    expect(bw.ruleId).toBe('B_ADD_REPS');
  });
  it('clamps out-of-range RIR and ignores invalid confidence', () => {
    const r = run(hist('135x10@15c7, 135x10@2, 135x10@2'));
    expect(r.evaluation?.working[0]?.rir).toBe(10);
    expect(r.evaluation?.working[0]?.confidence).toBe(4);
    expect(r.warnings.join(' ')).toMatch(/clamped/);
  });
  it('ignores sessions from another exercise and sorts out-of-order history', () => {
    const a = session('135x10@2, 135x9@2, 135x8@2', { day: 1 });
    const b = session('135x12@2, 135x12@2, 135x12@2', { day: 5 });
    const other = session('500x1@0, 500x1@0, 500x1@0', { day: 9, exerciseId: 'other' });
    const r = run([{ session: b, readiness: null }, { session: other, readiness: null }, { session: a, readiness: null }]);
    expect(r.ruleId).toBe('A_TOP_OF_RANGE');
    expect(r.warnings.join(' ')).toMatch(/ignored/);
  });
  it('a session with nothing usable falls back to the last known performance', () => {
    const r = run(hist('135x10@2, 135x9@2, 135x8@2', 'skip, skip, skip'));
    expect(r.ruleId).toBe('NO_SETS_LOGGED');
    expect(r.target.repTargets).toEqual([10, 9, 8]);
  });
  it('only empty sessions → baseline', () => {
    const r = run(hist('skip, skip, skip'));
    expect(r.ruleId).toBe('BASELINE');
  });
  it('invalid default confidence option falls back to 4', () => {
    const r = recommendNext({ exercise: ex(), history: hist('135x10@2, 135x10@2, 135x10@2'), options: { defaultRirConfidence: 99 } });
    expect(r.evaluation?.rir.averageConfidence).toBe(4);
  });
});

describe('determinism', () => {
  it('identical input produces identical output', () => {
    const h = hist('135x10@2, 135x9@2, 135x8@2', '135x11@2, 135x10@1, 135x9@1');
    expect(run(h)).toEqual(run(h));
  });
});

describe('regressions found during review', () => {
  it('an outlier set right after a load increase targets the minimum, not the lighter load’s reps', () => {
    const r = run(hist('135x12@2, 135x12@2, 135x12@2', '140x10@2, 140x10@2, 140x6@2'));
    expect(r.ruleId).toBe('B_ADD_REPS');
    expect(r.target.load).toBe(140);
    expect(r.target.repTargets).toEqual([11, 11, 8]);
  });
  it('a session with a skipped set is not counted as a regression or a stall', () => {
    const r = run(hist('65x9@2, 65x9@2, 65x8@2', '65x9@2, 65x8@2, skip'));
    expect(r.ruleId).toBe('INCOMPLETE_SESSION');
    expect(r.trend.regressionCount).toBe(0);
    expect(r.trend.stallCount).toBe(0);
    expect(r.reasons.join(' ')).not.toMatch(/Slightly down/);
  });
});

describe('rule F in trends', () => {
  it('a session dragged down by one bad set is not counted as a regression', () => {
    const r = run(hist('270x13@2, 270x13@2, 270x13@2', '270x14@2, 270x14@2, 270x8@2'), ex({ minReps: 10, maxReps: 15, loadIncrement: 10 }));
    expect(r.ruleId).toBe('B_ADD_REPS');
    expect(r.trend.regressionCount).toBe(0);
    expect(r.reasons.join(' ')).not.toMatch(/Slightly down/);
    expect(r.target.repTargets).toEqual([15, 15, 13]);
  });
  it('two real drops still trigger a regression deload even if one earlier session had an outlier', () => {
    const r = run(hist('225x9@2, 225x9@2, 225x5@2', '225x9@2, 225x9@2, 225x9@2', '225x8@2, 225x8@2, 225x8@2', '225x7@2, 225x7@2, 225x7@2'), ex({ minReps: 6, maxReps: 10 }));
    expect(r.ruleId).toBe('DELOAD_REGRESSION');
  });
  it('pain reviews carry no trend chatter', () => {
    const r = run(hist('95x13@2, 95x12@2, 95x12@2', ['95x12@2, 95x11@2, 95x10@2', { pain: 'significant' }]), ex({ minReps: 10, maxReps: 15 }));
    expect(r.ruleId).toBe('PAIN_REVIEW');
    expect(r.reasons.join(' ')).not.toMatch(/Slightly down/);
  });
});
