/**
 * Live sub-agent integration test (ADR-043) — uses a REAL model call.
 *
 * This does NOT stand up the whole Clowder server. It registers the REAL
 * route handler (`registerCallbackSpawnTempAgentRoutes`) on a tiny Fastify
 * instance, injects a fake `AgentService` whose `invoke()` calls the user's
 * free API, and mocks callback auth + the isLatest guard. That exercises the
 * actual route logic (validation → guards → synchronous invoke loop → token
 * accounting → result-only-to-parent → audit record) against a real model.
 *
 * Enable by setting env vars:
 *   SUB_AGENT_TEST_API_KIND   = "openai" | "anthropic"   (default openai)
 *   SUB_AGENT_TEST_API_BASE_URL = e.g. https://api.openai.com/v1  (openai)
 *                                or https://api.anthropic.com  (anthropic)
 *   SUB_AGENT_TEST_API_KEY    = your key
 *   SUB_AGENT_TEST_API_MODEL  = e.g. gpt-4o-mini / claude-3-5-haiku-latest
 *
 * When any of these are missing the test is skipped (so it never breaks the
 * normal `pnpm test` suite).
 */

import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import Fastify from 'fastify';

const ROUTE = '../dist/routes/callback-spawn-temp-agent-routes.js';
const WORKLIST = '../dist/domains/cats/services/agents/routing/WorklistRegistry.js';

const KIND = process.env.SUB_AGENT_TEST_API_KIND ?? 'openai';
const BASE_URL = process.env.SUB_AGENT_TEST_API_BASE_URL;
const API_KEY = process.env.SUB_AGENT_TEST_API_KEY;
const MODEL = process.env.SUB_AGENT_TEST_API_MODEL ?? 'gpt-4o-mini';

const ENABLED = Boolean(BASE_URL && API_KEY);

describe('sub-agent live call (real free API)', { skip: !ENABLED }, () => {
  let app;
  let loadRoute;
  let loadWorklist;

  before(async () => {
    loadRoute = (await import(ROUTE)).registerCallbackSpawnTempAgentRoutes;
    loadWorklist = await import(WORKLIST);
  });

  after(async () => {
    if (app) await app.close();
  });

  /** A fake AgentService that fronts the user's free API. */
  function makeLiveService() {
    return {
      async *invoke(prompt, opts) {
        const controller = opts?.signal;
        if (KIND === 'anthropic') {
          const res = await fetch(`${BASE_URL}/v1/messages`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-api-key': API_KEY,
              'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({ model: MODEL, max_tokens: 1024, messages: [{ role: 'user', content: prompt }] }),
            signal: controller,
          });
          const j = await res.json();
          const text = Array.isArray(j.content) ? j.content.map((c) => c.text ?? '').join('') : '';
          const tokens = (j.usage?.input_tokens ?? 0) + (j.usage?.output_tokens ?? 0);
          yield { type: 'text', content: text, catId: 'codex' };
          yield { type: 'text', content: '', catId: 'codex', usage: { totalTokens: tokens } };
          return;
        }
        // OpenAI-compatible (OpenAI / OpenRouter / Together / Groq / DeepSeek / Ollama ...)
        const res = await fetch(`${BASE_URL}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
          body: JSON.stringify({
            model: MODEL,
            messages: [{ role: 'user', content: prompt }],
            stream: false,
          }),
          signal: controller,
        });
        const j = await res.json();
        const text = j.choices?.[0]?.message?.content ?? '';
        const tokens = j.usage?.total_tokens ?? Math.ceil(text.length / 4);
        yield { type: 'text', content: text, catId: 'codex' };
        yield { type: 'text', content: '', catId: 'codex', usage: { totalTokens: tokens } };
      },
    };
  }

  it('spawns a sub-agent that returns the model output to the parent only', async () => {
    const { recordSubAgent, getSubAgents, clearSubAgents, registerWorklist, getWorklist, unregisterWorklist } =
      loadWorklist;

    const threadId = 'thread-live-1';
    const parentInvocationId = 'inv-live-1';
    clearSubAgents(threadId, parentInvocationId);

    app = Fastify({ logger: false });
    // Bypass real callback auth: pre-decorate the request with a fake principal.
    app.addHook('preHandler', async (request) => {
      request.callbackAuth = {
        invocationId: parentInvocationId,
        threadId,
        userId: 'user-live',
        catId: 'codex',
      };
    });
    loadRoute(app, {
      registry: { isLatest: async () => true },
      agentRegistry: { getAllEntries: () => new Map() },
      resolveService: async () => makeLiveService(),
    });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/spawn-temp-agent',
      payload: { task: '用一句中文介绍你自己，不超过20个字。' },
    });

    assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);
    const data = res.json();
    assert.equal(data.status, 'succeeded', `expected succeeded, got ${JSON.stringify(data)}`);
    assert.ok(typeof data.output === 'string' && data.output.length > 0, `empty output: ${JSON.stringify(data)}`);
    console.log('[live] model output:', data.output);

    // Audit record must exist for the parent.
    const records = getSubAgents(threadId, parentInvocationId);
    assert.equal(records.length, 1, 'sub-agent must be recorded for the parent');
    assert.equal(records[0].status, undefined); // struct has no status; presence is the proof

    // Crucially: the sub-agent must NOT have entered the A2A worklist.
    const entry = registerWorklist(threadId, ['codex'], 15, parentInvocationId);
    const beforeList = [...entry.list];
    const beforeCount = entry.a2aCount;
    recordSubAgent({
      invocationId: 'sub-live-1',
      parentInvocationId,
      threadId,
      catId: 'gemini',
      spawnedBy: 'codex',
      depth: 1,
      task: 'x',
      createdAt: Date.now(),
    });
    const after = getWorklist(threadId, parentInvocationId);
    assert.deepEqual(after.list, beforeList, 'sub-agent must not join the execution list');
    assert.equal(after.a2aCount, beforeCount, 'sub-agent must not consume A2A depth');

    unregisterWorklist(threadId, entry, parentInvocationId);
    clearSubAgents(threadId, parentInvocationId);
  });
});
