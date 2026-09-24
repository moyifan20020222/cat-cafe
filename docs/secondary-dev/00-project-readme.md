# Clowder AI（二次开发 Fork）项目说明

> 本仓库 **Fork 自 [zts212653/clowder-ai](https://github.com/zts212653/clowder-ai)**（根许可证 **MIT**，Copyright (c) 2026 Clowder AI Contributors）。
> 本文档是**二次开发后的对外项目说明**，记录我在原框架之上扩展的 **Code Review 子系统** 及配套改动，并附版权与合规说明。

---

## 一、项目是什么

Clowder AI 是一个**多智能体协作框架**（monorepo，pnpm 管理，TypeScript）。它本身提供多 Agent 协作所需的运行基座，我在此之上**设计并实现了一个 Review Agent 子系统**，把"代码审查"作为框架的一种 Agent 角色用例落地。

框架内核（非我原创，源自上游）由四层协作组件构成：

| 组件 | 职责（基于源码） |
|---|---|
| **AgentRouter** | 无状态纯函数路由层，解析 `@mention`/路由规则，决定任务派发给哪些 Agent |
| **WorklistRegistry** | 串行协作工作表（内存 Map），记录本次要跑的 Agent 清单、ping-pong 配对、协作深度 |
| **InvocationQueue** | 等待中的消息队列（按 `threadId:userId` 作用域隔离），与互斥锁配合管理"谁在等" |
| **SessionChainStore / InvocationRecordStore** | 调用生命周期状态机 + 会话链存储（内存 / Redis 双实现），负责状态跟踪、续跑与幂等 |

在此基座之上，我重点扩展的是 **上下文与记忆机制（Thread-Session-WorkList 多层隔离 + 上下文压缩 + 任务锚点保真）** 与 **稳定性治理（纯函数路由决策 + 状态快照续跑 + 活跃去重 / 深度限制 / ping-pong 检测 / 失败回退）**——这些机制构成了 Review 子系统得以稳定运行的基础，也是本项目作为"框架内核扩展"而非"独立应用"的体现。

---

## 二、本次二次开发：Code Review 子系统（核心改动）

> 下面列出的文件与字段均来自实际代码，可对照源码核对。

### 2.1 审查标准契约 + 结构化输出

| 模块 | 文件 | 说明 |
|---|---|---|
| 审查分类与契约类型 | `packages/shared/src/types/code-review.ts` | 扩展 `ReviewCategory` 联合类型，新增 `supply-chain`；保留 `CATEGORY_RE` 解析正则 |
| 审查标准 Skill（写侧契约） | `packages/api/src/domains/cats/services/context/SystemPromptBuilder.ts` | `reviewChecklistPrompt` 增加 supply-chain 维度；`buildReviewChecklistSection` 受门控注入 |
| 生产流水线 Prompt 注入 | `packages/api/src/domains/cats/services/context/PipelinePromptBuilder.ts` | 在显式 `reviewContext.diff` 与缓存 `reviewSubject` 两条分支均注入 diff / depSection 段落 |
| 结构化输出契约（读侧提取） | `packages/shared/src/types/code-review.ts` | `parseReviewReport`（正则提取 severity/category/file:line/comment/suggestion/confidence）、`deriveVerdict`、`sortFindingsBySeverity` |

**设计要点：写侧契约 + 读侧契约双重约束。**
审查前用契约约束模型产出格式；审查后用 `parseReviewReport` 读侧正则解析，保证结论可从自然语言文本**可溯源**地解析回结构化对象，直接接入下游流水线。这是本子系统的核心工程化护城河。

### 2.2 Git PR 感知（Diff 链 + PR 锚点）

| 模块 | 文件 | 说明 |
|---|---|---|
| 编排层接入 | `packages/api/src/domains/community/github/GitHubPrDiff.ts` | `InvocationContext.reviewSubject{repoFullName,prNumber,headSha}` → `resolveReviewContext`（异步、缓存）→ `attachReviewContextForReview`；`ReviewerReviewContext` 增加 `depSection?` |
| Diff 感知链 | `GitHubPrDiff.ts` | `fetchPullRequestFiles`(gh CLI) → `parsePatchHunks`（unified patch + 新行号锚点）→ `formatReviewDiff`（token 预算裁剪）→ `buildReviewDiffSection` |
| PR 锚点（拉取键 + 完整性校验门） | `GitHubPrDiff.ts` + `LocalReviewEvidenceProvider` | 段首 `PR: owner/repo#number HEAD: <sha>`；结算要求裁决文本**必须含 headSha + PR 锚点**，否则证据无效、不计为有效 review |

**设计要点：锚点 = 拉取键兼完整性校验门。** 锚点 `(repoFullName, prNumber, headSha)` 既是去 GitHub 拉取 PR 的键，也是校验门——审查产物必须回带精确 headSha 与 PR 锚点，防止"审了一份被悄悄改动过的代码"。取回代码后，无论来自 PR 还是直接贴文件，都走同一条审查核心。

### 2.3 PyPI 供应链启发式检测（安全差异化）

| 模块 | 文件 | 说明 |
|---|---|---|
| 供应链检测核心 | `packages/api/src/domains/community/github/PypiProvenance.ts` | `extractPythonImports(diff)`、`levenshtein(a,b)`、`assessPypiProvenance(info,{popularNames,minDownloads,maxAgeDays})`、`fetchPypiPackageInfo`、`buildDependencyReviewContext` |
| 接入 | `SystemPromptBuilder.ts` / `PipelinePromptBuilder.ts` | `depSection`（伪造/抢注包预检段落）注入两条 prompt 路径 |
| 判定规则 | — | 与热门包名 Levenshtein ≤ 2 + 低下载量 + 近期新建上传 → 高危 BLOCKER；best-effort，拉不到信息时降级为"列出导入、人工确认" |

**诚实说明**：供应链伪造包 / 密钥泄露这类检测是业界已解决子问题的共识能力（如 DeepSec Shield、GuardDog、Gitleaks 等），本系统做的是**将其编排进多智能体审查管线**，而非首创该检测。

### 2.4 测试

- `packages/api/test/code-review.test.js` + `code-review-diff.test.js` + `code-review-deps.test.js`
- 累计 **45 项单元测试**：契约往返、Diff 链、编排层（resolve/getPrepared/attach）、供应链启发式
- 构建/运行：先 `pnpm -r run build`；`node --import ./test/helpers/setup-cat-registry.js --test`（tsx loader）

> ⚠️ **测试边界（诚实）**：这些测试覆盖**流水线机制 + 启发式逻辑的正确性**，不是公开基准数据集上的"审查准确率"。对外请勿表述为"在 X 数据集达 Y%"。

---

## 三、技术亮点与设计取舍

1. **契约驱动（写/读双重）**：审查前约束产出、审查后读侧解析，保证链路可溯源、可接入流水线——区别于多数"输出 SARIF/JSON 一次性"的扫描器。
2. **PR 锚点（拉取键 + 完整性校验）**：headSha + PR 锚点硬校验，针对 Git 协作场景独有，防"审了被改过的代码"。
3. **diff-only、有界、可审计**：单 PR / 单提交审查，不做全仓库 agentic 检索；findings 结构化（`severity/category/file:line/confidence`）直接喂下游门禁。
4. **框架原生角色**：审查作为框架内 Agent 角色落地，复用 Thread-Session 上下文隔离、任务锚点续跑、纯函数路由治理等内核能力——即"框架能力的验证证据"，而非独立工具。
5. **临时 sub-agent 设计（多 Agent 协作）**：框架原生支持"父 Agent 同步派发临时子代理"——子代理复用同一套 `AgentService` 执行机制，但**不进协作工作表、不计 A2A 深度、输出只回传父 Agent 且绝不写入共享 thread**；子代理无 callback token，天然无法递归派生子代理；上下文为 scoped（精确消息 + 片段），运行期持有窗口、结束后不保留自身记忆。这是 Review 等复杂 Agent 做"有界内部分工"的底层能力。

---

## 四、版权与合规（Fork 发布须知）

| 位置 | 许可证 | 说明 |
|---|---|---|
| 根 `LICENSE` | **MIT** | 可 Fork / 修改 / 再发布，须保留原版权声明并追加自己的版权行 |
| `packages/*/package.json` | 无 `license` 字段 | 默认沿用根 MIT |
| **`desktop/package.json`** | **`AGPL-3.0-only`** | ⚠️ 强 copyleft + 网络条款；若发布包含 desktop 并对外提供服务，须开源全部修改 |

**发布到个人 GitHub 前请确认：**
- 保留根 `LICENSE` 全文，不改动 `Copyright (c) 2026 Clowder AI Contributors`，并追加你的版权行；
- README 顶部声明 Fork 来源（上游链接 + MIT + 你的改动）；
- 建议**剔除或单独标注 `desktop/`**（AGPL 强 copyleft，避免牵连）；
- 替换/移除原 Logo 与品牌名（MIT 不覆盖商标），避免商标混淆；
- 简历/答辩诚实写"Fork 并扩展开源多智能体框架"，**勿写从零自研**；Code Review 子系统写"在框架上设计并实现"，测试写"45 项单元测试覆盖机制"，**勿写数据集准确率**。

---

## 五、免责声明 / 诚实边界

- 本项目**未做分布式化**，单进程运行；面试中关于分布式的讨论属于"如果……你怎么考虑"的设计探讨，非已实现功能。
- 供应链 / 密钥检测为业界共识能力的**管线内编排**，非首创。
- 测试为机制正确性验证，非评审质量基准数据集。

---

*本说明与 `01-modifications-and-copyright.md`（内部自检清单）、`02-component-deepdive-interview.md`（组件深读/面试扩展）、`03-distributed-alignment.md`（分布式面试题作答）配合使用。*
