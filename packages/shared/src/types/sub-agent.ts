/**
 * Temporary Sub-Agent Types
 *
 * A sub-agent is a short-lived child agent spawned *by* a cat while that cat is
 * already executing. It exists to let one cat fan out discrete pieces of work
 * without turning them into collaborative turns.
 *
 * Design stance (see docs/decisions/ADR-043-temporary-sub-agent.md):
 *
 * - Sub-agents are **synchronous child calls**, not A2A handoffs. The parent
 *   invocation blocks until the child returns, and the child's output is
 *   returned to the parent only — it is never written to the shared thread.
 * - Because a sub-agent is not a handoff, it must NOT advance the A2A depth
 *   counter (`WorklistEntry.a2aCount`) and must NOT be pushed onto the
 *   worklist execution list. It is recorded for causal/audit purposes only.
 * - "Not a call" does not mean "unbounded". Sub-agents get their own
 *   resource-shaped limits (depth / concurrency / budget / cascade cancel)
 *   that are independent of the collaboration-shaped A2A limits.
 */

/** Nesting cap for sub-agents. A sub-agent may spawn children up to this depth. */
export const MAX_SUB_AGENT_DEPTH = 3;

/** Max sub-agents a single parent invocation may run at the same time. */
export const MAX_CONCURRENT_SUB_AGENTS = 3;

/** Wall-clock budget for one sub-agent run. Parent blocks for at most this long. */
export const SUB_AGENT_TIMEOUT_MS = 5 * 60_000;

/** Token budget shared by a parent invocation and all of its sub-agents. */
export const SUB_AGENT_TOKEN_BUDGET = 200_000;

/** Terminal reasons returned to the parent when a sub-agent cannot run. */
export type SubAgentRejectionReason =
  | 'depth_limit'
  | 'concurrency_limit'
  | 'budget_exhausted'
  | 'parent_not_running'
  | 'invalid_request'
  | 'timeout'
  | 'canceled'
  | 'provider_error';

/** Outcome of a completed sub-agent run, returned to the spawning cat. */
export interface SubAgentResult {
  invocationId: string;
  parentInvocationId: string;
  /** Text output produced by the sub-agent. Empty string when it produced none. */
  output: string;
  status: 'succeeded' | 'failed' | 'canceled' | 'timeout';
  /** Populated when status is not 'succeeded'. */
  reason?: SubAgentRejectionReason;
  /** Tokens consumed by this sub-agent, charged against the parent budget. */
  tokensUsed?: number;
  durationMs: number;
}

/** Rejection payload returned to the parent when a sub-agent was never started. */
export interface SubAgentRejection {
  status: 'rejected';
  reason: SubAgentRejectionReason;
  detail?: string;
}
