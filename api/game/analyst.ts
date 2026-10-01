// ============================================================
// 分析师 AI：上帝视角复盘报告 + 经验指南蒸馏
// - buildAnalysisPrompt：确定性日志摘要（logDigest 硬限 6000 字）+ 输出要求，总长 ≤7000 字
//   （旧实现把 ~18000 字整局日志一次性喂给思考型模型，响应常超 90s 超时 → 重试 3 次 → 任务失败）
// - 输出要求：精炼分析报告（≤1500 字），五段结构保持（概述/转折点/心理/阵营/经验教训）
// - 经验指南蒸馏两段式：
//   buildCommonDistillPrompt/runDistillCommon：只蒸馏与具体版型无关的通用策略（共通指南，≤4000 字）
//   buildBoardDistillPrompt/runDistillBoard：只蒸馏该版型特有角色配合/机制博弈（版型指南，≤3000 字）
// - runAnalysis / runDistillCommon / runDistillBoard：callAi 传 { jsonMode:false, timeoutMs:180s, maxRetries:1 }
//   （长调用不应三重重试：3×90s 串行重试是任务失败的放大器；单次放宽到 180s、仅重试 1 次）
// ============================================================

import type { AnalystAiConfig, GameEvent, GameSnapshot } from "../../contracts/game";
import { BOARDS } from "../../contracts/game";
import { callAi } from "./ai/providers";
import { buildLogDigest } from "./logDigest";

// ---------- 调用参数 ----------
export const ANALYSIS_TOTAL_CHAR_LIMIT = 10_500; // 整个 user prompt 的硬上限（digest ≤9000 + 定长指令区；质量优先放宽）
export const ANALYST_TIMEOUT_MS = 600_000; // 单次 AI 调用超时：复盘/蒸馏质量优先，给足 10 分钟（用户要求分析不再限时）
export const ANALYST_MAX_RETRIES = 2; // 长调用重试 2 次（质量优先）

// ---------- 版型规则文本 ----------
// 分析师侧此前从不告知本局规则，导致复盘/蒸馏沿用"女巫可自救"等泛化认知。
// 统一由 BOARDS 契约派生一段规则文本，供分析 prompt 与版型蒸馏 prompt 注入。
export function buildBoardRulesText(boardId: string): string {
  const board = BOARDS.find((b) => b.id === boardId);
  if (!board) return "规则未知（以该版型实际配置为准）";
  const witch = board.witchSelfSave === "firstNight" ? "女巫仅首夜可自救" : "女巫全程不可自救";
  const sheriff = board.sheriff ? "有警长" : "无警长";
  return `${witch} · ${sheriff} · 屠边`;
}

