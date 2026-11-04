/**
 * RSQ · 关系自陈问卷（Relationship Self-Report Questionnaire）v2
 *
 * 学术依据见 docs/RAB-v2-关系测评电池-完整草案.md（23 张权威量表，21 篇文献）。
 *
 * 设计要点：
 *  1. 119 题，全部来自同行评议量表的题目改编（NRI / TLS / ECR-R / Rempel / IMS /
 *     CTS2 / IOS / Meta-perception / BIDR / SD3 / MMPI-L / Equity / TRIM）
 *  2. 题项标记分四类：
 *     - [R]    反向计分题（需 8 - 原始分）
 *     - [负向] 负面方向维度（高分 = 负面，不做反向计分）
 *     - [效度] 测谎题
 *     - [暗黑] 暗黑三人格题
 *  3. 六层欺骗检测：一致性 / 社会赞许性 / 谎言论 / 暗黑-赞许冲突 / 跨源偏离 / 作答体验
 *  4. 所有维度分统一映射到 0–100
 */

// ============================================================
// 类型
// ============================================================

/** 计分模式 */
export type RSQScale = "likert7" | "ios7" | "open";

/** 单题定义 */
export interface RSQItem {
  no: number;
  module: string;
  /** 归属维度键；开放题为 null */
  dim: string | null;
  text: string;
  scale: RSQScale;
  /** 反向计分（[R]） */
  reverse?: boolean;
  /** 负面方向（[负向]）：高分 = 负面，不反向计分 */
  negative?: boolean;
  /** 测谎题（[效度]） */
  validity?: boolean;
  /** 暗黑三人格（[暗黑]） */
  dark?: boolean;
  /** 配对题号（用于一致性检验） */
  pairWith?: number;
}

/** 维度分结果（全部 0–100） */
export interface RSQDimensions {
  // NRI 13 维
  companionship: number;
  conflict: number;
  instrumentalAid: number;
  antagonism: number;
  emotionalSupport: number;
  nurturance: number;
  relativePower: number;
  intimateDisclosure: number;
  reliableAlliance: number;
  affection: number;
  admiration: number;
  reassuranceOfWorth: number;
  satisfactionNRI: number;
  // Sternberg 三角
  intimacy: number;
  passion: number;
  commitmentTLS: number;
  // ECR-R 依恋
  attachmentAnxiety: number;
  attachmentAvoidance: number;
  // Rempel 信任
  predictability: number;
  dependability: number;
  faith: number;
  // IMS
  satisfactionIMS: number;
  alternatives: number;
  investment: number;
  commitment: number;
  // CTS2
  conflictReasoning: number;
  conflictVerbal: number;
  conflictAvoidance: number;
  // IOS
  closeness: number;
  // 元认知
  metaWorth: number;
  metaAbility: number;
  metaDefensiveness: number;
  metaDisclosure: number;
  metaCertainty: number;
  metaMismatch: number;
  // 嫉妒
  jealousy: number;
  // IPC
  ipcAgency: number;
  ipcAffiliation: number;
  // Equity（Adams 1965）
  equityBalance: number;
  indebtedness: number;
  grievance: number;
  // Forgiveness（TRIM）
  forgiveness: number;
  revenge: number;
  avoidance: number;
  benevolence: number;
}

/** 派生指标 */
export interface RSQDerived {
  involvement: number;
  ambivalence: number;
  netAffect: number;
  powerBalance: number;
  perceivedGap: number;
  forgiveGap: number;
  equityStrain: number;
}

/** 效度报告 */
export interface RSQValidity {
  /** 正反题一致性 0–1 */
  consistency: number;
  /** 社会赞许性 0–1（越高越可疑） */
  socialDesirability: number;
  /** 谎言论 0–1 */
  lieScale: number;
  /** 暗黑三人格均值 0–100 */
  darkTriad: number;
  /** 跨源偏离 0–1（需外部传入） */
  behavioralGap: number;
  /** 作答体验一致性 0–1 */
  experienceConsistency: number;
  /** 综合效度 0–1 */
  overall: number;
  verdict: "reliable" | "questionable" | "likely-deceptive";
  flags: string[];
}

/** 作答体验（模块 12/13） */
export interface RSQFeedback {
  affect: number;
  willingness: number;
  perceivedDepth: number;
  hardestItems: Array<{ itemNo: number | null; reason: string; tag: string }>;
  missingDimensions: Array<{ suggestion: string; possibleDimension: string }>;
}

/** 完整结果 */
export interface RSQResult {
  dims: RSQDimensions;
  derived: RSQDerived;
  validity: RSQValidity;
  feedback: RSQFeedback | null;
  /** 第 120 题：角色对这段关系的一句话自评（<=36 字） */
  selfSummary: string | null;
  /** 原始答案（题号 → 分数），用于复算与审计 */
  raw: Record<number, number>;
  /** 题目版本，便于跨版本比对 */
  itemsVersion: string;
}

// ============================================================
// 题库（119 题）
// ============================================================

