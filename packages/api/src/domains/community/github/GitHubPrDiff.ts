/**
 * F-REVIEW Phase 2: PR diff 感知
 *
 * 背景：Phase 1 给 reviewer 猫注入了「审核清单 + 结构化输出契约」，但 reviewer 猫
 * 当时**看不到真实代码变更**——它只能凭 PR 描述/消息自由发挥（见仓库内
 * `github-repo-event` 连接器只处理入站 webhook，不拉取 diff）。这导致 reviewer
 * 的审核是"盲审"。
 *
 * 本模块补齐 diff 感知：
 *   1) `fetchPullRequestFiles` —— 通过项目既有的 `gh` CLI 鉴权链路
 *     （`resolveGhCliToken` / `buildGhCliEnv`）调用
 *      `gh api repos/{owner}/{repo}/pulls/{number}/files --paginate`，
 *      取回变更文件清单 + 每个文件的 unified diff patch。
 *   2) `parseGhApiFilesJson` / `parsePatchHunks` —— 纯函数，把 patch 解析成
 *      带「新文件行号」的 hunk，供 findings 锚定到 `file:line`。
 *   3) `formatReviewDiff` —— 纯函数，在 token 预算内把 diff 压成可注入的上下文文本。
 *   4) `buildReviewDiffSection` —— 纯函数，把 diff 包成 reviewer 猫的任务级上下文段落
 *      （与 `reviewChecklistPrompt` 同构，便于单测；由编排层在调用 reviewer 猫时注入
 *      到任务消息，而非 system prompt，以保持 legacy / production 双路径结构一致）。
 *
 * 优雅降级：无 token / `gh` 不可用 / 网络失败时 `fetchPullRequestFiles` 返回 `null`，
 * 编排层据此退回"仅依据 PR 描述盲审"的现有行为，不阻塞 review 流程。
 *
 * 编排层（消费方）：`resolveReviewContext(subject)` 在派发 review 时一次性异步预取并写入
 * 进程内有界缓存；同步的 prompt builder 读取 `InvocationContext.reviewSubject` 后从缓存注入，
 * 因此调用方只需在构建 reviewer 猫上下文时填入 `reviewSubject` 即可，无需自己管理 diff 文本。
 */

import { spawn } from 'node:child_process';
import { buildGhCliEnv, resolveGhCliToken, withHiddenGhCliWindow } from '../../../infrastructure/github/gh-cli-env.js';

export type GhPrFileStatus =
  | 'added'
  | 'modified'
  | 'removed'
  | 'renamed'
  | 'copied'
  | 'changed';

export interface GhPrFile {
  filename: string;
  status: GhPrFileStatus;
  additions: number;
  deletions: number;
  /** unified diff patch（二进制/超大文件可能缺失） */
  patch?: string;
}

export interface FetchPrFilesOptions {
  /** 显式 token；缺省时走 `resolveGhCliToken`（GITHUB_TOKEN / GH_TOKEN）。 */
  token?: string | null;
  /** 子进程工作目录（一般不需要）。 */
  cwd?: string;
  /** 测试注入：替换真实 spawn，便于断言命令构造而不触网。 */
  execFile?: GhApiExecutor;
}

/** 测试可注入的执行器：给定 `gh` 参数，返回 stdout 文本。 */
export type GhApiExecutor = (args: string[]) => Promise<string>;

/**
 * 构造 `gh api` 拉取 PR 文件清单的参数（纯函数，便于断言）。
 * 使用 `--paginate` 自动翻页，`--jq` 不做二次过滤（保持数组结构交由解析器处理）。
 */
export function buildGhApiFilesArgs(owner: string, repo: string, number: number): string[] {
  return [
    'api',
    '--paginate',
    `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}/files`,
  ];
}

