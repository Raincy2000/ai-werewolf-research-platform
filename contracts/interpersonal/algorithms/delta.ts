// 增量校验（§13）：只校正增量，不重算绝对值
// 审计修复（P0-11）：
//   - 先判 cap（显著性上限）再判 tolerance（容差）——旧实现让任何 |Δ|≤15 都返回 consistent
//   - |Δ|>cap 一律 anomalous；仅当 |expected|>cap（事件本身已超出上限）时 undeterminable
//   - DeltaCheckInput 增加 before/after/violationCount，实现 §13.3 第 7 步（trust 留疤）
//   - suggestedDelta = clamp100(before + expected) - before（相对当前值给出可执行建议）
//   - applyTrust 修复"正增量反而降值"与 trustCeiling(NaN)
import type { RelationParamPath, DeltaCheckInput, DeltaCheckResult } from "../types";
import { BASE_CAP, TOLERANCE, SALIENCE_MIN, SALIENCE_MAX, TRUST_VIOLATION_PENALTY } from "../constants";
import { clamp100, clampRange } from "./relation";

/** 数值型（有 0..100 或 -100..100 值域）的校正参数；kind/form 是分类量，不参与数值换算 */
const NUMERIC_PARAMS: ReadonlySet<RelationParamPath> = new Set<RelationParamPath>([
  "positivity", "negativity", "trust", "closeness", "dependence",
  "reciprocity", "power_balance", "formality", "commitment",
]);

/** 参数值域 clamp（power_balance 为双极 -100..100，其余百分比 0..100） */
export function clampParamValue(param: RelationParamPath, value: number): number {
  if (param === "power_balance") return clampRange(value, -100, 100);
  if (NUMERIC_PARAMS.has(param)) return clamp100(value);
  return value; // kind/form 等分类量原样返回
}

/** 信任上限（§12.6 背叛留疤）：100 - 10 × 被背叛次数；非法计数按 0 处理 */
export function trustCeiling(violationCount: number): number {
  const n = Number.isFinite(violationCount) && violationCount > 0 ? Math.floor(violationCount) : 0;
  return Math.max(0, 100 - TRUST_VIOLATION_PENALTY * n);
}

/** 应用信任变动（含上限约束，§12.6） */
export function applyTrust(current: number, delta: number, violationCount: number): number {
  const base = Number.isFinite(current) ? clamp100(current) : 0;
  const d = Number.isFinite(delta) ? delta : 0;
  const next = clamp100(base + d);
  const ceiling = trustCeiling(violationCount);
  // 上升受"受损上限"约束；但正增量不允许把已经高于上限的值往下拉（P0-11：applyTrust(95,+1,1)=95）
  return d > 0 ? Math.max(base, Math.min(next, ceiling)) : next;
}

/** 由事件显著性推出本次允许上限（§12.5） */
export function computeDeltaCaps(param: RelationParamPath, salience: number): { cap: number; tolerance: number } {
  const s = Math.max(SALIENCE_MIN, Math.min(SALIENCE_MAX, Number.isFinite(salience) ? salience : SALIENCE_MIN));
  return { cap: (BASE_CAP[param] ?? 10) * s, tolerance: TOLERANCE[param] ?? 15 };
}

/**
 * 增量合理性判定（§13.3）。
 * 铁律：无法判定时一律不动（undeterminable）——宁可漏检，不可误改。
 *
 * 判定顺序（cap 必须先于 tolerance）：
 *   1. 无事件依据                       → undeterminable
 *   2. 方向相反                          → anomalous（方向错误与幅度上限无关，优先判定）
 *   3. |Δ| > cap：|expected| ≤ cap → anomalous；否则（事件本身已超上限）→ undeterminable
 *   4. |Δ - expected| ≤ tolerance       → consistent
 *   5. trust 特判（§13.3 第 7 步）：violationCount>0 且 after 超过留疤上限 → anomalous
 *   6. 其余                              → undeterminable
 */
