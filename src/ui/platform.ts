/**
 * Browser/platform glue: ids, clock, file saving and theme. No domain logic here.
 */
interface DownloadsNs {
  save(req: { filename: string; data: string | Blob }): Promise<{ status: 'saved' | 'delivered' }>;
}
interface ClaudeGlobal {
  use?: (name: string) => Promise<unknown>;
}

export function newId(prefix: string): string {
  const c = globalThis.crypto as Crypto | undefined;
  const rand = c && typeof c.randomUUID === 'function' ? c.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}_${rand}`;
}

export const nowIso = () => new Date().toISOString();

let downloads: Promise<DownloadsNs | null> | null = null;
/** The viewer's download capability, or null outside a viewer (design for absence). */
export function getDownloads(): Promise<DownloadsNs | null> {
  if (!downloads) {
    const claude = (window as unknown as { claude?: ClaudeGlobal }).claude;
    downloads =
      claude && typeof claude.use === 'function'
        ? Promise.resolve(claude.use('downloads'))
            .then((ns) => (ns && typeof (ns as DownloadsNs).save === 'function' ? (ns as DownloadsNs) : null))
            .catch(() => null)
        : Promise.resolve(null);
  }
  return downloads;
}

function inFrame(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

export type SaveOutcome = { kind: 'saved' } | { kind: 'declined' } | { kind: 'manual'; filename: string; text: string } | { kind: 'error'; message: string };

/** Save text through the viewer's download prompt; fall back to a browser download, then to copy/paste. */
export async function saveTextFile(filename: string, text: string, mime: string): Promise<SaveOutcome> {
  const d = await getDownloads();
  if (d) {
    try {
      await d.save({ filename, data: text });
      return { kind: 'saved' };
    } catch (e) {
      const code = (e as { code?: string } | null)?.code;
      if (code === 'declined') return { kind: 'declined' };
      if (code === 'rate_limited') return { kind: 'error', message: 'A save prompt is already open. Try again in a moment.' };
      // Any other code: saving isn't usable in this view; fall through.
    }
  }
  if (!inFrame()) {
    try {
      const url = URL.createObjectURL(new Blob([text], { type: mime }));
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      return { kind: 'saved' };
    } catch {
      /* fall through */
    }
  }
  return { kind: 'manual', filename, text };
}

export type ThemePref = 'system' | 'light' | 'dark';
const THEME_KEY = 'gpc-theme';
export function readTheme(): ThemePref {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}
export function applyTheme(t: ThemePref): void {
  const root = document.documentElement;
  if (t === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', t);
  try {
    if (t === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, t);
  } catch {
    /* per-viewer convenience only */
  }
}

export function vibrate(ms = 12): void {
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* optional */
  }
}
