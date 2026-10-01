import React, { useRef, useState } from 'react';
import { DELOAD_STRATEGIES, EQUIPMENT_TYPES, MUSCLE_GROUPS, STRATEGIES, defaultIncrementFor, defaultProgression } from '../../domain/defaults';
import { emptyDataset } from '../../domain/change';
import { defaultSettings } from '../../domain/defaults';
import type { Dataset, Exercise, MuscleGroup, ProgressionConfig, Unit } from '../../domain/types';
import { RULES, RULE_DESCRIPTIONS } from '../../engine';
import { nextRecommendation } from '../../app/selectors';
import * as S from '../../app/services';
import { mergeDatasets, parseBackup, serializeBackup, toCsv, type ParseResult } from '../../storage/backup';
import { Chips, Confirm, Empty, HelpButton, Icon, Segmented, Sheet, Stepper, Toggle, TopBar } from '../components';
import { STRATEGY_HELP, cap } from '../format';
import { applyTheme, nowIso, readTheme, saveTextFile, type ThemePref } from '../platform';
import { buildDemo, useStore } from '../store';
import type { Nav } from '../App';

export function MoreMenu({ nav }: { nav: Nav }) {
  const { storage } = useStore();
  const items: { label: string; meta: string; route: Parameters<Nav['push']>[0] }[] = [
    { label: 'Exercise library', meta: 'Exercises and their progression settings', route: { name: 'library' } },
    { label: 'Routine builder', meta: 'Days, exercise order and rotation', route: { name: 'routines' } },
    { label: 'Settings', meta: 'Units, readiness check-in, RIR confidence, theme', route: { name: 'settings' } },
    { label: 'Backup & restore', meta: 'Export JSON or CSV, import, reset', route: { name: 'backup' } },
    { label: 'How progression works', meta: 'Every rule the coach uses, with thresholds', route: { name: 'rules' } },
  ];
  return (
    <>
      <TopBar title="More" />
      <div className="stack">
        <div className="list">
          {items.map((i) => (
            <button key={i.label} className="list-item" onClick={() => nav.push(i.route)}>
              <div className="grow">
                <div className="title">{i.label}</div>
                <div className="meta">{i.meta}</div>
              </div>
              <Icon name="chevron" size={18} />
            </button>
          ))}
        </div>
        <div className="small muted">
          Data is stored {storage === 'indexeddb' ? 'on this device (IndexedDB)' : 'in memory only; export a backup'}. Works offline once loaded. No account, no server.
        </div>
      </div>
    </>
  );
}

// ───────────────────────── library ─────────────────────────

export function Library({ nav }: { nav: Nav }) {
  const { ds } = useStore();
  const [q, setQ] = useState('');
  const [group, setGroup] = useState<MuscleGroup | null>(null);
  const [archived, setArchived] = useState(false);
  const list = ds.exercises
    .filter((e) => e.archived === archived && (!group || e.muscleGroup === group) && e.name.toLowerCase().includes(q.trim().toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name));
  const groups = MUSCLE_GROUPS.filter((g) => ds.exercises.some((e) => e.muscleGroup === g.value));
  return (
    <>
      <TopBar
        title="Exercise library"
        onBack={nav.back}
        right={
          <button className="btn primary small" onClick={() => nav.push({ name: 'editExercise', id: null })}>
            <Icon name="plus" size={16} /> New
          </button>
        }
      />
      <div className="stack">
        <input className="input" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search exercises" />
        {groups.length > 1 && <Chips label="Muscle group" value={group} onChange={setGroup} allowDeselect options={groups.map((g) => ({ value: g.value, label: g.label, className: 'text' }))} />}
        {list.length === 0 ? (
          <Empty title={archived ? 'No archived exercises' : 'No exercises match'} />
        ) : (
          <div className="list">
            {list.map((e) => {
              const rec = nextRecommendation(ds, e);
              return (
                <button key={e.id} className="list-item" onClick={() => nav.push({ name: 'editExercise', id: e.id })}>
                  <div className="grow">
                    <div className="title">{e.name}</div>
                    <div className="meta">
                      {cap(e.muscleGroup)}, {e.equipment}, {STRATEGIES.find((s) => s.value === e.progression.strategy)?.label.toLowerCase()}, {e.progression.workingSets}×{e.progression.minReps}–{e.progression.maxReps}
                    </div>
                    <div className="meta">Next: {rec.summary}</div>
                  </div>
                  <Icon name="chevron" size={18} />
                </button>
              );
            })}
          </div>
        )}
        <button className="linkish" onClick={() => setArchived((v) => !v)}>
          {archived ? 'Show active exercises' : 'Show archived exercises'}
        </button>
      </div>
    </>
  );
}

