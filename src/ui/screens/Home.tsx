import React from 'react';
import { PR_LABELS, formatNumber } from '../../engine';
import { activeWorkout, attentionItems, byId, completedWorkouts, nextRecommendation, nextRoutineDay, recentRecords, weekSummary } from '../../app/selectors';
import type { Exercise } from '../../domain/types';
import { ActionTag, Empty, Icon, TopBar, toneOf } from '../components';
import { dayLabel, isTimeBased, loadText, repsText, volumeText } from '../format';
import { isDemoData, useStore } from '../store';
import type { Nav } from '../App';

export function Home({ nav }: { nav: Nav }) {
  const { ds, warning } = useStore();
  const active = activeWorkout(ds);
  const next = nextRoutineDay(ds);
  const exercises = byId(ds.exercises);
  const nextList = (next?.exerciseIds ?? []).map((id) => exercises.get(id)).filter((e): e is Exercise => Boolean(e && !e.archived));
  const attention = attentionItems(ds);
  const week = weekSummary(ds, new Date().toISOString());
  const prs = recentRecords(ds, 4);
  const last = completedWorkouts(ds)[0];
  const demo = isDemoData(ds);
  const today = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

  if (ds.exercises.length === 0) {
    return (
      <>
        <TopBar title="Gym Progression Coach" sub={today} />
        <Empty
          title="Start your log"
          action={
            <div className="stack">
              <button className="btn primary block" onClick={() => nav.push({ name: 'editExercise', id: null })}>
                Create your first exercise
              </button>
              <button className="btn block" onClick={() => nav.push({ name: 'backup' })}>
                Load example data or restore a backup
              </button>
            </div>
          }
        >
          Log a workout and the coach will tell you exactly what to do next time, and why.
        </Empty>
      </>
    );
  }

  return (
    <>
      <TopBar title="Today" sub={today} />
      <div className="stack">
        {warning && <div className="banner warn" role="alert">{warning}</div>}
        {demo && (
          <div className="banner info small">
            You're viewing example data: 5 weeks of an Upper/Lower routine. Explore it, then start fresh from <button className="linkish" onClick={() => nav.push({ name: 'backup' })}>Backup & restore</button>.
          </div>
        )}

        {active ? (
          <button className="card-link" onClick={() => nav.tab('train')}>
            <div className="spread">
              <div>
                <div className="small muted">In progress</div>
                <div style={{ fontWeight: 700, fontSize: 19 }}>{active.name}</div>
              </div>
              <span className="btn primary small" aria-hidden>
                Resume <Icon name="chevron" size={16} />
              </span>
            </div>
          </button>
        ) : next ? (
          <section className="card" aria-labelledby="next-h">
            <div className="spread" style={{ marginBottom: 6 }}>
              <div>
                <div className="small muted">Next up{last ? `, last trained ${dayLabel(last.completedAt).toLowerCase()}` : ''}</div>
                <h3 id="next-h" style={{ margin: 0, fontSize: 21 }}>{next.name}</h3>
              </div>
              <button className="btn primary small" onClick={() => nav.tab('train')}>
                Start
              </button>
            </div>
            <div className="next-list">
              {nextList.map((ex) => {
                const rec = nextRecommendation(ds, ex);
                return (
                  <button key={ex.id} className={`next-item tone-${toneOf(rec.action)}`} style={{ border: 0, background: 'none', width: '100%', textAlign: 'left', borderBottom: '1px solid var(--line)' }} onClick={() => nav.push({ name: 'exercise', id: ex.id })}>
                    <span className="bar" />
                    <span className="grow">
                      <span style={{ fontWeight: 600, display: 'block' }}>{ex.name}</span>
                      <ActionTag action={rec.action} />
                    </span>
                    <span className="t">
                      {rec.target.load === null ? 'Pick load' : loadText(rec.target.load, ex.unit)}
                      <span className="small muted" style={{ display: 'block' }}>{repsText(rec.target.repTargets, isTimeBased(ex))}</span>
                    </span>
                  </button>
                );
              })}
              {nextList.length === 0 && <div className="small muted">No exercises on this day yet.</div>}
            </div>
          </section>
        ) : (
          <Empty title="No routine yet" action={<button className="btn primary" onClick={() => nav.push({ name: 'routines' })}>Build a routine</button>}>
            A routine lets the coach line up your next workout.
          </Empty>
        )}

        {attention.length > 0 && (
          <>
            <h2 className="section">Needs attention</h2>
            <div className="list">
              {attention.map((a) => (
                <button key={a.exercise.id} className="list-item" onClick={() => nav.push({ name: 'exercise', id: a.exercise.id })}>
                  <span className={`tag tone-${a.kind === 'pain' || a.kind === 'config' ? 'pain' : a.kind === 'stall' ? 'hold' : 'warn'}`}>
                    <Icon name={a.kind === 'pain' ? 'flag' : 'alert'} size={13} />
                  </span>
                  <span className="grow">
                    <span className="title" style={{ display: 'block' }}>{a.exercise.name}</span>
                    <span className="meta">{a.text}. {a.rec.summary}.</span>
                  </span>
                  <Icon name="chevron" size={18} />
                </button>
              ))}
            </div>
          </>
        )}

        <h2 className="section">Last 7 days</h2>
        <div className="stat-grid">
          <div className="stat"><div className="v">{week.workouts}</div><div className="l">workouts</div></div>
          <div className="stat"><div className="v">{week.sets}</div><div className="l">sets</div></div>
          <div className="stat"><div className="v">{week.prs}</div><div className="l">PRs</div></div>
        </div>
        <div className="small muted" style={{ marginTop: -4 }}>Volume: {volumeText(week.volumeByUnit)}</div>

        {prs.length > 0 && (
          <>
            <h2 className="section">Recent personal records</h2>
            <div className="list">
              {prs.map((p) => {
                const ex = exercises.get(p.exerciseId);
                return (
                  <button key={p.id} className="list-item" onClick={() => ex && nav.push({ name: 'exercise', id: ex.id })}>
                    <span className="tag pr"><Icon name="trophy" size={13} /></span>
                    <span className="grow">
                      <span className="title" style={{ display: 'block' }}>{ex?.name ?? 'Exercise'}</span>
                      <span className="meta">
                        {PR_LABELS[p.type]}: {prValue(p.type, p.value, p.load, p.reps, p.unit)} ({dayLabel(p.achievedAt)})
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>
    </>
  );
}

export function prValue(type: string, value: number, load: number | null, reps: number | null, unit: string): string {
  switch (type) {
    case 'heaviest-load':
      return `${formatNumber(value)} ${unit}${reps ? ` × ${reps}` : ''}`;
    case 'reps-at-load':
      return `${reps} reps at ${load ? `${formatNumber(load)} ${unit}` : 'bodyweight'}`;
    case 'estimated-1rm':
      return `~${formatNumber(value, 0)} ${unit} (from ${formatNumber(load ?? 0)} × ${reps})`;
    case 'session-volume':
      return `${Math.round(value).toLocaleString()} ${unit}`;
    case 'longest-hold':
      return `${value} s`;
    default:
      return String(value);
  }
}
