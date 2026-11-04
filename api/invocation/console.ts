// ============================================================
// 调用台（§30）—— 人格研究站的应用域核心
// 职责：情境识别 → 线索匹配 → 路由+扩散 → 冲突消解 → 组装+留痕
// 学术地基：工作记忆容量(Cowan 2001) / 编码特异性(Tulving 1973) /
//           激活规则(Higgins) / 激活扩散(Collins & Loftus 1975) /
//           情境模型(Zwaan) / 再认启动决策(Klein) / 可供性(Gibson)
// ============================================================
import { createHash } from "node:crypto";
import {
  MAX_INVOKED,
  type SituationKind,
  type InvokedItem,
  type Affordance,
  type ResolvedConflict,
  type InvokedContext,
} from "../../contracts/interpersonal";
import { readRelations, type PresentedRelation } from "../network/readModel";
import { insertInvocation } from "../network/repo/invocationRepo";

/** 情境识别（Klein RPD：先识别情境类型，再路由） */
export function identifySituation(phase: string, action?: string | null): SituationKind {
  const p = String(phase || "").toLowerCase();
  const a = String(action || "").toLowerCase();
  if (p.includes("night") && (a.includes("kill") || a.includes("wolf"))) return "night_wolf";
  if (p.includes("night") && (a.includes("check") || a.includes("seer"))) return "night_seer";
  if (a.includes("vote")) return "day_vote";
  if (a.includes("speech") || a.includes("talk")) return "day_speech";
  if (p.includes("dawn")) return "dawn";
  if (p.includes("end") || p.includes("over")) return "endgame";
  return "day_speech";
}

/** 适用性：这条关系与当前情境的吻合度 0..1 */
export function applicability(r: PresentedRelation, presentIds: Set<number>, kind: SituationKind): number {
  let s = 0;
  const inRoom = r.toPersonaId !== 0 && presentIds.has(r.toPersonaId);
  if (inRoom) s += 0.6;
  if (r.layer === "canon") s += 0.15;
  const neg = r.negativity ?? 0;
  const pos = r.positivity ?? 0;
  if (kind === "day_vote" || kind === "night_wolf") s += (neg / 100) * 0.25;
  else s += (pos / 100) * 0.15;
  return Math.max(0, Math.min(1, s));
}

/** 可及性：这条关系多容易被想起来 0..1（显式化，可复现，§30.11） */
export function accessibility(r: PresentedRelation, recencyWeight = 0): number {
  const inv = r.metrics.involvement / 100;
  const amb = r.metrics.ambivalence / 100;
  const viol = Math.min(1, (r.violationCount ?? 0) / 3);
  return Math.max(0, Math.min(1, 0.5 * inv + 0.3 * amb + 0.2 * viol + recencyWeight));
}

export interface AssembleInput {
  personaId: number;
  gameId?: string | null;
  turn?: number | null;
  phase: string;
  action?: string | null;
  /** 显式情境（优先于 phase/action 猜测；服务层传 pending.kind 映射） */
  situationKind?: SituationKind;
  present: Map<number, number>;
}

export interface AssembleResult {
  context: InvokedContext;
  digest: string;
  logId: number;
}