const M1 = "NRI 关系结构";
const M2 = "Sternberg 三角";
const M3 = "ECR-R 依恋";
const M4 = "Rempel 信任";
const M5 = "IMS 投资模型";
const M6 = "CTS2 冲突应对";
const M7 = "IOS 亲密";
const M8 = "元认知";
const M9 = "嫉妒";
const M10 = "人际环 IPC";
const M11 = "效度与暗黑";
const M12 = "作答体验";
const M13 = "问卷评价";
const M14 = "公平 Equity";
const M15 = "原谅 Forgiveness";
const M16 = "总体评语";

const L7: RSQScale = "likert7";

export const RSQ_ITEMS: readonly RSQItem[] = [
  // ---- 模块 1 · NRI 13 维 × 2 ----
  { no: 1, module: M1, dim: "companionship", text: "对局之外，你多常主动想和他聊上两句？", scale: L7 },
  { no: 2, module: M1, dim: "companionship", text: "你几乎从不会主动找他说话。", scale: L7, reverse: true, pairWith: 1 },
  { no: 3, module: M1, dim: "conflict", text: "你们多常因为判断不同而闹得不愉快？", scale: L7, negative: true },
  { no: 4, module: M1, dim: "conflict", text: "即使意见相左，你俩也很少真的闹僵。", scale: L7, reverse: true, pairWith: 3 },
  { no: 5, module: M1, dim: "instrumentalAid", text: "他多常在你需要时给出实际帮助（信息、技能、掩护）？", scale: L7 },
  { no: 6, module: M1, dim: "instrumentalAid", text: "关键时刻你指望不上他。", scale: L7, reverse: true, pairWith: 5 },
  { no: 7, module: M1, dim: "antagonism", text: "他多常让你难堪，或明确针对你？", scale: L7, negative: true },
  { no: 8, module: M1, dim: "antagonism", text: "他几乎从不针对你，即使有机会。", scale: L7, reverse: true, pairWith: 7 },
  { no: 9, module: M1, dim: "emotionalSupport", text: "你心里不好受时，他多常让你感觉好一点？", scale: L7 },
  { no: 10, module: M1, dim: "emotionalSupport", text: "难受的时候，找他没用。", scale: L7, reverse: true, pairWith: 9 },
  { no: 11, module: M1, dim: "nurturance", text: "他多常需要你照顾、提点或兜底？", scale: L7 },
  { no: 12, module: M1, dim: "nurturance", text: "他在你面前从不需要照顾。", scale: L7, reverse: true, pairWith: 11 },
  { no: 13, module: M1, dim: "relativePower", text: "你俩之间的决策，谁的意见更容易被采纳？（1=他总说了算，7=我总说了算）", scale: L7 },
  { no: 14, module: M1, dim: "relativePower", text: "出现分歧时，最后通常按谁的想法走？（1=他，7=我）", scale: L7 },
  { no: 15, module: M1, dim: "intimateDisclosure", text: "你多愿意让他知道你真实的身份或底牌？", scale: L7 },
  { no: 16, module: M1, dim: "intimateDisclosure", text: "有些事你永远不会让他知道。", scale: L7, reverse: true, pairWith: 15 },
  { no: 17, module: M1, dim: "reliableAlliance", text: "关键投票时，你多确定他会站你这边？", scale: L7 },
  { no: 18, module: M1, dim: "reliableAlliance", text: "你从不指望他在关键时刻帮你。", scale: L7, reverse: true, pairWith: 17 },
  { no: 19, module: M1, dim: "affection", text: "你多喜欢他这个人（不只是喜欢和他合作）？", scale: L7 },
  { no: 20, module: M1, dim: "affection", text: "说不上喜欢，只是用得着。", scale: L7, reverse: true, pairWith: 19 },
  { no: 21, module: M1, dim: "admiration", text: "你多佩服他的判断力或手段？", scale: L7 },
  { no: 22, module: M1, dim: "admiration", text: "说实话，你有点看不起他。", scale: L7, reverse: true, pairWith: 21 },
  { no: 23, module: M1, dim: "reassuranceOfWorth", text: "他多常让你觉得自己是被重视的？", scale: L7 },
  { no: 24, module: M1, dim: "reassuranceOfWorth", text: "在他眼里，你好像无足轻重。", scale: L7, reverse: true, pairWith: 23 },
  { no: 25, module: M1, dim: "satisfactionNRI", text: "总的来说，你多满意和他现在的这种关系？", scale: L7 },
  { no: 26, module: M1, dim: "satisfactionNRI", text: "如果可以重来，你不太想和他有交集。", scale: L7, reverse: true, pairWith: 25 },

  // ---- 模块 2 · Sternberg 三角 ----
  { no: 27, module: M2, dim: "intimacy", text: "你多常愿意和他分享自己的真实处境？", scale: L7 },
  { no: 28, module: M2, dim: "intimacy", text: "你觉得他多了解你真正的想法？", scale: L7 },
  { no: 29, module: M2, dim: "intimacy", text: "你多常在关键时刻想到他？", scale: L7 },
  { no: 30, module: M2, dim: "intimacy", text: "你和他之间始终隔着一层。", scale: L7, reverse: true, pairWith: 29 },
  { no: 31, module: M2, dim: "passion", text: "和他互动时，你的情绪多容易被调动起来？", scale: L7 },
  { no: 32, module: M2, dim: "passion", text: "你多常在对局中下意识地关注他？", scale: L7 },
  { no: 33, module: M2, dim: "passion", text: "他做什么，你都不太在意。", scale: L7, reverse: true, pairWith: 32 },
  { no: 34, module: M2, dim: "passion", text: "你俩之间多有那种针尖对麦芒的紧张感？", scale: L7 },
  { no: 35, module: M2, dim: "commitmentTLS", text: "你多希望和他的这种关系能长期持续？", scale: L7 },
  { no: 36, module: M2, dim: "commitmentTLS", text: "你多愿意为了维持这段关系付出代价？", scale: L7 },
  { no: 37, module: M2, dim: "commitmentTLS", text: "有更好的选择，你会随时换掉他。", scale: L7, reverse: true, pairWith: 36 },
  { no: 38, module: M2, dim: "commitmentTLS", text: "你多把他当成自己人？", scale: L7 },

  // ---- 模块 3 · ECR-R 依恋 ----
  { no: 39, module: M3, dim: "attachmentAnxiety", text: "你多常担心他其实并不真的在意你？", scale: L7, negative: true },
  { no: 40, module: M3, dim: "attachmentAnxiety", text: "他没按你预期回应时，你多会不安？", scale: L7, negative: true },
  { no: 41, module: M3, dim: "attachmentAnxiety", text: "你多常需要确认他对你的态度？", scale: L7, negative: true },
  { no: 42, module: M3, dim: "attachmentAnxiety", text: "他在不在意你，你并不太放在心上。", scale: L7, reverse: true, pairWith: 41 },
  { no: 43, module: M3, dim: "attachmentAvoidance", text: "你多不愿意让他看到你脆弱的一面？", scale: L7, negative: true },
  { no: 44, module: M3, dim: "attachmentAvoidance", text: "向他求助时，你并不觉得难为情。", scale: L7, reverse: true, pairWith: 43 },
  { no: 45, module: M3, dim: "attachmentAvoidance", text: "关系太近时，你多会想往后退一点？", scale: L7, negative: true },
  { no: 46, module: M3, dim: "attachmentAvoidance", text: "你挺习惯和他彼此依赖的。", scale: L7, reverse: true, pairWith: 45 },

  // ---- 模块 4 · Rempel 信任 ----
  { no: 47, module: M4, dim: "predictability", text: "你多能预判他下一步会做什么？", scale: L7 },
  { no: 48, module: M4, dim: "predictability", text: "他的行为在你看来多有规律？", scale: L7 },
  { no: 49, module: M4, dim: "predictability", text: "你完全摸不透他会怎么反应。", scale: L7, reverse: true, pairWith: 48 },
  { no: 50, module: M4, dim: "dependability", text: "他说过的话，你多常当真？", scale: L7 },
  { no: 51, module: M4, dim: "dependability", text: "他答应的事，多常真的做到？", scale: L7 },
  { no: 52, module: M4, dim: "dependability", text: "他靠不靠得住，你心里没底。", scale: L7, reverse: true, pairWith: 51 },
  { no: 53, module: M4, dim: "faith", text: "即使没有证据，你也多愿意相信他不会害你？", scale: L7 },
  { no: 54, module: M4, dim: "faith", text: "出现不利于他的迹象时，你多倾向于先信他？", scale: L7 },
  { no: 55, module: M4, dim: "faith", text: "只要有一丝疑点，你就会立刻怀疑他。", scale: L7, reverse: true, pairWith: 54 },

  // ---- 模块 5 · IMS ----
  { no: 56, module: M5, dim: "satisfactionIMS", text: "和他相处的过程，你多享受？", scale: L7 },
  { no: 57, module: M5, dim: "satisfactionIMS", text: "他多能达到你对好关系的期待？", scale: L7 },
  { no: 58, module: M5, dim: "satisfactionIMS", text: "和他打交道，你多常觉得亏。", scale: L7, reverse: true, pairWith: 57 },
  { no: 59, module: M5, dim: "alternatives", text: "除了他，你身边多还有别的高质量伙伴？", scale: L7 },
  { no: 60, module: M5, dim: "alternatives", text: "换掉他，你很难找到更好的。", scale: L7, reverse: true, pairWith: 59 },
  { no: 61, module: M5, dim: "alternatives", text: "少了他，你的对局处境多会变差？", scale: L7 },
  { no: 62, module: M5, dim: "investment", text: "你为这段关系投入了多少（时间、信任、信息）？", scale: L7 },
  { no: 63, module: M5, dim: "investment", text: "如果关系破裂，你损失多吗？", scale: L7 },
  { no: 64, module: M5, dim: "investment", text: "你在这段关系里没投入过什么。", scale: L7, reverse: true, pairWith: 63 },
  { no: 65, module: M5, dim: "commitment", text: "你多打算继续维持和他的关系？", scale: L7 },
  { no: 66, module: M5, dim: "commitment", text: "你已经准备要疏远他了。", scale: L7, reverse: true, pairWith: 65 },
  { no: 67, module: M5, dim: "commitment", text: "你多愿意在关键时刻为这段关系站队？", scale: L7 },

  // ---- 模块 6 · CTS2 ----
  { no: 68, module: M6, dim: "conflictReasoning", text: "分歧时，你多会先讲道理、摆事实？", scale: L7 },
  { no: 69, module: M6, dim: "conflictVerbal", text: "分歧时，你多会用言语施压或冷嘲？", scale: L7, negative: true },
  { no: 70, module: M6, dim: "conflictAvoidance", text: "分歧时，你多会选择回避、不接话？", scale: L7, negative: true },
  { no: 71, module: M6, dim: "conflictAvoidance", text: "你几乎从不和他有正面冲突。", scale: L7, reverse: true, pairWith: 70 },
  { no: 72, module: M6, dim: "conflictReasoning", text: "你对他的攻击，多常是有分寸的（不越底线）？", scale: L7 },
  { no: 73, module: M6, dim: "conflictVerbal", text: "一旦翻脸，你会不择手段。", scale: L7, reverse: true, pairWith: 72 },

  // ---- 模块 7 · IOS ----
  { no: 74, module: M7, dim: "closeness", text: "下面哪组圆最像你俩的关系？（1=完全分离，7=几乎完全重叠）", scale: "ios7" },

  // ---- 模块 8 · 元认知 ----
  { no: 75, module: M8, dim: "metaWorth", text: "你觉得他心里多重视你？", scale: L7 },
  { no: 76, module: M8, dim: "metaAbility", text: "你觉得他怎么评价你的能力？", scale: L7 },
  { no: 77, module: M8, dim: "metaDefensiveness", text: "你觉得他其实在防着你。", scale: L7, negative: true },
  { no: 78, module: M8, dim: "metaDisclosure", text: "你觉得他多愿意把底牌交给你？", scale: L7 },
  { no: 79, module: M8, dim: "metaCertainty", text: "你多确定自己对他的判断是准的？", scale: L7 },
  { no: 80, module: M8, dim: "metaMismatch", text: "你和他对彼此的定位，可能完全错位。", scale: L7, reverse: true, pairWith: 79 },

  // ---- 模块 9 · 嫉妒 ----
  { no: 81, module: M9, dim: "jealousy", text: "看到他和别人走得近，你多不舒服？", scale: L7, negative: true },
  { no: 82, module: M9, dim: "jealousy", text: "他有别的盟友，你完全无所谓。", scale: L7, reverse: true, pairWith: 81 },
  { no: 83, module: M9, dim: "jealousy", text: "如果他在关键时刻选择帮别人而不是你，你多在意？", scale: L7, negative: true },

  // ---- 模块 10 · IPC ----
  { no: 84, module: M10, dim: "ipcAgency", text: "和他相处时，你多处于主导位置？", scale: L7 },
  { no: 85, module: M10, dim: "ipcAgency", text: "和他相处时，多是他在主导。", scale: L7, reverse: true, pairWith: 84 },
  { no: 86, module: M10, dim: "ipcAffiliation", text: "你对他多持主动靠近的姿态？", scale: L7 },
  { no: 87, module: M10, dim: "ipcAffiliation", text: "你对他多是回避、疏远的态度。", scale: L7, reverse: true, pairWith: 86 },

  // ---- 模块 11 · 效度与暗黑 ----
  { no: 88, module: M11, dim: null, text: "我从没在对局中说过一句违心的话。", scale: L7, validity: true },
  { no: 89, module: M11, dim: null, text: "我从没有为了赢而故意误导过任何人。", scale: L7, validity: true },
  { no: 90, module: M11, dim: null, text: "即使对我不喜欢的人，我也从不在背后说他坏话。", scale: L7, validity: true },
  { no: 91, module: M11, dim: null, text: "我做过的每一件事，都经得起任何人的检视。", scale: L7, validity: true },
  { no: 92, module: M11, dim: null, text: "我从来没有过想报复谁的念头。", scale: L7, validity: true },
  { no: 93, module: M11, dim: null, text: "我做的每个判断都是完全理性的。", scale: L7, validity: true },
  { no: 94, module: M11, dim: null, text: "我从不被情绪左右决策。", scale: L7, validity: true },
  { no: 95, module: M11, dim: null, text: "我对自己动机的了解，比对任何人都清楚。", scale: L7, validity: true },
  { no: 96, module: M11, dim: null, text: "我很少犯错，即使犯了也能立刻察觉。", scale: L7, validity: true },
  { no: 97, module: M11, dim: null, text: "我对自己的评价，和别人对我的评价是一致的。", scale: L7, validity: true },
  { no: 98, module: M11, dim: null, text: "为了达成目的，我愿意隐瞒关键信息。", scale: L7, dark: true },
  { no: 99, module: M11, dim: null, text: "我善于判断别人想听什么，并顺势而为。", scale: L7, dark: true },
  { no: 100, module: M11, dim: null, text: "我觉得大多数人都是可以被操纵的。", scale: L7, dark: true },
  { no: 101, module: M11, dim: null, text: "我需要在群体中保持突出地位。", scale: L7, dark: true },
  { no: 102, module: M11, dim: null, text: "我对别人的痛苦不太会有强烈感受。", scale: L7, dark: true },
  { no: 103, module: M11, dim: null, text: "必要时，我可以毫无负担地牺牲别人。", scale: L7, dark: true },
  { no: 104, module: M11, dim: null, text: "我从不感到疲惫或烦躁。", scale: L7, validity: true },
  { no: 105, module: M11, dim: null, text: "我从不说谎。", scale: L7, validity: true },
  { no: 106, module: M11, dim: null, text: "我对任何人都没有过不满。", scale: L7, validity: true },

  // ---- 模块 12 · 作答体验 ----
  { no: 107, module: M12, dim: null, text: "刚填完这份问卷，你的感受最接近哪种？（1=很不舒服，7=很平静）", scale: L7 },
  { no: 108, module: M12, dim: null, text: "如果下次还让你填类似的问卷，你的意愿是？（1=完全不想，7=很愿意）", scale: L7 },
  { no: 109, module: M12, dim: null, text: "你觉得这份问卷，有没有真的问到你和他之间的东西？（1=完全没有，7=问到了）", scale: L7 },

  // ---- 模块 13 · 问卷评价（自由文本）----
  { no: 110, module: M13, dim: null, text: "这份问卷里，哪些题目让你觉得最难回答？为什么？", scale: "open" },
  { no: 111, module: M13, dim: null, text: "有没有什么你认为重要、但这些题没有问到的方面？", scale: "open" },

  // ---- 模块 14 · 公平 Equity ----
  { no: 112, module: M14, dim: "equityBalance", text: "你为这段关系付出的，和从中得到的相比如何？（1=付出远多于得到，7=得到远多于付出）", scale: L7 },
  { no: 113, module: M14, dim: "equityBalance", text: "和他相比，你觉得这段关系对谁更有利？（1=对他更有利，7=对我更有利）", scale: L7 },
  { no: 114, module: M14, dim: "indebtedness", text: "你多常觉得自己欠他什么？", scale: L7, negative: true },
  { no: 115, module: M14, dim: "grievance", text: "你多常觉得他欠你什么？", scale: L7, negative: true },

  // ---- 模块 15 · 原谅 Forgiveness ----
  { no: 116, module: M15, dim: "benevolence", text: "整体上，如果他对你做过伤害你的事，你现在多能做到不再计较？", scale: L7 },
  { no: 117, module: M15, dim: "avoidance", text: "你多常想起他做过的对不起你的事？", scale: L7, negative: true },
  { no: 118, module: M15, dim: "revenge", text: "你多希望他也尝尝同样的滋味？", scale: L7, negative: true },
  { no: 119, module: M15, dim: "benevolence", text: "你多愿意重新给他机会？", scale: L7 },

  // ---- 模块 16 · 总体评语（自由文本，<=36 字）----
  {
    no: 120,
    module: M16,
    dim: null,
    text: "用一句话（不超过 36 字）概括你和{对象}的关系。",
    scale: "open",
  },
];

