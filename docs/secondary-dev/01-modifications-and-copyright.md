# 二次开发修改清单 + 版权合规说明

> 用途：① 记录我们在 Clowder AI（上游 `github.com/zts212653/clowder-ai`，MIT）基础之上新增/修改的内容；② 给出把本项目发布到个人 GitHub 前的版权与合规检查清单。
> 受众：你自己（简历/答辩用）+ 发布前的自检。

---

## 一、本次二次开发新增 / 修改清单

### 1. Code Review 子系统（核心新增）

| 模块 | 文件 | 说明 |
|---|---|---|
| 审查分类与契约类型 | `packages/shared/src/types/code-review.ts` | 扩展 `ReviewCategory` 联合类型，新增 `supply-chain`；保留 `CATEGORY_RE` 解析正则 |
| 审查标准 Skill（写侧契约） | `packages/api/src/domains/cats/services/context/SystemPromptBuilder.ts` | `reviewChecklistPrompt` 增加 supply-chain 维度；`buildReviewChecklistSection` 受门控注入 |
| 生产流水线 Prompt 注入 | `packages/api/src/domains/cats/services/context/PipelinePromptBuilder.ts` | 在显式 `reviewContext.diff` 与缓存 `reviewSubject` 两条分支均注入 diff / depSection 段落 |
| 编排层接入 | `packages/api/src/domains/community/github/GitHubPrDiff.ts` | `InvocationContext.reviewSubject{repoFullName,prNumber,headSha}` → `resolveReviewContext`（异步、缓存）→ `attachReviewContextForReview`；`ReviewerReviewContext` 增加 `depSection?` |
| 结构化输出契约（读侧提取） | `packages/shared/src/types/code-review.ts` | `parseReviewReport`（正则提取 severity/category/file:line/comment/suggestion/confidence）、`deriveVerdict`、`sortFindingsBySeverity` |
| Diff 感知链 | `packages/api/src/domains/community/github/GitHubPrDiff.ts` | `fetchPullRequestFiles`(gh) → `parsePatchHunks`（unified patch + 新行号锚点）→ `formatReviewDiff`（token 预算裁剪）→ `buildReviewDiffSection` |
| PR 锚点（拉取键 + 完整性校验门） | `packages/api/src/domains/community/github/GitHubPrDiff.ts` + `LocalReviewEvidenceProvider` | 段首 `PR: owner/repo#number HEAD: <sha>`；结算要求裁决文本含 `headSha + PR 锚点`，否则证据无效 |

### 2. PyPI 供应链启发式检测（security 差异化）

| 模块 | 文件 | 说明 |
|---|---|---|
| 供应链检测核心 | `packages/api/src/domains/community/github/PypiProvenance.ts` | `extractPythonImports(diff)`、`levenshtein(a,b)`、`assessPypiProvenance(info,{popularNames,minDownloads,maxAgeDays})`、`fetchPypiPackageInfo`、`buildDependencyReviewContext` |
| 接入 | `SystemPromptBuilder.ts` / `PipelinePromptBuilder.ts` | `depSection`（伪造/抢注包预检段落）注入两条 prompt 路径 |
| 判定规则 | — | 与热门包名 Levenshtein ≤ 2 + 低下载量 + 近期新建上传 → 高危 BLOCKER；best-effort，拉不到信息时降级为"列出导入、人工确认" |

### 3. 测试（机制正确性，非质量基准）

- `packages/api/test/code-review.test.js` + `code-review-diff.test.js` + `code-review-deps.test.js`
- 累计 **45 项单元测试**：契约往返、Diff 链、编排层（resolve/getPrepared/attach）、供应链启发式
- 构建/运行方式（环境注意）：需先 `pnpm -r run build`；`node --import ./test/helpers/setup-cat-registry.js --test`（tsx loader）

> ⚠️ 诚实边界：这些测试覆盖**流水线机制 + 启发式逻辑**，不是公开基准数据集上的"审查准确率"。简历/答辩里**不要写"在 X 数据集达 Y%"**。

### 4. 文档/记忆

- 项目记忆 `D:\Desktop\Project\clowder-ai\.workbuddy\memory/2026-09-19.md` 等记录了架构决策与边界
- 本文档所在 `docs/secondary-dev/` 为本次二次开发的配套说明（面试/发布自检用，**发布前可自行删除**）

---

## 二、版权与合规分析（重要）

### 2.1 许可证现状（实测）

| 位置 | 许可证 | 性质 |
|---|---|---|
| 根 `LICENSE` | **MIT**，`Copyright (c) 2026 Clowder AI Contributors` | 宽松许可 |
| 根 `package.json` 及 `packages/*/package.json` | 无 `license` 字段 | 默认沿用仓库根 MIT |
| **`desktop/package.json`** | **`AGPL-3.0-only`** | ⚠️ **强 copyleft + 网络条款** |

