// ============================================================
// 人格研究站 — 前后端共享契约
// 「数字人类心理学实验场」的人格参数卡 / 记忆 / 关系 / 漂移 / 心理检查报告类型唯一事实源。
// 设计铁律：
// 1. 人格量化：所有维度 0-100 连续量化，禁止二选一（多组冲突参数必须能同时拉扯）
// 2. 推断项：铸魂师补全的字段在 params.inferred 里留路径标记，报告附录可追溯
// 3. 记忆持久化：记忆/关系/漂移跨对局保留，强度分支持衰减与强化
// ============================================================

import { z } from "zod";

// ============================================================
// 机制总开关（前后端共享的唯一事实源）
// ============================================================
/**
 * 认知笔记机制总开关 —— **2026-10 全量下线**。
 *
 * 下线理由（设计文档 §4.10.6）：笔记是一段**静态的自我摘要**，与「记性」的
 * 情境检索式自我互相冲突；实测它对决策层无影响（博弈术语密度变异系数 12.6%），
 * 却占据上下文并诱发"复述自我"。**对局中人格的自我应由「记性」每次现算提供。**
 *
 * ⚠️ **代码完整保留**：本机制将移植到「独处·自省室」（制度 A）。
 * 届时把本开关置 true 即可同时恢复——服务端写入、essence 同步、以及前端
 * 全部入口（「认知笔记」页签 / 记录认知 / 自动书写开关 / 铸造表单字段）。
 */
export const COGNITION_NOTE_ENABLED = false;

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
/** 铸造产出的结构化原作关系（设计文档 §19） */
export interface CanonRelationInput {
  /** 对方标准名（用卡名体系，便于接合） */
  name: string;
  /** 对方的其他译名/称呼（把译名差异一并产出，接合时一并匹配） */
  aliases?: string[];
  /** 关系类型（受控词表 §4.3）；未知用 unspecified */
  kind?: string;
  /** RMT 四型：CS | AR | EM | MP */
  kindSource?: string;
  /** 强度成分（0-100） */
  positivity?: number;
  negativity?: number;
  trust?: number;
  closeness?: number;
  /** 我称呼 TA 用什么 */
  addressTerm?: string;
  addressKind?: "neutral" | "intimate" | "honorific" | "derogatory";
  /** 依据（原作引文/事件） */
  basis?: string;
}