export function parseGhApiFilesJson(raw: string): GhPrFile[] {
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.map((f: Record<string, unknown>) => ({
    filename: String(f.filename ?? ''),
    status: String(f.status ?? 'modified') as GhPrFileStatus,
    additions: Number(f.additions ?? 0),
    deletions: Number(f.deletions ?? 0),
    ...(typeof f.patch === 'string' ? { patch: f.patch } : {}),
  }));
}

export interface ParsedHunk {
  /** `@@ -a,b +c,d @@` 中的新文件起始行 c。 */
  newStart: number;
  /** 新文件侧行数 d。 */
  newCount: number;
  /** hunk 原始文本（含 `@@` 头与上下文）。 */
  text: string;
}

const HUNK_HEADER_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/**
 * 纯函数：把单个文件的 unified diff patch 解析成带新文件行号的 hunk 列表。
 * 解析失败（无 patch / 格式异常）返回空数组，调用方可据此跳过锚定。
 */
export function parsePatchHunks(patch: string | undefined): ParsedHunk[] {
  if (!patch) return [];
  const hunks: ParsedHunk[] = [];
  const lines = patch.split('\n');
  let current: { header: string; body: string[]; newStart: number; newCount: number } | null = null;

  for (const line of lines) {
    const m = HUNK_HEADER_RE.exec(line);
    if (m) {
      if (current) hunks.push({ ...current, text: [current.header, ...current.body].join('\n') });
      current = {
        header: line,
        body: [],
        newStart: Number(m[1]),
        newCount: m[2] !== undefined ? Number(m[2]) : 1,
      };
      continue;
    }
    if (current) current.body.push(line);
  }
  if (current) hunks.push({ ...current, text: [current.header, ...current.body].join('\n') });
  return hunks;
}

export interface FormatReviewDiffOptions {
  /** 字符预算（≈ tokens * 4）。超出则截断并标注省略。默认 12000（≈3000 tokens）。 */
  maxChars?: number;
}

/**
 * 纯函数：把变更文件清单压成可注入 reviewer 猫的紧凑 diff 上下文。
 * - 每个文件一行摘要（`### file (status, +a/-d)`）后接尽可能完整的 hunk；
 * - 在 `maxChars` 预算内贪心保留文件，超出部分标注 `(已省略 N 个文件)`；
 * - 无 patch 的文件（二进制/超大）给出提示，由 reviewer 凭文件名/状态判断影响。
 */
export function formatReviewDiff(files: readonly GhPrFile[], options: FormatReviewDiffOptions = {}): string {
  const maxChars = options.maxChars ?? 12000;
  const blocks: string[] = [];
  let total = 0;
  let omitted = 0;
  let truncated = false;

  for (const f of files) {
    const summary = `### ${f.filename} (${f.status}, +${f.additions}/-${f.deletions})`;
    const hunks = parsePatchHunks(f.patch);
    const patchText = hunks.length > 0 ? `\n${hunks.map((h) => h.text).join('\n')}` : '\n(无 patch：二进制或超大文件，请依据文件名/状态判断影响范围)';
    const block = `${summary}${patchText}`;
    const next = total + block.length + 1;
    if (next > maxChars) {
      if (!truncated) {
        // 预算已满：尝试至少保留文件摘要行，丢弃其 patch
        if (total + summary.length + 1 <= maxChars) {
          blocks.push(summary);
          total += summary.length + 1;
        }
        truncated = true;
      }
      omitted += 1;
      continue;
    }
    blocks.push(block);
    total = next;
  }

  let out = blocks.join('\n');
  if (omitted > 0) out += `\n\n(已省略 ${omitted} 个文件——超出 token 预算，请聚焦已列出的变更)`;
  return out;
}

export interface ReviewDiffMeta {
  /** PR 锚点，形如 `owner/repo#123`。 */
  prAnchor?: string;
  /** 被审代码的精确 head SHA。 */
  headSha?: string;
}

