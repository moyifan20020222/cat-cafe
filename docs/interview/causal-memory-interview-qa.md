# 面试问答知识点：Clowder AI 记忆系统（提取 → 召回 全链路）

> 主题：**长期记忆（Long-term Memory）** 与 **Session 内部结构化记忆（In-Session Structured Memory）** 双线，覆盖 **提取 / 区分 / 冲突 / 确认反馈 / 召回**。
> 适用：校招后端 / Agent 平台方向，讲自己真实做过的记忆系统改造。
> 读法：先建立"双线地图"，再逐段看语义与设计取舍；**附录 A 是代码真实字段的中英对照**，**附录 B 是两条线的端到端路径图**——面试被问"你都定义了哪些字段 / 数据怎么流"时直接背附录。

---

## 0. 开场白（一句话定位）

> 记忆系统要解决的不是"把对话存下来"，而是让 Agent **从自己的经验里学习**：不重复犯同样的错、跨会话沉淀规律。
> Clowder 的记忆是**双线**的：
> - **长期记忆**——跨会话持久的经验库（蒸馏成 durable truth，召回时按情境 surface）。
> - **Session 内部结构化记忆**——一次会话/线程内，把零散对话**结构化**成可路由、可分流的增量，一部分升格为长期记忆，一部分变成私有 cue 直接回流召回。
>
> 两条线在**召回（Cue Plane）**汇合：无论记忆来自长期库还是 session 内提取，最终都通过同一套 `RecallOpportunity → CueEnvelope` 机制递送给 Agent。
> 核心原则：**每一步都保留人工确认与可追溯的演化轨迹，而不是黑盒自动写库。**

---

## 1. 双线地图

```
═══════════════ 长期记忆线（跨会话持久）═══════════════
信号源(4路: 摘要/显式标记/sub-Agent/反馈)
   │  AbstractiveSummaryClient: LLM → 结构化 DurableCandidate{causal}
   ▼
脱敏(DeidentificationService) → SqliteEvidenceStore(EvidenceItem)
   │
   ▼  [可选蒸馏] DistillationService
nominate(assessConflict 冲突门) → approve(force?supersede边) → materialize(.md)
   │
   ▼  GlobalIndexBuilder → global_knowledge.sqlite
   │
   ║═══════════ 汇合到召回 ═══════════╗

═══════ Session 内部结构化记忆线（会话内→跨会话）═══════
TranscriptEvent(原始消息事件)
   │  SessionReflectionProducer.onSessionSealed
   ▼  readAllEvents → ReflectionTranscriptEntry
extractReflectionDeltas(信号模式匹配: correction/decision/identity_relationship/open_loop/desire_cue)
   │  mergeReflectionDeltas(去重) → ReflectionOutputRecord(acceptBatch, 预算5)
   ▼  分流:
   ├─ public_evidence  ──────────────► EvidenceItem（进入长期记忆线）
   └─ f255_private_cue(desire_cue) ─► cueSink → 私有 cue 源
                                          │
                                          ║═══════════ 汇合到召回 ═══════════╗

═══════════════ 召回线（两条线汇合点）═══════════════
运行时产生 RecallOpportunity(subject_seen / delivery_decision / judgment_surface_entered) + serverScope
   │  MemoryCuePlaneService.resolve
   ▼  admitRecallOpportunity(校验+scope绑定) → Catalog(过期/dedupe/配额)
collectCandidates(按 resolverFamilies 调各 Resolver: 从 EvidenceItem / 私有cue源 取)
   ▼  formatMemoryCues(maxTokens) → MemoryCueResolution{cues, promptSegment}
   ▼  注入 Agent；recordPresented 写投递回执(幂等)
```

---

## 2. 长期记忆：提取（Extraction）

### 2.1 信号源：4 路
1. **会话结束的抽象摘要**：`AbstractiveSummaryClient` 调 LLM，把对话压成自然语言候选。
2. **显式标记**：对话里 `[lesson!]` / `[decision]` 主动点名。
3. **临时 Agent（sub-Agent）因果记录**：`spawn-temp-agent` 回调带回"它为什么这么决策"。
4. **人对候选的修正/拒绝**：feedback 本身也是信号（见第 5 节闭环）。

