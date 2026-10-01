import React, { useEffect, useId, useRef, useState } from 'react';
import type { Exercise, NextTarget, RecommendationAction } from '../domain/types';
import { formatNumber, roundTo } from '../engine';
import { ACTION_META, isTimeBased, repsText, type Tone } from './format';

// ───────────────────────── icons ─────────────────────────
const PATHS: Record<string, string> = {
  up: 'M12 19V5M5 12l7-7 7 7',
  down: 'M12 5v14M19 12l-7 7-7-7',
  same: 'M5 12h14M13 6l6 6-6 6',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  flag: 'M5 21V4h11l-1.5 4L16 12H5',
  start: 'M8 5l11 7-11 7z',
  check: 'M5 12.5l4.5 4.5L19 7',
  x: 'M6 6l12 12M18 6L6 18',
  back: 'M15 5l-7 7 7 7',
  chevron: 'M9 5l7 7-7 7',
  home: 'M4 11l8-7 8 7v9h-5v-6H9v6H4z',
  dumbbell: 'M3 10v4M6 7v10M18 7v10M21 10v4M6 12h12',
  history: 'M12 7v5l3 2M3.5 12a8.5 8.5 0 1 0 2.5-6M3 4v4h4',
  chart: 'M4 20h16M6 16l4-5 3 3 5-7',
  menu: 'M4 7h16M4 12h16M4 17h16',
  trophy: 'M8 4h8v5a4 4 0 0 1-8 0zM8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v4M8 20h8',
  alert: 'M12 4l9 16H3zM12 10v4M12 17.5v.5',
  edit: 'M4 20h4L19 9l-4-4L4 16zM13 7l4 4',
  swap: 'M7 7h11l-3-3M17 17H6l3 3',
  skip: 'M6 5l8 7-8 7zM17 5v14',
  help: 'M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.8.35-1 .8-1 1.7v.5M12 17v.1M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z',
};
export function Icon({ name, size = 20, label }: { name: keyof typeof PATHS | string; size?: number; label?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden={label ? undefined : true} role={label ? 'img' : undefined} aria-label={label}>
      <path d={PATHS[name] ?? ''} />
    </svg>
  );
}

/** Small round "?" that opens an explainer sheet. */
export function HelpButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="help-btn" onClick={onClick} aria-label={label}>
      <Icon name="help" size={16} />
    </button>
  );
}

// ───────────────────────── layout ─────────────────────────
export function TopBar({ title, sub, onBack, right }: { title: string; sub?: string; onBack?: () => void; right?: React.ReactNode }) {
  return (
    <header className="topbar">
      {onBack && (
        <button className="back-btn" onClick={onBack} aria-label="Back">
          <Icon name="back" />
        </button>
      )}
      <h1>
        {title}
        {sub && <span className="sub">{sub}</span>}
      </h1>
      {right}
    </header>
  );
}

export function Empty({ title, children, action }: { title: string; children?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="card empty">
      <h3>{title}</h3>
      {children && <div className="small">{children}</div>}
      {action && <div style={{ marginTop: 12 }}>{action}</div>}
    </div>
  );
}

// ───────────────────────── inputs ─────────────────────────
interface StepperProps {
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
  step: number;
  min?: number;
  max?: number;
  decimals?: number;
  allowEmpty?: boolean;
  placeholder?: string;
  hint?: string;
  integer?: boolean;
}

