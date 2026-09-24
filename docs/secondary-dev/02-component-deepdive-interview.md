# 组件深读 + 面试扩展（多 Agent 协作：挂载 / 临时 Agent / 回调鉴权 / 续跑）

> 用途：把简历三点（架构 / 记忆与上下文 / 治理）落到可讲的代码路径上，重点覆盖你提到的"一次请求挂多 Agent + Agent 发起临时 Agent + callback 鉴权 + 续跑"。
> 所有机制均来自 `packages/api/src/domains/cats/services/` 真实代码，不是凭空设计。

---

## 一、一句话定位（先把框架讲成一条主线）

> 自研多智能体框架 Clowder-ai：以一个**请求**为线索，依次经过 **路由分发（Router）→ 串行/并行协作（Worklist + Queue）→ callback 鉴权与状态续跑（Registry + Record）**，全程由 **Thread-Session-WorkList 三层上下文** 做信息隔离与保真，并由**纯函数路由 + 状态快照 + 异步回收**做稳定性治理。Code Review 子系统是架在这条主线上的验证用例。

---

## 二、端到端路径：一次请求挂多 Agent + 临时 Agent + 回调鉴权 + 续跑

下面这条线直接对应你面试会被追问的"信息怎么流转、怎么隔离、怎么调度"。

### 步骤 1 — 入队与建调用记录
- 用户消息到达编排层 → 建 `InvocationRecord`（`InvocationRecordStore.create`，带 `idempotencyKey` 去重，状态机 `queued`）。
- 入 `InvocationQueue`：`scopeKey = threadId:userId → QueueEntry[]`（**纯内存 Map**，互补于 `InvocationTracker` 互斥锁）。`MAX_QUEUE_DEPTH=5`，支持幂等合并、优先级、steer 预留。

### 步骤 2 — 路由挂载多个 Agent（"一次请求挂多 Agent"）
- `AgentRouter.routeSerial` 解析 `@mention` / 路由规则 → 算出 `targetCats`（多个）。
- 调 `WorklistRegistry.registerWorklist(threadId, [catA, catB, catC], maxDepth, parentInvocationId)`：
  - `worklist.list: CatId[]` 就是本次要跑的多个 Agent（串行消费，逐个执行）。
  - 注册键 = `parentInvocationId`（F108，保证并发隔离），并维护反向索引 `threadId → Set<registryKey>`。

### 步骤 3 — 为每个 Agent 发回调凭证（callback 鉴权）
- 对每个 target cat：`InvocationRegistry.create(userId, catId, threadId, parentInvocationId, ...)` → 返回 `{ invocationId, callbackToken }`（`randomUUID()` 生成）。
- 该 `callbackToken` 作为**环境变量注入到 CLI 子进程**（Codex/Claude）。
- **鉴权语义**：Agent 后续通过 MCP `post_message` / `schedule` 回传时，请求必须携带 `(invocationId, callbackToken)`；`verify()` 同时校验 **token 匹配 + TTL（默认 2 小时）+ 是否最新（isLatest 防抢占 stale 回传）**。
- 去重：`claimClientMessageId` 保证同一回传消息只处理一次。

### 步骤 4 — Agent 运行期间发起"临时 Agent"（关键区分）
代码里有两种"Agent 调 Agent"，必须分清，面试常考：

| 机制 | 触发 | 是否进 Worklist | 是否计 A2A 深度 | 是否触 ping-pong | 用途 |
|---|---|---|---|---|---|
| **A2A @mention**（`pushToWorklist`） | Agent 在消息里 @另一个猫 | ✅ 进 `entry.list` | ✅ `a2aCount++` | ✅ 计 streak | 协作交接（多轮对话） |
| **临时子 Agent**（`recordSubAgent`） | Agent 同步发起子调用 | ❌ **只做审计记录** | ❌ 不计 | ❌ 不触 | 委托性同步子任务（如一次检索/计算） |

- 临时子 Agent 的路径：`recordSubAgent({invocationId, parentInvocationId, catId, spawnedBy, depth, task, ...})` 写入 `subAgentRecords`（纯审计 Map），**绝不**进入执行工作表、绝不自增协作深度、绝不碰 ping-pong。UI/历史投影用它展示"本次调用派生出了那个子调用"。
- 设计意图：把"协作性交接（A2A）"与"执行期内委托（sub-agent）"解耦——前者是信息流横向传递，后者是单一 Agent 的内部展开，二者治理策略不同。

