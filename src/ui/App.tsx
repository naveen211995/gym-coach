import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { activeWorkout } from '../app/selectors';
import { Icon } from './components';
import { applyTheme, readTheme } from './platform';
import { StoreProvider, useStore } from './store';
import { Home } from './screens/Home';
import { ActiveWorkout, StartWorkout } from './screens/Train';
import { ExerciseDetail, HistoryScreen, WorkoutDetail } from './screens/History';
import { ProgressScreen } from './screens/Progress';
import { Backup, ExerciseEditor, Library, MoreMenu, Routines, RulesScreen, Settings } from './screens/More';

export type Tab = 'home' | 'train' | 'history' | 'progress' | 'more';
export type Route =
  | { name: 'workout'; id: string }
  | { name: 'exercise'; id: string }
  | { name: 'editExercise'; id: string | null }
  | { name: 'library' }
  | { name: 'routines' }
  | { name: 'settings' }
  | { name: 'backup' }
  | { name: 'rules' };

export interface Nav {
  tab: (t: Tab) => void;
  push: (r: Route) => void;
  back: () => void;
}

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'train', label: 'Train', icon: 'dumbbell' },
  { id: 'history', label: 'History', icon: 'history' },
  { id: 'progress', label: 'Progress', icon: 'chart' },
  { id: 'more', label: 'More', icon: 'menu' },
];

function Shell() {
  const { ds, toasts, dismiss } = useStore();
  const [tab, setTab] = useState<Tab>(() => (activeWorkout(ds) ? 'train' : 'home'));
  const [stack, setStack] = useState<Route[]>([]);
  const nav = useMemo<Nav>(
    () => ({
      tab: (t) => {
        setTab(t);
        setStack([]);
        window.scrollTo(0, 0);
      },
      push: (r) => {
        setStack((s) => [...s, r]);
        window.scrollTo(0, 0);
      },
      back: () => setStack((s) => s.slice(0, -1)),
    }),
    [],
  );
  const onKey = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape' && !document.querySelector('[role="dialog"]')) setStack((s) => s.slice(0, -1));
  }, []);
  useEffect(() => {
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onKey]);

  const active = activeWorkout(ds);
  const top = stack[stack.length - 1];
  let screen: React.ReactNode;
  if (top) {
    switch (top.name) {
      case 'workout':
        screen = <WorkoutDetail id={top.id} nav={nav} />;
        break;
      case 'exercise':
        screen = <ExerciseDetail id={top.id} nav={nav} />;
        break;
      case 'editExercise':
        screen = <ExerciseEditor key={top.id ?? 'new'} id={top.id} nav={nav} />;
        break;
      case 'library':
        screen = <Library nav={nav} />;
        break;
      case 'routines':
        screen = <Routines nav={nav} />;
        break;
      case 'settings':
        screen = <Settings nav={nav} />;
        break;
      case 'backup':
        screen = <Backup nav={nav} />;
        break;
      case 'rules':
        screen = <RulesScreen nav={nav} />;
        break;
    }
  } else {
    screen =
      tab === 'home' ? <Home nav={nav} /> :
      tab === 'train' ? (active ? <ActiveWorkout key={active.id} workout={active} nav={nav} /> : <StartWorkout nav={nav} />) :
      tab === 'history' ? <HistoryScreen nav={nav} /> :
      tab === 'progress' ? <ProgressScreen nav={nav} /> :
      <MoreMenu nav={nav} />;
  }

  return (
    <>
      <main className="app" id="main">{screen}</main>
      <nav className="tabbar" aria-label="Main">
        <div className="tabbar-inner">
          {TABS.map((t) => (
            <button key={t.id} className="tab" aria-current={!top && tab === t.id ? 'page' : undefined} onClick={() => nav.tab(t.id)}>
              <Icon name={t.icon} size={22} />
              {t.label}
              {t.id === 'train' && active && <span className="dot" aria-label="Workout in progress" />}
            </button>
          ))}
        </div>
      </nav>
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <button key={t.id} className={`toast ${t.tone}`} onClick={() => dismiss(t.id)}>
            {t.text}
          </button>
        ))}
      </div>
    </>
  );
}

export function App() {
  useEffect(() => applyTheme(readTheme()), []);
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  );
}
