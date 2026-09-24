/**
 * Temporary Sub-Agent tests (ADR-043)
 *
 * The central invariant: a sub-agent is a synchronous child call, NOT an A2A
 * handoff. Recording one must leave the collaboration worklist untouched.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const WORKLIST = '../dist/domains/cats/services/agents/routing/WorklistRegistry.js';

async function load() {
  return import(WORKLIST);
}

describe('sub-agent causal records', () => {
  it('records a sub-agent for its parent invocation', async () => {
    const { recordSubAgent, getSubAgents, clearSubAgents } = await load();
    const threadId = 'thread-sub-1';
    const parentInvocationId = 'inv-parent-1';
    clearSubAgents(threadId, parentInvocationId);

    recordSubAgent({
      invocationId: 'sub-1',
      parentInvocationId,
      threadId,
      catId: 'opus',
      spawnedBy: 'codex',
      depth: 1,
      task: 'summarise this excerpt',
      createdAt: Date.now(),
    });

    const records = getSubAgents(threadId, parentInvocationId);
    assert.equal(records.length, 1);
    assert.equal(records[0].invocationId, 'sub-1');
    assert.equal(records[0].spawnedBy, 'codex');
    assert.equal(records[0].depth, 1);

    clearSubAgents(threadId, parentInvocationId);
  });

  it('records multiple sub-agents in spawn order', async () => {
    const { recordSubAgent, getSubAgents, clearSubAgents } = await load();
    const threadId = 'thread-sub-2';
    const parentInvocationId = 'inv-parent-2';
    clearSubAgents(threadId, parentInvocationId);

    for (const id of ['sub-a', 'sub-b', 'sub-c']) {
      recordSubAgent({
        invocationId: id,
        parentInvocationId,
        threadId,
        catId: 'opus',
        spawnedBy: 'codex',
        depth: 1,
        task: `task ${id}`,
        createdAt: Date.now(),
      });
    }

    assert.deepEqual(
      getSubAgents(threadId, parentInvocationId).map((r) => r.invocationId),
      ['sub-a', 'sub-b', 'sub-c'],
    );

    clearSubAgents(threadId, parentInvocationId);
  });

  it('returns empty for a parent that spawned nothing', async () => {
    const { getSubAgents } = await load();
    assert.deepEqual(getSubAgents('thread-none', 'inv-none'), []);
  });

  it('clearSubAgents drops all records for that parent only', async () => {
    const { recordSubAgent, getSubAgents, clearSubAgents } = await load();
    const threadId = 'thread-sub-3';
    clearSubAgents(threadId, 'inv-p1');
    clearSubAgents(threadId, 'inv-p2');

    for (const parent of ['inv-p1', 'inv-p2']) {
      recordSubAgent({
        invocationId: `child-of-${parent}`,
        parentInvocationId: parent,
        threadId,
        catId: 'opus',
        spawnedBy: 'codex',
        depth: 1,
        task: 'x',
        createdAt: Date.now(),
      });
    }

    clearSubAgents(threadId, 'inv-p1');
    assert.deepEqual(getSubAgents(threadId, 'inv-p1'), []);
    assert.equal(getSubAgents(threadId, 'inv-p2').length, 1);

    clearSubAgents(threadId, 'inv-p2');
  });
});

describe('sub-agents must not disturb the A2A worklist', () => {
  it('recording a sub-agent leaves list and a2aCount untouched', async () => {
    const { registerWorklist, getWorklist, recordSubAgent, clearSubAgents, unregisterWorklist } = await load();
    const threadId = 'thread-iso-1';
    const parentInvocationId = 'inv-iso-1';

    const entry = registerWorklist(threadId, ['opus'], 15, parentInvocationId);
    const listBefore = [...entry.list];
    const countBefore = entry.a2aCount;

    recordSubAgent({
      invocationId: 'sub-iso-1',
      parentInvocationId,
      threadId,
      catId: 'gemini',
      spawnedBy: 'opus',
      depth: 1,
      task: 'isolated side task',
      createdAt: Date.now(),
    });

    const after = getWorklist(threadId, parentInvocationId);
    assert.deepEqual(after.list, listBefore, 'sub-agent must not join the execution list');
    assert.equal(after.a2aCount, countBefore, 'sub-agent must not consume A2A depth');
    assert.equal(after.a2aFrom.size, 0, 'sub-agent must not register as an A2A sender');

    unregisterWorklist(threadId, entry, parentInvocationId);
    clearSubAgents(threadId, parentInvocationId);
  });
});

describe('regression: pushToWorklist still behaves as before', () => {
  it('an A2A push still enqueues and increments depth', async () => {
    const { registerWorklist, pushToWorklist, unregisterWorklist } = await load();
    const threadId = 'thread-reg-1';
    const parentInvocationId = 'inv-reg-1';

    const entry = registerWorklist(threadId, ['opus'], 15, parentInvocationId);
    const result = pushToWorklist(threadId, ['codex'], 'opus', parentInvocationId);

    assert.deepEqual(result.added, ['codex'], 'A2A push must still enqueue the target');
    assert.equal(entry.a2aCount, 1, 'A2A push must still increment depth');
    assert.equal(entry.list.length, 2);

    unregisterWorklist(threadId, entry, parentInvocationId);
  });
});
