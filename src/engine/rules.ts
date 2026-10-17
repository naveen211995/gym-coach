/**
 * Every tunable threshold the progression engine uses. Nothing else in the
 * engine hard-codes a magic number, so the rules can be audited in one place.
 */
export const RULES = Object.freeze({
  engineVersion: '2.0.0',

  /** Effective RIR deviation (actual − target, weighted by confidence) that counts as "substantially easier". */
  rirSubstantiallyHigh: 1.5,
  /** Effective RIR deviation that counts as "substantially harder" (closer to failure). */
  rirSubstantiallyLow: -1.5,
  /**
   * Effective deviation at the top of the range that earns a bigger jump. The
   * SIZE of that jump now comes from the load-rep tradeoff and is capped at
   * RULES.maxJumpPercent, so this only decides whether the surplus is spent.
   */
  rirBigJump: 2.5,
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
  /**
   * Reported RIR above this is discounted: estimates of reps-in-reserve get
   * less accurate the further from failure a set stops. The taper is gentle on
   * purpose — lifters tend to UNDER-report what they had left, so a high report
   * is still real evidence the load is light. Oversized jumps are prevented by
   * RULES.maxJumpPercent, not by discounting the lifter's report.
   */
  rirTaperFrom: 4,
  /** Weight lost per reported RIR above rirTaperFrom. */
  rirTaperPerRep: 0.1,
  /** Weight never tapers below this. */
  rirTaperFloor: 0.6,

  /** With ≥ this many planned sets, one set may be 1 rep short of the top and still count. */
  topToleranceMinSets: 3,
  topToleranceReps: 1,

  /** Average reps this far under the minimum are treated as "far below" and reduce load immediately. */
  farBelowMinReps: 3,
  /** Load reduction after repeated below-range sessions, in percent (at least one increment). */
  decreasePercent: 5,

  /**
   * Reps lost per 1% of added load, in the 5-15 rep range. Rep-max tables put
   * one rep at roughly 2.5-3% of load; 0.4 reps per percent is the middle of
   * that. Used to predict reps at a new load and to size load jumps.
   */
  repsPerPercentLoad: 0.4,
  /** A single load increase never exceeds this percentage of the current load. */
  maxJumpPercent: 10,
  /**
   * When one increment costs more reps than the rep range spans, double
   * progression cannot work on that exercise: say so instead of bouncing the
   * lifter between "increase" and "decrease".
   */
  coarseIncrementSlackReps: 0,

  /** Rolling window for the long-term trend label. */
  trendWindow: 3,
  improvingPct: 1,
  regressingPct: -2,
  /** Performance-index drop between load changes that counts as a regression. */
  regressionPctAcrossLoads: -2,
  /**
   * At the same load, total reps must fall by MORE than this to count as a
   * regression. A one-rep dip is noise, not a trend.
   */
  regressionRepTolerance: 1,
  /**
   * At the same load and the same reps, this much lost capacity (summed
   * reps-to-failure, i.e. reps + RIR) counts as a regression on its own: the
   * same work is now closer to failure than it was.
   */
  capacityDropReps: 2,
  /** Capacity gain that counts as progress when reps did not change. */
  capacityGainReps: 2,
  /** Consecutive regressing sessions that trigger a deload. */
  regressionSessionsBeforeDeload: 2,
  /** Consecutive non-progressing sessions that raise a plateau warning. */
  plateauWarningAt: 2,

  /**
   * Reps above this are unreliable for 1RM estimation (Epley drifts badly past
   * ~15), so the estimate is computed from this many reps at most. Estimated-1RM
   * records are not claimed from sets above it.
   */
  e1rmReliableMaxReps: 15,

  /** Sets removed from a reduce-load deload, when the exercise has enough of them. */
  deloadSetReduction: 1,
  /** A set is only cut from a deload when at least this many are planned. */
  deloadMinSetsToReduce: 3,

  /** Within-session autoregulation: reps short of target before the load is questioned. */
  autoregMissReps: 2,
  /** Within-session autoregulation: reps past target (at or above target RIR) before more load is offered. */
  autoregBeatReps: 2,

  /** Weekly sets per muscle group that the volume report calls low / high. */
  weeklySetsLow: 10,
  weeklySetsHigh: 20,
  /**
   * A set counts toward volume when it finished within this many reps of
   * failure. Sets much further out contribute less per set, and this is the
   * usual operational definition of a "hard set".
   */
  hardSetMaxRir: 4,
  /** Sessions per muscle group per week below which frequency is called out. */
  weeklyFrequencyLow: 2,
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
  DELOAD_RIR_REGRESSION: 'Same reps but consistently closer to failure: deload.',
});
