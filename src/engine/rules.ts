/**
 * Every tunable threshold the progression engine uses. Nothing else in the
 * engine hard-codes a magic number, so the rules can be audited in one place.
 */
export const RULES = Object.freeze({
  engineVersion: '1.0.0',

  /** Effective RIR deviation (actual − target, weighted by confidence) that counts as "substantially easier". */
  rirSubstantiallyHigh: 1.5,
  /** Effective RIR deviation that counts as "substantially harder" (closer to failure). */
  rirSubstantiallyLow: -1.5,
  /** Effective deviation at the top of the range that earns a double load jump. */
  rirBigJump: 3,
  /** Minimum RIR weight required for RIR to influence decisions at all. */
  rirMinWeight: 0.5,
  /** Minimum share of working sets that must carry an RIR value. */
  rirMinCoverage: 0.5,
  /**
   * RIR is "inconsistent" when a later set at the same load reports at least this much MORE
   * RIR while doing no more reps (fatigue makes that implausible)…
   */
  rirInconsistentJump: 2,
  /** …or when the spread (max − min) across sets reaches this. Normal fatigue (3→2→0) stays consistent. */
  rirInconsistentSpread: 4,
  /** Weight multiplier applied to inconsistent RIR. */
  rirInconsistentPenalty: 0.5,

  /** With ≥ this many planned sets, one set may be 1 rep short of the top and still count. */
  topToleranceMinSets: 3,
  topToleranceReps: 1,

  /** Average reps this far under the minimum are treated as "far below" and reduce load immediately. */
  farBelowMinReps: 3,
  /** Load reduction after repeated below-range sessions, in percent (at least one increment). */
  decreasePercent: 5,

  /** Rolling window for the long-term trend label. */
  trendWindow: 3,
  improvingPct: 1,
  regressingPct: -2,
  /** Performance-index drop between load changes that counts as a regression. */
  regressionPctAcrossLoads: -2,
  /** Consecutive regressing sessions that trigger a deload. */
  regressionSessionsBeforeDeload: 2,
  /** Consecutive non-progressing sessions that raise a plateau warning. */
  plateauWarningAt: 2,

  /** Reps above this are unreliable for 1RM estimation; still used as a trend indicator. */
  e1rmReliableMaxReps: 15,
});

/** Human-readable catalogue of rule ids used in recommendations. */
export const RULE_DESCRIPTIONS: Readonly<Record<string, string>> = Object.freeze({
  BASELINE: 'No history: establish a baseline at the bottom of the rep range.',
  NO_SETS_LOGGED: 'Last session had no usable sets: repeat the last known target.',
  INVALID_CONFIG: 'Progression settings are invalid: fix them before the engine can progress this exercise.',
  PAIN_REVIEW: 'Significant pain: never add load; review, replace or skip the exercise.',
  PAIN_CAUTION: 'Mild pain: hold load and reps until a pain-free session.',
  DELOAD_STALL: 'No progress for the configured number of sessions: deload.',
  DELOAD_REGRESSION: 'Performance fell in consecutive sessions: deload.',
  RESUME_AFTER_DELOAD: 'After a reduced-sets deload: return to full sets at the same load.',
  C_OFF_DAY: 'Below range on a low-readiness day: treat as an off day and repeat.',
  C_FIRST_BELOW: 'Below range once: repeat the load before changing anything.',
  C_REPEATED_BELOW: 'Below range in two sessions at the same load: reduce load.',
  C_FAR_BELOW: 'Far below range: reduce load now.',
  A_TOP_OF_RANGE: 'Top of range on essentially all sets at target RIR: add one load increment.',
  D_TOP_HIGH_RIR_BIG: 'Top of range with RIR far above target: add two load increments.',
  D_HIGH_RIR_EARLY_INCREASE: 'Most sets at the top with RIR well above target: add load early.',
  E_TOP_LOW_RIR: 'Top of range but closer to failure than intended: repeat the load.',
  E_LOW_RIR_HOLD: 'Inside range but closer to failure than intended: repeat reps.',
  A_MAX_LOAD: 'Top of range at the configured maximum load: hold and progress another way.',
  REP_FIRST_CONSOLIDATE: 'Rep-first: top of range must be reached twice in a row before adding load.',
  INCOMPLETE_SESSION: 'Planned sets were missing or skipped: repeat before progressing.',
  B_ADD_REPS: 'Inside the rep range: keep load, add a rep to each set below the top.',
  B_ADD_REPS_HIGH_RIR: 'Inside range with RIR well above target: add two reps per set.',
  LF_MIN_REACHED: 'Load-first: every set reached the minimum reps: add load.',
  LF_BUILD: 'Load-first: bring every set up to the minimum reps at this load.',
  T_ADD_TIME: 'Time-based: add seconds to each set below the maximum time.',
  T_ADD_LOAD: 'Time-based: maximum time reached on every set: add load and restart at the minimum time.',
  T_MAX_TIME: 'Time-based: maximum time reached with no load option: progress the variation.',
  T_BELOW_MIN: 'Time-based: holds fell below the minimum: repeat the minimum time.',
});
