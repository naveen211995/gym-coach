/**
 * Persistence. IndexedDB is the source of truth; every Change is written in a
 * single readwrite transaction across all touched stores, so a workout update
 * is either fully saved or not saved at all.
 *
 * If IndexedDB is unavailable (private mode in some browsers, sandboxing), a
 * memory repository is used and the UI shows a warning that data won't persist.
 */
import { applyChange, emptyDataset, type Change } from '../domain/change';
import { defaultSettings } from '../domain/defaults';
import { COLLECTIONS, type CollectionName, type Dataset, type UserSettings } from '../domain/types';

export const DB_NAME = 'gym-progression-coach';
export const DB_VERSION = 1;
const SETTINGS_STORE = 'settings';
const META_STORE = 'meta';

export interface Repository {
  readonly kind: 'indexeddb' | 'memory';
  /** null when nothing has been saved yet (first run). */
  loadAll(): Promise<Dataset | null>;
  apply(change: Change): Promise<void>;
  replaceAll(ds: Dataset): Promise<void>;
  clearAll(): Promise<void>;
}

const req = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'));
  });

const txDone = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      for (const name of COLLECTIONS) if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(SETTINGS_STORE)) db.createObjectStore(SETTINGS_STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE, { keyPath: 'key' });
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error ?? new Error('Could not open IndexedDB'));
    open.onblocked = () => reject(new Error('IndexedDB is blocked by another open tab'));
  });
}

class IndexedDbRepository implements Repository {
  readonly kind = 'indexeddb' as const;
  constructor(private readonly db: IDBDatabase) {}

  async loadAll(): Promise<Dataset | null> {
    const stores = [...COLLECTIONS, SETTINGS_STORE];
    const tx = this.db.transaction(stores, 'readonly');
    const settings = (await req(tx.objectStore(SETTINGS_STORE).get('user'))) as UserSettings | undefined;
    const lists = await Promise.all(COLLECTIONS.map((c) => req(tx.objectStore(c).getAll())));
    if (!settings) return null;
    const ds = emptyDataset(settings);
    COLLECTIONS.forEach((c, i) => ((ds as unknown as Record<string, unknown>)[c] = lists[i]));
    return ds;
  }

  async apply(change: Change): Promise<void> {
    const touched = COLLECTIONS.filter((c) => change.put[c]?.length || change.remove[c]?.length);
    const stores: string[] = [...touched, META_STORE];
    if (change.settings) stores.push(SETTINGS_STORE);
    const tx = this.db.transaction(stores, 'readwrite');
    const done = txDone(tx);
    for (const c of touched) {
      const store = tx.objectStore(c);
      for (const id of change.remove[c] ?? []) store.delete(id);
      for (const r of (change.put[c] ?? []) as unknown[]) store.put(r);
    }
    if (change.settings) tx.objectStore(SETTINGS_STORE).put(change.settings);
    tx.objectStore(META_STORE).put({ key: 'lastWriteAt', value: new Date().toISOString() });
    await done;
  }

  async replaceAll(ds: Dataset): Promise<void> {
    const tx = this.db.transaction([...COLLECTIONS, SETTINGS_STORE, META_STORE], 'readwrite');
    const done = txDone(tx);
    for (const c of COLLECTIONS) {
      const store = tx.objectStore(c);
      store.clear();
      for (const r of ds[c] as unknown[]) store.put(r);
    }
    tx.objectStore(SETTINGS_STORE).put(ds.settings);
    tx.objectStore(META_STORE).put({ key: 'lastWriteAt', value: new Date().toISOString() });
    await done;
  }

  async clearAll(): Promise<void> {
    const tx = this.db.transaction([...COLLECTIONS, SETTINGS_STORE, META_STORE], 'readwrite');
    const done = txDone(tx);
    for (const name of [...COLLECTIONS, SETTINGS_STORE, META_STORE]) tx.objectStore(name).clear();
    await done;
  }
}

export class MemoryRepository implements Repository {
  readonly kind = 'memory' as const;
  private ds: Dataset | null = null;
  async loadAll() {
    return this.ds ? structuredCloneSafe(this.ds) : null;
  }
  async apply(change: Change) {
    const base = this.ds ?? emptyDataset(change.settings ?? defaultSettings(new Date().toISOString()));
    this.ds = applyChange(base, structuredCloneSafe(change));
  }
  async replaceAll(ds: Dataset) {
    this.ds = structuredCloneSafe(ds);
  }
  async clearAll() {
    this.ds = null;
  }
}

function structuredCloneSafe<T>(v: T): T {
  return typeof structuredClone === 'function' ? structuredClone(v) : (JSON.parse(JSON.stringify(v)) as T);
}

export async function openRepository(): Promise<{ repo: Repository; warning: string | null }> {
  try {
    if (typeof indexedDB === 'undefined') throw new Error('IndexedDB is not available in this browser.');
    const db = await openDb();
    return { repo: new IndexedDbRepository(db), warning: null };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { repo: new MemoryRepository(), warning: `Local storage is unavailable (${msg}). Your data will be lost when this page closes. Export a backup before leaving.` };
  }
}

export type { CollectionName };
