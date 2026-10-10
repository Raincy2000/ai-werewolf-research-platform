// ============================================================
// 记事簿（Notebook）：人格的跨对局记忆持久化（铁律3）
// - 赛前：loadMemoryContext 把高强度记忆与关系图谱注入心镜（人格记得自己的对局，也可访问历史对局）
// - 赛后：runNotebookWriteback 从对局摘要蒸馏记忆——
//   新记忆入库（强度随情绪权重）、被再度唤起的旧记忆强化（+boost）、
//   未被触及的旧记忆自然衰减（×0.85，下限 5：创伤不会彻底消失）、
//   关系图谱增量传递（亲疏/信任按对局表现调整）、人格漂移写卡并留痕（附录可查）
// ============================================================

import type { SeatAiConfig } from "../../contracts/game";
import type {
  PersonaCard,
  PersonaDriftChange,
  PersonaMemory,
  PersonaRelationship,
} from "../../contracts/persona";
import { getParamValue } from "../../contracts/persona";
import { callAi } from "../game/ai/providers";
import { parseJsonRobust } from "../game/ai/parse";
import {
  decayPersonaMemories,
  applyPersonaDrift,
  insertPersonaMemories,
  reinforcePersonaMemories,
  upsertPersonaRelationship,
} from "../queries/personas";

const NOTEBOOK_TIMEOUT_MS = 240_000;
const DECAY_FACTOR = 0.85; // 每局未被触及的记忆强度 ×0.85
const REINFORCE_BOOST = 15; // 被再度唤起的记忆 +15（封顶 100）
const DRIFT_MAX_DELTA = 12; // 单局单参数最大漂移幅度（防止人格突变）

// ---------- 回写输出契约 ----------
interface WritebackMemory {
  type: "trauma" | "relationship" | "general";
  content: string;
  emotionalWeight: number; // 0-100
  reinforceMemoryId: number | null; // 与本条同源的已有记忆 id（强化之）
}

interface WritebackRelationship {
  targetName: string; // 对方人格名或座位号描述
  relation: string;
  affinityDelta: number; // -100..100
  trustDelta: number; // -100..100
  note: string;
}

interface WritebackDrift {
  path: string;
  delta: number; // ±（被钳位到 ±DRIFT_MAX_DELTA）
  reason: string;
}

export interface WritebackSummary {
  memoriesAdded: number;
  memoriesReinforced: number;
  memoriesDecayed: boolean;
  relationshipsTouched: number;
  driftApplied: PersonaDriftChange[];
  text: string; // 事件流汇报用一句话
}