/**
 * 纯函数：把格式化后的 diff 包成 reviewer 猫的「任务级上下文段落」。
 * 与 `reviewChecklistPrompt` 同构——只产内容，不负责注入位置（由编排层注入任务消息）。
 * 当传入 `prAnchor` / `headSha` 时，会在段首显式给出，便于 reviewer 在裁决中回显，
 * 以满足 `LocalReviewEvidenceProvider` 的结算校验（必须含 headSha + PR 锚点）。
 */
export function buildReviewDiffSection(diff: string, meta?: ReviewDiffMeta): string {
  const anchorLines: string[] = [];
  if (meta?.prAnchor || meta?.headSha) {
    anchorLines.push(
      `PR: ${meta.prAnchor ?? '(unknown)'}　HEAD: ${meta.headSha ?? '(unknown)'}`,
    );
    anchorLines.push('');
  }
  const lines = [
    '## 本次待审代码变更（diff）',
    '',
    '以下为 PR 的真实变更内容（已做 token 预算裁剪）。请**基于这些真实代码**逐项给出结构化 review：',
    '每条 finding 务必用 `file:line` 锚定到下方 diff 中的具体位置。',
    ...anchorLines,
    '```diff',
    diff,
    '```',
    '',
    '（若某文件未包含 patch，请依据文件名/状态判断影响范围，不要臆测未给出的代码。）',
  ];
  return lines.join('\n');
}

/**
 * 通过 `gh` CLI 拉取 PR 变更文件。无 token / 执行失败返回 `null`（优雅降级）。
 * 生产链路复用项目既有的 GitHub 鉴权（GITHUB_TOKEN / GH_TOKEN → `gh`）。
 */
export async function fetchPullRequestFiles(
  owner: string,
  repo: string,
  number: number,
  options: FetchPrFilesOptions = {},
): Promise<GhPrFile[] | null> {
  const token = options.token ?? resolveGhCliToken();
  if (!token) return null;

  const args = buildGhApiFilesArgs(owner, repo, number);

  if (options.execFile) {
    try {
      const raw = await options.execFile(args);
      return parseGhApiFilesJson(raw);
    } catch {
      return null;
    }
  }

  try {
    const raw = await runGh(args, token, options.cwd);
    return parseGhApiFilesJson(raw);
  } catch {
    return null;
  }
}

function runGh(args: string[], token: string, cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'gh',
      args,
      withHiddenGhCliWindow({
        env: buildGhCliEnv({ token }),
        ...(cwd ? { cwd } : {}),
        windowsHide: true,
      }),
    );
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => (stdout += d.toString()));
    child.stderr?.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`gh exited ${code}: ${stderr.slice(0, 500)}`));
    });
  });
}

/**
 * 编排层在派发 review 任务时调用的一次性装配函数：
 * 拉取 PR 变更 → 格式化 → 产出可直接塞进 `InvocationContext.reviewContext` 的对象。
 * 返回 `null` 表示无 token / 拉取失败 / 无变更，编排层据此退回"盲审"而不阻塞。
 *
 * 用法（在 review 派发处，已知 owner/repo/number/headSha 时）：
 *   const rc = await buildReviewerReviewContext(owner, repo, prNumber, headSha);
 *   if (rc) invocationContext.reviewContext = rc;
 */
export interface ReviewerReviewContext {
  diff: string;
  prAnchor: string;
  headSha: string;
  /** supply-chain 初判段落（F-REVIEW Phase 2 依赖审查；可选，由编排层核对后填充）。 */
  depSection?: string;
}

export async function buildReviewerReviewContext(
  owner: string,
  repo: string,
  number: number,
  headSha: string,
  options: FetchPrFilesOptions = {},
): Promise<ReviewerReviewContext | null> {
  const files = await fetchPullRequestFiles(owner, repo, number, options);
  if (!files || files.length === 0) return null;
  const diff = formatReviewDiff(files);
  return { diff, prAnchor: `${owner}/${repo}#${number}`, headSha };
}

/**
 * F-REVIEW Phase 2（编排层）：review 派发处携带的 PR 主题坐标。
 * 形如 `owner/repo` 的 `repoFullName` 与项目其余 review 代码（ExternalReviewCoordinator 等）保持一致。
 */
