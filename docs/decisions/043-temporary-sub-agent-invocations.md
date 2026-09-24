---
topics: [multi-agent, invocation, a2a, sub-agent, mcp]
doc_kind: decision
created: 2026-09-13
status: proposed
related: [ADR-003, ADR-037]
---

# ADR-043: Temporary Sub-Agent Invocations

## Context

Clowder already lets cats hand work to each other through @mention A2A
handoffs. That mechanism is deliberately **collaborative**: the target becomes
the next cat to execute, its output is written to the shared thread, and the
exchange consumes A2A depth.

That is the wrong shape for a different, common need: a cat wants a focused
side-piece of work done — a targeted re-read, an isolated computation, a second
pass over one excerpt — **without** handing over the conversation. Today the
only options are to do it inline (bloating one context) or to @mention another
cat (making it a public, depth-consuming turn). Neither fits.

The platform also needs a way for one cat to fan out bounded work while
remaining the single owner of the turn.

## Decision

Introduce **temporary sub-agents**: short-lived child agents a cat spawns
mid-execution via `POST /api/callbacks/spawn-temp-agent` (MCP:
`cat_cafe_spawn_temp_agent`).

A sub-agent is a **synchronous child call**, not an A2A handoff:

| Property | A2A handoff | Sub-agent |
|---|---|---|
| Semantics | asynchronous relay, next runner | synchronous child call |
| Parent behavior | continues / ends | **blocks until the child returns** |
| Output destination | written to the shared thread | **returned to the parent only** |
| WorkList role | pushed onto `list`, becomes next target | **causal record only** |
| Depth accounting | `a2aCount++` (limit 15) | **does not increment** |
| Visibility | visible to all cats in the thread | invisible to other cats |

### Reuse, not reimplementation

The feature reuses existing structure rather than adding a parallel path:

- **Provider layer**: sub-agents reuse the cat's registered `AgentService`.
  `invoke()` is an async generator that launches an independent provider turn
  per call, so sharing the registered instance is safe — no new provider, no
  new carrier, no changes to provider selection or account resolution.
- **Causality**: recorded through `recordSubAgent()` in `WorklistRegistry.ts`,
  reusing the same causal vocabulary (`parentInvocationId`, spawned-by cat).
- **Types**: `TurnExecutionKind` gains `'sub_agent'`; `TurnExecutionCausalRefs`
  gains `subAgentOf` / `subAgentDepth`. `coveredMessageIds` already expresses
  "exactly which persisted bodies this child may see".
- **Queue**: sub-agents reuse the ordinary callback path; they are not a second
  dispatch pipeline.

`pushToWorklist` and `invokeSingleCat` are **not modified**.

### "Not a call" does not mean unbounded

Because sub-agents bypass the collaboration-shaped A2A limits, they carry their
own **resource-shaped** limits instead:

1. **Nesting depth** — `MAX_SUB_AGENT_DEPTH = 3`. In this revision a child holds
   no invocation of its own (and therefore no callback token), so it cannot
   spawn further children; the depth check remains for forward compatibility.
2. **Concurrency** — `MAX_CONCURRENT_SUB_AGENTS = 3` per parent invocation.
3. **Budget** — `SUB_AGENT_TOKEN_BUDGET = 200_000`, shared by the parent and all
   of its children, charged whether or not a provider reports usage.
4. **Cascade cancel** — every child gets an `AbortController`; `abortSubAgents()`
   cancels them all when the parent terminates, so a child can never outlive its
   parent. A wall-clock timeout (`SUB_AGENT_TIMEOUT_MS = 5min`) aborts stragglers.

### Scoped context by default

A sub-agent sees only `task` plus optional `contextFragments` /
`contextMessageIds`. It never receives the thread history. This keeps child
context small, prevents incidental context bloat, and stops a child from
inheriting conversational state it has no business acting on.

## Consequences

**Positive**

- Cats get bounded fan-out without polluting the shared thread.
- No new provider, carrier, or dispatch path — the blast radius stays small.
- Existing A2A and scheduling logic is untouched; the change is additive.

**Negative / trade-offs**

- The parent blocks for the duration of the child call (bounded by timeout).
- Sub-agents skip session chaining and continuity capsules. That is intentional
  (they are disposable), but it means a crashed sub-agent is retried by the
  parent, not resumed by the platform.
- Concurrency and budget state are process-local. A multi-process deployment
  would need these moved to shared storage (Redis) — same trajectory as the
  existing `InvocationQueue` externalization plan.
- Because children hold no invocation, they cannot themselves spawn children
  today. Nesting stays at one level until children get invocation identity.

## Follow-ups

- Move concurrency/budget counters to Redis if the API runs multi-process.
- Surface sub-agent runs in the UI as collapsed children of the parent turn.
- Consider promoting sub-agents to full invocations (reusing `invokeSingleCat`)
  if continuity/resume is ever required.