> 设计点：**多入口、单管线**。不管从哪路来，最后都归一到 `DurableCandidate`，走同一套确认流程，不因为任何来源走后门。

### 2.2 从扁平 claim 升级为因果四元组
原始实现把一条 `lesson` 压成一句话（`claim`）。硬伤：无法按情境召回、无法做冲突检测、无法跨场景泛化。升级为 `CausalExtraction`：

| 字段（代码真实） | 中文语义 | 服务谁 |
|---|---|---|
| `trigger` | **召回条件**——"什么情境下该想起这条记忆" | 直接喂给**召回**（第 4 节） |
| `action` | 当时实际采取的决策/动作 | 让人看清"当年怎么做的" |
| `result` | 可观测的结果 | 验证 `lesson` 是否成立（经验是否被证伪） |
| `lesson` | 可跨场景复用的规律 | **最该固化的 durable truth** |
| `causalConfidence` | LLM 自评把握度 `'high'\|'medium'\|'low'` | 给召回/确认做权重 |

> **`trigger` 是整个设计里最值钱的字段**——它不是给人读的，是给机器在召回时做"情境命中"的。提取阶段花力气拆出 trigger，正是为了召回阶段"在对的时候想起来"。

实现要点：LLM 仍输出自然语言，程序侧 `parseCausalTrace` 从 `## Causal Trace` 块抽四元组；缺字段自动退回扁平 `claim`（零破坏性）。解析用 `String.matchAll` 而非 `exec` 循环（真实踩坑：`exec` 失败会重置 `lastIndex` 死循环 OOM）。

### 2.3 区分逻辑（Differentiation）
三维标签：
- **`EvidenceKind`**：`lesson` / `decision` / `correction` / `observation`…——经验是什么性质，决定召回时机/权限。
- **`ProvenanceTier`**：来源可信度——人是 gold、LLM 摘要是 silver、sub-Agent 是 bronze。
- **`Cue family`**：记忆属于哪类"提示时机"（与召回的 Cue Plane 对齐）。

> **提取是捞，区分是打钢印路由**：先有内容，再贴标签；标签服务于召回与权限。

### 2.4 冲突解决（Conflict Resolution）
场景：同一话题（如"build 超时怎么处理"）提取出两条结论相反的记忆。系统默认**拒绝第二条、除非人显式放行**。

- **检测 `assessConflict()`**：扫已 materialized 的 truth——
  - `keyword_overlap`：基于**精选关键词**重叠率 ≥ 0.5 → 标记（用关键词而非原始文本，避免新词稀释漏报）。
  - `explicit_contradiction`：已有 truth 的 `contradicts` 已列本 anchor → 直接认定。
- **门控 + 裁决**：标了冲突仍进 `pending`，但 `approve()` 默认**拦截抛错**逼人看一眼；人确认 supersede（后者取代前者）→ `approve(id, reviewer, {force:true})`，把旧 truth 的 anchor 写进新 truth 的 `contradicts` 边。
- **取舍**：不删旧记忆，用**有向边**表达"后者取代前者"——保留演化轨迹（可追溯/可审计/可回滚）。

### 2.5 确认反馈闭环（Confirmation Feedback Loop）
- **度量**：`ProactiveMemoryOpportunityEvaluator` 统计人类拒绝率 = (irrelevant + conflict 拒绝) / 总 adjudicate 数。
- **回灌** `adaptCandidateThresholds(base, signal)`：拒绝率 ≤ 0.25（`CANDIDATE_REJECTION_RATE_CEILING`）不动；超过则抬升 `minDistinctThreads` / `minRecentBurstLift`，**最多 +2 封顶**，且**只升不降**（单向棘轮，避免阈值在边界震荡）。
- **语义**：拒绝多 → 门槛高 → 只有强信号成候选 → 少骚扰、少造矛盾记忆。反馈调的是"未来提取的宽松度"，**不是去删已有记忆**。

