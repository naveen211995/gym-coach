/**
 * Domain model for Gym Progression Coach.
 *
 * Records reference each other by id (normalized). Set performances live inside
 * their ExerciseSession because they are owned by it and never shared.
 * Completed history is never mutated by the app; corrections happen only while
 * the owning workout is still in progress.
 */

export type Unit = 'lb' | 'kg' | 'plt';

export type MuscleGroup =
  | 'chest' | 'back' | 'shoulders' | 'biceps' | 'triceps' | 'forearms'
  | 'quads' | 'hamstrings' | 'glutes' | 'calves' | 'core' | 'full-body';

export type EquipmentType =
  | 'barbell' | 'dumbbell' | 'machine' | 'cable' | 'smith' | 'kettlebell' | 'bodyweight' | 'other';

export type ProgressionStrategy = 'double' | 'load-first' | 'rep-first' | 'time-based';
export type DeloadStrategy = 'reduce-load' | 'reduce-sets' | 'none';

export type SetStatus = 'pending' | 'completed' | 'failed' | 'skipped';
export type PainLevel = 'none' | 'mild' | 'significant';

export type RecommendationAction =
  | 'establish-baseline'
  | 'increase-load'
  | 'increase-reps'
  | 'maintain'
  | 'decrease-load'
  | 'deload'
  | 'review';

export type Direction = 'up' | 'same' | 'down';
export type TrendLabel = 'improving' | 'plateau' | 'regressing' | 'insufficient-data';

export type RecommendationFlag =
  | 'stall'
  | 'plateau-warning'
  | 'regression'
  | 'pain-review'
  | 'pain-caution'
  | 'low-rir-confidence'
  | 'inconsistent-rir'
  | 'max-load-reached'
  | 'min-load-reached'
  | 'mixed-loads'
  | 'incomplete-session'
  | 'outlier-set'
  | 'off-day'
  | 'invalid-config'
  | 'progress-variation'
  | 'unit-converted'
  | 'data-warning';

export interface ProgressionConfig {
  workingSets: number;
  /** Minimum reps (or seconds for time-based). */
  minReps: number;
  /** Maximum reps (or seconds for time-based). */
  maxReps: number;
  targetRir: number;
  /** Load step in the exercise unit. 0 disables load progression. */
  loadIncrement: number;
  minLoad: number | null;
  maxLoad: number | null;
  /** Suggested first-session load when there is no history. */
  startingLoad: number | null;
  strategy: ProgressionStrategy;
  deloadStrategy: DeloadStrategy;
  /** Load reduction for a reduce-load deload, in percent. */
  deloadPercent: number;
  /** Consecutive non-progressing sessions that trigger a deload. */
  stallSessionsBeforeDeload: number;
  /** Seconds added per set for time-based progression. */
  timeIncrementSeconds: number;
}