/** Big −/+ stepper with a directly editable number (numeric keypad on phones). */
export function Stepper({ label, value, onChange, step, min = 0, max = 5000, decimals = 2, allowEmpty = false, placeholder, hint, integer = false }: StepperProps) {
  const id = useId();
  const [draft, setDraft] = useState(value === null ? '' : formatNumber(value, decimals));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(value === null ? '' : formatNumber(value, decimals));
  }, [value, decimals]);
  const clamp = (n: number) => Math.max(min, Math.min(max, integer ? Math.round(n) : roundTo(n, decimals)));
  const parse = (s: string): number | null | undefined => {
    const t = s.trim().replace(',', '.');
    if (t === '') return allowEmpty ? null : undefined;
    const n = Number(t);
    return Number.isFinite(n) ? clamp(n) : undefined;
  };
  const bump = (dir: 1 | -1) => {
    const base = value ?? (dir > 0 ? min - step : min);
    const next = clamp(roundTo(base + dir * step, 4));
    if (allowEmpty && dir < 0 && value !== null && value <= min) onChange(null);
    else onChange(next);
  };
  return (
    <div className="stepper">
      <label className="stepper-label" htmlFor={id}>
        <span>{label}</span>
        {hint && <span className="muted">{hint}</span>}
      </label>
      <div className="stepper-row">
        <button type="button" onClick={() => bump(-1)} aria-label={`Decrease ${label}`}>
          −
        </button>
        <input
          id={id}
          inputMode={integer ? 'numeric' : 'decimal'}
          value={draft}
          placeholder={placeholder}
          onFocus={(e) => {
            focused.current = true;
            e.currentTarget.select();
          }}
          onChange={(e) => {
            setDraft(e.target.value);
            const v = parse(e.target.value);
            if (v !== undefined) onChange(v);
          }}
          onBlur={() => {
            focused.current = false;
            const v = parse(draft);
            setDraft(v === undefined ? (value === null ? '' : formatNumber(value, decimals)) : v === null ? '' : formatNumber(v, decimals));
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
          }}
        />
        <button type="button" onClick={() => bump(1)} aria-label={`Increase ${label}`}>
          +
        </button>
      </div>
    </div>
  );
}

