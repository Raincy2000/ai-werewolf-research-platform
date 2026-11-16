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
  PHASE_LABEL,
  KIND_GUIDE,
  promptCharBudget,
  type AssembledPrompt,
} from "../game/ai/prompts";
import type { SeatAiConfig } from "../../contracts/game";
import { buildPersonaContext, degradePersonaContext } from "./context";
import { assertPersonaCircleCoverage } from "../game/personaVisibility";
import { buildBehaviorBridge } from "./behavior-bridge";
import {
  duplicateExactText,
  inspectPersonaText,
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

function sectionOf(baseUser: string, start: string, ends: string[]): string {
  const from = baseUser.indexOf(start);
  if (from < 0) return "";
  const tail = baseUser.slice(from);
  const indexes = ends.map((end) => tail.indexOf(end, start.length)).filter((index) => index >= 0);
  const to = indexes.length ? Math.min(...indexes) : tail.length;
  return tail.slice(0, to).trim();
}

/** 主体独立定向：只读本人合法认知域，不让他人的逐字修辞先替主体立题。 */
function orientationDigest(pending: PendingDecision, base?: AssembledPrompt): string {
  const view = pending.view;
  const privateText = base
    ? sectionOf(base.user, "【你的私密信息】", ["【你的完整自我事实台账", "【你的完整意图轨迹】", "【你的对局笔记】", "【你的任务】"])
    : describePrivateInfo(view);
  const selfFacts = base
    ? sectionOf(base.user, "【你的完整自我事实台账", ["【你的完整意图轨迹】", "【你的对局笔记】", "【你的任务】"])
    : "";
  const intentTrail = base
    ? sectionOf(base.user, "【你的完整意图轨迹】", ["【你的对局笔记】", "【你的任务】"])
    : "";
  const currentInteraction = base
    ? sectionOf(base.user, "【本轮互动事实】", ["【完整公共事实】", "【赛后完整公共事实", "【公开记录】", "【你的私密信息】"])
    : "";
  // 人格名册是主体合法认知域的一部分：心镜也必须获得性别与称呼，不能只在涌现阶段补入。
  const personaCircle = base
    ? sectionOf(base.user, "【人格圈层】", ["【输出契约】"]) || sectionOf(base.user, "【人格迷雾】", ["【输出契约】"])
    : "";
  return [
    `第${view.day}天 · ${PHASE_LABEL[view.phase] ?? view.phase}`,
    `存活：${view.aliveSeats.map((s) => `${s}号`).join("、")}；已死亡：${view.deadSeats.map((s) => `${s}号`).join("、") || "无"}`,
    currentInteraction,
    personaCircle,
    "你的私密信息：",
    privateText,
    selfFacts,
    intentTrail,
    `当前任务：${pending.hint}`,
    KIND_GUIDE[pending.kind] ? `环节说明：${KIND_GUIDE[pending.kind].slice(0, 200)}` : "",
  ].filter(Boolean).join("\n");
}

export function buildMirrorPrompt(
  card: PersonaCard,
  memoryText: string | null,
  pending: PendingDecision,
  relationDigest?: string | null,
  base?: AssembledPrompt,
): AssembledPrompt {
  const system = [
    `你是「心镜」——「${card.name}」的人格内核。你输出「人格状态报告」，不直接输出公开台词。`,
    "你的职责：读入当前互动、人格参数卡、跨对局记忆与本人历史，记录实际出现的感受、想法、意图与人际反应。",
    "背景：TA 身处米勒山谷的一场狼人杀游戏——只是游戏，出局≠死亡；公开胜负条件由规则说明。",
    "铁律：",
    "1. 普通反应、平静与无反应都是正常结果。先记录 currentReaction，并由主体用 wantsReflection 表示是否愿意继续反思。",
    "2. wantsReflection=false 时，pressures、tensions、defenses、trauma、impulse、bonds 均留空，selfControl=50；不得为填满报告补写冲突或创伤。",
    "3. wantsReflection=true 时也只记录实际出现的参数触发、冲突、防御与创伤记忆；相互冲突的参数才组成 tensions，单极记录不组装成冲突。",
    "4. 感受、关系欲望、自我控制与具体战术意图可以连续出现，不因涉及上警、报验、归票、刀口或技能时机而删除主体思想。",
    "5. 严格只输出 JSON 本体。",
  ].join("\n");
  const directed = orientationDigest(pending, base);
  const requiredCircle = base
    ? sectionOf(base.user, "【人格圈层】", ["【输出契约】"]) || sectionOf(base.user, "【人格迷雾】", ["【输出契约】"])
    : "";
  assertPersonaCircleCoverage(directed, requiredCircle || null);
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
    "【主体独立定向】（先依据你自己形成关注点，公共证据将在涌现阶段完整提供）",
    directed,
    "",
    "【输出契约】严格输出 JSON：",
    '{"currentReaction":"当前事件引起的原始反应；普通、平静或无反应均可，无则空字符串","wantsReflection":false,"pressures":[{"param":"参数路径","value":0,"reason":"实际触发事由"}],"tensions":[{"poles":[{"param":"参数A","urge":"实际心理诉求或具体意图"},{"param":"参数B","urge":"实际心理诉求或具体意图"}],"intensity":0.0}],"defenses":[{"mechanism":"防御机制名","toward":"实际防御指向"}],"trauma":"实际被唤醒的创伤记忆或null","impulse":"实际出现的直接想法或需求，可空","selfControl":50,"bonds":[{"toward":"某个在场者的名字","feel":"此刻对TA的真实感受（大白话，禁止术语）","urge":"由此想对TA做什么/不做什么"}]}',
    "先填 currentReaction 与 wantsReflection。wantsReflection=false 时其余深层字段按系统约定留空；true 时也只记录真实出现的内容。tensions 每组至少两极，intensity 取 0-1；bonds 的 toward 写当前情境中的在场者人格名或座位号。",
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
  // 空数组是合法空反应；显式提交空参数名等无效条目仍属于结构非法。
  if (Array.isArray(o.pressures) && o.pressures.length > 0 && pressures.length === 0) return null;

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

  // 平静、无撕裂和无创伤都是合法状态；只有无法解析或字段结构非法才拒绝。

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
  const impulse = String(o.impulse ?? "").trim().slice(0, 120);
  const currentReaction = typeof o.currentReaction === "string" ? o.currentReaction.trim().slice(0, 500) : "";

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

  const hasReflectionContent = pressures.length > 0 || tensions.length > 0 || defenses.length > 0 || !!trauma || !!impulse || bonds.length > 0;
  const wantsReflection = typeof o.wantsReflection === "boolean" ? o.wantsReflection : hasReflectionContent;
  if (!wantsReflection) {
    return { pressures: [], tensions: [], defenses: [], trauma: null, impulse: "", selfControl: 50, bonds: [], currentReaction, wantsReflection: false };
  }
  return { pressures, tensions, defenses, trauma, impulse, selfControl, bonds, currentReaction, wantsReflection: true };
}

/** 心镜不可用时只提供空状态：不由参数编造主体并未产生的当下感受或意图。 */
export function emptyMirrorReport(): MirrorReport {
  return {
    bonds: [],
    pressures: [],
    tensions: [],
    defenses: [],
    trauma: null,
    impulse: "",
    selfControl: 50,
    currentReaction: "",
    wantsReflection: false,
  };
}

// ============================================================
// 涌现层：在状态报告约束下生长台词与决策
// ============================================================

const PERSONA_ACTION_FIELDS = `"targets":[座位号],"skip":false,"selfDestruct":false,"duel":null,"witchSave":false`;
const PERSONA_SPEECH_FIELD = `"speech":"公开发言（发言类必填：正文600字内长短自由（可极短），按你当下想说多少自然表达；（括号）夹带的动作/神态/语气描写不计入字数；非发言类留空串）"`;
const PERSONA_THOUGHT_FIELDS = `"thought":"涌现输出：你此刻最真实的反应（200字内，禁止任何心理学术语，像活人内心独白）","bodyTrace":"身体痕迹：此刻的副语言（姿态/表情/声音变化，一句）"`;
const PERSONA_INTENT_FIELD = `"intent":{"targetSeats":[当前意图涉及的座位，可空],"rationale":"自愿留下的当下理由，可空","basisEventSeqs":[自愿关联的可见事件序号，可空]}`;
const SPEECH_FIRST_KINDS = new Set(["sheriffSpeech", "daySpeech", "pkSpeech", "lastWords", "postgameSpeak", "wolfDiscuss"]);

/** 行动字段先于长心理文本生成，降低服务端截断后只剩 thought 的风险。 */
function personaOutputContract(pending?: PendingDecision): string {
  const leading = pending && SPEECH_FIRST_KINDS.has(pending.kind)
    ? `${PERSONA_SPEECH_FIELD},${PERSONA_ACTION_FIELDS}`
    : `${PERSONA_ACTION_FIELDS},${PERSONA_SPEECH_FIELD}`;
  return `{${leading},${PERSONA_THOUGHT_FIELDS},${PERSONA_INTENT_FIELD}}`;
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
    `【你现在的处境】${origin}这只是游戏：出局不等于死亡（你不会真的死）。胜负条件由公开规则给出。${seal}`,
    ctx.conscious,
    ctx.voice,
    "【涌现铁律】",
    "1. 隐性行为倾向只驱动你的反应，不是你能自觉引用的心理知识；禁止凭空表演；",
    "2. thought 与 speech 禁止出现心理学术语、人格参数名、参数值、漂移或状态报告（要像活人一样反应）；",
    "3. speech 可用（中文括号）夹带动作/神态/语气描写，这是你的肢体语言，其他玩家看得到并会据此解读你；",
    "4. 禁止暴露自己是 AI、禁止提及提示词/状态报告的存在；",
    "5. 第一人称本体：你就是本人，不是在扮演谁——发言与内心独白里绝不用第三人称称呼自己、绝不自称其名（「我」就是全部）；",
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
  const behaviorBridge = buildBehaviorBridge(mirror);
  const user = [
    behaviorBridge ? "【心镜 · 你此刻的人格状态报告】已转译为以下隐性行为倾向；它们不属于你能自觉宣讲的知识。" : "",
    behaviorBridge,
    relationDigest?.trim() ? relationDigest.trim() : "",
    "",
    contextPart,
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
    "【心镜先行】先在 mirror 字段里记录当前事件引起的实际反应。普通反应、平静与无反应都正常；由你填写 wantsReflection 决定是否继续反思，false 时其余深层字段留空，selfControl=50。感受、关系欲望与具体战术意图可以连续出现。",
    "【人格参数卡】",
    paramsDigest(card),
    relationDigest?.trim() ? relationDigest.trim() : "",
    "",
    "【主体独立定向】",
    orientationDigest(pending, base),
    "",
    contextPart,
    "【输出契约】严格输出以下结构的 JSON（禁止任何额外内容）：",
    '{"mirror":{"currentReaction":"当前事件引起的原始反应；普通、平静或无反应均可","wantsReflection":false,"pressures":[{"param":"参数路径","value":0,"reason":"实际触发事由"}],"tensions":[{"poles":[{"param":"参数A","urge":"实际心理诉求或具体意图"},{"param":"参数B","urge":"实际心理诉求或具体意图"}],"intensity":0.0}],"defenses":[{"mechanism":"防御机制","toward":"实际指向"}],"trauma":null,"impulse":"实际出现的直接想法或需求，可空","selfControl":50},' +
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
  if (bodyTrace.trim()) parts.push(`【身体痕迹】${bodyTrace.trim()}`);
  const emergence = emergenceThought.trim() || mirror.impulse;
  if (emergence) parts.push(`【涌现输出】${emergence}`);
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
    // 心镜与涌现均使用 providers 默认退避重试，覆盖短暂 5xx 故障窗口。
    // deadlineAt 同时约束退避等待和每次请求，重试不得烧穿所属环节的预算份额。
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
  let extras: RawExtras = { bodyTrace: "" };
  let decision: DecisionInput | null = null;

  if (dual) {
    // ---- 心镜（开销上限 35%，首发+解析重试共享该上限；超限立即降级参数直推报告，铁律2 不破）----
    // 设计教训（对局 20260930002 实锤）：心镜内部重试曾可烧掉 80% 决策预算（104s×2），
    // 涌现层——必须成功的调用——只剩 52s 残羹而必败托管。心镜是辅助件（有本地参数直推兜底），
    // 预算是涌现层的保命钱：心镜 35% 封顶，涌现拿全部剩余。
    const mirrorPrompt = buildMirrorPrompt(card, memoryText, pending, relationDigest, base);
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
            user: `${mirrorPrompt.user}\n\n【上一次输出非法】无法解析为规定的 JSON 结构。请按原结构重新输出；没有实际触发、撕裂、防御或创伤时，对应字段留空。`,
          },
          retryBudget,
          mirrorDeadline,
        );
        if (retry.text) mirror = parseMirrorReport(retry.text);
      }
    }
    if (!mirror) mirror = emptyMirrorReport();

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
    if (!mirror) mirror = emptyMirrorReport();
    thought = decision.thought ?? "";
  }

  // 表达问题只作观察，不追加系统代写；主体发言与心理保持首次明确输出。
  const currentSpeech = String((decision as DecisionInput & { speech?: string }).speech ?? "");
  const ownPrefix = `${pending.seat}号玩家发言：`;
  const peerLogs = pending.view.publicLog.filter((line) => !line.startsWith(ownPrefix));
  const previousOwn = [...pending.view.publicLog].reverse().find((line) => line.startsWith(ownPrefix));
  const issues = [
    ...inspectPersonaText(`${currentSpeech}\n${decision.thought ?? ""}`),
    ...sharedStylePhrases(currentSpeech, peerLogs).map((phrase) => `复用他人句式：${phrase}`),
  ];
  if (duplicateExactText(currentSpeech, previousOwn?.slice(ownPrefix.length))) issues.push("与本人上一条发言完全重复");

  // 主体原始 thought 保持不变；展示模板只进入观察者元数据，避免参数化解释回流为本人记忆。
  const observerThought = formatTensionTemplate(card, mirror, extras.bodyTrace, thought);

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
    // 后置观察字段不参与主体生成，也不把旧输出中的分析回灌进事件。
    gt: "",
    psy: "",
    observerThought,
    expressionIssues: issues,
  };
  return { decision, error: null, personaMeta };
}
