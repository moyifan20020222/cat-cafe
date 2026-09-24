// F-EXT: causal memory extraction + conflict/feedback-loop tests.
// Run with: node --test packages/api/test/causal-memory.test.js (after `pnpm --filter @cat-cafe/api exec tsc`)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Pure exported functions
import { parseNaturalLanguageOutput } from '../dist/domains/memory/AbstractiveSummaryClient.js';
import {
  adaptCandidateThresholds,
  DEFAULT_PROACTIVE_MEMORY_CANDIDATE_CONFIG,
  CANDIDATE_REJECTION_RATE_CEILING,
} from '../dist/domains/memory/proactive-memory-candidate-contract.js';
import { DistillationService } from '../dist/domains/memory/distillation-service.js';

// better-sqlite3 is a native module built against the running Node ABI. In a Node 24
// workspace it loads; in a mismatched runtime it throws at import. Skip the DB-backed
// test there rather than failing the whole suite.
let BETTER_SQLITE_OK = true;
try {
  // `import` of better-sqlite3 succeeds; the native binding only fails lazily at
  // `new Database()` time. Probe an in-memory DB to detect an ABI mismatch for real.
  const mod = await import('better-sqlite3');
  new mod.default(':memory:');
} catch {
  BETTER_SQLITE_OK = false;
}

test('parseNaturalLanguageOutput extracts a causal trace block', () => {
  const text = [
    '# Build timeouts',
    '',
    'We kept hitting a 2-minute ceiling on CI builds.',
    '',
    '[lesson!] Build timeouts need an explicit AbortController',
    'trigger: a build step exceeded the CI hard timeout',
    'action: wrapped the long step with an AbortController + cascade cancel',
    'result: child jobs no longer hang after the parent aborts',
    'lesson: never rely on the platform to kill your children for you',
  ].join('\n');

  const result = parseNaturalLanguageOutput(text, {
    threadId: 'thread_abc',
    messages: [{ id: 'm1', content: 'x', timestamp: 0 }],
  });
  assert.ok(result, 'parser should return a result');
  const seg = result.segments[0];
  assert.equal(seg.candidates.length, 1);
  const cand = seg.candidates[0];
  assert.equal(cand.kind, 'lesson');
  assert.ok(cand.causal, 'causal quadruple should be parsed');
  assert.equal(cand.causal.trigger, 'a build step exceeded the CI hard timeout');
  assert.equal(cand.causal.action, 'wrapped the long step with an AbortController + cascade cancel');
  assert.equal(cand.causal.result, 'child jobs no longer hang after the parent aborts');
  assert.equal(cand.causal.lesson, 'never rely on the platform to kill your children for you');
});

test('parseNaturalLanguageOutput leaves a flat claim when no causal block', () => {
  const text = '# Topic\n\nPlain summary\n\n[lesson] Always log errors';
  const result = parseNaturalLanguageOutput(text, { threadId: 't', messages: [{ id: 'm1', content: 'x', timestamp: 0 }] });
  const cand = result.segments[0].candidates[0];
  assert.equal(cand.kind, 'lesson');
  assert.equal(cand.causal, undefined);
});

test('adaptCandidateThresholds stays flat under the ceiling', () => {
  const next = adaptCandidateThresholds(DEFAULT_PROACTIVE_MEMORY_CANDIDATE_CONFIG, {
    irrelevantRejections: 1,
    conflictRejections: 0,
    totalAdjudicated: 20,
  });
  assert.equal(next.minDistinctThreads, DEFAULT_PROACTIVE_MEMORY_CANDIDATE_CONFIG.minDistinctThreads);
  assert.equal(next.minRecentBurstLift, DEFAULT_PROACTIVE_MEMORY_CANDIDATE_CONFIG.minRecentBurstLift);
});

