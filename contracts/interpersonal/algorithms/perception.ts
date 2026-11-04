// 二阶关系认知（§24，纯函数、零 I/O）
// 审计修复（P0-11）：
//   - granularityScore 改为 source × viewerFactor 乘法；faculty 为乘法门控（faculty=0 → 0，§23.3）
//   - biasRisk clamp 到 [0,1]，closeness 先 clamp 到 0..100（旧实现 closeness=-200 可得负风险）
//   - 所有输入域补 clamp（NaN/越界不再污染评分）
import type {
  PerceivedGranularity, PerceptionInputs, PerceivedSource, PerceptionBias,
} from "../types";
import { GRANULARITY_RANK } from "../vocab";
import { CONFIDENCE_CLEAR, CONFIDENCE_BLURRED } from "../constants";

/** 信息来源权重（§24.5 因子①）：同世界原作知识 > 目击 > 传闻 > 推断 */
export const SOURCE_WEIGHT: Readonly<Record<PerceivedSource, number>> = {
  canon: 1.0,
  observed: 0.8,
  rumor: 0.4,
  inferred: 0.2,
};

function clamp01(v: number | undefined | null): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

function clamp100(v: number | undefined | null): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, v));
}

/**
 * 认知粒度评分（§24.5 五因子 / §23.10 viewerFactor 乘积模型）。
 * ① 信息来源 source（供给侧权重）
 * ② 与关系方距离 distanceToActor（越近越高）
 * ③ 认知能力 faculty（**乘法门控**：能力为 0 则什么都看不清，§23.3"任一为 0 整体为 0"）
 * ④ 结构位置 structuralPosition
 * ⑤ 对该个体知识 targetKnowledge
 *
 *   viewerFactor = faculty × (0.6×近距 + 0.2×结构 + 0.2×个体知识)
 *   granularity  = clamp(source × viewerFactor, 0, 1)
 * （0.45/0.25/0.15/0.15 的旧加权和把 faculty 当加项，faculty=0 仍得 0.3，故修正；P0-11）
 */
export function granularityScore(input: PerceptionInputs): number {
  const src = clamp01(SOURCE_WEIGHT[input.source] ?? 0.2);
  const distance = 1 - clamp01(input.distanceToActor); // 越近越高
  const faculty = clamp01(input.faculty);
  const position = clamp01(input.structuralPosition);
  const knowledge = clamp01(input.targetKnowledge);
  const viewerFactor = faculty * (0.6 * distance + 0.2 * position + 0.2 * knowledge);
  return clamp01(src * viewerFactor);
}

/** 评分 → 粒度层级（L0..L4）；非法分数按 L0（不可见）处理 */
export function scoreToGranularity(score: number): PerceivedGranularity {
  const s = typeof score === "number" && Number.isFinite(score) ? score : 0;
  if (s >= 0.80) return "L4";
  if (s >= 0.60) return "L3";
  if (s >= 0.40) return "L2";
  if (s >= 0.20) return "L1";
  return "L0";
}

/** 置信度 → 三档可见（§23.5）：clear / blurred / invisible；非法值→不可见 */
export function visibilityOf(confidence: number): "clear" | "blurred" | "invisible" {
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) return "invisible";
  const c = Math.max(0, Math.min(1, confidence));
  if (c >= CONFIDENCE_CLEAR) return "clear";
  if (c >= CONFIDENCE_BLURRED) return "blurred";
  return "invisible";
}

/** 粒度是否足以断言某维度的具体值（L2 以上才知道单维）；非法粒度按 L0 */
export function canAssertDimension(g: PerceivedGranularity): boolean {
  return (GRANULARITY_RANK[g] ?? 0) >= GRANULARITY_RANK.L2;
}

/**
 * 偏差风险（§23.6 投射悖论）：越亲近越容易用自己的模型覆盖对方。
 * closeness 先 clamp 到 0..100，结果 clamp 到 [0,1]（旧实现可为负，污染概率/采样；P0-11）。
 */
export function biasRisk(bias: PerceptionBias | null | undefined, closeness: number): number {
  const c = clamp100(closeness);
  // 投射悖论（§23.6）：越亲近，投射风险越高
  const proj = bias === "transitivity" ? 0.3 : bias === "balance" ? 0.4 : bias === "homophily" ? 0.35 : 0.25;
  return clamp01(proj * (0.5 + c / 100));
}

/** 认知准确性（Krackhardt CSS，研究用）：1 - 归一化偏差；输入维度先 clamp 到 0..100 */
export function perceptionAccuracy(
  perceived: { positivity?: number; negativity?: number },
  actual: { positivity?: number; negativity?: number },
): number {
  const dp = Math.abs(clamp100(perceived.positivity) - clamp100(actual.positivity)) / 100;
  const dn = Math.abs(clamp100(perceived.negativity) - clamp100(actual.negativity)) / 100;
  return clamp01(1 - (dp + dn) / 2);
}