> **关键风险点**：`desktop/` 子项目是 **AGPL-3.0-only**。AGPL 与 MIT 不兼容，且带有"网络使用条款"——如果你把修改版 **作为网络服务提供**，必须向通过网络使用的人提供对应源码（含你的修改）。MIT 部分则无此要求。

### 2.2 在你"Fork 别人代码二次开发"语境下的结论

1. **MIT 主体部分（框架核心、`packages/api`、`packages/shared` 等）**：可以 Fork、修改、再发布到个人 GitHub。前提是 **保留 `LICENSE` 全文 + 原版权声明**（`Copyright (c) 2026 Clowder AI Contributors`），并**新增你自己的版权行**（如 `Copyright (c) 2026 <你的名字>`）。**不得**删除原声明、不得改许可证类型。
2. **`desktop/`（AGPL-3.0-only）部分**：若你发布的 Fork **包含并对外提供** desktop 应用，则受 AGPL 约束——必须同样开源你的修改，且若以网络服务形式运行需向用户供源。若你的二次开发只涉及框架/Code Review（`packages/api` 等），**建议发布时剔除或单独标注 `desktop/`**，避免被 AGPL 强 copyleft 牵连。
3. **CLA.md（贡献者许可协议）**：它约束的是"向 Clowder AI 原项目**提交贡献**"的行为（授予维护者不可撤销的版权/专利许可）。**它不限制你 Fork 后在自己账号下再发布**（MIT 已授权你这么做）。但注意：若你日后向 `zts212653/clowder-ai` 提 PR，CLA 才会生效。

### 2.3 商标（MIT 不覆盖）

- "Clowder AI" 名称、Logo（`assets/icons/clowder-ai-logo-*`）可能构成商标/品牌资产。MIT 只授版权，不授商标。
- **建议**：个人 Fork 改名（如 `clowder-ai-fork` 或你自己的项目名），并**替换 Logo**，避免商标混淆。README 顶部"Hard Rails. Soft Power. Shared Mission."等品牌标语也建议调整。

### 2.4 来源可追溯性（诚信 + 法律保护）

- 仓库 git 历史首提交作者为 `苏策 <lysander@suces-MacBook-Pro.local>`，Fork 上游为 `zts212653/clowder-ai`（MIT）。本机二次开发版的推送目标 `origin` 已指向个人仓库 `github.com/moyifan20020222/cat-cafe`；上游 `upstream = zts212653/clowder-ai` 仅保留 fetch、已禁用 push（防止误改他人代码）。
- 请在 README 明确声明：**"本仓库 Fork 自 Clowder AI（zts212653/clowder-ai，MIT），由 <你> 二次开发。"** 这既是诚信，也符合 MIT 的署名要求。

---

## 三、发布到个人 GitHub 前的自检清单

- [ ] 保留根 `LICENSE` 全文，不改动 `Copyright (c) 2026 Clowder AI Contributors`
- [ ] 在 LICENSE 或单独 NOTICE 中**追加你的版权行**
- [ ] README 顶部加 Fork 来源声明（上游链接 + MIT + 你的改动说明）
- [ ] 决定 `desktop/`（AGPL-3.0-only）是否随 Fork 发布；若只发框架核心，将其排除并在说明中标注
- [ ] 替换/移除原 Logo 与品牌名，避免商标问题
- [ ] 确认 `.gitignore` 已排除 `node_modules/`（已确认：`.gitignore` 第 2、151 行）——**不要**把 `node_modules` 或打包的第三方依赖一并提交
- [ ] 扫描仓库内是否夹带其他强 copyleft 文件（本次未发现额外 `COPYING`/GPL/AGPL 文件，仅 `desktop/` 为 AGPL）
- [ ] 简历/答辩措辞：描述为"Fork 并扩展开源多智能体框架 Clowder AI"，**勿写为从零自研**；Code Review 子系统描述为"在框架上设计并实现"，测试写"45 项单元测试覆盖机制"，**勿写数据集准确率**
- [ ] 若向原项目提 PR，需先签 CLA（在 PR 下评论签名句）

---

## 四、一句话给你的建议

> MIT 主体随便 Fork 再发布，只要留名、不改证、加自己名；**真正的雷是 `desktop/` 的 AGPL-3.0-only**——要么别带它发布，要么接受强 copyleft 并开源你的全部修改。品牌名/Logo 建议换掉。简历上诚实写"Fork + 扩展"，比"自研"更稳也更经得起问。
