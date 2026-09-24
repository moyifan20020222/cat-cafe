import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  extractPythonImports,
  levenshtein,
  assessPypiProvenance,
  fetchPypiPackageInfo,
  buildDependencyReviewContext,
} from '../dist/domains/community/github/PypiProvenance.js';

const POPULAR = ['requests', 'numpy', 'django', 'flask', 'pandas'];

test('extractPythonImports: 解析新增导入、去重、忽略删除行', () => {
  const diff = [
    '+++ b/src/req.py',
    '@@ -0,0 +1,4 @@',
    '+import requests',
    '+import os',
    '+from sklearn.linear_model import LogisticRegression',
    '+from collections import OrderedDict',
    '-import removed_pkg',
    ' context',
  ].join('\n');
  const imports = extractPythonImports(diff);
  assert.deepEqual(imports.sort(), ['collections', 'os', 'requests', 'sklearn'].sort());
});

test('levenshtein: 基础距离', () => {
  assert.equal(levenshtein('requests', 'requests'), 0);
  assert.equal(levenshtein('requets', 'requests'), 1);
  assert.equal(levenshtein('reqests', 'requests'), 1);
  assert.equal(levenshtein('abc', 'ab'), 1);
});

test('assessPypiProvenance: 包名近似热门包 + 低下载 + 近期新建 → 高危', () => {
  const a = assessPypiProvenance(
    { name: 'requets', version: '1', firstUploadIso: '2026-09-15T00:00:00Z', recentDownloads: 5 },
    { popularNames: POPULAR },
  );
  assert.equal(a.risk, 'high');
  assert.ok(a.reasons.some((r) => r.includes('拼写劫持')));
  assert.ok(a.reasons.some((r) => r.includes('下载量极低')));
  assert.ok(a.reasons.some((r) => r.includes('疑似新建')));
});

test('assessPypiProvenance: 官方热门包 + 高下载 + 历史久 → 低危', () => {
  const a = assessPypiProvenance(
    { name: 'requests', version: '2', firstUploadIso: '2011-01-01T00:00:00Z', recentDownloads: 100_000_000 },
    { popularNames: POPULAR },
  );
  assert.equal(a.risk, 'low');
});

test('assessPypiProvenance: 低下载但历史久、无相似 → 中危', () => {
  const a = assessPypiProvenance(
    { name: 'obscurelib', version: '1', recentDownloads: 50 },
    { popularNames: POPULAR },
  );
  assert.equal(a.risk, 'medium');
});

test('fetchPypiPackageInfo: 注入 fetch 解析元数据 + pypistats 下载量', async () => {
  const fakeFetch = async (url) => {
    if (url.includes('pypistats.org')) {
      return { ok: true, status: 200, json: async () => ({ data: [{ downloads: 1000 }, { downloads: 2000 }] }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        info: { name: 'Flask', version: '3.2', author: 'p' },
        urls: [{ upload_time_iso_8601: '2020-05-01T00:00:00Z' }],
      }),
    };
  };
  const info = await fetchPypiPackageInfo('Flask', { fetchFn: fakeFetch });
  assert.ok(info);
  assert.equal(info.name, 'flask');
  assert.equal(info.version, '3.2');
  assert.equal(info.firstUploadIso, '2020-05-01T00:00:00Z');
  assert.equal(info.recentDownloads, 3000);
});

test('fetchPypiPackageInfo: 包不存在（404）→ null（优雅降级）', async () => {
  const fakeFetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
  const info = await fetchPypiPackageInfo('nope-pkg-xyz', { fetchFn: fakeFetch });
  assert.equal(info, null);
});

test('buildDependencyReviewContext: 识别出拼写劫持包并标高危', async () => {
  const fakeFetch = async (url) => {
    if (url.includes('pypistats.org')) {
      const risky = url.includes('requets');
      return { ok: true, status: 200, json: async () => ({ data: [{ downloads: risky ? 5 : 1_000_000 }] }) };
    }
    const risky = url.includes('requets');
    return {
      ok: true,
      status: 200,
      json: async () => ({
        info: { name: risky ? 'requets' : 'os', version: '1.0' },
        urls: [{ upload_time_iso_8601: risky ? '2026-09-15T00:00:00Z' : '2011-01-01T00:00:00Z' }],
      }),
    };
  };
  const diff = ['+import requets', '+import os'].join('\n');
  const res = await buildDependencyReviewContext(diff, { fetchFn: fakeFetch, popularNames: POPULAR });
  assert.ok(res);
  assert.match(res.depSection, /第三方依赖来源安全初判/);
  assert.match(res.depSection, /高危/);
  assert.deepEqual(res.riskyImports, ['requets']);
});

test('buildDependencyReviewContext: 无导入 → null', async () => {
  const res = await buildDependencyReviewContext('@@ -1,1 +1,1 @@\n a\n-b', { popularNames: POPULAR });
  assert.equal(res, null);
});
