/**
 * Example data: a 4-day Upper/Lower routine with ~5 weeks of history.
 *
 * The history is created by replaying the real services (start workout → log
 * sets → complete → finish), so seeded recommendations and PRs come from the
 * same code path as live use. Each exercise's history is written so its next
 * recommendation demonstrates a different rule (see EXPECTED_SEED_RULES).
 */
import { applyChange, emptyDataset, type Change } from '../domain/change';
import { defaultProgression, defaultSettings } from '../domain/defaults';
import type { Dataset, EquipmentType, MuscleGroup, PainLevel, ProgressionConfig, Unit } from '../domain/types';
import { sessionsForWorkout } from './selectors';
import {
  completeExercise,
  createExercise,
  createRoutine,
  finishWorkout,
  logSet,
  markSet,
  addSet,
  setDayExercises,
  setExerciseNote,
  setPain,
  startWorkout,
  type Ctx,
  type ReadinessInput,
} from './services';

type DayKey = 'upperA' | 'lowerA' | 'upperB' | 'lowerB';
type SeedSession = string | { sets: string; pain?: PainLevel; note?: string };

interface SeedExercise {
  key: string;
  name: string;
  day: DayKey;
  muscleGroup: MuscleGroup;
  equipment: EquipmentType;
  unit?: Unit;
  cfg?: Partial<ProgressionConfig>;
  notes?: string;
  sessions: [SeedSession, SeedSession, SeedSession, SeedSession, SeedSession];
}

