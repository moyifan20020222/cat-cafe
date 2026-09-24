/**
 * Code Review 领域类型（F-REVIEW）
 *
 * 背景：原 `LocalReviewVerdict` 只是字符串枚举
 * (`approved` | `changes_requested` | `commented`)，reviewer 猫产出的是自由文本，
 * 系统只用正则校验里面有没有 APPROVE/REQUEST_CHANGES + headSha + PR 锚点。
 * 这导致审核"没有结构化结论"——不知道审出了什么问题、在哪个文件哪一行、严重度如何。
 *
 * 本文件把审核升级为**结构化裁决**：reviewer 猫除了给出总 verdict，还要产出
 * 一组 `CodeReviewFinding`（每条带严重度/分类/文件行号/评论/建议）。
 * 这样既保留了与原 `LocalReviewVerdict` 枚举的语义兼容（verdict 可由 findings 派生），
 * 又能把"审出了什么"沉淀下来（见 Phase 3 回流长期记忆）。
 */

/** 严重度：blocker=必须改才能合；major=强烈建议改；minor=应该改；nit=吹毛求疵 */
export type ReviewSeverity = 'blocker' | 'major' | 'minor' | 'nit';

/**
 * 分类：让 findings 可聚合、可路由。
 * - security      安全问题（注入、越权、密钥泄露…）
 * - correctness   正确性问题（逻辑错误、边界、并发…）
 * - performance   性能问题
 * - maintainability 可维护性（重复、耦合、命名…）
 * - tests         测试缺失/错误
 * - style         风格（在不阻塞时尽量不报）
 * - documentation 文档/注释缺失
 * - supply-chain  依赖来源安全（新增的第三方包导入是否为伪造/拼写劫持包；
 *                 对照 PyPI/npm 官方元数据：下载量、首次上传时间、与热门包名相似度）
 */
export type ReviewCategory =
  | 'security'
  | 'correctness'
  | 'performance'
  | 'maintainability'
  | 'tests'
  | 'style'
  | 'documentation'
  | 'supply-chain';

/**
 * 单条审核发现。
 * 注意 `file` / `line` 都是可选的：当 reviewer 给的是全局性建议（如"请补充整体测试策略"）
 * 时可以不绑定具体位置；但当能定位时务必填，否则 findings 无法被 diff 锚定。
 */
export interface CodeReviewFinding {
  /** 严重度，决定是否需要阻塞合并 */
  severity: ReviewSeverity;
  /** 问题分类 */
  category: ReviewCategory;
  /** 受影响文件（相对于仓库根） */
  file?: string;
  /** 受影响行（1-based；区间可表示为 "12-18" 的字符串，本类型仅存起点） */
  line?: number;
  /** 问题描述：哪里有问题、为什么是问题（面向作者，不要情绪化） */
  comment: string;
  /** 修复建议：具体怎么改（可含代码示例片段） */
  suggestion?: string;
  /** reviewer 对这条发现的确信度，便于下游过滤低置信噪声 */
  confidence: 'high' | 'medium' | 'low';
}

/**
 * 与原 `LocalReviewVerdict` 枚举语义兼容的总裁决。
 * 之所以保留三态而不是用 findings 直接替代，是因为下游结算/证据校验仍依赖这三个 token。
 * `verdict` 可由 `deriveVerdict(findings)` 自动推导：存在 blocker/major 即 changes_requested，
 * 全为 nit/minor 且 reviewer 仍想通过时为 approved，否则 commented。
 */
export type ReviewVerdict = 'approved' | 'changes_requested' | 'commented';

/**
 * 结构化审核报告：reviewer 猫的最终产出。
 * `verdict` 是给原结算体系的兼容字段；`findings` 是新增的结构化结论；
 * `summary` 是给作者的一句话总评。
 */
export interface StructuredReviewReport {
  verdict: ReviewVerdict;
  summary: string;
  findings: CodeReviewFinding[];
}

/**
 * 由 findings 推导总裁决（供 reviewer 猫偷懒只填 findings 时使用，也可由解析器在缺省 verdict 时补齐）。
 * - 任一 blocker 或 major → changes_requested（必须改）
 * - 仅 minor/nit → commented（给了意见但不阻塞）
 * - 无 findings → approved（看起来没问题）
 */
export function deriveVerdict(findings: readonly CodeReviewFinding[]): ReviewVerdict {
  let hasBlocking = false;
  let hasMinor = false;
  for (const f of findings) {
    if (f.severity === 'blocker' || f.severity === 'major') hasBlocking = true;
    if (f.severity === 'minor' || f.severity === 'nit') hasMinor = true;
  }
  if (hasBlocking) return 'changes_requested';
  if (hasMinor) return 'commented';
  return 'approved';
}

