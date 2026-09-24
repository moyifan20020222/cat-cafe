import type { CatId } from './ids.js';

/**
 * Typed child purpose; never inferred from prompt or logs.
 *
 * `sub_agent` marks a temporary agent spawned *by* a cat mid-execution.
 * It is a synchronous child call owned by the parent invocation — not an
 * A2A handoff — so it never advances the A2A depth counter and never writes
 * to the shared thread. See docs/decisions/ADR-XXX.
 */
export type TurnExecutionKind = 'ordinary' | 'routing_guard' | 'freshness_supplement' | 'sub_agent';
export type TurnExecutionStatus = 'running' | 'succeeded' | 'failed' | 'canceled' | 'interrupted';
export type TurnExecutionTerminalStatus = Exclude<TurnExecutionStatus, 'running'>;

export interface TurnExecutionCausalRefs {
  triggerMessageId?: string;
  freshnessSupplementId?: string;
  routingGuardReason?: 'missing_routing_exit';
  /** Exact persisted message bodies present in this child's prompt. */
  coveredMessageIds?: string[];
  /** Set only for `sub_agent`: the invocation that spawned this child. */
  subAgentOf?: string;
  /** Nesting level of this sub-agent (1 = direct child of a root invocation). */
  subAgentDepth?: number;
}

export interface CreateTurnExecutionInput {
  invocationId: string;
  parentInvocationId: string;
  threadId: string;
  userId: string;
  catId: CatId;
  executionKind: TurnExecutionKind;
  startedAt: number;
  causal?: TurnExecutionCausalRefs;
}

export interface TurnExecutionRecord extends CreateTurnExecutionInput {
  status: TurnExecutionStatus;
  endedAt?: number;
  terminalReason?: string;
}

/** Immutable child identity safe to persist beside a visible message body. */
export interface TurnExecutionMessageProjection {
  invocationId: string;
  parentInvocationId: string;
  executionKind: TurnExecutionKind;
}

export interface TurnExecutionTerminalInput {
  status: TurnExecutionTerminalStatus;
  endedAt: number;
  terminalReason?: string;
}

export type CreateTurnExecutionOutcome = 'created' | 'replayed' | 'conflict';

export interface CreateTurnExecutionResult {
  outcome: CreateTurnExecutionOutcome;
  record: TurnExecutionRecord;
}

export type TransitionTurnExecutionOutcome = 'transitioned' | 'already_terminal' | 'not_found';

export interface TransitionTurnExecutionResult {
  outcome: TransitionTurnExecutionOutcome;
  record: TurnExecutionRecord | null;
}

export interface InterruptRunningTurnExecutionsInput {
  endedAt: number;
  terminalReason: string;
}
