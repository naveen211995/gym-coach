/**
 * Weekly volume and frequency per muscle group — pure and deterministic.
 *
 * Weekly sets per muscle group is the best-supported dose variable for
 * hypertrophy, and training a muscle at least twice a week makes a given weekly
 * volume easier to distribute. Nothing here changes a recommendation: it is a
 * report, so the lifter can see what their routine actually delivers.
 *
 * Two honest limits, both surfaced in the UI:
 *  - each exercise carries ONE muscle group, so secondary work (triceps on a
 *    bench press, say) is not counted anywhere;
 *  - set counts are what was logged, not what was planned.
 */
import type { MuscleGroup } from '../domain/types';
import { RULES } from './rules';
import type { SessionEvaluation } from './sessionEval';

export type VolumeLevel = 'none' | 'low' | 'in-band' | 'high';

/** One completed exercise session, with the muscle group it is attributed to. */
export interface VolumeSession {
  muscleGroup: MuscleGroup;
  exerciseId: string;
  workoutSessionId: string;
  evaluation: SessionEvaluation;
}

export interface VolumeEntry {
  muscleGroup: MuscleGroup;
  /** Working sets performed (completed or failed). */
  sets: number;
  /**
   * Sets taken close enough to failure to drive growth: within
   * RULES.hardSetMaxRir of it. A set with no RIR logged is counted as hard,
   * since the alternative is to silently discard most people's data.
   */
  hardSets: number;
  /** Distinct workouts that trained this muscle group. */
  sessions: number;
  exercises: number;
  level: VolumeLevel;
  /** Below RULES.weeklyFrequencyLow sessions per week. */
  lowFrequency: boolean;
}

export interface VolumeReport {
  /** Length of the window in weeks; all bands are scaled by it. */
  weeks: number;
  entries: VolumeEntry[];
  totalSets: number;
  totalHardSets: number;
}

const isHard = (rir: number | null) => rir === null || rir <= RULES.hardSetMaxRir;

function levelOf(hardSets: number, weeks: number): VolumeLevel {
  if (hardSets === 0) return 'none';
  if (hardSets < RULES.weeklySetsLow * weeks) return 'low';
  if (hardSets > RULES.weeklySetsHigh * weeks) return 'high';
  return 'in-band';
}

/**
 * Aggregate sessions into per-muscle-group volume, busiest first. `weeks`
 * scales the low/high bands so a 4-week window is judged against 4 weeks of
 * training rather than one.
 */
export function volumeReport(sessions: readonly VolumeSession[], weeks = 1): VolumeReport {
  const w = weeks > 0 ? weeks : 1;
  const acc = new Map<MuscleGroup, { sets: number; hardSets: number; workouts: Set<string>; exercises: Set<string> }>();

  for (const s of sessions) {
    const cur = acc.get(s.muscleGroup) ?? { sets: 0, hardSets: 0, workouts: new Set<string>(), exercises: new Set<string>() };
    let counted = 0;
    for (const set of s.evaluation.working) {
      counted++;
      if (isHard(set.rir)) cur.hardSets++;
    }
    if (counted > 0) {
      cur.sets += counted;
      cur.workouts.add(s.workoutSessionId);
      cur.exercises.add(s.exerciseId);
    }
    acc.set(s.muscleGroup, cur);
  }

  const entries: VolumeEntry[] = [...acc.entries()]
    .filter(([, v]) => v.sets > 0)
    .map(([muscleGroup, v]) => ({
      muscleGroup,
      sets: v.sets,
      hardSets: v.hardSets,
      sessions: v.workouts.size,
      exercises: v.exercises.size,
      level: levelOf(v.hardSets, w),
      lowFrequency: v.workouts.size > 0 && v.workouts.size < RULES.weeklyFrequencyLow * w,
    }))
    .sort((a, b) => b.hardSets - a.hardSets || a.muscleGroup.localeCompare(b.muscleGroup));

  return {
    weeks: w,
    entries,
    totalSets: entries.reduce((a, e) => a + e.sets, 0),
    totalHardSets: entries.reduce((a, e) => a + e.hardSets, 0),
  };
}

/** The weekly set band used for the low / in-band / high labels. */
export const VOLUME_BAND = Object.freeze({ low: RULES.weeklySetsLow, high: RULES.weeklySetsHigh });
