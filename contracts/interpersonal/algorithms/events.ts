// 山谷事件统计（§17.4，零 AI）
// 审计修复（P0-11）：
//   - killedBy / killedThem 改为计数（布尔化会丢频次）
//   - eventId 去重（同一事件不重复计数）
//   - 事件显著性改为 **显式档位表 + 计数饱和**：亲手终结可达 3.0；opposed_camp / skill_targeted / joint_* 纳入
import type { DyadEvent, DyadEventKind, DyadStats } from "../types";
import { SALIENCE_MIN, SALIENCE_MAX } from "../constants";

/** 计数饱和上限倍数：同类事件即使发生很多次，贡献也不超过基准的 1.5 倍 */
const SALIENCE_COUNT_SATURATION_CAP = 1.5;

/**
 * §12.5 事件显著性表：值为**单个事件在 SALIENCE_MIN 之上的增量**（count=1 时总显著性 = MIN + 该值）。
 * 档位依据 §12.5：
 *   日常闲聊/普通投票 0.2；同阵营协作 0.5；关键局出局 1.5；背叛/生死相救 2.5；亲手终结（kin_slayer）3.0
 */
export const EVENT_SALIENCE_WEIGHTS: Readonly<Record<DyadEventKind, number>> = {
  vote_for: 0,          // 普通投票 → 0.2（仅 MIN）
  vote_against: 0.8,    // 被投 → 1.0，计数饱和后逼近 1.5「关键局被票出」
  same_camp: 0.3,       // → 0.5「同阵营协作」
  opposed_camp: 0.4,    // → 0.6「对阵营博弈」
  killed_by: 1.3,       // → 1.5「关键局/生死局被终结」
  killed: 2.8,          // → 3.0「亲手终结（kin_slayer）」
  skill_targeted: 0.4,  // → 0.6「被技能指向」
  joint_win: 0.3,       // → 0.5「共同胜利」
  joint_loss: 0.5,      // → 0.7「共同失败」
  betrayal: 2.3,        // → 2.5「背叛 / 生死相救」
};

/**
 * 计数饱和：第 n 次同 kind 事件的贡献 = base × (1 + 0.5 × (1 − 0.5^(n−1)))。
 * n=1 → base；n→∞ → 1.5×base。避免刷票/多局累积把显著性直接顶满。
 */
function saturatedWeight(base: number, count: number): number {
  if (!Number.isFinite(count) || count <= 0) return 0;
  const n = Math.floor(count);
  const extra = 0.5 * (1 - Math.pow(0.5, n - 1));
  return base * Math.min(SALIENCE_COUNT_SATURATION_CAP, 1 + extra);
}

function countOf(v: number | undefined): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return 0;
  return Math.floor(v);
}

/** 山谷事件统计（§17.4）：eventId 去重后按类型累计；killed / killed_by 保留频次 */
export function eventStats(events: DyadEvent[]): DyadStats {
  const s: DyadStats = {
    sameCamp: 0, opposedCamp: 0, votesFor: 0, votesAgainst: 0,
    killedBy: 0, killedThem: 0, skillTargeted: 0,
    jointWins: 0, jointLosses: 0, betrayal: 0,
  };
  const seen = new Set<number>();
  for (const e of events) {
    if (typeof e.eventId === "number" && Number.isFinite(e.eventId)) {
      if (seen.has(e.eventId)) continue; // 同一事件只算一次（P0-11 去重）
      seen.add(e.eventId);
    }
    switch (e.kind) {
      case "same_camp": s.sameCamp++; break;
      case "opposed_camp": s.opposedCamp++; break;
      case "vote_for": s.votesFor++; break;
      case "vote_against": s.votesAgainst++; break;
      case "killed_by": s.killedBy++; break;
      case "killed": s.killedThem++; break;
      case "skill_targeted": s.skillTargeted++; break;
      case "joint_win": s.jointWins++; break;
      case "joint_loss": s.jointLosses++; break;
      case "betrayal": s.betrayal++; break;
      default: break;
    }
  }
  return s;
}

/**
 * 事件显著性（§12.5）：由统计矩阵映射到 SALIENCE_MIN..SALIENCE_MAX。
 * 各类型贡献相加后整体封顶；亲手终结（killed）单次即达 3.0。
 */
export function eventSalience(stats: DyadStats): number {
  const counts: Array<[DyadEventKind, number]> = [
    ["vote_for", countOf(stats.votesFor)],
    ["vote_against", countOf(stats.votesAgainst)],
    ["same_camp", countOf(stats.sameCamp)],
    ["opposed_camp", countOf(stats.opposedCamp)],
    ["killed_by", countOf(stats.killedBy)],
    ["killed", countOf(stats.killedThem)],
    ["skill_targeted", countOf(stats.skillTargeted)],
    ["joint_win", countOf(stats.jointWins)],
    ["joint_loss", countOf(stats.jointLosses)],
    ["betrayal", countOf(stats.betrayal)],
  ];
  let s = SALIENCE_MIN;
  for (const [kind, count] of counts) {
    if (count <= 0) continue;
    s += saturatedWeight(EVENT_SALIENCE_WEIGHTS[kind], count);
  }
  return Math.max(SALIENCE_MIN, Math.min(SALIENCE_MAX, s));
}