// ───────────────────────── exercise editor ─────────────────────────

export function ExerciseEditor({ id, nav }: { id: string | null; nav: Nav }) {
  const { ds, run, commit, notify } = useStore();
  const existing = id ? ds.exercises.find((e) => e.id === id) : undefined;
  const unit0: Unit = existing?.unit ?? ds.settings.defaultUnit;
  const [form, setForm] = useState<S.ExerciseInput>(() =>
    existing
      ? { name: existing.name, muscleGroup: existing.muscleGroup, equipment: existing.equipment, unit: existing.unit, progression: { ...existing.progression }, notes: existing.notes }
      : { name: '', muscleGroup: 'chest', equipment: 'barbell', unit: unit0, progression: defaultProgression({ loadIncrement: defaultIncrementFor(unit0) }), notes: '' },
  );
  const [touched, setTouched] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [strategyHelp, setStrategyHelp] = useState(false);
  const errors = S.validateExerciseInput(ds, form, id ?? undefined);
  const hasHistory = id ? ds.exerciseSessions.some((s) => s.exerciseId === id) : false;
  const c = form.progression;
  const tb = c.strategy === 'time-based';
  const setP = (patch: Partial<ProgressionConfig>) => setForm((f) => ({ ...f, progression: { ...f.progression, ...patch } }));
  const err = (k: string) => (touched && errors[k] ? <span className="err">{errors[k]}</span> : null);

  const save = async () => {
    setTouched(true);
    if (Object.keys(errors).length) {
      notify('Fix the highlighted fields first.', 'error');
      return;
    }
    if (existing) {
      const ok = await commit((d, ctx) => S.updateExercise(d, existing.id, form, ctx));
      if (ok) {
        notify('Saved. Future recommendations use the new settings.', 'success');
        nav.back();
      }
    } else {
      const res = await run((d, ctx) => S.createExercise(d, form, ctx));
      if (res) {
        notify('Exercise created.', 'success');
        nav.back();
      }
    }
  };

  return (
    <>
      <TopBar title={existing ? 'Edit exercise' : 'New exercise'} onBack={nav.back} />
      <div className="stack">
        <div className={`field ${touched && errors.name ? 'invalid' : ''}`}>
          <label htmlFor="ex-name">Name</label>
          <input id="ex-name" type="text" value={form.name} maxLength={60} onChange={(e) => setForm({ ...form, name: e.target.value })} autoComplete="off" />
          {err('name')}
        </div>
        <div className="two-col">
          <div className="field">
            <label htmlFor="ex-mg">Muscle group</label>
            <select id="ex-mg" value={form.muscleGroup} onChange={(e) => setForm({ ...form, muscleGroup: e.target.value as Exercise['muscleGroup'] })}>
              {MUSCLE_GROUPS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="ex-eq">Equipment</label>
            <select id="ex-eq" value={form.equipment} onChange={(e) => setForm({ ...form, equipment: e.target.value as Exercise['equipment'] })}>
              {EQUIPMENT_TYPES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </div>
        </div>
        <div className="field">
          <span className="label">Unit</span>
          <Segmented label="Unit" value={form.unit} onChange={(u) => setForm({ ...form, unit: u, progression: existing ? form.progression : { ...form.progression, loadIncrement: defaultIncrementFor(u) } })} options={[{ value: 'lb', label: 'lb' }, { value: 'kg', label: 'kg' }, { value: 'plt', label: 'plt' }]} />
          {existing && form.unit !== existing.unit && (
            <span className="hint">
              {form.unit === 'plt' || existing.unit === 'plt'
                ? "Logged sets keep the unit they were logged in. Plates aren't a real weight, so past lb/kg sets won't be converted to or from plates — only new sets will use the new unit."
                : 'Logged sets keep the unit they were logged in; the engine converts them. Nothing in history is rewritten.'}
            </span>
          )}
        </div>

        <h2 className="section">Progression</h2>
        <div className="field">
          <div className="label-row">
            <label htmlFor="ex-strat">Strategy</label>
            <HelpButton label="What do these strategies mean?" onClick={() => setStrategyHelp(true)} />
          </div>
          <select id="ex-strat" value={c.strategy} onChange={(e) => setP({ strategy: e.target.value as ProgressionConfig['strategy'] })}>
            {STRATEGIES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
          <span className="hint">{STRATEGIES.find((s) => s.value === c.strategy)?.description}</span>
        </div>
        <Sheet open={strategyHelp} title="Progression strategies, in plain terms" onClose={() => setStrategyHelp(false)}>
          <div className="strategy-help-list">
            {STRATEGIES.map((s) => (
              <div key={s.value} className={`strategy-help-item ${s.value === c.strategy ? 'current' : ''}`}>
                <h3>
                  {s.label}
                  {s.value === c.strategy && <span className="tag">Selected</span>}
                </h3>
                <p>{STRATEGY_HELP[s.value].plain}</p>
                <div className="best-for">Best for: {STRATEGY_HELP[s.value].bestFor}</div>
              </div>
            ))}
          </div>
        </Sheet>
        <Stepper label="Working sets" value={c.workingSets} onChange={(v) => setP({ workingSets: v ?? 1 })} step={1} min={1} max={10} integer />
        {err('workingSets')}
        <div className="two-col">
          <Stepper label={tb ? 'Min seconds' : 'Min reps'} value={c.minReps} onChange={(v) => setP({ minReps: v ?? 1 })} step={tb ? 5 : 1} min={1} max={tb ? 3600 : 100} integer />
          <Stepper label={tb ? 'Max seconds' : 'Max reps'} value={c.maxReps} onChange={(v) => setP({ maxReps: v ?? 1 })} step={tb ? 5 : 1} min={1} max={tb ? 3600 : 100} integer />
        </div>
        {err('minReps')}
        {err('maxReps')}
        {!tb && (
          <div className="field">
            <span className="label">Target RIR</span>
            <Chips label="Target RIR" value={c.targetRir} onChange={(v) => setP({ targetRir: v ?? 2 })} fill options={[0, 1, 2, 3, 4, 5].map((v) => ({ value: v, label: String(v) }))} />
          </div>
        )}
        <div className="field">
          <span className="label">Load increment ({form.unit}); 0 = no load progression</span>
          <Chips label="Load increment" value={c.loadIncrement} onChange={(v) => setP({ loadIncrement: v ?? 0 })} options={(form.unit === 'kg' ? [0, 0.5, 1, 1.25, 2.5, 5] : form.unit === 'plt' ? [0, 1, 2, 3] : [0, 1, 2.5, 5, 10]).map((v) => ({ value: v, label: String(v) }))} />
          <Stepper label="Custom increment" value={c.loadIncrement} onChange={(v) => setP({ loadIncrement: v ?? 0 })} step={form.unit === 'plt' ? 1 : form.unit === 'kg' ? 0.25 : 0.5} min={0} max={100} decimals={2} />
          {err('loadIncrement')}
        </div>
        {tb && <Stepper label="Seconds added per progression" value={c.timeIncrementSeconds} onChange={(v) => setP({ timeIncrementSeconds: v ?? 5 })} step={1} min={1} max={120} integer />}
        <div className="two-col">
          <Stepper label="Min load (optional)" value={c.minLoad} onChange={(v) => setP({ minLoad: v })} step={c.loadIncrement || 5} allowEmpty placeholder="—" />
          <Stepper label="Max load (optional)" value={c.maxLoad} onChange={(v) => setP({ maxLoad: v })} step={c.loadIncrement || 5} allowEmpty placeholder="—" />
        </div>
        {err('minLoad')}
        {err('maxLoad')}
        {!hasHistory && <Stepper label="Starting load for the first session (optional)" value={c.startingLoad} onChange={(v) => setP({ startingLoad: v })} step={c.loadIncrement || 5} allowEmpty placeholder="—" />}
        {err('startingLoad')}

        <h2 className="section">Deload</h2>
        <div className="field">
          <label htmlFor="ex-deload">When progress stalls</label>
          <select id="ex-deload" value={c.deloadStrategy} onChange={(e) => setP({ deloadStrategy: e.target.value as ProgressionConfig['deloadStrategy'] })}>
            {DELOAD_STRATEGIES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </div>
        {c.deloadStrategy !== 'none' && (
          <div className="two-col">
            <Stepper label="Stall sessions" value={c.stallSessionsBeforeDeload} onChange={(v) => setP({ stallSessionsBeforeDeload: v ?? 3 })} step={1} min={2} max={10} integer />
            {c.deloadStrategy === 'reduce-load' && <Stepper label="Deload %" value={c.deloadPercent} onChange={(v) => setP({ deloadPercent: v ?? 10 })} step={5} min={1} max={50} integer />}
          </div>
        )}
        <div className="field">
          <label htmlFor="ex-notes">Notes</label>
          <textarea id="ex-notes" maxLength={500} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Setup, seat position, cues" />
        </div>

        <button className="btn primary big" onClick={save}>
          Save
        </button>
        {existing &&
          (hasHistory ? (
            <button className="btn block" onClick={async () => { if (await commit((d, ctx) => S.setExerciseArchived(d, existing.id, !existing.archived, ctx))) { notify(existing.archived ? 'Restored.' : 'Archived. History is kept.'); nav.back(); } }}>
              {existing.archived ? 'Restore exercise' : 'Archive exercise (keeps history)'}
            </button>
          ) : (
            <button className="btn danger block" onClick={() => setConfirmDelete(true)}>
              Delete exercise
            </button>
          ))}
      </div>
      <Confirm
        open={confirmDelete}
        danger
        title="Delete exercise?"
        confirmLabel="Delete"
        body="It has never been logged, so no history is lost. It will be removed from routines."
        onClose={() => setConfirmDelete(false)}
        onConfirm={async () => {
          if (existing && (await commit((d) => S.deleteExercise(d, existing.id)))) nav.back();
        }}
      />
    </>
  );
}

// ───────────────────────── routines ─────────────────────────

export function Routines({ nav }: { nav: Nav }) {
  const { ds, commit, run } = useStore();
  const [routineId, setRoutineId] = useState<string | null>(ds.settings.activeRoutineId ?? ds.routines[0]?.id ?? null);
  const routine = ds.routines.find((r) => r.id === routineId) ?? ds.routines[0];
  const [picking, setPicking] = useState<string | null>(null);
  const [naming, setNaming] = useState<{ kind: 'routine-new' | 'routine' | 'day-new' | 'day'; id?: string; value: string } | null>(null);
  const [confirmDel, setConfirmDel] = useState<{ kind: 'routine' | 'day'; id: string; name: string } | null>(null);
  const exById = new Map(ds.exercises.map((e) => [e.id, e]));

  const saveName = async () => {
    if (!naming) return;
    const v = naming.value;
    if (naming.kind === 'routine-new') {
      const res = await run((d, ctx) => S.createRoutine(d, v, ['Day 1'], ctx));
      if (res) setRoutineId(res.id);
    } else if (naming.kind === 'routine' && naming.id) await commit((d) => S.renameRoutine(d, naming.id as string, v));
    else if (naming.kind === 'day-new' && routine) await commit((d, ctx) => S.addRoutineDay(d, routine.id, v, ctx));
    else if (naming.kind === 'day' && naming.id) await commit((d) => S.renameRoutineDay(d, naming.id as string, v));
    setNaming(null);
  };

  return (
    <>
      <TopBar title="Routine builder" onBack={nav.back} right={<button className="btn small" onClick={() => setNaming({ kind: 'routine-new', value: '' })}><Icon name="plus" size={16} /> Routine</button>} />
      <div className="stack">
        {!routine ? (
          <Empty title="No routines yet" action={<button className="btn primary" onClick={() => setNaming({ kind: 'routine-new', value: '' })}>Create a routine</button>}>
            A routine is an ordered list of days. The coach rotates through them.
          </Empty>
        ) : (
          <>
            {ds.routines.length > 1 && (
              <Chips label="Routine" value={routine.id} onChange={(v) => v && setRoutineId(String(v))} options={ds.routines.map((r) => ({ value: r.id, label: r.name, className: 'text' }))} />
            )}
            <div className="card">
              <div className="spread">
                <div>
                  <h3 style={{ margin: 0 }}>{routine.name}</h3>
                  <div className="small muted">{ds.settings.activeRoutineId === routine.id ? 'Active routine' : 'Not active'}</div>
                </div>
                <div className="row">
                  <button className="icon-btn" aria-label="Rename routine" onClick={() => setNaming({ kind: 'routine', id: routine.id, value: routine.name })}><Icon name="edit" /></button>
                  <button className="icon-btn" aria-label="Delete routine" onClick={() => setConfirmDel({ kind: 'routine', id: routine.id, name: routine.name })}><Icon name="x" /></button>
                </div>
              </div>
              {ds.settings.activeRoutineId !== routine.id && (
                <button className="btn small" style={{ marginTop: 8 }} onClick={() => commit((d, ctx) => S.updateSettings(d, { activeRoutineId: routine.id }, ctx))}>
                  Make active
                </button>
              )}
            </div>
            {routine.dayIds.map((dayId, i) => {
              const day = ds.routineDays.find((d) => d.id === dayId);
              if (!day) return null;
              return (
                <section key={day.id} className="card" aria-label={day.name}>
                  <div className="spread">
                    <h3 style={{ margin: 0 }}>{day.name}</h3>
                    <div className="row">
                      <button className="icon-btn" aria-label={`Move ${day.name} up`} disabled={i === 0} onClick={() => commit((d) => S.moveRoutineDay(d, day.id, -1))}><Icon name="up" size={18} /></button>
                      <button className="icon-btn" aria-label={`Move ${day.name} down`} disabled={i === routine.dayIds.length - 1} onClick={() => commit((d) => S.moveRoutineDay(d, day.id, 1))}><Icon name="down" size={18} /></button>
                      <button className="icon-btn" aria-label={`Rename ${day.name}`} onClick={() => setNaming({ kind: 'day', id: day.id, value: day.name })}><Icon name="edit" size={18} /></button>
                      <button className="icon-btn" aria-label={`Remove ${day.name}`} onClick={() => setConfirmDel({ kind: 'day', id: day.id, name: day.name })}><Icon name="x" size={18} /></button>
                    </div>
                  </div>
                  <div className="list" style={{ marginTop: 8 }}>
                    {day.exerciseIds.length === 0 && <div className="list-item muted small">No exercises yet.</div>}
                    {day.exerciseIds.map((exId, j) => (
                      <div key={exId} className="list-item" style={{ minHeight: 48, padding: '4px 6px 4px 12px' }}>
                        <span className="grow">{exById.get(exId)?.name ?? 'Unknown'}</span>
                        <button className="icon-btn" aria-label="Move up" disabled={j === 0} onClick={() => commit((d) => S.moveDayExercise(d, day.id, exId, -1))}><Icon name="up" size={16} /></button>
                        <button className="icon-btn" aria-label="Move down" disabled={j === day.exerciseIds.length - 1} onClick={() => commit((d) => S.moveDayExercise(d, day.id, exId, 1))}><Icon name="down" size={16} /></button>
                        <button className="icon-btn" aria-label="Remove from day" onClick={() => commit((d) => S.setDayExercises(d, day.id, day.exerciseIds.filter((x) => x !== exId)))}><Icon name="x" size={16} /></button>
                      </div>
                    ))}
                  </div>
                  <button className="btn small block" style={{ marginTop: 8 }} onClick={() => setPicking(day.id)}>
                    <Icon name="plus" size={16} /> Add exercises
                  </button>
                </section>
              );
            })}
            <button className="btn block" onClick={() => setNaming({ kind: 'day-new', value: `Day ${routine.dayIds.length + 1}` })}>
              <Icon name="plus" size={16} /> Add day
            </button>
          </>
        )}
      </div>

      <Sheet open={naming !== null} title={naming?.kind.startsWith('routine') ? 'Routine name' : 'Day name'} onClose={() => setNaming(null)}>
        <div className="stack">
          <input className="input" autoFocus value={naming?.value ?? ''} maxLength={40} onChange={(e) => naming && setNaming({ ...naming, value: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && saveName()} aria-label="Name" />
          <button className="btn primary block" onClick={saveName}>Save</button>
        </div>
      </Sheet>
      <DayExercisePicker dayId={picking} onClose={() => setPicking(null)} />
      <Confirm
        open={confirmDel !== null}
        danger
        title={`Remove ${confirmDel?.name ?? ''}?`}
        confirmLabel="Remove"
        body="Past workouts keep their names and data. Only the plan changes."
        onClose={() => setConfirmDel(null)}
        onConfirm={() => {
          if (!confirmDel) return;
          if (confirmDel.kind === 'routine') void commit((d, ctx) => S.deleteRoutine(d, confirmDel.id, ctx));
          else void commit((d) => S.removeRoutineDay(d, confirmDel.id));
        }}
      />
    </>
  );
}

function DayExercisePicker({ dayId, onClose }: { dayId: string | null; onClose: () => void }) {
  const { ds, commit } = useStore();
  const day = ds.routineDays.find((d) => d.id === dayId);
  const [sel, setSel] = useState<string[]>([]);
  const [key, setKey] = useState<string | null>(null);
  if (day && key !== day.id) {
    setKey(day.id);
    setSel(day.exerciseIds);
  }
  const list = ds.exercises.filter((e) => !e.archived).sort((a, b) => a.muscleGroup.localeCompare(b.muscleGroup) || a.name.localeCompare(b.name));
  return (
    <Sheet open={Boolean(day)} title={`Exercises for ${day?.name ?? ''}`} onClose={() => { setKey(null); onClose(); }}>
      <div className="stack">
        <div className="list">
          {list.map((e) => (
            <label key={e.id} className="list-item">
              <input type="checkbox" checked={sel.includes(e.id)} onChange={(ev) => setSel(ev.target.checked ? [...sel, e.id] : sel.filter((x) => x !== e.id))} style={{ width: 22, height: 22 }} />
              <span className="grow">
                <span className="title" style={{ display: 'block' }}>{e.name}</span>
                <span className="meta">{cap(e.muscleGroup)}</span>
              </span>
            </label>
          ))}
        </div>
        <button className="btn primary block" onClick={async () => { if (day && (await commit((d) => S.setDayExercises(d, day.id, sel)))) { setKey(null); onClose(); } }}>
          Save ({sel.length})
        </button>
      </div>
    </Sheet>
  );
}

// ───────────────────────── settings ─────────────────────────

export function Settings({ nav }: { nav: Nav }) {
  const { ds, commit } = useStore();
  const s = ds.settings;
  const [theme, setTheme] = useState<ThemePref>(readTheme());
  const upd = (patch: Parameters<typeof S.updateSettings>[1]) => commit((d, ctx) => S.updateSettings(d, patch, ctx));
  return (
    <>
      <TopBar title="Settings" onBack={nav.back} />
      <div className="stack">
        <div className="card">
          <div className="field">
            <span className="label">Default unit for new exercises</span>
            <Segmented label="Default unit" value={s.defaultUnit} onChange={(u) => upd({ defaultUnit: u })} options={[{ value: 'lb', label: 'lb' }, { value: 'kg', label: 'kg' }, { value: 'plt', label: 'plt' }]} />
            <span className="hint">Each exercise keeps its own unit. Mixed-unit history is converted by the engine.</span>
          </div>
        </div>
        <div className="card">
          <Toggle label="Readiness check-in" hint="Offer the optional check-in before a workout. It adjusts that day only." checked={s.askReadiness} onChange={(v) => upd({ askReadiness: v })} />
          <Toggle label="Ask RIR confidence" hint="Show a 1–5 'how sure' row after picking RIR. Low confidence reduces RIR's influence." checked={s.askRirConfidence} onChange={(v) => upd({ askRirConfidence: v })} />
          <div className="field" style={{ paddingTop: 10 }}>
            <span className="label">Assumed confidence when not asked</span>
            <Chips label="Default RIR confidence" value={s.defaultRirConfidence} onChange={(v) => v && upd({ defaultRirConfidence: v })} fill options={[1, 2, 3, 4, 5].map((v) => ({ value: v, label: String(v) }))} />
            <span className="hint">4 means RIR counts at 75% weight. 1 means RIR is ignored and only reps and load decide.</span>
          </div>
        </div>
        <div className="card">
          <div className="field">
            <span className="label">Theme</span>
            <Segmented label="Theme" value={theme} onChange={(t) => { setTheme(t); applyTheme(t); }} options={[{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} />
          </div>
        </div>
      </div>
    </>
  );
}

// ───────────────────────── backup ─────────────────────────

const stamp = () => new Date().toISOString().slice(0, 10);

export function Backup({ nav }: { nav: Nav }) {
  const { ds, replaceAll, notify, storage } = useStore();
  const [manual, setManual] = useState<{ filename: string; text: string } | null>(null);
  const [paste, setPaste] = useState('');
  const [parsed, setParsed] = useState<ParseResult | null>(null);
  const [confirm, setConfirm] = useState<'replace' | 'fresh' | 'erase' | 'demo' | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const counts = { workouts: ds.workoutSessions.filter((w) => w.status === 'completed').length, exercises: ds.exercises.length, sets: ds.exerciseSessions.reduce((a, s) => a + s.sets.filter((x) => x.status === 'completed' || x.status === 'failed').length, 0) };

  const save = async (filename: string, text: string, mime: string) => {
    const r = await saveTextFile(filename, text, mime);
    if (r.kind === 'saved') notify(`Saved ${filename}`, 'success');
    else if (r.kind === 'declined') notify('Save cancelled.');
    else if (r.kind === 'error') notify(r.message, 'error');
    else setManual({ filename: r.filename, text: r.text });
  };
  const load = (text: string) => {
    const r = parseBackup(text, nowIso());
    setParsed(r);
    if (!r.ok) notify(r.error, 'error');
  };
  const doMerge = async (incoming: Dataset) => {
    const m = mergeDatasets(ds, incoming);
    if (await replaceAll(m.dataset)) {
      const added = Object.values(m.added).reduce((a, b) => a + b, 0);
      notify(`Merged: ${added} records added, ${Object.values(m.kept).reduce((a, b) => a + b, 0)} already present.${m.notes.length ? ` ${m.notes.join(' ')}` : ''}`, 'success');
      setParsed(null);
      setPaste('');
    }
  };

  return (
    <>
      <TopBar title="Backup & restore" onBack={nav.back} />
      <div className="stack">
        {storage === 'memory' && <div className="banner warn">Storage is in memory only on this device. Export a backup before closing.</div>}
        <div className="card">
          <h3>Export</h3>
          <div className="small muted" style={{ marginBottom: 10 }}>
            {counts.workouts} workouts, {counts.exercises} exercises, {counts.sets} logged sets.
          </div>
          <div className="stack">
            <button className="btn primary block" onClick={() => save(`gym-coach-backup-${stamp()}.json`, serializeBackup(ds, nowIso()), 'application/json')}>
              Export full backup (JSON)
            </button>
            <button className="btn block" onClick={() => save(`gym-coach-sets-${stamp()}.csv`, toCsv(ds), 'text/csv')}>
              Export workout history (CSV)
            </button>
          </div>
          <div className="small muted" style={{ marginTop: 8 }}>JSON restores everything (schema version 1). CSV is one row per set, for spreadsheets.</div>
        </div>

        <div className="card">
          <h3>Import a JSON backup</h3>
          <div className="stack">
            <input ref={fileRef} type="file" accept=".json,application/json" className="sr-only" id="import-file" onChange={async (e) => { const f = e.target.files?.[0]; if (f) load(await f.text()); e.target.value = ''; }} />
            <button className="btn block" onClick={() => fileRef.current?.click()}>Choose a file</button>
            <div className="field">
              <label htmlFor="paste">Or paste the JSON</label>
              <textarea id="paste" className="input" value={paste} onChange={(e) => setPaste(e.target.value)} spellCheck={false} placeholder='{"app":"gym-progression-coach", …}' />
            </div>
            <button className="btn block" disabled={!paste.trim()} onClick={() => load(paste)}>Check pasted backup</button>
            {parsed?.ok && (
              <div className="banner info small" role="status">
                <strong>Backup is valid.</strong> Schema {parsed.schemaVersion}
                {parsed.exportedAt ? `, exported ${new Date(parsed.exportedAt).toLocaleString()}` : ''}. Contains {parsed.counts.workoutSessions} workouts, {parsed.counts.exercises} exercises, {parsed.counts.exerciseSessions} exercise sessions.
                {parsed.warnings.length > 0 && (
                  <ul className="reasons">
                    {parsed.warnings.map((w, i) => <li key={i}>{w}</li>)}
                  </ul>
                )}
                <div className="btn-row" style={{ marginTop: 10 }}>
                  <button className="btn small" onClick={() => doMerge(parsed.dataset)}>Merge into mine</button>
                  <button className="btn small danger" onClick={() => setConfirm('replace')}>Replace all</button>
                </div>
                <div style={{ marginTop: 6 }}>Merge adds records you don't have and keeps yours on conflicts. Replace swaps everything.</div>
              </div>
            )}
            {parsed && !parsed.ok && <div className="banner pain small" role="alert">{parsed.error}</div>}
          </div>
        </div>

        <div className="card">
          <h3>Reset</h3>
          <div className="stack">
            <button className="btn block" onClick={() => setConfirm('fresh')}>Start fresh, keep exercises and routines</button>
            <button className="btn block" onClick={() => setConfirm('demo')}>Load example data</button>
            <button className="btn danger block" onClick={() => setConfirm('erase')}>Erase everything</button>
          </div>
        </div>
      </div>

      <Sheet open={manual !== null} title="Copy your file" onClose={() => setManual(null)}>
        <div className="stack">
          <div className="small">This view can't save files directly. Copy the text below and save it as <strong>{manual?.filename}</strong>.</div>
          <textarea className="input" readOnly value={manual?.text ?? ''} style={{ minHeight: 220, fontFamily: 'ui-monospace, monospace', fontSize: 12 }} onFocus={(e) => e.currentTarget.select()} aria-label="File contents" />
          <button className="btn primary block" onClick={async () => { try { await navigator.clipboard.writeText(manual?.text ?? ''); notify('Copied.', 'success'); } catch { notify('Select the text and copy it manually.', 'error'); } }}>Copy to clipboard</button>
        </div>
      </Sheet>
      <Confirm open={confirm === 'replace'} danger title="Replace all data?" confirmLabel="Replace" onClose={() => setConfirm(null)} body="Everything on this device is replaced by the backup. Export your current data first if you might need it." onConfirm={async () => { if (parsed?.ok && (await replaceAll(parsed.dataset))) { notify('Backup restored.', 'success'); setParsed(null); setPaste(''); } }} />
      <Confirm open={confirm === 'fresh'} danger title="Remove all workout history?" confirmLabel="Remove history" onClose={() => setConfirm(null)} body="Workouts, sets, recommendations, PRs and readiness are deleted. Exercises, their settings and routines stay. Export a backup first if unsure." onConfirm={async () => { if (await replaceAll({ ...ds, workoutSessions: [], exerciseSessions: [], recommendations: [], personalRecords: [], readiness: [], substitutions: [] })) notify('History cleared. Your first sessions will set new baselines.', 'success'); }} />
      <Confirm open={confirm === 'demo'} danger title="Load example data?" confirmLabel="Load example" onClose={() => setConfirm(null)} body="Your current data is replaced by the example routine and 5 weeks of sample history." onConfirm={async () => { if (await replaceAll(buildDemo())) notify('Example data loaded.', 'success'); }} />
      <Confirm open={confirm === 'erase'} danger title="Erase everything?" confirmLabel="Erase" onClose={() => setConfirm(null)} body="All exercises, routines and history on this device are deleted. This can't be undone without a backup." onConfirm={async () => { if (await replaceAll(emptyDataset(defaultSettings(nowIso(), ds.settings.defaultUnit)))) notify('All data erased.'); }} />
    </>
  );
}

// ───────────────────────── rules reference ─────────────────────────

export function RulesScreen({ nav }: { nav: Nav }) {
  const groups: { title: string; ids: string[] }[] = [
    { title: 'Checked first', ids: ['INVALID_CONFIG', 'BASELINE', 'NO_SETS_LOGGED', 'PAIN_REVIEW', 'RESUME_AFTER_DELOAD'] },
    { title: 'Deloads', ids: ['DELOAD_STALL', 'DELOAD_REGRESSION'] },
    { title: 'Below the rep range', ids: ['C_OFF_DAY', 'C_FIRST_BELOW', 'C_REPEATED_BELOW', 'C_FAR_BELOW'] },
    { title: 'Top of the range', ids: ['E_TOP_LOW_RIR', 'A_MAX_LOAD', 'REP_FIRST_CONSOLIDATE', 'D_TOP_HIGH_RIR_BIG', 'A_TOP_OF_RANGE'] },
    { title: 'Inside the range', ids: ['D_HIGH_RIR_EARLY_INCREASE', 'INCOMPLETE_SESSION', 'E_LOW_RIR_HOLD', 'B_ADD_REPS_HIGH_RIR', 'B_ADD_REPS'] },
    { title: 'Load-first and time-based', ids: ['LF_MIN_REACHED', 'LF_BUILD', 'T_BELOW_MIN', 'T_ADD_TIME', 'T_ADD_LOAD', 'T_MAX_TIME'] },
    { title: 'Guard applied last', ids: ['PAIN_CAUTION'] },
  ];
  const r = RULES;
  return (
    <>
      <TopBar title="How progression works" sub={`Engine ${r.engineVersion}`} onBack={nav.back} />
      <div className="stack">
        <div className="card small">
          The coach is a fixed set of rules, not AI. The same history always produces the same target. Rules are checked in the order below; the first one that matches decides, and its reasons are shown with every target.
        </div>
        {groups.map((g) => (
          <section key={g.title} className="card">
            <h3>{g.title}</h3>
            <div className="stack" style={{ gap: 8 }}>
              {g.ids.map((id) => (
                <div key={id}>
                  <div className="rule-id">{id}</div>
                  <div className="small">{RULE_DESCRIPTIONS[id]}</div>
                </div>
              ))}
            </div>
          </section>
        ))}
        <section className="card small">
          <h3>Thresholds</h3>
          <ul className="reasons" style={{ color: 'var(--ink)' }}>
            <li>Top of range: every working set at the max reps; with 3+ sets one set may be {r.topToleranceReps} rep short. A single low set is treated as a one-off.</li>
            <li>RIR counts only when logged on at least {r.rirMinCoverage * 100}% of sets. Its weight is (confidence − 1) / 4, halved when inconsistent (a later set {r.rirInconsistentJump}+ RIR higher with no more reps, or a spread of {r.rirInconsistentSpread}+). Below {r.rirMinWeight * 100}% weight it is ignored.</li>
            <li>"Well above/below target" means a weighted RIR difference of ±{r.rirSubstantiallyHigh}. A difference of {r.rirBigJump}+ at the top of the range earns two increments.</li>
            <li>Below range means at least half the sets under the minimum. "Far below" is an average {r.farBelowMinReps}+ reps under it. Repeated below-range drops load {r.decreasePercent}% (at least one increment).</li>
            <li>Trends use the last {r.trendWindow} sessions. A stall is a session with no load increase and no new rep best at that load; low-readiness and incomplete sessions are neutral. Two stalls warn, the exercise's stall setting (default 3) deloads. Two consecutive drops deload.</li>
            <li>Readiness (mean of readiness, energy and 6 − fatigue, minus a sleep penalty) at or below 2.75 postpones increases today; at or below 1.75 also removes a set and adds 1 RIR. It never changes the baseline.</li>
            <li>Significant pain: never increase, review/replace/skip. Mild pain: hold load and reps.</li>
          </ul>
        </section>
      </div>
    </>
  );
}
