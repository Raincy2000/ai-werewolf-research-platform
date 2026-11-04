// ============================================================
// 心镜 → 涌现 双程管线（铁律2「参数溢出」与铁律6「真情生于撕裂」的对局执行层）
//
// 设计：
// - 心镜（mirror）：只输出「人格状态报告」JSON（被点燃的参数/当前撕裂/防御/创伤/冲动），
//   绝不生成台词；每一项心理活动必须挂在具体参数上（参数溢出），否则输出非法。
// - 涌现层（emergence）：接收完整状态报告 + 对局情境，在参数约束下自由生长台词与决策；
//   涌现输出禁止心理学术语；发言可带（括号举止）供其他玩家感知交互。
// - 双视角（铁律4）：涌现同时输出该动作的博弈论解释（gt）与人格动力学解释（psy），
//   随 event.meta.persona 落盘供观察者双栏查看。
// - 双/单程自适应（用户决策）：模型上下文 ≥32K 走双程；小上下文模型自动合并为单程，
//   同一 JSON 内含 mirror 段与决策字段，保住铁律2校验不降级。
// ============================================================

import type { DecisionInput, PendingDecision } from "../game/engine/api";
import type {
  MirrorBond,
  MirrorReport,
  PersonaCard,
  PersonaEventMeta,
  TensionGroup,
} from "../../contracts/persona";
import { callAi } from "../game/ai/providers";
import { defaultCallTimeoutMs } from "../game/ai/modelCaps";
import { parseJsonRobust } from "../game/ai/parse";
import { parseDecision } from "../game/ai/parse";
import {
  describePrivateInfo,
  formatPublicLog,
  PHASE_LABEL,
  KIND_GUIDE,
  promptCharBudget,
  type AssembledPrompt,
} from "../game/ai/prompts";
import type { SeatAiConfig } from "../../contracts/game";
import { buildPersonaContext, degradePersonaContext } from "./context";
import { buildBehaviorBridge } from "./behavior-bridge";
import {
  buildFidelityRetryNote,
  duplicateExactText,
  inspectPersonaText,
  mergePersonaTextOnly,
  sharedStylePhrases,
} from "./fidelity";

// ---------- 双/单程判定（模型上下文 token 阈值；小上下文合并为单程保预算） ----------
export const DUAL_PIPELINE_MIN_CONTEXT = 32_768;
export function shouldUseDualPipeline(modelContextTokens: number): boolean {
  return modelContextTokens >= DUAL_PIPELINE_MIN_CONTEXT;
}

// ---------- 参数路径 → 中文标签（含当前值），心镜报告与展示共用 ----------
const PARAM_NAME_LABEL: Record<string, string> = {
  "bigFive.openness": "开放性",
  "bigFive.conscientiousness": "尽责性",
  "bigFive.extraversion": "外向性",
  "bigFive.agreeableness": "宜人性",
  "bigFive.neuroticism": "神经质",
  "attachment.anxiety": "依恋焦虑",
  "attachment.avoidance": "依恋回避",
  "darkTetrad.machiavellianism": "马基雅维利",
  "darkTetrad.narcissism": "自恋",
  "darkTetrad.psychopathy": "精神病态",
  "darkTetrad.sadism": "施虐",
  "emotionRegulation.cognitiveReappraisal": "认知重评",
  "emotionRegulation.expressiveSuppression": "表达抑制",
  "emotionRegulation.rumination": "反刍倾向",
  "sdt.autonomy": "自主需要",
  "sdt.competence": "胜任需要",
  "sdt.relatedness": "归属需要",
};

/** 参数路径当前值（查不到返回 null） */
export function paramValueOf(card: PersonaCard, path: string): number | null {
  const [group, key] = path.split(".");
  const p = card.params;
  const pick = (obj: unknown): number | null =>
    (obj as Record<string, number>)[key] ?? null;
  switch (group) {
    case "bigFive":
      return pick(p.bigFive);
    case "attachment":
      return pick(p.attachment);
    case "darkTetrad":
      return pick(p.darkTetrad);
    case "emotionRegulation":
      return pick(p.emotionRegulation);
    case "sdt":
      return pick(p.sdt);
    case "cognitiveBiases":
      return p.cognitiveBiases.find((b) => b.id === key || b.label === key)?.strength ?? null;
    case "defenseMechanisms":
      return p.defenseMechanisms.find((d) => d.id === key || d.label === key)?.tendency ?? null;
    default:
      return null;
  }
}

/** 参数路径 → 「中文名 值」展示标签（如 "神经质 80"） */
export function paramLabel(card: PersonaCard, path: string): string {
  const value = paramValueOf(card, path);
  const name =
    PARAM_NAME_LABEL[path] ??
    (path.startsWith("cognitiveBiases.") || path.startsWith("defenseMechanisms.")
      ? path.split(".").slice(1).join(".")
      : path);
  return value != null ? `${name} ${value}` : name;
}

