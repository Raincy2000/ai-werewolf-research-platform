// ============================================================
// 人格研究库 — 前后端共享契约
// 「数字人类心理学实验场」的人格参数卡 / 记忆 / 关系 / 漂移 / 心理检查报告类型唯一事实源。
// 设计铁律：
// 1. 人格量化：所有维度 0-100 连续量化，禁止二选一（多组冲突参数必须能同时拉扯）
// 2. 推断项：铸魂师补全的字段在 params.inferred 里留路径标记，报告附录可追溯
// 3. 记忆持久化：记忆/关系/漂移跨对局保留，强度分支持衰减与强化
// ============================================================

import { z } from "zod";

// ---------- 大五人格（Big Five） ----------
export interface BigFiveParams {
  openness: number; // 开放性：想象/求新 vs 务实/守常
  conscientiousness: number; // 尽责性：自律/筹划 vs 随性/冲动
  extraversion: number; // 外向性：社交/积极 vs 内敛/沉默
  agreeableness: number; // 宜人性：信任/利他 vs 多疑/对抗
  neuroticism: number; // 神经质：情绪不稳/敏感 vs 稳定/迟钝
}

// ---------- 依恋类型（双轴连续，标签为派生展示） ----------
export interface AttachmentParams {
  anxiety: number; // 依恋焦虑：对被抛弃/被背叛的敏感度
  avoidance: number; // 依恋回避：对亲密与依赖的回避倾向
}

/** 依恋双轴派生标签（展示层用；双轴数值才是事实源，标签不构成二选一约束） */
export function attachmentLabel(a: AttachmentParams): string {
  const hiAnx = a.anxiety >= 50;
  const hiAvo = a.avoidance >= 50;
  if (!hiAnx && !hiAvo) return "安全型";
  if (hiAnx && !hiAvo) return "焦虑型";
  if (!hiAnx && hiAvo) return "回避型";
  return "恐惧型";
}

// ---------- 黑暗四人格（Dark Tetrad） ----------
export interface DarkTetradParams {
  machiavellianism: number; // 马基雅维利主义：操控欲与策略性冷漠
  narcissism: number; // 自恋：夸大体与钦佩渴求
  psychopathy: number; // 精神病态：低共情/低悔恨/冲动
  sadism: number; // 施虐：从他人痛苦中获益的倾向
}

// ---------- 核心认知偏差（目录为常用项，允许自定义条目） ----------
export interface CognitiveBiasEntry {
  id: string; // 目录 id 或自定义 slug
  label: string; // 展示名
  strength: number; // 0-100 偏差强度
}

export const COGNITIVE_BIAS_CATALOG: ReadonlyArray<{ id: string; label: string; hint: string }> = [
  { id: "confirmation", label: "确认偏误", hint: "只找支持自己判断的证据" },
  { id: "anchoring", label: "锚定效应", hint: "被第一印象/首个信息钉死" },
  { id: "loss-aversion", label: "损失厌恶", hint: "对失去的痛苦远大于得到的快乐" },
  { id: "fundamental-attribution", label: "基本归因错误", hint: "把他人行为归于人品而非处境" },
  { id: "dunning-kruger", label: "达克效应", hint: "能力不足时高估自己" },
  { id: "halo", label: "光环效应", hint: "一点好则处处好" },
  { id: "self-serving", label: "自利偏差", hint: "成功归自己、失败归环境" },
  { id: "negativity", label: "负面偏差", hint: "坏消息比好消息权重更大" },
  { id: "bandwagon", label: "从众偏差", hint: "多数人信什么就信什么" },
  { id: "control-illusion", label: "控制幻觉", hint: "高估自己对局面的掌控" },
];

// ---------- 防御机制（成熟度分级：原始/神经质/成熟） ----------
export type DefenseMaturity = "primitive" | "neurotic" | "mature";

export interface DefenseMechanismEntry {
  id: string; // 目录 id 或自定义 slug
  label: string; // 展示名
  tendency: number; // 0-100 启用倾向
  maturity: DefenseMaturity; // 成熟度分级
}

