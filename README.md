# Gym Progression Coach

Local-first workout logger with a deterministic, explainable progression engine.
No backend, no account, no external APIs. Data lives in IndexedDB; works offline once loaded.

## Scripts
- `npm run typecheck` – TypeScript strict mode
- `npm test` – unit tests (engine, edge cases, services, backup, seed)
- `npm run build` – single self-contained HTML, written to both `dist/index.html` and the
  repo-root `index.html` (the file people open). The build owns both, so never hand-edit them.
  Set `BUILD_COPY_TO=<dir>` for an extra copy.
- `PLAYWRIGHT_BROWSERS_PATH=… python3 tests/e2e/e2e_smoke.py` – phone-size browser test (after build)

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
