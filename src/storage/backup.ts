/**
 * Backup formats.
 *  - JSON: the full dataset with an app id and schema version for migrations.
 *  - CSV: one row per logged set, for spreadsheets. Export only.
 *
 * Import never trusts the file: records are validated one by one, orphans are
 * dropped, and the user chooses between merging (keep local on conflict) and
 * replacing everything (explicit confirmation in the UI).
 */
import { defaultSettings } from '../domain/defaults';
import { emptyDataset } from '../domain/change';
import { COLLECTIONS, type CollectionName, type Dataset, type ExerciseSession } from '../domain/types';
import { validators } from './schema';

export const BACKUP_APP_ID = 'gym-progression-coach';
export const SCHEMA_VERSION = 1;

export interface BackupFile {
  app: typeof BACKUP_APP_ID;
  schemaVersion: number;
  exportedAt: string;
  data: Dataset;
}

export function serializeBackup(ds: Dataset, exportedAt: string): string {
  const file: BackupFile = { app: BACKUP_APP_ID, schemaVersion: SCHEMA_VERSION, exportedAt, data: ds };
  return JSON.stringify(file, null, 2);
}

/**
 * Migrations from version N to N+1. Version 1 is the first format, so the
 * registry is empty; add `2: (data) => …` when the model changes.
 */
export const MIGRATIONS: Record<number, (data: Record<string, unknown>) => Record<string, unknown>> = {};

export type Counts = Record<CollectionName, number>;
const zeroCounts = (): Counts => Object.fromEntries(COLLECTIONS.map((c) => [c, 0])) as Counts;

export type ParseResult =
  | { ok: true; dataset: Dataset; exportedAt: string | null; schemaVersion: number; counts: Counts; warnings: string[] }
  | { ok: false; error: string };

const MAX_WARNINGS = 12;

export function parseBackup(text: string, nowIso: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'This is not valid JSON.' };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, error: 'The file does not contain a backup object.' };
  const file = raw as Record<string, unknown>;
  if (file.app !== BACKUP_APP_ID) return { ok: false, error: 'This file is not a Gym Progression Coach backup.' };
  const version = file.schemaVersion;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return { ok: false, error: 'The backup has no valid schema version.' };
  if (version > SCHEMA_VERSION) return { ok: false, error: `This backup was made by a newer version of the app (schema ${version}; this app reads up to ${SCHEMA_VERSION}).` };
  if (typeof file.data !== 'object' || file.data === null) return { ok: false, error: 'The backup has no data section.' };

  let data = file.data as Record<string, unknown>;
  for (let v = version; v < SCHEMA_VERSION; v++) {
    const m = MIGRATIONS[v + 1];
    if (!m) return { ok: false, error: `No migration from schema ${v} to ${v + 1}.` };
    data = m(data);
  }

  const warnings: string[] = [];
  let dropped = 0;
  const warn = (msg: string) => {
    dropped++;
    if (warnings.length < MAX_WARNINGS) warnings.push(msg);
  };

  let settings = defaultSettings(nowIso);
  const settingsErr = validators.settings(data.settings);
  if (settingsErr) warnings.push(`Settings were invalid (${settingsErr}) and were reset to defaults.`);
  else settings = { ...(data.settings as Dataset['settings']) };

  const ds = emptyDataset(settings);
  const counts = zeroCounts();
  for (const c of COLLECTIONS) {
    const list = data[c];
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      warn(`"${c}" is not a list and was skipped.`);
      continue;
    }
    const seen = new Set<string>();
    for (const [i, rec] of list.entries()) {
      const err = validators[c](rec);
      if (err) {
        warn(`${c}[${i}]: ${err}; skipped.`);
        continue;
      }
      const id = (rec as { id: string }).id;
      if (seen.has(id)) {
        warn(`${c}[${i}]: duplicate id "${id}"; skipped.`);
        continue;
      }
      seen.add(id);
      (ds[c] as unknown[]).push(rec);
    }
  }

  // Referential integrity: drop records whose parents are missing.
  const exIds = new Set(ds.exercises.map((e) => e.id));
  const wsIds = new Set(ds.workoutSessions.map((w) => w.id));
  const keep = <K extends CollectionName>(c: K, pred: (r: Dataset[K][number]) => boolean, why: string) => {
    const before = ds[c].length;
    (ds as unknown as Record<string, unknown>)[c] = (ds[c] as Dataset[K][number][]).filter(pred);
    const n = before - ds[c].length;
    if (n > 0) warn(`${n} ${c} record(s) dropped: ${why}.`);
  };
  keep('exerciseSessions', (s) => wsIds.has(s.workoutSessionId) && exIds.has(s.exerciseId), 'missing workout or exercise');
  const esIds = new Set(ds.exerciseSessions.map((s) => s.id));
  keep('recommendations', (r) => exIds.has(r.exerciseId), 'missing exercise');
  keep('personalRecords', (r) => exIds.has(r.exerciseId) && esIds.has(r.exerciseSessionId), 'missing exercise session');
  keep('readiness', (r) => wsIds.has(r.workoutSessionId), 'missing workout');
  keep('substitutions', (r) => wsIds.has(r.workoutSessionId), 'missing workout');
  keep('routineDays', (d) => ds.routines.some((r) => r.id === d.routineId), 'missing routine');
  // Days may reference archived/deleted exercises; drop only unknown ids from the list.
  ds.routineDays = ds.routineDays.map((d) => ({ ...d, exerciseIds: d.exerciseIds.filter((id) => exIds.has(id)) }));
  const dayIds = new Set(ds.routineDays.map((d) => d.id));
  ds.routines = ds.routines.map((r) => ({ ...r, dayIds: r.dayIds.filter((id) => dayIds.has(id)) }));

  // At most one in-progress workout.
  const inProgress = ds.workoutSessions.filter((w) => w.status === 'in-progress').sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  if (inProgress.length > 1) {
    const extra = new Set(inProgress.slice(1).map((w) => w.id));
    ds.workoutSessions = ds.workoutSessions.filter((w) => !extra.has(w.id));
    ds.exerciseSessions = ds.exerciseSessions.filter((s) => !extra.has(s.workoutSessionId));
    warn(`${extra.size} extra in-progress workout(s) dropped; only one can be active.`);
  }
  if (ds.settings.activeRoutineId && !ds.routines.some((r) => r.id === ds.settings.activeRoutineId)) ds.settings = { ...ds.settings, activeRoutineId: ds.routines[0]?.id ?? null };

  for (const c of COLLECTIONS) counts[c] = ds[c].length;
  if (dropped > warnings.length) warnings.push(`…and ${dropped - warnings.length} more issue(s).`);
  return { ok: true, dataset: ds, exportedAt: typeof file.exportedAt === 'string' ? file.exportedAt : null, schemaVersion: version, counts, warnings };
}

