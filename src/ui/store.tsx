/**
 * App state. The dataset lives in memory for rendering; IndexedDB is the source
 * of truth. Every action is persisted FIRST and only then shown (persist-first),
 * and actions run through a queue so each one sees the latest data.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { buildSeedDataset } from '../app/seed';
import { ServiceError, type Ctx } from '../app/services';
import { applyChange, isEmptyChange, type Change } from '../domain/change';
import type { Dataset } from '../domain/types';
import { openRepository, type Repository } from '../storage/db';
import { newId, nowIso } from './platform';

export interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'error' | 'success';
}

interface StoreValue {
  ds: Dataset;
  storage: Repository['kind'];
  warning: string | null;
  run: <T extends { change: Change }>(make: (ds: Dataset, ctx: Ctx) => T) => Promise<T | null>;
  commit: (make: (ds: Dataset, ctx: Ctx) => Change) => Promise<boolean>;
  replaceAll: (ds: Dataset) => Promise<boolean>;
  notify: (text: string, tone?: Toast['tone']) => void;
  toasts: Toast[];
  dismiss: (id: number) => void;
}

const StoreContext = createContext<StoreValue | null>(null);

export function useStore(): StoreValue {
  const v = useContext(StoreContext);
  if (!v) throw new Error('useStore outside provider');
  return v;
}

export const DEMO_MARK = 'demo';
export const makeCtx = (): Ctx => ({ now: nowIso(), newId });
export const buildDemo = () => {
  let n = 0;
  return buildSeedDataset(new Date(), (p) => `${p}_${DEMO_MARK}${(++n).toString(36)}`);
};
export const isDemoData = (ds: Dataset) => ds.workoutSessions.some((w) => w.id.includes(`_${DEMO_MARK}`));

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<{ ds: Dataset; repo: Repository; warning: string | null } | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dsRef = useRef<Dataset | null>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const toastId = useRef(0);

  const notify = useCallback((text: string, tone: Toast['tone'] = 'info') => {
    const id = ++toastId.current;
    setToasts((t) => [...t.slice(-2), { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 6000 : 3500);
  }, []);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { repo, warning } = await openRepository();
        let ds = await repo.loadAll();
        if (!ds) {
          ds = buildDemo();
          await repo.replaceAll(ds);
        }
        if (!alive) return;
        dsRef.current = ds;
        setState({ ds, repo, warning });
      } catch (e) {
        setBootError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const repo = state?.repo ?? null;

  const run = useCallback(
    <T extends { change: Change }>(make: (ds: Dataset, ctx: Ctx) => T): Promise<T | null> =>
      new Promise<T | null>((resolve) => {
        queue.current = queue.current.then(async () => {
          const cur = dsRef.current;
          if (!cur || !repo) return resolve(null);
          let result: T;
          try {
            result = make(cur, makeCtx());
          } catch (e) {
            notify(e instanceof ServiceError ? e.message : `Something went wrong: ${e instanceof Error ? e.message : String(e)}`, 'error');
            return resolve(null);
          }
          if (isEmptyChange(result.change)) return resolve(result);
          try {
            await repo.apply(result.change);
          } catch (e) {
            notify(`Not saved: ${e instanceof Error ? e.message : String(e)}`, 'error');
            return resolve(null);
          }
          const next = applyChange(cur, result.change);
          dsRef.current = next;
          setState((s) => (s ? { ...s, ds: next } : s));
          resolve(result);
        });
      }),
    [repo, notify],
  );

  const commit = useCallback((make: (ds: Dataset, ctx: Ctx) => Change) => run((ds, ctx) => ({ change: make(ds, ctx) })).then((r) => r !== null), [run]);

  const replaceAll = useCallback(
    (ds: Dataset) =>
      new Promise<boolean>((resolve) => {
        queue.current = queue.current.then(async () => {
          if (!repo) return resolve(false);
          try {
            await repo.replaceAll(ds);
            dsRef.current = ds;
            setState((s) => (s ? { ...s, ds } : s));
            resolve(true);
          } catch (e) {
            notify(`Not saved: ${e instanceof Error ? e.message : String(e)}`, 'error');
            resolve(false);
          }
        });
      }),
    [repo, notify],
  );

  const value = useMemo<StoreValue | null>(
    () => (state ? { ds: state.ds, storage: state.repo.kind, warning: state.warning, run, commit, replaceAll, notify, toasts, dismiss } : null),
    [state, run, commit, replaceAll, notify, toasts, dismiss],
  );

  if (bootError) return <div className="boot">Could not start: {bootError}</div>;
  if (!value) return <div className="boot" aria-busy="true">Loading your training log…</div>;
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}