export const SEED_EXERCISES: SeedExercise[] = [
  // ── Upper A ──
  {
    key: 'bench', name: 'Barbell Bench Press', day: 'upperA', muscleGroup: 'chest', equipment: 'barbell', cfg: { minReps: 6, maxReps: 10 },
    sessions: ['180x10@2, 180x10@2, 180x10@2', '185x8@2, 185x7@2, 185x7@2', '185x9@2, 185x8@2, 185x8@2', '185x10@2, 185x9@2, 185x9@2', '185x10@2, 185x10@2, 185x10@2'],
  },
  {
    key: 'row', name: 'Chest-Supported Row', day: 'upperA', muscleGroup: 'back', equipment: 'machine',
    sessions: ['110x12@2, 110x12@2, 110x12@2', '115x9@2, 115x9@2, 115x8@2', '115x10@2, 115x9@2, 115x9@2', '115x10@2, 115x10@2, 115x9@2', '115x11@2, 115x11@2, 115x10@2'],
  },
  {
    key: 'ohp', name: 'Seated Dumbbell Shoulder Press', day: 'upperA', muscleGroup: 'shoulders', equipment: 'dumbbell', notes: 'Load is per dumbbell.',
    sessions: ['45x12@2, 45x12@2, 45x11@2', '50x9@2, 50x8@2, 50x8@2', '50x9@2, 50x8@2, 50x8@2', '50x8@1, 50x8@1, 50x8@1', '50x9@2, 50x8@2, 50x7@1'],
  },
  {
    key: 'pushdown', name: 'Cable Triceps Pushdown', day: 'upperA', muscleGroup: 'triceps', equipment: 'cable', cfg: { strategy: 'rep-first', minReps: 10, maxReps: 15 },
    sessions: ['45x15@2, 45x15@2, 45x15@2', '45x15@2, 45x15@2, 45x15@2', '50x12@2, 50x11@2, 50x11@2', '50x14@2, 50x13@2, 50x12@2', '50x15@2, 50x15@2, 50x14@2'],
  },
  // ── Lower A ──
  {
    key: 'squat', name: 'Back Squat', day: 'lowerA', muscleGroup: 'quads', equipment: 'barbell', cfg: { minReps: 6, maxReps: 10 },
    sessions: ['220x9@2, 220x8@2, 220x8@2', '220x10@2, 220x10@2, 220x10@2', '225x9@2, 225x9@2, 225x9@2', '225x8@1, 225x8@1, 225x8@1', { sets: '225x7@1, 225x7@1, 225x7@0', note: 'Legs felt flat all week' }],
  },
  {
    key: 'rdl', name: 'Romanian Deadlift', day: 'lowerA', muscleGroup: 'hamstrings', equipment: 'barbell',
    sessions: ['160x12@2, 160x12@2, 160x11@2', '165x10@2, 165x9@2, 165x9@2', '165x11@2, 165x11@2, 165x10@2', '165x12@2, 165x12@2, 165x12@2', '170x12@4c5, 170x12@4c5, 170x10@3c5'],
  },
  {
    key: 'legext', name: 'Leg Extension', day: 'lowerA', muscleGroup: 'quads', equipment: 'machine', cfg: { minReps: 10, maxReps: 15 },
    sessions: ['90x15@2, 90x15@2, 90x14@2', '95x12@2, 95x11@2, 95x11@2', '95x14@2, 95x13@2, 95x13@2', '95x15@2, 95x15@2, 95x15@2', '100x15@0, 100x15@0, 100x15@0'],
  },
  {
    key: 'calf', name: 'Standing Calf Raise', day: 'lowerA', muscleGroup: 'calves', equipment: 'machine', cfg: { minReps: 10, maxReps: 15, loadIncrement: 10 },
    sessions: ['140x15@2, 140x15@2, 140x14@2', '150x12@2, 150x12@2, 150x11@2', '150x14@2, 150x13@2, 150x13@2', '150x15@2, 150x15@2, 150x15@2', '160x9@1, 160x9@1, 160x8@1'],
  },
  // ── Upper B ──
  {
    key: 'incline', name: 'Incline Dumbbell Press', day: 'upperB', muscleGroup: 'chest', equipment: 'dumbbell', notes: 'Load is per dumbbell.',
    sessions: ['55x10@2, 55x9@2, 55x9@2', '55x11@2, 55x10@2, 55x10@2', '55x12@2, 55x12@2, 55x11@2', '60x11@2, 60x10@2, 60x10@2', '60x12@4c1, 60x12@4c1, 60x12@4c1'],
  },
  {
    key: 'pulldown', name: 'Lat Pulldown', day: 'upperB', muscleGroup: 'back', equipment: 'cable', unit: 'kg', cfg: { loadIncrement: 2.5 },
    sessions: ['52.5x12@2, 52.5x12@2, 52.5x12@2', '55x10@2, 55x10@2, 55x9@2', '55x12@2, 55x12@2, 55x11@2', '57.5x10@2, 57.5x10@2, 57.5x9@2', '57.5x12@2, 57.5x12@2, 57.5x11@2'],
  },
  {
    key: 'lateral', name: 'Dumbbell Lateral Raise', day: 'upperB', muscleGroup: 'shoulders', equipment: 'dumbbell', cfg: { minReps: 12, maxReps: 15, loadIncrement: 2.5 }, notes: 'Load is per dumbbell.',
    sessions: ['20x15@2, 20x15@2, 20x15@2', '22.5x12@2, 22.5x12@2, 22.5x12@2', '22.5x13@2, 22.5x12@2, 22.5x12@2', '22.5x13@2, 22.5x13@2, 22.5x12@2', '22.5x14@4c5, 22.5x13@4c5, 22.5x12@4c5'],
  },
  {
    key: 'curl', name: 'EZ-Bar Curl', day: 'upperB', muscleGroup: 'biceps', equipment: 'barbell',
    sessions: ['60x12@2, 60x12@2, 60x11@2', '65x8@2, 65x8@2, 65x8@2', '65x9@2, 65x8@2, 65x8@2', '65x9@2, 65x9@2, 65x8@2', { sets: '65x9@2, 65x8@2, skip', note: 'Ran out of time' }],
  },
  // ── Lower B ──
  {
    key: 'legpress', name: 'Leg Press', day: 'lowerB', muscleGroup: 'quads', equipment: 'machine', cfg: { minReps: 10, maxReps: 15, loadIncrement: 10 },
    sessions: ['260x15@2, 260x15@2, 260x14@2', '270x12@2, 270x12@2, 270x11@2', '270x12@2, 270x12@2, 270x11@2', '270x13@2, 270x13@2, 270x13@2', { sets: '270x14@2, 270x14@2, 270x8@2', note: 'Foot slipped on the last set' }],
  },
  {
    key: 'legcurl', name: 'Lying Leg Curl', day: 'lowerB', muscleGroup: 'hamstrings', equipment: 'machine', cfg: { minReps: 10, maxReps: 15 },
    sessions: ['90x15@2, 90x15@2, 90x15@2', '95x11@2, 95x11@2, 95x10@2', '95x12@2, 95x12@2, 95x11@2', '95x13@2, 95x12@2, 95x12@2', { sets: '95x12@2, 95x11@2, 95x10@3', pain: 'significant', note: 'Sharp pain behind left knee on set 2' }],
  },
  {
    key: 'hipthrust', name: 'Barbell Hip Thrust', day: 'lowerB', muscleGroup: 'glutes', equipment: 'barbell', cfg: { loadIncrement: 10 },
    sessions: ['195x12@2, 195x12@2, 195x12@2', '205x10@2, 205x9@2, 205x9@2', '205x7@1, 205x7@1, 205x6@1', '205x11@2, 205x10@2, 205x10@2', '205x12@5c5, 205x12@5c5, 205x12@5c5'],
  },
  {
    key: 'plank', name: 'Plank', day: 'lowerB', muscleGroup: 'core', equipment: 'bodyweight',
    cfg: { strategy: 'time-based', minReps: 30, maxReps: 60, loadIncrement: 0, timeIncrementSeconds: 5, deloadStrategy: 'none' },
    sessions: ['bwx30, bwx30, bwx30', 'bwx35, bwx35, bwx30', 'bwx35, bwx35, bwx35', 'bwx45, bwx40, bwx40', 'bwx50, bwx45, bwx45'],
  },
];

