/**
 * Runtime validators for imported data. A backup file is untrusted input: every
 * record is checked field by field before it can reach the app or the engine.
 */
import type { Dataset } from '../domain/types';
import { EQUIPMENT_TYPES, MUSCLE_GROUPS } from '../domain/defaults';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isNullNum = (v: unknown): v is number | null => v === null || isNum(v);
const isNullStr = (v: unknown): v is string | null => v === null || isStr(v);
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isIso = (v: unknown): v is string => isStr(v) && !Number.isNaN(Date.parse(v));
const isNullIso = (v: unknown): v is string | null => v === null || isIso(v);
const oneOf = <T extends string>(vals: readonly T[]) => (v: unknown): v is T => isStr(v) && (vals as readonly string[]).includes(v);
const arrOf = <T>(pred: (x: unknown) => x is T) => (v: unknown): v is T[] => Array.isArray(v) && v.every(pred);
const isId = (v: unknown): v is string => isStr(v) && v.length > 0 && v.length <= 200;

const UNIT = oneOf(['lb', 'kg', 'plt'] as const);
const MUSCLE = oneOf(MUSCLE_GROUPS.map((m) => m.value));
const EQUIP = oneOf(EQUIPMENT_TYPES.map((m) => m.value));
const STRATEGY = oneOf(['double', 'load-first', 'rep-first', 'time-based'] as const);
const DELOAD = oneOf(['reduce-load', 'reduce-sets', 'none'] as const);
const ACTION = oneOf(['establish-baseline', 'increase-load', 'increase-reps', 'maintain', 'decrease-load', 'deload', 'review'] as const);
const SET_STATUS = oneOf(['pending', 'completed', 'failed', 'skipped'] as const);
const PAIN = oneOf(['none', 'mild', 'significant'] as const);
const ES_STATUS = oneOf(['pending', 'in-progress', 'completed', 'skipped'] as const);
const WS_STATUS = oneOf(['in-progress', 'completed'] as const);
const PR_TYPE = oneOf(['heaviest-load', 'reps-at-load', 'estimated-1rm', 'session-volume', 'longest-hold'] as const);
const DIRECTION = oneOf(['up', 'same', 'down'] as const);
const TREND = oneOf(['improving', 'plateau', 'regressing', 'insufficient-data'] as const);

/** Build a validator from a field → predicate table. Returns the first problem found. */
function shape(fields: Record<string, (v: unknown) => boolean>): (v: unknown) => string | null {
  return (v) => {
    if (!isObj(v)) return 'not an object';
    for (const [k, pred] of Object.entries(fields)) if (!pred(v[k])) return `invalid "${k}"`;
    return null;
  };
}

const progression = shape({
  workingSets: isNum,
  minReps: isNum,
  maxReps: isNum,
  targetRir: isNum,
  loadIncrement: isNum,
  minLoad: isNullNum,
  maxLoad: isNullNum,
  startingLoad: isNullNum,
  strategy: STRATEGY,
  deloadStrategy: DELOAD,
  deloadPercent: isNum,
  stallSessionsBeforeDeload: isNum,
  timeIncrementSeconds: isNum,
});

const nextTarget = {
  load: isNullNum,
  unit: UNIT,
  sets: isNum,
  repTargets: arrOf(isNum),
  targetRir: isNum,
};

const setPerformance = shape({
  id: isId,
  index: isNum,
  load: isNullNum,
  unit: UNIT,
  reps: isNullNum,
  rir: isNullNum,
  rirConfidence: isNullNum,
  status: SET_STATUS,
  note: isStr,
});

export const validators: { [K in keyof Omit<Dataset, 'settings'>]: (v: unknown) => string | null } & { settings: (v: unknown) => string | null } = {
  settings: shape({
    id: (v) => v === 'user',
    defaultUnit: UNIT,
    defaultRirConfidence: isNum,
    askRirConfidence: isBool,
    askReadiness: isBool,
    activeRoutineId: isNullStr,
    createdAt: isIso,
    updatedAt: isIso,
  }),
  exercises: (v) =>
    shape({ id: isId, name: (x) => isStr(x) && x.trim().length > 0 && x.length <= 80, muscleGroup: MUSCLE, equipment: EQUIP, unit: UNIT, notes: isStr, archived: isBool, createdAt: isIso, updatedAt: isIso })(v) ??
    (progression((v as Obj).progression) ? `progression: ${progression((v as Obj).progression)}` : null),
  routines: shape({ id: isId, name: isStr, dayIds: arrOf(isId), createdAt: isIso }),
  routineDays: shape({ id: isId, routineId: isId, name: isStr, exerciseIds: arrOf(isId) }),
  workoutSessions: shape({ id: isId, routineId: isNullStr, routineDayId: isNullStr, name: isStr, status: WS_STATUS, startedAt: isIso, completedAt: isNullIso, readinessId: isNullStr, notes: isStr }),
  exerciseSessions: (v) => {
    const base = shape({
      id: isId,
      workoutSessionId: isId,
      exerciseId: isId,
      order: isNum,
      status: ES_STATUS,
      pain: PAIN,
      note: isStr,
      completedAt: isNullIso,
      substitutedFromExerciseId: isNullStr,
      sets: Array.isArray,
    })(v);
    if (base) return base;
    const o = v as Obj;
    const p = shape({ ...nextTarget, action: ACTION, summary: isStr, reasons: arrOf(isStr), recommendationId: isNullStr, readinessAdjusted: isBool, readinessNotes: arrOf(isStr) })(o.prescribed);
    if (p) return `prescribed: ${p}`;
    for (const s of o.sets as unknown[]) {
      const e = setPerformance(s);
      if (e) return `set: ${e}`;
    }
    return null;
  },
  recommendations: shape({
    id: isId,
    exerciseId: isId,
    basedOnExerciseSessionId: isNullStr,
    createdAt: isIso,
    action: ACTION,
    direction: DIRECTION,
    previous: (x) => x === null || (isObj(x) && isNullNum(x.load) && arrOf(isNum)(x.reps) && UNIT(x.unit)),
    target: (x) => shape(nextTarget)(x) === null,
    summary: isStr,
    reasons: arrOf(isStr),
    ruleId: isStr,
    flags: arrOf(isStr),
    trend: (x) => isObj(x) && TREND(x.label) && isNum(x.windowSize) && isNullNum(x.changePct) && isNum(x.stallCount) && isNum(x.regressionCount),
    warnings: arrOf(isStr),
    engineVersion: isStr,
  }),
  personalRecords: shape({ id: isId, exerciseId: isId, exerciseSessionId: isId, workoutSessionId: isId, type: PR_TYPE, value: isNum, load: isNullNum, reps: isNullNum, unit: UNIT, previousValue: isNullNum, achievedAt: isIso }),
  readiness: shape({ id: isId, workoutSessionId: isId, recordedAt: isIso, readiness: isNullNum, energy: isNullNum, sleepHours: isNullNum, fatigue: isNullNum, pain: isBool, note: isStr }),
  substitutions: shape({ id: isId, workoutSessionId: isId, originalExerciseSessionId: isId, originalExerciseId: isId, substituteExerciseId: isId, reason: isStr, createdAt: isIso }),
};
