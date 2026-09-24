import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildGhApiFilesArgs,
  parseGhApiFilesJson,
  parsePatchHunks,
  formatReviewDiff,
  buildReviewDiffSection,
  fetchPullRequestFiles,
  buildReviewerReviewContext,
  resolveReviewContext,
  getPreparedReviewContext,
  attachReviewContextForReview,
  reviewSubjectKey,
} from '../dist/domains/community/github/GitHubPrDiff.js';

const SAMPLE_PATCH = [
  '@@ -1,3 +1,4 @@',
  ' line one',
  '-old line',
  '+new line',
  '+added line',
  ' line three',
  '@@ -10,2 +11,2 @@',
  ' context',
  '-removed',
  '+replaced',
].join('\n');

test('buildGhApiFilesArgs: 构造正确的 gh api 路径', () => {
  assert.deepEqual(buildGhApiFilesArgs('octo', 'cat', 42), [
    'api',
    '--paginate',
    'repos/octo/cat/pulls/42/files',
  ]);
});

test('parseGhApiFilesJson: 解析文件清单并保留 patch', () => {
  const raw = JSON.stringify([
    { filename: 'src/a.ts', status: 'modified', additions: 2, deletions: 1, patch: SAMPLE_PATCH },
    { filename: 'src/b.ts', status: 'added', additions: 5, deletions: 0 },
  ]);
  const files = parseGhApiFilesJson(raw);
  assert.equal(files.length, 2);
  assert.equal(files[0].filename, 'src/a.ts');
  assert.equal(files[0].status, 'modified');
  assert.equal(files[0].additions, 2);
  assert.equal(files[0].patch, SAMPLE_PATCH);
  // 无 patch 的文件不应带 patch 字段
  assert.equal(files[1].patch, undefined);
});

test('parseGhApiFilesJson: 非数组返回空数组（防御性）', () => {
  assert.deepEqual(parseGhApiFilesJson('{"foo":1}'), []);
});

test('parsePatchHunks: 提取每个 hunk 的新文件行号', () => {
  const hunks = parsePatchHunks(SAMPLE_PATCH);
  assert.equal(hunks.length, 2);
  assert.equal(hunks[0].newStart, 1);
  assert.equal(hunks[0].newCount, 4);
  assert.equal(hunks[1].newStart, 11);
  assert.match(hunks[0].text, /@@ -1,3 \+1,4 @@/);
});

test('parsePatchHunks: 无 patch 返回空数组', () => {
  assert.deepEqual(parsePatchHunks(undefined), []);
  assert.deepEqual(parsePatchHunks(''), []);
});

