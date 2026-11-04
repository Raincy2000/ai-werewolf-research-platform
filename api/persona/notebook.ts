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

import { ROLE_META, type SeatAiConfig } from "../../contracts/game";
import type {
  PersonaCard,
  PersonaDriftChange,
  PersonaMemory,
  PersonaRelationship,
} from "../../contracts/persona";
import {
  getParamValue,
  clampParam,
  driftLimitOf,
  DRIFT_BUDGET_PER_GAME,
  appraisalFactor,
  EVOLUTION_MECHANISM_VERSION,
  accumulateStep,
  evolveParam,
  formatDriftPanel,
} from "../../contracts/persona";
import { callAi } from "../game/ai/providers";
import { parseJsonRobust } from "../game/ai/parse";
import {
  decayPersonaMemories,
  applyPersonaDrift,
  saveParamsResidual,
  insertStateObservations,
  countSameDirectionObservations,
  insertTraitUpdates,
  type NewStateObservation,
  type NewTraitUpdate,
  insertPersonaMemories,
  reinforcePersonaMemories,
  beginPersonaWriteback,
  finishPersonaWriteback,
} from "../queries/personas";

const NOTEBOOK_TIMEOUT_MS = 240_000;
const DECAY_FACTOR = 0.85; // 每局未被触及的记忆强度 ×0.85
const REINFORCE_BOOST = 15; // 被再度唤起的记忆 +15（封顶 100）
// 单局单参数漂移上限改为「分层标定」（contracts/persona.ts DRIFT_LIMIT_BY_GROUP）：
// 特质层 ±2 / 依恋 ±1 / 适应层 ±3 / 状态层 ±6
// 依据 Roberts et al. (2017)（数周干预约 0.5 SD）与 Fraley et al. (2011)（依恋较大五更稳定）。

// ---------- 回写输出契约 ----------
interface WritebackMemory {
  type: "trauma" | "triumph" | "relationship" | "general";
  content: string;
  emotionalWeight: number; // 0-100 唤醒度（arousal）
  valence: number; // -100..100 效价（valence）：负=创伤/挫败，正=高光/成就（Russell 1980 情绪二维）
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
  /** 幂等跳过（本局该座位已成功回写过） */
  skipped?: boolean;
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
    "【人格参数卡（漂移参考）】以下为全部可漂移参数（path=当前值）；请优先选择与本局情境真正相关的维度，不要默认落在神经质/宜人性：",
    formatDriftPanel(card.params),
    "",
    "【输出契约】严格输出 JSON：",
    `{"memories":[{"type":"trauma|triumph|relationship|general","content":"第一人称记忆（具体到人与事，≤120字）","emotionalWeight":0,"valence":0,"reinforceMemoryId":null}],"relationships":[{"targetName":"关系锚点（见规则3）","relation":"关系标签","affinityDelta":0,"trustDelta":0,"note":"关键事件一句"}],"drift":[{"path":"参数路径","delta":0,"reason":"漂移事由"}]}`,
    "规则：",
    "1. memories ≤4 条：只写真正塑造 TA 的事件（被背叛/被信任/濒死/翻盘/手刃……）；type：trauma=创伤、triumph=高光/成就、general=其他。emotionalWeight=唤醒度(0-100)，valence=效价(-100..100)——情绪是二维的，两者都要给；高光同样值得被记住；",
    "2. reinforceMemoryId：本条记忆与某条已有记忆同源（同一人物/同一主题）时填其 id——旧记忆会被强化而非重复；",
    "3. relationships ≤4 条：只写本局与 TA 产生真实交互的对象；affinity/trust 用增量（如被票出局 trustDelta=-30）。targetName 是关系的永久锚点，按对象身份可知性双轨：",
    "   - 对象是人格可知的人格玩家（名册中标注「人格玩家」）：targetName 必须精确等于 TA 的人格名（如「五条悟」）——人格跨对局存续，锚定点是人格本身，禁止带座位号（每局座位绑定会变）；",
    `   - 对象是迷雾玩家或无人格玩家：targetName 用「对局标题号·N号玩家」格式（本局如「${gameTitleNo}·10号玩家」）——TA 们对 TA 而言只是这局的一个代号，必须带对局编号才能区分；`,
    "4. 记忆内容同理（锚点一致性铁律）：提及人格可知的对象时写人格名（「五条悟骗了我」），绝不写 TA 的座位号；提及迷雾/无人格对象时写「N号玩家」（记忆本身已带对局归属）；",
    "5. drift ≤3 条：只有经历真正撼动人格时才漂移，且必须同时评估两个方向：",
    "   · 创伤面（被背叛/被放逐/误判）→ 例：attachment.anxiety +1、bigFive.neuroticism +2；",
    "   · 成长面（识破/翻盘/救场/被信任）→ 例：sdt.competence +3、bigFive.agreeableness +2、attachment.anxiety -1；",
    "   ★ 创伤后成长（PTG）：同一次创伤可同时带来痛苦与成长（如 神经质 +2 且 宜人 +2 且 归属 +3）——都要写，绝不许互相抵消；",
    "   · 单参数幅度按层级上限：大五 ±2、依恋 ±1、黑暗四联/SDT ±3、情绪调节/防御/认知偏差 ±6；",
    `   · 全部 drift 的 |delta| 之和 ≤ ${DRIFT_BUDGET_PER_GAME}；`,
    "   · 优先选择本局情境真正相关的维度——不要默认落在神经质/宜人性；",
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
  const VALID_TYPES = new Set(["trauma", "triumph", "relationship", "general"]);