### 2.6 持久化（Materialization）
- 落盘 `.md`（frontmatter + `## Causal Trace` 段 + `contradicts` 头），`GlobalIndexBuilder` 发现后编进 `global_knowledge.sqlite`，跨会话/跨重建可查。
- 存储单元是 `EvidenceItem`（见附录 A），`anchor` 是唯一键；`generalizable` 决定是否升格进全局 reflow。

---

## 3. Session 内部结构化记忆（In-Session Structured Memory）★

这是容易被忽略、但最能体现"记忆分层"设计的一条线——它处理的是**会话内部**的结构化，而非跨会话持久。

### 3.1 它是什么 / 与长期记忆的关系
- 长期记忆关心"**沉淀下来的经验**"；Session 内部记忆关心"**这次对话里发生了什么值得记住的结构**"。
- 它不是另起炉灶：session 内提取出的结构化增量，会**分流**进长期记忆（`public_evidence`）或私有 cue（`f255_private_cue`），从而把"会话内洞察"接回长期线与召回线。

### 3.2 原料：最底层的 `TranscriptEvent`
每次会话产生的原始事件（代码位置 `TranscriptReader.ts`）：

| 字段 | 中文语义 |
|---|---|
| `v` | 模式版本 |
| `t` | 事件时间戳（epoch ms） |
| `threadId` / `catId` / `sessionId` | 线程/猫/会话标识 |
| `invocationId?` | **执行上下文**——哪一次 Agent 调用（召回 scope 的关键维度） |
| `eventNo` | 事件序号 |
| `event` | 原始负载 |

> `invocationId` 是关键：它把"一次具体执行"和"一条 thread"区分开，也是后面召回 `RecallScopeV1` 的三个维度之一。

### 3.3 提取：从对话到结构化增量
`SessionReflectionProducer.onSessionSealed` 在会话密封时触发：
1. `readAllEvents` 读出全部 `TranscriptEvent` → 转成 `ReflectionTranscriptEntry`（`role` + `content` + `sourceRef`）。
2. `extractReflectionDeltas` 用**信号模式匹配**提取（不是 LLM，是确定性正则 + 角色约束，可解释、零成本）：
   - `correction`（用户纠正行为/契约）
   - `decision`（明确同意/拍板）
   - `identity_relationship`（稳定身份/关系变更）
   - `open_loop`（未闭合的依赖/下一步）
   - `desire_cue`（值得回访的渴望）
3. `mergeReflectionDeltas` 去重（同 `destination+kind+normalizedClaim+targetCatId` 只留最新来源）。

提取产物 `ExtractedReflectionDelta`：

| 字段 | 中文语义 |
|---|---|
| `kind` | 上述 5 种信号之一 |
| `destination` | `public_evidence`（公开证据）或 `f255_private_cue`（私有 cue） |
| `normalizedClaim` | 归一化后的主张文本 |
| `reason` | 为何被提取（信号原因） |
| `sourceRef` | 溯源：`threadId`/`messageId`/`sessionId`/`eventNo`/`invocationId`/`eventAt` |
| `targetCatId?` | 目标猫（desire_cue 专用） |

### 3.4 落库与分流：`ReflectionOutputRecord`
`acceptBatch` 入库（带**预算 5**，超出 `budget_exhausted` 拒绝），记录 `outputId` / `ownerUserId` / `householdLocalDate` / `catId` / `projectionState`(`pending`|`delivered`) / `producer` / `createdAt`。

分流逻辑（在 `toDelta` 里已定）：
- `kind === 'desire_cue'` → `destination = 'f255_private_cue'` → `reconcilePendingCues` 投递到 `cueSink.ingestPendingCue`。
- 其余 → `destination = 'public_evidence'` → 成为公共证据，可升格为 `EvidenceItem` 进长期库。

### 3.5 与长期记忆的衔接点（面试必讲）
- **`public_evidence` 增量** → `EvidenceItem`（长期库），经 `DistillationService` 蒸馏成全局 durable truth。
- **`desire_cue`** → 私有 cue 源（`PersonMemoryCueSource` / `TasteMemoryCueSource` 等）→ 召回时由 `MemoryCuePlaneService` 解析。
- 长期记忆的 `EvidenceItem.causal.trigger` 与 session 内 `normalizedClaim` 在召回侧殊途同归：都被包装成 `CueEnvelope` 递送给 Agent。

