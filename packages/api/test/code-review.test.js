import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseReviewReport,
  deriveVerdict,
  sortFindingsBySeverity,
} from '@cat-cafe/shared';
import {
  reviewChecklistPrompt,
  buildReviewChecklistSection,
  buildSystemPrompt,
} from '../dist/domains/cats/services/context/SystemPromptBuilder.js';
import { resolveReviewContext } from '../dist/domains/community/github/GitHubPrDiff.js';

test('parseReviewReport: 解析结构化 findings + verdict + summary', () => {
  const text = [
    '[BLOCKER][security] src/auth.ts:42 — 直接拼接 SQL 会注入 | suggestion: 用参数化查询',
    '[MINOR][tests] src/auth.ts:88 — 登录分支无测试覆盖',
    'Verdict: REQUEST_CHANGES',
    'Summary: 有一处严重 SQL 注入必须修，其余小问题顺手补',
  ].join('\n');

  const report = parseReviewReport(text);
  assert.equal(report.verdict, 'changes_requested');
  assert.equal(report.summary, '有一处严重 SQL 注入必须修，其余小问题顺手补');
  assert.equal(report.findings.length, 2);

  const [first] = report.findings;
  assert.equal(first.severity, 'blocker');
  assert.equal(first.category, 'security');
  assert.equal(first.file, 'src/auth.ts');
  assert.equal(first.line, 42);
  assert.equal(first.comment, '直接拼接 SQL 会注入');
  assert.equal(first.suggestion, '用参数化查询');
  // 严重度降序：blocker 应在 minor 前
  assert.equal(report.findings[0].severity, 'blocker');
  assert.equal(report.findings[1].severity, 'minor');
});

test('parseReviewReport: 缺省 verdict 时由 findings 推导', () => {
  const text = [
    '[MAJOR][correctness] src/calc.ts:10 — 整数溢出风险',
  ].join('\n');
  const report = parseReviewReport(text);
  assert.equal(report.verdict, 'changes_requested');
  assert.equal(report.findings.length, 1);
});

test('parseReviewReport: 无 findings 推导为 approved', () => {
  const report = parseReviewReport('Summary: 看起来没问题');
  assert.equal(report.verdict, 'approved');
  assert.equal(report.findings.length, 0);
  assert.equal(report.summary, '看起来没问题');
});

test('parseReviewReport: 大小写不敏感 + 容忍缺失 category/file', () => {
  const text = [
    '[nit] 建议补充整体错误处理策略',
    'Verdict: COMMENT',
  ].join('\n');
  const report = parseReviewReport(text);
  // 缺 category 的行不应被当 findings（没有 [CATEGORY] 标签）
  assert.equal(report.findings.length, 0);
  assert.equal(report.verdict, 'commented');
});

test('parseReviewReport: APPROVE/APPROVED 与 COMMENT/COMMENTED 文法兼容', () => {
  assert.equal(parseReviewReport('Verdict: APPROVED').verdict, 'approved');
  assert.equal(parseReviewReport('Verdict: COMMENTED').verdict, 'commented');
  assert.equal(parseReviewReport('Verdict: CHANGES_REQUESTED').verdict, 'changes_requested');
});

test('deriveVerdict / sortFindingsBySeverity 工具', () => {
  assert.equal(deriveVerdict([]), 'approved');
  assert.equal(
    deriveVerdict([{ severity: 'minor', category: 'style', comment: 'x', confidence: 'high' }]),
    'commented',
  );
  const sorted = sortFindingsBySeverity([
    { severity: 'nit', category: 'style', comment: 'a', confidence: 'high' },
    { severity: 'blocker', category: 'security', comment: 'b', confidence: 'high' },
  ]);
  assert.equal(sorted[0].severity, 'blocker');
});

test('reviewChecklistPrompt: 必须包含结算强制 token', () => {
  const content = reviewChecklistPrompt();
  assert.match(content, /APPROVE/);
  assert.match(content, /REQUEST_CHANGES/);
  assert.match(content, /COMMENT/);
  assert.match(content, /headSha/);
  assert.match(content, /owner\/repo#\d+|PR 锚点/);
  assert.match(content, /\[SEVERITY\]\[CATEGORY\]/);
});

test('buildReviewChecklistSection: 测试环境无 roster → 返回 null（门控生效）', () => {
  // 测试环境未加载 cat-template，roster 为空，任何猫都不含 peer-reviewer 角色
  const result = buildReviewChecklistSection('some-cat');
  assert.equal(result, null);
});

test('parseReviewReport: 识别 [supply-chain] 类别（依赖伪造初判）', () => {
  const text = [
    '[BLOCKER][supply-chain] src/req.py:1 — 疑似拼写劫持包 requets | suggestion: 改用官方 requests',
    'Verdict: REQUEST_CHANGES',
  ].join('\n');
  const r = parseReviewReport(text);
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].category, 'supply-chain');
  assert.equal(r.findings[0].severity, 'blocker');
  assert.equal(r.verdict, 'changes_requested');
});

