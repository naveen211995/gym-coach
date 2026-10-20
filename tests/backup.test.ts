import { describe, expect, it } from 'vitest';
import { buildSeedDataset } from '../src/app/seed';
import { csvCell, mergeDatasets, parseBackup, serializeBackup, toCsv, SCHEMA_VERSION } from '../src/storage/backup';
import { COLLECTIONS } from '../src/domain/types';

let n = 0;
const seed = buildSeedDataset(new Date(2026, 8, 25, 9, 0), (p) => `${p}_${++n}`);
const NOW = '2026-09-25T12:00:00.000Z';

describe('JSON backup', () => {
  it('round-trips the full dataset losslessly', () => {
    const text = serializeBackup(seed, NOW);
    const parsed = parseBackup(text, NOW);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.schemaVersion).toBe(SCHEMA_VERSION);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.dataset).toEqual(seed);
    expect(JSON.parse(text).schemaVersion).toBe(1);
  });
  it('rejects non-JSON, foreign files and newer schemas', () => {
    expect(parseBackup('nope', NOW)).toMatchObject({ ok: false, error: expect.stringMatching(/not valid JSON/) });
    expect(parseBackup('{"app":"other"}', NOW)).toMatchObject({ ok: false, error: expect.stringMatching(/not a Gym Progression Coach/) });
    expect(parseBackup(JSON.stringify({ app: 'gym-progression-coach', schemaVersion: 99, data: {} }), NOW)).toMatchObject({ ok: false, error: expect.stringMatching(/newer version/) });
  });
  it('drops invalid records and orphans with warnings instead of failing', () => {
    const file = JSON.parse(serializeBackup(seed, NOW));
    file.data.exercises[0].progression.strategy = 'magic';
    file.data.workoutSessions.push({ id: 'bad' });
    file.data.settings = 'broken';
    const parsed = parseBackup(JSON.stringify(file), NOW);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.dataset.exercises).toHaveLength(seed.exercises.length - 1);
    // Sessions of the dropped exercise are orphans and are removed too.
    expect(parsed.dataset.exerciseSessions.length).toBe(seed.exerciseSessions.length - 5);
    expect(parsed.warnings.join(' ')).toMatch(/Settings were invalid/);
    expect(parsed.warnings.join(' ')).toMatch(/strategy/);
  });
  it('merge adds only missing records and keeps local on conflict', () => {
    const empty = { ...seed, exercises: seed.exercises.slice(0, 2), workoutSessions: [], exerciseSessions: [], recommendations: [], personalRecords: [], readiness: [] };
    const m = mergeDatasets(empty, seed);
    expect(m.dataset.exercises).toHaveLength(seed.exercises.length);
    expect(m.kept.exercises).toBe(2);
    expect(m.added.workoutSessions).toBe(seed.workoutSessions.length);
    const again = mergeDatasets(seed, seed);
    for (const c of COLLECTIONS) expect(again.added[c]).toBe(0);
  });
});

describe('CSV export', () => {
  it('escapes and neutralizes formula injection', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('@SUM')).toBe("'@SUM");
    expect(csvCell(-5, false)).toBe('-5');
    expect(csvCell(null)).toBe('');
  });
  it('writes one row per set with a header', () => {
    const csv = toCsv(seed);
    const lines = csv.trim().split('\r\n');
    const setCount = seed.exerciseSessions.reduce((a, s) => a + s.sets.length, 0);
    expect(lines).toHaveLength(setCount + 1);
    expect(lines[0]).toMatch(/^date,workout,exercise/);
    expect(csv).toMatch(/Sharp pain behind left knee/);
  });
});