export interface Exercise {
  id: string;
  name: string;
  muscleGroup: MuscleGroup;
  equipment: EquipmentType;
  unit: Unit;
  progression: ProgressionConfig;
  notes: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Routine {
  id: string;
  name: string;
  /** Ordered day ids; the rotation follows this order. */
  dayIds: string[];
  createdAt: string;
}

export interface RoutineDay {
  id: string;
  routineId: string;
  name: string;
  /** Ordered exercise ids. */
  exerciseIds: string[];
}

export type WorkoutStatus = 'in-progress' | 'completed';

export interface WorkoutSession {
  id: string;
  routineId: string | null;
  routineDayId: string | null;
  /** Snapshot of the day name so history survives routine edits. */
  name: string;
  status: WorkoutStatus;
  startedAt: string;
  completedAt: string | null;
  readinessId: string | null;
  notes: string;
}

export interface NextTarget {
  load: number | null;
  unit: Unit;
  sets: number;
  /** Per-set rep targets (seconds for time-based). Length === sets. */
  repTargets: number[];
  targetRir: number;
}

/** Immutable snapshot of what was prescribed when the exercise session was created. */
export interface PrescribedTarget extends NextTarget {
  action: RecommendationAction;
  summary: string;
  reasons: string[];
  recommendationId: string | null;
  readinessAdjusted: boolean;
  readinessNotes: string[];
}

export type ExerciseSessionStatus = 'pending' | 'in-progress' | 'completed' | 'skipped';

export interface SetPerformance {
  id: string;
  index: number;
  load: number | null;
  unit: Unit;
  /** Reps, or seconds for time-based exercises. */
  reps: number | null;
  rir: number | null;
  /** 1 (guess) – 5 (very sure). null = use the default from settings. */
  rirConfidence: number | null;
  status: SetStatus;
  note: string;
}

export interface ExerciseSession {
  id: string;
  workoutSessionId: string;
  exerciseId: string;
  order: number;
  status: ExerciseSessionStatus;
  prescribed: PrescribedTarget;
  sets: SetPerformance[];
  pain: PainLevel;
  note: string;
  completedAt: string | null;
  substitutedFromExerciseId: string | null;
}

export interface TrendSnapshot {
  label: TrendLabel;
  windowSize: number;
  changePct: number | null;
  stallCount: number;
  regressionCount: number;
}

export interface ProgressionRecommendation {
  id: string;
  exerciseId: string;
  basedOnExerciseSessionId: string | null;
  createdAt: string;
  action: RecommendationAction;
  direction: Direction;
  previous: { load: number | null; reps: number[]; unit: Unit } | null;
  target: NextTarget;
  summary: string;
  reasons: string[];
  ruleId: string;
  flags: RecommendationFlag[];
  trend: TrendSnapshot;
  warnings: string[];
  engineVersion: string;
}

export type PersonalRecordType =
  | 'heaviest-load'
  | 'reps-at-load'
  | 'estimated-1rm'
  | 'session-volume'
  | 'longest-hold';

export interface PersonalRecord {
  id: string;
  exerciseId: string;
  exerciseSessionId: string;
  workoutSessionId: string;
  type: PersonalRecordType;
  value: number;
  load: number | null;
  reps: number | null;
  unit: Unit;
  previousValue: number | null;
  achievedAt: string;
}

export interface ReadinessRecord {
  id: string;
  workoutSessionId: string;
  recordedAt: string;
  /** 1–5, higher is better. */
  readiness: number | null;
  /** 1–5, higher is better. */
  energy: number | null;
  sleepHours: number | null;
  /** 1–5, higher is MORE fatigued. */
  fatigue: number | null;
  /** General pain or niggle today. */
  pain: boolean;
  note: string;
}

export interface ExerciseSubstitution {
  id: string;
  workoutSessionId: string;
  originalExerciseSessionId: string;
  originalExerciseId: string;
  substituteExerciseId: string;
  reason: string;
  createdAt: string;
}

export interface UserSettings {
  id: 'user';
  defaultUnit: Unit;
  /** Confidence assumed when a set has RIR but no explicit confidence. */
  defaultRirConfidence: number;
  askRirConfidence: boolean;
  askReadiness: boolean;
  activeRoutineId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Dataset {
  settings: UserSettings;
  exercises: Exercise[];
  routines: Routine[];
  routineDays: RoutineDay[];
  workoutSessions: WorkoutSession[];
  exerciseSessions: ExerciseSession[];
  recommendations: ProgressionRecommendation[];
  personalRecords: PersonalRecord[];
  readiness: ReadinessRecord[];
  substitutions: ExerciseSubstitution[];
}

/** Collections that hold id-keyed records (everything except settings). */
export type CollectionName = Exclude<keyof Dataset, 'settings'>;

export const COLLECTIONS: readonly CollectionName[] = [
  'exercises',
  'routines',
  'routineDays',
  'workoutSessions',
  'exerciseSessions',
  'recommendations',
  'personalRecords',
  'readiness',
  'substitutions',
] as const;