test('buildSystemPrompt: peer-reviewer(opus) + reviewContext.depSection → 注入 supply-chain 段落', () => {
  const prompt = buildSystemPrompt({
    catId: 'opus',
    mode: 'independent',
    teammates: [],
    mcpAvailable: false,
    reviewContext: {
      diff: '### src/a.ts (modified, +2/-1)',
      prAnchor: 'octo/cat#42',
      headSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      depSection: '## 第三方依赖来源安全初判（supply-chain）\n- `requets` 高危',
    },
  });
  assert.match(prompt, /第三方依赖来源安全初判/);
  assert.match(prompt, /requets/);
});

test('buildSystemPrompt: 非 peer-reviewer 即使有 reviewContext 也不注入 diff/dep 段落', () => {
  const prompt = buildSystemPrompt({
    catId: 'some-cat',
    mode: 'independent',
    teammates: [],
    mcpAvailable: false,
    reviewContext: {
      diff: '### src/a.ts (modified)',
      prAnchor: 'octo/cat#42',
      headSha: 'deadbeef',
      depSection: 'dep-section',
    },
  });
  assert.doesNotMatch(prompt, /本次待审代码变更（diff）/);
  assert.doesNotMatch(prompt, /第三方依赖来源安全初判/);
});

test('buildSystemPrompt: peer-reviewer(opus) + reviewContext → 注入 diff 段落与结算锚点', () => {
  const prompt = buildSystemPrompt({
    catId: 'opus',
    mode: 'independent',
    teammates: [],
    mcpAvailable: false,
    reviewContext: {
      diff: '### src/a.ts (modified, +2/-1)\n@@ -1,3 +1,4 @@',
      prAnchor: 'octo/cat#42',
      headSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    },
  });
  // Phase 1 checklist 注入
  assert.match(prompt, /你是本项目的代码 Reviewer/);
  // Phase 2 diff 段落注入
  assert.match(prompt, /本次待审代码变更（diff）/);
  // 结算锚点（headSha / PR）显式给出
  assert.match(prompt, /octo\/cat#42/);
  assert.match(prompt, /deadbeefdeadbeefdeadbeefdeadbeefdeadbeef/);
});

test('buildSystemPrompt: 无 reviewContext 时 peer-reviewer 不注入 diff 段落', () => {
  const prompt = buildSystemPrompt({
    catId: 'opus',
    mode: 'independent',
    teammates: [],
    mcpAvailable: false,
  });
  assert.match(prompt, /你是本项目的代码 Reviewer/);
  assert.doesNotMatch(prompt, /本次待审代码变更（diff）/);
});

test('buildSystemPrompt: peer-reviewer + reviewSubject（缓存已预取）→ 自动注入 diff 段落', async () => {
  // 模拟编排层在派发前异步预取
  const subject = { repoFullName: 'octo/cat', prNumber: 7777, headSha: 'facefeedfacefeedfacefeedfacefeedfacefeed' };
  await resolveReviewContext(subject, {
    token: 'tok',
    execFile: async () =>
      JSON.stringify([{ filename: 'src/a.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1,1 +1,1 @@\n a\n+b' }]),
  });
  const prompt = buildSystemPrompt({
    catId: 'opus',
    mode: 'independent',
    teammates: [],
    mcpAvailable: false,
    reviewSubject: subject,
  });
  assert.match(prompt, /你是本项目的代码 Reviewer/);
  assert.match(prompt, /本次待审代码变更（diff）/);
  assert.match(prompt, /octo\/cat#7777/);
  assert.match(prompt, /facefeedfacefeedfacefeedfacefeedfacefeed/);
});

test('buildSystemPrompt: peer-reviewer + reviewSubject 但缓存未预取 → 不注入 diff（盲审降级）', () => {
  const prompt = buildSystemPrompt({
    catId: 'opus',
    mode: 'independent',
    teammates: [],
    mcpAvailable: false,
    reviewSubject: { repoFullName: 'octo/cat', prNumber: 99999 },
  });
  assert.match(prompt, /你是本项目的代码 Reviewer/);
  assert.doesNotMatch(prompt, /本次待审代码变更（diff）/);
});
