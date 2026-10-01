import { describe, expect, it } from 'vitest';
import { defaultIncrementFor, defaultProgression } from '../src/domain/defaults';
import {
  addLoad,
  analyzeTrend,
  applyReadiness,
  assessReadiness,
  computeBests,
  convertLoad,
  detectPersonalRecords,
  estimateOneRepMax,
  evaluateSession,
  formatLoad,
  reduceLoad,
  snapToStep,
  toTrendPoints,
  validateProgressionConfig,
  validateSetEntry,
} from '../src/engine';
import { ex, readiness, session } from './helpers';

const OPTS = { defaultRirConfidence: 4 };

describe('units', () => {
  it('adds loads without float noise', () => {
    expect(addLoad(22.5, 2.5)).toBe(25);
    expect(addLoad(1.1, 2.2)).toBe(3.3);
    expect(addLoad(18.75, 1.25)).toBe(20);
  });
  it('snaps to steps', () => {
    expect(snapToStep(61.235, 2.5, 'nearest')).toBe(60);
    expect(snapToStep(51.75, 2.5, 'floor')).toBe(50);
    expect(snapToStep(51.75, 2.5, 'ceil')).toBe(52.5);
    expect(snapToStep(10, 0, 'nearest')).toBe(10);
  });
  it('converts both directions', () => {
    expect(convertLoad(100, 'kg', 'lb')).toBeCloseTo(220.462, 3);
    expect(convertLoad(225, 'lb', 'kg')).toBeCloseTo(102.058, 3);
    expect(convertLoad(50, 'kg', 'kg')).toBe(50);
  });
  it('formats loads', () => {
    expect(formatLoad(null, 'lb')).toBe('your chosen load');
    expect(formatLoad(0, 'kg')).toBe('bodyweight');
    expect(formatLoad(57.5, 'kg')).toBe('57.5 kg');
  });
});

describe('plates unit', () => {
  it('never converts to or from plates (a plate count is not a weight)', () => {
    expect(convertLoad(3, 'plt', 'lb')).toBe(3);
    expect(convertLoad(100, 'lb', 'plt')).toBe(100);
    expect(convertLoad(45, 'plt', 'kg')).toBe(45);
    expect(convertLoad(2, 'plt', 'plt')).toBe(2);
  });
  it('steps by one whole plate by default', () => {
    expect(defaultIncrementFor('plt')).toBe(1);
    expect(defaultIncrementFor('kg')).toBe(2.5);
    expect(defaultIncrementFor('lb')).toBe(5);
  });
  it('formats as a plate count', () => {
    expect(formatLoad(3, 'plt')).toBe('3 plt');
    expect(formatLoad(0, 'plt')).toBe('bodyweight');
  });
  it('leaves the number untouched when a lb set is logged on a plates exercise', () => {
    const ev = evaluateSession(session('135lbx12@2, 135lbx12@2, 135lbx12@2', { unit: 'plt' }), ex({}, { unit: 'plt' }), OPTS);
    expect(ev.workingLoad).toBe(135); // not scaled by 0.4536 or 2.2046
    expect(ev.unitConverted).toBe(true);
  });
});

describe('metrics', () => {
  it('Epley e1RM', () => {
    expect(estimateOneRepMax(100, 10)).toBe(133.33);
    expect(estimateOneRepMax(100, 1)).toBe(100);
    expect(estimateOneRepMax(0, 10)).toBe(0);
  });
});

describe('reduceLoad', () => {
  const cfg = defaultProgression();
  it('drops at least one increment', () => {
    expect(reduceLoad(50, 5, cfg)).toBe(45);
  });
  it('snaps down and respects minLoad', () => {
    expect(reduceLoad(225, 10, cfg)).toBe(200);
    expect(reduceLoad(100, 10, { ...cfg, minLoad: 95 })).toBe(95);
  });
});

describe('evaluateSession', () => {
  it('counts working vs extras and the working load', () => {
    const ev = evaluateSession(session('135x12@2, 135x12@2, 135x11@2, 95x15'), ex(), OPTS);
    expect(ev.working).toHaveLength(3);
    expect(ev.extras).toHaveLength(1);
    expect(ev.workingLoad).toBe(135);
    expect(ev.essentiallyAllTop).toBe(true);
    expect(ev.toleranceUsed).toBe(true);
    expect(ev.volume).toBe(135 * 35 + 95 * 15);
  });
  it('mode load ties resolve to the lower load', () => {
    const ev = evaluateSession(session('135x10@2, 140x10@2', { prescribedSets: 2 }), ex(), OPTS);
    expect(ev.workingLoad).toBe(135);
  });
  it('RIR weight scales with confidence', () => {
    expect(evaluateSession(session('135x10@2c5, 135x10@2c5, 135x10@2c5'), ex(), OPTS).rir.weight).toBe(1);
    expect(evaluateSession(session('135x10@2c3, 135x10@2c3, 135x10@2c3'), ex(), OPTS).rir.weight).toBe(0.5);
    expect(evaluateSession(session('135x10@2c1, 135x10@2c1, 135x10@2c1'), ex(), OPTS).rir.reliable).toBe(false);
  });
  it('flags inconsistent RIR', () => {
    const ev = evaluateSession(session('135x10@1, 135x9@4, 135x9@2'), ex(), OPTS);
    expect(ev.rir.inconsistent).toBe(true);
  });
});

