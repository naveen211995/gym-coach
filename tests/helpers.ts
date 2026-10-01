import { defaultProgression } from '../src/domain/defaults';
import type {
  ExerciseSession,
  PainLevel,
  ProgressionConfig,
  ReadinessRecord,
  RecommendationAction,
  SetPerformance,
  Unit,
} from '../src/domain/types';
import type { EngineExercise, EngineHistoryEntry } from '../src/engine';

export function ex(cfg: Partial<ProgressionConfig> = {}, extra: Partial<Omit<EngineExercise, 'progression'>> = {}): EngineExercise {
  return { id: 'ex1', unit: 'lb', equipment: 'barbell', ...extra, progression: defaultProgression(cfg) };
}

/**
 * Parse compact set notation, comma separated:
 *   "135x10@2"      load 135, 10 reps, RIR 2
 *   "135x10@2c1"    …with RIR confidence 1
 *   "135x10"        no RIR
 *   "135x6F"        failed set
 *   "60kgx12@2"     logged in kg
 *   "skip"          skipped set
 *   "pending"       never logged
 */
export function sets(spec: string, defaultUnit: Unit = 'lb'): SetPerformance[] {
  return spec
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .map((tok, index): SetPerformance => {
      const base = { id: `s${index}`, index, note: '', rirConfidence: null, unit: defaultUnit };
      if (tok === 'skip') return { ...base, load: null, reps: null, rir: null, status: 'skipped' };
      if (tok === 'pending') return { ...base, load: null, reps: null, rir: null, status: 'pending' };
      const m = tok.match(/^(-?[\d.]+|null)(kg|lb)?x(-?[\d.]+|NaN)(?:@([\d.]+)(?:c(\d))?)?(F)?$/);
      if (!m) throw new Error(`Bad set token: ${tok}`);
      const [, load, unit, reps, rir, conf, failed] = m;
      return {
        ...base,
        unit: (unit as Unit | undefined) ?? defaultUnit,
        load: load === 'null' ? null : Number(load),
        reps: Number(reps),
        rir: rir === undefined ? null : Number(rir),
        rirConfidence: conf === undefined ? null : Number(conf),
        status: failed ? 'failed' : 'completed',
      };
    });
}

let counter = 0;
export interface SessionOpts {
  pain?: PainLevel;
  note?: string;
  prescribedAction?: RecommendationAction;
  prescribedSets?: number;
  exerciseId?: string;
  day?: number;
  unit?: Unit;
}

export function session(spec: string, opts: SessionOpts = {}): ExerciseSession {
  counter++;
  const day = opts.day ?? counter;
  const s = sets(spec, opts.unit ?? 'lb');
  return {
    id: `es${counter}`,
    workoutSessionId: `w${counter}`,
    exerciseId: opts.exerciseId ?? 'ex1',
    order: 0,
    status: 'completed',
    prescribed: {
      load: null,
      unit: opts.unit ?? 'lb',
      sets: opts.prescribedSets ?? 3,
      repTargets: [],
      targetRir: 2,
      action: opts.prescribedAction ?? 'maintain',
      summary: '',
      reasons: [],
      recommendationId: null,
      readinessAdjusted: false,
      readinessNotes: [],
    },
    sets: s,
    pain: opts.pain ?? 'none',
    note: opts.note ?? '',
    completedAt: new Date(Date.UTC(2026, 0, 1) + day * 86400000).toISOString(),
    substitutedFromExerciseId: null,
  };
}

/** Build chronological history from set specs (strings) or pre-built sessions. */
export function hist(...items: (string | ExerciseSession | [string, SessionOpts])[]): EngineHistoryEntry[] {
  return items.map((it, i) => {
    const s = typeof it === 'string' ? session(it, { day: i + 1 }) : Array.isArray(it) ? session(it[0], { day: i + 1, ...it[1] }) : it;
    return { session: s, readiness: null };
  });
}

export function readiness(values: Partial<ReadinessRecord>): ReadinessRecord {
  return { id: 'r1', workoutSessionId: 'w', recordedAt: '2026-01-01T00:00:00.000Z', readiness: null, energy: null, sleepHours: null, fatigue: null, pain: false, note: '', ...values };
}

export const LOW_READINESS = readiness({ readiness: 2, energy: 2, fatigue: 4 });
