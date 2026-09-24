# 分布式架构设想（面试题作答 + 设计探讨）

> **定位说明（重要）**：本文档**仅用于回答面试官"如果做成分布式你怎么考虑"这一开放题**，是对当前架构的延伸思考与对齐练习。**本项目并不打算做成分布式、也不打算上线分布式**——下文所有 Redis/Nacos/MCP/Kafka/PgSQL 的设想都属于"口头设计"，代码里 `WorklistRegistry`（协作元信息）与 `InvocationQueue`（等待中消息）目前仍是**纯内存态**，请勿对外表述为"已实现分布式"。
>
> 用途：把"当前四组件真实存储/防丢机制"与面试回答里的分布式设想对齐，给出"每个会话需要什么内容"的映射表，以及三个可以拿来作答的完善思路（用于体现你理解现状与差距，而非承诺已实现）。

---

## 一、现状：四个组件的真实存储与防丢机制

| 组件 | 当前存储 | 持久化？ | 防丢/恢复机制 |
|---|---|---|---|
| **AgentRouter** | 无状态计算层（运行时缓存 `rebuildRuntimeCaches`） | 否 | 纯函数可复现；崩溃重启即重建 |
| **WorklistRegistry** | **纯内存 `Map`**（`registryKey=parentInvocationId → WorklistEntry` + 反向索引 `threadId→Set`） | ❌ 否 | 仅 `parentInvocationId` 隔离；进程崩溃工作表丢失（**分布式化的薄弱点**） |
| **InvocationQueue** | **纯内存 `Map`**（`scopeKey=threadId:userId → QueueEntry[]`） | ❌ 否 | 互补于 `InvocationTracker` 互斥锁；custody carriers（`WaitContinuationCarrierV1`/`ActionSuccessorFence`）支持 `restoreDurableEntry`/`restoreQueuedHandledResult` 重建；幂等三重键防重复执行 |
| **SessionChainStore** | **内存 + Redis 双实现**（工厂选择） | ✅ Redis 版有 | `restoreActiveSession` 会话复活；`continuityCapsule`/`compressionCount` 续跑保真 |
| **InvocationRecordStore** | **内存有界(500) + Redis 双实现** | ✅ Redis 版有 | 状态机 `queued→running→succeeded/failed/canceled` + CAS 守卫 + 幂等索引(TTL 5min) |
| **InvocationRegistry（callback 鉴权）** | **内存 + Redis 双实现**（`selectInvocationBackendKind`） | ✅ Redis 版有 | `verify`（token+TTL 2h+isLatest）、`claimClientMessageId` 去重；Redis 版重启不丢 |

**结论**：鉴权、记录、会话三块已有 Redis 双实现；**真正的分布式短板是 `WorklistRegistry`（串行协作元信息）与 `InvocationQueue`（等待中消息）这两块纯内存态**——下面映射与完善点都围绕它俩。

---

## 二、每个会话需要什么内容（现状 → 你的分布式映射）

| 会话内容 | 当前存储 | 你的分布式对齐 |
|---|---|---|
| 公共对话上下文（thread 消息历史） | `SessionChainStore`（已有 Redis 版） | Redis 热存 + 请求结束压缩落 **PgSQL** |
| 各 Agent 私有会话上下文（per-cat） | `SessionChainStore` / `runtime-session`（已有 `RedisRuntimeSessionStore`） | Redis（按 `userID + sessionID` 取） |
| 跨 Agent 协作元信息 / 因果链 | `WorklistRegistry`（**内存**）⚠️ | **需补持久化** → Redis / PgSQL（当前分布式最薄弱处） |
| 调用生命周期状态 + 续跑 | `InvocationRecordStore`（**Redis** 版已有） | Redis 热存 + PgSQL 落地 |
| callback 鉴权 | `InvocationRegistry`（**Redis** 版已有） | 直接复用 |
| 排队中消息 | `InvocationQueue`（**纯内存**）⚠️ | **需补持久化** → Redis（见完善点 1） |