describe('trend', () => {
  const evs = (specs: string[]) => specs.map((s) => evaluateSession(session(s), ex(), OPTS));
  it('improving when reps rise at the same load', () => {
    const t = analyzeTrend(toTrendPoints(evs(['135x8@2, 135x8@2, 135x8@2', '135x9@2, 135x8@2, 135x8@2', '135x10@2, 135x9@2, 135x8@2']), [false, false, false]));
    expect(t.label).toBe('improving');
    expect(t.stallCount).toBe(0);
  });
  it('low-readiness sessions do not count toward a stall', () => {
    const e = evs(['135x10@2, 135x10@2, 135x10@2', '135x9@2, 135x9@2, 135x9@2', '135x10@2, 135x10@2, 135x10@2']);
    expect(analyzeTrend(toTrendPoints(e, [false, true, false])).stallCount).toBe(1);
    expect(analyzeTrend(toTrendPoints(e, [false, false, false])).stallCount).toBe(2);
  });
  it('insufficient data with one session', () => {
    expect(analyzeTrend(toTrendPoints(evs(['135x10@2, 135x10@2, 135x10@2']), [false])).label).toBe('insufficient-data');
  });
});

describe('readiness', () => {
  it('scores and levels', () => {
    expect(assessReadiness(null).level).toBe('unknown');
    expect(assessReadiness(readiness({ readiness: 4, energy: 4, fatigue: 2 })).level).toBe('normal');
    expect(assessReadiness(readiness({ readiness: 2, energy: 3, fatigue: 3, sleepHours: 6.5 })).level).toBe('caution');
    expect(assessReadiness(readiness({ readiness: 1, energy: 2, fatigue: 5, sleepHours: 4 })).level).toBe('poor');
    expect(assessReadiness(readiness({ readiness: 5, energy: 5, fatigue: 1, pain: true })).level).toBe('caution');
  });
  const cfg = defaultProgression();
  const baseline = { load: 140, unit: 'lb' as const, sets: 3, repTargets: [8, 8, 8], targetRir: 2 };
  it('caution postpones a load increase for today only', () => {
    const adj = applyReadiness(baseline, { action: 'increase-load', previous: { load: 135, reps: [12, 12, 12] } }, assessReadiness(readiness({ readiness: 2, energy: 2, fatigue: 3 })), cfg);
    expect(adj.adjusted).toBe(true);
    expect(adj.target.load).toBe(135);
    expect(adj.target.repTargets).toEqual([12, 12, 12]);
    expect(baseline.load).toBe(140); // baseline untouched
  });
  it('poor readiness also drops a set and adds RIR', () => {
    const adj = applyReadiness(baseline, { action: 'maintain', previous: null }, assessReadiness(readiness({ readiness: 1, energy: 1, fatigue: 5 })), cfg);
    expect(adj.target.sets).toBe(2);
    expect(adj.target.repTargets).toHaveLength(2);
    expect(adj.target.targetRir).toBe(3);
  });
  it('normal readiness changes nothing', () => {
    const adj = applyReadiness(baseline, { action: 'increase-load', previous: null }, assessReadiness(readiness({ readiness: 4 })), cfg);
    expect(adj.adjusted).toBe(false);
    expect(adj.target).toBe(baseline);
  });
});

describe('personal records', () => {
  const e = (s: string) => evaluateSession(session(s), ex(), OPTS);
  it('first session is a baseline, not a PR', () => {
    expect(detectPersonalRecords([], e('135x10@2, 135x10@2, 135x10@2'), false)).toEqual([]);
  });
  it('detects heaviest load, e1RM and volume', () => {
    const prs = detectPersonalRecords([e('135x12@2, 135x12@2, 135x12@2')], e('145x10@2, 145x9@2, 145x9@2'), false).map((p) => p.type);
    expect(prs).toContain('heaviest-load');
    expect(prs).toContain('estimated-1rm');
  });
  it('reps-at-load counts heavier previous sets too', () => {
    const prior = [e('140x10@2, 140x10@2, 140x10@2')];
    expect(detectPersonalRecords(prior, e('135x10@2, 135x10@2, 135x10@2'), false).map((p) => p.type)).not.toContain('reps-at-load');
    expect(detectPersonalRecords(prior, e('135x11@2, 135x10@2, 135x10@2'), false).map((p) => p.type)).toContain('reps-at-load');
  });
  it('historical bests track reps at each load', () => {
    const b = computeBests([e('135x10@2, 135x10@2, 135x10@2'), e('140x8@2, 140x8@2, 140x7@2')], false);
    expect(b.heaviestLoad?.load).toBe(140);
    expect(b.repsAtLoad).toEqual([expect.objectContaining({ load: 140, reps: 8 }), expect.objectContaining({ load: 135, reps: 10 })]);
  });
});

describe('validation', () => {
  it('accepts defaults', () => {
    expect(validateProgressionConfig(defaultProgression()).ok).toBe(true);
  });
  it('rejects bad values with field-level messages', () => {
    const r = validateProgressionConfig(defaultProgression({ minReps: 12, maxReps: 8, workingSets: 0, targetRir: 7, loadIncrement: -1, minLoad: 100, maxLoad: 50 }));
    expect(r.ok).toBe(false);
    expect(r.errors.map((x) => x.field).sort()).toEqual(['loadIncrement', 'maxLoad', 'maxReps', 'targetRir', 'workingSets'].sort());
  });
  it('validates set entries', () => {
    expect(validateSetEntry({ load: null, reps: 10, rir: 2, bodyweight: false, timeBased: false })).toMatch(/weight/);
    expect(validateSetEntry({ load: null, reps: 10, rir: 2, bodyweight: true, timeBased: false })).toBeNull();
    expect(validateSetEntry({ load: 100, reps: 10.5, rir: 2, bodyweight: false, timeBased: false })).toMatch(/whole number/);
    expect(validateSetEntry({ load: 100, reps: 10, rir: 11, bodyweight: false, timeBased: false })).toMatch(/RIR/);
  });
});
