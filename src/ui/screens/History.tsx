import React, { useState } from 'react';
import { PR_LABELS, RULE_DESCRIPTIONS, formatNumber } from '../../engine';
import { byId, completedWorkouts, exerciseStats, nextRecommendation, readinessForWorkout, recommendationAfter, sessionsForWorkout } from '../../app/selectors';
import { assessReadiness } from '../../engine';
import { ActionTag, Empty, Icon, Segmented, TargetPlate, TopBar } from '../components';
import { cap, dateLabel, dayLabel, durationText, isTimeBased, performanceText, setText, shortDate } from '../format';
import { useStore } from '../store';
import type { Nav } from '../App';
import { prValue } from './Home';

export function HistoryScreen({ nav }: { nav: Nav }) {
  const { ds } = useStore();
  const [view, setView] = useState<'workouts' | 'exercises'>('workouts');
  const workouts = completedWorkouts(ds);
  const exercises = [...ds.exercises].filter((e) => !e.archived || ds.exerciseSessions.some((s) => s.exerciseId === e.id)).sort((a, b) => a.name.localeCompare(b.name));
  return (
    <>
      <TopBar title="History" />
      <div className="stack">
        <Segmented label="History view" value={view} onChange={setView} options={[{ value: 'workouts', label: 'Workouts' }, { value: 'exercises', label: 'Exercises' }]} />
        {view === 'workouts' ? (
          workouts.length === 0 ? (
            <Empty title="No workouts yet">Finished workouts show up here, with what the coach recommended after each exercise.</Empty>
          ) : (
            <div className="list">
              {workouts.map((w) => {
                const ss = sessionsForWorkout(ds, w.id).filter((s) => s.status === 'completed');
                const sets = ss.reduce((a, s) => a + s.sets.filter((x) => x.status === 'completed' || x.status === 'failed').length, 0);
                const prs = ds.personalRecords.filter((p) => p.workoutSessionId === w.id).length;
                return (
                  <button key={w.id} className="list-item" onClick={() => nav.push({ name: 'workout', id: w.id })}>
                    <div className="grow">
                      <div className="title">{w.name}</div>
                      <div className="meta">
                        {dateLabel(w.completedAt)}, {ss.length} exercises, {sets} sets
                      </div>
                    </div>
                    {prs > 0 && (
                      <span className="tag pr">
                        <Icon name="trophy" size={13} /> {prs}
                      </span>
                    )}
                    <Icon name="chevron" size={18} />
                  </button>
                );
              })}
            </div>
          )
        ) : exercises.length === 0 ? (
          <Empty title="No exercises yet" />
        ) : (
          <div className="list">
            {exercises.map((e) => {
              const count = ds.exerciseSessions.filter((s) => s.exerciseId === e.id && s.status === 'completed').length;
              const rec = nextRecommendation(ds, e);
              return (
                <button key={e.id} className="list-item" onClick={() => nav.push({ name: 'exercise', id: e.id })}>
                  <div className="grow">
                    <div className="title">
                      {e.name}
                      {e.archived ? ' (archived)' : ''}
                    </div>
                    <div className="meta">
                      {count} session{count === 1 ? '' : 's'}, next: {rec.summary}
                    </div>
                  </div>
                  <Icon name="chevron" size={18} />
                </button>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}

export function WorkoutDetail({ id, nav }: { id: string; nav: Nav }) {
  const { ds } = useStore();
  const w = ds.workoutSessions.find((x) => x.id === id);
  if (!w) return <><TopBar title="Workout" onBack={nav.back} /><Empty title="Workout not found" /></>;
  const exercises = byId(ds.exercises);
  const sessions = sessionsForWorkout(ds, id);
  const readiness = readinessForWorkout(ds, w);
  const level = assessReadiness(readiness).level;
  return (
    <>
      <TopBar title={w.name} sub={`${dateLabel(w.completedAt ?? w.startedAt)}${w.completedAt ? `, ${durationText(w.startedAt, w.completedAt)}` : ', in progress'}`} onBack={nav.back} />
      <div className="stack">
        {readiness && (
          <div className="card small">
            <strong>Readiness:</strong> {cap(level === 'unknown' ? 'not rated' : level)}
            {readiness.readiness ? `, readiness ${readiness.readiness}/5` : ''}
            {readiness.energy ? `, energy ${readiness.energy}/5` : ''}
            {readiness.fatigue ? `, fatigue ${readiness.fatigue}/5` : ''}
            {readiness.sleepHours !== null ? `, ${formatNumber(readiness.sleepHours)} h sleep` : ''}
            {readiness.pain ? ', pain reported' : ''}
            {readiness.note ? `. "${readiness.note}"` : ''}
          </div>
        )}
        {sessions.map((es) => {
          const ex = exercises.get(es.exerciseId);
          if (!ex) return null;
          const rec = recommendationAfter(ds, es.id);
          const prs = ds.personalRecords.filter((p) => p.exerciseSessionId === es.id);
          const tb = isTimeBased(ex);
          const sub = es.substitutedFromExerciseId ? exercises.get(es.substitutedFromExerciseId) : null;
          return (
            <section key={es.id} className="card">
              <div className="spread">
                <button className="linkish" style={{ fontSize: 17, fontWeight: 700, textDecoration: 'none', color: 'var(--ink)' }} onClick={() => nav.push({ name: 'exercise', id: ex.id })}>
                  {ex.name}
                </button>
                {es.status === 'skipped' ? <span className="tag">Skipped</span> : es.pain !== 'none' ? <span className={`tag tone-${es.pain === 'significant' ? 'pain' : 'warn'}`}>{cap(es.pain)} pain</span> : null}
              </div>
              {sub && <div className="small muted">Replaced {sub.name}</div>}
              <div className="small muted">
                Prescribed: {es.prescribed.summary}
                {es.prescribed.readinessAdjusted ? ' (adjusted for readiness)' : ''}
              </div>
              {es.status !== 'skipped' && (
                <div className="table-wrap" style={{ marginTop: 6 }}>
                  <table className="simple">
                    <thead>
                      <tr>
                        <th>Set</th>
                        <th>Done</th>
                        <th>Target</th>
                        <th>Note</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...es.sets]
                        .sort((a, b) => a.index - b.index)
                        .map((s) => (
                          <tr key={s.id}>
                            <td>{s.index + 1}</td>
                            <td className="num">{setText(s, tb)}</td>
                            <td className="num muted">
                              {es.prescribed.repTargets[s.index] ?? '—'}
                              {tb ? ' s' : ''}
                            </td>
                            <td className="small">{s.note}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              )}
              {es.note && <div className="small" style={{ marginTop: 6 }}>Note: {es.note}</div>}
              {prs.length > 0 && (
                <div className="row wrap" style={{ marginTop: 8 }}>
                  {prs.map((p) => (
                    <span key={p.id} className="tag pr">
                      <Icon name="trophy" size={13} /> {PR_LABELS[p.type]}: {prValue(p.type, p.value, p.load, p.reps, p.unit)}
                    </span>
                  ))}
                </div>
              )}
              {rec && (
                <div className="tl-next">
                  <strong>Then recommended:</strong> {rec.summary} <ActionTag action={rec.action} />
                </div>
              )}
            </section>
          );
        })}
        {w.notes && <div className="card small">Workout note: {w.notes}</div>}
      </div>
    </>
  );
}

export function ExerciseDetail({ id, nav }: { id: string; nav: Nav }) {
  const { ds } = useStore();
  const ex = ds.exercises.find((e) => e.id === id);
  if (!ex) return <><TopBar title="Exercise" onBack={nav.back} /><Empty title="Exercise not found" /></>;
  const rec = nextRecommendation(ds, ex);
  const stats = exerciseStats(ds, ex);
  const tb = isTimeBased(ex);
  const sessions = ds.exerciseSessions
    .filter((s) => s.exerciseId === ex.id && s.status === 'completed')
    .sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''));
  const c = ex.progression;
  const b = stats.bests;
  return (
    <>
      <TopBar
        title={ex.name}
        sub={`${cap(ex.muscleGroup)}, ${ex.equipment}, ${c.workingSets} × ${c.minReps}–${c.maxReps}${tb ? ' s' : ''}${tb ? '' : ` @ RIR ${c.targetRir}`}`}
        onBack={nav.back}
        right={
          <button className="icon-btn" aria-label="Edit exercise settings" onClick={() => nav.push({ name: 'editExercise', id: ex.id })}>
            <Icon name="edit" />
          </button>
        }
      />
      <div className="stack">
        <h2 className="section" style={{ marginTop: 0 }}>Next session</h2>
        <TargetPlate action={rec.action} target={rec.target} exercise={ex} summary={rec.summary} reasons={rec.reasons} ruleId={rec.ruleId} />
        {rec.warnings.length > 0 && <div className="banner warn small">{rec.warnings.join(' ')}</div>}
        <div className="small muted">{RULE_DESCRIPTIONS[rec.ruleId] ?? ''}</div>

        <h2 className="section">Trend (last {rec.trend.windowSize || 0} sessions)</h2>
        <div className="stat-grid">
          <div className="stat">
            <div className="v" style={{ fontSize: 19 }}>{rec.trend.label === 'insufficient-data' ? 'Too early' : cap(rec.trend.label)}</div>
            <div className="l">status</div>
          </div>
          <div className="stat">
            <div className="v">{rec.trend.changePct === null ? '—' : `${rec.trend.changePct > 0 ? '+' : ''}${formatNumber(rec.trend.changePct, 1)}%`}</div>
            <div className="l">{tb ? 'total time' : 'est. strength'}</div>
          </div>
          <div className="stat">
            <div className="v">{rec.trend.stallCount}</div>
            <div className="l">sessions w/o progress</div>
          </div>
        </div>

        <h2 className="section">Historical bests</h2>
        {stats.sessionCount === 0 ? (
          <div className="small muted">Nothing logged yet.</div>
        ) : (
          <div className="card flat">
            <div className="table-wrap">
              <table className="simple">
                <tbody>
                  {tb ? (
                    <tr><td>Longest hold</td><td className="num">{b.longestHold ? `${b.longestHold.seconds} s` : '—'}</td><td className="small muted">{b.longestHold ? shortDate(b.longestHold.date) : ''}</td></tr>
                  ) : (
                    <>
                      <tr><td>Heaviest load</td><td className="num">{b.heaviestLoad ? `${formatNumber(b.heaviestLoad.load)} ${ex.unit} × ${b.heaviestLoad.reps}` : '—'}</td><td className="small muted">{b.heaviestLoad ? shortDate(b.heaviestLoad.date) : ''}</td></tr>
                      <tr><td>Best est. 1RM</td><td className="num">{b.bestE1rm ? `~${formatNumber(b.bestE1rm.value, 0)} ${ex.unit}` : '—'}</td><td className="small muted">{b.bestE1rm ? `${formatNumber(b.bestE1rm.load)} × ${b.bestE1rm.reps}` : ''}</td></tr>
                      <tr><td>Best session volume</td><td className="num">{b.bestVolume ? `${Math.round(b.bestVolume.value).toLocaleString()} ${ex.unit}` : '—'}</td><td className="small muted">{b.bestVolume ? shortDate(b.bestVolume.date) : ''}</td></tr>
                    </>
                  )}
                </tbody>
              </table>
            </div>
            {!tb && b.repsAtLoad.length > 0 && (
              <>
                <div className="small" style={{ fontWeight: 700, margin: '10px 0 4px' }}>Best reps at each load</div>
                <div className="row wrap">
                  {b.repsAtLoad.slice(0, 8).map((r) => (
                    <span key={r.load} className="tag">
                      {r.load ? `${formatNumber(r.load)} ${ex.unit}` : 'BW'}: {r.reps}
                    </span>
                  ))}
                </div>
              </>
            )}
            <div className="small muted" style={{ marginTop: 8 }}>Estimated 1RM is a trend indicator (Epley formula), not a measured max.</div>
          </div>
        )}

        <h2 className="section">Session log: how each session shaped the next target</h2>
        {sessions.length === 0 ? (
          <div className="small muted">Complete a session and the recommendation it produced will appear here.</div>
        ) : (
          <div className="card flat timeline">
            {sessions.map((s) => {
              const r = recommendationAfter(ds, s.id);
              const prs = ds.personalRecords.filter((p) => p.exerciseSessionId === s.id);
              return (
                <div key={s.id} className="tl-item">
                  <div className="spread">
                    <strong>{dayLabel(s.completedAt)}</strong>
                    <span className="small muted">{s.prescribed.readinessAdjusted ? 'readiness-adjusted' : ''}</span>
                  </div>
                  <div className="num" style={{ fontSize: 18 }}>{performanceText(s.sets, ex)}</div>
                  <div className="small muted">
                    RIR {s.sets.filter((x) => x.rir !== null).map((x) => formatNumber(x.rir as number)).join('/') || 'not logged'}
                    {s.pain !== 'none' ? `, ${s.pain} pain` : ''}
                    {s.note ? `. ${s.note}` : ''}
                  </div>
                  {prs.length > 0 && (
                    <div className="row wrap" style={{ marginTop: 4 }}>
                      {prs.map((p) => (
                        <span key={p.id} className="tag pr">
                          <Icon name="trophy" size={12} /> {PR_LABELS[p.type]}
                        </span>
                      ))}
                    </div>
                  )}
                  {r && (
                    <div className="tl-next">
                      <Icon name="chevron" size={14} /> {r.summary} <span className="rule-id">{r.ruleId}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
