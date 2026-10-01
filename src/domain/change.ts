import { COLLECTIONS, type CollectionName, type Dataset, type UserSettings } from './types';

type RecordOf<K extends CollectionName> = Dataset[K][number];

/**
 * A unit of change produced by app services. Services never mutate data; they
 * describe the change, and the store persists it (one IndexedDB transaction)
 * before showing it.
 */
export interface Change {
  put: { [K in CollectionName]?: RecordOf<K>[] };
  remove: { [K in CollectionName]?: string[] };
  settings?: UserSettings;
}

export const emptyChange = (): Change => ({ put: {}, remove: {} });

export function isEmptyChange(c: Change): boolean {
  return !c.settings && COLLECTIONS.every((k) => !(c.put[k]?.length || c.remove[k]?.length));
}

export function putRecords<K extends CollectionName>(change: Change, key: K, records: RecordOf<K>[]): Change {
  const existing = (change.put[key] ?? []) as RecordOf<K>[];
  const byId = new Map<string, RecordOf<K>>(existing.map((r) => [r.id, r]));
  for (const r of records) byId.set(r.id, r);
  (change.put as Record<K, RecordOf<K>[]>)[key] = [...byId.values()];
  const removed = change.remove[key];
  if (removed) change.remove[key] = removed.filter((id) => !byId.has(id));
  return change;
}

export function removeRecords(change: Change, key: CollectionName, ids: string[]): Change {
  const set = new Set([...(change.remove[key] ?? []), ...ids]);
  change.remove[key] = [...set];
  const puts = change.put[key] as { id: string }[] | undefined;
  if (puts) (change.put as Record<string, { id: string }[]>)[key] = puts.filter((r) => !set.has(r.id));
  return change;
}

/** Combine changes in order (later wins). */
export function mergeChanges(...changes: Change[]): Change {
  const out = emptyChange();
  for (const c of changes) {
    for (const k of COLLECTIONS) {
      const rm = c.remove[k];
      if (rm?.length) removeRecords(out, k, rm);
      const put = c.put[k] as { id: string }[] | undefined;
      if (put?.length) putRecords(out, k, put as never);
    }
    if (c.settings) out.settings = c.settings;
  }
  return out;
}

/** Pure: returns a new dataset with the change applied. Unchanged collections keep identity. */
export function applyChange(ds: Dataset, change: Change): Dataset {
  const next: Dataset = { ...ds };
  for (const k of COLLECTIONS) {
    const put = change.put[k] as { id: string }[] | undefined;
    const rm = change.remove[k];
    if (!put?.length && !rm?.length) continue;
    const removed = new Set(rm ?? []);
    const puts = new Map((put ?? []).map((r) => [r.id, r]));
    const list = (ds[k] as { id: string }[]).filter((r) => !removed.has(r.id)).map((r) => (puts.has(r.id) ? (puts.get(r.id) as { id: string }) : r));
    const seen = new Set(list.map((r) => r.id));
    for (const [id, r] of puts) if (!seen.has(id)) list.push(r);
    (next as unknown as Record<string, unknown>)[k] = list;
  }
  if (change.settings) next.settings = change.settings;
  return next;
}

export function emptyDataset(settings: UserSettings): Dataset {
  return {
    settings,
    exercises: [],
    routines: [],
    routineDays: [],
    workoutSessions: [],
    exerciseSessions: [],
    recommendations: [],
    personalRecords: [],
    readiness: [],
    substitutions: [],
  };
}
