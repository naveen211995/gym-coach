import type { ProgressionConfig } from '../domain/types';

export interface ValidationIssue {
  field: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationIssue[];
}

const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n);
const isNum = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/** Validate a progression config. Used by the engine (defensively) and by the exercise editor. */
export function validateProgressionConfig(c: ProgressionConfig): ValidationResult {
  const errors: ValidationIssue[] = [];
  const add = (field: string, message: string) => errors.push({ field, message });
  const timeBased = c.strategy === 'time-based';
  const repCap = timeBased ? 3600 : 100;
  const repWord = timeBased ? 'seconds' : 'reps';

  if (!isInt(c.workingSets) || c.workingSets < 1 || c.workingSets > 10) add('workingSets', 'Working sets must be a whole number from 1 to 10.');
  if (!isInt(c.minReps) || c.minReps < 1 || c.minReps > repCap) add('minReps', `Minimum ${repWord} must be a whole number from 1 to ${repCap}.`);
  if (!isInt(c.maxReps) || c.maxReps < 1 || c.maxReps > repCap) add('maxReps', `Maximum ${repWord} must be a whole number from 1 to ${repCap}.`);
  if (isInt(c.minReps) && isInt(c.maxReps) && c.maxReps < c.minReps) add('maxReps', `Maximum ${repWord} can't be lower than the minimum.`);
  if (!isNum(c.targetRir) || c.targetRir < 0 || c.targetRir > 5) add('targetRir', 'Target RIR must be between 0 and 5.');
  if (!isNum(c.loadIncrement) || c.loadIncrement < 0 || c.loadIncrement > 100) add('loadIncrement', 'Load increment must be between 0 and 100.');
  for (const key of ['minLoad', 'maxLoad', 'startingLoad'] as const) {
    const v = c[key];
    if (v !== null && (!isNum(v) || v < 0 || v > 5000)) add(key, 'Load must be empty or a number from 0 to 5000.');
  }
  if (isNum(c.minLoad) && isNum(c.maxLoad) && c.minLoad > c.maxLoad) add('maxLoad', "Maximum load can't be lower than the minimum load.");
  if (isNum(c.startingLoad)) {
    if (isNum(c.minLoad) && c.startingLoad < c.minLoad) add('startingLoad', 'Starting load is below the minimum load.');
    if (isNum(c.maxLoad) && c.startingLoad > c.maxLoad) add('startingLoad', 'Starting load is above the maximum load.');
  }
  if (!['double', 'load-first', 'rep-first', 'time-based'].includes(c.strategy)) add('strategy', 'Unknown progression strategy.');
  if (!['reduce-load', 'reduce-sets', 'none'].includes(c.deloadStrategy)) add('deloadStrategy', 'Unknown deload strategy.');
  if (!isNum(c.deloadPercent) || c.deloadPercent < 1 || c.deloadPercent > 50) add('deloadPercent', 'Deload percentage must be between 1 and 50.');
  if (!isInt(c.stallSessionsBeforeDeload) || c.stallSessionsBeforeDeload < 2 || c.stallSessionsBeforeDeload > 10) add('stallSessionsBeforeDeload', 'Stall sessions must be a whole number from 2 to 10.');
  if (timeBased && (!isInt(c.timeIncrementSeconds) || c.timeIncrementSeconds < 1 || c.timeIncrementSeconds > 120)) add('timeIncrementSeconds', 'Time increment must be 1–120 seconds.');

  return { ok: errors.length === 0, errors };
}

/** Validate a single numeric set entry from the UI. Returns an error message or null. */
export function validateSetEntry(entry: { load: number | null; reps: number | null; rir: number | null; bodyweight: boolean; timeBased: boolean }): string | null {
  const { load, reps, rir } = entry;
  if (load === null && !entry.bodyweight) return 'Enter the weight you used.';
  if (load !== null && (!Number.isFinite(load) || load < 0 || load > 5000)) return 'Weight must be between 0 and 5000.';
  const cap = entry.timeBased ? 3600 : 100;
  if (reps === null) return entry.timeBased ? 'Enter the seconds you held.' : 'Enter the reps you did.';
  if (!Number.isInteger(reps) || reps < 0 || reps > cap) return entry.timeBased ? `Seconds must be a whole number from 0 to ${cap}.` : `Reps must be a whole number from 0 to ${cap}.`;
  if (rir !== null && (!Number.isFinite(rir) || rir < 0 || rir > 10)) return 'RIR must be between 0 and 10.';
  return null;
}
