// ============================================================
// L3 集成层：关系摘要生成器（把关系网「翻译」成决策层能用的白话）
//
// §43 换血：从旧的九维（positivity/negativity/trust…）改成 RSQ 的 39 维，
// 并叠加现实层（L1）的「他记得的那几件事」。
//
// 数据来源：
//   L2 主观层 → rsq_responses（39 维 + 自评语）
//   L1 现实层 → persona_canon_log（他视角下的事件 + 感受）
//
// 铁律：只读，不在此处改数据；L1 只显示**这个人自己的视角**。
// ============================================================
import { readRelations, type PresentedRelation } from "../network";
import { chooseAddress, type Nickname } from "../../contracts/interpersonal";
import { getLatestRSQ } from "../network/repo/rsqRepo";
import { listCanonLog } from "../network/repo/canonLogRepo";

export interface DigestInput {
  personaId: number;
  /** 在场者：personaId → 座位号（必须已按 personaVisibility 过滤） */
  present: Map<number, number>;
  /** 可见人格 id（fog/none 过滤；缺省不过滤，供研究者/管理路径） */
  visiblePersonaIds?: Set<number>;
  /** 该人格的昵称库（profile.nicknames） */
  nicknames?: Nickname[];
  /** 容量上限（§30.8） */
  maxItems?: number;
  /** 每个人最多显示几条现实层记忆 */
  canonLinesPerPerson?: number;
}

// ============================================================
// 旧九维兜底（RSQ 尚未填写时使用）
// ============================================================

function feelTextLegacy(r: PresentedRelation): string {
  const p = r.positivity ?? 0;
  const n = r.negativity ?? 0;
  const k = String(r.kind);
  if (p >= 70 && n >= 60) return "这个人对你又爱又恨，感情极重、也极矛盾";
  if (p >= 70) return "这个人对你很重要，你护着 TA";
  if (n >= 70) return "这个人伤过你，你心里过不去";
  if (n >= 40) return "你对这个人有戒心";
  if (p >= 40) return "你对这个人有好感";
  return k === "unspecified" ? "你们之间说不上亲近" : "你们之间有过交集";
}

function kindText(kind: string): string {
  const M: Record<string, string> = {
    kin: "血缘/家人", beloved: "挚爱", sworn_friend: "生死之交",
    comrade: "并肩的同伴", peer: "同侪", mentor: "师长",
    sovereign: "上级/统领", rival: "对手", nemesis: "宿敌",
    creditor: "你欠着 TA", kin_slayer: "你亲手了结过的人",
    unspecified: "",
  };
  return M[kind] ?? "";
}

// ============================================================
// RSQ 核心维度的白话翻译
// ============================================================

/** 把 RSQ 的一组维度压成一句「我此刻对他的感觉」 */
function rsqFeelText(dims: {
  affection: number;
  antagonism: number;
  faith: number;
  commitment: number;
  closeness: number;
  forgiveness: number;
}): string {
  const { affection, antagonism, faith, commitment, closeness, forgiveness } = dims;
  const parts: string[] = [];

  // 爱恨并存是最重要的形态
  if (affection >= 65 && antagonism >= 65) {
    parts.push("你对 TA 又离不开又恨得咬牙");
  } else if (affection >= 70) {
    parts.push("TA 对你是重要的");
  } else if (antagonism >= 70) {
    parts.push("TA 让你很难受");
  } else if (affection >= 45) {
    parts.push("你对 TA 有点好感");
  } else if (antagonism >= 45) {
    parts.push("你对 TA 有戒心");
  }

  if (faith >= 75) {
    parts.push("你信 TA 的判断");
  } else if (faith <= 30) {
    parts.push("你不信 TA");
  }

  if (commitment >= 70) {
    parts.push("你愿意为 TA 付出代价");
  } else if (commitment <= 30) {
    parts.push("你不打算为 TA 担什么");
  }

  if (closeness >= 80) {
    parts.push("你俩几乎没有边界");
  } else if (closeness <= 25) {
    parts.push("你俩隔着很远");
  }

  if (forgiveness <= 30 && affection >= 50) {
    parts.push("但你有件事还没原谅 TA");
  }

  return parts.length > 0 ? parts.join("，") : "你说不清对 TA 是什么感觉";
}