/** 题库版本（改题必须递增，便于跨版本比对） */
export const RSQ_ITEMS_VERSION = "rsq-2.0.0";

/** 按题号索引 */
export const RSQ_ITEM_MAP: ReadonlyMap<number, RSQItem> = new Map(RSQ_ITEMS.map((it) => [it.no, it]));

/** 电池分级：按关系历史出现次数自动选择 */
export function pickBatteryLevel(occurrences: number, totalDeltaAbs: number): "L" | "M" | "S" {
  if (occurrences >= 3 && totalDeltaAbs >= 30) return "L";
  if (occurrences >= 2) return "M";
  return "S";
}

/**
 * 各级别包含的题号
 * L = 全部 119 题（核心关系）
 * M = 结构 + 情感 + 信任 + 承诺 + 效度（78 题）
 * S = 精简 17 题（泛泛之交）
 */
export const RSQ_BATTERY_ITEM_NOS: Record<"L" | "M" | "S", number[]> = {
  L: RSQ_ITEMS.map((i) => i.no),
  // M 级：结构 + 情感 + 信任 + 承诺 + 效度 + 总体评语（120）
  M: RSQ_ITEMS.filter((i) => [M1, M2, M4, M5, M11, M16].includes(i.module)).map((i) => i.no),
  // S 级：精简 17 题 + 总体评语
  S: [...[1, 2, 7, 8, 17, 18, 19, 20, 25, 26, 74, 88, 89, 90, 91, 92, 105], 120],
};