test('adaptCandidateThresholds inflates when rejection rate is high', () => {
  const next = adaptCandidateThresholds(DEFAULT_PROACTIVE_MEMORY_CANDIDATE_CONFIG, {
    irrelevantRejections: 6,
    conflictRejections: 2,
    totalAdjudicated: 20,
  });
  assert.ok(next.minDistinctThreads > DEFAULT_PROACTIVE_MEMORY_CANDIDATE_CONFIG.minDistinctThreads);
  assert.ok(next.minRecentBurstLift > DEFAULT_PROACTIVE_MEMORY_CANDIDATE_CONFIG.minRecentBurstLift);
  // Capped: cannot lock the pipeline shut.
  assert.ok(next.minDistinctThreads <= DEFAULT_PROACTIVE_MEMORY_CANDIDATE_CONFIG.minDistinctThreads + 2);
});

test(
  'DistillationService persists causal + detects conflict + materializes quadruple',
  { skip: !BETTER_SQLITE_OK },
  async () => {
    const Database = (await import('better-sqlite3')).default;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'causal-test-'));
  const db = new Database(':memory:');
  db.exec('CREATE TABLE IF NOT EXISTS evidence (anchor TEXT PRIMARY KEY, data TEXT)');
  const storeItem = {
    anchor: 'evt:1',
    kind: 'lesson',
    status: 'active',
    title: 'Build timeouts need an explicit AbortController',
    summary: 'wrapping with AbortController fixed the CI hang',
    keywords: ['build', 'timeout', 'abortcontroller'],
    generalizable: true,
  };
  db.prepare('INSERT INTO evidence VALUES (?,?)').run(storeItem.anchor, JSON.stringify(storeItem));

  const projectStore = {
    getDb: () => db,
    getByAnchor: async (anchor) => {
      const row = db.prepare('SELECT data FROM evidence WHERE anchor = ?').get(anchor);
      return row ? JSON.parse(row.data) : null;
    },
  };
  const globalStore = { upsert: async () => {} };

  const svc = new DistillationService(projectStore, globalStore, { distilledRoot: tmp });
  await svc.initialize();

  // First (conflicting) truth — materialize it as the "existing" durable truth.
  const c1 = await svc.nominate('evt:1', tmp, {
    causal: {
      trigger: 'a build step exceeded the CI hard timeout',
      action: 'wrapped the long step with an AbortController',
      result: 'child jobs no longer hang',
      lesson: 'never rely on the platform to kill your children',
      causalConfidence: 'high',
    },
  });
  await svc.approve(c1.id, 'tester');
  const materialized = svc.listMaterialized();
  assert.equal(materialized.length, 1);
  const fc = fs.readFileSync(materialized[0].filePath, 'utf-8');
  assert.match(fc, /## Causal Trace/);
  assert.match(fc, /trigger: a build step exceeded the CI hard timeout/);

  // Second candidate on the SAME topic but divergent claim → must be flagged as conflict.
  const storeItem2 = {
    anchor: 'evt:2',
    kind: 'lesson',
    status: 'active',
    title: 'Build timeouts should use a longer CI budget instead',
    summary: 'increase the CI timeout window rather than adding cancellation logic',
    keywords: ['build', 'timeout', 'abortcontroller', 'budget'],
    generalizable: true,
  };
  db.prepare('INSERT INTO evidence VALUES (?,?)').run(storeItem2.anchor, JSON.stringify(storeItem2));
  const c2 = await svc.nominate('evt:2', tmp);
  assert.ok(c2.conflict, 'second same-topic candidate should be flagged as conflict');
  assert.equal(c2.conflict.basis, 'keyword_overlap');

  // Approving without force must throw (conflict gate).
  await assert.rejects(() => svc.approve(c2.id, 'tester'));

  // Force-approve records a contradicts edge (supersession).
  await svc.approve(c2.id, 'tester', { force: true });
  const c2Materialized = svc.listMaterialized().find((t) => t.anchor === `distilled:${c2.id}`);
  assert.ok(c2Materialized, 'c2 should be materialized after force-approve');
  const fc2 = fs.readFileSync(c2Materialized.filePath, 'utf-8');
  assert.match(fc2, /contradicts: \[distilled:/);

  fs.rmSync(tmp, { recursive: true, force: true });
});