> 一句话：**Session 内部记忆是"经验的采掘面"，长期记忆是"经验的仓库"，召回是"统一的配送网络"。**

---

## 4. 召回（Recall）：两条线汇合到 Cue Plane ★

召回不是全文检索，而是"**情境命中 trigger → 在对的时机递送**"。所有记忆（无论来自长期库还是 session 内 cue）都走同一套机制。

### 4.1 触发事件 `RecallOpportunityV1`（discriminatedUnion by `kind`）
由运行时产生，带 `serverScope`（见下）：
- **`subject_seen`**（producer=`entity_nudge`）：payload `{entityId, matchedAlias, sourceMessageId}`——看见某个实体。
- **`delivery_decision`**（producer=`github_ci`）：payload `{repoFullName, prNumber, headSha, phase, gateOutcome, ...}`——进入交付决策面。
- **`judgment_surface_entered`**（producer=`workflow_sop`）：payload `{stage, selectedSkill, selectionSource, featureId}`——进入判断面。
- 公共字段：`v` / `opportunityId` / `consumer='agent_route'` / `scope` / `occurredAt`。

### 4.2 准入目录 `RecallOpportunityCatalogEntry`
每个 opportunity 经 `admitRecallOpportunity` 校验 + **scope 绑定**（`server_exact`：必须 `ownerUserId`+`threadId`+`invocationId` 全匹配，防越权召回）。目录控制：
- `resolverFamilies`：该机会该调哪些解析器（`subject_seen`→`person_entity`；`delivery_decision`→`operational_precedent`；`judgment_surface_entered`→`taste`）。
- `maxCues` / `maxPromptTokens`：配额（防 prompt 爆炸）。
- `expiresAfterMs`：机会过期时间（5~30 分钟）。
- `dedupeKey`：去重键（同实体/同 PR/同 feature 不重复 surface）。

### 4.3 召回产物 `CueEnvelopeV1`
各 `RecallResolverFamily`（`person_entity` / `operational_precedent` / `taste` / `profile` / `project_knowledge`）从 `EvidenceItem` 或私有 cue 源取出后，包装成信封：

| 字段 | 中文语义 |
|---|---|
| `cueId` / `opportunityId` | 召回线索 ID / 来源机会 ID |
| `resolverFamily` / `resolverVersion` | 解析器族/版本 |
| `whyNow` | **为何此刻召回**（对应长期记忆的 `trigger`） |
| `title` / `summary` | 给 Agent 看的标题/摘要 |
| `source` | `{anchor, revision, asOf?, visibility:'owner_public'\|'owner_private'}`——溯源与可见性 |
| `drill` | `{family, handle}`——下钻句柄（让 Agent 看全貌） |
| `scope` | `RecallScopeV1`（ownerUserId/threadId/invocationId） |
| `invalidators` | 失效条件元组（source_corrected/forgotten/scope_revoked/superseded/expired） |
| `expiresAt?` | 过期时间 |

### 4.4 解析流程 `MemoryCuePlaneService.resolve`
```
admit(校验+scope) → 查 Catalog(过期? 返回 expired) → dedupeKey 去重(重复? 返回 duplicate)
   → collectCandidates(按 resolverFamilies 调各 Resolver)
   → formatMemoryCues(maxTokens 截断)
   → MemoryCueResolution{ status:'admitted', cues, promptSegment, estimatedTokens, deliveryReceipts }
   → 注入 Agent；recordPresented 写幂等投递回执
```
> `status` 四态：`not_admitted`（未准入）/ `expired`（过期）/ `duplicate`（重复）/ `admitted`（已投递）。`deliveryReceipts` 让"是否真正递达"可审计——这是把"记忆召回"当成**有 SLA 的事件**来对待，而不是 best-effort。

---