export function buildWritebackPrompt(opts: {
  card: PersonaCard;
  seat: number;
  roleName: string;
  outcome: string; // 如「狼人阵营胜利」「已死亡（第3天被放逐）」
  gameTitleNo: string; // 对局标题号（如 20260811001）：记忆引用对局时的统一编号
  digest: string; // 对局结构化摘要（buildLogDigest 产物）
  memories: PersonaMemory[];
  relationships: PersonaRelationship[];
  otherPersonas: string[]; // 本局其他人格名（关系传递的归并目标）
}): { system: string; user: string } {
  const { card, seat, roleName, outcome, gameTitleNo, digest, memories, relationships, otherPersonas } = opts;
  const system = [
    `你是「记事簿」——数字人类心理学实验场的记忆官。你负责把「${card.name}」刚刚经历的一局狼人杀写入 TA 的长期记忆。`,
    "铁律3「记忆持久化」：关系图谱、创伤事件、人格漂移跨对局保留；支持关系传递与记忆衰减/强化。",
    "你只输出结构化 JSON，禁止任何其他文字。",
    "写作视角：记忆内容一律用第一人称（TA 自己记得……），具体到人（座位号/人格名）与事（第几天、什么事件），禁止空泛感慨。",
  ].join("\n");

  const memList =
    memories.length > 0
      ? memories
          .slice(0, 12)
          .map((m) => `#${m.id} [${m.type}·强度${m.strength}] ${m.content.slice(0, 120)}`)
          .join("\n")
      : "（暂无长期记忆）";
  const relList =
    relationships.length > 0
      ? relationships
          .slice(0, 10)
          .map((r) => `对「${r.targetName}」：${r.relation}（亲疏${r.affinity}，信任${r.trust}）`)
          .join("\n")
      : "（暂无关系记录）";

  const user = [
    `【本局对局】标题号「${gameTitleNo}」`,
    `【本局身份】${seat}号 · ${roleName}；结局：${outcome}`,
    `【本局其他人格】${otherPersonas.length ? otherPersonas.join("、") : "（无）"}`,
    "",
    "【对局摘要】",
    digest,
    "",
    "【已有长期记忆】（reinforceMemoryId 引用这里的 id）",
    memList,
    "",
    "【已有关系图谱】",
    relList,
    "",
    "【人格参数卡（漂移参考）】大五/依恋/黑暗四/情绪调节/SDT 当前值见路径，如 bigFive.neuroticism=",
    JSON.stringify(card.params.bigFive),
    "",
    "【输出契约】严格输出 JSON：",
    `{"memories":[{"type":"trauma|relationship|general","content":"第一人称记忆（具体到人与事，≤120字）","emotionalWeight":0,"reinforceMemoryId":null}],"relationships":[{"targetName":"关系锚点（见规则3）","relation":"关系标签","affinityDelta":0,"trustDelta":0,"note":"关键事件一句"}],"drift":[{"path":"参数路径","delta":0,"reason":"漂移事由"}]}`,
    "规则：",
    "1. memories ≤4 条：只写真正塑造 TA 的事件（被背叛/被信任/濒死/翻盘/手刃……），type=trauma 留给真正的创伤；",
    "2. reinforceMemoryId：本条记忆与某条已有记忆同源（同一人物/同一主题）时填其 id——旧记忆会被强化而非重复；",
    "3. relationships ≤4 条：只写本局与 TA 产生真实交互的对象；affinity/trust 用增量（如被票出局 trustDelta=-30）。targetName 是关系的永久锚点，双轨制：",
    "   - 对象是人格玩家（【本局其他人格】之一）：targetName 必须精确等于 TA 的人格名（如「五条悟」）——人格跨对局存续，锚定点是人格本身，禁止带座位号（每局座位绑定会变）；",
    `   - 对象是无人格玩家：targetName 用「对局标题号·N号玩家」格式（本局如「${gameTitleNo}·10号玩家」）——无人格玩家每局都是不同的人，必须带对局编号才能区分；`,
    "4. drift ≤3 条：只有经历真正撼动人格时才漂移（如反复被背叛 → attachment.anxiety +8）；单参数幅度 ±12 内；",
    "5. 没有可写的内容就返回空数组——平庸的对局不产生记忆。",
    `6. 引用对局时一律使用标题号（本局为「${gameTitleNo}」，其他对局的标题号可从已有记忆中延续）——这是你与他人讨论对局的统一编号。`,
  ].join("\n");
  return { system, user };
}

