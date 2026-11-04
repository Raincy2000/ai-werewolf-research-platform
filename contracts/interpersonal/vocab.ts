// ============================================================
// 受控词表（单一事实源，§27.3）
// ============================================================
import type { NicknameLayer, RelationForm, RelationKind, PerceivedGranularity, ValePattern } from "./types";

/** 昵称四层（Altman & Taylor 1973 社会渗透 depth） */
export const NICKNAME_LAYERS: readonly NicknameLayer[] = ["public", "intimate", "private", "secret"];

/** 层级序（越大越亲密） */
export const NICKNAME_LAYER_RANK: Readonly<Record<NicknameLayer, number>> = {
  public: 1,
  intimate: 2,
  private: 3,
  secret: 4,
};

/** 各层默认 awareness / usage / threshold */
export const NICKNAME_LAYER_DEFAULTS: Readonly<
  Record<NicknameLayer, { awareness: "all" | "private" | "self"; usage: "all" | "threshold" | "specific" | "self"; threshold: number }>
> = {
  public: { awareness: "all", usage: "all", threshold: 0 },
  intimate: { awareness: "all", usage: "threshold", threshold: 60 },
  private: { awareness: "private", usage: "specific", threshold: 80 },
  secret: { awareness: "self", usage: "self", threshold: 100 },
};

/** 关系类别（Haslam 1994 原型范畴；可多重，带 prototypicality） */
export const RELATION_KINDS: readonly RelationKind[] = [
  "kin", "beloved", "sworn_friend", "comrade",
  "mentor", "sovereign", "peer", "rival", "nemesis",
  "creditor", "kin_slayer", "unspecified",
];

/** 关系类别中文标签（详情页/手录表单展示与选择用；2026-10-22 从后端硬编码提升为契约） */
export const RELATION_KIND_LABEL: Readonly<Record<RelationKind, string>> = {
  kin: "血缘/家人",
  beloved: "挚爱",
  sworn_friend: "生死之交",
  comrade: "并肩同伴",
  peer: "同侪",
  mentor: "师长",
  sovereign: "上级/统领",
  rival: "对手",
  nemesis: "宿敌",
  creditor: "亏欠",
  kin_slayer: "亲手了结",
  unspecified: "未分类",
};

/** 类别 → Fiske RMT 四型默认映射（§25.7） */
export const RELATION_KIND_TO_FORM: Readonly<Record<RelationKind, RelationForm>> = {
  kin: "CS",
  beloved: "CS",
  sworn_friend: "CS",
  comrade: "EM",
  peer: "EM",
  rival: "EM",
  nemesis: "EM",
  mentor: "AR",
  sovereign: "AR",
  kin_slayer: "AR",
  creditor: "MP",
  unspecified: "CS",
};

/** Fiske RMT 四型（1991/2004） */
export const RELATION_FORMS: readonly RelationForm[] = ["CS", "AR", "EM", "MP"];

export const RELATION_FORM_LABEL: Readonly<Record<RelationForm, string>> = {
  CS: "共同分享",
  AR: "权威排序",
  EM: "平等匹配",
  MP: "市场定价",
};

/** 二阶认知粒度（§24.4） */
export const GRANULARITY_LEVELS: readonly PerceivedGranularity[] = ["L0", "L1", "L2", "L3", "L4"];

export const GRANULARITY_RANK: Readonly<Record<PerceivedGranularity, number>> = {
  L0: 0, L1: 1, L2: 2, L3: 3, L4: 4,
};

export const GRANULARITY_LABEL: Readonly<Record<PerceivedGranularity, string>> = {
  L0: "知道存在",
  L1: "知道极性",
  L2: "知道单维",
  L3: "知道多维",
  L4: "知道细节",
};

/** 山谷层对局关系词表（§38 修正：与原世界情感词表严格分离） */
export const VALE_PATTERNS: readonly ValePattern[] = [
  "team", "cooperate", "oppose", "trading", "suppress", "acquainted", "none",
];

export const VALE_PATTERN_LABEL: Readonly<Record<ValePattern, string>> = {
  team: "队友",
  cooperate: "常协作",
  oppose: "常对立",
  trading: "攻防互现",
  suppress: "单向压制",
  acquainted: "偶有交集",
  none: "无直接互动",
};

/** 山谷层不判 Fiske 四型（那是原世界关系的组织逻辑），统一记 EM（对等博弈） */
export const VALE_DEFAULT_FORM = "EM" as const;
