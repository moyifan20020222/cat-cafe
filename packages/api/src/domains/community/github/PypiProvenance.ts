/**
 * F-REVIEW Phase 2 (supply-chain): 依赖来源安全初判
 *
 * 背景：reviewer 猫目前只看 diff 文本，对"新增的第三方包导入是否伪造/拼写劫持"
 * 没有结构化判断依据。用户提出的需求：比对 PyPI 包自身信息（下载数、上传时间等）
 * 做初步判断，识别"包可能是伪造"的情况。
 *
 * 本模块提供：
 *   1) `extractPythonImports(diff)` —— 纯函数，从 diff 的新增行解析顶层 Python 包名；
 *   2) `assessPypiProvenance(info, opts)` —— 纯函数，依据下载量 / 首次上传时间 /
 *      与热门包名相似度给出 high/medium/low 风险 + 理由（即"以下载数、上传时间做初步判断"）；
 *   3) `fetchPypiPackageInfo(name, opts)` —— 经可注入 fetch 拉取 PyPI JSON 元数据
 *      （+ pypistats 下载量，best-effort）；
 *   4) `buildDependencyReviewContext(diff, opts)` —— 编排：解析导入 → 逐个核对 →
 *      生成可注入 reviewer 的 supply-chain 段落（经 `reviewContext.depSection` 注入，仅 peer-reviewer 可见）。
 *
 * 优雅降级：无网络 / 包不存在 / fetch 失败 → 退化为仅列出导入名、标注"无法核对"，不阻塞 review。
 * 注意：这只是**初步信号**，最终是否采纳依赖由 reviewer 结合代码用法决定（人类在环）。
 */

/** 归一化后的 PyPI 包元数据（供纯函数 `assessPypiProvenance` 评估）。 */
export interface PypiPackageInfo {
  name: string;
  version: string;
  author?: string;
  /** 最早一次 release 的上传时间（ISO 8601），用于"近期新建"信号。 */
  firstUploadIso?: string;
  /** 近 30 天下载量（best-effort，来自 pypistats）。 */
  recentDownloads?: number;
  /** 包名与某热门包近似（拼写劫持核心信号），由评估函数回填。 */
  similarToPopular?: string;
}

/** 可注入的 fetch（便于单测，不触网）。与全局 fetch 签名对齐。 */
export type FetchLike = (
  url: string,
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

const PYPI_JSON = (name: string): string =>
  `https://pypi.org/pypi/${encodeURIComponent(name.toLowerCase())}/json`;
const PYPISTATS_RECENT = (name: string): string =>
  `https://pypistats.org/api/packages/${encodeURIComponent(name.toLowerCase())}/recent`;

/**
 * 纯函数：从 diff 文本解析新增（`+` 行）的顶层 Python 包名，去重返回。
 * 支持 `import X` / `import X as Y` / `from X import ...` / `from X.Y import Z`。
 * 不区分标准库 vs 第三方——未经核对的包名交由后续 fetch / reviewer 判断。
 */
export function extractPythonImports(diff: string): string[] {
  const names = new Set<string>();
  for (const raw of diff.split('\n')) {
    if (!raw.startsWith('+')) continue;
    const line = raw.slice(1).trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:import\s+([A-Za-z_][\w.]*)|from\s+([A-Za-z_][\w.]*)\s+import\b)/.exec(line);
    if (!m) continue;
    const mod = (m[1] ?? m[2] ?? '').split('.')[0];
    if (mod) names.add(mod);
  }
  return [...names];
}

/** 编辑距离（纯函数，用于包名相似度判断）。 */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let cur = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
  }
  return prev[n];
}

export interface ProvenanceAssessment {
  risk: 'high' | 'medium' | 'low';
  reasons: string[];
}

export interface AssessOptions {
  /** 已知热门包名清单（拼写劫持比对基准）。 */
  popularNames?: string[];
  /** 低于此下载量视为"低下载量"，默认 1000。 */
  minDownloads?: number;
  /** 首次上传距今小于此天数视为"近期新建"，默认 30。 */
  maxAgeDays?: number;
  /** 注入用"当前时间"，便于单测。 */
  now?: Date;
}

/**
 * 纯函数：依据元数据给出伪造/拼写劫持风险。
 * 信号权重：包名近似热门包 → 直接 high；低下载量 → 至少 medium；近期新建 → 至少 medium；
 * 低下载量 + 近期新建 同时存在 → high。无任何异常 → low（仍标注需人工确认）。
 */