// ---------- 复盘分析 prompt ----------
export function buildAnalysisPrompt(
  snapshot: GameSnapshot,
  events: GameEvent[],
): { system: string; user: string } {
  // 本局规则行：分析师此前不知本局规则，曾把"女巫可自救"的泛化认知当成合理策略写进报告
  const board = BOARDS.find((b) => b.id === snapshot.boardId);
  const rulesLine = board
    ? `本局版型：${board.name}；${board.witchSelfSave === "firstNight" ? "女巫仅首夜可自救" : "女巫全程不可自救"}；${board.sheriff ? "有警长" : "无警长"}；屠边规则`
    : `本局版型：${snapshot.boardName}；具体规则以摘要为准`;

  const system = [
    "你是博弈论与心理学专家，正在复盘一场AI狼人杀对局实验。",
    "你拥有上帝视角：输入摘要包含所有玩家的真实身份、夜间行动、代表性心理活动与公开发言（已经过机械压缩，发言/心理为截取片段）。",
    rulesLine,
    "摘要中玩家若表现出与上述规则相悖的认知（如女巫试图自救、认为存在不存在的规则），那是该玩家的错误认知——你应在报告中指出这是规则认知错误，并评估其对局势的影响，绝不可将其当作合理策略采纳。",
    "你的分析必须精炼、有证据：引用摘要中具体玩家在第几天的具体发言/心理活动，而不是泛泛而谈。",
  ].join("\n");

  const instructions = [
    "【输出要求】",
    "请基于以上对局摘要，输出一份详尽的复盘分析报告（全文不超过 3000 字），markdown 格式，严格包含以下六个章节（使用 ## 标题）。要求事无巨细：亮点与失误都要覆盖到，每个论点必须落到「第几天、几号玩家、具体发言/行动/心理活动」的证据上，禁止泛泛而谈：",
    "## 一、对局概述",
    "（版型、胜负归属、整体走势，200 字以内）",
    "## 二、关键转折点分析",
    "（博弈论视角：轮次计算、信息战、票型控制、自爆时机等；逐转折点评，指出发生在第几天、涉及哪些玩家、当时各方信息集）",
    "## 三、心理博弈分析",
    "（诈身份、信任建立与背叛、羊群效应、锚定效应等；引用摘要中具体玩家的发言或心理活动片段作为证据）",
    "## 四、规则认知错误与明显失误清单",
    "（逐条列出玩家对规则/术语/局势的错误认知与明显失误——如误解「金水」适用对象、误用不存在的规则、漏用关键技能、错误轮次判断等；每条写明：第几天、谁、错在哪、正确理解是什么、对局势造成的影响。没有则写「本局未发现明显失误」）",
    "## 五、阵营表现点评",
    "（狼队与好人阵营各自打得最好与最差之处，含个人亮点与反面典型）",
    "## 六、经验教训",
    "（5-10 条可复用策略与误区警示，每条一行、精炼可执行，形如 “- 狼人：被集火时应…”、“- 误区：金水包括平民，平民被验明后不应反水”）",
  ].join("\n");

  const digest = buildLogDigest(snapshot, events);
  let user = `${digest}\n\n${instructions}`;
  if (user.length > ANALYSIS_TOTAL_CHAR_LIMIT) {
    // 防御性截断：digest 已硬限 6000 字本不会触发；触发时压缩 digest 保住指令区
    user = `${digest.slice(0, ANALYSIS_TOTAL_CHAR_LIMIT - instructions.length - 2)}\n\n${instructions}`;
  }
  return { system, user };
}

// ---------- 共通经验蒸馏 prompt（scope="common"：与具体版型角色配置无关的通用策略） ----------
export function buildCommonDistillPrompt(
  currentCommonGuide: string | null,
  newReport: string,
): { system: string; user: string } {
  const system =
    "你是狼人杀博弈实验的「共通经验指南」维护者：把每一局复盘报告中通用于所有狼人杀版型的经验教训，蒸馏进一份持续累积的公共教程，供后续所有对局的所有玩家（任何版型、任何角色）查阅。";

  const user = [
    "【现有共通经验指南】（历代对局累积至今）",
    currentCommonGuide?.trim() ? currentCommonGuide : "（暂无：这是第一份指南，请基于报告直接创建）",
    "",
    "【最新对局复盘报告】",
    newReport,
    "",
    "【蒸馏要求】",
    "1. 只提取与具体版型角色配置无关的通用策略：发言心理、投票博弈、轮次计算、诈身份通用技巧等；",
    "   凡是依赖特定版型角色或特殊机制（如守卫、摄梦人、白狼王等）的经验，一律不要写入本指南。",
    "2. 狼人杀各版型规则存在差异（如女巫可否自救、有无警长），共通指南中的经验不得依赖某一特定规则设定；",
    "   涉及规则差异的经验必须条件化表述（如“若规则允许自救…”），否则剔除。",
    "2.5 报告中的规则认知错误与失误清单是宝贵的反面教材：必须以「误区警示」条目收录",
    "   （写明错误认知是什么、为何错、正确理解是什么，如“误区：金水包括平民——预言家验出的好人不限神职”）；",
    "3. 去重合并：与现有指南语义重复的条目，用更准确、更一般的表述替换；禁止简单堆叠导致指南膨胀。",
    "4. 按主题组织，使用 markdown 小节：## 狼人策略 / ## 好人策略 / ## 发言心理 / ## 投票博弈 / ## 夜间博弈（可按需增删主题，无内容的小节省略）。",
    "5. 每条经验一句话、可执行（明确谁在什么情境下该怎么做），每条以 “- ” 开头。",
    "6. 总长度严格控制在 4000 字以内；必须取舍时，优先保留被多局验证的通用经验。",
    "6.5 炼金师规矩：每条经验末尾附样本量与置信度标注，形如（样本 n=3｜置信度 中）——",
    "   样本量=该经验被几局对局验证过（含本局，按现有指南条目存活代数估计），置信度给 低/中/高；",
    "7. 只输出指南正文（markdown 纯文本），禁止输出任何解释、前言、版本信息或代码块包裹。",
  ].join("\n");

  return { system, user };
}

