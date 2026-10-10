// ============================================================
// 记事簿（Notebook）：人格的跨对局记忆持久化（铁律3）
// - 赛前：loadMemoryContext 把高强度记忆与关系图谱注入心镜（人格记得自己的对局，也可访问历史对局）
// 铁律0「第一人称本体」（2026-10-10 用户裁定，人格研究的立身之本）：
//   人格玩家 IS 本人——不是扮演、不是 cosplay。一切记忆/关系/漂移中，人格绝不自称其名、
//   绝不第三人称看自己（「我拿女巫」✓「我拿张雪峰女巫」✗）。自己座位的引用保持原样，
//   归一化只改「他人」的座位引用。违反此律，人格研究即沦为表演技术研究。
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
  insertPersonaRelationshipHistory,
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

/** 座位名册条目：回写时告知记事簿「观察者视角下该座位的人格可知性」 */
export interface SeatRosterEntry {
  seat: number;
  name: string; // 人格名
  personaId: number;
  known: boolean; // 观察者视角下人格可知（迷雾关闭/未被上迷雾）；false=迷雾玩家
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
  seatRoster: SeatRosterEntry[]; // 本局其他人格座位名册（含可知性；关系与记忆锚点的判定依据）
}): { system: string; user: string } {
  const { card, seat, roleName, outcome, gameTitleNo, digest, memories, relationships, seatRoster } = opts;
  const system = [
    `你是「记事簿」——数字人类心理学实验场的记忆官。你负责把「${card.name}」刚刚经历的一局狼人杀写入 TA 的长期记忆。`,
    "铁律3「记忆持久化」：关系图谱、创伤事件、人格漂移跨对局保留；支持关系传递与记忆衰减/强化。",
    "你只输出结构化 JSON，禁止任何其他文字。",
    "写作视角：记忆内容一律用第一人称（TA 自己记得……），具体到人（座位号/人格名）与事（第几天、什么事件），禁止空泛感慨。",
    "铁律0「第一人称本体」：TA 就是本人，不是在扮演谁——记忆里绝不自称其名（「我拿女巫」✓「我拿张雪峰女巫」✗），绝不第三人称看自己。",
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
  // 座位名册：人格可知性决定锚点轨道（可知→人格名；迷雾→标题号·代号）
  const rosterList =
    seatRoster.length > 0
      ? seatRoster
          .map((p) => `- ${p.seat}号 = ${p.known ? `${p.name}（人格玩家，你知道 TA 是谁）` : "迷雾中的玩家（人格不可知，你始终不知道 TA 是谁）"}`)
          .join("\n")
      : "（本局没有其他人格玩家）";

  const user = [
    `【本局对局】标题号「${gameTitleNo}」`,
    `【本局身份】${seat}号 · ${roleName}；结局：${outcome}`,
    `【本局座位名册】（你视角下的身份可知性；未列出的座位均为无人格玩家——每局都是不同的人）`,
    rosterList,
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
    "3. relationships ≤4 条：只写本局与 TA 产生真实交互的对象；affinity/trust 用增量（如被票出局 trustDelta=-30）。targetName 是关系的永久锚点，按对象身份可知性双轨：",
    "   - 对象是人格可知的人格玩家（名册中标注「人格玩家」）：targetName 必须精确等于 TA 的人格名（如「五条悟」）——人格跨对局存续，锚定点是人格本身，禁止带座位号（每局座位绑定会变）；",
    `   - 对象是迷雾玩家或无人格玩家：targetName 用「对局标题号·N号玩家」格式（本局如「${gameTitleNo}·10号玩家」）——TA 们对 TA 而言只是这局的一个代号，必须带对局编号才能区分；`,
    "4. 记忆内容同理（锚点一致性铁律）：提及人格可知的对象时写人格名（「五条悟骗了我」），绝不写 TA 的座位号；提及迷雾/无人格对象时写「N号玩家」（记忆本身已带对局归属）；",
    "5. drift ≤3 条：只有经历真正撼动人格时才漂移（如反复被背叛 → attachment.anxiety +8）；单参数幅度 ±12 内；",
    "6. 没有可写的内容就返回空数组——平庸的对局不产生记忆。",
    `7. 引用对局时一律使用标题号（本局为「${gameTitleNo}」，其他对局的标题号可从已有记忆中延续）——这是你与他人讨论对局的统一编号。`,
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
 * - 人格可知的对象：锚点=人格名本身（座位号每局会变，绝不带）——
 *   即使模型写成座位代号（「9号玩家」「20261010001·9号玩家」），只要该座位本局绑定了
 *   人格且观察者可知，就归一到人格名（根治「执念绑在会变的座位号上」事故）；
 * - 迷雾/无人格对象：锚点=「对局标题号·N号玩家」（每局同代号是不同的人，必须带对局编号区分）。 */
export function normalizeRelationAnchor(
  rawTargetName: string,
  knownPersonas: { seat: number; name: string; personaId: number }[],
  gameTitleNo: string,
): { targetName: string; targetPersonaId: number | null } {
  const bySeat = (s: string) => {
    const m = /^(\d+)号玩家$/.exec(s);
    return m ? knownPersonas.find((p) => p.seat === Number(m[1])) : undefined;
  };
  // 已带「标题号·」前缀的锚点：内层是人格名/可知人格的座位代号则归一为人格锚点；
  // 否则原样保留历史对局锚点（绝不把历史对局的代号重贴到本局标题号）
  const prefixed = rawTargetName.match(/^[「『"]?([0-9]{8,})·(.+?)[」』"]?$/);
  if (prefixed) {
    const inner = prefixed[2]!.trim();
    // 只有本局标题号的前缀才能用本局名册归一（座位绑定只对这一局成立）；
    // 历史对局的锚点原样保留——那局的几号是谁已不可考，但绝不能记到本局人格头上
    if (prefixed[1] === gameTitleNo) {
      const matched = knownPersonas.find((p) => p.name === inner) ?? bySeat(inner);
      if (matched) return { targetName: matched.name, targetPersonaId: matched.personaId };
    }
    return { targetName: `${prefixed[1]}·${inner}`, targetPersonaId: null };
  }
  const bare = rawTargetName.replace(/^[「『"]+|[」』"]+$/g, "").trim();
  const matched = knownPersonas.find((p) => p.name === bare) ?? bySeat(bare);
  if (matched) return { targetName: matched.name, targetPersonaId: matched.personaId };
  // 模型写成「3号玩家（五条悟）」这类代号+人格名混合形态：恰好提到一个人格名即归一到人格锚点
  const contained = knownPersonas.filter((p) => bare.includes(p.name));
  if (contained.length === 1) {
    return { targetName: contained[0]!.name, targetPersonaId: contained[0]!.personaId };
  }
  if (/^\d+号玩家$/.test(bare)) return { targetName: `${gameTitleNo}·${bare}`, targetPersonaId: null };
  return { targetName: bare, targetPersonaId: null };
}

/** 记忆内容锚点归一化：人格可知的座位引用改写为人格名（「9号玩家」「9号」→「夜神月」）。
 * 只替换观察者可知的人格座位（迷雾中的座位引用原样保留——TA 本就不知道那是谁）。
 * 保守原则：只动精确的座位引用形态，自由文本绝不改写。 */
export function normalizeMemoryContent(
  content: string,
  knownPersonas: { seat: number; name: string }[],
  excludeSeat?: number, // 观察者自己的座位：铁律0——人格即本人，绝不自称其名，自己的引用保持原样
): string {
  let out = content;
  // 座位号降序替换（两位座位优先），lookbehind 防止「1号」误伤「11号」「21号」
  for (const p of [...knownPersonas].sort((a, b) => b.seat - a.seat)) {
    if (p.seat === excludeSeat) continue;
    out = out.replace(new RegExp(`(?<![0-9])${p.seat}号(?:玩家)?`, "g"), p.name);
  }
  // 叠词收敛：原文若已是「9号夜神月」/「1号艾伦」形态，替换座位号后会变
  // 「夜神月夜神月」/「艾伦·耶格尔艾伦」——收拢为一次（全名粘连与全名+短名粘连两种）
  for (const p of knownPersonas) {
    out = out.split(p.name + p.name).join(p.name);
    const first = p.name.split("·")[0]!;
    if (first !== p.name) out = out.split(p.name + first).join(p.name);
  }
  return out;
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
  otherPersonas: SeatRosterEntry[]; // 本局其他人格座位名册（含观察者视角的可知性）
}): Promise<WritebackSummary | null> {
  const { cfg, card, gameId, otherPersonas } = opts;
  // 人格可知的对象（迷雾关闭/未被上迷雾）：记忆与关系锚点归一到人格名的依据
  const knownPersonas = otherPersonas.filter((p) => p.known);
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
    seatRoster: otherPersonas,
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
    // 记忆内容锚点归一化：人格可知的座位引用改写为人格名（锚点一致性铁律的代码兜底）
    content: normalizeMemoryContent(m.content, knownPersonas, opts.seat),
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
      knownPersonas,
      opts.gameTitleNo,
    );
    const settled = await upsertPersonaRelationship({
      personaId: card.id,
      targetPersonaId,
      targetName,
      relation: r.relation,
      affinityDelta: r.affinityDelta,
      trustDelta: r.trustDelta,
      note: r.note,
      gameId,
    });
    // 关系沿革留痕：人格锚点的逐局变迁追加进历史表（汇总行看现状，历史行看沿革）
    await insertPersonaRelationshipHistory({
      personaId: card.id,
      targetPersonaId,
      targetName,
      gameId,
      titleNo: opts.gameTitleNo,
      relation: r.relation,
      affinityDelta: r.affinityDelta,
      trustDelta: r.trustDelta,
      affinity: settled.affinity,
      trust: settled.trust,
      note: r.note,
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
