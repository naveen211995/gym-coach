import type { Unit } from '../domain/types';

export const KG_PER_LB = 0.45359237;

/** Number of decimal places in a finite number (handles 1e-7 notation). */
export function decimalsOf(n: number): number {
  if (!Number.isFinite(n)) return 0;
  const s = String(n);
  const exp = s.match(/e-(\d+)$/);
  if (exp && exp[1]) return Number(exp[1]);
  const dot = s.indexOf('.');
  return dot === -1 ? 0 : s.length - dot - 1;
}

/** Round half away from zero to a fixed number of decimals, avoiding float noise. */
export function roundTo(n: number, decimals: number): number {
  const d = Math.max(0, Math.min(10, Math.floor(decimals)));
  const f = 10 ** d;
  const r = Math.round(Math.abs(n) * f + 1e-9) / f;
  return n < 0 ? -r : r;
}

/** Snap a value to a multiple of step. */
export function snapToStep(value: number, step: number, mode: 'floor' | 'ceil' | 'nearest'): number {
  if (!(step > 0) || !Number.isFinite(value)) return value;
  const q = value / step;
  const qi = mode === 'floor' ? Math.floor(q + 1e-9) : mode === 'ceil' ? Math.ceil(q - 1e-9) : Math.round(q);
  return roundTo(qi * step, Math.min(6, decimalsOf(step)));
}

/** Add two loads without floating-point artifacts (e.g. 22.5 + 2.5 → 25, 1.1 + 2.2 → 3.3). */
export function addLoad(a: number, b: number): number {
  return roundTo(a + b, Math.min(4, Math.max(decimalsOf(a), decimalsOf(b))));
}

/** Plates are a count, not a weight, so they are never converted to or from lb/kg. */
export function convertLoad(value: number, from: Unit, to: Unit): number {
  if (from === to || from === 'plt' || to === 'plt') return value;
  return from === 'lb' ? value * KG_PER_LB : value / KG_PER_LB;
}

/** Convert and round to 2 decimals — used when normalizing logged sets into the exercise unit. */
export function convertLoadRounded(value: number, from: Unit, to: Unit): number {
  return roundTo(convertLoad(value, from, to), 2);
}

export function formatNumber(n: number, maxDecimals = 2): string {
  return String(roundTo(n, maxDecimals));
}

export function formatLoad(load: number | null, unit: Unit): string {
  if (load === null) return 'your chosen load';
  if (load === 0) return 'bodyweight';
  return `${formatNumber(load)} ${unit}`;
}
