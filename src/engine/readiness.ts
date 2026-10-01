import type { NextTarget, ProgressionConfig, ReadinessRecord, RecommendationAction } from '../domain/types';
import { clampInt, mean } from './metrics';
import { roundTo } from './units';

export type ReadinessLevel = 'unknown' | 'normal' | 'caution' | 'poor';

export interface ReadinessAssessment {
  level: ReadinessLevel;
  score: number | null;
  reasons: string[];
}

const valid15 = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 1 && n <= 5;

/**
 * Combine the optional check-in into one conservative level.
 * score = mean(readiness, energy, 6 − fatigue) minus a sleep penalty.
 */
export function assessReadiness(r: ReadinessRecord | null | undefined): ReadinessAssessment {
  if (!r) return { level: 'unknown', score: null, reasons: [] };
  const reasons: string[] = [];
  const parts: number[] = [];
  if (valid15(r.readiness)) parts.push(r.readiness);
  if (valid15(r.energy)) parts.push(r.energy);
  if (valid15(r.fatigue)) parts.push(6 - r.fatigue);
  let score = mean(parts);
  const sleep = typeof r.sleepHours === 'number' && Number.isFinite(r.sleepHours) && r.sleepHours >= 0 && r.sleepHours <= 24 ? r.sleepHours : null;
  if (sleep !== null) {
    if (score === null) score = 3;
    if (sleep < 5) {
      score -= 1;
      reasons.push(`Short sleep (${sleep} h).`);
    } else if (sleep < 6) {
      score -= 0.5;
      reasons.push(`Below-average sleep (${sleep} h).`);
    }
  }
  if (score === null && !r.pain) return { level: 'unknown', score: null, reasons: [] };

  let level: ReadinessLevel = score === null ? 'normal' : score <= 1.75 ? 'poor' : score <= 2.75 ? 'caution' : 'normal';
  if (score !== null && level !== 'normal') reasons.unshift(`Readiness score ${roundTo(score, 1)}/5.`);
  if (r.pain) {
    reasons.push('General pain reported today.');
    if (level === 'normal') level = 'caution';
  }
  return { level, score: score === null ? null : roundTo(score, 2), reasons };
}

export function isLowReadiness(r: ReadinessRecord | null | undefined): boolean {
  const a = assessReadiness(r);
  return a.level === 'caution' || a.level === 'poor';
}

export interface ReadinessAdjustment {
  target: NextTarget;
  adjusted: boolean;
  notes: string[];
}

/**
 * Adjust TODAY's target only. The stored recommendation (the progression
 * baseline) is never modified; next session is derived from what was actually done.
 */
export function applyReadiness(
  baseline: NextTarget,
  context: { action: RecommendationAction; previous: { load: number | null; reps: number[] } | null },
  assessment: ReadinessAssessment,
  cfg: ProgressionConfig,
): ReadinessAdjustment {
  if (assessment.level === 'normal' || assessment.level === 'unknown') {
    return { target: baseline, adjusted: false, notes: [] };
  }
  const target: NextTarget = { ...baseline, repTargets: [...baseline.repTargets] };
  const notes: string[] = [];
  const prev = context.previous;
  const repeatPrevReps = () => {
    if (!prev || prev.reps.length === 0) return target.repTargets;
    return target.repTargets.map((_, i) => clampInt(prev.reps[i] ?? prev.reps[prev.reps.length - 1] ?? cfg.minReps, cfg.minReps, cfg.maxReps));
  };

  if (context.action === 'increase-load' && prev && prev.load !== null && baseline.load !== null && baseline.load > prev.load) {
    target.load = prev.load;
    target.repTargets = repeatPrevReps();
    notes.push('Load increase postponed today; it will be offered again next session.');
  } else if (context.action === 'increase-reps') {
    target.repTargets = repeatPrevReps();
    notes.push('No rep push today: match last session.');
  } else {
    notes.push("Stop at the target RIR; don't chase extra reps today.");
  }

  if (assessment.level === 'poor') {
    if (target.sets > 1) {
      target.sets -= 1;
      target.repTargets = target.repTargets.slice(0, target.sets);
      notes.push('One fewer working set today.');
    }
    target.targetRir = Math.min(5, target.targetRir + 1);
    notes.push(`Leave an extra rep in reserve (RIR ${target.targetRir}).`);
  }
  return { target, adjusted: true, notes: [...assessment.reasons, ...notes] };
}