export const DEFENSE_MECHANISM_CATALOG: ReadonlyArray<{
  id: string;
  label: string;
  maturity: DefenseMaturity;
  hint: string;
}> = [
  { id: "denial", label: "否认", maturity: "primitive", hint: "拒绝承认痛苦现实" },
  { id: "projection", label: "投射", maturity: "primitive", hint: "把自己的动机安到别人身上" },
  { id: "splitting", label: "分裂", maturity: "primitive", hint: "非黑即白地看待他人" },
  { id: "regression", label: "退行", maturity: "neurotic", hint: "压力下退回幼稚反应" },
  { id: "repression", label: "压抑", maturity: "neurotic", hint: "把痛苦挤出意识" },
  { id: "rationalization", label: "合理化", maturity: "neurotic", hint: "为行为找体面理由" },
  { id: "displacement", label: "置换", maturity: "neurotic", hint: "把情绪发泄到安全对象" },
  { id: "intellectualization", label: "理智化", maturity: "neurotic", hint: "用分析隔离情绪" },
  { id: "reaction-formation", label: "反向形成", maturity: "neurotic", hint: "表现与真实欲望相反" },
  { id: "sublimation", label: "升华", maturity: "mature", hint: "把冲动转化为建设性行为" },
  { id: "humor", label: "幽默", maturity: "mature", hint: "以玩笑化解痛苦" },
  { id: "altruism", label: "利他", maturity: "mature", hint: "通过助人获得满足" },
];

// ---------- 情绪调节策略（Gross 过程模型 + 反刍） ----------
export interface EmotionRegulationParams {
  cognitiveReappraisal: number; // 认知重评：换角度解读情境
  expressiveSuppression: number; // 表达抑制：压住情绪外露
  rumination: number; // 反刍倾向：反复咀嚼负面体验
}

// ---------- SDT 动机（自我决定论三需要） ----------
export interface SdtParams {
  autonomy: number; // 自主需要：按自己意志行动的渴求
  competence: number; // 胜任需要：证明自己有能力的渴求
  relatedness: number; // 归属需要：与他人联结的渴求
}

// ---------- 人格参数卡（完整参数体） ----------
export interface PersonaParams {
  bigFive: BigFiveParams;
  attachment: AttachmentParams;
  darkTetrad: DarkTetradParams;
  cognitiveBiases: CognitiveBiasEntry[]; // 核心认知偏差（建议 2-7 条）
  defenseMechanisms: DefenseMechanismEntry[]; // 防御机制（建议 2-7 条）
  emotionRegulation: EmotionRegulationParams;
  sdt: SdtParams;
  /** 铸魂师推断项路径（如 "bigFive.openness"、"darkTetrad.sadism"）；手动建卡为空数组。
   *  用户手动修改某推断字段后应将该路径移出列表（推断→实证）。 */
  inferred: string[];
}

// ---------- 人物档案（自由文本区，供铸魂师蒸馏与涌现层约束） ----------
export interface PersonaProfile {
  summary: string; // 基本信息：是谁、出处、时代背景（一段）
  persona: string; // 人设与性格画像
  experiences: string; // 关键经历（塑造人格的事件）
  relationships: string; // 重要关系（人物关系网）
  quotes: string[]; // 标志性语录/口头禅（≤5，涌现层语气锚点）
  speechStyle: string; // 语言风格描述（用词/节奏/口癖）
  // ---- 完整档案扩展区（三步铸魂师产出；展示/心理检查/记事簿用） ----
  appearance?: string; // 外貌与气质（肖像文字版；以人物最新状态为准：在世取当下/已故取终态）
  values?: string; // 价值观与信念
  desires?: string; // 欲望与驱动力
  fears?: string; // 恐惧与软肋
  socialMask?: string; // 社交面具与对外形象
  innerWorld?: string; // 内心世界与隐秘面
  quirks?: string; // 习惯与癖好
  // ---- 人格精粹（对局注入专用：完整档案的行为指导级蒸馏，保证大档案在对局中不失效） ----
  essence?: string; // ≤1200 字：核心冲突/行为倾向/语言心智/雷区——心镜与涌现层以此为准
  // ---- 在世状态（穿越认知依据：在世=忽然穿越到米勒山谷；已故=死后穿越到米勒山谷；原创=山谷原住民） ----
  aliveStatus?: "alive" | "deceased" | null;
  // ---- 特殊能力封印（原作/设定中的超常能力概述；到达米勒山谷后全部失效，无则空串） ----
  specialAbilities?: string;
}

