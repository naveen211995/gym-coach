import React, { useState } from 'react';
import { formatNumber, PR_LABELS } from '../../engine';
import { exerciseStats, nextRecommendation } from '../../app/selectors';
import { Empty, Icon, LineChart, Segmented, TopBar, type ChartPoint } from '../components';
import { cap, dayLabel, isTimeBased } from '../format';
import { useStore } from '../store';
import type { Nav } from '../App';
import { prValue } from './Home';

type Metric = 'e1rm' | 'topLoad' | 'volume' | 'totalReps';

export function ProgressScreen({ nav }: { nav: Nav }) {
  const { ds } = useStore();
  const withHistory = ds.exercises.filter((e) => ds.exerciseSessions.some((s) => s.exerciseId === e.id && s.status === 'completed')).sort((a, b) => a.name.localeCompare(b.name));
  const [exId, setExId] = useState<string | null>(withHistory[0]?.id ?? null);
  const [metric, setMetric] = useState<Metric>('e1rm');
  const ex = withHistory.find((e) => e.id === exId) ?? withHistory[0];

  if (!ex) {
    return (
      <>
        <TopBar title="Progress" />
        <Empty title="Nothing to chart yet">Complete a workout and your trends appear here.</Empty>
      </>
    );
  }
  const tb = isTimeBased(ex);
  const m: Metric = tb ? 'totalReps' : metric;
  const stats = exerciseStats(ds, ex);
  const prSessions = new Set(stats.records.map((r) => r.exerciseSessionId));
  const points: ChartPoint[] = stats.series.map((p) => ({ date: p.date, y: p[m], highlight: prSessions.has(p.sessionId) }));
  const fmt = (n: number) => (m === 'volume' ? `${Math.round(n / (n >= 10000 ? 1000 : 1))}${n >= 10000 ? 'k' : ''}` : formatNumber(n, m === 'totalReps' ? 0 : 1));
  const metricLabel: Record<Metric, string> = { e1rm: `Estimated 1RM (${ex.unit})`, topLoad: `Top load (${ex.unit})`, volume: `Session volume (${ex.unit})`, totalReps: tb ? 'Total seconds held' : 'Total working reps' };

  return (
    <>
      <TopBar title="Progress" />
      <div className="stack">
        <div className="field">
          <label htmlFor="progress-ex">Exercise</label>
          <select id="progress-ex" value={ex.id} onChange={(e) => setExId(e.target.value)}>
            {withHistory.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        </div>
        {!tb && (
          <Segmented
            label="Metric"
            value={metric}
            onChange={setMetric}
            options={[
              { value: 'e1rm', label: 'e1RM' },
              { value: 'topLoad', label: 'Load' },
              { value: 'volume', label: 'Volume' },
              { value: 'totalReps', label: 'Reps' },
            ]}
          />
        )}
        <section className="card" aria-label={metricLabel[m]}>
          <div className="spread" style={{ marginBottom: 6 }}>
            <strong>{metricLabel[m]}</strong>
            <span className="small muted">{points.length} sessions</span>
          </div>
          <LineChart points={points} format={fmt} label={metricLabel[m]} />
          <div className="small muted" style={{ marginTop: 6 }}>
            Filled dots mark sessions with a PR.{!tb && m === 'e1rm' ? ' Estimated 1RM is a trend indicator, not a measurement.' : ''}
          </div>
        </section>
        <button className="btn block" onClick={() => nav.push({ name: 'exercise', id: ex.id })}>
          Full history and next target <Icon name="chevron" size={16} />
        </button>

        {stats.records.length > 0 && (
          <>
            <h2 className="section">Personal records</h2>
            <div className="list">
              {stats.records.slice(0, 8).map((p) => (
                <div key={p.id} className="list-item">
                  <span className="tag pr"><Icon name="trophy" size={13} /></span>
                  <div className="grow">
                    <div className="title">{PR_LABELS[p.type]}</div>
                    <div className="meta">
                      {prValue(p.type, p.value, p.load, p.reps, p.unit)}
                      {p.previousValue !== null ? `, previous ${formatNumber(p.previousValue, 1)}` : ''} ({dayLabel(p.achievedAt)})
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        <h2 className="section">All exercises: 3-session trend</h2>
        <div className="list">
          {withHistory.map((e) => {
            const rec = nextRecommendation(ds, e);
            const t = rec.trend;
            const tone = t.label === 'improving' ? 'reps' : t.label === 'regressing' ? 'pain' : t.label === 'plateau' ? 'warn' : 'hold';
            return (
              <button key={e.id} className="list-item" onClick={() => setExId(e.id)} aria-pressed={e.id === ex.id}>
                <div className="grow">
                  <div className="title">{e.name}</div>
                  <div className="meta">{t.changePct === null ? 'Not enough data' : `${t.changePct > 0 ? '+' : ''}${formatNumber(t.changePct, 1)}% over the window`}</div>
                </div>
                <span className={`tag tone-${tone}`}>{t.label === 'insufficient-data' ? 'Too early' : cap(t.label)}</span>
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
}