export function assessPypiProvenance(
  info: PypiPackageInfo,
  opts: AssessOptions = {},
): ProvenanceAssessment {
  const minDownloads = opts.minDownloads ?? 1000;
  const maxAgeDays = opts.maxAgeDays ?? 30;
  const now = opts.now ?? new Date();
  const reasons: string[] = [];
  let risk: 'high' | 'medium' | 'low' = 'low';

  if (opts.popularNames && opts.popularNames.length > 0) {
    const lower = info.name.toLowerCase();
    for (const pop of opts.popularNames) {
      const popLower = pop.toLowerCase();
      if (popLower === lower) continue;
      const d = levenshtein(lower, popLower);
      const maxLen = Math.max(lower.length, popLower.length);
      if (d <= 2 && maxLen > 2) {
        info.similarToPopular = pop;
        reasons.push(`包名与热门包 "${pop}" 近似（编辑距离 ${d}），疑似拼写劫持`);
        risk = 'high';
        break;
      }
    }
  }

  const lowDownloads = info.recentDownloads !== undefined && info.recentDownloads < minDownloads;
  if (lowDownloads) {
    reasons.push(`下载量极低（近 30 天 ≈ ${info.recentDownloads}）`);
    if (risk !== 'high') risk = 'medium';
  }

  if (info.firstUploadIso) {
    const ageDays = (now.getTime() - new Date(info.firstUploadIso).getTime()) / 86_400_000;
    if (!Number.isNaN(ageDays) && ageDays < maxAgeDays) {
      reasons.push(`包首次上传于 ${info.firstUploadIso.slice(0, 10)}（约 ${Math.floor(ageDays)} 天前，疑似新建）`);
      if (risk === 'low') risk = 'medium';
      if (risk === 'medium' && lowDownloads) risk = 'high';
    }
  }

  if (reasons.length === 0) reasons.push('元数据未见明显异常（仍需人工确认）');
  return { risk, reasons };
}

/**
 * 经可注入 fetch 拉取 PyPI 元数据；失败 / 包不存在返回 null（优雅降级）。
 * 下载量来自 pypistats（best-effort，失败则留空，不影响其余信号）。
 */
export async function fetchPypiPackageInfo(
  name: string,
  options: { fetchFn?: FetchLike } = {},
): Promise<PypiPackageInfo | null> {
  const doFetch = options.fetchFn ?? (globalThis.fetch as unknown as FetchLike | undefined);
  if (!doFetch) return null;
  try {
    const res = await doFetch(PYPI_JSON(name));
    if (!res.ok) return null;
    const data = (await res.json()) as { info?: Record<string, unknown>; urls?: Array<Record<string, unknown>> };
    const info = data.info ?? {};
    const urls = Array.isArray(data.urls) ? data.urls : [];
    let firstUploadIso: string | undefined;
    for (const u of urls) {
      const t = (typeof u.upload_time_iso_8601 === 'string'
        ? u.upload_time_iso_8601
        : typeof u.upload_time === 'string'
          ? u.upload_time
          : undefined) as string | undefined;
      if (t && (!firstUploadIso || t < firstUploadIso)) firstUploadIso = t;
    }

    let recentDownloads: number | undefined;
    try {
      const sres = await doFetch(PYPISTATS_RECENT(name));
      if (sres.ok) {
        const sdata = (await sres.json()) as { data?: Array<{ downloads?: number }> };
        if (Array.isArray(sdata.data)) {
          recentDownloads = sdata.data.reduce((a, r) => a + (Number(r.downloads) || 0), 0);
        }
      }
    } catch {
      /* 下载量非必需，忽略 */
    }

    return {
      name: String(info.name ?? name).toLowerCase(),
      version: String(info.version ?? ''),
      author: typeof info.author === 'string' ? info.author : undefined,
      firstUploadIso,
      recentDownloads,
    };
  } catch {
    return null;
  }
}

export interface DependencyReviewResult {
  /** 可直接注入 reviewer 猫上下文的 supply-chain 段落。 */
  depSection: string;
  /** 被判为高危的导入名。 */
  riskyImports: string[];
}

export interface BuildDepOptions extends AssessOptions {
  fetchFn?: FetchLike;
  /** 单 PR 最多核对的导入数，防网络放大。默认 30。 */
  maxImports?: number;
}

/**
 * 编排：解析导入 → 逐个核对 PyPI → 生成可注入 reviewer 的 supply-chain 段落。
 * 无导入返回 null；网络不可用 / 包不存在 → 退化为仅列出导入名并标注"无法核对"，仍返回段落。
 */
export async function buildDependencyReviewContext(
  diff: string,
  options: BuildDepOptions = {},
): Promise<DependencyReviewResult | null> {
  const imports = extractPythonImports(diff);
  if (imports.length === 0) return null;
  const capped = imports.slice(0, options.maxImports ?? 30);
  const risky: string[] = [];
  const lines: string[] = [
    '## 第三方依赖来源安全初判（supply-chain）',
    '',
    '以下为本次 diff 新增的 Python 导入，已对照 PyPI 官方元数据做伪造/拼写劫持初判：',
  ];
  for (const name of capped) {
    const info = await fetchPypiPackageInfo(name, { fetchFn: options.fetchFn });
    if (!info) {
      lines.push(`- \`${name}\`：无法核对（网络不可用 / 包不存在），请人工确认来源`);
      continue;
    }
    const a = assessPypiProvenance(info, options);
    const tag = a.risk === 'high' ? '**高危**' : a.risk === 'medium' ? '中危' : '低危';
    const meta = [
      info.recentDownloads !== undefined ? `下载≈${info.recentDownloads}` : '下载量未知',
      info.firstUploadIso ? `首传 ${info.firstUploadIso.slice(0, 10)}` : '首传未知',
    ].join('，');
    lines.push(`- \`${name}\`（${meta}）${tag}：${a.reasons.join('；')}`);
    if (a.risk === 'high') risky.push(name);
  }
  lines.push('');
  lines.push('（以上为初步判断，最终是否采纳依赖由 reviewer 结合代码用法决定；误报请人工复核）');
  return { depSection: lines.join('\n'), riskyImports: risky };
}
