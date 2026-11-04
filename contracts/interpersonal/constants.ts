// ============================================================
// 常量与阈值（单一事实源；标注 CALIBRATABLE 的待实证重估）
// ============================================================
import type { RelationParamPath } from "./types";

/** 悬空哨兵：to_persona_id = 0 表示对方是库外角色（§19） */
export const DANGLING_PERSONA_ID = 0;

// ---------- 增量校正（§13.4） ----------
/** 日常事件下的允许变动幅度（CALIBRATABLE） */
export const BASE_CAP: Readonly<Record<RelationParamPath, number>> = {
  positivity: 10,
  negativity: 10,
  trust: 10,
  closeness: 8,
  dependence: 8,
  reciprocity: 10,
  power_balance: 8,
  formality: 8,
  commitment: 8,
  kind: 1,
  form: 1,
};

/** 判定容差（CALIBRATABLE） */
export const TOLERANCE: Readonly<Record<RelationParamPath, number>> = {
  positivity: 15,
  negativity: 15,
  trust: 15,
  closeness: 12,
  dependence: 12,
  reciprocity: 15,
  power_balance: 12,
  formality: 12,
  commitment: 12,
  kind: 0,
  form: 0,
};

/** 事件显著性范围（§12.5） */
export const SALIENCE_MIN = 0.2;
export const SALIENCE_MAX = 3.0;

/** 信任背叛折损（§12.6）：每次背叛永久压低上限 10 点 */
export const TRUST_VIOLATION_PENALTY = 10;

// ---------- 昵称 / 称呼（§17 / §21） ----------
/** 亲密层默认门槛（CALIBRATABLE） */
export const NICKNAME_THRESHOLD_DEFAULT = 60;
/** 亲密度达标的快捷线（closeness ≥ 此值即达标） */
export const FAMILIARITY_CLOSENESS_MIN = 60;
/** 亲密度达标的组合线（positivity 与 trust 同时 ≥ 此值） */
export const FAMILIARITY_AFFECT_MIN = 70;
export const FAMILIARITY_TRUST_MIN = 60;

// ---------- 二阶认知（§24） ----------
/** 置信度阈值：≥清晰 / 中间模糊 / 低不可见 */
export const CONFIDENCE_CLEAR = 0.7;
export const CONFIDENCE_BLURRED = 0.3;

// ---------- 调用台（§30） ----------
/** 工作记忆容量上限（Cowan 2001 约 4 chunks；此处放宽到可读批次） */
export const MAX_INVOKED = 12;
/** 激活扩散深度（跳） */
export const SPREAD_DEPTH = 1;