### 步骤 5 — A2A 串行协作 + 稳定性护栏
- 被 @的猫经 `pushToWorklist` 追加到 `entry.list` 尾部，由 `routeSerial` 串行消费，**不新开 invocation**。
- **调用方授权**：`entry.list[executedIndex]`（当前正在执行的猫）才允许 push，防止被抢占的旧 invocation 注入目标。
- **深度限制**：`MAX_A2A_DEPTH = 10`（`callback-a2a-trigger.ts`），超过直接截断。
- **ping-pong 检测**：`streakPair` 记录最近同一对 (A↔B) 的连续 1:1 push；`count ≥ 2` 告警注入提示，`≥ 4` 直接 `pingpong_terminated` 阻断（且区分"纯语言惯性" vs "有实质工作的真讨论"——`isSubstantiveActivity` 看是否调用了实质工具 / 输出长度 >200）。
- 用户新消息到达会 `resetStreak`，避免跨轮次误判。

### 步骤 6 — 完成结算与续跑（"执行中不丢信息"）
- 每个 cat 执行完 → `InvocationRecord` 状态机转 `succeeded` + 记录 `successfulCatIds`（持久化到 Redis 版）→ `unregisterWorklist`。
- **进程崩溃后的恢复**（这是"InvocationQueue 怎么不丢"的真实答案，不是 Kafka 模型）：
  1. `InvocationRecord` 状态机是 **Redis 持久化**的（`queued→running→succeeded/failed`），进程重启不丢"谁在跑、跑到哪"。
  2. 启动时 `QueuedMessageCustodyStartupReconciler` / `InvocationOwnerReaper` / `convergeZombieQueue` **检测僵尸并回收**，不会永久卡死。
  3. `restoreDurableEntry` / `restoreQueuedHandledResult` 从持久 **custody**（含 `WaitContinuationCarrierV1` / `ActionSuccessorFence`）重建内存队列条目——**丢失的是"内存队列顺序"，但 custody 里的内容可重建**。
  4. **幂等三重防护**：`idempotencyKey`（请求级）、`clientMessageIds`（回调级）、`actionSuccessor` 幂等键（重启后防止同一 carrier 被执行两次；代码注释原话：*"a lost in-memory queue can execute the same carrier twice"* 即为此设计）。
  5. 会话级续跑保真：`SessionChainStore.restoreActiveSession` 可把已 `sealed` 的会话**重新激活**（长链路 continuity），`continuityCapsule` / `compressionCount` 记录压缩观测，保证上下文压缩后因果不丢。

---

## 二-B、临时 Agent（sub-agent）设计要点（你提的 5 点，已对照代码）

临时代理**已落地**（不是只设计）：运行时在 `packages/api/src/routes/callback-spawn-temp-agent-routes.ts`（`POST /api/callbacks/spawn-temp-agent`），类型在 `packages/shared/src/types/sub-agent.ts`，审计在 `WorklistRegistry.recordSubAgent`，执行记录持久化在 `TurnExecutionStore`（`executionKind='sub_agent'`）。

| 你的设计点 | 代码落点 | 是否一致 |
|---|---|---|
| **复用原始调度思路** | 子代理复用父 cat 已注册的 `AgentService.invoke()`（新开一个 provider turn / CLI 进程），并拥有自己的子调用身份 `sub_<uuid>`；只是不进 worklist、不计 A2A 深度 | ✅ 复用同一套调用/执行机制 |
| **临时 Agent 不保留记忆** | 子代理输出 `output` **只回传父 Agent，绝不写入共享 thread**；其上下文是 scoped（`contextMessageIds` 精确消息 + `contextFragments` 片段），**看不到完整 thread 历史**；运行结束后 `disposeSubAgentState` 释放内存态 guard，不保留工作记忆（仅留审计轨迹 `recordSubAgent`） | ✅ 不污染共享记忆 |
| **父 Agent 提供一次性完整任务** | `task: string(≤8000)` 注释明确："This is the sub-agent's entire brief"；外加 `contextFragments`/`contextMessageIds` 给限定上下文 | ✅ 一次性完整 brief |
| **不会产生递归临时 Agent 调用** | **当前实现实际上是单层**：子代理**没有自己的 invocation 身份、没有 callback token**，因此调不了需要鉴权的 `spawn-temp-agent`，天然无法生孙子代理。`MAX_SUB_AGENT_DEPTH=3` 是为"未来子代理可能获得身份"预留的前向兼容上限，本版不触发 | ✅ 与你的设计一致（注意：常量 `=3` 是 dormant 的，不是真允许三层递归） |
| **保留一部分上下文窗口看执行结果** | 运行期 `brief=[task,...contextFragments].join`，作为一次正常 provider turn 执行并流式收集输出到 `chunks`——**执行期天然持有上下文窗口**；结果经 `SubAgentResult.output` **全量回传父 Agent**，由父决定如何使用与归属 | ✅ 见下方"窗口保留"说明 |