export interface PersonaProfile {
  gender?: string; // 性别（「男」/「女」/「其他」）：圈层可见时决定他人的人称代词（他/她/TA）
  summary: string; // 基本信息：是谁、出处、时代背景（一段）
  persona: string; // 人设与性格画像
  experiences: string; // 关键经历（塑造人格的事件）
  relationships: string; // 重要关系（人物关系网）
  /** 结构化原作关系（铸造产出；入库时转 canon 层关系边）
   *  ⚠️ 悬空边：对方可能尚未入库，靠 name + aliases 等待接合 */
  canonRelations?: CanonRelationInput[] | null;
  /** 自我的其他称呼（译名/称号/昵称）—— 入库时写入别名库 */
  selfAliases?: string[] | null;
  /** 昵称库（四层分级，§17；对局称呼选择用） */
  nicknames?: import("./interpersonal").Nickname[] | null;
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
  // ---- 在世状态（分身降临认知依据：外来人格都是从原世界的自己身上分出的分身来到米勒山谷——
  //   TA 既是真实自我本身、也是真实自我的一部分；在世=原我仍在原世界继续生活，已故=原我已走完一生；
  //   原创（手动建卡）=山谷原住民。对局注入与认知笔记材料均据此分层注入） ----
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
  /** 演化小数累积器（path → 未落账的小数位移）：EWMA 单局位移常 <0.5 分，需累积后落整 */
  paramsResidual?: Record<string, number> | null;
  gameCount: number;
  autoCognition?: AutoCognitionSetting | null; // 赛后自动书写设置（认知笔记页签维护） // 已参与对局数（对局落座即计）
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
  cognitionWritingAt?: string | null; // 认知笔记书写中的开始时刻（ISO）；null/缺省=无在飞书写
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
export type PersonaMemoryType = "trauma" | "triumph" | "relationship" | "general";

export interface PersonaMemory {
  id: number;
  personaId: number;
  gameId: string | null; // 出处对局（null = 手动录入/背景记忆）
  type: PersonaMemoryType;
  content: string;
  emotionalWeight: number; // 0-100 唤醒度（arousal）
  valence: number; // -100..100 效价（valence）：负=创伤/挫败，正=高光/成就（Russell 1980）
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

// ---------- 关系历史（人格锚点关系的逐局变迁；汇总行看现状，历史行看沿革） ----------
export interface PersonaRelationshipHistory {
  id: number;
  personaId: number;
  targetPersonaId: number | null;
  targetName: string;
  gameId: string | null;
  titleNo: string; // 对局标题号（展示用统一编号）
  relation: string; // 当局关系标签
  affinityDelta: number; // 当局亲疏增量
  trustDelta: number; // 当局信任增量
  affinity: number; // 当局结算后累计亲疏
  trust: number; // 当局结算后累计信任
  note: string; // 当局关键事件一句
  backfill: boolean; // true=追溯回填（历史对局事后蒸馏，区别于赛后实时回写）
  createdAt: string;
}

/** 赛后自动书写认知笔记设置（人格详情「认知笔记」页签的开关；null=关闭） */
export interface AutoCognitionSetting {
  enabled: boolean;
  includeReports: boolean; // 书写时允许读心理检查报告
  includeDrift: boolean; // 允许读成长变化（人话版漂移）
}

// ---------- 自我认知笔记（沿革版本化；人格第一人称书写，取代「人格精粹」心智定位） ----------
export interface PersonaCognitionNote {
  id: number;
  personaId: number;
  content: string;
  model: string; // 书写所用模型
  opts: { includeReports?: boolean; includeDrift?: boolean }; // 可见性开关快照
  gameCount: number; // 书写时的参战局数
  createdAt: string;
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

/** 铸造产出的结构化原作关系（2026-10-22：必须在 zod 层保留，否则 API 入库静默剥离） */
export const canonRelationSchema = z.object({
  name: z.string().trim().min(1).max(64),
  aliases: z.array(z.string().trim().max(64)).max(20).optional(),
  kind: z.string().trim().max(32).optional(),
  kindSource: z.string().trim().max(8).optional(),
  positivity: z.number().int().min(0).max(100).optional(),
  negativity: z.number().int().min(0).max(100).optional(),
  trust: z.number().int().min(0).max(100).optional(),
  closeness: z.number().int().min(0).max(100).optional(),
  dependence: z.number().int().min(0).max(100).optional(),
  reciprocity: z.number().int().min(0).max(100).optional(),
  powerBalance: z.number().int().min(-100).max(100).optional(),
  formality: z.number().int().min(0).max(100).optional(),
  commitment: z.number().int().min(0).max(100).optional(),
  addressTerm: z.string().max(64).optional(),
  addressKind: z.enum(["neutral", "intimate", "honorific", "derogatory"]).optional(),
  basis: z.string().max(300).optional(),
});

/** 昵称库（披露深度四层，§17；2026-10-22 补齐契约，此前类型缺失） */
export const nicknameSchema = z.object({
  text: z.string().trim().min(1).max(128),
  layer: z.enum(["public", "intimate", "private", "secret"]),
  awareness: z.enum(["all", "private", "self"]).default("all"),
  usage: z.enum(["all", "threshold", "specific", "self"]).default("all"),
  threshold: z.number().int().min(0).max(100).optional(),
  allowedIds: z.array(z.number().int().positive()).max(200).optional(),
  power: z.enum(["equal", "upward", "downward"]).optional(),
  tone: z.enum(["intimate", "honorific", "derogatory", "neutral"]).optional(),
  publicUse: z.boolean().optional(),
  coOwners: z.array(z.number().int().positive()).max(200).optional(),
});

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
  gender: z.string().max(8).optional(),
  summary: z.string().max(4000),
  persona: z.string().max(4000),
  experiences: z.string().max(8000),
  relationships: z.string().max(4000),
  // ---- 2026-10-22：铸造结构化产物必须保留（否则 §19 建边链路静默失效）----
  canonRelations: z.array(canonRelationSchema).max(200).nullable().optional(),
  selfAliases: z.array(z.string().trim().max(64)).max(50).nullable().optional(),
  nicknames: z.array(nicknameSchema).max(50).nullable().optional(),
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
    gender: "",
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

// ============================================================
// 人格演化动力学（v2 优化）
// 文献依据：
// - Roberts, Walton & Viechtbauer (2006) 成熟原则：成年期宜人性↑、尽责性↑、神经质↓
// - Roberts et al. (2017) Psychological Bulletin：数周干预改变人格约 0.5 SD（单局应远小于此）
// - Fleeson (2001) / Fleeson & Jayawickreme (2015) Whole Trait Theory：特质=状态密度分布
// - Mischel & Shoda (1995) CAPS：人格不变性在于 if–then 情境-行为签名
// - Jayawickreme & Blackie (2014) 创伤后成长：痛苦与成长并存，不互相抵消
// - Fraley et al. (2011)：依恋的稳定性高于大五
// - Russell (1980) 情绪环状模型：情绪 = valence × arousal 二维
// ============================================================

/** 参数硬钳位：铁律1「所有维度 0-100 连续量化」。漂移链路的最终防线。 */
export function clampParam(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, Math.round(v)));
}

/** 分层漂移幅度上限（单局·单参数）—— **v3 收紧（M2）**，按文献标定：
 *  特质层（大五）±1；依恋 ±0.5（Fraley et al. 2011：依恋比大五更稳定）；
 *  适应层（黑暗四联/SDT）±2；状态层（情绪调节/防御/认知偏差）±4。
 *  ⚠️ 这是**安全网**，不是主控：主控是 §4.3 的 EWMA。 */
export const DRIFT_LIMIT_BY_GROUP: Readonly<Record<string, number>> = {
  bigFive: 1,
  attachment: 0.5,
  darkTetrad: 2,
  sdt: 2,
  emotionRegulation: 4,
  defenseMechanisms: 4,
  cognitiveBiases: 4,
};

/**
 * 小数累积器（EWMA 微小位移的落账缓冲）。
 *
 * 为什么必须有：α_eff 使单局位移常 **< 0.5 分**，而参数为 0-100 整数，
 * 直接取整会把它吃成 0 —— 机制在数学上正确、在实践中等于零。
 * 累积器把不足 1 分的位移留存到后续对局，这正是
 * 「反复小经历累积」的动力学（Dugan et al. 2023）。
 *
 * 稳定性：delta 非有限值按 0 处理；余数**严格有界** [-1, 1]，绝不增长。
 */
export function accumulateStep(
  residual: number,
  delta: number,
): { step: number; residual: number } {
  const r0 = Number.isFinite(residual) ? Math.max(-1, Math.min(1, residual)) : 0;
  const d0 = Number.isFinite(delta) ? delta : 0;
  const acc = r0 + d0;
  const step = Math.trunc(acc);
  const rest = acc - step;
  return { step, residual: Math.max(-1, Math.min(1, Number.isFinite(rest) ? rest : 0)) };
}

/** 取某参数路径所属层级的单局漂移上限（未知层级按适应层 ±2） */
export function driftLimitOf(path: string): number {
  const group = path.split(/[.[]/)[0] ?? "";
  return DRIFT_LIMIT_BY_GROUP[group] ?? 2;
}

/** 单局全部漂移 |delta| 总和上限：一局不应改写过多维度 */
export const DRIFT_BUDGET_PER_GAME = 12;

/** 演化机制版本：写入 persona_trait_updates.mechanism_version（跨版本比较 / 复现） */
export const EVOLUTION_MECHANISM_VERSION = "ewma-3.0";

// ============================================================
// §4.3 状态 → 特质 的分布更新（EWMA，取代「LLM 提议 delta」）
// ------------------------------------------------------------
//   trait ← trait + α_eff × (state − trait)
//   α_eff = α_base × φ(重复) × ψ(预测误差) × κ(易感) × 评价调节
//
// 为什么 EWMA 是对的（逐条对应证据）：
//   · 单次重大事件可改变轨迹      ← 高 salience → ψ 提升（Dugan 2023）
//   · 反复小经历累积              ← 同情境同向重复 → φ 稳步上升（Dugan 2023）
//   · 场合噪声被压制              ← 小 α_eff 即低通滤波（LST / Steyer）
//   · 排序稳定自动保持            ← 以自身特质为先验的贝叶斯式更新（Roberts & DelVecchio 2000）
//   · 不需要回归项                ← EWMA 本身即「以既有特质为先验」（Diener 2006）
//   · 个体适应不同                ← κ 与评价调节按人格取值（Diener 2006 / Bucciol 2024）
// ============================================================

/** EWMA 基础学习率（Q7：不设固定值，用实证包络校准；初始 0.03） */
export const ALPHA_BASE = 0.03;

/** α_eff 的四个乘性因子（各自有界，见 §4.3） */
export interface AlphaFactors {
  /** 同情境·同向重复**次数**（原始计数；内部经 repeatFactor 换算为 φ，凹且饱和 —— Dugan 2023） */
  repeatCount: number;
  /** ψ：预测误差 |state − trait|（烈度/惊讶度，封顶 —— Dugan 2023；Damian 2020 警告） */
  salience: number;
  /** κ：易感异质（Diener 2006）；无数据时取 1 */
  kappa: number;
  /** 评价调节：防御成熟度 · 情绪调节 · SDT 控制信念（Bucciol 2024） */
  appraisal: number;
}

/** φ(重复次数)：凹且饱和 —— 首次影响小、反复累积但永不超过 1 */
export function repeatFactor(repeats: number): number {
  const n = Math.max(0, repeats);
  return 1 - Math.exp(-n / 3);
}

/** ψ(预测误差)：|state − trait| 越大冲击越强，下限 0.2、封顶 1 */
export function salienceFactor(state: number, trait: number): number {
  return Math.min(1, Math.max(0.2, Math.abs(state - trait) / 50));
}

/** 评价调节：重评/成熟防御缓冲冲击，反刍放大冲击（Bucciol 2024） */
export const APPRAISAL_MIN = 0.5;
export const APPRAISAL_MAX = 1.5;
export function appraisalFactor(o: {
  cognitiveReappraisal?: number; // 0-100
  rumination?: number; // 0-100
  defenseMaturity?: number; // 0-1（成熟防御占比）
}): number {
  const z = (v: number | undefined) => ((v ?? 50) - 50) / 50; // ∈ [-1, 1]
  const raw = 1 - 0.3 * z(o.cognitiveReappraisal) + 0.3 * z(o.rumination) - 0.2 * (o.defenseMaturity ?? 0.5) * 2 + 0.2;
  return Math.min(APPRAISAL_MAX, Math.max(APPRAISAL_MIN, raw));
}

/** α_eff：四因子合成，并施加实证上限（由 Roberts et al. 2017 反推） */
export const ALPHA_EFF_MAX = 0.15;
export function alphaEff(f: Partial<AlphaFactors>): number {
  const v =
    ALPHA_BASE *
    repeatFactor(f.repeatCount ?? 1) * // ← 次数经 φ 换算（凹、饱和）
    (f.salience ?? 1) *
    (f.kappa ?? 1) *
    (f.appraisal ?? 1);
  return Math.max(0, Math.min(ALPHA_EFF_MAX, v));
}

/** 极值阻尼（人格弹性）：距边界 EXTREME_EDGE 内同向漂移线性衰减，
 *  防止人格因重复同类事件被推向 0/100 的极端。 */
export const EXTREME_EDGE = 40;
export function elasticDelta(value: number, delta: number): number {
  const room = delta > 0 ? 100 - value : value;
  const factor = Math.min(1, Math.max(0, room) / EXTREME_EDGE);
  return factor === 0 ? 0 : delta * factor; // 触界时返回 +0（避免 -0 污染）
}

/**
 * 演化合成（v3 · EWMA）：以「本局表现出的状态」更新特质。
 *
 * @param current 当前特质值
 * @param state   本局该维度的**表现水平**（0-100，由心镜/回写报告，非 delta）
 * @param path    参数路径（决定层级上限）
 * @param factors α_eff 的四个因子
 *
 * ⚠️ **已退役「成熟拉力」**（maturityPull）：人工成熟向量缺乏证据，
 *    改由**制度**（社会投资）驱动成熟，见 §8 战队锦标赛。
 */
export function evolveParam(
  current: number,
  state: number,
  path: string,
  factors: Partial<AlphaFactors> = {},
): { value: number; delta: number; alphaEff: number; factors: AlphaFactors } {
  const f: AlphaFactors = {
    repeatCount: factors.repeatCount ?? 1,
    // ψ 默认按「本局状态与自身特质的差距」自动计算（烈度/惊讶度）
    salience: factors.salience ?? salienceFactor(state, current),
    kappa: factors.kappa ?? 1,
    appraisal: factors.appraisal ?? 1,
  };
  const a = alphaEff(f);
  const limit = driftLimitOf(path);
  const rawDelta = a * (state - current);
  // 安全网：单局单参数上限（EWMA 通常远小于此）
  const capped = Math.max(-limit, Math.min(limit, rawDelta));
  const damped = elasticDelta(current, capped);
  // ⚠️ 关键：α_eff 使单局位移常 < 0.5 分，直接取整会被吃成 0（机制失效）。
  // 因此**同时返回未取整的浮点 delta**，由调用方用「小数累积器」逐步落账——
  // 这恰好实现了「反复小经历累积」的动力学（Dugan 2023）。
  return { value: clampParam(current + damped), delta: damped, alphaEff: a, factors: f };
}

/** 完整可漂移参数面板（扁平 path=value），供记事簿漂移参考。
 *  修复原实现只注入 bigFive、导致漂移维度单一的缺陷。 */
export function formatDriftPanel(params: PersonaParams): string {
  const out: string[] = [];
  // 路径格式必须与 getParamValue/setParamValue 一致（group.key）：
  // 数组型参数用 group.<id>（第三个点段被解析器忽略），绝不能用 [index]
  const plain = (group: string, obj: object): void => {
    for (const [k, v] of Object.entries(obj)) if (typeof v === "number") out.push(`${group}.${k}=${v}`);
  };
  plain("bigFive", params.bigFive);
  plain("attachment", params.attachment);
  plain("darkTetrad", params.darkTetrad);
  plain("emotionRegulation", params.emotionRegulation);
  plain("sdt", params.sdt);
  for (const b of params.cognitiveBiases) out.push(`cognitiveBiases.${b.id}=${b.strength}`);
  for (const d of params.defenseMechanisms) out.push(`defenseMechanisms.${d.id}=${d.tendency}`);
  return out.join("，");
}

/** 创建对局时的座位人格绑定（seat 1-based；personaId 指向人格研究站的卡） */
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

/**
 * 心镜中的「对人」条目（§24 修复的第 4 层断裂）。
 * 设计文档：docs/interpersonal-graph-design.md §5/§23/§24
 * 没有这个字段时，关系网的数据无法到达决策层——三笠对艾伦「毕生所爱」
 * 而落刀时却毫无波澜，根因即此。
 */
export interface MirrorBond {
  /** 对谁（用对方名字，与在场座位绑定） */
  toward: string;
  /** 此刻对 TA 的真实感受（大白话，禁止心理学术语） */
  feel: string;
  /** 由此产生的冲动（想做什么 / 不想做什么） */
  urge: string;
}

export interface MirrorReport {
  pressures: MirrorPressure[]; // 被情境点燃的参数（≥1，铁律2）
  tensions: TensionGroup[]; // 当前撕裂（可多组，铁律6）
  defenses: MirrorDefense[]; // 被触发的防御机制（可为空）
  trauma: string | null; // 被唤醒的创伤记忆（无则 null）
  impulse: string; // 此刻最想做的事（一句，心镜的冲动原稿）
  selfControl: number; // 自控余量 0-100（低=涌现更失控）
  /** 对在场者的真实感受（可为空；缺省时视为无特别感受） */
  bonds?: MirrorBond[];
}

/** 涌现事件注解（落 event.meta.persona）：双视角解释（铁律4）+ 撕裂摘要（观察者展示） */
export interface PersonaEventMeta {
  name: string; // 人格名
  dual: boolean; // true=双程管线（心镜→涌现）；false=小上下文模型单程合并
  tensions: { poles: string[]; intensity: number }[]; // 撕裂组标签（如 ["宜人性 20 ⇄ 马基雅维利 85"]）
  gt: string; // 博弈论解释（一句）
  psy: string; // 人格动力学解释（一句）
  contextVersion?: string; // 本局人格上下文版本（观察者审计，不进人物可见文本）
  degraded?: string[]; // 小上下文预算下被整块降级的材料；空数组=无降级
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
  interrupted?: boolean; // 已中断（进程死亡/断电导致；检查点已落盘，可从断点续铸）
  saved?: boolean; // 已核销入库（草稿与留痕仍保留在草稿箱，仅用户主动删除才清）
}

/** 生成留痕的阶段标记（persona.castTrace 返回；text 为该阶段已落盘的研究文本，无则 undefined） */
export interface CastTraceStage {
  key: string; // params/research/pool/dossier/reading/portraits/draft
  label: string; // 人话阶段名（配置确认/身份核对/素材检索/研究档案/人格解读/肖像甄选/整合定稿）
  available: boolean; // 该阶段是否已有落盘产物可看
  text?: string; // 已生成的研究文本（服务端已脱敏/截断；portraits 只给数量摘要）
}

/** 生成留痕（草稿箱/生成中卡片共用）：进度标记点 + 各阶段文本 */
export interface CastTrace {
  castId: string;
  name: string;
  status: string; // queued/running/paused/interrupted/failed/done/saved
  stages: CastTraceStage[];
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