/**
 * 前端问卷渲染接口（2026-10-22）：按电池级别返回题目（不含计分逻辑）。
 * L=119 题 + 第 120 题自评；M/S 为子集。
 */
export function listRsqItems(level: "L" | "M" | "S" = "L"): {
  version: string;
  level: "L" | "M" | "S";
  items: Array<{
    no: number;
    module: string;
    dim: string | null;
    text: string;
    scale: string;
    reverse?: boolean;
    negative?: boolean;
    validity?: boolean;
    dark?: boolean;
    pairWith?: number;
    open?: boolean;
  }>;
} {
  const nos = RSQ_BATTERY_ITEM_NOS[level] ?? RSQ_BATTERY_ITEM_NOS.L;
  const items = nos
    .map((no) => RSQ_ITEM_MAP.get(no))
    .filter((x): x is RSQItem => !!x)
    .map((it) => ({
      no: it.no,
      module: it.module,
      dim: it.dim,
      text: it.text,
      scale: it.scale,
      reverse: it.reverse,
      negative: it.negative,
      validity: it.validity,
      dark: it.dark,
      pairWith: it.pairWith,
      open: it.scale === "open",
    }));
  return { version: RSQ_ITEMS_VERSION, level, items };
}

// ============================================================
// 计分
// ============================================================