// ============================================================
// 心镜：人格状态报告
// ============================================================

/** M2.6 开关：是否**常驻注入**自我认知笔记（essence）。
 *  · false（默认）= v3 行为：笔记降级为「记性」中的一条 self_narrative，仅相关情境被检索；
 *  · true          = 旧行为，用于与锁定的改造前基线做 A/B 对照（A14/A15）。
 *  ⚠️ 常驻自我描述会诱发「复述自我」与表演（设计文档 §4.10.6）。 */
export const INJECT_STATIC_SELF_NOTE = process.env.WW_STATIC_SELF_NOTE === "1";

function paramsDigest(card: PersonaCard): string {
  const p = card.params;
  const line = (label: string, entries: [string, number][]) =>
    `${label}：${entries.map(([k, v]) => `${PARAM_NAME_LABEL[k] ?? k} ${v}`).join("，")}`;
  const biases = p.cognitiveBiases.map((b) => `${b.label} ${b.strength}`).join("，") || "无";
  const defenses = p.defenseMechanisms
    .map((d) => `${d.label} ${d.tendency}（${d.maturity}）`)
    .join("，") || "无";
  return [
    line("大五", Object.entries(p.bigFive).map(([k, v]) => [`bigFive.${k}`, v]) as [string, number][]),
    `依恋：焦虑 ${p.attachment.anxiety}，回避 ${p.attachment.avoidance}`,
    `黑暗四：${(["machiavellianism", "narcissism", "psychopathy", "sadism"] as const)
      .map((k) => `${PARAM_NAME_LABEL[`darkTetrad.${k}`]} ${p.darkTetrad[k]}`)
      .join("，")}`,
    `情绪调节：认知重评 ${p.emotionRegulation.cognitiveReappraisal}，表达抑制 ${p.emotionRegulation.expressiveSuppression}，反刍 ${p.emotionRegulation.rumination}`,
    `SDT：自主 ${p.sdt.autonomy}，胜任 ${p.sdt.competence}，归属 ${p.sdt.relatedness}`,
    `认知偏差：${biases}`,
    `防御机制：${defenses}`,
  ].join("\n");
}

function profileDigest(card: PersonaCard): string {
  const ctx = buildPersonaContext(card, null);
  const latentInner = card.profile.innerWorld?.trim()
    ? `【潜在内心冲突（只影响反应，不得自述）】${card.profile.innerWorld.trim()}`
    : "";
  return [ctx.conscious, ctx.voice, latentInner].filter(Boolean).join("\n") || "（无档案）";
}