export interface MergeResult {
  dataset: Dataset;
  added: Counts;
  kept: Counts;
  notes: string[];
}

/** Add records the local dataset doesn't have; on id conflicts the local record wins. Local settings are kept. */
export function mergeDatasets(local: Dataset, incoming: Dataset): MergeResult {
  const added = zeroCounts();
  const kept = zeroCounts();
  const notes: string[] = [];
  const out: Dataset = { ...local };
  const localActive = local.workoutSessions.some((w) => w.status === 'in-progress');
  const skippedWorkouts = new Set<string>();
  for (const c of COLLECTIONS) {
    const ids = new Set((local[c] as { id: string }[]).map((r) => r.id));
    const list = [...(local[c] as { id: string }[])];
    for (const r of incoming[c] as { id: string }[]) {
      if (ids.has(r.id)) {
        kept[c]++;
        continue;
      }
      if (c === 'workoutSessions' && localActive && (r as Dataset['workoutSessions'][number]).status === 'in-progress') {
        skippedWorkouts.add(r.id);
        continue;
      }
      if ((c === 'exerciseSessions' || c === 'readiness' || c === 'substitutions') && skippedWorkouts.has((r as unknown as { workoutSessionId: string }).workoutSessionId)) continue;
      list.push(r);
      ids.add(r.id);
      added[c]++;
    }
    (out as unknown as Record<string, unknown>)[c] = list;
  }
  if (skippedWorkouts.size) notes.push('The backup’s in-progress workout was not imported because one is already active here.');
  if (!local.settings.activeRoutineId && incoming.settings.activeRoutineId && out.routines.some((r) => r.id === incoming.settings.activeRoutineId)) {
    out.settings = { ...local.settings, activeRoutineId: incoming.settings.activeRoutineId };
  }
  return { dataset: out, added, kept, notes };
}

// ───────────────────────── CSV ─────────────────────────

const FORMULA_START = /^[=+\-@\t\r]/;

/** RFC 4180 escaping, plus a leading apostrophe on text that a spreadsheet would treat as a formula. */
export function csvCell(v: string | number | null | undefined, isText = true): string {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (isText && FORMULA_START.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const CSV_HEADER = [
  'date',
  'workout',
  'exercise',
  'muscle_group',
  'exercise_status',
  'set_number',
  'set_status',
  'load',
  'unit',
  'reps_or_seconds',
  'rir',
  'rir_confidence',
  'set_note',
  'pain',
  'exercise_note',
  'prescribed',
  'next_recommendation',
  'rule',
];

export function toCsv(ds: Dataset): string {
  const workouts = new Map(ds.workoutSessions.map((w) => [w.id, w]));
  const exercises = new Map(ds.exercises.map((e) => [e.id, e]));
  const recBySession = new Map(ds.recommendations.filter((r) => r.basedOnExerciseSessionId).map((r) => [r.basedOnExerciseSessionId as string, r]));
  const sessions = [...ds.exerciseSessions].filter((s) => workouts.has(s.workoutSessionId));
  const dateOf = (s: ExerciseSession) => s.completedAt ?? workouts.get(s.workoutSessionId)?.startedAt ?? '';
  sessions.sort((a, b) => dateOf(a).localeCompare(dateOf(b)) || a.order - b.order);
  const rows = [CSV_HEADER.join(',')];
  for (const s of sessions) {
    const w = workouts.get(s.workoutSessionId);
    const ex = exercises.get(s.exerciseId);
    const rec = recBySession.get(s.id);
    const sets = [...s.sets].sort((a, b) => a.index - b.index);
    for (const set of sets) {
      rows.push(
        [
          csvCell(dateOf(s).slice(0, 10)),
          csvCell(w?.name ?? ''),
          csvCell(ex?.name ?? s.exerciseId),
          csvCell(ex?.muscleGroup ?? ''),
          csvCell(s.status),
          csvCell(set.index + 1, false),
          csvCell(set.status),
          csvCell(set.load, false),
          csvCell(set.unit),
          csvCell(set.reps, false),
          csvCell(set.rir, false),
          csvCell(set.rirConfidence, false),
          csvCell(set.note),
          csvCell(s.pain),
          csvCell(s.note),
          csvCell(s.prescribed.summary),
          csvCell(rec?.summary ?? ''),
          csvCell(rec?.ruleId ?? ''),
        ].join(','),
      );
    }
  }
  return rows.join('\r\n') + '\r\n';
}