export function Chips<T extends string | number>({ options, value, onChange, label, className = '', allowDeselect = false, fill = false }: { options: { value: T; label: string; className?: string }[]; value: T | null; onChange: (v: T | null) => void; label: string; className?: string; allowDeselect?: boolean; fill?: boolean }) {
  return (
    <div className={`chips ${fill ? 'fill' : ''} ${className}`} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          className={`chip ${o.className ?? ''}`}
          onClick={() => onChange(allowDeselect && value === o.value ? null : o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Segmented<T extends string>({ options, value, onChange, label }: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void; label: string }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={value === o.value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  const id = useId();
  return (
    <div className="toggle">
      <label htmlFor={id} className="grow">
        <div style={{ fontWeight: 600 }}>{label}</div>
        {hint && <div className="small muted">{hint}</div>}
      </label>
      <input id={id} type="checkbox" role="switch" className="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </div>
  );
}

// ───────────────────────── sheet ─────────────────────────
export function Sheet({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // Held in a ref so the effect depends only on `open`: a parent re-render that
  // passes a fresh onClose must not re-run it and yank focus out of an input.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    if (!ref.current?.contains(document.activeElement)) ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [open]);
  if (!open) return null;
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} ref={ref} onClick={(e) => e.stopPropagation()}>
        <div className="spread" style={{ marginBottom: 12 }}>
          <h2 id={titleId}>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Confirm({ open, title, body, confirmLabel, danger, onConfirm, onClose }: { open: boolean; title: string; body: React.ReactNode; confirmLabel: string; danger?: boolean; onConfirm: () => void; onClose: () => void }) {
  return (
    <Sheet open={open} title={title} onClose={onClose}>
      <div className="stack">
        <div>{body}</div>
        <div className="btn-row">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className={`btn ${danger ? 'danger solid' : 'primary'}`}
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </Sheet>
  );
}

// ───────────────────────── recommendation display ─────────────────────────
export function ActionTag({ action }: { action: RecommendationAction }) {
  const m = ACTION_META[action];
  return (
    <span className={`tag tone-${m.tone}`}>
      <Icon name={m.icon} size={13} />
      {m.label}
    </span>
  );
}

export const toneOf = (action: RecommendationAction): Tone => ACTION_META[action].tone;

/** The target "plate": what to lift, in big numbers, with the reason right under it. */
export function TargetPlate({
  action,
  target,
  exercise,
  summary,
  reasons,
  ruleId,
  compact = false,
  showReasons = true,
  extra,
}: {
  action: RecommendationAction;
  target: NextTarget;
  exercise: Exercise;
  summary?: string;
  reasons: readonly string[];
  ruleId?: string;
  compact?: boolean;
  showReasons?: boolean;
  extra?: React.ReactNode;
}) {
  const m = ACTION_META[action];
  const tb = isTimeBased(exercise);
  const loadBig = target.load === null ? 'Your pick' : target.load === 0 ? (tb ? 'Bodyweight' : 'Bodyweight') : formatNumber(target.load);
  return (
    <section className={`plate tone-${m.tone} ${compact ? 'compact' : ''}`} aria-label={`Target: ${summary ?? m.label}`}>
      <div className="plate-head">
        <span className="plate-action">
          <Icon name={m.icon} size={16} />
          {m.label}
        </span>
        {ruleId && <span className="rule-id">{ruleId}</span>}
      </div>
      <div className="plate-load">
        {loadBig}
        {target.load !== null && target.load > 0 && <span className="unit">{target.unit}</span>}
      </div>
      <div className="plate-reps">
        {repsText(target.repTargets, tb)}
        {!tb && <span className="rir">RIR {formatNumber(target.targetRir)}</span>}
      </div>
      {summary && !compact && <div className="plate-summary">{summary}</div>}
      {showReasons && reasons.length > 0 && (
        <ul className="reasons">
          {reasons.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      )}
      {extra}
    </section>
  );
}

// ───────────────────────── chart ─────────────────────────
export interface ChartPoint {
  date: string;
  y: number;
  highlight?: boolean;
}

export function LineChart({ points, format, label }: { points: ChartPoint[]; format: (n: number) => string; label: string }) {
  const W = 340;
  const H = 180;
  const pad = { l: 44, r: 12, t: 12, b: 26 };
  if (points.length === 0) return <div className="muted small">No data yet.</div>;
  const ys = points.map((p) => p.y);
  let lo = Math.min(...ys);
  let hi = Math.max(...ys);
  if (hi - lo < 1e-9) {
    lo -= 1;
    hi += 1;
  }
  const span = hi - lo;
  lo -= span * 0.12;
  hi += span * 0.12;
  const x = (i: number) => pad.l + (points.length === 1 ? (W - pad.l - pad.r) / 2 : (i / (points.length - 1)) * (W - pad.l - pad.r));
  const y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b);
  const ticks = [lo + (hi - lo) * 0.15, (lo + hi) / 2, hi - (hi - lo) * 0.15];
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.y).toFixed(1)}`).join(' ');
  const first = points[0] as ChartPoint;
  const last = points[points.length - 1] as ChartPoint;
  const fmtD = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${label}: from ${format(first.y)} on ${fmtD(first.date)} to ${format(last.y)} on ${fmtD(last.date)}`}>
      {ticks.map((t, i) => (
        <g key={i}>
          <line className="grid" x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} />
          <text x={pad.l - 6} y={y(t) + 4} textAnchor="end">
            {format(t)}
          </text>
        </g>
      ))}
      <path className="line" d={d} />
      {points.map((p, i) => (
        <circle key={i} className={`pt ${p.highlight ? 'pr' : ''}`} cx={x(i)} cy={y(p.y)} r={p.highlight ? 5 : 3.5}>
          <title>{`${fmtD(p.date)}: ${format(p.y)}${p.highlight ? ' (PR)' : ''}`}</title>
        </circle>
      ))}
      <text x={pad.l} y={H - 6}>
        {fmtD(first.date)}
      </text>
      <text x={W - pad.r} y={H - 6} textAnchor="end">
        {fmtD(last.date)}
      </text>
    </svg>
  );
}
