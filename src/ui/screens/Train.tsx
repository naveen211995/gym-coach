import React, { useEffect, useState } from 'react';
import { PR_LABELS, assessReadiness, formatNumber } from '../../engine';
import type { Dataset, Exercise, ExerciseSession, PainLevel, SetPerformance, WorkoutSession } from '../../domain/types';
import {
  activeRoutineDays,
  byId,
  lastCompletedSession,
  nextRecommendation,
  nextRoutineDay,
  readinessForWorkout,
  recommendationAfter,
  sessionsForWorkout,
  substituteCandidates,
} from '../../app/selectors';
import * as S from '../../app/services';
import { emptyChange } from '../../domain/change';
import { ActionTag, Chips, Confirm, Empty, Icon, Sheet, Stepper, TargetPlate, TopBar, toneOf } from '../components';
import { ACTION_META, dayLabel, durationText, isBodyweight, isTimeBased, loadText, performanceText, repsText, setText } from '../format';
import { vibrate } from '../platform';
import { useStore } from '../store';
import type { Nav } from '../App';

// ───────────────────────── start ─────────────────────────

const SCALE = [1, 2, 3, 4, 5].map((v) => ({ value: v, label: String(v) }));

export function StartWorkout({ nav }: { nav: Nav }) {
  const { ds, run } = useStore();
  const days = activeRoutineDays(ds);
  const suggested = nextRoutineDay(ds);
  const [dayId, setDayId] = useState<string | null>(suggested?.id ?? null);
  const [checkIn, setCheckIn] = useState(false);
  const [r, setR] = useState<{ readiness: number | null; energy: number | null; fatigue: number | null; sleepHours: number | null; pain: boolean }>({ readiness: null, energy: null, fatigue: null, sleepHours: null, pain: false });
  const day = days.find((d) => d.id === dayId) ?? null;
  const exercises = byId(ds.exercises);
  const list = (day?.exerciseIds ?? []).map((id) => exercises.get(id)).filter((e): e is Exercise => Boolean(e && !e.archived));
  const filled = checkIn && (r.readiness !== null || r.energy !== null || r.fatigue !== null || r.sleepHours !== null || r.pain);
  const assessment = assessReadiness(filled ? { id: 'x', workoutSessionId: 'x', recordedAt: '', note: '', ...r } : null);

  const start = async () => {
    const res = await run((d, ctx) => S.startWorkout(d, { routineDayId: dayId, readiness: filled ? r : null }, ctx));
    if (res) vibrate();
  };

  if (ds.exercises.length === 0) {
    return (
      <>
        <TopBar title="Train" />
        <Empty title="No exercises yet" action={<button className="btn primary" onClick={() => nav.push({ name: 'editExercise', id: null })}>Create an exercise</button>}>
          Add exercises and a routine, or load the example data from Backup & restore.
        </Empty>
      </>
    );
  }

  return (
    <>
      <TopBar title="Start workout" sub={suggested ? `Next in your rotation: ${suggested.name}` : undefined} />
      <div className="stack">
        {days.length > 0 && (
          <Chips
            label="Workout day"
            value={dayId ?? '__empty'}
            onChange={(v) => setDayId(v === '__empty' || v === null ? null : String(v))}
            options={[...days.map((d) => ({ value: d.id, label: d.name, className: 'text' })), { value: '__empty', label: 'Empty workout', className: 'text' }]}
          />
        )}

        {day && list.length === 0 && <Empty title="This day has no exercises">Add some in the routine builder.</Empty>}
        {list.length > 0 && (
          <div className="card">
            <div className="next-list">
              {list.map((ex) => {
                const rec = nextRecommendation(ds, ex);
                return (
                  <div key={ex.id} className={`next-item tone-${toneOf(rec.action)}`}>
                    <span className="bar" />
                    <div className="grow">
                      <div style={{ fontWeight: 600 }}>{ex.name}</div>
                      <ActionTag action={rec.action} />
                    </div>
                    <div className="t">
                      {rec.target.load === null ? 'Pick load' : loadText(rec.target.load, ex.unit)}
                      <div className="small muted">{repsText(rec.target.repTargets, isTimeBased(ex))}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
        {!day && <div className="card small muted">An empty workout starts with no exercises; add them as you go.</div>}

        {ds.settings.askReadiness && (
          <div className="card">
            <div className="spread">
              <div>
                <div style={{ fontWeight: 700 }}>Readiness check-in</div>
                <div className="small muted">Optional. Adjusts today only, never your progression.</div>
              </div>
              <button className="btn small" aria-expanded={checkIn} onClick={() => setCheckIn((v) => !v)}>
                {checkIn ? 'Hide' : 'Check in'}
              </button>
            </div>
            {checkIn && (
              <div className="stack" style={{ marginTop: 12 }}>
                <div className="field">
                  <span className="label">Readiness (1 low – 5 great)</span>
                  <Chips label="Readiness" options={SCALE} value={r.readiness} onChange={(v) => setR({ ...r, readiness: v })} allowDeselect fill />
                </div>
                <div className="field">
                  <span className="label">Energy (1 low – 5 high)</span>
                  <Chips label="Energy" options={SCALE} value={r.energy} onChange={(v) => setR({ ...r, energy: v })} allowDeselect fill />
                </div>
                <div className="field">
                  <span className="label">Fatigue / soreness (1 fresh – 5 wrecked)</span>
                  <Chips label="Fatigue" options={SCALE} value={r.fatigue} onChange={(v) => setR({ ...r, fatigue: v })} allowDeselect fill />
                </div>
                <Stepper label="Sleep last night (hours)" value={r.sleepHours} onChange={(v) => setR({ ...r, sleepHours: v })} step={0.5} min={0} max={24} decimals={1} allowEmpty placeholder="—" />
                <label className="toggle">
                  <span>Pain or a niggle today</span>
                  <input type="checkbox" className="switch" role="switch" checked={r.pain} onChange={(e) => setR({ ...r, pain: e.target.checked })} />
                </label>
                {filled && (
                  <div className={`banner ${assessment.level === 'normal' ? 'info' : 'warn'}`} role="status">
                    {assessment.level === 'normal' && 'Normal readiness: targets unchanged.'}
                    {assessment.level === 'caution' && 'Caution: load increases and rep pushes are postponed today.'}
                    {assessment.level === 'poor' && 'Low readiness: one fewer set, an extra rep in reserve, no increases today.'}
                    {assessment.level === 'unknown' && 'Not enough answers to judge readiness.'}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        <button className="btn primary big" onClick={start}>
          <Icon name="start" /> Start {day ? day.name : 'empty workout'}
        </button>
      </div>
    </>
  );
}

// ───────────────────────── active workout ─────────────────────────

export function ActiveWorkout({ workout, nav }: { workout: WorkoutSession; nav: Nav }) {
  const { ds, run, commit, notify } = useStore();
  const sessions = sessionsForWorkout(ds, workout.id);
  const exercises = byId(ds.exercises);
  const firstOpen = sessions.find((s) => s.status === 'pending' || s.status === 'in-progress')?.id ?? null;
  const [openId, setOpenId] = useState<string | null>(firstOpen);
  const [adding, setAdding] = useState(false);
  const [confirm, setConfirm] = useState<'finish' | 'discard' | null>(null);
  const [now, setNow] = useState(() => new Date().toISOString());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date().toISOString()), 30000);
    return () => clearInterval(t);
  }, []);
  const readiness = readinessForWorkout(ds, workout);
  const assessment = assessReadiness(readiness);
  const done = sessions.filter((s) => s.status === 'completed').length;
  const pendingCount = sessions.filter((s) => s.status === 'pending' || s.status === 'in-progress').length;

  const openNext = (afterId: string) => {
    const list = sessionsForWorkout(ds, workout.id);
    const i = list.findIndex((s) => s.id === afterId);
    const next = list.slice(i + 1).find((s) => s.status === 'pending' || s.status === 'in-progress') ?? list.find((s) => s.status === 'pending' || s.status === 'in-progress');
    setOpenId(next?.id ?? null);
  };

  const finish = async () => {
    const ok = await commit((d, ctx) => S.finishWorkout(d, workout.id, ctx));
    if (ok) {
      vibrate(30);
      notify('Workout saved. Next targets are ready.', 'success');
      nav.push({ name: 'workout', id: workout.id });
    }
  };
  const discard = async () => {
    const ok = await commit((d) => S.discardWorkout(d, workout.id));
    if (ok) notify('Workout discarded.');
  };

  return (
    <>
      <TopBar
        title={workout.name}
        sub={`Started ${durationText(workout.startedAt, now)} ago, ${done} of ${sessions.filter((s) => s.status !== 'skipped').length} done`}
        right={
          <button className="btn primary small" onClick={() => setConfirm('finish')}>
            Finish
          </button>
        }
      />
      <div className="stack">
        {(assessment.level === 'caution' || assessment.level === 'poor') && (
          <div className="banner warn" role="status">
            <strong>{assessment.level === 'poor' ? 'Low readiness today.' : 'Caution today.'}</strong> Targets below are adjusted for today only. {assessment.reasons.join(' ')}
          </div>
        )}
        {sessions.length === 0 && <Empty title="No exercises in this workout">Add one to start logging.</Empty>}
        {sessions.map((es) => {
          const ex = exercises.get(es.exerciseId);
          if (!ex) return null;
          return <ExerciseCard key={es.id} es={es} exercise={ex} workout={workout} open={openId === es.id} onToggle={() => setOpenId(openId === es.id ? null : es.id)} onNext={() => openNext(es.id)} onOpen={setOpenId} />;
        })}
        <button className="btn block" onClick={() => setAdding(true)}>
          <Icon name="plus" /> Add exercise
        </button>
        <button className="btn primary big" onClick={() => setConfirm('finish')}>
          Finish workout
        </button>
        <button className="btn ghost block" onClick={() => setConfirm('discard')}>
          Discard workout
        </button>
      </div>

      <Sheet open={adding} title="Add exercise" onClose={() => setAdding(false)}>
        <ExercisePicker
          ds={ds}
          exclude={sessions.filter((s) => s.status !== 'skipped').map((s) => s.exerciseId)}
          onPick={async (id) => {
            setAdding(false);
            const res = await run((d, ctx) => ({ change: S.addExerciseToWorkout(d, workout.id, id, ctx) }));
            const created = res?.change.put.exerciseSessions?.[0]?.id;
            if (created) setOpenId(created);
          }}
        />
      </Sheet>
      <Confirm
        open={confirm === 'finish'}
        title="Finish workout?"
        confirmLabel="Finish and save"
        onClose={() => setConfirm(null)}
        onConfirm={finish}
        body={
          <div className="stack small">
            <div>{done} exercise{done === 1 ? '' : 's'} completed.</div>
            {pendingCount > 0 && <div>{pendingCount} not completed: any logged sets are saved and the rest are marked skipped. Partial sessions don't trigger progression.</div>}
            <div className="muted">After saving, this workout becomes read-only history.</div>
          </div>
        }
      />
      <Confirm
        open={confirm === 'discard'}
        title="Discard this workout?"
        danger
        confirmLabel="Discard"
        onClose={() => setConfirm(null)}
        onConfirm={discard}
        body="Everything logged in this workout will be deleted. Completed workouts in your history are not affected."
      />
    </>
  );
}

function ExercisePicker({ ds, exclude, onPick, prefer }: { ds: Dataset; exclude: string[]; onPick: (id: string) => void; prefer?: Exercise }) {
  const [q, setQ] = useState('');
  const list = prefer
    ? substituteCandidates(ds, prefer, exclude)
    : ds.exercises.filter((e) => !e.archived && !exclude.includes(e.id)).sort((a, b) => a.name.localeCompare(b.name));
  const shown = list.filter((e) => e.name.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <div className="stack">
      <input className="input" placeholder="Search exercises" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search exercises" />
      {shown.length === 0 ? (
        <div className="muted small">No matching exercises. Create one in the exercise library.</div>
      ) : (
        <div className="list">
          {shown.map((e) => (
            <button key={e.id} className="list-item" onClick={() => onPick(e.id)}>
              <div className="grow">
                <div className="title">{e.name}</div>
                <div className="meta">
                  {e.muscleGroup}
                  {prefer && e.muscleGroup === prefer.muscleGroup ? ' (same muscle group)' : ''}
                </div>
              </div>
              <Icon name="plus" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ───────────────────────── exercise card ─────────────────────────

const performed = (s: SetPerformance) => s.status === 'completed' || s.status === 'failed';

function ExerciseCard({ es, exercise, workout, open, onToggle, onNext, onOpen }: { es: ExerciseSession; exercise: Exercise; workout: WorkoutSession; open: boolean; onToggle: () => void; onNext: () => void; onOpen: (id: string) => void }) {
  const { ds, commit, run, notify } = useStore();
  const tb = isTimeBased(exercise);
  const sets = [...es.sets].sort((a, b) => a.index - b.index);
  const loggedCount = sets.filter(performed).length;
  const firstPending = sets.find((s) => s.status === 'pending')?.index ?? null;
  const [selected, setSelected] = useState<number | null>(firstPending);
  const [replacing, setReplacing] = useState(false);
  const [noteOpen, setNoteOpen] = useState(es.note.length > 0);
  useEffect(() => {
    if (selected === null || !sets.some((s) => s.index === selected)) setSelected(firstPending);
  }, [firstPending, sets.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const last = lastCompletedSession(ds, exercise.id, workout.startedAt);
  const rec = es.status === 'completed' ? recommendationAfter(ds, es.id) : null;
  const prs = es.status === 'completed' ? ds.personalRecords.filter((p) => p.exerciseSessionId === es.id) : [];
  const p = es.prescribed;
  const statusDot = es.status === 'completed' ? 'done' : es.status === 'skipped' ? 'skipped' : open ? 'active' : '';

  /** After any set change: when every set is resolved, complete the exercise and show the next target. */
  const afterSetChange = async () => {
    const result = await run((d, ctx) => {
      const cur = d.exerciseSessions.find((s) => s.id === es.id);
      if (!cur || cur.status === 'completed') return { change: emptyChange(), recommendation: null, records: [] };
      const unresolved = cur.sets.some((s) => s.status === 'pending');
      if (unresolved) return { change: emptyChange(), recommendation: null, records: [] };
      return S.completeExercise(d, es.id, ctx);
    });
    if (result?.recommendation) {
      vibrate(25);
      if (result.records.length) notify(`New PR: ${result.records.map((r) => PR_LABELS[r.type].toLowerCase()).join(', ')}`, 'success');
    }
  };

  const logSet = async (index: number, input: S.SetInput) => {
    const ok = await commit((d) => S.logSet(d, es.id, index, input));
    if (!ok) return;
    vibrate();
    const nextPending = sets.find((s) => s.status === 'pending' && s.index !== index)?.index ?? null;
    setSelected(nextPending);
    await afterSetChange();
  };
  const skipSet = async (index: number) => {
    const ok = await commit((d) => S.markSet(d, es.id, index, 'skipped'));
    if (!ok) return;
    setSelected(sets.find((s) => s.status === 'pending' && s.index !== index)?.index ?? null);
    await afterSetChange();
  };
  const clearSet = async (index: number) => {
    await commit((d) => S.markSet(d, es.id, index, 'pending'));
    setSelected(index);
  };
  const setPain = (pain: PainLevel) => commit((d, ctx) => S.setPain(d, es.id, pain, ctx));
  const complete = async () => {
    const res = await run((d, ctx) => S.completeExercise(d, es.id, ctx));
    if (res?.records.length) notify(`New PR: ${res.records.map((r) => PR_LABELS[r.type].toLowerCase()).join(', ')}`, 'success');
    if (res && !res.recommendation) notify('Nothing logged, so the exercise was marked skipped.');
  };

  return (
    <article className={`ex-card ${es.status === 'completed' ? 'done' : ''}`}>
      <button className="ex-head" onClick={onToggle} aria-expanded={open}>
        <span className={`status-dot ${statusDot}`} aria-hidden>
          {es.status === 'completed' ? <Icon name="check" size={16} /> : es.status === 'skipped' ? '–' : `${loggedCount}/${sets.length}`}
        </span>
        <div className="grow">
          <div className="name">{exercise.name}</div>
          <div className="meta">
            {es.status === 'completed' && rec ? `Next: ${rec.summary}` : es.status === 'skipped' ? 'Skipped' : `${loadText(p.load, exercise.unit)}, ${repsText(p.repTargets, tb)}`}
            {es.substitutedFromExerciseId ? ' (replacement)' : ''}
          </div>
        </div>
        {!open && es.status !== 'completed' && es.status !== 'skipped' && <span className={`tag tone-${ACTION_META[p.action].tone}`}>{ACTION_META[p.action].label}</span>}
        <Icon name={open ? 'down' : 'chevron'} size={18} />
      </button>

      {open && (
        <div className="ex-body">
          {es.status === 'skipped' ? (
            <div className="stack">
              <div className="muted small">Skipped. Skipped exercises don't affect progression.</div>
              {!es.substitutedFromExerciseId && !ds.substitutions.some((s) => s.originalExerciseSessionId === es.id) && (
                <button className="btn" onClick={() => commit((d) => S.reopenExercise(d, es.id))}>
                  Undo skip
                </button>
              )}
            </div>
          ) : es.status === 'completed' && rec ? (
            <CompletedView es={es} exercise={exercise} recSummary={rec} prs={prs} onNext={onNext} onEdit={() => commit((d) => S.reopenExercise(d, es.id))} onPain={setPain} />
          ) : (
            <>
              {p.action === 'review' && (
                <div className="banner pain" role="alert">
                  <strong>Flagged for review.</strong> Pain was logged last time. Replace or skip this exercise; if you train it, don't go above the target.
                  <div className="btn-row" style={{ marginTop: 10 }}>
                    <button className="btn small" onClick={() => setReplacing(true)}>
                      <Icon name="swap" size={16} /> Replace
                    </button>
                    <button className="btn small" onClick={() => commit((d) => S.skipExercise(d, es.id))}>
                      <Icon name="skip" size={16} /> Skip
                    </button>
                  </div>
                </div>
              )}
              <TargetPlate action={p.action} target={p} exercise={exercise} summary={p.summary} reasons={p.reasons} />
              {p.readinessAdjusted && (
                <div className="banner warn small">
                  <strong>Adjusted for today:</strong> {p.readinessNotes.join(' ')}
                </div>
              )}
              <div className="last-time">
                <strong>Last time</strong> {last ? `(${dayLabel(last.completedAt)})` : ''}: {last ? performanceText(last.sets, exercise) : 'no history yet'}
                {last?.pain && last.pain !== 'none' ? `, ${last.pain} pain` : ''}
              </div>

              <div className="sets" role="list" aria-label="Sets">
                {sets.map((s) => (
                  <button
                    key={s.id}
                    role="listitem"
                    className={`set-row ${performed(s) ? 'logged' : ''} ${s.status === 'failed' ? 'failed' : ''}`}
                    aria-current={selected === s.index}
                    onClick={() => setSelected(s.index)}
                  >
                    <span className="n">Set {s.index + 1}</span>
                    <span className="v">{s.status === 'pending' ? <span className="muted">—</span> : setText(s, tb)}</span>
                    <span className="t">
                      target {p.repTargets[s.index] ?? p.repTargets[p.repTargets.length - 1] ?? '—'}
                      {tb ? ' s' : ''}
                    </span>
                  </button>
                ))}
              </div>

              {selected !== null && sets.some((s) => s.index === selected) && (
                <SetEditor
                  key={`${es.id}-${selected}-${sets.find((s) => s.index === selected)?.status}`}
                  es={es}
                  exercise={exercise}
                  index={selected}
                  askConfidence={ds.settings.askRirConfidence}
                  onLog={(input) => logSet(selected, input)}
                  onSkip={() => skipSet(selected)}
                  onClear={() => clearSet(selected)}
                />
              )}

              <div className="row wrap">
                <button className="btn small" onClick={() => commit((d, ctx) => S.addSet(d, es.id, ctx))}>
                  <Icon name="plus" size={16} /> Add set
                </button>
                <button className="btn small ghost" onClick={() => commit((d) => S.removeLastSet(d, es.id))} disabled={sets.length <= 1}>
                  <Icon name="minus" size={16} /> Remove last
                </button>
                <button className="btn small ghost" onClick={() => setNoteOpen((v) => !v)} aria-expanded={noteOpen}>
                  <Icon name="edit" size={16} /> Note
                </button>
              </div>
              {noteOpen && <NoteField initial={es.note} onSave={(note) => commit((d) => S.setExerciseNote(d, es.id, note))} />}

              <div className="field">
                <span className="label">Pain during this exercise</span>
                <Chips
                  label="Pain"
                  value={es.pain}
                  onChange={(v) => setPain((v ?? 'none') as PainLevel)}
                  fill
                  options={[
                    { value: 'none', label: 'None', className: 'text' },
                    { value: 'mild', label: 'Mild', className: 'text chip-mild' },
                    { value: 'significant', label: 'Significant', className: 'text chip-pain' },
                  ]}
                />
                {es.pain === 'significant' && <span className="small" style={{ color: 'var(--pain)' }}>Load will not be increased. Consider stopping, replacing or skipping.</span>}
              </div>

              <div className="btn-row">
                <button className="btn primary" onClick={complete} disabled={loggedCount === 0}>
                  <Icon name="check" size={18} /> Complete
                </button>
                {loggedCount === 0 ? (
                  <button className="btn" onClick={() => setReplacing(true)}>
                    <Icon name="swap" size={18} /> Replace
                  </button>
                ) : (
                  <span className="small muted" style={{ alignSelf: 'center' }}>
                    Completes automatically after the last set.
                  </span>
                )}
              </div>
              {loggedCount === 0 && (
                <button className="btn ghost block" onClick={() => commit((d) => S.skipExercise(d, es.id))}>
                  Skip this exercise
                </button>
              )}
            </>
          )}
        </div>
      )}
      <Sheet open={replacing} title={`Replace ${exercise.name}`} onClose={() => setReplacing(false)}>
        <ExercisePicker
          ds={ds}
          prefer={exercise}
          exclude={sessionsForWorkout(ds, workout.id).filter((s) => s.status !== 'skipped').map((s) => s.exerciseId)}
          onPick={async (id) => {
            setReplacing(false);
            const res = await run((d, ctx) => S.substituteExercise(d, es.id, id, es.pain !== 'none' || p.action === 'review' ? 'Pain' : 'Replaced during workout', ctx));
            if (res) onOpen(res.newSessionId);
          }}
        />
      </Sheet>
    </article>
  );
}

function NoteField({ initial, onSave }: { initial: string; onSave: (s: string) => void }) {
  const [v, setV] = useState(initial);
  return (
    <div className="field">
      <label htmlFor="ex-note">Exercise note</label>
      <input id="ex-note" type="text" maxLength={300} value={v} onChange={(e) => setV(e.target.value)} onBlur={() => v !== initial && onSave(v)} placeholder="Seat height, grip, how it felt…" />
    </div>
  );
}

function SetEditor({ es, exercise, index, askConfidence, onLog, onSkip, onClear }: { es: ExerciseSession; exercise: Exercise; index: number; askConfidence: boolean; onLog: (i: S.SetInput) => void; onSkip: () => void; onClear: () => void }) {
  const tb = isTimeBased(exercise);
  const bw = isBodyweight(exercise);
  const sets = [...es.sets].sort((a, b) => a.index - b.index);
  const current = sets.find((s) => s.index === index) as SetPerformance;
  const prevLogged = sets.filter((s) => s.index < index && performed(s)).pop();
  const p = es.prescribed;
  const isLogged = performed(current);
  const defaultLoad = isLogged ? current.load : (prevLogged?.load ?? p.load ?? (bw ? null : null));
  const defaultReps = isLogged ? current.reps : (p.repTargets[index] ?? p.repTargets[p.repTargets.length - 1] ?? exercise.progression.minReps);
  const [load, setLoad] = useState<number | null>(defaultLoad);
  const [reps, setReps] = useState<number | null>(defaultReps);
  const [rir, setRir] = useState<number | null>(isLogged ? current.rir : tb ? null : p.targetRir);
  const [conf, setConf] = useState<number | null>(isLogged ? current.rirConfidence : null);
  const [note, setNote] = useState(isLogged ? current.note : '');
  const [showNote, setShowNote] = useState(Boolean(isLogged && current.note));
  const step = exercise.progression.loadIncrement > 0 ? exercise.progression.loadIncrement : exercise.unit === 'kg' ? 2.5 : 5;
  const missingLoad = !bw && load === null;

  const submit = (status: 'completed' | 'failed') => onLog({ load, reps, rir: status === 'failed' ? 0 : rir, rirConfidence: rir === null ? null : conf, note, status });

  return (
    <div className="editor" aria-label={`Log set ${index + 1}`}>
      <div className="spread">
        <span className="editor-title">
          {isLogged ? 'Edit' : 'Log'} set {index + 1}
        </span>
        <span className="small muted">
          Target {p.repTargets[index] ?? '—'}
          {tb ? ' s' : ` reps @ RIR ${formatNumber(p.targetRir)}`}
        </span>
      </div>
      <div className="stack" style={{ gap: 10 }}>
        <Stepper label={`Weight (${exercise.unit})`} hint={bw ? 'blank = BW' : undefined} value={load} onChange={setLoad} step={step} min={0} max={5000} decimals={2} allowEmpty placeholder={bw ? 'BW' : 'kg/lb/plt'} />
        <Stepper label={tb ? 'Seconds' : 'Reps'} value={reps} onChange={setReps} step={tb ? 5 : 1} min={0} max={tb ? 3600 : 100} integer />
      </div>
      {!tb && (
        <div className="field">
          <span className="label">Reps in reserve (tap again to clear)</span>
          <Chips label="RIR" value={rir} onChange={setRir} allowDeselect fill options={[0, 1, 2, 3, 4, 5].map((v) => ({ value: v, label: v === 5 ? '5+' : String(v) }))} />
        </div>
      )}
      {!tb && askConfidence && rir !== null && (
        <div className="field">
          <span className="label">How sure is that RIR? (optional, 1 guess – 5 certain)</span>
          <Chips label="RIR confidence" value={conf} onChange={setConf} allowDeselect fill options={SCALE} />
        </div>
      )}
      {showNote ? (
        <div className="field">
          <label htmlFor={`note-${es.id}-${index}`}>Set note</label>
          <input id={`note-${es.id}-${index}`} type="text" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
      ) : (
        <button className="linkish" onClick={() => setShowNote(true)} style={{ alignSelf: 'flex-start' }}>
          Add a set note
        </button>
      )}
      {missingLoad && <div className="small" style={{ color: 'var(--pain)' }}>Enter the weight you used.</div>}
      <button className="btn primary big" onClick={() => submit('completed')} disabled={missingLoad || reps === null}>
        <Icon name="check" /> {isLogged ? 'Update set' : `Log ${load !== null && load > 0 ? `${formatNumber(load)} × ` : ''}${reps ?? '—'}${tb ? ' s' : ''}`}
      </button>
      <div className="btn-row">
        <button className="btn" onClick={() => submit('failed')} disabled={missingLoad || reps === null}>
          Failed rep
        </button>
        {isLogged ? (
          <button className="btn" onClick={onClear}>
            Clear set
          </button>
        ) : (
          <button className="btn" onClick={onSkip}>
            Skip set
          </button>
        )}
      </div>
    </div>
  );
}

function CompletedView({
  es,
  exercise,
  recSummary,
  prs,
  onNext,
  onEdit,
  onPain,
}: {
  es: ExerciseSession;
  exercise: Exercise;
  recSummary: NonNullable<ReturnType<typeof recommendationAfter>>;
  prs: Dataset['personalRecords'];
  onNext: () => void;
  onEdit: () => void;
  onPain: (p: PainLevel) => void;
}) {
  const r = recSummary;
  const m = ACTION_META[r.action];
  const dirIcon = r.direction === 'up' ? 'up' : r.direction === 'down' ? 'down' : 'same';
  const dirText = r.direction === 'up' ? 'Load goes up next time' : r.direction === 'down' ? 'Load comes down next time' : 'Load stays the same next time';
  return (
    <div className="stack">
      <section className={`result tone-${m.tone}`} aria-live="polite">
        <div className="result-head">
          <span className="result-arrow">
            <Icon name={dirIcon} size={24} />
          </span>
          <div className="grow">
            <div className="small muted">{dirText}</div>
            <div className="result-line">{r.summary}</div>
          </div>
        </div>
        <ul className="reasons">
          {r.reasons.map((x, i) => (
            <li key={i}>{x}</li>
          ))}
        </ul>
        <div className="row wrap" style={{ marginTop: 8 }}>
          <ActionTag action={r.action} />
          <span className="rule-id">{r.ruleId}</span>
          {prs.map((p) => (
            <span key={p.id} className="tag pr">
              <Icon name="trophy" size={13} /> {PR_LABELS[p.type]}
            </span>
          ))}
        </div>
      </section>
      <div className="last-time">
        <strong>Today:</strong> {performanceText(es.sets, exercise)}
        {es.pain !== 'none' ? `, ${es.pain} pain` : ''}
      </div>
      <div className="field">
        <span className="label">Pain (changes the recommendation)</span>
        <Chips
          label="Pain"
          value={es.pain}
          onChange={(v) => onPain((v ?? 'none') as PainLevel)}
          fill
          options={[
            { value: 'none', label: 'None', className: 'text' },
            { value: 'mild', label: 'Mild', className: 'text chip-mild' },
            { value: 'significant', label: 'Significant', className: 'text chip-pain' },
          ]}
        />
      </div>
      <div className="btn-row">
        <button className="btn" onClick={onEdit}>
          <Icon name="edit" size={18} /> Edit sets
        </button>
        <button className="btn primary" onClick={onNext}>
          Next exercise <Icon name="chevron" size={18} />
        </button>
      </div>
    </div>
  );
}