/** 严重度排序权重，用于 findings 排序（blocker 在前）。 */
export const SEVERITY_RANK: Record<ReviewSeverity, number> = {
  blocker: 0,
  major: 1,
  minor: 2,
  nit: 3,
};

/** 按严重度降序稳定排序 findings（同严重度保持原顺序）。 */
export function sortFindingsBySeverity(findings: readonly CodeReviewFinding[]): CodeReviewFinding[] {
  return findings
    .map((f, i) => ({ f, i }))
    .sort((a, b) => SEVERITY_RANK[a.f.severity] - SEVERITY_RANK[b.f.severity] || a.i - b.i)
    .map((x) => x.f);
}

/**
 * 从 reviewer 猫的自由文本裁决中解析出结构化审核报告。
 *
 * 设计：reviewer 猫按我们注入的 checklist 输出形如
 *   `[BLOCKER][security] src/foo.ts:42 — 这里会注入用户输入 | suggestion: 用参数化查询`
 * 的行；本函数容忍缺省（无 category/无 file:line/无 suggestion），并把
 * 总 verdict 映射回 `LocalReviewVerdict` 三态（缺省时由 findings 推导）。
 *
 * 与 `LocalReviewEvidenceProvider.containsVerdict` 的文法保持一致：
 * APPROVE(D)? / REQUEST_CHANGES|CHANGES_REQUESTED / COMMENT(ED)?。
 */
const SEVERITY_RE = /\[(blocker|major|minor|nit)\]/i;
const CATEGORY_RE =
  /\[(security|correctness|performance|maintainability|tests|style|documentation|supply-chain|dependency)\]/i;
const FILE_LINE_RE = /([^\s:]+\.[\w]+):(\d+)/;
const VERDICT_RE = /verdict:\s*(APPROVE(?:D)?|REQUEST_CHANGES|CHANGES_REQUESTED|COMMENT(?:ED)?)/i;
const SUMMARY_RE = /summary:\s*(.+)/i;

const VERDICT_TOKEN_MAP: Record<string, ReviewVerdict> = {
  approve: 'approved',
  approved: 'approved',
  request_changes: 'changes_requested',
  changes_requested: 'changes_requested',
  comment: 'commented',
  commented: 'commented',
};

function parseVerdictToken(raw: string): ReviewVerdict | null {
  const key = raw.toLowerCase().replace(/[()]/g, '');
  return VERDICT_TOKEN_MAP[key] ?? null;
}

export function parseReviewReport(text: string): StructuredReviewReport {
  const lines = text.split('\n');
  const findings: CodeReviewFinding[] = [];
  let verdict: ReviewVerdict | null = null;
  let summary: string | null = null;
  let summaryFallback: string | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const verdictMatch = VERDICT_RE.exec(line);
    if (verdictMatch && !verdict) {
      verdict = parseVerdictToken(verdictMatch[1]);
    }

    const summaryMatch = SUMMARY_RE.exec(line);
    if (summaryMatch && !summary) {
      summary = summaryMatch[1].trim();
    }

    const sev = SEVERITY_RE.exec(line);
    const cat = CATEGORY_RE.exec(line);
    if (sev && cat) {
      // Strip the two tag brackets + optional "—"/"-" separator, then split comment/suggestion.
      let body = line
        .replace(SEVERITY_RE, '')
        .replace(CATEGORY_RE, '')
        .replace(/^[*\-]\s*/, '')
        .replace(/^[—-]\s*/, '')
        .trim();
      const fileLine = FILE_LINE_RE.exec(body);
      let file: string | undefined;
      let lineNo: number | undefined;
      if (fileLine) {
        file = fileLine[1];
        lineNo = Number(fileLine[2]);
        body = (body.slice(0, fileLine.index) + body.slice(fileLine.index + fileLine[0].length)).trim();
      }
      const suggestionSplit = body.split(/\s*\|\s*(?:suggestion|fix):\s*/i);
      const comment = suggestionSplit[0].replace(/^[—-]\s*/, '').trim();
      const suggestion = suggestionSplit[1]?.trim() || undefined;
      findings.push({
        severity: sev[1].toLowerCase() as ReviewSeverity,
        category: cat[1].toLowerCase() as ReviewCategory,
        ...(file ? { file } : {}),
        ...(lineNo !== undefined ? { line: lineNo } : {}),
        comment,
        ...(suggestion ? { suggestion } : {}),
        confidence: 'high',
      });
      continue;
    }

    // 记录第一个非空非标签行作为 fallback summary
    if (!summaryFallback && !SEVERITY_RE.test(line) && !VERDICT_RE.test(line)) {
      summaryFallback = line;
    }
  }

  const finalVerdict = verdict ?? deriveVerdict(findings);
  return {
    verdict: finalVerdict,
    summary: summary ?? summaryFallback ?? '',
    findings: sortFindingsBySeverity(findings),
  };
}
