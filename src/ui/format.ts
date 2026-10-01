import type { Exercise, NextTarget, ProgressionStrategy, RecommendationAction, SetPerformance } from '../domain/types';
import { formatLoad, formatNumber } from '../engine';

export type Tone = 'load' | 'reps' | 'hold' | 'warn' | 'pain' | 'base';

/** Plain-language explainer for each strategy, shown in the exercise editor's help sheet. */
export const STRATEGY_HELP: Readonly<Record<ProgressionStrategy, { plain: string; bestFor: string }>> = {
  double: {
    plain: 'Add reps each session until every set hits the top of your rep range, then add weight and drop back to the bottom of the range.',
    bestFor: 'Most exercises.',
  },
  'load-first': {
    plain: 'Add weight as soon as every set hits the bottom of your rep range, rather than waiting to build up reps first.',
    bestFor: 'Heavy compound lifts (squat, bench, deadlift).',
  },
  'rep-first': {
    plain: 'You must hit the top of the rep range on every set for two workouts in a row before weight goes up.',
    bestFor: 'Isolation exercises (curls, lateral raises).',
  },
  'time-based': {
    plain: 'For holds: add seconds each session. Once you hit the max hold time, add weight or make it harder another way instead of holding longer.',
    bestFor: 'Planks, dead hangs, wall sits.',
  },
};

export const ACTION_META: Record<RecommendationAction, { label: string; tone: Tone; icon: 'up' | 'down' | 'same' | 'plus' | 'flag' | 'start' }> = {
  'establish-baseline': { label: 'Set a baseline', tone: 'base', icon: 'start' },
  'increase-load': { label: 'Increase load', tone: 'load', icon: 'up' },
  'increase-reps': { label: 'Add reps', tone: 'reps', icon: 'plus' },
  maintain: { label: 'Repeat', tone: 'hold', icon: 'same' },
  'decrease-load': { label: 'Reduce load', tone: 'warn', icon: 'down' },
  deload: { label: 'Deload', tone: 'warn', icon: 'down' },
  review: { label: 'Review', tone: 'pain', icon: 'flag' },
};

export const isTimeBased = (e: Pick<Exercise, 'progression'>) => e.progression.strategy === 'time-based';
export const isBodyweight = (e: Pick<Exercise, 'equipment' | 'progression'>) => e.equipment === 'bodyweight' || isTimeBased(e);

export const loadText = (load: number | null, unit: Exercise['unit']) => formatLoad(load, unit);

export function repsText(reps: readonly number[], timeBased: boolean): string {
  if (reps.length === 0) return '—';
  const same = reps.every((r) => r === reps[0]);
  const body = same && reps.length > 1 ? `${reps.length} × ${reps[0]}` : reps.join(' / ');
  return timeBased ? `${body} s` : body;
}

export function targetText(t: NextTarget, timeBased: boolean): string {
  return `${loadText(t.load, t.unit)}, ${repsText(t.repTargets, timeBased)}${timeBased ? '' : ` @ RIR ${formatNumber(t.targetRir)}`}`;
}

export function setText(s: SetPerformance, timeBased: boolean): string {
  if (s.status === 'skipped') return 'Skipped';
  if (s.status === 'pending') return '—';
  const load = s.load === null || s.load === 0 ? (timeBased ? '' : 'BW') : `${formatNumber(s.load)}`;
  const reps = timeBased ? `${s.reps ?? 0} s` : `${s.reps ?? 0}`;
  const main = load ? `${load} × ${reps}` : reps;
  const rir = s.rir !== null && !timeBased ? ` @${formatNumber(s.rir)}` : '';
  return `${main}${rir}${s.status === 'failed' ? ' (failed)' : ''}`;
}

export function performanceText(sets: readonly SetPerformance[], exercise: Exercise): string {
  const done = [...sets].filter((s) => s.status === 'completed' || s.status === 'failed').sort((a, b) => a.index - b.index);
  if (done.length === 0) return 'Nothing logged';
  const tb = isTimeBased(exercise);
  const loads = new Set(done.map((s) => s.load ?? 0));
  if (loads.size === 1) {
    const l = done[0]?.load ?? 0;
    return `${l ? `${formatNumber(l)} ${exercise.unit}` : tb ? '' : 'Bodyweight'}${l || !tb ? ' × ' : ''}${done.map((s) => s.reps).join(' / ')}${tb ? ' s' : ''}`;
  }
  return done.map((s) => setText(s, tb)).join(', ');
}

const DAY = 86400000;
export function dayLabel(iso: string | null, now = new Date()): string {
  if (!iso) return '';
  const d = new Date(iso);
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(now) - start(d)) / DAY);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff > 1 && diff < 7) return `${diff} days ago`;
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

export const dateLabel = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) : '');
export const shortDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

export function durationText(fromIso: string, toIso: string): string {
  const mins = Math.max(0, Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 60000));
  return mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)} h ${mins % 60} min`;
}

export function volumeText(v: { lb: number; kg: number; plt: number }): string {
  const parts: string[] = [];
  if (v.lb) parts.push(`${Math.round(v.lb).toLocaleString()} lb`);
  if (v.kg) parts.push(`${Math.round(v.kg).toLocaleString()} kg`);
  if (v.plt) parts.push(`${Math.round(v.plt).toLocaleString()} plt`);
  return parts.join(' + ') || '0';
}

export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
