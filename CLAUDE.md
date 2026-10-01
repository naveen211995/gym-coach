# Gym Progression Coach — Project Guide for Claude Code

This file is read automatically by Claude Code at the start of every session in
this repo. It captures the non-negotiable product principles and architecture
this app was built under. Follow it for every future change — don't relax
these rules just because a shortcut seems faster.

## What this app is

A mobile-first, offline-first workout tracker that records completed workouts
and automatically calculates the next recommended target (weight/reps/RIR)
for every exercise. The core value is: *"I finished today's exercise. Tell me
exactly what I should do next time, explain why, and use everything I've
previously logged."* Charts and polish are secondary to that.

## Non-negotiable product principles

1. The progression engine is **deterministic and rule-based** — never call an
   LLM or any external API to compute a recommendation.
2. Every recommendation must be **explainable**: show the reason(s) behind it,
   not just the number.
3. **Never silently overwrite historical workout data.** Edits/imports must be
   additive or explicit, never destructive without the user's clear intent.
4. All progression-engine behavior must be covered by **automated tests**.
5. The app must work **fully offline**, including a cold launch from the
   home screen, and needs **no backend** for core functionality — everything
   is local-first. React is bundled into the HTML (never fetched from a CDN
   at runtime) and a service worker caches the shell, so a launch with no
   signal still works. Don't reintroduce a runtime dependency on a CDN.
6. **No external paid APIs.** No authentication unless absolutely necessary.
   No unnecessary dependencies.
7. Design for **fast gym usage on a phone**: large tap targets, numeric
   steppers, minimal typing, swipe-friendly.
8. Support **JSON export/import** and **CSV export** for backup — JSON must
   carry a schema version for future migrations.