// ---------- 版型特定经验蒸馏 prompt（scope=版型 id：仅适用于该版型的经验） ----------
export interface BoardContext {
  boardName: string;    // 版型名，如 "12人白狼王守卫"
  rolesSummary: string; // 阵容摘要，如 "预女猎守 + 4民 vs 3狼+白狼王"
  rulesText: string;    // 本版型规则摘要，如 "女巫全程不可自救 · 有警长 · 屠边"
}

export function buildBoardDistillPrompt(
  boardCtx: BoardContext,
  currentBoardGuide: string | null,
  newReport: string,
): { system: string; user: string } {
  const system =
    `你是狼人杀博弈实验的「版型特定经验指南」维护者：只维护版型「${boardCtx.boardName}」的专属经验，供后续使用该版型对局的所有玩家查阅。`;

  const user = [
    `【版型】${boardCtx.boardName}`,
    `【角色配置】${boardCtx.rolesSummary}`,
    `【本版型规则】${boardCtx.rulesText}`,
    "",
    "【现有本版型经验指南】（该版型历代对局累积至今）",
    currentBoardGuide?.trim() ? currentBoardGuide : "（暂无：这是该版型的第一份指南，请基于报告直接创建）",
    "",
    "【最新对局复盘报告】",
    newReport,
    "",
    "【蒸馏要求】",
    `1. 只提取仅适用于版型「${boardCtx.boardName}」的经验：该版型特有角色配合、特殊机制博弈`,
    "   （如白狼王自爆带人时机、守卫盾法、摄梦人连招等）；",
    "   与具体版型无关的通用策略（发言心理、投票博弈、轮次计算等）一律不要写入本指南。",
    "2. 所有经验必须符合【本版型规则】，严禁输出与规则相悖的建议",
    "   （例如本版型女巫不可自救时，任何“女巫自救/解药保护自己”类建议一律禁止；",
    "   玩家在对局中的此类行为属于规则认知错误，只可作为“应避免”的反面教训写入）。",
    "3. 去重合并：与现有指南语义重复的条目，用更准确、更一般的表述替换；禁止简单堆叠导致指南膨胀。",
    "4. 按主题组织，使用 markdown 小节（按角色或机制分节，无内容的小节省略）。",
    "5. 每条经验一句话、可执行（明确谁在什么情境下该怎么做），每条以 “- ” 开头。",
    "6. 总长度严格控制在 3000 字以内；必须取舍时，优先保留被多局验证的经验。",
    "6.5 炼金师规矩：每条经验末尾附样本量与置信度标注，形如（样本 n=2｜置信度 低）——",
    "   样本量=该经验被几局对局验证过（含本局），置信度给 低/中/高；",
    "7. 只输出指南正文（markdown 纯文本），禁止输出任何解释、前言、版本信息或代码块包裹。",
  ].join("\n");

  return { system, user };
}

// ---------- 调用入口（失败抛错，由服务层置 failed / 记日志事件） ----------
export async function runAnalysis(
  cfg: AnalystAiConfig,
  snapshot: GameSnapshot,
  events: GameEvent[],
): Promise<string> {
  const { system, user } = buildAnalysisPrompt(snapshot, events);
  const res = await callAi({ ...cfg, seat: 0 }, system, user, {
    jsonMode: false,
    timeoutMs: ANALYST_TIMEOUT_MS,
    maxRetries: ANALYST_MAX_RETRIES,
  });
  if (!res.ok || !res.text?.trim()) {
    throw new Error(`分析师AI生成报告失败：${res.error ?? "返回内容为空"}`);
  }
  return res.text.trim();
}

export async function runDistillCommon(
  cfg: AnalystAiConfig,
  currentCommonGuide: string | null,
  newReport: string,
): Promise<string> {
  const { system, user } = buildCommonDistillPrompt(currentCommonGuide, newReport);
  const res = await callAi({ ...cfg, seat: 0 }, system, user, {
    jsonMode: false,
    timeoutMs: ANALYST_TIMEOUT_MS,
    maxRetries: ANALYST_MAX_RETRIES,
  });
  if (!res.ok || !res.text?.trim()) {
    throw new Error(`分析师AI蒸馏共通指南失败：${res.error ?? "返回内容为空"}`);
  }
  return res.text.trim();
}

