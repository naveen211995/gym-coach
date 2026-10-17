import type {
  DeloadStrategy,
  EquipmentType,
  MuscleGroup,
  ProgressionConfig,
  ProgressionStrategy,
  Routine,
  RoutineSchedule,
  Unit,
  UserSettings,
  Weekday,
} from './types';
import { WEEKDAYS } from './types';

export const DEFAULT_PROGRESSION: Readonly<ProgressionConfig> = Object.freeze({
  workingSets: 3,
  minReps: 8,
  maxReps: 12,
  targetRir: 2,
  loadIncrement: 5,
  minLoad: null,
  maxLoad: null,
  startingLoad: null,
  strategy: 'double',
  deloadStrategy: 'reduce-load',
  deloadPercent: 10,
  stallSessionsBeforeDeload: 3,
  timeIncrementSeconds: 5,
});

export function defaultProgression(overrides: Partial<ProgressionConfig> = {}): ProgressionConfig {
  return { ...DEFAULT_PROGRESSION, ...overrides };
}

export function defaultIncrementFor(unit: Unit): number {
  return unit === 'kg' ? 2.5 : unit === 'plt' ? 1 : 5;
}

export function defaultSettings(nowIso: string, unit: Unit = 'lb'): UserSettings {
  return {
    id: 'user',
    defaultUnit: unit,
    defaultRirConfidence: 4,
    askRirConfidence: false,
    askReadiness: true,
    activeRoutineId: null,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

export const MUSCLE_GROUPS: readonly { value: MuscleGroup; label: string }[] = [
  { value: 'chest', label: 'Chest' },
  { value: 'back', label: 'Back' },
  { value: 'shoulders', label: 'Shoulders' },
  { value: 'biceps', label: 'Biceps' },
  { value: 'triceps', label: 'Triceps' },
  { value: 'forearms', label: 'Forearms' },
  { value: 'quads', label: 'Quads' },
  { value: 'hamstrings', label: 'Hamstrings' },
  { value: 'glutes', label: 'Glutes' },
  { value: 'calves', label: 'Calves' },
  { value: 'core', label: 'Core' },
  { value: 'full-body', label: 'Full body' },
];

export const EQUIPMENT_TYPES: readonly { value: EquipmentType; label: string }[] = [
  { value: 'barbell', label: 'Barbell' },
  { value: 'dumbbell', label: 'Dumbbell' },
  { value: 'machine', label: 'Machine' },
  { value: 'cable', label: 'Cable' },
  { value: 'smith', label: 'Smith machine' },
  { value: 'kettlebell', label: 'Kettlebell' },
  { value: 'bodyweight', label: 'Bodyweight' },
  { value: 'other', label: 'Other' },
];

export const STRATEGIES: readonly { value: ProgressionStrategy; label: string; description: string }[] = [
  {
    value: 'double',
    label: 'Double progression',
    description: 'Add reps inside the range; add load once every set reaches the top at your target RIR.',
  },
  {
    value: 'load-first',
    label: 'Load first',
    description: 'Add load as soon as every set reaches the bottom of the range. Good for heavy compounds.',
  },
  {
    value: 'rep-first',
    label: 'Rep first',
    description: 'Reach the top of the range in two sessions in a row before adding load. Good for isolation work.',
  },
  {
    value: 'time-based',
    label: 'Time based',
    description: 'For holds: add seconds each session; add load (if any) after every set reaches the maximum time.',
  },
];

export const DELOAD_STRATEGIES: readonly { value: DeloadStrategy; label: string; description: string }[] = [
  { value: 'reduce-load', label: 'Reduce load', description: 'Drop the load by the deload percentage and rebuild.' },
  { value: 'reduce-sets', label: 'Reduce sets', description: 'One session with about half the sets, then resume.' },
  { value: 'none', label: 'No deload', description: 'Flag stalls but never recommend a deload.' },
];

export const WEEKDAY_LABELS: Readonly<Record<Weekday, { short: string; long: string }>> = Object.freeze({
  mon: { short: 'Mon', long: 'Monday' },
  tue: { short: 'Tue', long: 'Tuesday' },
  wed: { short: 'Wed', long: 'Wednesday' },
  thu: { short: 'Thu', long: 'Thursday' },
  fri: { short: 'Fri', long: 'Friday' },
  sat: { short: 'Sat', long: 'Saturday' },
  sun: { short: 'Sun', long: 'Sunday' },
});

/** Every weekday a rest day. */
export function emptySchedule(): RoutineSchedule {
  return { mon: null, tue: null, wed: null, thu: null, fri: null, sat: null, sun: null };
}

/**
 * A routine's schedule, with every weekday present. Routines written before
 * schema 2 have none, so this is the only safe way to read it.
 */
export function scheduleOf(routine: Pick<Routine, 'schedule'> | null | undefined): RoutineSchedule {
  const out = emptySchedule();
  const raw = routine?.schedule;
  if (!raw) return out;
  for (const d of WEEKDAYS) {
    const v = raw[d];
    out[d] = typeof v === 'string' && v.length > 0 ? v : null;
  }
  return out;
}

/** A schedule with nothing assigned is not a plan, so the rotation is used instead. */
export function hasSchedule(routine: Pick<Routine, 'schedule'> | null | undefined): boolean {
  const s = scheduleOf(routine);
  return WEEKDAYS.some((d) => s[d] !== null);
}

/**
 * The default weekly split for a new routine: four training days, with
 * Wednesday, Saturday and Sunday as explicit rest days.
 */
export const DEFAULT_SPLIT: readonly { name: string; weekdays: readonly Weekday[] }[] = Object.freeze([
  { name: 'Push', weekdays: ['mon'] },
  { name: 'Pull', weekdays: ['tue'] },
  { name: 'Legs', weekdays: ['thu'] },
  { name: 'Delts + Width + Arms', weekdays: ['fri'] },
]);

/**
 * Evidence-backed window for proximity to failure on hypertrophy work: roughly
 * RIR 0-3 produces similar growth per set, and sets taken much further from
 * failure produce less. Shown as guidance in the exercise editor; nothing in
 * the engine enforces it.
 */
export const TARGET_RIR_GUIDANCE = Object.freeze({ low: 1, high: 3, heavyCompoundHigh: 4 });

export const PAIN_LEVELS = [
  { value: 'none', label: 'No pain' },
  { value: 'mild', label: 'Mild' },
  { value: 'significant', label: 'Significant' },
] as const;