test('formatReviewDiff: 输出文件摘要 + hunk，并锚定行号', () => {
  const files = [
    { filename: 'src/a.ts', status: 'modified', additions: 2, deletions: 1, patch: SAMPLE_PATCH },
  ];
  const out = formatReviewDiff(files);
  assert.match(out, /### src\/a\.ts \(modified, \+2\/-1\)/);
  assert.match(out, /@@ -1,3 \+1,4 @@/);
  assert.match(out, /\+new line/);
});

test('formatReviewDiff: 无 patch 文件给出提示而非崩溃', () => {
  const out = formatReviewDiff([
    { filename: 'img.png', status: 'added', additions: 0, deletions: 0 },
  ]);
  assert.match(out, /img\.png/);
  assert.match(out, /无 patch/);
});

test('formatReviewDiff: 超出预算时截断并标注省略数量', () => {
  const many = Array.from({ length: 50 }, (_, i) => ({
    filename: `src/file${i}.ts`,
    status: 'modified',
    additions: 1,
    deletions: 1,
    patch: SAMPLE_PATCH,
  }));
  const out = formatReviewDiff(many, { maxChars: 800 });
  assert.match(out, /已省略 \d+ 个文件/);
  assert.ok(out.length <= 800 + 200, '应在预算附近截断');
});

test('buildReviewDiffSection: 包裹 diff 为 reviewer 任务段落', () => {
  const section = buildReviewDiffSection('### src/a.ts (modified)');
  assert.match(section, /## 本次待审代码变更（diff）/);
  assert.match(section, /```diff/);
  assert.match(section, /### src\/a\.ts \(modified\)/);
  assert.match(section, /file:line/);
});

test('buildReviewDiffSection: 带 meta 时显式给出 PR 锚点与 headSha（结算校验所需）', () => {
  const section = buildReviewDiffSection('### src/a.ts', {
    prAnchor: 'octo/cat#42',
    headSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
  });
  assert.match(section, /PR: octo\/cat#42/);
  assert.match(section, /HEAD: deadbeefdeadbeefdeadbeefdeadbeefdeadbeef/);
});

test('buildReviewDiffSection: 无 meta 时不产生 PR/HEAD 行', () => {
  const section = buildReviewDiffSection('### src/a.ts');
  assert.doesNotMatch(section, /PR: /);
});

test('fetchPullRequestFiles: 注入 execFile 解析成功的清单', async () => {
  const files = await fetchPullRequestFiles('o', 'r', 1, {
    token: 'tok',
    execFile: async () =>
      JSON.stringify([{ filename: 'x.ts', status: 'modified', additions: 1, deletions: 0, patch: SAMPLE_PATCH }]),
  });
  assert.ok(files);
  assert.equal(files.length, 1);
  assert.equal(files[0].filename, 'x.ts');
});

test('fetchPullRequestFiles: 无 token 优雅降级返回 null', async () => {
  const files = await fetchPullRequestFiles('o', 'r', 1, { token: null });
  assert.equal(files, null);
});

test('fetchPullRequestFiles: execFile 抛错优雅降级返回 null', async () => {
  const files = await fetchPullRequestFiles('o', 'r', 1, {
    token: 'tok',
    execFile: async () => {
      throw new Error('boom');
    },
  });
  assert.equal(files, null);
});

test('buildReviewerReviewContext: 装配出可注入 reviewContext 的对象', async () => {
  const rc = await buildReviewerReviewContext('octo', 'cat', 7, 'deadbeef', {
    token: 'tok',
    execFile: async () =>
      JSON.stringify([{ filename: 'src/a.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1,1 +1,1 @@\n a\n+b' }]),
  });
  assert.ok(rc);
  assert.equal(rc.prAnchor, 'octo/cat#7');
  assert.equal(rc.headSha, 'deadbeef');
  assert.match(rc.diff, /src\/a\.ts/);
});

test('buildReviewerReviewContext: 拉取失败优雅降级返回 null', async () => {
  const rc = await buildReviewerReviewContext('octo', 'cat', 7, 'deadbeef', {
    token: 'tok',
    execFile: async () => {
      throw new Error('boom');
    },
  });
  assert.equal(rc, null);
});

// ---- F-REVIEW Phase 2 编排层（resolveReviewContext / 缓存 / 自动注入）----

test('reviewSubjectKey: 含 headSha 与不含时键不同', () => {
  assert.equal(reviewSubjectKey({ repoFullName: 'o/r', prNumber: 3 }), 'o/r#3');
  assert.equal(reviewSubjectKey({ repoFullName: 'o/r', prNumber: 3, headSha: 'abc' }), 'o/r#3@abc');
});

test('resolveReviewContext: 解析坐标→拉取→写入缓存并返回 reviewContext', async () => {
  const subject = { repoFullName: 'octo/cat', prNumber: 9001, headSha: 'feedface' };
  const rc = await resolveReviewContext(subject, {
    token: 'tok',
    execFile: async () =>
      JSON.stringify([{ filename: 'src/a.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1,1 +1,1 @@\n a\n+b' }]),
  });
  assert.ok(rc);
  assert.equal(rc.prAnchor, 'octo/cat#9001');
  assert.equal(rc.headSha, 'feedface');
  // 同步缓存已写入，供 prompt builder 读取
  assert.equal(getPreparedReviewContext(subject), rc);
});

test('resolveReviewContext: 坐标非法（无 owner/repo 斜杠）返回 null 且不污染缓存', async () => {
  const subject = { repoFullName: 'invalidrepo', prNumber: 1 };
  const rc = await resolveReviewContext(subject, { token: 'tok', execFile: async () => JSON.stringify([]) });
  assert.equal(rc, null);
  assert.equal(getPreparedReviewContext(subject), null);
});

test('attachReviewContextForReview: 把解析结果挂到 reviewContext 上', async () => {
  const ctx = { reviewSubject: { repoFullName: 'octo/cat', prNumber: 9002, headSha: 'cafe' } };
  await attachReviewContextForReview(ctx, {
    token: 'tok',
    execFile: async () =>
      JSON.stringify([{ filename: 'src/a.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1,1 +1,1 @@\n a\n+b' }]),
  });
  assert.ok(ctx.reviewContext);
  assert.equal(ctx.reviewContext.prAnchor, 'octo/cat#9002');
});

test('attachReviewContextForReview: 无 reviewSubject 时为空操作', async () => {
  const ctx = {};
  await attachReviewContextForReview(ctx);
  assert.equal(ctx.reviewContext, undefined);
});