  const memories: WritebackMemory[] = (Array.isArray(o.memories) ? o.memories : [])
    .map((x) => {
      const r = (x ?? {}) as Record<string, unknown>;
      const content = String(r.content ?? "").trim().slice(0, 150);
      if (!content) return null;
      return {
        type: VALID_TYPES.has(String(r.type)) ? (String(r.type) as WritebackMemory["type"]) : "general",
        content,
        emotionalWeight: clamp(r.emotionalWeight, 0, 100, 50),
        valence: clamp(r.valence, -100, 100, 0),
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

  const rawDrift: WritebackDrift[] = (Array.isArray(o.drift) ? o.drift : [])
    .map((x) => {
      const r = (x ?? {}) as Record<string, unknown>;
      const path = String(r.path ?? "").trim();
      if (!path) return null;
      // 分层限幅：特质层 ±2 / 依恋 ±1 / 适应层 ±3 / 状态层 ±6
      const limit = driftLimitOf(path);
      const delta = clamp(r.delta, -limit, limit);
      if (delta === 0) return null;
      return { path, delta, reason: String(r.reason ?? "").trim().slice(0, 120) };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .slice(0, 3);

  // 单局漂移预算：Σ|delta| 超预算则等比缩放（保号；防止一局改写过多维度）
  const used = rawDrift.reduce((s, d) => s + Math.abs(d.delta), 0);
  const drift: WritebackDrift[] =
    used > DRIFT_BUDGET_PER_GAME
      ? rawDrift.map((d) => {
          const scaled = Math.trunc((d.delta * DRIFT_BUDGET_PER_GAME) / used);
          return { ...d, delta: scaled === 0 ? (d.delta > 0 ? 1 : -1) : scaled };
        })
      : rawDrift;

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
 * 保守原则：只动精确的座位引用形态，自由文本绝不改写。
 * 2026-10-22 修复：`标题号·N号玩家` 历史锚点绝不改写；只有当前局标题号前缀才归一。 */
export function normalizeMemoryContent(
  content: string,
  knownPersonas: { seat: number; name: string }[],
  excludeSeat?: number, // 观察者自己的座位：铁律0——人格即本人，绝不自称其名，自己的引用保持原样
  currentGameTitleNo?: string,
): string {
  const seatToName = new Map(
    knownPersonas.filter((p) => p.seat !== excludeSeat).map((p) => [p.seat, p.name] as const),
  );
  let out = content.replace(
    /(?<![0-9])(\d+)号(?:玩家)?/g,
    (match: string, numStr: string, offset: number, full: string) => {
      const name = seatToName.get(Number(numStr));
      if (!name) return match;
      const before = full.slice(Math.max(0, offset - 16), offset);
      const prefixed = /(\d{8,})·$/.exec(before);
      if (prefixed) {
        // 历史对局锚点：原样保留（那局的 N 号是谁不可考，绝不能记到本局人格头上）
        if (!currentGameTitleNo || prefixed[1] !== currentGameTitleNo) return match;
      }
      return name;
    },
  );
  // 叠词收敛：原文若已是「9号夜神月」/「1号艾伦」形态，替换座位号后会变
  // 「夜神月夜神月」/「艾伦·耶格尔艾伦」——收拢为一次（全名粘连与全名+短名粘连两种）
  for (const p of knownPersonas) {
    out = out.split(p.name + p.name).join(p.name);
    const first = p.name.split("·")[0]!;
    if (first !== p.name) out = out.split(p.name + first).join(p.name);
  }
  return out;
}

/** 关系定性文本 → 受控 kind 的保守映射（模型输出是自由中文，映射不上就 unspecified） */
export function mapRelationLabelToKind(label: string): string {
  const s = String(label || "");
  const rules: Array<[RegExp, string]> = [
    [/(宿敌|死敌|仇敌|敌手|对手)/, "nemesis"],
    [/(挚爱|恋人|爱人|所爱|挚爱之人)/, "beloved"],
    [/(生死之交|挚友|挚交|结义|兄弟)/, "sworn_friend"],
    [/(家人|亲人|血缘|兄妹|姐弟|父子|母女)/, "kin"],
    [/(师徒|师长|师父|老师|弟子)/, "mentor"],
    [/(上级|统领|君主|臣属|主从)/, "sovereign"],
    [/(同伴|战友|队友|同盟|并肩)/, "comrade"],
    [/(同侪|同辈|同窗|同学)/, "peer"],
    [/(亏欠|恩情|债|欠着)/, "creditor"],
    [/(亲手|了结|杀死|弑)/, "kin_slayer"],
    [/(竞争|较劲)/, "rival"],
  ];
  for (const [re, kind] of rules) if (re.test(s)) return kind;
  return "unspecified";
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
  // 2026-10-22：幂等守卫（persona_writeback_runs）——同一 (人格,对局,座位) 成功回写后重放/重试不再双计
  const shouldRun = await beginPersonaWriteback(card.id, gameId, opts.seat);
  if (!shouldRun) {
    return {
      memoriesAdded: 0,
      memoriesReinforced: 0,
      memoriesDecayed: false,
      relationshipsTouched: 0,
      driftApplied: [],
      skipped: true,
      text: "已回写（幂等跳过）",
    };
  }
  let runOk = false;
  let runError: string | null = null;
  try {
  // 人格可知的对象（迷雾关闭/未被上迷雾）：记忆与关系锚点归一到人格名的依据
  const knownPersonas = otherPersonas.filter((p) => p.known);
  const memories = await listPersonaMemoriesInternal(card.id);
  const prompt = buildWritebackPrompt({
    card: opts.card,
    seat: opts.seat,
    roleName: opts.roleName,
    outcome: opts.outcome,
    gameTitleNo: opts.gameTitleNo,
    digest: opts.digest,
    memories,
    relationships: [],
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
  // 情境签名（编码特异性）：记录本局阵营，供**下一局**在相似处境下优先唤起
  // （Tulving & Thomson 1973：提取线索须与编码情境重合）
  const campHit = Object.values(ROLE_META).find((meta) => meta.name === opts.roleName);
  const situationSignature = `game:${campHit?.camp ?? "good"}`;
  const newRows = parsed.memories.map((m) => ({
    personaId: card.id,
    gameId,
    situationSignature,
    type: m.type,
    // 记忆内容锚点归一化：人格可知的座位引用改写为人格名（锚点一致性铁律的代码兜底）
    content: normalizeMemoryContent(m.content, knownPersonas, opts.seat, opts.gameTitleNo),
    emotionalWeight: m.emotionalWeight,
    valence: m.valence,
    // 强度 = 唤醒度 + |效价|：高光与创伤同样持久（Russell 1980 情绪二维）
    strength: Math.max(
      10,
      clampParam(30 + m.emotionalWeight * 0.4 + Math.abs(m.valence) * 0.2),
    ),
  }));
  const newIds = await insertPersonaMemories(newRows);
  newIds.forEach((id) => touched.add(id));
  reinforceIds.forEach((id) => touched.add(id));

  // 2. 强化同源旧记忆；3. 未被触及的记忆自然衰减
  if (reinforceIds.length > 0) await reinforcePersonaMemories(reinforceIds, REINFORCE_BOOST);
  await decayPersonaMemories(card.id, [...touched], DECAY_FACTOR);

  // 5. 人格漂移（v3 · EWMA）：trait ← trait + α_eff × (state − trait)
  //    语义：LLM 给的 delta = 本局表现相对**自身特质**的偏离量（不是「特质该改变多少」）
  //    α_eff 的评价调节按**该人格自己**的调节装置取值（Bucciol 2024），不借用外部目标值
  const residual: Record<string, number> = { ...((card.paramsResidual ?? {}) as Record<string, number>) };
  const defenses = card.params.defenseMechanisms;
  const appraisal = appraisalFactor({
    cognitiveReappraisal: card.params.emotionRegulation.cognitiveReappraisal,
    rumination: card.params.emotionRegulation.rumination,
    defenseMaturity: defenses.length
      ? defenses.filter((x) => x.maturity === "mature").length / defenses.length
      : 0.5,
  });
  const scenarioIndex = card.gameCount ?? 1;
  // 情境类 = 情境签名（game:<阵营>）：φ 的「同情境」判据（Tulving & Thomson 1973）
  const situationClassId = situationSignature;
  const driftChanges: PersonaDriftChange[] = [];
  const newObservations: NewStateObservation[] = [];
  const pendingUpdates: Array<Omit<NewTraitUpdate, "observationIds"> & { pathKey: string }> = [];
  for (const d of parsed.drift) {
    const from = getParamValue(card.params, d.path);
    if (from === null) continue;
    const state = clampParam(from + d.delta); // 本局表现水平
    const direction: "up" | "down" = state >= from ? "up" : "down";
    // φ 的输入：同情境·同向的历史观测次数（本次为第 prior+1 次）
    // 统计失败**不阻塞对局**：退化为「首次经历」
    let prior = 0;
    try {
      prior = await countSameDirectionObservations(card.id, situationClassId, d.path, direction);
    } catch {
      prior = 0;
    }
    const { delta, alphaEff, factors } = evolveParam(from, state, d.path, {
      repeatCount: prior + 1,
      appraisal,
    });
    const salience = Math.round(factors.salience * 100);
    // 观测**每次都写**：φ 靠观测累积（幂等由唯一索引 idx_pso_dedup 保证，重复回写不虚增）
    newObservations.push({
      personaId: card.id,
      scenarioId: gameId,
      scenarioKind: "game",
      scenarioIndex,
      cumulativeSalience: 0,
      traitPath: d.path,
      stateValue: state,
      direction,
      situationClassId,
      situationSignature: situationClassId,
      salience,
      sourceParam: d.path,
    });
    // 小数累积器：|累积| ≥ 1 才落整数位移，余数留存到下一局
    // —— 这正是「反复小经历累积」的实现（Dugan 2023）；否则单局 <0.5 分会被取整归零
    const { step, residual: rest } = accumulateStep(residual[d.path] ?? 0, delta);
    residual[d.path] = rest; // 严格有界 [-1, 1]
    if (step === 0) continue;
    const to = clampParam(from + step);
    if (to === from) continue; // 阻尼/钳位后无净变化则不落痕
    driftChanges.push({ path: d.path, from, to, reason: d.reason });
    pendingUpdates.push({
      personaId: card.id,
      scenarioId: gameId,
      traitPath: d.path,
      valueFrom: from,
      valueTo: to,
      alphaEff,
      factorsJson: factors,
      mechanismVersion: EVOLUTION_MECHANISM_VERSION,
      pathKey: d.path,
    });
  }
  // 审计链写入（铁律7）：累积器 → 观测 → 台账。任一失败都**不阻塞对局**
  try {
    await saveParamsResidual(card.id, residual);
  } catch { /* 累积器失败仅丢一局的小数残留，不阻塞 */ }
  let observationIds: number[] = [];
  try {
    observationIds = await insertStateObservations(newObservations);
  } catch { /* 观测失败仅影响 φ 统计，不阻塞 */ }
  if (driftChanges.length > 0) {
    await applyPersonaDrift(card.id, gameId, driftChanges, "记事簿回写");
    try {
      const idByPath = new Map<string, number[]>();
      newObservations.forEach((o, i) => {
        const arr = idByPath.get(o.traitPath) ?? [];
        const id = observationIds[i];
        if (id) arr.push(id);
        idByPath.set(o.traitPath, arr);
      });
      await insertTraitUpdates(
        pendingUpdates.map(({ pathKey, ...rest }) => ({
          ...rest,
          observationIds: idByPath.get(pathKey) ?? [],
        })),
      );
    } catch { /* 台账失败不影响已生效的漂移 */ }
  }

  runOk = true;
  return {
    memoriesAdded: newIds.length,
    memoriesReinforced: reinforceIds.length,
    memoriesDecayed: true,
    relationshipsTouched: 0,
    driftApplied: driftChanges,
    text: `记忆+${newIds.length}/强化${reinforceIds.length}/关系0/漂移${driftChanges.length}`,
  };
  } catch (e) {
    runError = e instanceof Error ? e.message : String(e);
    throw e;
  } finally {
    // 成功才置 done；AI 失败/异常置 failed，允许下次 startPsyCheck 重试
    try {
      await finishPersonaWriteback(card.id, gameId, opts.seat, runOk ? "done" : "failed", runError);
    } catch { /* 台账失败不掩盖主流程 */ }
  }
}

// ---------- 内部读取（不校验归属；绑卡时已校验） ----------
import { getDb } from "../queries/connection";
import { personaMemories } from "../../db/schema";
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