/** 调用台主流程（§30.5）。失败不阻塞决策。 */
export async function assembleInvocation(input: AssembleInput): Promise<AssembleResult> {
  const { personaId, gameId, turn, phase, action, present, situationKind } = input;
  const kind = situationKind ?? identifySituation(phase, action);
  const presentIds = new Set(present.keys());

  let rels: PresentedRelation[] = [];
  try { rels = await readRelations({ personaId }); } catch { rels = []; }

  // 2026-10-22：只保留在场者（§33.3）；同一目标多 kind 去重，避免台下沉旧账挤占容量
  const byTarget = new Map<number, { r: PresentedRelation; score: number }>();
  for (const r of rels) {
    if (r.toPersonaId === 0 || !presentIds.has(r.toPersonaId)) continue;
    const s = applicability(r, presentIds, kind) * accessibility(r);
    const prev = byTarget.get(r.toPersonaId);
    if (!prev || s > prev.score) byTarget.set(r.toPersonaId, { r, score: s });
  }
  const scored = [...byTarget.values()]
    .map((x) => ({ ...x, ap: applicability(x.r, presentIds, kind), ac: accessibility(x.r) }))
    .sort((a, b) => b.score - a.score);

  const kept = scored.slice(0, MAX_INVOKED);
  const dropped = scored.slice(MAX_INVOKED);
  const toItem = (x: (typeof scored)[number]): InvokedItem => ({
    source: "persona_relations",
    id: x.r.id ?? 0,
    purpose: String(x.r.toName ?? x.r.toPersonaId) + "/" + String(x.r.kind),
    score: Number(x.score.toFixed(3)),
  });
  const invoked = kept.map(toItem);
  const truncated = dropped.map(toItem);

  // 冲突消解：同一 dyad 跨层并存（§5.1）
  const conflicts: ResolvedConflict[] = [];
  const byTargetLayers = new Map<number, string[]>();
  for (const x of kept) {
    const list = byTargetLayers.get(x.r.toPersonaId) ?? [];
    list.push(x.r.layer);
    byTargetLayers.set(x.r.toPersonaId, list);
  }
  for (const layers of byTargetLayers.values()) {
    const uniq = [...new Set(layers)];
    if (uniq.length > 1) {
      conflicts.push({
        between: [uniq[0] ?? "", uniq[1] ?? ""],
        resolvedTo: "coexist",
        rule: "canon 与 vale 冲突共存（§5.1）",
      });
    }
  }

  // 可供性（Gibson）：此刻"能做什么"
  const affordances: Affordance[] = [];
  const hostile = kept.filter((x) => (x.r.negativity ?? 0) >= 60);
  if (hostile.length > 0) {
    affordances.push({ action: "对旧敌出手", supportedBy: hostile.map((x) => String(x.r.id ?? 0)) });
  }
  const loyal = kept.filter((x) => (x.r.positivity ?? 0) >= 70);
  if (loyal.length > 0) {
    affordances.push({ action: "护着旧情", supportedBy: loyal.map((x) => String(x.r.id ?? 0)) });
  }

  const context: InvokedContext = {
    situation: { kind, actors: [...present.keys()], recentEvents: [] },
    situationModel: { timeline: String(phase) + (action ? " / " + String(action) : ""), causalChain: "", myGoal: "" },
    invoked,
    truncated,
    affordances,
    conflicts,
  };

  const digest = renderDigest(kept.map((x) => x.r), present);

  let logId = 0;
  try {
    const hash = createHash("sha256")
      .update(JSON.stringify({ kind, invoked, conflicts }))
      .digest("hex")
      .slice(0, 32);
    logId = await insertInvocation({
      gameId: gameId ?? null,
      turn: turn ?? null,
      personaId,
      situationKind: kind,
      invokedSources: invoked,
      truncated,
      conflictsResolved: conflicts,
      contextHash: hash,
    });
  } catch { logId = 0; }

  return { context, digest, logId };
}

/** 把调用结果渲染成决策层可用的白话段 */
export function renderDigest(rels: PresentedRelation[], present: Map<number, number>): string {
  if (rels.length === 0) return "";
  const feel = (r: PresentedRelation): string => {
    const p = r.positivity ?? 0;
    const n = r.negativity ?? 0;
    if (p >= 70 && n >= 60) return "又爱又恨，感情极重也极矛盾";
    if (p >= 70) return "很重要，你护着 TA";
    if (n >= 70) return "伤过你，你心里过不去";
    if (n >= 40) return "你有戒心";
    if (p >= 40) return "你有好感";
    return "说不上亲近";
  };
  const lines = rels.map((r) => {
    const seat = present.get(r.toPersonaId);
    const who = seat != null ? String(seat) + "号位" : (r.toName || "某人");
    return "- " + who + "：" + feel(r);
  });
  return ["【你此刻心里浮起的人】（不是规则，是你自己的分量）", ...lines].join("\n");
}
