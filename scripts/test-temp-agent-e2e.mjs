/**
 * 临时 Agent（sub-agent）端到端测试脚本 —— 设计「一次专门的对话」来验证特性。
 *
 * 背景：
 *   POST /api/callbacks/spawn-temp-agent 需要父 invocation 的鉴权头
 *   (X-Invocation-Id + X-Callback-Token)。这两个值在猫被对话触发时由服务端
 *   生成，并存进 Redis（key: cat-cafe:auth:inv:{invocationId}，hash 含 callbackToken）。
 *
 * 本脚本做的事：
 *   1. 连 Redis，扫描所有 auth:inv:* 记录，挑 createdAt 最新的一条（= 你刚发的那条对话）。
 *   2. 取出 invocationId + callbackToken（+ catId / threadId，仅打印供核对）。
 *   3. 用这两个头 + 一个 task 请求 spawn-temp-agent 路由。
 *   4. 打印子 Agent 的返回（status / output / durationMs 等）。
 *
 * 用法：
 *   # 1) 先按 README 启动（用 Redis 模式，不要加 -Memory）：
 *   #    .\scripts\start-windows.ps1        # 会自动起 Redis + API(:3004) + Web(:3003)
 *   # 2) 浏览器开 http://localhost:3003，给某只猫发一条消息（触发一个真实 invocation）。
 *   # 3) 配置该猫的 provider 指向你的免费 API（Hub → System Settings → Account Configuration）。
 *   # 4) 跑本脚本（建议从仓库根目录，node 22+）：
 *   #    node scripts/test-temp-agent-e2e.mjs
 *   #    TASK="用一句话解释什么是闭包" node scripts/test-temp-agent-e2e.mjs
 *
 * 环境变量（都有默认值，多数不用改）：
 *   REDIS_URL        默认 redis://localhost:6399
 *   API_SERVER_PORT  默认 3004
 *   TASK             子 Agent 的任务，默认一段示例
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

// ioredis 通过 shamefully-hoist 提升到了仓库根 node_modules；从脚本所在仓库根解析。
const repoRoot = resolve(__dirname, '..');
let Redis;
try {
  Redis = require(resolve(repoRoot, 'node_modules/ioredis'));
} catch {
  // 兜底：直接按包名解析（在 api 包内也可）
  Redis = require('ioredis');
}

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6399';
const API_PORT = process.env.API_SERVER_PORT || '3004';
const TASK =
  process.env.TASK ||
  '请用两句话向一个完全不懂编程的人解释：什么是“临时子 Agent”？它和普通的多 Agent 协作有什么区别？';

console.log(`[e2e] connecting to Redis: ${REDIS_URL}`);
const redis = new Redis(REDIS_URL, { maxRetrievers: 1, lazyConnect: true });
await redis.connect();

const KEY_PREFIX = 'cat-cafe:';

let cursor = '0';
let best = null; // { invocationId, callbackToken, catId, threadId, createdAt, expiresAt }
do {
  // ioredis 的 SCAN pattern 不会自动加前缀；真实 key 是 cat-cafe:auth:inv:{id}
  const [next, keys] = await redis.scan(cursor, 'MATCH', `${KEY_PREFIX}auth:inv:*`, 'COUNT', 100);
  cursor = next;
  for (const fullKey of keys) {
    // HGETALL 会自动加前缀，所以这里要传裸 key（剥掉 cat-cafe:）
    const bare = fullKey.startsWith(KEY_PREFIX) ? fullKey.slice(KEY_PREFIX.length) : fullKey;
    const raw = await redis.hgetall(bare);
    if (!raw || !raw.invocationId || !raw.callbackToken) continue;
    const createdAt = Number(raw.createdAt || 0);
    if (!best || createdAt > best.createdAt) {
      best = {
        invocationId: raw.invocationId,
        callbackToken: raw.callbackToken,
        catId: raw.catId || '',
        threadId: raw.threadId || '',
        createdAt,
        expiresAt: Number(raw.expiresAt || 0),
      };
    }
  }
} while (cursor !== '0');

if (!best) {
  console.error(
    '\n[e2e] 没找到任何 invocation 记录。请确认：\n' +
      '  1) 你是用 Redis 模式启动的（没加 -Memory）；\n' +
      '  2) 你已经给某只猫发过一条消息（产生了一个真实 invocation）。',
  );
  await redis.quit();
  process.exit(1);
}

const now = Date.now();
if (best.expiresAt && now > best.expiresAt) {
  console.error(
    `\n[e2e] 找到的 invocation 已过期（createdAt=${new Date(best.createdAt).toISOString()}，已失效）。\n` +
      '请重新给猫发一条消息，然后再跑本脚本。',
  );
  await redis.quit();
  process.exit(1);
}

console.log('[e2e] 选中的父 invocation:');
console.log(`       invocationId : ${best.invocationId}`);
console.log(`       catId        : ${best.catId}`);
console.log(`       threadId     : ${best.threadId}`);
console.log(`       createdAt    : ${new Date(best.createdAt).toISOString()}`);
console.log(`[e2e] task         : ${TASK}\n`);

const url = `http://localhost:${API_PORT}/api/callbacks/spawn-temp-agent`;
console.log(`[e2e] POST ${url}`);

let res;
try {
  res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Invocation-Id': best.invocationId,
      'X-Callback-Token': best.callbackToken,
    },
    body: JSON.stringify({ task: TASK }),
  });
} catch (err) {
  console.error(`\n[e2e] 请求失败：${err?.message || err}`);
  console.error('       确认 API 是否在 http://localhost:' + API_PORT + ' 上运行。');
  await redis.quit();
  process.exit(1);
}

const text = await res.text();
let body;
try {
  body = JSON.parse(text);
} catch {
  body = text;
}

await redis.quit();

console.log(`\n[e2e] HTTP ${res.status}`);
if (typeof body === 'object') {
  console.log('[e2e] 响应:');
  console.log('  status     :', body.status);
  console.log('  reason     :', body.reason ?? '(无)');
  console.log('  durationMs :', body.durationMs ?? '(无)');
  console.log('  invocationId (子):', body.invocationId ?? '(无)');
  console.log('  deduped    :', body.deduped ?? '(无)');
  console.log('  output:');
  console.log('  ────────────────────────────────────────────────');
  console.log('  ' + String(body.output ?? '').replace(/\n/g, '\n  '));
  console.log('  ────────────────────────────────────────────────');
} else {
  console.log('[e2e] 原始响应:');
  console.log(body);
}

if (res.status === 401) {
  console.error('\n[!] 401：callbackToken 失效或不是最新 invocation。重新给猫发一条消息再试。');
} else if (res.status === 403) {
  console.error('\n[!] 403：父 invocation 的 toolExecutionPolicy 拒绝了 spawn-temp-agent（read_only 名单里）。');
} else if (res.status === 503) {
  console.error('\n[!] 503：该 cat 没有可用的 AgentService / provider 未配置。去 Hub 给这只猫配上你的免费 API。');
}
