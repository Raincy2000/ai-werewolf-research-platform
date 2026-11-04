/**
 * RSQ 解析器：把 39 个维度分 → 关系类型（kind）。
 *
 * 学术依据：
 *  - Haslam (1994)：关系类别是**原型结构**，判断"算不算挚爱"看与原型相似度，
 *    不是查表；且一个关系可以同时匹配多个原型（"挚爱"与"终结者"可并存）。
 *  - Wiggins (1979) 人际环：用少数正交维度定位关系。
 *
 * 算法：欧氏距离 + 归一化相似度。纯规则、可复现、可审计。
 * LLM 不参与 kind 判定（避免不可复现），仅在分数接近两原型时可由上层做"叙事裁决"。
 */
import type { RSQDimensions } from "./rsq";

// ============================================================
// 8 轴（与雷达图一致）
// ============================================================

export type ArchetypeAxis =
  | "affection" // 喜爱
  | "antagonism" // 对抗
  | "faith" // 信任
  | "commitment" // 承诺
  | "closeness" // 亲密
  | "forgiveness" // 原谅
  | "equity" // 公平（由 equityBalance 派生）
  | "admiration"; // 钦佩

export const ARCHETYPE_AXES: readonly ArchetypeAxis[] = [
  "affection",
  "antagonism",
  "faith",
  "commitment",
  "closeness",
  "forgiveness",
  "equity",
  "admiration",
];

export const ARCHETYPE_LABEL: Record<ArchetypeAxis, string> = {
  affection: "喜爱",
  antagonism: "对抗",
  faith: "信任",
  commitment: "承诺",
  closeness: "亲密",
  forgiveness: "原谅",
  equity: "公平",
  admiration: "钦佩",
};

export type ArchetypeVector = Record<ArchetypeAxis, number>;

/**
 * 把 39 维压缩成 8 轴（全部映射到 0–100，数值越大该轴越"满"）。
 *
 * 注意：
 *  - forgiveness 已是组合指标（善意×2 + (100-回避) + (100-报复)）
 *  - equity 由 equityBalance（50=公平）派生：公平度 = 100 - |balance-50|×2
 *  - 缺失维度按 50（中性）处理，避免整条向量崩坏
 */
export function toArchetypeVector(d: RSQDimensions): ArchetypeVector {
  const neutral = (v: number | undefined | null): number =>
    typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 50;
  const equityFairness = 100 - Math.abs((d.equityBalance ?? 50) - 50) * 2;
  return {
    affection: neutral(d.affection),
    antagonism: neutral(d.antagonism),
    faith: neutral(d.faith),
    commitment: neutral(d.commitment),
    closeness: neutral(d.closeness),
    forgiveness: neutral(d.forgiveness),
    equity: neutral(equityFairness),
    admiration: neutral(d.admiration),
  };
}

// ============================================================
// kind 原型坐标（8 轴，0–100）
// ============================================================

export interface KindPrototype {
  kind: string;
  label: string;
  axis: ArchetypeVector;
  /** 一句话典型特征（供 UI 提示） */
  gist: string;
}

const P = (
  kind: string,
  label: string,
  gist: string,
  a: [number, number, number, number, number, number, number, number],
): KindPrototype => ({
  kind,
  label,
  gist,
  axis: {
    affection: a[0],
    antagonism: a[1],
    faith: a[2],
    commitment: a[3],
    closeness: a[4],
    forgiveness: a[5],
    equity: a[6],
    admiration: a[7],
  },
});

/**
 * 12 个 kind 的原型。
 * 顺序无意义，匹配时按距离排序。
 */
export const KIND_PROTOTYPES: readonly KindPrototype[] = [
  //        喜爱 对抗 信任 承诺 亲密 原谅 公平 钦佩
  P("kin", "家人", "血脉/养育绑定的不可选择关系", [85, 20, 85, 90, 90, 80, 60, 60]),
  P("beloved", "挚爱", "唯一的、不可替代的依恋", [95, 10, 88, 88, 95, 85, 60, 75]),
  P("sworn_friend", "生死之交", "以命相托的同盟", [85, 15, 92, 95, 80, 80, 65, 75]),
  P("comrade", "同伴", "并肩作战但非性命相托", [65, 25, 75, 70, 60, 65, 65, 55]),
  P("peer", "同侪", "平级、可合作可竞争的普通关系", [50, 40, 55, 40, 40, 55, 60, 45]),
  P("mentor", "师长", "我敬他、他指点我", [60, 20, 70, 55, 55, 60, 35, 90]),
  P("sovereign", "上级", "地位不对等，我听命于他", [50, 30, 65, 60, 40, 50, 20, 85]),
  P("rival", "对手", "立场对立但守规则", [30, 75, 45, 30, 35, 40, 55, 60]),
  P("nemesis", "宿敌", "刻骨对立，不共戴天", [15, 90, 30, 15, 25, 20, 50, 65]),
  P("creditor", "亏欠", "人情债未清，关系被债绑定", [45, 35, 45, 50, 40, 45, 10, 50]),
  /** ★ 关键：高喜爱 + 高对抗 = 又爱又恨的"终结者" */
  P("kin_slayer", "终结", "最亲的人，也是亲手了断的人", [85, 85, 40, 60, 80, 20, 40, 60]),
  P("unspecified", "未定", "尚无足够依据定型", [50, 50, 50, 50, 50, 50, 50, 50]),
];