export async function runDistillBoard(
  cfg: AnalystAiConfig,
  boardCtx: BoardContext,
  currentBoardGuide: string | null,
  newReport: string,
): Promise<string> {
  const { system, user } = buildBoardDistillPrompt(boardCtx, currentBoardGuide, newReport);
  const res = await callAi({ ...cfg, seat: 0 }, system, user, {
    jsonMode: false,
    timeoutMs: ANALYST_TIMEOUT_MS,
    maxRetries: ANALYST_MAX_RETRIES,
  });
  if (!res.ok || !res.text?.trim()) {
    throw new Error(`分析师AI蒸馏版型指南失败：${res.error ?? "返回内容为空"}`);
  }
  return res.text.trim();
}

// ---------- 赛前图书馆学习（AI 不是生而知之：开赛前自主学习资料形成心得） ----------
// 图书馆是综合藏书（狼人杀教程/心理学/博弈论等跨学科），三级选读：
// 书名（buildStudyPickPrompt）→ 章节（buildChapterPickPrompt，大部头按目录按需研读）
// → 精简实战心得（buildStudyPrompt，≤700字锦囊，可完整注入决策 prompt）
export function buildStudyPickPrompt(
  seat: number,
  roleName: string,
  docNames: string[],
): { system: string; user: string } {
  const system = [
    "你是狼人杀玩家，开赛前来到图书馆。馆内是综合藏书：既有狼人杀对局教程，也有心理学、博弈论等跨学科书籍。",
    "你不必本本都读——根据你的身份与对局需要，挑选最值得通读的 1-3 本。",
    "严格只输出 JSON：{\"read\": [\"书名1\", \"书名2\"]}（书名必须与列表完全一致；都觉得没用则返回空数组）。",
  ].join("\n");
  const user = [
    `你是 ${seat} 号玩家${roleName ? `，本局身份【${roleName}】` : ""}。`,
    "",
    "【馆藏书目】",
    ...docNames.map((n) => `- ${n}`),
    "",
    "请选择你要通读的书目（1-3 本）。",
  ].join("\n");
  return { system, user };
}

/** 书名/章节单元（章节切分结果） */
export interface DocChapter {
  title: string;
  text: string;
}

/**
 * 把馆藏正文按「章节线索」切分：识别 第X章/节/篇/卷/回、markdown 标题、序/前言/楔子/尾声/后记。
 * 标题行判定：独立短行（≤30 字）且不以句读结尾（防正文「第一天…」误判）。
 * 全文找不到 ≥2 个章节时返回单章「全文」（调用方按小文档处理）。
 */
export function splitDocChapters(content: string): DocChapter[] {
  const TITLE_RE =
    /^(#{1,3}\s*\S.{0,28}|第[0-9一二三四五六七八九十百千两]+[章节篇卷部回][^\n。，；！？]{0,24}|序[言章]?|前言|楔子|尾声|后记)$/;
  const lines = content.split("\n");
  const marks: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.length > 0 && t.length <= 30 && TITLE_RE.test(t)) marks.push(i);
  }
  if (marks.length < 2) return [{ title: "全文", text: content }];
  const chapters: DocChapter[] = [];
  for (let k = 0; k < marks.length; k++) {
    const start = marks[k];
    const end = k + 1 < marks.length ? marks[k + 1] : lines.length;
    chapters.push({ title: lines[start].trim(), text: lines.slice(start + 1, end).join("\n").trim() });
  }
  return chapters;
}