## 5. 设计哲学总结（收尾，当"你最大的收获"讲）
- 让 Agent 从经验里学习，但**每一步都保留人工确认与可追溯的演化轨迹**。
- 三个"不"：不静默复制矛盾记忆（冲突门）、不靠阈值写死（反馈闭环）、不盲目删记忆（supersede 边）。
- **可解释性优先**：冲突检测用关键词重叠、session 提取用确定性格，都为了"人能看懂为什么"。
- **双线分层**：session 内是"采掘面"，长期库是"仓库"，召回是"统一配送"——三者解耦但汇合。

---

## 6. 面试官最可能追问 & 你怎么答

**Q：长期记忆和 Session 内部记忆有什么区别？为什么要分两条线？**
A：职责不同。Session 内部处理"**单次对话内的结构化**"——把零散消息变成可路由增量，且必须**低延迟、可解释、零 LLM 成本**（用正则信号匹配）。长期记忆处理"**跨会话沉淀**"——要脱敏、去重、冲突裁决、可召回。两条线在"分流"处衔接：session 增量一部分升格为长期库、一部分变成私有 cue，最终都经同一召回网络投递。

**Q：为什么 Session 内提取用正则而不是 LLM？**
A：① 每次会话密封都要跑，LLM 成本和延迟扛不住；② 提取的是**确定性信号**（用户明确纠正/拍板/表达渴望），正则 + 角色约束足够且**完全可解释、可单测**；③ 真要语义泛化，留给长期记忆线的 LLM 蒸馏做。

**Q：为什么不用向量数据库做冲突检测 / 召回？**
A：冲突用关键词重叠 + 人工确认，可解释（人能看懂"为什么这俩冲突"）；向量相似度阈值难调、不可解释、易把"同义不同表述"误判矛盾。召回的"该不该想起来"靠结构化 `trigger`/`opportunity` 的精确/半精确匹配，比模糊相似度更适合"在对的时机递送"。

**Q：记忆无限膨胀怎么办？**
A：三层闸——① `generalizable` 泛化门；② 准入门槛随拒绝率自适应抬高（第 2.5 节）；③ supersede 边让旧记忆被"取代"而非堆积，召回优先走最新 truth。Session 侧还有 `DEFAULT_REFLECTION_CANDIDATE_BUDGET=5` 的每会话预算。

**Q：trigger 怎么和召回接上？**
A：长期记忆的 `CausalExtraction.trigger` 在召回时落到 `CueEnvelope.whyNow`；运行时事件 `RecallOpportunity`（subject_seen/delivery_decision/judgment_surface_entered）提供"当前上下文命中"的触发信号；`MemoryCuePlaneService` 按 scope + catalog 解析出对应 cue。Session 内 `desire_cue` 则通过私有 cue 源同样回流。

---

## 附录 A：字段中英对照速查（代码真实字段）

### A.1 长期记忆 · 提取产物
**`DurableCandidate`**（`AbstractiveSummaryClient`）
`kind` 候选类型 · `claim` 扁平主张(兜底) · `causal?` 因果四元组 · `personNames?` 待脱敏人名

**`CausalExtraction`**（`shared/causal-memory.ts`）
`trigger` 触发情境(召回条件) · `action` 当时决策 · `result` 可观测结果 · `lesson` 跨场景规律 · `causalConfidence` 因果置信度(`high`/`medium`/`low`)

### A.2 长期记忆 · 存储单元
**`EvidenceItem`**（`interfaces.ts:93`）
`anchor` 唯一锚点 · `kind` 证据种类(EvidenceKind) · `status` 状态 · `title`/`summary`/`keywords` · `provenance?` 来源可信度(ProvenanceTier) · `generalizable?` 是否可泛化进全局 · `causal?` 因果链 · `contradicts?` 矛盾边(被取代的 anchor) · `authority?`/`activation?`/`verifiedAt?` 知识权威(F163) · `worldId?`/`sceneId?` 场景范围 · `firstIndexedAt?`/`reviewCycleDays?` 宽限/复核 · `retrievalScore?` 检索评分

**`MaterializedTruth`**（`distillation-service.ts`）
`anchor`(=`distilled:{id}`) · `contradicts?` 超辑边