export interface ReviewSubject {
  repoFullName: string;
  prNumber: number;
  headSha?: string;
}

/** 由 `ReviewSubject` 派生缓存键（headSha 缺失时仅用 repo#pr）。 */
export function reviewSubjectKey(subject: ReviewSubject): string {
  return subject.headSha
    ? `${subject.repoFullName}#${subject.prNumber}@${subject.headSha}`
    : `${subject.repoFullName}#${subject.prNumber}`;
}

/** 把 `owner/repo` 拆成 owner / repo；格式非法返回 null。 */
function splitRepoFullName(repoFullName: string): { owner: string; repo: string } | null {
  const idx = repoFullName.indexOf('/');
  if (idx <= 0 || idx >= repoFullName.length - 1) return null;
  return { owner: repoFullName.slice(0, idx), repo: repoFullName.slice(idx + 1) };
}

/**
 * 进程内有界缓存：编排层 `resolveReviewContext`（异步）预取后写入，
 * 同步的 prompt builder 在构建 peer-reviewer 上下文时读取，避免每次构建都触网。
 * LRU 淘汰，上限 64 条，防止长进程内存膨胀。
 */
const reviewDiffCache = new Map<string, ReviewerReviewContext>();
const REVIEW_DIFF_CACHE_MAX = 64;

function cachePut(key: string, value: ReviewerReviewContext): void {
  if (reviewDiffCache.size >= REVIEW_DIFF_CACHE_MAX) {
    const oldest = reviewDiffCache.keys().next().value;
    if (typeof oldest === 'string') reviewDiffCache.delete(oldest);
  }
  reviewDiffCache.set(key, value);
}

/** 同步读取预取的 review 上下文（供 prompt builder 注入）。未预取返回 null。 */
export function getPreparedReviewContext(subject: ReviewSubject): ReviewerReviewContext | null {
  return reviewDiffCache.get(reviewSubjectKey(subject)) ?? null;
}

/**
 * 编排层在派发 review 任务（已知 PR 坐标且 cat 为 peer-reviewer）时调用的一次性异步装配：
 * 解析坐标 → 拉取 PR 变更 → 格式化 → 写入缓存并返回。
 * 返回 `null` 表示坐标非法 / 无 token / 拉取失败 / 无变更，调用方据此退回"盲审"而不阻塞。
 *
 * 用法（review 派发处，await 后 reviewer 猫的 `InvocationContext.reviewSubject` 即被消费）：
 *   const rc = await resolveReviewContext({ repoFullName, prNumber, headSha });
 *   if (rc) invocationContext.reviewContext = rc;   // 也可仅靠 reviewSubject + 缓存自动注入
 */
export async function resolveReviewContext(
  subject: ReviewSubject,
  options: FetchPrFilesOptions = {},
): Promise<ReviewerReviewContext | null> {
  const split = splitRepoFullName(subject.repoFullName);
  if (!split) return null;
  const rc = await buildReviewerReviewContext(
    split.owner,
    split.repo,
    subject.prNumber,
    subject.headSha ?? '',
    options,
  );
  if (rc) cachePut(reviewSubjectKey(subject), rc);
  return rc;
}

/**
 * 编排层便捷封装：把解析结果直接挂到 `InvocationContext.reviewContext` 上，
 * 供同步的 prompt builder 注入。调用方在构建 reviewer 猫上下文后、调用
 * `buildSystemPrompt` / 派发 cat 之前执行一次即可。
 */
export async function attachReviewContextForReview(
  context: { reviewSubject?: ReviewSubject; reviewContext?: ReviewerReviewContext },
  options: FetchPrFilesOptions = {},
): Promise<void> {
  if (!context.reviewSubject) return;
  const rc = await resolveReviewContext(context.reviewSubject, options);
  if (rc) context.reviewContext = rc;
}