// ---------- 回写输出解析（清洗+钳位） ----------
export function parseWriteback(text: string): {
  memories: WritebackMemory[];
  relationships: WritebackRelationship[];
  drift: WritebackDrift[];
} | null {
  const cleaned = text.replace(/```(?:json)?/gi, "");
  const start = cleaned.indexOf("{");
  if (start < 0) return null;
  const end = cleaned.lastIndexOf("}");
  const obj = parseJsonRobust(cleaned.slice(start, end > start ? end + 1 : undefined));
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;

  const clamp = (v: unknown, lo: number, hi: number, dflt = 0): number => {
    const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : dflt;
    return Math.max(lo, Math.min(hi, n));
  };
  const VALID_TYPES = new Set(["trauma", "relationship", "general"]);

  const memories: WritebackMemory[] = (Array.isArray(o.memories) ? o.memories : [])
    .map((x) => {
      const r = (x ?? {}) as Record<string, unknown>;
      const content = String(r.content ?? "").trim().slice(0, 150);
      if (!content) return null;
      return {
        type: VALID_TYPES.has(String(r.type)) ? (String(r.type) as WritebackMemory["type"]) : "general",
        content,
        emotionalWeight: clamp(r.emotionalWeight, 0, 100, 50),
        reinforceMemoryId:
          typeof r.reinforceMemoryId === "number" && Number.isInteger(r.reinforceMemoryId)
            ? r.reinforceMemoryId
            : null,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .slice(0, 4);

  const relationships: WritebackRelationship[] = (Array.isArray(o.relationships) ? o.relationships : [])
    .map((x) => {
      const r = (x ?? {}) as Record<string, unknown>;
      const targetName = String(r.targetName ?? "").trim().slice(0, 64);
      if (!targetName) return null;
      return {
        targetName,
        relation: String(r.relation ?? "").trim().slice(0, 32),
        affinityDelta: clamp(r.affinityDelta, -100, 100),
        trustDelta: clamp(r.trustDelta, -100, 100),
        note: String(r.note ?? "").trim().slice(0, 120),
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .slice(0, 4);

  const drift: WritebackDrift[] = (Array.isArray(o.drift) ? o.drift : [])
    .map((x) => {
      const r = (x ?? {}) as Record<string, unknown>;
      const path = String(r.path ?? "").trim();
      const delta = clamp(r.delta, -DRIFT_MAX_DELTA, DRIFT_MAX_DELTA);
      if (!path || delta === 0) return null;
      return { path, delta, reason: String(r.reason ?? "").trim().slice(0, 120) };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .slice(0, 3);

  return { memories, relationships, drift };
}

/** 关系锚点归一化（双轨制的纯函数实现，供单测锚定）：
 * - 人格玩家对象：锚点=人格名本身（座位号每局会变，绝不带）；
 * - 无人格玩家对象：锚点=「对局标题号·N号玩家」（每局同代号是不同的人，必须带对局编号区分）。
 * 模型不严格按格式写也能正确入库：先剥「」包裹与误贴的「标题号·」前缀再比对。 */
export function normalizeRelationAnchor(
  rawTargetName: string,
  otherPersonas: { name: string; personaId: number }[],
  gameTitleNo: string,
): { targetName: string; targetPersonaId: number | null } {
  // 已带「标题号·」前缀的锚点：内层是人格名则归一为人格锚点；否则原样保留历史对局锚点
  // （绝不把历史对局的代号重贴到本局标题号——那会把别人对局里的人记错账）
  const prefixed = rawTargetName.match(/^[「『"]?([0-9]{8,})·(.+?)[」』"]?$/);
  if (prefixed) {
    const inner = prefixed[2]!.trim();
    const matched = otherPersonas.find((p) => p.name === inner);
    if (matched) return { targetName: matched.name, targetPersonaId: matched.personaId };
    return { targetName: `${prefixed[1]}·${inner}`, targetPersonaId: null };
  }
  const bare = rawTargetName.replace(/^[「『"]+|[」』"]+$/g, "").trim();
  const matched = otherPersonas.find((p) => p.name === bare);
  if (matched) return { targetName: matched.name, targetPersonaId: matched.personaId };
  // 模型写成「3号玩家（五条悟）」这类代号+人格名混合形态：恰好提到一个人格名即归一到人格锚点
  const contained = otherPersonas.filter((p) => bare.includes(p.name));
  if (contained.length === 1) {
    return { targetName: contained[0]!.name, targetPersonaId: contained[0]!.personaId };
  }
  if (/^\d+号玩家$/.test(bare)) return { targetName: `${gameTitleNo}·${bare}`, targetPersonaId: null };
  return { targetName: bare, targetPersonaId: null };
}

/**
 * 执行记事簿回写：蒸馏 → 入库 → 强化/衰减 → 关系传递 → 漂移。
 * AI 失败/输出非法返回 null（调用方记事件，绝不影响对局收敛）。
 */
export async function runNotebookWriteback(opts: {
  cfg: SeatAiConfig;
  card: PersonaCard;
  seat: number;
  roleName: string;
  outcome: string;
  gameTitleNo: string;
  digest: string;
  gameId: string;
  otherPersonas: { name: string; personaId: number }[];
}): Promise<WritebackSummary | null> {
  const { cfg, card, gameId, otherPersonas } = opts;
  const [memories, relationships] = await Promise.all([
    listPersonaMemoriesInternal(card.id),
    listPersonaRelationshipsInternal(card.id),
  ]);
  const prompt = buildWritebackPrompt({
    card: opts.card,
    seat: opts.seat,
    roleName: opts.roleName,
    outcome: opts.outcome,
    gameTitleNo: opts.gameTitleNo,
    digest: opts.digest,
    memories,
    relationships,
    otherPersonas: otherPersonas.map((p) => p.name),
  });
  const res = await callAi(cfg, prompt.system, prompt.user, {
    timeoutMs: NOTEBOOK_TIMEOUT_MS,
    maxRetries: 1,
  });
  if (!res.ok || !res.text) return null;
  const parsed = parseWriteback(res.text);
  if (!parsed) return null;

  // 1. 新记忆入库（初始强度 = 30 + 情绪权重×0.5，10..100）
  const touched = new Set<number>();
  const reinforceIds = parsed.memories
    .map((m) => m.reinforceMemoryId)
    .filter((id): id is number => id !== null && memories.some((m) => m.id === id));
  const newRows = parsed.memories.map((m) => ({
    personaId: card.id,
    gameId,
    type: m.type,
    content: m.content,
    emotionalWeight: m.emotionalWeight,
    strength: Math.max(10, Math.min(100, Math.round(30 + m.emotionalWeight * 0.5))),
  }));
  const newIds = await insertPersonaMemories(newRows);
  newIds.forEach((id) => touched.add(id));
  reinforceIds.forEach((id) => touched.add(id));

  // 2. 强化同源旧记忆；3. 未被触及的记忆自然衰减
  if (reinforceIds.length > 0) await reinforcePersonaMemories(reinforceIds, REINFORCE_BOOST);
  await decayPersonaMemories(card.id, [...touched], DECAY_FACTOR);

  // 4. 关系传递（targetName 能匹配本局人格时建立卡间链接）
  let relTouched = 0;
  for (const r of parsed.relationships) {
    // 锚点归一化（双轨制代码兜底，模型不严格按格式写也能正确入库）
    const { targetName, targetPersonaId } = normalizeRelationAnchor(
      r.targetName,
      otherPersonas,
      opts.gameTitleNo,
    );
    await upsertPersonaRelationship({
      personaId: card.id,
      targetPersonaId,
      targetName,
      relation: r.relation,
      affinityDelta: r.affinityDelta,
      trustDelta: r.trustDelta,
      note: r.note,
      gameId,
    });
    relTouched++;
  }

  // 5. 人格漂移（from 取当前值，to 钳位后写卡 + 留痕）
  const driftChanges: PersonaDriftChange[] = [];
  for (const d of parsed.drift) {
    const from = getParamValue(card.params, d.path);
    if (from === null) continue;
    driftChanges.push({ path: d.path, from, to: from + d.delta, reason: d.reason });
  }
  if (driftChanges.length > 0) {
    await applyPersonaDrift(card.id, gameId, driftChanges, "记事簿回写");
  }

  return {
    memoriesAdded: newIds.length,
    memoriesReinforced: reinforceIds.length,
    memoriesDecayed: true,
    relationshipsTouched: relTouched,
    driftApplied: driftChanges,
    text: `记忆+${newIds.length}/强化${reinforceIds.length}/关系${relTouched}/漂移${driftChanges.length}`,
  };
}

// ---------- 内部读取（不校验归属；绑卡时已校验） ----------
import { getDb } from "../queries/connection";
import { personaMemories, personaRelationships } from "../../db/schema";
import { desc, eq } from "drizzle-orm";

async function listPersonaMemoriesInternal(personaId: number): Promise<PersonaMemory[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(personaMemories)
    .where(eq(personaMemories.personaId, personaId))
    .orderBy(desc(personaMemories.strength), desc(personaMemories.updatedAt));
  return rows.map((r: typeof personaMemories.$inferSelect) => ({
    id: r.id,
    personaId: r.personaId,
    gameId: r.gameId,
    type: r.type as PersonaMemory["type"],
    content: r.content,
    emotionalWeight: r.emotionalWeight,
    strength: r.strength,
    createdAt: (r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt)).toISOString(),
    updatedAt: (r.updatedAt instanceof Date ? r.updatedAt : new Date(r.updatedAt)).toISOString(),
  }));
}

async function listPersonaRelationshipsInternal(personaId: number): Promise<PersonaRelationship[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(personaRelationships)
    .where(eq(personaRelationships.personaId, personaId))
    .orderBy(desc(personaRelationships.updatedAt));
  return rows.map((r: typeof personaRelationships.$inferSelect) => ({
    id: r.id,
    personaId: r.personaId,
    targetPersonaId: r.targetPersonaId,
    targetName: r.targetName,
    relation: r.relation,
    affinity: r.affinity,
    trust: r.trust,
    note: r.note,
    gameId: r.gameId,
    updatedAt: (r.updatedAt instanceof Date ? r.updatedAt : new Date(r.updatedAt)).toISOString(),
  }));
}