### A.3 冲突 & 反馈
**`ConflictAssessment`**：`basis`(`keyword_overlap`/`explicit_contradiction`) · `conflictingAnchor?` 冲突锚点 · `conflictingTitle?` · `score` 冲突分
**`ProactiveMemoryCandidateConfig`**（`proactive-memory-candidate-contract.ts`）：`minDistinctThreads` · `minRecentBurstLift` · `windowMs`/`recentWindowMs`/`minDistinctMessages`/`minBackgroundMessages`/`maxNudgesPerTurn`；`CANDIDATE_REJECTION_RATE_CEILING = 0.25`；`adaptCandidateThresholds(base, signal)` 抬升降级

### A.4 召回 · Cue Plane
**`RecallScopeV1`**：`ownerUserId` · `threadId` · `invocationId`
**`RecallOpportunityV1`**：`subject_seen`/`delivery_decision`/`judgment_surface_entered`（各带 producer 与 payload）；公共 `v`/`opportunityId`/`consumer='agent_route'`/`scope`/`occurredAt`
**`RecallOpportunityCatalogEntry`**：`resolverFamilies` · `maxCues` · `maxPromptTokens` · `expiresAfterMs` · `dedupeKey(opportunity)`
**`RecallResolverFamily`**：`person_entity`/`operational_precedent`/`taste`/`profile`/`project_knowledge`
**`CueEnvelopeV1`**：`cueId`/`opportunityId`/`catalogVersion`/`resolverFamily`/`resolverVersion` · `whyNow` 为何此刻 · `title`/`summary` · `source{anchor,revision,asOf?,visibility}` · `drill{family,handle}` · `scope` · `invalidators` · `expiresAt?`
**`MemoryCueResolution`**：`status`(`not_admitted`/`expired`/`duplicate`/`admitted`) · `cues` · `promptSegment` · `estimatedTokens` · `deliveryReceipts`

### A.5 Session 内部结构化记忆
**`TranscriptEvent`**（`TranscriptReader.ts:18`）：`v` · `t` 时间戳 · `threadId`/`catId`/`sessionId` · `invocationId?` 执行上下文 · `eventNo` · `event`
**`ReflectionTranscriptEntry`**（`reflection-types.ts:15`）：`role`(`user`/`assistant`/`system`) · `content` · `sourceRef`
**`ReflectionSourceRef`**：`threadId`/`messageId?`/`sessionId?`/`eventNo?`/`invocationId?`/`eventAt?`
**`ExtractedReflectionDelta`**（`reflection-types.ts:21`）：`kind`(`decision`/`correction`/`identity_relationship`/`open_loop`/`desire_cue`) · `destination`(`public_evidence`/`f255_private_cue`) · `normalizedClaim` · `reason` · `sourceRef` · `targetCatId?`
**`ReflectionOutputRecord`**（`reflection-types.ts:37`）：`outputId`/`ownerUserId`/`householdLocalDate`/`catId` · `projectionState`(`pending`/`delivered`) · `producer` · `createdAt`/`deliveredAt?`
> 提取信号预算：`DEFAULT_REFLECTION_CANDIDATE_BUDGET = 5`（`reflection-extractor.ts`）

---

## 附录 B：两条线的端到端路径与流程

### B.1 长期记忆路径（跨会话持久）
```
信号源(4路)
 → AbstractiveSummaryClient: LLM → DurableCandidate{causal}
 → DeidentificationService 脱敏
 → SqliteEvidenceStore: EvidenceItem{anchor, kind, provenance, generalizable, causal, contradicts}
 → [蒸馏] DistillationService.nominate
      → assessConflict(冲突门) → pending
      → approve(force? → 写 contradicts 超辑边)
      → materialize(.md: frontmatter + ## Causal Trace + contradicts)
 → GlobalIndexBuilder → global_knowledge.sqlite
```

### B.2 Session 内部结构化记忆路径（会话内 → 跨会话）
```
TranscriptEvent(v,t,threadId,catId,sessionId,invocationId,eventNo,event)
 → SessionReflectionProducer.onSessionSealed
 → readAllEvents → ReflectionTranscriptEntry{role,content,sourceRef}
 → extractReflectionDeltas(SIGNALS 正则匹配: correction/decision/identity_relationship/open_loop/desire_cue)
 → mergeReflectionDeltas(去重)
 → ReflectionOutputRecord{outputId, ownerUserId, householdLocalDate, catId, projectionState}
    → acceptBatch(预算5)
 → 分流:
    ├─ public_evidence  → EvidenceItem（进入长期记忆线 B.1）
    └─ f255_private_cue → cueSink.ingestPendingCue → 私有 cue 源（进入 B.3）
```

