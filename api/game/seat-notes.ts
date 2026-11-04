// ============================================================
// 对局笔记（座位级「所知所思所为」紧凑记录）——书记员层的叶子模块
// 从 service.ts 析出（2026-10-15 架构优化专项）：主服务与恢复模块共用，零反向依赖
// ============================================================

import type { DecisionInput } from "./engine/api";

export const SEAT_NOTE_MAX = 15; // 每座位最多保留最近 N 条（早期笔记自然淡出）
export const SEAT_NOTE_CHARS = 110; // 单条上限

/** 决策 → 笔记动作描述（紧凑人话） */
export function describeActionForNote(kind: string, d: DecisionInput): string {
  const tgt = d.targets?.length ? `${d.targets[0]}号` : "";
  if (d.selfDestruct) return "自爆";
  if (d.duel != null) return `决斗${d.duel}号`;
  if (d.surrender || d.declareVictory) return "白日交刀";
  if (d.speech?.trim()) return `发言说「${d.speech.trim().slice(0, 50)}${d.speech.trim().length > 50 ? "…" : ""}」`;
  switch (kind) {
    case "wolfKill": return `夜刀投票给${tgt}`;
    case "seerCheck": case "psychicCheck": case "gargoyleCheck": return `查验${tgt}`;
    case "witchAction": return d.witchSave ? "用解药救人" : tgt ? `毒杀${tgt}` : "未用药";
    case "guardProtect": return tgt ? `守护${tgt}` : "空守";
    case "dreamerDream": return `摄梦${tgt}`;
    case "mechWolfMimic": return tgt ? `模仿${tgt}` : "未模仿";
    case "demonHunterHunt": return tgt ? `狩猎${tgt}` : "未狩猎";
    case "crowCurse": return tgt ? `诽谤${tgt}` : "未诽谤";
    case "dayVote": case "sheriffVote": return `投票给${tgt}`;
    case "sheriffRun": return d.targets?.[0] === 1 ? "报名上警" : "留在警下";
    case "sheriffWithdraw": return d.targets?.[0] === 1 ? "退水放弃竞选" : "继续竞选";
    case "sheriffOrder": return `定序${d.targets?.[0] === 1 ? "升序" : "降序"}发言`;
    case "badgePass": return tgt ? `警徽移交给${tgt}` : "撕掉警徽";
    case "hunterShoot": case "whiteWolfTake": return tgt ? `开枪/带走${tgt}` : "不开枪";
    case "exileSkill": return tgt ? `发动技能指向${tgt}` : "沉默出局";
    default: return d.skip ? "弃权" : tgt ? `行动→${tgt}` : "行动";
  }
}

/** 从决策日志重建对局笔记（断点恢复用：与引擎状态同源，重放一致性天然成立） */
export function rebuildSeatNotesFromLog(rows: { kind: string; seat: number; decision: unknown }[]): Map<number, string[]> {
  const notes = new Map<number, string[]>();
  for (const r of rows) {
    const d = r.decision as DecisionInput;
    if (!d || typeof d !== "object") continue;
    const thought = (d.thought ?? "").trim().slice(0, 60);
    const line = `[重放] 我${describeActionForNote(r.kind, d)}${thought ? `（想法：${thought}）` : ""}`
      .slice(0, SEAT_NOTE_CHARS);
    const arr = notes.get(r.seat) ?? [];
    arr.push(line);
    if (arr.length > SEAT_NOTE_MAX) arr.splice(0, arr.length - SEAT_NOTE_MAX);
    notes.set(r.seat, arr);
  }
  return notes;
}
