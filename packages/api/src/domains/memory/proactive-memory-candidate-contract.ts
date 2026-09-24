export interface ProactiveMemoryCandidateCoordinate {
  readonly threadId: string;
  readonly messageIds: readonly string[];
}

export interface ProactiveMemoryFrequencySlice {
  readonly eligibleMessageCount: number;
  readonly distinctMessageCount: number;
  readonly messageShare: number;
}

/**
 * Lane-neutral statistical fact surfaced to the in-context cat.
 * Deliberately contains no lane, importance, recommendation, or tool payload.
 */
export interface ProactiveMemoryCandidate {
  readonly phrase: string;
  readonly normalizedPhrase: string;
  readonly window: {
    readonly sinceInclusive: number;
    readonly untilInclusive: number;
  };
  readonly distinctThreadCount: number;
  readonly distinctMessageCount: number;
  readonly messageShare: number;
  readonly frequency: {
    readonly background: ProactiveMemoryFrequencySlice & {
      readonly untilExclusive: number;
    };
    readonly recentBurst: ProactiveMemoryFrequencySlice & {
      readonly sinceInclusive: number;
    };
  };
  readonly sourceCoordinates: readonly ProactiveMemoryCandidateCoordinate[];
}

export interface ProactiveMemoryCandidateConfig {
  readonly windowMs: number;
  readonly recentWindowMs: number;
  readonly minDistinctThreads: number;
  readonly minDistinctMessages: number;
  readonly minBackgroundMessages: number;
  readonly minRecentBurstLift: number;
  readonly maxNudgesPerTurn: number;
}

export const DEFAULT_PROACTIVE_MEMORY_CANDIDATE_CONFIG: ProactiveMemoryCandidateConfig = Object.freeze({
  windowMs: 7 * 24 * 60 * 60 * 1000,
  recentWindowMs: 24 * 60 * 60 * 1000,
  minDistinctThreads: 2,
  minDistinctMessages: 3,
  minBackgroundMessages: 4,
  minRecentBurstLift: 2,
  maxNudgesPerTurn: 3,
});

/**
 * F-EXT: confirmation-feedback closed loop.
 *
 * The opportunity evaluator measures how often the human REJECTS proposed memories
 * (irrelevant + conflicting). When that rejection rate exceeds the budget, the system
 * should not keep spamming — it should RAISE the admission bar so only stronger signals
 * surface as candidates. This pure function is the "measurement → threshold" step of the
 * loop: it inflates `minDistinctThreads` / `minRecentBurstLift` as the rejection rate climbs,
 * capped so it can never lock the pipeline shut.
 */
export interface CandidateRejectionSignal {
  /** Proposals the human marked irrelevant. */
  readonly irrelevantRejections: number;
  /** Proposals rejected because they conflicted with an existing truth. */
  readonly conflictRejections: number;
  /** Total proposals the human adjudicated (relevant + irrelevant + conflict). */
  readonly totalAdjudicated: number;
}

/** Rejection rate above which thresholds begin to inflate. Mirrors the evaluator's ceiling. */
export const CANDIDATE_REJECTION_RATE_CEILING = 0.25;

export function adaptCandidateThresholds(
  base: ProactiveMemoryCandidateConfig,
  signal: CandidateRejectionSignal,
): ProactiveMemoryCandidateConfig {
  const total = signal.totalAdjudicated;
  const rejectionRate = total === 0 ? 0 : (signal.irrelevantRejections + signal.conflictRejections) / total;
  if (rejectionRate <= CANDIDATE_REJECTION_RATE_CEILING) {
    return { ...base };
  }
  // Over-ceiling: scale the inflation by how far past the ceiling we are (capped at 1.0).
  const excess = Math.min(1, (rejectionRate - CANDIDATE_REJECTION_RATE_CEILING) / (1 - CANDIDATE_REJECTION_RATE_CEILING));
  // Stepwise inflation: cross the ceiling → nudge +1; worst case → +2. `ceil` means the
  // very first over-budget signal already raises the bar (a one-way ratchet, so the loop
  // never oscillates), while the 0..1 excess bound keeps the step at/below +2.
  const threadStep = Math.ceil(excess * 2);
  const liftStep = Math.ceil(excess * 2);
  return {
    ...base,
    minDistinctThreads: base.minDistinctThreads + threadStep,
    minRecentBurstLift: base.minRecentBurstLift + liftStep,
  };
}