> 你设想的"按 userID + 会话ID 取最近 State"——代码里天然有 `scopeKey=threadId:userId` 这个隔离维度，与你的想法一致，可直接映射。

---

## 三、你的分布式设想（落到组件）

- **Agent 无状态实例**：`AgentRouter` 本就是无状态纯函数；每个 Agent 执行容器不持有会话状态，状态外置到 Redis。
- **Nginx 首轮分配**：请求先到 Nginx，按 `userID+sessionID` 路由到对应 Agent Pod（会话亲和）。
- **Redis 热存 + PgSQL 落地**：运行时 State 在 Redis；请求结束把压缩后上下文 + `InvocationRecord` 落 **PgSQL**（对应现有 Redis 版 + 压缩字段）。
- **工具拆 Pod + Nacos + MCP**：每个工具（检索/DB/ls/grep/远端 API）作为独立 Pod，在 **Nacos** 注册，并**统一封装为 MCP** 格式，框架用统一 MCP 客户端调用——这样既支持本地用户侧工具（ls/grep 在用户那侧执行），也支持远端 API（远程调用）。
- **Kafka 异步长耗时工具**：长耗时工具调用先把"调用意图"交消费队列，执行完回写；短耗时（搜索/DB/用户空间 ls,grep）直接同步执行；远端 API 走远程调用。
- **幂等键**：每个工具调用附加幂等键，配合 `idempotencyKey`/`clientMessageIds` 既有机制，防重复执行与消息重放。

---

## 四、三个最小可行的防丢完善点（对齐你的 Kafka 语义）

### 完善点 1（最小）：给 `InvocationQueue` 加 Redis 持久层
- 复用现有 `RedisSessionChainStore` 的 Redis 客户端模式，把 `scopeKey → QueueEntry[]` 持久化。
- 崩溃重启后由 `restoreDurableEntry` 从 Redis 重建队列，不再依赖纯内存 custody 重建（更稳）。
- 风险低：仅改存储后端，不动队列内部不变量（steer 预留 / prestart 退休 / custody CAS）。

### 完善点 2（对齐 Kafka 语义）：显式 outbox ack + 重试队列（DLQ）
- 把"完成 = 子 invocation 回传父 + 清任务"显式化为 **outbox ack**：每个 target 完成并回传父 worklist，才标记 done；失败进入**显式重试队列**。
- 将现有 `retryFailedTarget` / `bindRetryAttemptId` 扩成真正的 **DLQ**（死信队列），而非仅内存重试。
- 这正好对应你说的"生产端记本地事务库 → 子 Agent 回传父 Agent 才清任务 → 错误进重试队列"。

### 完善点 3（落库）：PgSQL 落地压缩后上下文 + 调用记录
- 请求结束把 `InvocationRecord` + 压缩后上下文写 **PgSQL**（现有 Redis 热 + `compressionCount` 字段扩展）。
- 对齐你说的"Redis 热存储 + PgSQL 在后续压缩，请求结束的时候落地"。

> 落地顺序建议：完善点 1（先把队列持久化，立刻降低崩溃丢消息概率）→ 完善点 3（落库，满足审计/回溯）→ 完善点 2（显式 DLQ，对齐 Kafka 语义，工作量最大放最后）。

---

## 五、一句话总结给你（面试怎么讲）

> 现状下"鉴权/记录/会话"已 Redis 化，短板在 `WorklistRegistry` 与 `InvocationQueue` 两块纯内存；如果要做分布式，我的 Nacos/MCP/Kafka/Redis/PgSQL 设想正好补上这两块的持久化与异步化，三个完善点按"队列持久化 → PgSQL 落地 → 显式 DLQ"顺序推进最稳。
> **注意**：这道题是"如果……你怎么考虑"，回答时定性为"现状分析 + 设计方向"，明确说明当前系统**单进程内存态、未做分布式**，不要让人误以为已经上线了分布式。