export const KIND_PROTOTYPE_MAP: ReadonlyMap<string, KindPrototype> = new Map(
  KIND_PROTOTYPES.map((p) => [p.kind, p]),
);

// ============================================================
// 匹配
// ============================================================

/** 归一化欧氏距离的上界（8 轴 × 100²）*/
const MAX_DIST = Math.sqrt(ARCHETYPE_AXES.length * 100 * 100);

export interface KindMatch {
  kind: string;
  label: string;
  gist: string;
  /** 原型匹配度 0–1（1 = 与该原型完全吻合）*/
  prototypicality: number;
  /** 各轴差值明细（用于解释"为什么不是另一个原型"）*/
  diff: ArchetypeVector;
}

export interface InterpretOptions {
  /** 取前 N 个匹配（默认 3）*/
  topN?: number;
  /** 低于此匹配度不返回（默认 0.55）*/
  minPrototypicality?: number;
}

/**
 * 原型匹配：返回按匹配度降序的 kind 列表。
 *
 * 允许多个 kind 同时命中（Haslam 原型范畴）——
 * 例如"三笠 → 艾伦"会同时匹配 beloved 与 kin_slayer。
 */
export function matchKinds(d: RSQDimensions, opts: InterpretOptions = {}): KindMatch[] {
  const v = toArchetypeVector(d);
  const topN = opts.topN ?? 3;
  const minP = opts.minPrototypicality ?? 0.55;

  const scored = KIND_PROTOTYPES.map((p) => {
    let sumSq = 0;
    const diff = {} as ArchetypeVector;
    for (const axis of ARCHETYPE_AXES) {
      const dv = v[axis] - p.axis[axis];
      diff[axis] = Math.round(dv);
      sumSq += dv * dv;
    }
    const dist = Math.sqrt(sumSq);
    return {
      kind: p.kind,
      label: p.label,
      gist: p.gist,
      prototypicality: Number((1 - dist / MAX_DIST).toFixed(3)),
      diff,
    };
  });

  return scored
    .filter((m) => m.prototypicality >= minP)
    .sort((a, b) => b.prototypicality - a.prototypicality)
    .slice(0, topN);
}

/** 主导 kind（匹配度最高的一个）；全部低于阈值时返回 unspecified */
export function dominantKind(d: RSQDimensions, opts: InterpretOptions = {}): KindMatch {
  const list = matchKinds(d, { ...opts, topN: 1, minPrototypicality: 0 });
  const fallback = KIND_PROTOTYPE_MAP.get("unspecified")!;
  const best = list[0];
  if (!best || best.prototypicality < (opts.minPrototypicality ?? 0.55)) {
    return {
      kind: "unspecified",
      label: fallback.label,
      gist: fallback.gist,
      prototypicality: best?.prototypicality ?? 0,
      diff: best?.diff ?? ({} as ArchetypeVector),
    };
  }
  return best;
}

/**
 * 原型竞争性：第一名与第二名的差距。
 * 差距小（< 0.05）说明该关系处于两个原型的边界 —— 需要上层叙事裁决或人工复核。
 */
export function archetypeAmbiguity(matches: KindMatch[]): {
  margin: number;
  ambiguous: boolean;
  between: [string, string] | null;
} {
  if (matches.length < 2) return { margin: 1, ambiguous: false, between: null };
  const margin = Number((matches[0]!.prototypicality - matches[1]!.prototypicality).toFixed(3));
  return {
    margin,
    ambiguous: margin < 0.05,
    between: [matches[0]!.kind, matches[1]!.kind],
  };
}

// ============================================================
// 雷达图数据
// ============================================================

/** 雷达图 8 轴数据（0–100，含标签）*/
export interface RadarDatum {
  axis: ArchetypeAxis;
  label: string;
  value: number;
}

export function toRadarData(d: RSQDimensions): RadarDatum[] {
  const v = toArchetypeVector(d);
  return ARCHETYPE_AXES.map((axis) => ({
    axis,
    label: ARCHETYPE_LABEL[axis],
    value: Math.round(v[axis]),
  }));
}
