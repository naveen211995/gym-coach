# Gym Progression Coach

Local-first workout logger with a deterministic, explainable progression engine.
No backend, no account, no external APIs, no CDN at runtime. Data lives in IndexedDB.
Installs to a phone home screen and launches fullscreen and offline via a service worker.

## Scripts
- `npm run typecheck` – TypeScript strict mode
- `npm test` – unit tests (engine, edge cases, services, backup, seed)
- `npm run build` – generates five deployed files at the repo root: `index.html`
  (self-contained app, React inlined), `sw.js`, `manifest.webmanifest` and two icons.
  All are generated and committed; never hand-edit them — edit `src/` and rebuild.
  `BUILD_COPY_TO=<dir>` adds an extra copy of the HTML elsewhere.
- `python tests/e2e/e2e_smoke.py`, `focus_regression.py`, `offline_pwa.py` – phone-size
  browser tests (after a build). Needs `pip install playwright && playwright install chromium`.

## Layers (dependencies point downward only)
- `src/domain` – normalized models, defaults, `Change` (a described write)
- `src/engine` – pure progression engine: no I/O, clock or randomness. `recommendNext()`
- `src/storage` – IndexedDB repository (one transaction per change), JSON backup with schema version + migrations, CSV export
- `src/app` – pure services `(dataset, input, ctx) → Change` that enforce history rules; selectors; seed data
- `src/ui` – React screens. They read via selectors and act via services; no progression rules in components.

## History rules
Completed workouts are read-only. Only the single in-progress workout can be edited; editing a completed
exercise reopens it and its recommendation/PRs are recalculated on completion. Exercises with history can be
archived, never deleted. Logged sets keep their own unit.

## Units
`lb`, `kg` and `plt` (plate count, for machines marked in plates). lb and kg convert both ways;
`plt` never converts to or from a real weight, so switching an exercise to or from plates leaves
existing history untouched and only new sets use the new unit.
