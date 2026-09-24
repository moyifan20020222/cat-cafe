/**
 * F-EXT: Causal memory extraction schema（因果记忆提取结构）
 *
 * 原始项目的蒸馏链路把一条"教训"抽成扁平字符串（DurableCandidate.claim）。
 * 这里把提取升级为**因果四元组**，把"发生了什么 → 做了什么 → 结果如何 → 学到了什么"
 * 显式拆开，使记忆能按"触发情境"检索、按"动作"聚类，而不只是关键词匹配。
 *
 * 语义：
 * - trigger：触发这条记忆的情境 / 信号（比如"build 超时""用户连续两次改了同一段逻辑"）。
 * - action ：当时采取了什么动作 / 决策（比如"加 AbortController 级联取消"）。
 * - result ：动作带来的结果（比如"子 Agent 不再悬挂"）。
 * - lesson ：从中提炼的、可跨场景复用的规律（这才是最该固化的 durable truth）。
 * - causalConfidence：模型对这四元组因果链成立的把握度。
 */

export const CAUSAL_CONFIDENCE_LEVELS = ['high', 'medium', 'low'] as const;

export type CausalConfidence = (typeof CAUSAL_CONFIDENCE_LEVELS)[number];

export interface CausalExtraction {
  /** 触发情境 / 信号：什么条件下这条记忆会被再次召回。 */
  trigger: string;
  /** 当时采取的行动 / 决策。 */
  action: string;
  /** 行动产生的结果（可观测、可验证）。 */
  result: string;
  /** 从中提炼的、可跨场景复用的规律——最该固化的 durable truth。 */
  lesson: string;
  /** 模型对因果链成立的把握度。 */
  causalConfidence: CausalConfidence;
}

/** 冲突评估：新候选与既有 durable truth 之间的矛盾检测结论。 */
export interface ConflictAssessment {
  /**
   * 与既有 truth 的冲突类型：
   * - keyword_overlap：关键词高度重叠但结论方向不同（疑似同一话题的矛盾记忆）。
   * - explicit_contradiction：显式互相排斥（一方 contradicts 另一方）。
   */
  basis: 'keyword_overlap' | 'explicit_contradiction';
  /** 被冲突的既有 truth 的 anchor（来自 materialized truth 或 EvidenceItem）。 */
  conflictingAnchor?: string;
  /** 被冲突的既有 truth 的标题（用于卡片展示）。 */
  conflictingTitle?: string;
  /** 冲突强度 [0,1]，由关键词重叠度 / 显式矛盾字段得出。 */
  score: number;
}