### 关于"窗口保留在原始文件中需要做吗"——结论：不需要新增持久化代码

按你的设计思路（执行结果全量返回调用方、由调用方决定使用与归属）：

- 子代理的执行窗口**只在运行期存在**（它的 `brief` + 限定上下文），运行结束即释放；
- 它**不把窗口当作自己的记忆持久化**，也**不写入共享 thread**；
- 当前代码已经是这个行为：`output` 回传父、`recordSubAgent` 只记因果审计（记 `task` 字符串，不记完整对话）、`disposeSubAgentState` 释放内存态。
- 所以**原始文件无需为"窗口保留"加任何存储逻辑**；唯一存在的"保留"是审计轨迹，这是需要的、不是内存泄漏。
- 若想更显式，可在注释里补一句"子代理不持久化自身上下文，结果所有权归父"即可（非功能改动）。

> 设计文档：仓库内已有 `docs/decisions/043-temporary-sub-agent-invocations.md`（以及 `044-causal-memory-extraction.md`），与代码注释里的 `ADR-043` 引用对应——设计是有文档落点的（当前为未提交状态，提交后即随仓库发布）。面试若被问到设计依据，可直接指向该 ADR + 类型注释 + `recordSubAgent` 审计。

---

## 三、简历三点 ↔ 代码机制映射

你简历的三点其实都围绕 **Agent 协作中的信息（流转 / 隔离 / 调度）**：

| 简历点 | 对应代码机制 | 信息维度 |
|---|---|---|
| **架构：路由分发 / 串并行 / callback 鉴权 / 续跑** | `AgentRouter`（纯函数路由）、`WorklistRegistry`（串行工作表 + 调用方授权 + 深度/ping-pong）、`InvocationRegistry`（callbackToken + TTL + isLatest）、`InvocationRecordStore`（状态机 + 续跑） | **信息调度**——谁在何时以何种顺序处理 |
| **记忆与上下文：Thread-Session-WorkList 三层 + 压缩保真** | `SessionChainStore`（Thread→N session/cat，sealing/restore，`continuityCapsule`）、`WorklistRegistry`（跨 Agent 协作元信息因果链 + sub-agent 审计）、`ContextAssembler.truncateHeadTail`（头尾保留中间截断）、`governance-l0` 锚点保真（heading/table 锚点缺失即 fail-closed）、quote anchoring | **信息隔离 + 保真**——公共对话 / 私有会话 / 协作因果 三层分离，压缩不漂移 |
| **治理：纯函数路由 / 状态快照续跑 / 异步回收 / 去重 / 深度 / ping-pong / 回退** | `AgentRouter` 纯函数决策、`InvocationRecordStore` 快照 + `restoreDurableEntry`、`QueuedMessageCustodyStartupReconciler`/`InvocationOwnerReaper` 异步回收、`idempotencyKey` 活跃去重、`MAX_A2A_DEPTH` 深度、`streakPair` ping-pong、`retryFailedTarget`/`bindRetryAttemptId` 失败回退 | **信息可控**——可中断、可恢复、不循环、不偏移 |

**一句话给面试官**：我的三点不是并列功能，而是同一个内核的三条性质——任务怎么**流**、状态怎么**留**、协作怎么**稳**。

---

## 四、高频面试题回答提纲（你被问过的那些）

### Q1：四个组件（Router / Worklist / InvocationQueue / SessionChainStore）分别存什么、结构、设计思路？
- **AgentRouter**：几乎不持久化任务，是**路由计算层**（纯函数解析 @mention/规则 → target cats）；持有运行时缓存重建。设计核心=可复现的纯函数决策。
- **WorklistRegistry**：**内存 `Map`**，`registryKey(parentInvocationId) → WorklistEntry{list:CatId[], originalCount, a2aCount, maxDepth, executedIndex, a2aFrom, a2aTriggerMessageId, streakPair}` + 反向索引 `threadId→Set<key>`。存"本次串行路由的工作表"；A2A 目标压回工作表串行消费而非新开 invocation；`streakPair` 做 ping-pong 防抖。
- **InvocationQueue**：**纯内存 `Map`**，`scopeKey=threadId:userId → QueueEntry[]`；存"等待中的消息载体"；互补于 `InvocationTracker` 互斥锁（锁管"谁在跑"，队列管"谁在等"）；`MAX_QUEUE_DEPTH=5`；含 custody carriers 用于崩溃重建。
- **SessionChainStore / InvocationRecordStore**：**调用生命周期状态机**（`InvocationRecord{id,threadId,userId,targetCats,status,idempotencyKey,...}`），**内存有界(500) + Redis 双实现**；CAS 守卫 + 状态机转换校验 + 幂等索引(TTL 5min)。是"状态跟踪 + 续跑"的骨干。