/** 章节选读 prompt：大部头按目录挑选最相关章节（书名→章节两级选读的第二级） */
export function buildChapterPickPrompt(
  seat: number,
  roleName: string,
  boardName: string,
  toc: { name: string; chapters: string[] }[],
): { system: string; user: string } {
  const system = [
    "你是狼人杀玩家，开赛前来到图书馆做针对性研读。时间有限，不必逐页通读——",
    "按书名与章节目录，挑选与你身份和本局版型最相关、最能提升实战的章节来读。",
    '严格只输出 JSON：{"read": [{"doc": "书名", "chapters": ["章节名1", "章节名2"]}]}（书名/章节名必须与目录完全一致；每本书最多选 5 章）。',
  ].join("\n");
  const user = [
    `你是 ${seat} 号玩家${roleName ? `，本局身份【${roleName}】` : ""}。本局版型：${boardName}。`,
    "",
    "【馆藏目录】（书名 → 章节）",
    ...toc.map((d) => `《${d.name}》\n${d.chapters.map((c) => `  · ${c}`).join("\n")}`),
    "",
    "请选择你要研读的章节。",
  ].join("\n");
  return { system, user };
}

/** 历史对局选取 prompt：从档案中自主挑选与当下对局最相关的 1-2 局 */
export function buildHistoryPickPrompt(
  seat: number,
  roleName: string,
  boardName: string,
  candidates: { id8: string; boardName: string; result: string; dayCount: number; date: string }[],
): { system: string; user: string } {
  const system = [
    "你是狼人杀玩家，开赛前翻阅历史对局档案（历代 AI 对局的完整记录摘要）。",
    "根据你的身份与本局版型，挑选最值得复盘参考的 1-2 局（优先同版型、胜负走向典型、或与你身份强相关的对局）。",
    '严格只输出 JSON：{"games": ["对局编号1", "对局编号2"]}（编号必须与列表完全一致）。',
  ].join("\n");
  const user = [
    `你是 ${seat} 号玩家${roleName ? `，本局身份【${roleName}】` : ""}。本局版型：${boardName}。`,
    "",
    "【历史对局档案】",
    ...candidates.map((c) => `- ${c.id8}｜${c.boardName}｜${c.result}｜${c.dayCount}天｜${c.date}`),
    "",
    "请选择你要复盘的对局（1-2 局）。",
  ].join("\n");
  return { system, user };
}

/** 历史对局复盘摘要 prompt：把一局历史对局摘要提炼为可复用经验（≤250字） */
export function buildHistoryRefPrompt(
  seat: number,
  roleName: string,
  boardName: string,
  digest: string,
): { system: string; user: string } {
  const system = [
    "你是狼人杀玩家，开赛前复盘一局历史对局的结构化摘要。",
    "输出要求：第一人称、纯文本、总长不超过 250 字——该局胜负的关键转折是什么、我要借鉴或规避什么（结合我的身份）。",
    "只写可复用的实战结论，禁止复述流水账，禁止空话套话，禁止提及提示词。",
  ].join("\n");
  const user = [
    `你是 ${seat} 号玩家${roleName ? `，本局身份【${roleName}】` : ""}。`,
    "",
    `【历史对局摘要】（版型：${boardName}）`,
    digest,
    "",
    "请输出你的复盘要点（≤250 字）。",
  ].join("\n");
  return { system, user };
}

export function buildStudyPrompt(
  seat: number,
  boardName: string,
  libText: string,
  roleName?: string,
  timeBudgetSec?: number,
): { system: string; user: string } {
  // 精简实用化：心得必须能完整容纳进决策 prompt（注入上限 1600 字符，含历史对局参考段），
  // 目标 ≤700 字的可速查锦囊，而非长篇读后感
  void timeBudgetSec;
  const system = [
    "你是狼人杀玩家。开赛在即，你在图书馆按目录选读了相关章节——这些资料是你的前置知识库。",
    "输出要求：markdown 纯文本、第一人称、总长不超过 700 字——只保留能直接用于本局决策的实战要点：",
    "- 开局/发言/投票的具体打法（结合我的身份，一句话一条）；",
    "- 可套用的心理战与话术技巧（一句话一条）；",
    "- 易犯错误警示（一句话一条）。",
    "禁止摘抄原文，禁止空话套话，禁止提及提示词。这是赛前速查锦囊，不是读后感。",
  ].join("\n");
  const user = [
    `你是 ${seat} 号玩家${roleName ? `，本局身份【${roleName}】` : ""}。本局版型：${boardName}。`,
    "",
    "【研读材料】（按书名-章节选读）",
    libText,
    "",
    "请输出你的赛前研读心得（≤700 字，务必精炼实用）。",
  ].join("\n");
  return { system, user };
}