// ---------- 人格参数卡 ----------
export type PersonaSource = "manual" | "ai-cast";

export interface PersonaCard {
  id: number;
  name: string; // 人格名（如「曹操」）
  source: PersonaSource;
  originName: string | null; // 原型人物名（ai-cast 确认的人物）
  originSource: string | null; // 出处（作品名 / 「现实人物」）
  profile: PersonaProfile;
  params: PersonaParams;
  notes: string; // 研究备注
  imageData: string | null; // 肖像配图（data URL；null=无图用首字占位）
  gameCount: number; // 已参与对局数（对局落座即计）
  createdAt: string;
  updatedAt: string;
}

/** 列表页摘要行（不含 profile/notes 长文本；bigFive 供迷你条形图，imageData 供身份证式卡片） */
export interface PersonaCardSummary {
  id: number;
  name: string;
  source: PersonaSource;
  originName: string | null;
  originSource: string | null;
  bigFive: BigFiveParams;
  inferredCount: number; // 推断项数量（保真度提示）
  imageData: string | null; // 肖像配图（data URL；null=首字占位）
  gameCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface PersonaCardInput {
  name: string;
  originName?: string | null;
  originSource?: string | null;
  profile: PersonaProfile;
  params: PersonaParams;
  notes?: string;
  imageData?: string | null; // 肖像配图（data URL）
}

// ---------- 记事簿：自传体记忆 ----------
export type PersonaMemoryType = "trauma" | "relationship" | "general";

export interface PersonaMemory {
  id: number;
  personaId: number;
  gameId: string | null; // 出处对局（null = 手动录入/背景记忆）
  type: PersonaMemoryType;
  content: string;
  emotionalWeight: number; // 0-100 情绪权重（创伤通常高权重）
  strength: number; // 0-100 记忆强度（随时间衰减，被唤起/复述则强化）
  createdAt: string;
  updatedAt: string; // 最近一次强化/衰减触碰时间
}

// ---------- 记事簿：关系图谱 ----------
export interface PersonaRelationship {
  id: number;
  personaId: number;
  targetPersonaId: number | null; // 对方也是人格卡时建立链接
  targetName: string; // 展示名（对方卡名或自由文本）
  relation: string; // 关系标签（如「信任」「宿怨」「亦敌亦友」）
  affinity: number; // -100..100 亲疏（负=敌意）
  trust: number; // 0..100 信任度
  note: string; // 关系注记（关键事件一句话）
  gameId: string | null; // 最近一次塑造该关系的对局
  updatedAt: string;
}

// ---------- 人格漂移记录（报告附录；长期参数跨对局可调，逐次留痕） ----------
export interface PersonaDriftChange {
  path: string; // 参数路径（如 "bigFive.neuroticism"）
  from: number;
  to: number;
  reason: string; // 漂移事由（哪件事触发的）
}

export interface PersonaDriftEntry {
  id: number;
  personaId: number;
  gameId: string | null;
  changes: PersonaDriftChange[];
  note: string;
  createdAt: string;
}

// ---------- 心理检查报告（心理检查师产出，一局一人格一份） ----------
export interface PersonaReport {
  id: number;
  gameId: string;
  personaId: number;
  seat: number;
  report: string; // 《心理检查报告》全文（markdown）
  model: string; // 心理检查师所用模型
  createdAt: string;
}

// ============================================================
// zod 校验（路由输入与前端表单共用；数值一律 0-100 整数，affinity 例外）
// ============================================================

const pct = z.number().int().min(0).max(100);

const bigFiveSchema = z.object({
  openness: pct,
  conscientiousness: pct,
  extraversion: pct,
  agreeableness: pct,
  neuroticism: pct,
});

const attachmentSchema = z.object({ anxiety: pct, avoidance: pct });

const darkTetradSchema = z.object({
  machiavellianism: pct,
  narcissism: pct,
  psychopathy: pct,
  sadism: pct,
});

const cognitiveBiasSchema = z.object({
  id: z.string().trim().min(1).max(64),
  label: z.string().trim().min(1).max(32),
  strength: pct,
});

const defenseMechanismSchema = z.object({
  id: z.string().trim().min(1).max(64),
  label: z.string().trim().min(1).max(32),
  tendency: pct,
  maturity: z.enum(["primitive", "neurotic", "mature"]),
});

const emotionRegulationSchema = z.object({
  cognitiveReappraisal: pct,
  expressiveSuppression: pct,
  rumination: pct,
});

const sdtSchema = z.object({ autonomy: pct, competence: pct, relatedness: pct });

export const personaParamsSchema = z.object({
  bigFive: bigFiveSchema,
  attachment: attachmentSchema,
  darkTetrad: darkTetradSchema,
  cognitiveBiases: z.array(cognitiveBiasSchema).max(12),
  defenseMechanisms: z.array(defenseMechanismSchema).max(12),
  emotionRegulation: emotionRegulationSchema,
  sdt: sdtSchema,
  inferred: z.array(z.string().max(128)).max(64),
});

export const personaProfileSchema = z.object({
  summary: z.string().max(4000),
  persona: z.string().max(4000),
  experiences: z.string().max(8000),
  relationships: z.string().max(4000),
  quotes: z.array(z.string().max(200)).max(5),
  speechStyle: z.string().max(2000),
  appearance: z.string().max(2000).optional(),
  values: z.string().max(3000).optional(),
  desires: z.string().max(3000).optional(),
  fears: z.string().max(3000).optional(),
  socialMask: z.string().max(2000).optional(),
  innerWorld: z.string().max(3000).optional(),
  quirks: z.string().max(2000).optional(),
  essence: z.string().max(1200).optional(),
  aliveStatus: z.enum(["alive", "deceased"]).nullable().optional(),
  specialAbilities: z.string().max(1000).optional(),
});

export const personaInputSchema = z.object({
  name: z.string().trim().min(1, "人格名不能为空").max(64),
  originName: z.string().trim().max(128).nullable().optional(),
  originSource: z.string().trim().max(128).nullable().optional(),
  profile: personaProfileSchema,
  params: personaParamsSchema,
  notes: z.string().max(4000).optional(),
  // 肖像配图（data URL；铸魂师联网搜取或用户上传/换链，≤1.5MB base64）
  imageData: z.string().max(1_500_000).nullable().optional(),
});

// ---------- 构造默认值 ----------
export function defaultPersonaParams(): PersonaParams {
  return {
    bigFive: { openness: 50, conscientiousness: 50, extraversion: 50, agreeableness: 50, neuroticism: 50 },
    attachment: { anxiety: 30, avoidance: 30 },
    darkTetrad: { machiavellianism: 20, narcissism: 20, psychopathy: 10, sadism: 5 },
    cognitiveBiases: [
      { id: "confirmation", label: "确认偏误", strength: 50 },
      { id: "loss-aversion", label: "损失厌恶", strength: 50 },
    ],
    defenseMechanisms: [
      { id: "rationalization", label: "合理化", tendency: 50, maturity: "neurotic" },
      { id: "humor", label: "幽默", tendency: 40, maturity: "mature" },
    ],
    emotionRegulation: { cognitiveReappraisal: 50, expressiveSuppression: 40, rumination: 30 },
    sdt: { autonomy: 60, competence: 60, relatedness: 60 },
    inferred: [],
  };
}

export function emptyPersonaProfile(): PersonaProfile {
  return {
    summary: "",
    persona: "",
    experiences: "",
    relationships: "",
    quotes: [],
    speechStyle: "",
    appearance: "",
    values: "",
    desires: "",
    fears: "",
    socialMask: "",
    innerWorld: "",
    quirks: "",
    essence: "",
  };
}

// ============================================================
// 对局接入：座位人格绑定 / 心镜状态报告 / 涌现事件注解（铁律2/4/6）
// ============================================================

/** 参数路径当前值（查不到返回 null）。路径约定："bigFive.openness"、"cognitiveBiases.确认偏误" 等 */
export function getParamValue(params: PersonaParams, path: string): number | null {
  const [group, key] = path.split(".");
  const pick = (obj: unknown): number | null =>
    (obj as Record<string, number>)[key] ?? null;
  switch (group) {
    case "bigFive":
      return pick(params.bigFive);
    case "attachment":
      return pick(params.attachment);
    case "darkTetrad":
      return pick(params.darkTetrad);
    case "emotionRegulation":
      return pick(params.emotionRegulation);
    case "sdt":
      return pick(params.sdt);
    case "cognitiveBiases":
      return params.cognitiveBiases.find((b) => b.id === key || b.label === key)?.strength ?? null;
    case "defenseMechanisms":
      return params.defenseMechanisms.find((d) => d.id === key || d.label === key)?.tendency ?? null;
    default:
      return null;
  }
}

/** 写入参数路径（钳位 0-100；路径非法返回原参数不变）。人格漂移/手动调参共用。 */
export function setParamValue(params: PersonaParams, path: string, value: number): PersonaParams {
  const v = Math.max(0, Math.min(100, Math.round(value)));
  const [group, key] = path.split(".");
  switch (group) {
    case "bigFive":
      if (!(key in params.bigFive)) return params;
      return { ...params, bigFive: { ...params.bigFive, [key]: v } };
    case "attachment":
      if (!(key in params.attachment)) return params;
      return { ...params, attachment: { ...params.attachment, [key]: v } };
    case "darkTetrad":
      if (!(key in params.darkTetrad)) return params;
      return { ...params, darkTetrad: { ...params.darkTetrad, [key]: v } };
    case "emotionRegulation":
      if (!(key in params.emotionRegulation)) return params;
      return { ...params, emotionRegulation: { ...params.emotionRegulation, [key]: v } };
    case "sdt":
      if (!(key in params.sdt)) return params;
      return { ...params, sdt: { ...params.sdt, [key]: v } };
    case "cognitiveBiases": {
      const i = params.cognitiveBiases.findIndex((b) => b.id === key || b.label === key);
      if (i < 0) return params;
      const cognitiveBiases = params.cognitiveBiases.map((b, j) => (j === i ? { ...b, strength: v } : b));
      return { ...params, cognitiveBiases };
    }
    case "defenseMechanisms": {
      const i = params.defenseMechanisms.findIndex((d) => d.id === key || d.label === key);
      if (i < 0) return params;
      const defenseMechanisms = params.defenseMechanisms.map((d, j) =>
        j === i ? { ...d, tendency: v } : d,
      );
      return { ...params, defenseMechanisms };
    }
    default:
      return params;
  }
}

/** 创建对局时的座位人格绑定（seat 1-based；personaId 指向人格研究库的卡） */
export interface PersonaSeatBinding {
  seat: number;
  personaId: number;
}

/** setup 落库的绑定快照（含人格名冗余：断点恢复与快照展示不再查库） */
export interface PersonaSeatInfo extends PersonaSeatBinding {
  name: string;
}

// ---------- 心镜「人格状态报告」（铁律6：只输出状态，不生成台词） ----------
/** 被触发参数（铁律2「参数溢出」的最小单元：任何心理活动必须挂在具体参数上） */
export interface MirrorPressure {
  param: string; // 参数路径（如 bigFive.neuroticism / darkTetrad.machiavellianism / cognitiveBiases.确认偏误）
  value: number; // 该参数的当前值（0-100）
  reason: string; // 触发事由（一句，落到当前情境）
}

/** 一组撕裂的两极（禁止二选一：两极同时在场、互相拉扯） */
export interface TensionPole {
  param: string; // 参数路径
  urge: string; // 这一极此刻想要什么（一句，第一人称口吻）
}

export interface TensionGroup {
  poles: TensionPole[]; // ≥2 极（可多组多级同时拉扯）
  intensity: number; // 冲突强度 0-1
}

export interface MirrorDefense {
  mechanism: string; // 防御机制名（如 合理化/投射）
  toward: string; // 防御指向（对谁/对什么事）
}

export interface MirrorReport {
  pressures: MirrorPressure[]; // 被情境点燃的参数（≥1，铁律2）
  tensions: TensionGroup[]; // 当前撕裂（可多组，铁律6）
  defenses: MirrorDefense[]; // 被触发的防御机制（可为空）
  trauma: string | null; // 被唤醒的创伤记忆（无则 null）
  impulse: string; // 此刻最想做的事（一句，心镜的冲动原稿）
  selfControl: number; // 自控余量 0-100（低=涌现更失控）
}

/** 涌现事件注解（落 event.meta.persona）：双视角解释（铁律4）+ 撕裂摘要（观察者展示） */
export interface PersonaEventMeta {
  name: string; // 人格名
  dual: boolean; // true=双程管线（心镜→涌现）；false=小上下文模型单程合并
  tensions: { poles: string[]; intensity: number }[]; // 撕裂组标签（如 ["宜人性 20 ⇄ 马基雅维利 85"]）
  gt: string; // 博弈论解释（一句）
  psy: string; // 人格动力学解释（一句）
}

// ---------- 铸魂师（AI 铸造：联网检索 + 整合量化） ----------
/** 检索消歧候选（重名时列出多个确有其人的对象供用户确认） */
export interface CasterCandidate {
  name: string; // 人物名
  source: string; // 出处（作品名 / 现实领域）
  identity: string; // 身份一句话（如「《三国演义》曹魏奠基人」）
  summary: string; // 基本信息附录（性格/生平两三句）
}

export interface PersonaResearchResult {
  candidates: CasterCandidate[];
  notice?: string; // 降级提示（如「当前检索 AI 未联网，结果来自模型内部知识」）
}

/** 铸造产物（未入库的草稿卡：用户确认后才落库） */
export interface PersonaCastResult {
  draft: PersonaCardInput;
  notice?: string;
}

/** 铸造进度（persona.castProgress 轮询透出）：阶段人话 label + 动态细节 detail（生成字数/检索轮次） */
export interface CastProgressState {
  castId: string;
  name?: string; // 铸造人格名（后台任务卡片显示；异步铸造任务有）
  label: string; // 当前阶段（如「② 分段深读人格（4 专题并行）」）
  detail: string; // 细节行（如「已生成 1,240 字」或并行 lane 合并）
  startedAt: number;
  updatedAt: number;
  done: boolean; // 任务结束（成功或失败）
  error: string | null; // 失败原因（成功为 null）
  result: PersonaCastResult | null; // 铸造完成产物（异步任务模式：done 且成功时有值）
  paused: boolean; // 已暂停（生成进度挂起，可继续）
}

/** persona.cast 启动响应（异步任务模式：立即返回 castId，进度与结果经 castProgress 轮询） */
export interface CastJobStart {
  castId: string;
}

/** 铸造控制动作（persona.castControl）：暂停/继续/终止 */
export type CastControlAction = "pause" | "resume" | "cancel";

/** 回收站保留期（天）：软删人格到期后惰性彻底删除 */
export const PERSONA_TRASH_TTL_DAYS = 30;

/** 回收站条目（persona.trash 返回） */
export interface PersonaTrashEntry {
  id: number;
  name: string;
  originName: string | null;
  originSource: string | null;
  imageData: string | null;
  gameCount: number;
  deletedAt: string; // 移入回收站时间
  expiresAt: string; // 到期彻底清除时间（deletedAt + PERSONA_TRASH_TTL_DAYS 天）
}