### B.3 召回路径（双线汇合点）
```
运行时事件 → RecallOpportunity{kind, producer, payload, scope, occurredAt}
 → MemoryCuePlaneService.resolve
    → admitRecallOpportunity(校验 + server_exact scope 绑定)
    → getRecallOpportunityCatalogEntry(过期? expired / dedupeKey 重复? duplicate)
    → collectCandidates(按 resolverFamilies 调各 Resolver:
        长期库 EvidenceItem  /  私有 cue 源  →  CueEnvelopeV1)
    → formatMemoryCues(maxPromptTokens 截断)
    → MemoryCueResolution{status:'admitted', cues, promptSegment, deliveryReceipts}
 → 注入 Agent；recordPresented 写幂等投递回执
```

---

## 附录 C：关键文件 / 函数速查（被问"你能指代码吗"时）

| 文件 | 关键符号 | 负责 |
|---|---|---|
| `packages/shared/src/types/causal-memory.ts` | `CausalExtraction` / `ConflictAssessment` | 因果四元组 + 冲突评估类型 |
| `packages/shared/src/types/memory-cue.ts` | `RecallOpportunityV1` / `CueEnvelopeV1` / `RecallScopeV1` / `RecallResolverFamily` | 召回侧全类型（zod 校验） |
| `packages/api/src/domains/memory/AbstractiveSummaryClient.ts` | `parseCausalTrace` / `extractCandidates` | LLM 自然语言 → 结构化候选 |
| `packages/api/src/domains/memory/distillation-service.ts` | `assessConflict` / `approve(force)` / `materialize` | 冲突门 + 超辑边持久化 |
| `packages/api/src/domains/memory/interfaces.ts` | `EvidenceItem`(:93) / `Marker`(:257) | 长期记忆存储单元 |
| `packages/api/src/domains/memory/proactive-memory-candidate-contract.ts` | `adaptCandidateThresholds` / `CANDIDATE_REJECTION_RATE_CEILING` | 确认反馈闭环阈值自适应 |
| `packages/api/src/domains/memory/SessionReflectionProducer.ts` | `onSessionSealed` / `extractReflectionDeltas` / `reconcilePendingCues` | Session 内结构化记忆提取+分流 |
| `packages/api/src/domains/memory/reflection-types.ts` | `ExtractedReflectionDelta` / `ReflectionOutputRecord` / `ReflectionSourceRef` | Session 内记忆结构化类型 |
| `packages/api/src/domains/memory/cue/RecallOpportunityCatalog.ts` | `admitRecallOpportunity` / `RECALL_OPPORTUNITY_CATALOG_V1` | 召回机会准入 + 目录 |
| `packages/api/src/domains/memory/cue/MemoryCuePlaneService.ts` | `resolve` / `recordPresented` | 召回解析主流程 + 投递回执 |
| `packages/api/src/cats/services/session/TranscriptReader.ts` | `TranscriptEvent`(:18) | Session 底层原始事件 |
| `docs/decisions/044-causal-memory-extraction.md` | — | 设计决策 ADR（含修订记录） |

---

## 附录 D：一句话背给面试官（电梯陈述）

> "我们给 Agent 做了**双线记忆**：长期记忆把对话经多路信号提取成**因果四元组**（trigger/action/result/lesson），脱敏后入 `EvidenceItem`，经冲突门与 supersede 边保留演化；Session 内部记忆在会话密封时把零散对话用**确定性信号匹配**结构化成 `ReflectionDelta`，一部分升格为长期库、一部分变成私有 cue。两条线在**召回平面（Cue Plane）**汇合——运行时 `RecallOpportunity` 触发，按 scope + catalog 解析出 `CueEnvelope` 在**对的时机**递送给 Agent。核心是每一步都可解释、可追溯、有人工确认。"