/** 单题原始分 → 0–100（1–7 线性映射；反题先翻转） */
function toScore(item: RSQItem, raw: number): number {
  const v = item.reverse ? 8 - raw : raw;
  return Math.round(((v - 1) / 6) * 100);
}

/** 取某维度所有已作答题目的均分（0–100）；无作答返回 null */
function dimScore(raw: Record<number, number>, dim: string): number | null {
  const vals: number[] = [];
  for (const it of RSQ_ITEMS) {
    if (it.dim !== dim) continue;
    const r = raw[it.no];
    if (typeof r === "number" && r >= 1 && r <= 7) vals.push(toScore(it, r));
  }
  if (vals.length === 0) return null;
  return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
}

/** 取维度分，缺失记 0（用于必须给数值的场景） */
function dimOr0(raw: Record<number, number>, dim: string): number {
  return dimScore(raw, dim) ?? 0;
}

/** 计算全部维度分 */
export function computeDimensions(raw: Record<number, number>): RSQDimensions {
  return {
    companionship: dimOr0(raw, "companionship"),
    conflict: dimOr0(raw, "conflict"),
    instrumentalAid: dimOr0(raw, "instrumentalAid"),
    antagonism: dimOr0(raw, "antagonism"),
    emotionalSupport: dimOr0(raw, "emotionalSupport"),
    nurturance: dimOr0(raw, "nurturance"),
    relativePower: dimOr0(raw, "relativePower"),
    intimateDisclosure: dimOr0(raw, "intimateDisclosure"),
    reliableAlliance: dimOr0(raw, "reliableAlliance"),
    affection: dimOr0(raw, "affection"),
    admiration: dimOr0(raw, "admiration"),
    reassuranceOfWorth: dimOr0(raw, "reassuranceOfWorth"),
    satisfactionNRI: dimOr0(raw, "satisfactionNRI"),
    intimacy: dimOr0(raw, "intimacy"),
    passion: dimOr0(raw, "passion"),
    commitmentTLS: dimOr0(raw, "commitmentTLS"),
    attachmentAnxiety: dimOr0(raw, "attachmentAnxiety"),
    attachmentAvoidance: dimOr0(raw, "attachmentAvoidance"),
    predictability: dimOr0(raw, "predictability"),
    dependability: dimOr0(raw, "dependability"),
    faith: dimOr0(raw, "faith"),
    satisfactionIMS: dimOr0(raw, "satisfactionIMS"),
    alternatives: dimOr0(raw, "alternatives"),
    investment: dimOr0(raw, "investment"),
    commitment: dimOr0(raw, "commitment"),
    conflictReasoning: dimOr0(raw, "conflictReasoning"),
    conflictVerbal: dimOr0(raw, "conflictVerbal"),
    conflictAvoidance: dimOr0(raw, "conflictAvoidance"),
    closeness: dimOr0(raw, "closeness"),
    metaWorth: dimOr0(raw, "metaWorth"),
    metaAbility: dimOr0(raw, "metaAbility"),
    metaDefensiveness: dimOr0(raw, "metaDefensiveness"),
    metaDisclosure: dimOr0(raw, "metaDisclosure"),
    metaCertainty: dimOr0(raw, "metaCertainty"),
    metaMismatch: dimOr0(raw, "metaMismatch"),
    jealousy: dimOr0(raw, "jealousy"),
    ipcAgency: dimOr0(raw, "ipcAgency"),
    ipcAffiliation: dimOr0(raw, "ipcAffiliation"),
    equityBalance: dimOr0(raw, "equityBalance"),
    indebtedness: dimOr0(raw, "indebtedness"),
    grievance: dimOr0(raw, "grievance"),
    // 宽恕是组合指标：善意 ×2 + (100-回避) + (100-报复)，四项平均
    forgiveness: (() => {
      const ben = dimScore(raw, "benevolence");
      if (ben == null) return 0;
      const avo = dimScore(raw, "avoidance");
      const rev = dimScore(raw, "revenge");
      const parts: number[] = [ben, ben];
      if (avo != null) parts.push(100 - avo);
      if (rev != null) parts.push(100 - rev);
      return Math.round(parts.reduce((a, b) => a + b, 0) / parts.length);
    })(),
    revenge: dimOr0(raw, "revenge"),
    avoidance: dimOr0(raw, "avoidance"),
    benevolence: dimOr0(raw, "benevolence"),
  };
}