/** What the engine should recommend next for each seeded exercise (asserted in tests/seed.test.ts). */
export const EXPECTED_SEED_RULES: Record<string, { ruleId: string; load: number | null; reps: number[] }> = {
  bench: { ruleId: 'A_TOP_OF_RANGE', load: 190, reps: [6, 6, 6] },
  row: { ruleId: 'B_ADD_REPS', load: 115, reps: [12, 12, 11] },
  ohp: { ruleId: 'DELOAD_STALL', load: 45, reps: [9, 8, 8] },
  pushdown: { ruleId: 'REP_FIRST_CONSOLIDATE', load: 50, reps: [15, 15, 15] },
  squat: { ruleId: 'DELOAD_REGRESSION', load: 200, reps: [7, 7, 7] },
  rdl: { ruleId: 'D_HIGH_RIR_EARLY_INCREASE', load: 175, reps: [8, 8, 8] },
  legext: { ruleId: 'E_TOP_LOW_RIR', load: 100, reps: [15, 15, 15] },
  calf: { ruleId: 'C_FIRST_BELOW', load: 160, reps: [10, 10, 10] },
  incline: { ruleId: 'A_TOP_OF_RANGE', load: 65, reps: [8, 8, 8] },
  pulldown: { ruleId: 'A_TOP_OF_RANGE', load: 60, reps: [8, 8, 8] },
  lateral: { ruleId: 'B_ADD_REPS_HIGH_RIR', load: 22.5, reps: [15, 15, 14] },
  curl: { ruleId: 'INCOMPLETE_SESSION', load: 65, reps: [9, 8, 8] },
  legpress: { ruleId: 'B_ADD_REPS', load: 270, reps: [15, 15, 13] },
  legcurl: { ruleId: 'PAIN_REVIEW', load: 95, reps: [12, 11, 10] },
  hipthrust: { ruleId: 'D_TOP_HIGH_RIR_BIG', load: 225, reps: [8, 8, 8] },
  plank: { ruleId: 'T_ADD_TIME', load: 0, reps: [55, 50, 50] },
};

const DAY_NAMES: Record<DayKey, string> = { upperA: 'Upper A', lowerA: 'Lower A', upperB: 'Upper B', lowerB: 'Lower B' };
const ROUTINE_ORDER: DayKey[] = ['upperA', 'lowerA', 'upperB', 'lowerB'];
/** Workout order in the log (oldest first), repeated 5 times; ends on Upper B yesterday so Lower B is next. */
const CYCLE: DayKey[] = ['lowerB', 'upperA', 'lowerA', 'upperB'];
/** Days back from each workout to the previous one, walking backwards from the last Upper B. */
const GAPS_BACK = [2, 1, 3, 1];

const READINESS_NORMAL: ReadinessInput[] = [
  { readiness: 4, energy: 4, fatigue: 2, sleepHours: 7.5, pain: false },
  { readiness: 4, energy: 3, fatigue: 2, sleepHours: 7, pain: false },
  { readiness: 3, energy: 4, fatigue: 3, sleepHours: 8, pain: false },
  { readiness: 5, energy: 4, fatigue: 2, sleepHours: 7.5, pain: false },
];
const READINESS_LOW: ReadinessInput = { readiness: 2, energy: 3, fatigue: 3, sleepHours: 6.5, pain: false, note: 'Long day at work, stiff from sitting' };

interface ParsedSet {
  load: number | null;
  reps: number;
  rir: number | null;
  conf: number | null;
  skip: boolean;
}

function parseSets(spec: string): ParsedSet[] {
  return spec.split(',').map((raw) => {
    const t = raw.trim();
    if (t === 'skip') return { load: null, reps: 0, rir: null, conf: null, skip: true };
    const m = t.match(/^(bw|[\d.]+)x(\d+)(?:@([\d.]+)(?:c(\d))?)?$/);
    if (!m) throw new Error(`Bad seed set: ${t}`);
    return { load: m[1] === 'bw' ? null : Number(m[1]), reps: Number(m[2]), rir: m[3] === undefined ? null : Number(m[3]), conf: m[4] === undefined ? null : Number(m[4]), skip: false };
  });
}