export function checkRelationDelta(input: DeltaCheckInput): DeltaCheckResult {
  const { param, layer, actualDelta, events, salience } = input;
  const { cap, tolerance } = computeDeltaCaps(param, salience);

  // 事件去重（同一 eventId 只计一次，避免重复证据抬高 expected）
  const seen = new Set<number>();
  const uniqueEvents = events.filter((e) => {
    const id = Number.isFinite(e.eventId) ? e.eventId : -1;
    if (id >= 0) {
      if (seen.has(id)) return false;
      seen.add(id);
    }
    return true;
  });
  const evidence = uniqueEvents.map((e) => `${e.kind}#${e.eventId}`);

  const actual = Number.isFinite(actualDelta) ? actualDelta : 0;
  const before = typeof input.before === "number" && Number.isFinite(input.before) ? input.before : null;
  const after = typeof input.after === "number" && Number.isFinite(input.after)
    ? input.after
    : (before !== null ? before + actual : null);
  const violationCount = typeof input.violationCount === "number" && Number.isFinite(input.violationCount)
    ? Math.max(0, Math.floor(input.violationCount))
    : 0;

  // 1. 无客观事件依据
  if (uniqueEvents.length === 0) {
    return {
      verdict: "undeterminable",
      suggestedDelta: null,
      reason: layer === "canon" ? "无客观事件依据" : "无事件依据",
      evidence,
    };
  }

  const expected = uniqueEvents.reduce((s, e) => s + (Number.isFinite(e.weight) ? e.weight : 0), 0);

  /** suggestedDelta：把"期望值"折算成相对当前值的可执行增量（§13.3；不重算绝对值） */
  const suggest = (): number | null => {
    if (before === null) return parameterFallbackDelta(param, expected);
    const target = NUMERIC_PARAMS.has(param)
      ? clampParamValue(param, before + expected)
      : before + expected;
    return Math.round(target - before);
  };

  // 2. 方向相反：无论幅度大小都属异常
  if (Math.sign(actual) !== 0 && Math.sign(expected) !== 0 && Math.sign(actual) !== Math.sign(expected)) {
    return {
      verdict: "anomalous",
      suggestedDelta: suggest(),
      reason: `方向相反（实际 ${actual} vs 期望 ${expected}）`,
      evidence,
    };
  }

  // 3. cap 优先于 tolerance：|Δ| 超上限一律 anomalous；事件本身超上限则无法判定
  if (Math.abs(actual) > cap) {
    if (Math.abs(expected) > cap) {
      return {
        verdict: "undeterminable",
        suggestedDelta: null,
        reason: `实际增量 ${actual} 与事件期望 ${expected} 均超出显著性上限 ${cap.toFixed(2)}，无法据此判定`,
        evidence,
      };
    }
    return {
      verdict: "anomalous",
      suggestedDelta: suggest(),
      reason: `实际增量 ${actual} 超出显著性上限 ${cap.toFixed(2)}`,
      evidence,
    };
  }

  // 4. 与事件推导一致（容差内）
  if (Math.abs(actual - expected) <= tolerance) {
    return { verdict: "consistent", suggestedDelta: null, reason: "与事件推导一致", evidence };
  }

  // 5. trust 留疤特判（§13.3 第 7 步）：上升不得超过 100 - 10×violationCount
  if (param === "trust" && violationCount > 0 && after !== null) {
    const ceiling = trustCeiling(violationCount);
    if (after > ceiling) {
      return {
        verdict: "anomalous",
        suggestedDelta: suggest(),
        reason: `信任留疤：after=${after} 超过受损上限 ${ceiling}（violationCount=${violationCount}）`,
        evidence,
      };
    }
  }

  // 6. 其余：证据不足以判定
  return { verdict: "undeterminable", suggestedDelta: null, reason: "证据不足以判定", evidence };
}

/** 无 before 时的建议增量回退（仅用于分类量或缺失上下文）：取期望值并夹到合法增量区间 */
function parameterFallbackDelta(param: RelationParamPath, expected: number): number {
  if (!Number.isFinite(expected)) return 0;
  if (param === "kind" || param === "form") return Math.round(expected);
  return Math.round(clampRange(expected, -100, 100));
}
