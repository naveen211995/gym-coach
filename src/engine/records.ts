import type { PersonalRecordType } from '../domain/types';
import { LOAD_EPS, type NormalizedSet, type SessionEvaluation } from './sessionEval';
import { roundTo } from './units';

export interface PrCandidate {
  type: PersonalRecordType;
  value: number;
  load: number | null;
  reps: number | null;
  previousValue: number | null;
}

export interface HistoricalBests {
  heaviestLoad: { load: number; reps: number; date: string } | null;
  bestE1rm: { value: number; load: number; reps: number; date: string } | null;
  bestVolume: { value: number; date: string } | null;
  longestHold: { seconds: number; date: string } | null;
  /** Best reps achieved at each distinct load, heaviest first. */
  repsAtLoad: { load: number; reps: number; date: string }[];
}

const performedSets = (ev: SessionEvaluation): NormalizedSet[] => [...ev.working, ...ev.extras];

export function computeBests(evals: readonly SessionEvaluation[], timeBased: boolean): HistoricalBests {
  const bests: HistoricalBests = { heaviestLoad: null, bestE1rm: null, bestVolume: null, longestHold: null, repsAtLoad: [] };
  const byLoad = new Map<number, { reps: number; date: string }>();
  for (const ev of evals) {
    for (const s of performedSets(ev)) {
      if (s.reps <= 0) continue;
      if (timeBased) {
        if (!bests.longestHold || s.reps > bests.longestHold.seconds) bests.longestHold = { seconds: s.reps, date: ev.completedAt };
      }
      if (!bests.heaviestLoad || s.load > bests.heaviestLoad.load + LOAD_EPS) bests.heaviestLoad = { load: s.load, reps: s.reps, date: ev.completedAt };
      if (!timeBased && s.e1rm > 0 && (!bests.bestE1rm || s.e1rm > bests.bestE1rm.value)) {
        bests.bestE1rm = { value: s.e1rm, load: s.load, reps: s.reps, date: ev.completedAt };
      }
      const key = roundTo(s.load, 3);
      const cur = byLoad.get(key);
      if (!cur || s.reps > cur.reps) byLoad.set(key, { reps: s.reps, date: ev.completedAt });
    }
    if (!timeBased && ev.volume > 0 && (!bests.bestVolume || ev.volume > bests.bestVolume.value)) bests.bestVolume = { value: ev.volume, date: ev.completedAt };
  }
  bests.repsAtLoad = [...byLoad.entries()].map(([load, v]) => ({ load, ...v })).sort((a, b) => b.load - a.load);
  return bests;
}

/**
 * Personal records set by `current` compared with everything in `prior`.
 * The first session of an exercise is a baseline, not a PR.
 */
export function detectPersonalRecords(prior: readonly SessionEvaluation[], current: SessionEvaluation, timeBased: boolean): PrCandidate[] {
  const priorSets = prior.flatMap(performedSets).filter((s) => s.reps > 0);
  const curSets = performedSets(current).filter((s) => s.reps > 0);
  if (priorSets.length === 0 || curSets.length === 0) return [];
  const out: PrCandidate[] = [];

  if (timeBased) {
    const prevBest = Math.max(...priorSets.map((s) => s.reps));
    const best = curSets.reduce((a, s) => (s.reps > a.reps ? s : a));
    if (best.reps > prevBest) out.push({ type: 'longest-hold', value: best.reps, load: best.load, reps: best.reps, previousValue: prevBest });
    return out;
  }

  const prevHeaviest = Math.max(...priorSets.map((s) => s.load));
  const heaviest = curSets.reduce((a, s) => (s.load > a.load || (s.load === a.load && s.reps > a.reps) ? s : a));
  if (heaviest.load > prevHeaviest + LOAD_EPS && heaviest.load > 0) {
    out.push({ type: 'heaviest-load', value: heaviest.load, load: heaviest.load, reps: heaviest.reps, previousValue: prevHeaviest });
  }

  // Reps at load: more reps than ever before at this load OR any heavier load.
  let bestRepPr: PrCandidate | null = null;
  for (const s of curSets) {
    const comparable = priorSets.filter((p) => p.load >= s.load - LOAD_EPS);
    if (comparable.length === 0) continue; // new territory is covered by heaviest-load
    const prevMax = Math.max(...comparable.map((p) => p.reps));
    if (s.reps > prevMax) {
      const gain = s.reps - prevMax;
      if (!bestRepPr || s.load > (bestRepPr.load ?? 0) || (s.load === bestRepPr.load && gain > (bestRepPr.value - (bestRepPr.previousValue ?? 0)))) {
        bestRepPr = { type: 'reps-at-load', value: s.reps, load: s.load, reps: s.reps, previousValue: prevMax };
      }
    }
  }
  if (bestRepPr) out.push(bestRepPr);

  const prevE1rm = Math.max(0, ...priorSets.map((s) => s.e1rm));
  const bestSet = curSets.reduce((a, s) => (s.e1rm > a.e1rm ? s : a));
  if (bestSet.e1rm > prevE1rm + 0.01 && prevE1rm > 0) {
    out.push({ type: 'estimated-1rm', value: bestSet.e1rm, load: bestSet.load, reps: bestSet.reps, previousValue: prevE1rm });
  }

  const prevVolume = Math.max(0, ...prior.map((e) => e.volume));
  if (current.volume > prevVolume + 0.01 && prevVolume > 0) {
    out.push({ type: 'session-volume', value: current.volume, load: null, reps: null, previousValue: prevVolume });
  }
  return out;
}

export interface SeriesPoint {
  sessionId: string;
  date: string;
  e1rm: number;
  topLoad: number;
  volume: number;
  totalReps: number;
}

export function buildSeries(evals: readonly SessionEvaluation[]): SeriesPoint[] {
  return evals
    .filter((e) => e.working.length > 0)
    .map((e) => ({
      sessionId: e.sessionId,
      date: e.completedAt,
      e1rm: e.bestE1rm,
      topLoad: Math.max(...[...e.working, ...e.extras].map((s) => s.load)),
      volume: e.volume,
      totalReps: e.totalReps,
    }));
}

export const PR_LABELS: Readonly<Record<PersonalRecordType, string>> = {
  'heaviest-load': 'Heaviest load',
  'reps-at-load': 'Most reps at this load',
  'estimated-1rm': 'Best estimated 1RM',
  'session-volume': 'Best session volume',
  'longest-hold': 'Longest hold',
};