### Q2：一次用户输入怎么流转？
入口 → 建 `InvocationRecord`（幂等去重）→ 入 `InvocationQueue` → `AgentRouter.routeSerial` 解析路由并 `registerWorklist` → 对每个 target cat 建子 invocation（`InvocationRegistry.create` 发 callbackToken 注入子进程）→ 运行中 A2A 经 `pushToWorklist` 串行消费 / 临时子 Agent 经 `recordSubAgent` 审计 → 完成转 `succeeded` + `successfulCatIds`（落 Redis）→ `unregisterWorklist` → 队列下一 entry 出队。
*这条线正好覆盖你简历三点。*

### Q3：你的压缩策略怎么设计的？
四层真实落地（不是单一 summarizer）：
1. `ContextAssembler.truncateHeadTail`：超长消息**保留头尾、中间截断**（prompt 安全字符上限）。
2. `governance-l0` 锚点校验：要求共享规则里特定 heading/table **锚点必须存在，缺失即 fail-closed**——锚点靠结构断言保真，不靠模型摘要（防漂移）。
3. quote anchoring：引用在被引用文本里必须能精确定位。
4. 三层上下文 + `continuityCapsule`/`WaitContinuationCarrier`/`ActionSuccessorFence` 做**续跑保真**（长链路因果不丢）。

### Q4：做成分布式架构怎么考虑？（详见 `03-distributed-alignment.md`）
- Agent 无状态实例；Nginx 首轮分配到 Agent；**Redis 热存 State（按 userID+sessionID 取）**，请求结束压缩落 **PgSQL**。
- 工具拆成不同 Pod 实例，在 **Nacos** 注册并统一为 **MCP** 格式；长耗时工具走 **Kafka**（信息先交消费队列），短耗时（搜索/DB/用户空间 ls,grep）直接执行（用户侧 / 远端 API 走远程调用）。
- 每个工具附加**幂等键**；状态信息 **Redis 热 + PgSQL 落地**，请求结束落地。

### Q5：InvocationQueue 怎么做到执行中不丢信息？
**诚实版**：当前队列本身是**纯内存**的（进程崩会丢顺序），但它的"不丢"靠三层：
1. `InvocationRecord` 状态机 **Redis 持久化**（queued→running→succeeded/failed）；
2. 重启后 `QueuedMessageCustodyStartupReconciler`/`InvocationOwnerReaper`/`convergeZombieQueue` **对账僵尸并回收**；
3. `restoreDurableEntry`/`restoreQueuedHandledResult` 从 **custody（WaitContinuationCarrier / ActionSuccessorFence）** 重建队列条目；
4. **幂等三重键**防止重启后重复执行。
> ⚠️ 若面试官追问"是不是事务日志 + 回传 ack + 重试队列（Kafka 语义）"，答：**当前不是，但我设计的分布式方案里用 outbox ack + 显式重试队列（DLQ）来对齐这一语义**（见文档三完善点 2）。不要硬说"现在就是 Kafka 模型"。

---

## 五、诚实边界（别踩的坑）

- 不要说"我们首创 / 独家做了供应链与密钥泄露检测"——DeepSec Shield、GuardDog、Gitleaks、GitHub Secret Scanning 都在做同威胁模型；应说"把业界共识能力**编排进契约化、可审计、PR 锚定的管线**"。
- 测试写"45 项单元测试覆盖机制"，**不写"在 X 数据集达 Y% 准确率"**。
- 分布式部分是**设计/对齐方案**，代码里 `WorklistRegistry` 与 `InvocationQueue` 仍是**内存态**——面试讲"规划+对齐"，不要说"已上线分布式"。
- "项目是 Fork 并扩展"，不要说"从零自研"（详见 `01-modifications-and-copyright.md` 的 AGPL 提醒）。