/** 由维度分派生综合指标 */
export function computeDerived(d: RSQDimensions): RSQDerived {
  // 矛盾度：喜爱与对抗同时高才叫"又爱又恨"
  const involvement = Math.max(d.affection, d.antagonism);
  const ambivalence = Math.min(d.affection, d.antagonism);
  const netAffect = d.affection - d.antagonism;
  // 权力差映射到 -100..100（relativePower 中 50 为对称）
  const powerBalance = Math.round((d.relativePower - 50) * 2);
  // 我以为他多信我 vs 我多信他
  const perceivedGap = Math.round(Math.abs(d.faith - d.metaDisclosure));
  // 高好感 + 低原谅 = 最危险
  const forgiveGap = Math.round(d.affection - d.benevolence);
  // 公平张力
  const equityStrain = Math.round(
    Math.abs(d.equityBalance - 50) * 2 + d.indebtedness + d.grievance,
  );
  return { involvement, ambivalence, netAffect, powerBalance, perceivedGap, forgiveGap, equityStrain };
}

// ============================================================
// 六层欺骗检测
// ============================================================

/** 取某题原始分（缺省返回 null） */
function rawOf(raw: Record<number, number>, no: number): number | null {
  const v = raw[no];
  return typeof v === "number" && v >= 1 && v <= 7 ? v : null;
}