9. Data is stored locally via **IndexedDB**. There is no sync between devices
   — each browser/device has its own independent local copy. (JSON
   export/import is the user's manual "sync" mechanism between devices.)

## Architecture — strict separation of concerns

```
src/domain/    Pure types, constants, defaults, and the Change model.
               No logic, no I/O.
src/engine/    Pure, deterministic progression-calculation logic.
               No React, no storage, no side effects. Fully unit-testable
               in isolation.
src/storage/   IndexedDB repository, JSON backup (schema-versioned),
               CSV export.
src/app/       Glue layer: services shaped as (dataset, input, ctx) → Change,
               selectors for reading derived data, seed/demo data.
src/ui/        React screens and components. Reads data via selectors,
               acts via services. UI MUST NOT contain progression logic —
               it only calls into src/engine and src/app.
```

**Rule: progression calculations never live inside a React component.** If
you're tempted to compute a recommendation inline in a `.tsx` file, stop —
it belongs in `src/engine`, covered by tests, and the component just renders
the result.

`node build.mjs` (esbuild) generates **five files at the repo root**, all
committed, all deployed, none to be hand-edited — edit `src/` and rebuild:

```
index.html                 the app: React, CSS and icons all inlined
sw.js                      service worker (from src/ui/sw.js, build id injected)
manifest.webmanifest       standalone / installable metadata
icon-512.png               icons the manifest points at
apple-touch-icon-180.png
```

`index.html` on its own is still a complete, self-contained working app. The
other four are progressive enhancement for the installed experience: without
them you lose offline launch and fullscreen, nothing else. A service worker
cannot be inlined into HTML — it needs its own URL and scope — which is why
the build is no longer a single file.

There is no server component. GitHub Pages can only serve a branch root or
`/docs`, never a `/dist` folder, so these live at the root and there is
deliberately no second copy of any artifact to drift out of sync.

**Every URL in the build must be relative** (`./sw.js`, `start_url: "./"`).
Pages serves this project from `/<repo>/`, not the domain root, so an absolute
`/sw.js` would 404.

## Development approach for any non-trivial change

Before implementing a significant feature:
1. Explain the proposed architecture/approach.
2. Identify which files will change.
3. Identify edge cases.
4. Write or update tests.
5. Implement the feature.
6. Run tests (`npx vitest run`, `npx tsc --noEmit`).
7. Rebuild (`node build.mjs`, which regenerates the root `index.html`) and
   re-run the E2E suite
   (`e2e_smoke.py`, `focus_regression.py`, `offline_pwa.py` in `tests/e2e/`).
8. Inspect the result, fix any issues found.

Prefer simplicity, correctness, and maintainability over "fashionable"
rewrites or architectural changes without a concrete need.

## Progression engine specifics

Per-exercise configurable: muscle group, equipment, unit (lb/kg/plt), working
sets, min/max reps, target RIR, load increment, optional min/max load,
progression strategy, deload strategy.

Default strategy: **RIR-aware double progression** (e.g. 3×8–12 @ RIR 2).

Supported strategies: `double`, `load-first`, `rep-first`, `time-based`
(for holds/cardio). Supported deload strategies: `reduce-load`,
`reduce-sets`, `none`.

Core behaviors (see `src/engine/rules.ts` for the authoritative rule IDs and
reasons text):
- Top of rep range on essentially all sets at target RIR → increase load.
- Inside range but not yet earned a load increase → keep load, push reps.
- Clearly below minimum reps → hold or reduce load depending on recent
  history (never overreact to one bad set).
- RIR substantially above target at top of range → consider bigger load jump.
- RIR substantially below target → avoid aggressive increases, favor holding.
- Uses a rolling ~3-session window to detect improvement, plateau, and
  regression; detects stalls and repeated regression and can trigger deload.
- RIR is subjective — record per-set RIR plus an optional 1–5 confidence
  score; low-confidence RIR gets reduced weight in the decision, falling back
  more on reps/load history.
- Significant pain on an exercise → never recommend a load increase; flag for
  review (replace/skip), don't compute a normal target.
- Readiness (energy/sleep/fatigue/pain) adjusts *today's* recommendation
  conservatively but never permanently changes the exercise's baseline.

Units: `lb`, `kg` (physically convertible to each other,
`src/engine/units.ts::convertLoad`), and `plt` (plates — a lifter-defined
count, **never converted** to/from lb or kg; treated as identity in
`convertLoad`).

## Testing requirements

The progression engine must have unit test coverage for (non-exhaustive,
see `tests/*.test.ts`): no-history baseline, normal/top-of-range/partial
progression, low-rep performance, high/low/inconsistent RIR, missing/skipped/
failed sets, plateau, regression, deload, decimal load increments, kg/lb
conversion, the `plt` unit (never converted), different rep ranges and set
counts, and invalid/missing inputs. **Never consider a progression-engine
change complete without tests covering it.**

E2E coverage (Playwright, `tests/e2e/`) exercises the built root files from a
real HTTP server on `127.0.0.1` (`harness.py` starts it). The origin must be
`127.0.0.1`/`localhost`, not an invented host: service workers require a
secure context, and on e.g. `http://gym.test` `navigator.serviceWorker` is
undefined. The harness also aborts cdnjs, so if React ever stops being inlined
the suites fail instead of silently using the live CDN.

- `e2e_smoke.py` — every screen, logging, backup round-trip, responsiveness.
- `focus_regression.py` — the Sheet-component focus bug. Don't let a future
  change to `Sheet`/modal focus handling regress it. It documents one known
  remaining gap: on a sheet whose input has `autoFocus`, React focuses that
  input during commit, before `Sheet`'s effect reads `document.activeElement`,
  so focus is not returned to the opener on close.
- `offline_pwa.py` — service worker registers and precaches, the app boots
  with the network fully offline, logged data survives it, and every emitted
  URL is relative.

## Working agreement for Claude Code in this repo

- Keep the file layout and separation above intact for any new feature.
- Any change to recommendation logic goes in `src/engine`, with matching
  tests, never inline in a component.
- After any change: `npx tsc --noEmit`, `npx vitest run`, `node build.mjs`,
  then the Playwright E2E suite, before calling the change done.
- Deploying an update to the phone = run `node build.mjs`, then commit and
  push **all regenerated root files** (`git add -A` covers them) → GitHub
  Pages redeploys in under a minute → reopen the existing Home Screen icon (no
  need to re-add it, unless the icon itself changed). The service worker is
  network-first for the HTML, so a launch with signal picks the update up
  immediately; an offline launch serves the last cached build. Each build gets
  its own cache name, so the old cache is dropped on activate.
  Don't upload files by hand through the web UI: that is what let the artifact
  drift ahead of `src/` before.
- Never introduce a backend, authentication, or a paid API to solve a
  problem — solve it locally/offline first, and say so explicitly if a
  request seems to need one.
