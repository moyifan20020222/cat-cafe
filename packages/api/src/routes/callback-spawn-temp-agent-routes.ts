/**
 * Temporary Sub-Agent callback route.
 *
 * POST /api/callbacks/spawn-temp-agent
 *   Cat-auth. Runs a short-lived child agent and returns its output to the
 *   CALLING cat only. See docs/decisions/ADR-043-temporary-sub-agent.md.
 *
 * This is deliberately NOT an A2A handoff:
 *   - the parent blocks until the child returns (synchronous child call);
 *   - the child's output is returned to the parent, never written to the thread;
 *   - the child does NOT enter the worklist execution list and does NOT
 *     increment the A2A depth counter — it is recorded for causality only.
 *
 * "Not a call" does not mean "unbounded": sub-agents carry their own
 * resource-shaped limits (depth / concurrency / budget / cascade cancel).
 */

import type { CatId } from '@cat-cafe/shared';
import {
  assertKnownCatId,
  catIdSchema,
  MAX_CONCURRENT_SUB_AGENTS,
  MAX_SUB_AGENT_DEPTH,
  SUB_AGENT_TIMEOUT_MS,
  SUB_AGENT_TOKEN_BUDGET,
  type SubAgentRejectionReason,
} from '@cat-cafe/shared';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { InvocationRegistry } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import { recordSubAgent } from '../domains/cats/services/agents/routing/WorklistRegistry.js';
import type { AgentService } from '../domains/cats/services/types.js';
import { requireCallbackAuth } from './callback-auth-prehandler.js';

const spawnTempAgentSchema = z.object({
  /** The task handed to the sub-agent. This is the sub-agent's entire brief. */
  task: z.string().trim().min(1).max(8000),
  /** Which cat the sub-agent runs as. Defaults to the calling cat. */
  targetCatId: catIdSchema().optional(),
  /**
   * Exact message IDs the sub-agent may see. Scoped context only — the
   * sub-agent never receives the whole thread history.
   */
  contextMessageIds: z.array(z.string().min(1)).max(20).optional(),
  /** Extra text fragments (e.g. a file excerpt) to prepend to the brief. */
  contextFragments: z.array(z.string().max(4000)).max(10).optional(),
  /** Per-request idempotency key; a replay returns the original result. */
  clientRequestId: z.string().min(1).max(200).optional(),
});

export interface SpawnTempAgentDeps {
  registry: InvocationRegistry;
  /**
   * Registry of per-cat services. Deliberately typed as the narrow shape the
   * callback route options already expose, so this feature needs no changes to
   * route option plumbing.
   */
  agentRegistry: { getAllEntries(): Map<string, unknown> };
  /**
   * Optional override for building the service used by one sub-agent run.
   *
   * `invoke()` is an async generator that launches an independent provider
   * turn (new CLI process / new API call) per call, so reusing the cat's
   * registered service is safe — the instance only carries configuration.
   * Inject a factory when a caller needs a dedicated instance instead.
   */
  resolveService?: (input: {
    catId: CatId;
    threadId: string;
    userId: string;
  }) => AgentService | Promise<AgentService>;
  /** Working directory for the sub-agent. Defaults to the caller's project root. */
  resolveWorkingDirectory?: (input: { threadId: string; userId: string }) => string | undefined;
}

interface ParentSubAgentState {
  running: number;
  tokensUsed: number;
  controllers: Set<AbortController>;
  results: Map<string, unknown>;
}

/** Per-parent runtime guard state. Bounded by invocation lifecycle. */
const parentStates = new Map<string, ParentSubAgentState>();

function parentState(parentInvocationId: string): ParentSubAgentState {
  let state = parentStates.get(parentInvocationId);
  if (!state) {
    state = { running: 0, tokensUsed: 0, controllers: new Set(), results: new Map() };
    parentStates.set(parentInvocationId, state);
  }
  return state;
}

/**
 * Cancel every sub-agent belonging to a parent invocation.
 *
 * Call this when the parent terminates so children can never outlive it.
 * Safe to call repeatedly and for parents that never spawned children.
 */
export function abortSubAgents(parentInvocationId: string): number {
  const state = parentStates.get(parentInvocationId);
  if (!state) return 0;
  let canceled = 0;
  for (const controller of state.controllers) {
    if (!controller.signal.aborted) {
      controller.abort();
      canceled++;
    }
  }
  state.controllers.clear();
  return canceled;
}

/** Release all guard state for a parent invocation after it terminates. */
export function disposeSubAgentState(parentInvocationId: string): void {
  abortSubAgents(parentInvocationId);
  parentStates.delete(parentInvocationId);
}

function rejection(reason: SubAgentRejectionReason, detail?: string) {
  return { status: 'rejected' as const, reason, ...(detail ? { detail } : {}) };
}