function situationDigest(pending: PendingDecision, logLimit: number): string {
  const view = pending.view;
  const lines = [
    `第${view.day}天 · ${PHASE_LABEL[view.phase] ?? view.phase}`,
    `存活：${view.aliveSeats.map((s) => `${s}号`).join("、")}；已死亡：${view.deadSeats.map((s) => `${s}号`).join("、") || "无"}`,
    `最近公开记录：`,
    formatPublicLog(view.publicLog.slice(-10), logLimit),
    `你的私密信息：`,
    describePrivateInfo(view),
    `当前任务：${pending.hint}`,
    KIND_GUIDE[pending.kind] ? `环节说明：${KIND_GUIDE[pending.kind].slice(0, 200)}` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

export function buildMirrorPrompt(
  card: PersonaCard,
  memoryText: string | null,
  pending: PendingDecision,
  relationDigest?: string | null,
): AssembledPrompt {
  const system = [
    `你是「心镜」——「${card.name}」的人格内核。你只输出「人格状态报告」，绝不说台词、绝不描述任何行动或发言。`,
    "你的职责：读入人格参数卡、跨对局记忆与当前情境，报告此刻哪些参数被点燃、哪些参数在互相拉扯、哪些防御机制被触发、是否有创伤记忆被唤醒。",
    "背景：TA 身处米勒山谷的一场狼人杀游戏——只是游戏，出局≠死亡；但在意输赢、在意他人眼光，是 TA 的本性。",
    "铁律：",
    "1. 参数溢出——每一项心理活动必须挂在具体参数上（给出参数路径与当前值），禁止无根表演；",
    "2. 真情生于撕裂——禁止二选一：相互冲突的参数必须同时列出、分别写明各自的诉求，并给出拉扯强度；",
    "3. 严格只输出 JSON 本体。",
  ].join("\n");
  const user = [
    "【人格参数卡】",
    paramsDigest(card),
    "",
    "【人物档案摘要】",
    profileDigest(card),
    "",
    "【你记得的】（你亲身经历过的对局与人——只想得起这些）",
    memoryText?.trim() ? memoryText : "（这是 TA 的第一局：尚无跨对局记忆）",
    "",
    relationDigest?.trim() ? "【你与在场者的旧账（你自己的分量，不是规则）】" : "",
    relationDigest?.trim() ? relationDigest.trim() : "",
    "",
    "【当前情境】",
    situationDigest(pending, 900),
    "",
    "【输出契约】严格输出 JSON：",
    '{"pressures":[{"param":"参数路径","value":0,"reason":"触发事由一句"}],"tensions":[{"poles":[{"param":"参数A","urge":"这一极想要什么（一句）"},{"param":"参数B","urge":"另一极想要什么"}],"intensity":0.0}],"defenses":[{"mechanism":"防御机制名","toward":"防御指向"}],"trauma":"被唤醒的创伤记忆或null","impulse":"此刻最想做的事（一句）","selfControl":0,"bonds":[{"toward":"某个在场者的名字","feel":"此刻对TA的真实感受（大白话，禁止术语）","urge":"由此想对TA做什么/不做什么"}]}',
    "硬性要求：pressures≥1 或 tensions≥1（无参数触发=无根表演，输出非法）；tensions 可多达 3 组；intensity 取 0-1；selfControl 取 0-100（越低越失控）。**bonds：只对【你与在场者的旧账】/当前情境中出现的在场者写，toward 写对方人格名或座位号（禁止写不在场/不认识的人）；没有就不写；禁止空话套话，要有具体所指。**",
  ].filter((x, i, arr) => !(x === "" && arr[i - 1] === "")).join("\n");
  return { system, user };
}

/** 从心镜输出文本解析人格状态报告；铁律2 校验：无触发参数（pressures 与 tensions 皆空）→ null */
export function parseMirrorReport(text: string): MirrorReport | null {
  const cleaned = text.replace(/```(?:json)?/gi, "");
  const start = cleaned.indexOf("{");
  if (start < 0) return null;
  const end = cleaned.lastIndexOf("}");
  const obj = parseJsonRobust(cleaned.slice(start, end > start ? end + 1 : undefined));
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;

  const pressures = (Array.isArray(o.pressures) ? o.pressures : [])
    .map((x) => {
      const r = (x ?? {}) as Record<string, unknown>;
      const param = String(r.param ?? "").trim();
      if (!param) return null;
      const value =
        typeof r.value === "number" && Number.isFinite(r.value)
          ? Math.max(0, Math.min(100, Math.round(r.value)))
          : 50;
      return { param, value, reason: String(r.reason ?? "").trim().slice(0, 120) };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .slice(0, 6);

  const tensions: TensionGroup[] = (Array.isArray(o.tensions) ? o.tensions : [])
    .map((x) => {
      const r = (x ?? {}) as Record<string, unknown>;
      const poles = (Array.isArray(r.poles) ? r.poles : [])
        .map((pl) => {
          const q = (pl ?? {}) as Record<string, unknown>;
          const param = String(q.param ?? "").trim();
          if (!param) return null;
          return { param, urge: String(q.urge ?? "").trim().slice(0, 120) };
        })
        .filter((q): q is NonNullable<typeof q> => q !== null)
        .slice(0, 4);
      if (poles.length < 2) return null;
      let intensity = typeof r.intensity === "number" && Number.isFinite(r.intensity) ? r.intensity : 0.5;
      if (intensity > 1) intensity = intensity / 100; // 容忍 0-100 形态
      return { poles, intensity: Math.max(0, Math.min(1, intensity)) };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .slice(0, 3);

  // 铁律2：无根表演判非法（无被点燃的参数、也无任何撕裂 → 不成立的心理活动）
  if (pressures.length === 0 && tensions.length === 0) return null;

  const defenses = (Array.isArray(o.defenses) ? o.defenses : [])
    .map((x) => {
      const r = (x ?? {}) as Record<string, unknown>;
      const mechanism = String(r.mechanism ?? "").trim();
      if (!mechanism) return null;
      return { mechanism: mechanism.slice(0, 32), toward: String(r.toward ?? "").trim().slice(0, 120) };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .slice(0, 3);

  let selfControl =
    typeof o.selfControl === "number" && Number.isFinite(o.selfControl) ? Math.round(o.selfControl) : 50;
  selfControl = Math.max(0, Math.min(100, selfControl));

  const trauma = typeof o.trauma === "string" && o.trauma.trim() ? o.trauma.trim().slice(0, 200) : null;
  const impulse = String(o.impulse ?? "").trim().slice(0, 120) || "（心镜未给出冲动）";

  // §24 第 4 层断裂修复：解析「对人」条目
  const bonds: MirrorBond[] = (Array.isArray(o.bonds) ? o.bonds : [])
    .map((x) => {
      const r = (x ?? {}) as Record<string, unknown>;
      const toward = String(r.toward ?? "").trim();
      const feel = String(r.feel ?? "").trim().slice(0, 160);
      const urge = String(r.urge ?? "").trim().slice(0, 160);
      if (!toward || (!feel && !urge)) return null;
      return { toward: toward.slice(0, 32), feel, urge };
    })
    .filter((x): x is MirrorBond => x !== null)
    .slice(0, 8);

  return { pressures, tensions, defenses, trauma, impulse, selfControl, bonds };
}

/** 心镜 AI 失败时的确定性兜底：由参数卡直接推导状态报告（铁律2 不降级——触发参数来自卡本身） */
export function mirrorFallbackReport(card: PersonaCard, pending: PendingDecision): MirrorReport {
  const p = card.params;
  // 极端值即最易被点燃的参数：取 |值-50| 最大的两个固定维度
  const flat: { param: string; value: number }[] = [
    { param: "bigFive.openness", value: p.bigFive.openness },
    { param: "bigFive.conscientiousness", value: p.bigFive.conscientiousness },
    { param: "bigFive.extraversion", value: p.bigFive.extraversion },
    { param: "bigFive.agreeableness", value: p.bigFive.agreeableness },
    { param: "bigFive.neuroticism", value: p.bigFive.neuroticism },
    { param: "attachment.anxiety", value: p.attachment.anxiety },
    { param: "attachment.avoidance", value: p.attachment.avoidance },
    { param: "darkTetrad.machiavellianism", value: p.darkTetrad.machiavellianism },
    { param: "darkTetrad.narcissism", value: p.darkTetrad.narcissism },
    { param: "darkTetrad.psychopathy", value: p.darkTetrad.psychopathy },
    { param: "emotionRegulation.rumination", value: p.emotionRegulation.rumination },
  ];
  flat.sort((a, b) => Math.abs(b.value - 50) - Math.abs(a.value - 50));
  const top = flat.slice(0, 2);
  const phaseLabel = PHASE_LABEL[pending.view.phase] ?? pending.view.phase;
  const pressures = top.map((t) => ({
    param: t.param,
    value: t.value,
    reason: `${phaseLabel}的压力将其点燃（心镜暂由参数直推）`,
  }));
  // 天然撕裂组：宜人性 ⇄ 最强黑暗面；若依恋双轴皆高则补一组焦虑⇄回避
  const dark = (
    [
      ["darkTetrad.machiavellianism", p.darkTetrad.machiavellianism],
      ["darkTetrad.narcissism", p.darkTetrad.narcissism],
      ["darkTetrad.psychopathy", p.darkTetrad.psychopathy],
      ["darkTetrad.sadism", p.darkTetrad.sadism],
    ] as [string, number][]
  ).sort((a, b) => b[1] - a[1])[0];
  const tensions: TensionGroup[] = [
    {
      poles: [
        { param: "bigFive.agreeableness", urge: "想相信他人、维持表面和谐" },
        { param: dark[0], urge: "想利用局面为自己牟利" },
      ],
      intensity: Math.min(1, (Math.abs(p.bigFive.agreeableness - dark[1]) + 30) / 130),
    },
  ];
  if (p.attachment.anxiety >= 50 && p.attachment.avoidance >= 50) {
    tensions.push({
      poles: [
        { param: "attachment.anxiety", urge: "怕被孤立背叛，想抓住盟友" },
        { param: "attachment.avoidance", urge: "怕被看穿束缚，想抽身独处" },
      ],
      intensity: Math.min(1, (p.attachment.anxiety + p.attachment.avoidance) / 200),
    });
  }
  return {
    bonds: [], // 兜底报告不含对人条目（关系由涌现层从 relationDigest 获取）
    pressures,
    tensions: tensions.slice(0, 3),
    defenses: [],
    trauma: null,
    impulse: "在表态与隐藏之间先观望一步",
    selfControl: 50,
  };
}

// ============================================================
// 涌现层：在状态报告约束下生长台词与决策
// ============================================================

const PERSONA_ACTION_FIELDS = `"targets":[座位号],"skip":false,"selfDestruct":false,"duel":null,"witchSave":false`;
const PERSONA_SPEECH_FIELD = `"speech":"公开发言（发言类必填：正文600字内长短自由（可极短），逻辑要完整说完；（括号）夹带的动作/神态/语气描写不计入字数，动作尽管写；非发言类留空串）"`;
const PERSONA_THOUGHT_FIELDS = `"thought":"涌现输出：你此刻最真实的反应（200字内，禁止任何心理学术语，像活人内心独白）","bodyTrace":"身体痕迹：此刻的副语言（姿态/表情/声音变化，一句）","analysisGt":"这一步的博弈论解释（一句，≤80字）","analysisPsy":"这一步的人格动力学解释（一句，≤80字，这里允许术语）"`;
const SPEECH_FIRST_KINDS = new Set(["sheriffSpeech", "daySpeech", "pkSpeech", "lastWords", "postgameSpeak", "wolfDiscuss"]);

/** 行动字段先于长心理文本生成，降低服务端截断后只剩 thought 的风险。 */
function personaOutputContract(pending?: PendingDecision): string {
  const leading = pending && SPEECH_FIRST_KINDS.has(pending.kind)
    ? `${PERSONA_SPEECH_FIELD},${PERSONA_ACTION_FIELDS}`
    : `${PERSONA_ACTION_FIELDS},${PERSONA_SPEECH_FIELD}`;
  return `{${leading},${PERSONA_THOUGHT_FIELDS}}`;
}

function personaSystemBlock(card: PersonaCard, memoryText: string | null = null, personaCharCap = 0): string {
  const pr = card.profile;
  const ctx = degradePersonaContext(buildPersonaContext(card, memoryText), personaCharCap);
  const origin =
    card.source === "manual"
      ? "你是米勒山谷村庄小镇土生土长的原住民，小镇今晚要开一局狼人杀游戏。"
      : pr.aliveStatus === "deceased"
        ? "你在原世界即将走到生命的最后一刻——那一刻的你分出了一道分身，来到米勒山谷的村庄小镇，被卷入一场狼人杀游戏。你就是TA，TA也就是你：你有TA的全部记忆与性情。"
        : "此刻的你，是从原世界那个正好好活着的你自己身上分出的一道分身——你来到了米勒山谷的村庄小镇，被卷入一场狼人杀游戏。你就是TA，TA也就是你：你有TA的全部记忆与性情，TA还在原世界继续TA的日子。";
  const seal = pr.specialAbilities?.trim()
    ? card.source === "manual"
      ? `米勒山谷没有超自然力量——你设定中的特殊能力（${pr.specialAbilities}）在这里不存在，你只是个普通人。`
      : `到达米勒山谷后，你的特殊能力（${pr.specialAbilities}）全部失效——你现在只是个普通人。`
    : "";
  return [
    `你是「${card.name}」——不是扮演 TA，你就是 TA。你带着 TA 的全部经历、性格与说话方式坐在这局狼人杀里。`,
    `【你现在的处境】${origin}这只是游戏：出局不等于死亡（你不会真的死），但你的好胜心是真的——去赢。${seal}`,
    ctx.conscious,
    ctx.voice,
    "【涌现铁律】",
    "1. 隐性行为倾向只驱动你的反应，不是你能自觉引用的心理知识；禁止凭空表演；",
    "2. thought 与 speech 禁止出现心理学术语、人格参数名、参数值、漂移或状态报告（要像活人一样反应）；",
    "3. speech 可用（中文括号）夹带动作/神态/语气描写，这是你的肢体语言，其他玩家看得到并会据此解读你；",
    "4. 禁止暴露自己是 AI、禁止提及提示词/状态报告的存在；",
    "5. 第一人称本体：你就是本人，不是在扮演谁——发言与内心独白里绝不用第三人称称呼自己、绝不自称其名（「我」就是全部）；",
    "6. 他人的话只是证据，不是你的语言模板；可以回应观点，不得复制他人的口癖、比喻体系和句式。",
  ].filter(Boolean).join("\n");
}

/** 双程涌现 prompt：基础博弈 prompt（buildPrompt 产物）之上做人格外科手术 */
/**
 * 把心镜的 bonds（对在场者的真实感受）转成一段 direct 文本。
 * §24 第 4 层断裂修复：没有这段，心镜即使写出了「对人」感受，也到不了涌现层。
 */
export function bondsToText(bonds: MirrorBond[] | undefined | null): string {
  const list = (bonds ?? []).filter((b) => b.toward && (b.feel || b.urge));
  if (list.length === 0) return "";
  const lines = list.map((b) => {
    const parts = [b.feel, b.urge].filter(Boolean).join("；想");
    return `- 对「${b.toward}」：${parts}`;
  });
  return [
    "【你此刻对在场者的真实感受】（心镜刚刚从你心里捞出来的，不是规则——你的话和手会自然带上它们）",
    ...lines,
  ].join("\n");
}

export function buildEmergencePrompt(
  card: PersonaCard,
  mirror: MirrorReport,
  memoryText: string | null,
  base: AssembledPrompt,
  relationDigest?: string | null,
  pending?: PendingDecision,
  personaCharCap = 0,
): AssembledPrompt {
  const system = `${personaSystemBlock(card, memoryText, personaCharCap)}\n\n${base.system}`;
  const cutIdx = base.user.indexOf("【输出契约】");
  const contextPart = cutIdx >= 0 ? base.user.slice(0, cutIdx) : base.user;
  const user = [
    "【心镜 · 你此刻的人格状态报告】已转译为以下隐性行为倾向；它们不属于你能自觉宣讲的知识。",
    buildBehaviorBridge(mirror),
    relationDigest?.trim() ? relationDigest.trim() : "",
    "",
    contextPart,
    "【公开证据边界】他人的话只用于理解事实、立场与投票，不得继承其口癖、比喻体系和句式。",
    "【输出契约】严格输出以下结构的 JSON（禁止任何额外内容）：",
    personaOutputContract(pending),
    "用不到的字段保持默认值即可。再次强调：只输出 JSON 本体；thought/speech 里禁止心理学术语。",
  ].join("\n");
  return { system, user };
}

/** 单程合并 prompt（小上下文模型）：心镜指令内联，同一 JSON 同时含 mirror 段与决策字段 */
export function buildSinglePrompt(
  card: PersonaCard,
  memoryText: string | null,
  pending: PendingDecision,
  base: AssembledPrompt,
  relationDigest?: string | null,
  personaCharCap = 0,
): AssembledPrompt {
  const system = `${personaSystemBlock(card, memoryText, personaCharCap)}\n\n${base.system}`;
  const cutIdx = base.user.indexOf("【输出契约】");
  const contextPart = cutIdx >= 0 ? base.user.slice(0, cutIdx) : base.user;
  const user = [
    "【心镜先行】先在 mirror 字段里给出你此刻的人格状态报告（pressures≥1 或 tensions≥1：每项心理活动必须挂在具体参数上，禁止无根表演；相互冲突的参数必须同时列出、互相拉扯，禁止二选一），再让反应从中生长。",
    "【人格参数卡】",
    paramsDigest(card),
    relationDigest?.trim() ? relationDigest.trim() : "",
    "",
    contextPart,
    "【公开证据边界】他人的话只用于理解事实、立场与投票，不得继承其口癖、比喻体系和句式。",
    "【输出契约】严格输出以下结构的 JSON（禁止任何额外内容）：",
    '{"mirror":{"pressures":[{"param":"参数路径","value":0,"reason":"触发事由"}],"tensions":[{"poles":[{"param":"参数A","urge":"诉求"},{"param":"参数B","urge":"诉求"}],"intensity":0.0}],"defenses":[{"mechanism":"防御机制","toward":"指向"}],"trauma":null,"impulse":"此刻最想做的事","selfControl":0},' +
      personaOutputContract(pending).slice(1),
    "用不到的字段保持默认值即可。只输出 JSON 本体；thought/speech 里禁止心理学术语。",
  ].join("\n");
  return { system, user };
}

// ============================================================
// 张力模板组装（落 event.thought；观察者可见，绝不喂给其他玩家）
// 【当前撕裂】（可多组）→ 冲突强度 →【身体痕迹】→【涌现输出】
// ============================================================

export function formatTensionTemplate(
  card: PersonaCard,
  mirror: MirrorReport,
  bodyTrace: string,
  emergenceThought: string,
): string {
  const parts: string[] = [];
  if (mirror.tensions.length > 0) {
    const groups = mirror.tensions.map((t, i) => {
      const lines = t.poles
        .map((p) => `- ${paramLabel(card, p.param)}："${p.urge}"`)
        .join("\n");
      const head = mirror.tensions.length > 1 ? `（第${i + 1}组）` : "";
      return `${head}\n${lines}\n冲突强度：${t.intensity.toFixed(2)}`;
    });
    parts.push(`【当前撕裂】${groups.join("\n")}`);
  }
  if (mirror.pressures.length > 0) {
    parts.push(
      `【参数触发】${mirror.pressures
        .map((pr) => `${paramLabel(card, pr.param)}（${pr.reason}）`)
        .join("；")}`,
    );
  }
  if (mirror.defenses.length > 0) {
    parts.push(
      `【防御启动】${mirror.defenses.map((d) => `${d.mechanism}（→${d.toward}）`).join("；")}`,
    );
  }
  if (mirror.trauma) parts.push(`【创伤唤醒】${mirror.trauma}`);
  parts.push(`【身体痕迹】${bodyTrace.trim() || "（无显著痕迹）"}`);
  parts.push(`【涌现输出】${emergenceThought.trim() || mirror.impulse}`);
  return parts.join("\n\n").slice(0, 1600);
}

// ============================================================
// 管线执行
// ============================================================

export interface PersonaPipelineResult {
  decision: DecisionInput | null;
  error: string | null;
  personaMeta?: PersonaEventMeta;
}

interface RawExtras {
  bodyTrace: string;
  analysisGt: string;
  analysisPsy: string;
  mirrorRaw?: unknown;
}

function extractExtras(text: string): RawExtras {
  const cleaned = text.replace(/```(?:json)?/gi, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  const obj =
    start >= 0
      ? parseJsonRobust(cleaned.slice(start, end > start ? end + 1 : undefined))
      : undefined;
  const o = (typeof obj === "object" && obj !== null ? obj : {}) as Record<string, unknown>;
  return {
    bodyTrace: String(o.bodyTrace ?? "").trim().slice(0, 150),
    analysisGt: String(o.analysisGt ?? "").trim().slice(0, 120),
    analysisPsy: String(o.analysisPsy ?? "").trim().slice(0, 120),
    mirrorRaw: o.mirror,
  };
}

async function callWithBudget(
  cfg: SeatAiConfig,
  prompt: AssembledPrompt,
  timeoutMs: number,
  deadlineAt?: number,
): Promise<{ text: string | null; error: string | null }> {
  const res = await callAi(cfg, prompt.system, prompt.user, {
    timeoutMs: Math.max(3_000, timeoutMs),
    // deadlineAt 透传：重试循环内逐次按剩余预算截断——单次调用内部重试不得烧穿所属环节的预算份额
    maxRetries: timeoutMs > 60_000 ? 1 : 0,
    deadlineAt,
  });
  return res.ok && res.text ? { text: res.text, error: null } : { text: null, error: res.error ?? "AI 调用失败" };
}

/**
 * 人格座位决策管线：心镜 →（双程/单程）→ 涌现 → 张力模板 + 双视角注解。
 * 心镜失败降级为参数直推状态报告（铁律2 不破）；涌现失败返回 error 由服务层走标准托管。
 */
export async function runPersonaPipeline(opts: {
  cfg: SeatAiConfig;
  card: PersonaCard;
  memoryText: string | null;
  pending: PendingDecision;
  base: AssembledPrompt; // buildPrompt(pending, …) 产物（情境与游戏逻辑的唯一事实源）
  modelContext: number;
  deadlineAt?: number;
  retryNote?: string | null; // 引擎校验失败原因（重试时注入涌现层修正）
  resumeNote?: string | null; // 暂停恢复参考（挂起前思考量）
  /** 关系摘要（L4 集成层生成；为空表示关系网尚无数据，行为退化为旧版） */
  relationDigest?: string | null;
}): Promise<PersonaPipelineResult> {
  const { cfg, card, memoryText, pending, base, modelContext, relationDigest } = opts;
  const remaining = opts.deadlineAt != null ? opts.deadlineAt - Date.now() : Number.POSITIVE_INFINITY;
  const dual = shouldUseDualPipeline(modelContext);
  // 单次调用超时按模型能力画像分流（思考型 150s / 常规 90s，AI_TIMEOUT_MS 可全覆盖）——
  // 思考型模型（kimi-k3 永远思考等）思考链长，90s 常规上限会拦断长推理导致人格决策批量托管
  const baseTimeout = defaultCallTimeoutMs(cfg);
  const personaCharCap = Math.floor(promptCharBudget(modelContext) * 0.6);
  // 重试/恢复注记：追加到涌现（或单程合并）prompt 尾部（与标准决策路径同语义）
  const extraNote = [
    opts.resumeNote ? `【暂停恢复参考】${opts.resumeNote}` : "",
    opts.retryNote ? `【上一次输出非法】${opts.retryNote}。请修正后重新输出合法 JSON。` : "",
  ]
    .filter(Boolean)
    .join("\n");

  let mirror: MirrorReport | null = null;
  let thought = "";
  let extras: RawExtras = { bodyTrace: "", analysisGt: "", analysisPsy: "" };
  let decision: DecisionInput | null = null;

  if (dual) {
    // ---- 心镜（开销上限 35%，首发+解析重试共享该上限；超限立即降级参数直推报告，铁律2 不破）----
    // 设计教训（对局 20260930002 实锤）：心镜内部重试曾可烧掉 80% 决策预算（104s×2），
    // 涌现层——必须成功的调用——只剩 52s 残羹而必败托管。心镜是辅助件（有本地参数直推兜底），
    // 预算是涌现层的保命钱：心镜 35% 封顶，涌现拿全部剩余。
    const mirrorPrompt = buildMirrorPrompt(card, memoryText, pending, relationDigest);
    const mirrorCap = Math.min(baseTimeout, remaining * 0.35);
    const mirrorDeadline = Date.now() + mirrorCap;
    let mr = await callWithBudget(cfg, mirrorPrompt, mirrorCap, mirrorDeadline);
    if (mr.text) mirror = parseMirrorReport(mr.text);
    if (!mirror && mr.text) {
      // 铁律2 判非法：预算内允许一次重试（与首发共享心镜总上限，耗尽则不再追加）
      const retryBudget = mirrorDeadline - Date.now();
      if (retryBudget > 10_000) {
        const retry = await callWithBudget(
          cfg,
          {
            system: mirrorPrompt.system,
            user: `${mirrorPrompt.user}\n\n【上一次输出非法】未给出任何触发参数（pressures 与 tensions 皆空）。请重新输出，至少给出一条被点燃的参数或一组撕裂。`,
          },
          retryBudget,
          mirrorDeadline,
        );
        if (retry.text) mirror = parseMirrorReport(retry.text);
      }
    }
    if (!mirror) mirror = mirrorFallbackReport(card, pending);

    // ---- 涌现（预算的绝对优先方：拿心镜消耗后的全部剩余，deadlineAt 透传约束内部重试）----
    const emergePrompt = buildEmergencePrompt(card, mirror, memoryText, base, relationDigest, pending, personaCharCap);
    if (extraNote) emergePrompt.user += `\n${extraNote}`;
    const emergeRemaining = opts.deadlineAt != null ? opts.deadlineAt - Date.now() : baseTimeout;
    const er = await callWithBudget(cfg, emergePrompt, Math.min(baseTimeout, emergeRemaining), opts.deadlineAt);
    if (!er.text) return { decision: null, error: er.error ?? "涌现层调用失败" };
    decision = parseDecision(er.text, pending);
    if (!decision) return { decision: null, error: "涌现输出无法解析" };
    extras = extractExtras(er.text);
    thought = decision.thought ?? "";
  } else {
    // ---- 单程合并（deadlineAt 透传：内部重试不得烧穿决策点总预算）----
    const singlePrompt = buildSinglePrompt(card, memoryText, pending, base, relationDigest, personaCharCap);
    if (extraNote) singlePrompt.user += `\n${extraNote}`;
    const budget = Math.min(baseTimeout, remaining);
    const sr = await callWithBudget(cfg, singlePrompt, budget, opts.deadlineAt);
    if (!sr.text) return { decision: null, error: sr.error ?? "人格单程调用失败" };
    decision = parseDecision(sr.text, pending);
    if (!decision) return { decision: null, error: "人格单程输出无法解析" };
    extras = extractExtras(sr.text);
    if (extras.mirrorRaw) {
      mirror = parseMirrorReport(JSON.stringify(extras.mirrorRaw));
    }
    if (!mirror) mirror = mirrorFallbackReport(card, pending);
    thought = decision.thought ?? "";
  }

  // 表达保真：最多追加一次“只改文本”调用。无论模型新输出什么，行动字段都取首次决策。
  const currentSpeech = String((decision as DecisionInput & { speech?: string }).speech ?? "");
  const ownPrefix = `${pending.seat}号玩家发言：`;
  const peerLogs = pending.view.publicLog.filter((line) => !line.startsWith(ownPrefix));
  const previousOwn = [...pending.view.publicLog].reverse().find((line) => line.startsWith(ownPrefix));
  const issues = [
    ...inspectPersonaText(`${currentSpeech}\n${decision.thought ?? ""}`),
    ...sharedStylePhrases(currentSpeech, peerLogs).map((phrase) => `复用他人句式：${phrase}`),
  ];
  if (duplicateExactText(currentSpeech, previousOwn?.slice(ownPrefix.length))) issues.push("与本人上一条发言完全重复");
  const fidelityRemaining = opts.deadlineAt != null ? opts.deadlineAt - Date.now() : baseTimeout;
  if (issues.length > 0 && fidelityRemaining > 3_000) {
    const { speech: _speech, thought: _thought, ...lockedAction } = decision as DecisionInput & { speech?: string };
    const fidelityPrompt = dual
      ? buildEmergencePrompt(card, mirror, memoryText, base, relationDigest, pending, personaCharCap)
      : buildSinglePrompt(card, memoryText, pending, base, relationDigest, personaCharCap);
    fidelityPrompt.user += `\n${extraNote}\n${buildFidelityRetryNote(issues, lockedAction)}`;
    const retry = await callWithBudget(cfg, fidelityPrompt, Math.min(baseTimeout, fidelityRemaining), opts.deadlineAt);
    const rewritten = retry.text ? parseDecision(retry.text, pending) : null;
    if (rewritten) {
      decision = mergePersonaTextOnly(decision, rewritten);
      extras = extractExtras(retry.text!);
      thought = decision.thought ?? "";
    }
  }

  // 张力模板覆盖 thought（观察者可见的心理检查注解；涌现原文进【涌现输出】段）
  const fullThought = formatTensionTemplate(card, mirror, extras.bodyTrace, thought);
  decision.thought = fullThought;

  const contextAudit = degradePersonaContext(buildPersonaContext(card, memoryText), personaCharCap).audit;
  const personaMeta: PersonaEventMeta = {
    name: card.name,
    dual,
    contextVersion: contextAudit.version,
    degraded: contextAudit.degraded,
    tensions: mirror.tensions.map((t) => ({
      poles: t.poles.map((p) => paramLabel(card, p.param)),
      intensity: t.intensity,
    })),
    gt: extras.analysisGt,
    psy: extras.analysisPsy,
  };
  return { decision, error: null, personaMeta };
}