/** Local date `daysAgo` days before `now`, at the given hour. */
function localAt(now: Date, daysAgo: number, hour: number, minute = 0): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo, hour, minute, 0, 0);
}

export function buildSeedDataset(now: Date, newId: (prefix: string) => string): Dataset {
  const iso = (d: Date) => d.toISOString();
  let ds = emptyDataset(defaultSettings(iso(localAt(now, 40, 12))));
  const apply = (c: Change) => {
    ds = applyChange(ds, c);
  };
  const ctxAt = (d: Date): Ctx => ({ now: iso(d), newId });
  const setupCtx = ctxAt(localAt(now, 40, 12));

  // Exercises and routine.
  const idByKey = new Map<string, string>();
  for (const s of SEED_EXERCISES) {
    const unit = s.unit ?? 'lb';
    const { change, id } = createExercise(ds, { name: s.name, muscleGroup: s.muscleGroup, equipment: s.equipment, unit, progression: defaultProgression(s.cfg ?? {}), notes: s.notes ?? '' }, setupCtx);
    apply(change);
    idByKey.set(s.key, id);
  }
  const routine = createRoutine(ds, 'Upper / Lower (4 days)', ROUTINE_ORDER.map((d) => DAY_NAMES[d]), setupCtx);
  apply(routine.change);
  const dayIdByKey = new Map<DayKey, string>();
  const r = ds.routines.find((x) => x.id === routine.id);
  ROUTINE_ORDER.forEach((k, i) => dayIdByKey.set(k, r?.dayIds[i] ?? ''));
  for (const k of ROUTINE_ORDER) {
    apply(setDayExercises(ds, dayIdByKey.get(k) ?? '', SEED_EXERCISES.filter((s) => s.day === k).map((s) => idByKey.get(s.key) ?? '')));
  }

  // Dates, newest (last Upper B = yesterday) to oldest.
  const total = CYCLE.length * 5;
  const daysAgo: number[] = new Array(total);
  let d = 1;
  for (let i = total - 1, g = 0; i >= 0; i--, g++) {
    daysAgo[i] = d;
    d += GAPS_BACK[g % GAPS_BACK.length] ?? 1;
  }

  const byExerciseId = new Map(SEED_EXERCISES.map((s) => [idByKey.get(s.key) ?? '', s]));
  for (let i = 0; i < total; i++) {
    const dayKey = CYCLE[i % CYCLE.length] as DayKey;
    const cycle = Math.floor(i / CYCLE.length);
    const start = localAt(now, daysAgo[i] ?? 1, 18, 5 + (i % 3) * 10);
    const readiness = dayKey === 'lowerB' && cycle === 2 ? READINESS_LOW : i % 5 === 3 ? null : (READINESS_NORMAL[i % READINESS_NORMAL.length] ?? null);
    const started = startWorkout(ds, { routineDayId: dayIdByKey.get(dayKey) ?? null, readiness }, ctxAt(start));
    apply(started.change);

    sessionsForWorkout(ds, started.workoutId).forEach((es, order) => {
      const seed = byExerciseId.get(es.exerciseId);
      if (!seed) return;
      const spec = seed.sessions[cycle] as SeedSession;
      const { sets, pain, note } = typeof spec === 'string' ? { sets: spec, pain: undefined, note: undefined } : spec;
      const parsed = parseSets(sets);
      const when = new Date(start.getTime() + (order + 1) * 13 * 60000);
      const ctx = ctxAt(when);
      parsed.forEach((p, idx) => {
        const cur = ds.exerciseSessions.find((x) => x.id === es.id);
        if (cur && idx >= cur.sets.length) apply(addSet(ds, es.id, ctx));
        if (p.skip) apply(markSet(ds, es.id, idx, 'skipped'));
        else apply(logSet(ds, es.id, idx, { load: p.load, reps: p.reps, rir: p.rir, rirConfidence: p.conf, note: '', status: 'completed' }));
      });
      if (pain) apply(setPain(ds, es.id, pain, ctx));
      if (note) apply(setExerciseNote(ds, es.id, note));
      apply(completeExercise(ds, es.id, ctx).change);
    });
    apply(finishWorkout(ds, started.workoutId, ctxAt(new Date(start.getTime() + 58 * 60000))));
  }
  return ds;
}
