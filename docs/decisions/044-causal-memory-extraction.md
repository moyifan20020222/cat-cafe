# ADR 044 — 因果记忆提取 + 冲突消解 + 确认反馈闭环

- **状态**：Proposed（校招生独立贡献，叠加在原始蒸馏管线上）
- **相关**：`AbstractiveSummaryClient`、`DistillationService`、`ProactiveMemoryOpportunityEvaluator`、`proactive-memory-candidate-contract`
- **目标**：在不破坏原始 `nominate → pending → approve → materialize` 结构的前提下，把"记忆提取"从**扁平 claim 字符串**升级为**结构化因果链**，并在确认环节加入**冲突检测**与**拒绝反馈自适应**，形成完整的"提取 → 区分 → 确认 → 召回"闭环。

## 背景 / 动机

原始项目的长期记忆提取（`AbstractiveSummaryClient`）把一段对话抽成 `DurableCandidate.claim`——一个自然语言句子。这条链路能跑，但有三类问题，恰好是简历上可讲的"差异化深挖口子"：

1. **提取粒度太粗**：一条 `lesson` 被压成一句话，召回时只能靠关键词/向量匹配，无法"按触发情境检索"或"按动作聚类"。面试官常问"你的记忆怎么避免和已有记忆重复"——扁平 claim 答不上来。
2. **缺少冲突语义**：两个话题相同但结论相反的记忆会被分别 approve，长期记忆库里出现互相打架的 truth，而原始 `EvidenceItem.contradicts` 字段（F163）几乎没有生产者。
3. **反馈只度量不调节**：`ProactiveMemoryOpportunityEvaluator` 已经量了 `irrelevantProposalRate`，但阈值（`minDistinctThreads` 等）是写死的，人不 reject 多少次，系统都不会少提——不是真正的闭环。

## 决策

### 1. 因果四元组（CausalExtraction）

新增共享类型 `CausalExtraction`：`{ trigger, action, result, lesson, causalConfidence }`。

- **trigger**：触发情境/信号——这条记忆"在什么条件下该被召回"。
- **action**：当时采取的行动/决策。
- **result**：可观测的结果。
- **lesson**：从中提炼的、可跨场景复用的规律——**最该固化的 durable truth**。
- LLM 输出仍是自然语言，程序用 `parseCausalTrace` 从 `## Causal Trace` 块里抽取四元组（中英文标签都认）；缺字段就退回扁平 claim，**零破坏性**。

### 2. 冲突消解门（ConflictAssessment）

`DistillationService.assessConflict()` 在 `nominate` 时对新候选扫描已 materialized 的 truth：

- `keyword_overlap`：关键词重合率 ≥ 0.5（同话题）即标记，记下 `conflictingAnchor`。
- `explicit_contradiction`：既有 truth 的 `contradicts` 已列本 anchor，直接认定矛盾。
- 标记后候选仍进 `pending`，但 `approve` 默认**拦截**，必须 `force:true` 才能通过；force 通过时把对方写入新 truth 的 `contradicts` 字段，形成**显式 supersede 边**，而非默默复制第二条矛盾记忆。
- 这就是用户说的"一个内容提取出两个不同记忆 → 拒绝/合并其中一个"的正式机制。

### 3. 确认反馈闭环（adaptCandidateThresholds）

新增纯函数 `adaptCandidateThresholds(base, signal)`：

- `signal` = 人 adjudicate 过的提议里 `irrelevant + conflict` 拒绝数 / 总数。
- 拒绝率 ≤ 0.25（与 evaluator 的 ceiling 对齐）→ 阈值不变。
- 超过 → 按超出比例抬升 `minDistinctThreads` / `minRecentBurstLift`（最多 +2，封顶，绝不锁死管线）。
- 这是闭环的"测量 → 阈值"一步：人 reject 越多，系统提 admission bar，少骚扰、少制造矛盾记忆。

## 影响 / 风险

- **兼容**：所有新字段均为 `optional`；`nominate` 的 `causal` 来自 caller override 或 `EvidenceItem.causal`，缺失即退回原行为。
- **存储**：`distillation_candidates` 表用 `ALTER TABLE` 增量加 `causal_json` / `conflict_json`（幂等）；`materialize` 的 `.md` 增加 `## Causal Trace` 段与 `contradicts` 头。
- **未做（留给后续）**：阈值自适应目前是纯函数，真正的"按 workspace 持久化并回流进 Detector"需要一个小KV，本次未接，避免扩大改动面；设计上已留好接口。

## 验证

- `packages/api/test/causal-memory.test.js`：parser 抽四元组、阈值函数、DistillationService 因果持久化 + 冲突检测 + force supersede 全绿。
- 端到端：把某只猫的 provider 配成可跑 abstractive 的模型 + 开 `F102_DURABLE_CANDIDATES=on`，build 报错类信号会被抽成 causal truth 并弹确认卡。

## 修订记录（验证阶段实跑发现并修正）

1. **`adaptCandidateThresholds` 改用 `Math.ceil` 单向棘轮**：原 `Math.round(excess*2)` 在中等拒绝率（如 8/20=0.4 → excess 0.2 → round(0.4)=0）下**完全不抬升**，违反"超 ceiling 就该抬门槛"的语义。改为 `ceil` 后，任何超 ceiling 的信号至少 +1，worst case 封顶 +2，且只升不降（避免阈值在边界震荡）。
2. **`assessConflict` 改为基于 curated keywords 的重叠**：原实现对 title+summary+keywords 全文 tokenize 后算 `overlap/candidateTerms.size`，但"新方案"会引入大量新词稀释比率（实测 3/14≈0.21 < 0.5，漏报）。改为优先用**精选关键词**算重叠率（3/4=0.75），文本 token 仅作兜底——关键词才是"是不是同话题"的可靠表征。
3. **修复 `getCandidate` / `listPending` 漏选 `causal_json` / `conflict_json`**：原 SELECT 列不含这两列，`rowToCandidate` 返回 `causal: undefined`，导致 `materialize` 漏写 `## Causal Trace` 段。补齐列后闭环打通。
4. 测试 guard 修正：`better-sqlite3` 的 ABI 不匹配只在 `new Database()` 时抛（import 时不抛），guard 改为**实际实例化 in-memory DB** 探测；DB 用例在 Node24（ABI 137）跑通、Node22（ABI 127）自动 skip。