/** 简短维度串（给 AI 一个可感的坐标）*/
function rsqDimLine(dims: {
  affection: number;
  antagonism: number;
  faith: number;
  commitment: number;
}): string {
  const pct = (v: number) => String(Math.round(v));
  return "喜爱 " + pct(dims.affection) + " · 对抗 " + pct(dims.antagonism) +
    " · 信任 " + pct(dims.faith) + " · 承诺 " + pct(dims.commitment);
}

// ============================================================
// 主函数
// ============================================================

export async function buildRelationDigest(input: DigestInput): Promise<string> {
  const { personaId, present, nicknames = [], maxItems = 8, canonLinesPerPerson = 2, visiblePersonaIds } = input;
  const rels = await readRelations({ personaId });
  if (rels.length === 0) return "";

  const presentIds = new Set(present.keys());
  const visible = visiblePersonaIds ?? null;
  const isVisible = (id: number) => id !== 0 && presentIds.has(id) && (!visible || visible.has(id));
  const inRoom = rels.filter((r) => isVisible(r.toPersonaId));
  const outside = rels.filter((r) => !isVisible(r.toPersonaId));

  const top = [...inRoom]
    .sort((a, b) => (b.metrics?.involvement ?? 0) - (a.metrics?.involvement ?? 0))
    .slice(0, maxItems);
  if (top.length === 0) return "";

  const blocks: string[] = [];
  for (const r of top) {
    const seat = present.get(r.toPersonaId);
    const who = seat != null ? seat + "号位" : "某位";
    const name = r.toName || "";
    const kt = kindText(String(r.kind));

    // 称呼：§21 语境模型（私下场合）
    let call = name;
    if (nicknames.length > 0) {
      const eligible = nicknames.filter((n) => n.layer === "public" || n.layer === "intimate");
      const chosen = chooseAddress({ eligible, setting: "private", intent: "neutral" });
      if (chosen) call = chosen.text;
    }

    // ---- L2：RSQ 主观层 ----
    const rsq = await getLatestRSQ(personaId, r.toPersonaId).catch(() => null);
    // 称呼优先用语境模型选出的昵称，退化到本名
    const head = [who, call ? "（" + call + "）" : name ? "（" + name + "）" : "", kt ? " · " + kt : ""].join("");
    const detail: string[] = [];

    if (rsq) {
      const d = rsq.dims;
      detail.push(rsqDimLine(d));
      detail.push("→ " + rsqFeelText(d));
      if (rsq.selfSummary) detail.push("你自己的话：\"" + rsq.selfSummary.replace(/\n/g, " ") + "\"");
    } else {
      // 兜底：旧九维
      detail.push("→ " + feelTextLegacy(r));
    }

    // ---- L1：现实层（他记得的事）----
    const canon = await listCanonLog(personaId, r.toPersonaId, { order: "desc" })
      .then((xs) => xs.slice(0, canonLinesPerPerson))
      .catch(() => []);
    if (canon.length > 0) {
      detail.push("你记得的事：");
      for (const c of canon) {
        detail.push("  · " + c.era + " " + c.eventText);
      }
    }

    blocks.push([head, ...detail.map((x) => "  " + x)].join("\n"));
  }

  const out: string[] = [];
  out.push("【你与在场者的旧账】（这些是你心里真实的分量，不是规则——你的话和手会自然带上它们）");
  out.push(...blocks.map((b) => "- " + b));
  if (outside.length > 0) {
    const heavy = outside.filter((r) => (r.metrics?.involvement ?? 0) >= 60).length;
    if (heavy > 0) out.push("- （台下还有 " + heavy + " 段重到放不下的旧账，此刻不在此处）");
  }
  return out.join("\n");
}

/** 生成「对我最重的那一段」一句话（用于目标选择时的倾斜） */
export async function heaviestRelationLine(personaId: number): Promise<string> {
  const rels = await readRelations({ personaId });
  if (rels.length === 0) return "";
  const top = [...rels].sort((a, b) => (b.metrics?.involvement ?? 0) - (a.metrics?.involvement ?? 0))[0];
  if (!top || (top.metrics?.involvement ?? 0) < 60) return "";

  // 优先用 RSQ 的自评语——那是他自己说的话
  const rsq = await getLatestRSQ(personaId, top.toPersonaId).catch(() => null);
  if (rsq?.selfSummary) {
    return "你心里最重的一段是「" + (top.toName || String(top.toPersonaId)) + "」——你自己的话是：" + rsq.selfSummary.replace(/\n/g, " ");
  }

  return "你心里最重的一段是「" + (top.toName || String(top.toPersonaId)) + "」——" + feelTextLegacy(top) + "。";
}