export function registerCallbackSpawnTempAgentRoutes(app: FastifyInstance, deps: SpawnTempAgentDeps): void {
  const { registry, agentRegistry, resolveService } = deps;

  app.post('/api/callbacks/spawn-temp-agent', async (request, reply) => {
    const record = requireCallbackAuth(request, reply);
    if (!record) return;

    const parsed = spawnTempAgentSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }

    const parentInvocationId = record.invocationId;
    const { task, targetCatId, contextMessageIds, contextFragments, clientRequestId } = parsed.data;
    const childCatId: CatId = targetCatId ? assertKnownCatId(targetCatId) : record.catId;

    // Guard 0: parent must still be the authoritative (latest) invocation.
    if (!(await registry.isLatest(parentInvocationId))) {
      return rejection('parent_not_running', 'Parent invocation is no longer latest');
    }

    const state = parentState(parentInvocationId);

    // Idempotency: a replayed request returns the original result.
    if (clientRequestId) {
      const cached = state.results.get(clientRequestId);
      if (cached) return { ...(cached as object), deduped: true };
    }

    // Guard 1: nesting depth. Sub-agents are one level deep in this revision —
    // a child holds no invocation of its own (and therefore no callback token),
    // so it cannot spawn further children. The depth check remains for forward
    // compatibility if children ever receive their own invocation identity.
    const depth = 1;
    if (depth > MAX_SUB_AGENT_DEPTH) {
      return rejection('depth_limit', `Sub-agent depth ${depth} exceeds ${MAX_SUB_AGENT_DEPTH}`);
    }

    // Guard 2: concurrency.
    if (state.running >= MAX_CONCURRENT_SUB_AGENTS) {
      return rejection(
        'concurrency_limit',
        `At most ${MAX_CONCURRENT_SUB_AGENTS} concurrent sub-agents per invocation`,
      );
    }

    // Guard 3: shared token budget.
    if (state.tokensUsed >= SUB_AGENT_TOKEN_BUDGET) {
      return rejection('budget_exhausted', `Token budget of ${SUB_AGENT_TOKEN_BUDGET} exhausted`);
    }

    const invocationId = `sub_${randomUUID()}`;
    const controller = new AbortController();
    const startedAt = Date.now();
    state.running++;
    state.controllers.add(controller);

    let service: AgentService;
    try {
      if (resolveService) {
        service = await resolveService({ catId: childCatId, threadId: record.threadId, userId: record.userId });
      } else {
        const entry = agentRegistry.getAllEntries().get(childCatId);
        if (!entry) {
          throw new Error(`No AgentService registered for "${childCatId}"`);
        }
        service = entry as AgentService;
      }
    } catch (error) {
      state.running--;
      state.controllers.delete(controller);
      reply.status(503);
      return rejection('provider_error', error instanceof Error ? error.message : 'Provider unavailable');
    }

    // Record causality BEFORE running so an audit trail exists even if the run fails.
    recordSubAgent({
      invocationId,
      parentInvocationId,
      threadId: record.threadId,
      catId: childCatId,
      spawnedBy: record.catId,
      depth,
      task,
      createdAt: startedAt,
    });

    const brief = [task, ...(contextFragments ?? [])].join('\n\n');
    const chunks: string[] = [];
    let outcome: 'succeeded' | 'failed' | 'canceled' | 'timeout' = 'succeeded';
    let reason: SubAgentRejectionReason | undefined;
    /** Distinguishes our own timeout from a parent-initiated cancel. */
    let timedOut = false;

    const workingDirectory = deps.resolveWorkingDirectory?.({ threadId: record.threadId, userId: record.userId });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, SUB_AGENT_TIMEOUT_MS);
    try {
      for await (const message of service.invoke(brief, {
        signal: controller.signal,
        ...(workingDirectory ? { workingDirectory } : {}),
      })) {
        if (controller.signal.aborted) break;
        if (message.type === 'text' && message.content) {
          chunks.push(message.content);
        } else if (message.type === 'error') {
          outcome = 'failed';
          reason = 'provider_error';
        }
        // Charge usage to the shared parent budget. Providers that omit usage
        // are approximated from output size so the budget can never be bypassed.
        const usage = (message as { usage?: { totalTokens?: number } }).usage?.totalTokens;
        state.tokensUsed += usage ?? Math.ceil((message.content?.length ?? 0) / 4);
      }
    } catch (error) {
      // Aborts surface as throws from most providers; classify by cause.
      if (timedOut) {
        outcome = 'timeout';
        reason = 'timeout';
      } else if (controller.signal.aborted) {
        outcome = 'canceled';
        reason = 'canceled';
      } else {
        outcome = 'failed';
        reason = 'provider_error';
      }
      void error;
    } finally {
      clearTimeout(timer);
      state.running--;
      state.controllers.delete(controller);
    }

    // A run that was aborted without throwing still needs a truthful outcome.
    if (outcome === 'succeeded' && controller.signal.aborted) {
      if (timedOut) {
        outcome = 'timeout';
        reason = 'timeout';
      } else {
        outcome = 'canceled';
        reason = 'canceled';
      }
    }

    const output = chunks.join('').trim();
    const result = {
      invocationId,
      parentInvocationId,
      output,
      status: outcome,
      ...(reason ? { reason } : {}),
      durationMs: Date.now() - startedAt,
      ...(contextMessageIds?.length ? { contextMessageIds } : {}),
    };

    if (clientRequestId) state.results.set(clientRequestId, result);
    return result;
  });
}