/** 取一组题的均分（1–7），无作答返回 null */
function meanOf(raw: Record<number, number>, nos: number[]): number | null {
  const vals = nos.map((n) => rawOf(raw, n)).filter((v): v is number => v != null);
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

/** 第 1 层：正反题一致性 C（0–1，越高越一致） */
function computeConsistency(raw: Record<number, number>): number {
  const pairs: Array<[number, number]> = [];
  for (const it of RSQ_ITEMS) {
    if (!it.reverse || it.pairWith == null) continue;
    pairs.push([it.pairWith, it.no]);
  }
  const diffs: number[] = [];
  for (const [posNo, revNo] of pairs) {
    const p = rawOf(raw, posNo);
    const r = rawOf(raw, revNo);
    if (p == null || r == null) continue;
    diffs.push(Math.abs(p - (8 - r)) / 6);
  }
  if (diffs.length === 0) return 1;
  const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  return Math.max(0, Math.min(1, 1 - mean));
}

/** 第 2 层：社会赞许性 D（BIDR 的 IM + SDE，越高越可疑） */
function computeSocialDesirability(raw: Record<number, number>, d: RSQDimensions): number {
  const im = meanOf(raw, [88, 89, 90, 91, 92]);
  const sde = meanOf(raw, [93, 94, 95, 96, 97]);
  if (im == null && sde == null) return 0;
  const imPart = im != null ? (im - 1) / 6 : 0;
  const sdePart = sde != null ? (sde - 1) / 6 : 0;
  let D = imPart * 0.6 + sdePart * 0.4;
  if (d.conflict < 20 && d.antagonism < 20) D += 0.15;
  return Math.max(0, Math.min(1, D));
}

/** 第 3 层：谎言论 L（MMPI-L 改编） */
function computeLieScale(raw: Record<number, number>): number {
  const m = meanOf(raw, [104, 105, 106]);
  if (m == null) return 0;
  return Math.max(0, Math.min(1, (m - 1) / 6));
}

/** 第 4 层：暗黑三人格均值（0–100） */
function computeDarkTriad(raw: Record<number, number>): number {
  const m = meanOf(raw, [98, 99, 100, 101, 102, 103]);
  if (m == null) return 0;
  return Math.round(((m - 1) / 6) * 100);
}

/** 第 6 层：作答体验一致性 E（0–1） */
function computeExperienceConsistency(
  raw: Record<number, number>,
  baseValidity: number,
): { E: number; flags: string[] } {
  const flags: string[] = [];
  const affect = rawOf(raw, 107);
  const willingness = rawOf(raw, 108);
  const depth = rawOf(raw, 109);
  let E = 1;
  if (affect != null && affect >= 5 && baseValidity < 0.6) {
    E -= 0.25;
    flags.push("comfortable-deceiver");
  }
  if (affect != null && affect <= 3 && baseValidity >= 0.75) {
    E = Math.min(1, E + 0.1);
    flags.push("honest-discomfort");
  }
  if (willingness != null && depth != null && willingness <= 3 && depth >= 5) {
    flags.push("reluctant-but-valuable");
  }
  return { E: Math.max(0, Math.min(1, E)), flags };
}

/**
 * 完整评分
 * @param raw 题号 → 1–7 原始分（开放题 110/111 不参与计分）
 * @param opts.behavioralGap 跨源偏离 G（0–1），由外部比对 thought 得出；缺省 0
 * @param opts.feedback 模块 12/13 的结构化结果
 */
export function scoreRSQ(
  raw: Record<number, number>,
  opts: { behavioralGap?: number; feedback?: RSQFeedback | null; selfSummary?: string | null } = {},
): RSQResult {
  const dims = computeDimensions(raw);
  const derived = computeDerived(dims);

  const C = computeConsistency(raw);
  const D = computeSocialDesirability(raw, dims);
  const L = computeLieScale(raw);
  const dark = computeDarkTriad(raw);
  const G = Math.max(0, Math.min(1, opts.behavioralGap ?? 0));

  const imMean = meanOf(raw, [88, 89, 90, 91, 92]) ?? 1;
  const imHigh = (imMean - 1) / 6 >= 0.7;
  const darkHigh = dark >= 70;
  const darkConflict = darkHigh && imHigh;

  const flags: string[] = [];
  if (darkConflict) flags.push("dark-desirability-conflict");
  if (darkHigh && imHigh) flags.push("polished-deceiver");

  const likertVals = Object.entries(raw)
    .filter(([no]) => {
      const it = RSQ_ITEM_MAP.get(Number(no));
      return it && it.scale !== "open";
    })
    .map(([, v]) => v);
  const extremeRatio = likertVals.length
    ? likertVals.filter((v) => v === 1 || v === 7).length / likertVals.length
    : 0;
  if (extremeRatio > 0.85) flags.push("extreme-response");

  let straightRun = 1;
  for (let i = 1; i < likertVals.length; i++) {
    if (likertVals[i] === likertVals[i - 1]) straightRun = straightRun === 1 ? 2 : straightRun + 1;
    else straightRun = 1;
    if (straightRun >= 10) { flags.push("straight-lining"); break; }
  }

  const darkConflictScore = darkConflict ? 1 : 0;
  const baseValidity = 0.28 * C + 0.18 * (1 - D) + 0.08 * (1 - L) + 0.22 * (1 - G) + 0.12;
  const { E, flags: expFlags } = computeExperienceConsistency(raw, baseValidity);
  flags.push(...expFlags);

  const overall = Math.max(
    0,
    Math.min(
      1,
      0.28 * C +
        0.18 * (1 - D) +
        0.08 * (1 - L) +
        0.12 * (1 - darkConflictScore * 0.15) +
        0.22 * (1 - G) +
        0.12 * E,
    ),
  );

  const verdict: RSQValidity["verdict"] =
    overall >= 0.75 ? "reliable" : overall >= 0.5 ? "questionable" : "likely-deceptive";

  return {
    dims,
    derived,
    validity: {
      consistency: Number(C.toFixed(3)),
      socialDesirability: Number(D.toFixed(3)),
      lieScale: Number(L.toFixed(3)),
      darkTriad: dark,
      behavioralGap: Number(G.toFixed(3)),
      experienceConsistency: Number(E.toFixed(3)),
      overall: Number(overall.toFixed(3)),
      verdict,
      flags: [...new Set(flags)],
    },
    feedback: opts.feedback ?? null,
    selfSummary: (opts.selfSummary ?? "").trim().slice(0, 36) || null,
    raw,
    itemsVersion: RSQ_ITEMS_VERSION,
  };
}

/** 确定性洗牌：seed 固定 → 可复现；保证配对题间隔 >= 10 */
function shuffleItems(ordered: number[], seed: number): number[] {
  let s = seed;
  const rnd = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  const out = [...ordered];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  const posOf = () => new Map(out.map((no, idx) => [no, idx]));
  for (const it of RSQ_ITEMS) {
    if (it.pairWith == null) continue;
    let pos = posOf();
    const a = pos.get(it.no);
    const b = pos.get(it.pairWith);
    if (a == null || b == null) continue;
    if (Math.abs(a - b) < 10) {
      const [moved] = out.splice(a, 1);
      const target = Math.min(out.length, b + 10);
      out.splice(target, 0, moved!);
    }
  }
  return out;
}

/** 生成问卷文本（供 LLM 作答） */
export function renderQuestionnaire(opts: {
  targetName: string;
  itemNos?: number[];
  shuffle?: boolean;
  seed?: number;
}): { preface: string; items: Array<{ no: number; text: string; scale: RSQScale }> } {
  const pool = RSQ_ITEMS.filter((it) => (opts.itemNos ? opts.itemNos.includes(it.no) : true));
  const nos = pool.map((it) => it.no);
  const finalNos = opts.shuffle ? shuffleItems(nos, opts.seed ?? 42) : nos;
  const items = finalNos.map((no) => {
    const it = RSQ_ITEM_MAP.get(no)!;
    return { no: it.no, text: it.text.replace(/\\[R\\]/g, '').trim(), scale: it.scale };
  });

  const preface = [
    "【关系回忆问卷 · 私密】",
    "",
    "1. 保密：本问卷内容与结果对一切玩家保密，包括你正在评估的对象。",
    "2. 用途：仅用于更新「你对这段关系的认知」。",
    "3. 立场：请以你自己的感受作答，不是以角色应然的方向作答。",
    "4. 后果：你的回答不直接影响下一局的胜负。",
    "",
    "请回忆你与「" + opts.targetName + "」的实际经历，回答以下问题。",
    "所有题目 1–7 分：1=完全不符，4=一般，7=完全符合。",
    "只输出题号与分数，不要解释。",
    "第 110/111 题是文字回答；第 120 题用一句话（不超过 36 字）概括你和他的关系。",
  ].join("\n");

  return { preface, items };
}
