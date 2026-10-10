// ============================================================
// 对局服务层实现
// 职责：对局生命周期管理、游戏循环驱动（启动/暂停/tick）、AI 调用、
//       事件持久化（seq 分配）、快照组装。API key 仅存内存 Map，绝不写库。
// ============================================================

import type {
  CreateGameInput,
  PollResult,
  GameSummary,
  AiTestInput,
  AiTestResult,
  GameSnapshot,
  GameStatus,
  SeatAiConfig,
  AdvancedOptions,
  RoleId,
  GameEvent,
  GuideInfo,
  GuideBoardEntry,
  GuideOverview,
  GuideVersionSummary,
  AnalysisReport,
  AnalysisJobStatus,
  AnalysisJobStage,
  AnalystAiConfig,
} from "../../contracts/game";
import { BOARDS, ROLE_META, formatGameTitleNo } from "../../contracts/game";
import type { GameRow } from "../../db/schema";
import { TRPCError } from "@trpc/server";
import { encryptSecret, decryptSecret } from "../lib/authCrypto";
import {
  appendEvents,
  countGamesOnDate,
  getAllEvents,
  getEventsAfter,
  getGame,
  getLatestEvents,
  getLatestPhaseEvent,
  getMaxEventSeq,
  hasPostGameEvents,
  insertGame,
  listGames,
  updateGame,
} from "../queries/games";
import {
  countGuides,
  getAnalysis as getAnalysisRow,
  getGuideVersion,
  getLatestGuide,
  insertGuideVersion,
  listGuideScopes,
  listGuideVersions,
  upsertAnalysis,
} from "../queries/guide";
import { appendDecision, getDecisions } from "../queries/decisions";
import { getAllLibraryContents, upsertStudyNote, getStudyNotes } from "../queries/library";
import { getLatestWinRate, getWinRatesAfter, insertWinRate } from "../queries/winrates";
import { buildBoardRulesText, runAnalysis, runDistillBoard, runDistillCommon, buildStudyPrompt, buildStudyPickPrompt, buildChapterPickPrompt, buildHistoryPickPrompt, buildHistoryRefPrompt, splitDocChapters } from "./analyst";
import { buildLogDigest } from "./logDigest";
import { createEngine, MEETING_WOLVES } from "./engine/index";
import type {
  DecisionInput,
  DecisionKind,
  Engine,
  EngineEvent,
  PendingDecision,
} from "./engine/api";
import { SPEECH_REQUIRED_KINDS } from "./engine/api";
import { callAi } from "./ai/providers";
import { defaultCallTimeoutMs, isThinkingModel } from "./ai/modelCaps";
import { buildPrompt, modelContextTokens } from "./ai/prompts";
import { parseDecision } from "./ai/parse";
import { buildPersonaCircleText, injectCircleText, type PersonaBondInfo } from "./personaVisibility";
import type { PersonaCard, PersonaEventMeta, PersonaSeatInfo } from "../../contracts/persona";
import {
  getPersona,
  getPersonaCardsInternal,
  getPersonaReportsForGame,
  incrementPersonaGameCount,
  listRelationshipsAmong,
  loadMemoryContext,
  upsertPersonaReport,
} from "../queries/personas";
import { runPersonaPipeline } from "../persona/pipeline";
import { runNotebookWriteback } from "../persona/notebook";
import { runPsyCheck } from "../persona/anatomist";
import { withTimeout, DB_TIMEOUT_MS } from "./runtime/timing";
import { initJudgeRecorder, maybeFoulCheck } from "./judge/foulReferee";

export interface GameService {
  // userId 由路由层强制传入（归属校验）；测试/内部路径可省略（省略时不做归属拦截）
  createGame(input: CreateGameInput, userId?: string): Promise<{ gameId: string }>;
  control(gameId: string, action: "start" | "pause" | "terminate" | "stopPostGame", userId?: string): Promise<{ ok: boolean }>;
  // 已结束对局补开赛后讨论（started=false 时 reason 给出原因；幂等）
  startPostGame(gameId: string, userId?: string): Promise<{ started: boolean; reason?: string }>;
  // 开始心理检查（手动开启的终局收尾，分出胜负即可；可续跑：已完成座位跳过；幂等）
  startPsyCheck(
    gameId: string,
    analystAi?: AnalystAiConfig | null,
    userId?: string,
  ): Promise<{ started: boolean; reason?: string }>;
  /** 赛前学习心得（图书馆对局）：内存实时值与落库值合并按座位返回 */
  studyNotes(gameId: string, userId?: string): Promise<{ seat: number; notes: string }[]>;
  poll(gameId: string, afterSeq: number, lastSig?: string, userId?: string, afterWinRateId?: number): Promise<PollResult>;
  list(userId: string): Promise<GameSummary[]>;
  exportGame(gameId: string, userId: string): Promise<{ snapshot: GameSnapshot; events: unknown[] }>;
  aiTest(input: AiTestInput): Promise<AiTestResult>;
  // 分析师与经验指南（账户体系：全部按 userId 隔离）
  guide(userId: string): Promise<GuideOverview>;
  guideVersions(userId: string, scope: string): Promise<GuideVersionSummary[]>;
  guideVersion(userId: string, scope: string, version: number): Promise<{ version: number; content: string; createdAt: string } | null>;
  updateGuide(userId: string, scope: string, content: string): Promise<import("../../contracts/game").GuideInfo>;
  getAnalysis(gameId: string, userId: string): Promise<{ report: import("../../contracts/game").AnalysisReport | null; jobStatus: import("../../contracts/game").AnalysisJobStatus; jobStage: import("../../contracts/game").AnalysisJobStage; jobError: string | null }>;
  generateAnalysis(gameId: string, userId: string, analyst?: import("../../contracts/game").AnalystAiConfig): Promise<{ started: boolean }>;
  /** 人格研究库：本局人格座位的《心理检查报告》列表（对局页查看入口） */
  personaReports(gameId: string, userId: string): Promise<import("../../contracts/persona").PersonaReport[]>;
}

/** 对局归属校验：不存在→NOT_FOUND；非本人→FORBIDDEN（账户隔离的统一关卡） */
async function requireOwnedGame(gameId: string, userId?: string): Promise<GameRow> {
  const row = await getGame(gameId);
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: `对局不存在: ${gameId}` });
  if (row.userId !== userId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "无权访问该对局" });
  }
  return row;
}

// ---------- 内存注册表（apiKey 只存这里，绝不落盘） ----------
// 导出仅供测试/诊断使用（构造断链、观察运行时状态），运行时不应外部修改
export interface GameRuntime {
  engine: Engine;
  seatAIs: SeatAiConfig[];
  boardId: string; // 版型 id：经验指南按版型注入的依据
  userId: string | null; // 对局归属用户：指南注入/蒸馏按用户隔离的依据（旧内存运行时可为 null）
  status: GameStatus;
  seq: number;
  timer: ReturnType<typeof setTimeout> | null;
  pending: PendingDecision | null;
  options: AdvancedOptions;
  ticking: boolean; // tick 执行锁，防止重入
  lastTickAt: number; // 最近一次 tick 开始/结束的时间戳（断链检测依据）
  noProgressTicks: number; // 连续「无事件且无待决且未结束」的 tick 数（引擎停滞看门狗）
  pauseWaiters: Array<() => void>; // 在飞决策的暂停等待者：暂停时唤醒，挂起当前决策（resume 时重新思考）
  decisionIdx: number; // 已落盘决策数（决策日志 idx 计数器，断点重放恢复时从 DB 重建）
  // 挂起时保存的「未完成思考量」：该决策点暂停前最近一次校验失败尝试的思考内容与失败原因，
  // 恢复重新思考时注入 prompt 供参考（可采纳/修正/抛弃），避免灵感流失；注入后即清空
  suspendDraft: { thought: string | null; error: string | null } | null;
  analystAi: AnalystAiConfig | null; // 分析师配置（仅存内存；配置后终局自动复盘）
  // 上一个待决所属时段（"night"/"day"/""未知名）：检测日夜交界，触发交界停歇（phaseBreakMs）
  lastDayPart: string;
  // 最近一条已落盘事件的阶段值：恢复补漏时批首事件的 thinkBeat 判定依据；随 persistEvents 更新
  lastEventPhase: string | null;
  // 显示阶段（跟随已持久化内容）：快照的 day/phase/phaseLabel 以此为准——
  // 引擎阶段值先行推进但内容未落盘时，界面阶段/色调/时段标签一律不跟进
  //（杜绝日夜交界主题反复抖动）；随每次事件落盘由 recordDisplayPhase 更新
  displayPhase: { day: number; phase: string; phaseLabel: string } | null;
  // 停歇待决冻结：true 时快照隐藏一切待决显示（pendingSeat/pendingActs 置空，
  // 狼人不提前亮权衡圈），AI 互动流程真实暂停，停歇结束放行
  pendingHold: boolean;
  // 当前停歇类型（黄灯规则据此区分）：夜→日 / 日→夜 / 独立思考节拍；无停歇为 null
  breakKind: "nightToDay" | "dayToNight" | "thinkBeat" | null;
  // 状态圈跟随内容显示：pendingActs 只在「上一个交互的内容已落盘」后更新——
  // 角色的状态圈在其交互内容显示出来的瞬间才切换/消失（界面变动协调）
  acts: { seat: number; kind: string }[] | null;
  // 本次停歇的起始时刻（倒计时文字框用）
  breakStartedAt: number | null;
  // 304 快路径用的快照缓存（tickKey 变更时重建）
  snapCache?: { tickKey: string; snapshot: GameSnapshot };
  // 胜率推测开关（自创建对局时生效；随 setup 落库，恢复时据此重建）
  winRateEnabled: boolean;
  // 胜率分析在飞标记：true 时跳过新触发（只分析最新状态，绝不排队积压）
  winRateInFlight: boolean;
  // 终局保底：终局时刻恰有在飞分析时置位，在飞完成的 finally 里补一次终局状态分析
  winRateFinalPending: boolean;
  // 在飞期间对局又产出了新事件（本次分析已覆盖不了最新状态）：完成后立即重评——
  // 胜率分析追逐最新对局状态的「近乎即时」语义；无新事件时收敛不空转
  winRateDirty: boolean;
  // 胜率预演循环字段：最近一次评估发起时刻 / 评估锚定的事件游标 / 循环定时器
  winRateLastEvalAt: number;
  winRateLastSeq: number;
  winRateLoopTimer: ReturnType<typeof setTimeout> | null;
  // 已落库记录的最大锚定游标：只接受锚点更新的评估落库——保证胜率序列按对局时间单调，
  // 杜绝乱序（阵营颜色/涨跌方向错乱）与同状态重复记录
  winRateLastStoredSeq: number;
  // 胜负已落库：分出胜负的瞬间 winner/dayCount 即落库并触发自动分析（赛后讨论期间
  // status 仍 running、引擎未 finished，但分析报告已可生成）；防重复落库/重复启动
  decidedPersisted: boolean;
  // 赛后讨论挂起标记：postgameSpeak 待决首次出现时暂停对局（等用户进房），
  // control("start") 后由 rt.pending 直接决策续跑；防重复挂起（恢复路径重建为 false，
  // 恢复的对局 rt.pending 非空走直接决策路径，不会重复触发）
  postgameAutoHeld: boolean;
  // 玩家对局笔记：座位 → 最近 N 条「行动+想法」紧凑记录（对局笔记知识库，注入该座位 prompt）
  seatNotes?: Map<number, string[]>;
  // 赛前图书馆学习：座位 → 学习心得；studyDoneSeats 完成计数；studying/studyDone 状态
  studyNotes?: Map<number, string>;
  studyDoneSeats?: Set<number>;
  studyInFlight?: Set<number>; // 正在学习的座位（快照透出 → 祖母绿「学习中」状态环）
  studying?: boolean;
  studyDone?: boolean;
  // ---------- 人格研究库（铁律2/4/6 对局执行） ----------
  // 人格卡按座位注册：绑定人格的座位决策走「心镜→涌现」管线而非普通 buildPrompt
  personaCards?: Map<number, PersonaCard>;
  // 座位人格绑定快照（seat/personaId/name）：人格圈层可见度的全场绑定表（创建/恢复时写入）
  seatPersonas?: PersonaSeatInfo[];
  // 记事簿注入文本（跨对局记忆与关系图谱）：创建/恢复时加载，随记忆回写跨局演进
  personaMemory?: Map<number, string>;
  // 涌现事件注解暂存（座位 → 本决策点的人格注解）：事件落盘前富化到 meta.persona 后清空
  personaEventMeta?: Map<number, PersonaEventMeta>;
  // 圈层羁绊缓存（观察者 personaId → 与在场人格的关系行）：首个人格决策点惰性加载，
  // 局内不变（关系只在终局回写时更新），避免每决策点重复查库
  personaBondRows?: Map<number, RelationshipRowLite[]>;
  // 心理检查（手动开启环节）运行时状态：在飞座位 / 已完成座位（poll 透出进度）
  psyCheckRunning?: Set<number>;
  psyCheckDone?: Set<number>;
  // ---------- 犯规裁判（分析师担任，实时审查公开发言的内容级犯规） ----------
  // 赛后讨论与狼人频道豁免；判罚经 settleExternal 落定对立阵营获胜（与拍刀驳回同一外部结算路径）
  foulQueue?: EngineEvent[]; // 待审公开发言事件（事件落盘即入队，逐个审查）
  foulInFlight?: boolean;    // 审查在飞标记（只审最新，不排队积压审查调用）
  foulSettled?: boolean;     // 本局已判罚（一局至多一次判罚结算，防止重复落定）
}

/** 圈层羁绊的关系行最简形态（查询层 RelationshipRow 的字段子集，service 内自洽） */
interface RelationshipRowLite {
  personaId: number;
  targetPersonaId: number | null;
  targetName: string;
  relation: string;
  affinity: number;
  trust: number;
  note: string;
}

/** 取观察者座位的在场羁绊：记事簿跨局关系（双方都在本局）+ 档案互提的原作渊源。
 *  返回 null 表示本局无人格绑定（连圈层都不需要装配）。 */
async function getSeatBonds(rt: GameRuntime, seat: number): Promise<PersonaBondInfo[] | null> {
  if (!rt.seatPersonas || rt.seatPersonas.length === 0) return null;
  const me = rt.seatPersonas.find((b) => b.seat === seat);
  if (!me) return []; // 观察者本人无人格卡：无圈层视角（不会走到这里，防御）
  if (!rt.personaBondRows) {
    const ids = rt.seatPersonas.map((b) => b.personaId);
    const rows = await listRelationshipsAmong(ids).catch(() => []);
    rt.personaBondRows = new Map();
    for (const r of rows) {
      const list = rt.personaBondRows.get(r.personaId) ?? [];
      list.push(r);
      rt.personaBondRows.set(r.personaId, list);
    }
  }
  const seatOf = new Map(rt.seatPersonas.map((b) => [b.personaId, b.seat] as const));
  const out: PersonaBondInfo[] = [];
  for (const r of rt.personaBondRows.get(me.personaId) ?? []) {
    const tSeat = r.targetPersonaId != null ? seatOf.get(r.targetPersonaId) : undefined;
    if (tSeat == null) continue;
    out.push({
      seat: tSeat,
      name: r.targetName,
      relation: r.relation,
      affinity: r.affinity,
      trust: r.trust,
      note: r.note,
    });
  }
  // 原作渊源：观察者自己的档案（重要关系栏）提到在场人格的人格名/原型名
  //（如五条悟档案记载夏油杰）——曾有羁绊的角色同场时，这是最直接的认知依据
  const relText = rt.personaCards?.get(seat)?.profile.relationships?.trim() ?? "";
  if (relText) {
    for (const b of rt.seatPersonas) {
      if (b.seat === seat || out.some((o) => o.seat === b.seat)) continue;
      const card = rt.personaCards?.get(b.seat);
      const hit = [b.name, card?.originName ?? ""].filter(Boolean).find((n) => relText.includes(n));
      if (hit) {
        // 截取档案中记载对方的那一句（按句切分）
        const sentence =
          relText.split(/[。！？!?\n；;]/).find((s) => s.includes(hit))?.trim() ?? "";
        out.push({
          seat: b.seat,
          name: b.name,
          relation: "",
          affinity: 0,
          trust: 0,
          note: "",
          origin: `你的档案记载着你们的渊源${sentence ? `（「${sentence.slice(0, 60)}」）` : ""}`,
        });
      }
    }
  }
  return out;
}

export const registry = new Map<string, GameRuntime>();

// 恢复中的对局（并发 poll/control 去重共享同一 Promise，避免惊群重复重放）
const recoveringGames = new Map<string, Promise<GameRuntime | null>>();

// ---------- 超时/看门狗常量 ----------
// 计时工具已迁入书记员层（runtime/timing.ts）：withTimeout / DB_TIMEOUT_MS
const STALE_TICK_MS = 15_000; // running 状态下超过该时长没有任何 tick 推进 → 判定 tick 链断裂
const MAX_NO_PROGRESS_TICKS = 30; // 连续无进展 tick 上限，超过判定为引擎停滞

// ---------- 分析任务状态（内存跟踪；含阶段检查点与自愈心跳） ----------
// 导出仅供测试/诊断使用（构造停滞任务、观察阶段流转），运行时不应外部修改
export interface AnalysisJob {
  status: "running" | "done" | "failed";
  stage: AnalysisJobStage; // 当前阶段：analyze=撰写报告 / distill=沉淀指南；done 后归 null
  error: string | null;
  updatedAt: number; // 最近一次阶段推进/检查点写入时间（自愈心跳依据）
  report: string | null; // analyze 阶段产物的内存检查点：distill 失败/中断可跳过 analyze 直接续跑
  commonDone: boolean; // distill 阶段内检查点：共通指南已蒸馏落库 → 自愈重跑时跳过共通段，只续跑版型段
  cfg: AnalystAiConfig; // 复活所需配置（仅存内存，与座位 apiKey 一样绝不落盘）
  snapshot: GameSnapshot | null; // 指南版本 note 所需（版型/胜负），免去复活时重新导出
}
export const analysisJobs = new Map<string, AnalysisJob>();

// running 任务超过该时长无任何心跳 → 判定任务已死（进程波动/调用悬挂），getAnalysis 触发复活
const ANALYSIS_STALE_MS = 60_000;

// ---------- 经验指南注入缓存（按版型缓存，60s，避免每步决策都查库） ----------
// 导出仅供测试/诊断使用，运行时不应外部修改
const GUIDE_CACHE_TTL_MS = 60_000;
export const guideCache = new Map<string, { at: number; text: string }>();

// 拼接注入玩家的指南文本：共通经验 + 本版型经验；某层无内容则省略该层，两层都空返回 ""
function combineGuideText(boardId: string, common: string, boardGuide: string): string {
  const parts: string[] = [];
  if (common.trim()) {
    parts.push(`【共通经验】\n${common.trim()}`);
  }
  if (boardGuide.trim()) {
    const boardName = BOARDS.find((b) => b.id === boardId)?.name ?? boardId;
    parts.push(`【本版型经验·${boardName}】\n${boardGuide.trim()}`);
  }
  return parts.join("\n\n");
}

// 导出仅供测试（验证拼接逻辑与缓存行为）
// 账户体系：指南按 userId+boardId 隔离注入（缓存键复合）；userId 缺失时不注入（不放行他人经验）
export async function getCachedGuideText(userId: string | null, boardId: string): Promise<string> {
  if (!userId) return "";
  const cacheKey = `${userId}:${boardId}`;
  const now = Date.now();
  const hit = guideCache.get(cacheKey);
  if (hit && now - hit.at < GUIDE_CACHE_TTL_MS) return hit.text;
  try {
    // 超时保护：连接挂起时退回旧缓存（或空指南），绝不拖死 tick 循环
    const [commonRow, boardRow] = await withTimeout(
      Promise.all([getLatestGuide(userId, "common"), getLatestGuide(userId, boardId)]),
      DB_TIMEOUT_MS,
      "DB操作超时: 读取经验指南",
    );
    const text = combineGuideText(boardId, commonRow?.content ?? "", boardRow?.content ?? "");
    guideCache.set(cacheKey, { at: now, text });
    return text;
  } catch {
    // 查库失败：退回旧缓存（或空指南），绝不阻断对局循环
    return hit?.text ?? "";
  }
}

// ---------- 工具 ----------
function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function toIso(d: Date | string): string {
  return d instanceof Date ? d.toISOString() : new Date(d).toISOString();
}

interface StoredSetup {
  seatRoles: RoleId[];
  seatModels: string[];
  options: AdvancedOptions;
  // 断点恢复需要完整 AI 配置（含 key）：账户体系后以 AES-GCM 密文存 seatAIsEnc；
  // 旧对局的明文 seatAIs 仅作兼容回退；更老的对局两者皆无 → 不可自动恢复（仅可查看事件）
  seatAIs?: SeatAiConfig[];
  seatAIsEnc?: string;
  // 胜率推测开关（重启恢复后功能仍在的依据）
  winRateEnabled?: boolean;
  // 人格研究库：座位人格绑定快照（含人格名冗余——断点恢复与快照展示不再查库）
  seatPersonas?: PersonaSeatInfo[];
}

/** 从 StoredSetup 解出座位 AI 配置：优先密文，兼容明文存量 */
function seatAIsOfSetup(setup: StoredSetup): SeatAiConfig[] | undefined {
  if (setup.seatAIsEnc) {
    try {
      return JSON.parse(decryptSecret(setup.seatAIsEnc)) as SeatAiConfig[];
    } catch {
      return undefined;
    }
  }
  return setup.seatAIs;
}

// ---------- 事件持久化（每条赋递增 seq） ----------
/** 事件所属时段（夜/日/ null=不涉及时段的系统类阶段） */
function partOfPhase(phase: string): "night" | "day" | null {
  return phase.startsWith("night.") ? "night" : phase.startsWith("day.") ? "day" : null;
}

/**
 * 带日夜交界停歇的持久化（关键机制）：
 * 引擎的 decide()/advance() 会把「上时段结算 + 新时段开始 + 新时段首个待决」在同一批
 * 事件中产出——本函数按时段把事件切成两段：先持久化上一时段的尾巴，静歇 phaseBreakMs
 * （默认 5s，给用户读完上一时段末几轮互动的时间），再持久化新时段的内容
 * （天亮/夜临的公告此时才出现）。仅按 pending 判交界会漏掉 decide() 同批产出的交界
 * 事件（历史 bug：女巫事件后立刻天亮）。
 * 循环处理：一批事件中理论上的多个交界（如终局批连跨两段）逐段各自静歇；
 * finally 保证静歇标记必定复位（历史 bug：余量落盘异常时 pendingHold 永久卡死）。
 */
async function persistWithPhaseBreak(
  gameId: string,
  rt: GameRuntime,
  events: EngineEvent[],
): Promise<void> {
  let rest = events;
  let holding = false;
  try {
    while (rest.length > 0) {
      // 顺序扫描：更新已知时段，定位交界点——
      // ① 日夜时段切换（夜↔日）；② 狼队独立思考→讨论（思考内容须先放出给足阅读时间）
      let split = -1;
      let kind: "nightToDay" | "dayToNight" | "thinkBeat" | null = null;
      for (let i = 0; i < rest.length; i++) {
        const p = partOfPhase(rest[i].phase);
        if (!p) continue;
        const partBreak = rt.lastDayPart && p !== rt.lastDayPart;
        // 批首事件的「前一事件」取自最近已落盘事件（rt.lastEventPhase），
        // 覆盖恢复补漏时 thinkBeat 正好位于缺失后缀起点的情形
        const prevPhase = i > 0 ? rest[i - 1].phase : rt.lastEventPhase;
        const thinkBreak =
          rest[i].phase === "night.wolfDiscuss" && rt.lastDayPart === "night" &&
          prevPhase === "night.wolfThink";
        if (partBreak || thinkBreak) {
          split = i;
          kind = thinkBreak ? "thinkBeat" : p === "day" ? "nightToDay" : "dayToNight";
          break;
        }
        rt.lastDayPart = p;
      }
      if (split < 0) {
        await persistEvents(gameId, rt, rest);
        recordDisplayPhase(rt, rest);
        return;
      }
      // 交界：先出上一时段尾巴（显示阶段随之停在旧时段）→ 静歇（pendingHold 冻结待决显示，
      // AI 互动真实暂停、呼吸灯变橙）→ 再出新时段内容（待决与显示阶段同步放行）
      await persistEvents(gameId, rt, rest.slice(0, split));
      recordDisplayPhase(rt, rest.slice(0, split));
      holding = true;
      rt.pendingHold = true;
      rt.breakKind = kind;
      rt.breakStartedAt = Date.now();
      await new Promise((r) => setTimeout(r, rt.options.phaseBreakMs ?? 5000));
      rt.lastDayPart = partOfPhase(rest[split].phase) ?? rt.lastDayPart;
      // 本交界已消费：余量扫描的批首事件就是交界事件本身——partBreak 因 lastDayPart 更新
      // 不会复发，thinkBeat 则需把 prevPhase 基准推进到交界事件（否则同一 thinkBeat 无限
      // 重复触发静歇）；余量落盘时 persistEvents 会把它纠正回真实落盘尾部
      rt.lastEventPhase = rest[split].phase;
      rest = rest.slice(split);
      // 循环继续：余量中的后续交界同样静歇
    }
  } finally {
    if (holding) {
      rt.pendingHold = false;
      rt.breakKind = null;
      rt.breakStartedAt = null;
    }
  }
}

/** 显示阶段跟随持久化更新：快照的 day/phase/phaseLabel 只反映「已落盘」的最新阶段提醒 */
function recordDisplayPhase(rt: GameRuntime, events: EngineEvent[]): void {
  for (const ev of events) {
    if (ev.type === "phase") {
      rt.displayPhase = { day: ev.day, phase: ev.phase, phaseLabel: ev.title };
    }
  }
}

async function persistEvents(
  gameId: string,
  rt: GameRuntime,
  events: EngineEvent[],
): Promise<void> {
  if (events.length === 0) return;
  // 超时保护：appendEvents 挂起时 15s 抛错 → runTick 捕获走 handleTickError（可见暂停而非假死）
  await withTimeout(
    appendEvents(
      events.map((ev) => ({
        gameId,
        seq: ++rt.seq,
        day: ev.day,
        phase: ev.phase,
        type: ev.type,
        actor: ev.actor,
        actorLabel: ev.actor != null ? `${ev.actor}号玩家` : null,
        title: ev.title,
        content: ev.content,
        thought: ev.thought,
        meta: ev.meta,
      })),
    ),
    DB_TIMEOUT_MS,
    "DB操作超时: 事件持久化",
  );
  // 最近已落盘事件的阶段：批首事件的 thinkBeat 判定与恢复时的时段基准都以此为准
  rt.lastEventPhase = events[events.length - 1].phase;
}

// ---------- 玩家对局笔记（每座位「所知所思所为」实时留存的知识库） ----------
// 每次决策落槌后按座位追加一条紧凑笔记（行动+内心想法），随下次决策注入该座位 prompt——
// 玩家对自身历史始终保真（不再只靠公开记录推断自己说过/做过什么），注意力得以聚焦新变局。
const SEAT_NOTE_MAX = 15;   // 每座位最多保留最近 N 条（早期笔记自然淡出）
const SEAT_NOTE_CHARS = 110; // 单条上限

function describeActionForNote(kind: string, d: DecisionInput): string {
  const tgt = d.targets?.length ? `${d.targets[0]}号` : "";
  if (d.selfDestruct) return "自爆";
  if (d.duel != null) return `决斗${d.duel}号`;
  if (d.surrender || d.declareVictory) return "白日交刀";
  if (d.speech?.trim()) return `发言说「${d.speech.trim().slice(0, 50)}${d.speech.trim().length > 50 ? "…" : ""}」`;
  switch (kind) {
    case "wolfKill": return `夜刀投票给${tgt}`;
    case "seerCheck": case "psychicCheck": case "gargoyleCheck": return `查验${tgt}`;
    case "witchAction": return d.witchSave ? "用解药救人" : tgt ? `毒杀${tgt}` : "未用药";
    case "guardProtect": return tgt ? `守护${tgt}` : "空守";
    case "dreamerDream": return `摄梦${tgt}`;
    case "mechWolfMimic": return tgt ? `模仿${tgt}` : "未模仿";
    case "demonHunterHunt": return tgt ? `狩猎${tgt}` : "未狩猎";
    case "crowCurse": return tgt ? `诽谤${tgt}` : "未诽谤";
    case "dayVote": case "sheriffVote": return `投票给${tgt}`;
    case "sheriffRun": return d.targets?.[0] === 1 ? "报名上警" : "留在警下";
    case "sheriffWithdraw": return d.targets?.[0] === 1 ? "退水放弃竞选" : "继续竞选";
    case "sheriffOrder": return `定序${d.targets?.[0] === 1 ? "升序" : "降序"}发言`;
    case "badgePass": return tgt ? `警徽移交给${tgt}` : "撕掉警徽";
    case "hunterShoot": case "whiteWolfTake": return tgt ? `开枪/带走${tgt}` : "不开枪";
    case "exileSkill": return tgt ? `发动技能指向${tgt}` : "沉默出局";
    default: return d.skip ? "弃权" : tgt ? `行动→${tgt}` : "行动";
  }
}

function recordSeatNotes(rt: GameRuntime, pending: PendingDecision, input: DecisionInput): void {
  if (!rt.seatNotes) rt.seatNotes = new Map();
  const notes = rt.seatNotes;
  const dayLabel = `第${rt.engine.getSnapshot().day}天`;
  const push = (seat: number, kind: string, d: DecisionInput) => {
    const thought = (d.thought ?? "").trim().slice(0, 60);
    const line = `[${dayLabel}] 我${describeActionForNote(kind, d)}${thought ? `（想法：${thought}）` : ""}`
      .slice(0, SEAT_NOTE_CHARS);
    const arr = notes.get(seat) ?? [];
    arr.push(line);
    if (arr.length > SEAT_NOTE_MAX) arr.splice(0, arr.length - SEAT_NOTE_MAX);
    notes.set(seat, arr);
  };
  if (pending.batch?.length && input.batchInputs) {
    for (let i = 0; i < pending.batch.length; i++) {
      const sub = pending.batch[i];
      const d = input.batchInputs[i];
      if (sub && d) push(sub.seat, sub.kind, d);
    }
  } else {
    push(pending.seat, pending.kind, input);
  }
}

// 恢复重放后重建笔记：以决策日志为准（与引擎状态同源）
function rebuildSeatNotesFromLog(rows: { kind: string; seat: number; decision: unknown }[]): Map<number, string[]> {
  const notes = new Map<number, string[]>();
  for (const r of rows) {
    const d = r.decision as DecisionInput;
    if (!d || typeof d !== "object") continue;
    const thought = (d.thought ?? "").trim().slice(0, 60);
    const line = `[重放] 我${describeActionForNote(r.kind, d)}${thought ? `（想法：${thought}）` : ""}`
      .slice(0, SEAT_NOTE_CHARS);
    const arr = notes.get(r.seat) ?? [];
    arr.push(line);
    if (arr.length > SEAT_NOTE_MAX) arr.splice(0, arr.length - SEAT_NOTE_MAX);
    notes.set(r.seat, arr);
  }
  return notes;
}

/** 人格事件富化：把本决策点涌现管线产出的人格注解合并进该座位的发言/行动/投票事件
 * （event.meta.persona：双视角解释 + 撕裂组摘要，观察者双栏展示；富化后即清空防串用） */
function enrichPersonaEvents(rt: GameRuntime, events: EngineEvent[]): void {
  if (!rt.personaEventMeta || rt.personaEventMeta.size === 0) return;
  for (const ev of events) {
    if (ev.actor == null) continue;
    const meta = rt.personaEventMeta.get(ev.actor);
    if (meta && (ev.type === "speech" || ev.type === "action" || ev.type === "vote")) {
      ev.meta = { ...(ev.meta ?? {}), persona: meta };
    }
  }
  rt.personaEventMeta.clear();
}

// ---------- 启发式兜底决策（AI 连续无响应/输出彻底损坏时使用） ----------
// 发言类决策：兜底必须提供非空 speech——集合与引擎校验共用同一事实源（api.ts），
// 防止两处列表漂移（本次事故根因：此处漏了 wolfDiscuss → 兜底无 speech → 引擎拒绝 → 对局崩溃）
const SPEECH_KINDS = SPEECH_REQUIRED_KINDS;

// 夜间可选技能类与白天主动技能窗口：托管时保守放弃，不乱用技能
const SKIP_PREFERRED_KINDS: ReadonlySet<DecisionKind> = new Set([
  "guardProtect",
  "witchAction",
  "mechWolfMimic",
  "demonHunterHunt",
  "crowCurse",
  "hunterShoot",
  "daySkill", // 骑士决斗/狼人自爆绝不由托管代劳，按兵不动
  "exileSkill", // 放逐技能询问默认沉默（托管绝不代劳发动）
  "postgameSpeak", // 赛后讨论托管=本轮弃权（skip 不消耗机会），绝不由系统代发言
]);

// 导出供测试：兜底决策必须被真实引擎接受（任何决策类型都不得让对局崩溃）
export function heuristicDecision(
  pending: PendingDecision,
  thought: string = "[AI连续无响应，系统托管]",
): DecisionInput {
  // 并行权衡批次：逐个子待决递归兜底（子项绝不含 batch）
  if (pending.batch && pending.batch.length > 0) {
    return { thought, batchInputs: pending.batch.map((s) => heuristicDecision(s, thought)) };
  }
  const decision: DecisionInput = { thought };

  if (SPEECH_KINDS.has(pending.kind)) {
    decision.speech =
      pending.kind === "lastWords"
        ? "我是好人走的，大家冷静分析票型，加油。"
        : pending.kind === "wolfDiscuss"
          ? "今晚我随队行动，听大家的安排。"
          : "我这边没什么头绪，先听听大家的发言。";
    return decision;
  }

  if (pending.kind === "sheriffRun") {
    // 托管默认不上警（0=不参与，1=参与）
    decision.targets = [pending.options.includes(0) ? 0 : (pending.options[0] ?? 0)];
    return decision;
  }

  if (pending.kind === "sheriffWithdraw") {
    // 托管默认留在竞选（0=继续竞选，1=退水）：不替玩家做退选决断
    decision.targets = [0];
    return decision;
  }

  if (pending.kind === "sheriffOrder") {
    // 托管默认升序（1=升序，0=降序）
    decision.targets = [1];
    return decision;
  }

  if (pending.allowSkip && SKIP_PREFERRED_KINDS.has(pending.kind)) {
    decision.skip = true;
    return decision;
  }

  // 其余目标类动作：随机选一个合法目标；无合法目标且允许放弃则 skip
  const legal = pending.options.length > 0 ? pending.options : pending.view.aliveSeats;
  if (legal.length > 0) {
    decision.targets = [legal[Math.floor(Math.random() * legal.length)]];
  } else if (pending.allowSkip) {
    decision.skip = true;
  }
  return decision;
}

// ---------- AI 决策（providers + prompts + parse，失败走启发式兜底） ----------
// 调一次 AI 并解析输出；失败（网络/超时/输出损坏）返回 decision=null 并带出真实原因
//（原因最终落入兜底事件的 meta.fallbackReason，可观测——此前被吞掉导致后期全托管无法定位）
/**
 * 单个决策点的 AI 总预算（默认不限制，可用 AI_DECISION_DEADLINE_MS 覆盖；
 * 对局选项 aiTimeLimitSec 设定后按之执行，下限 120s（两分钟）——思考模式下 AI 完成一次
 * 狼人杀决策的合理最低耗时；更短的时限只会逼出草率输出或批量超时托管，不提供）。
 * 思考型模型保底（modelCaps.isThinkingModel：DeepSeek 默认思考 / kimi-k3 永远思考 /
 * kimi-k2.x 思考默认开）：预算下限自动放宽至 260s（含一次完整思考调用 + 一次重试的余地）。
 * 历史事故：AI 提供方故障/全线超时时，单决策点最坏静默 ~9 分钟
 * （askAiOnce 内 3 次×90s × 决策层 2 次尝试），对局看似彻底卡死；
 * 进程被平台频繁回收时，恢复重想重新计时，对局永远无法推进。
 * 预算耗尽立即启发式托管兜底（事件 meta 记录真实原因），对局绝不卡死在 AI 等待上；
 * 预算经 callAi 的 deadlineAt 在重试循环内逐次生效（单次超时截到剩余预算）。
 * 函数级读取（非模块常量）：测试可临时改环境变量。
 */
// 思考型模型决策预算下限（毫秒）：思考链真实耗时 60-150s（kimi-k3 永远思考、
// reasoning_effort 默认 max；DeepSeek 官方端点默认开思考），45s/90s 级预算装不下
// 一次完整调用+重试，必然大面积超时托管（线上实锤：限时 45s 时「请求超时（45s）」占失败近半；
// kimi-k3 限时 120s 时 90s 超时 ×8、批量托管 38 次）——思考模型预算下限自动放宽至 260s
// （含一次完整思考调用 + 一次重试的余地）。
const THINKING_MIN_BUDGET_MS = 260_000;

function decisionDeadlineMs(rt: GameRuntime, cfg?: SeatAiConfig): number {
  const envOverride = Number(process.env.AI_DECISION_DEADLINE_MS);
  if (envOverride) return envOverride;
  const sec = rt.options.aiTimeLimitSec;
  const base =
    typeof sec === "number" && sec > 0 ? Math.max(120, sec) * 1000 : Number.POSITIVE_INFINITY;
  // 思考型模型：预算下限放宽（思考链耗时长，过紧预算只会批量超时转托管）
  if (cfg && isThinkingModel(cfg)) return Math.max(base, THINKING_MIN_BUDGET_MS);
  return base;
}

async function askAiOnce(
  cfg: SeatAiConfig,
  pending: PendingDecision,
  retryNote: string | null,
  rt: GameRuntime,
  resumeNote: string | null = null,
  deadlineAt?: number,
): Promise<{ decision: DecisionInput | null; error: string | null }> {
  try {
    // 总预算守卫：剩余预算不足一次最短调用时直接判失败（调用方走兜底）
    const remaining = deadlineAt != null ? deadlineAt - Date.now() : Number.POSITIVE_INFINITY;
    if (remaining <= 3_000) {
      return { decision: null, error: "AI响应总预算耗尽，转入托管" };
    }
    // 人格研究库：绑定人格的座位改走「心镜→涌现」管线（铁律2参数溢出/铁律4双视角/铁律6撕裂），
    // 基础博弈情境仍由 buildPrompt 单一事实源生成（信息壁垒铁律不破）
    const personaCard = rt.personaCards?.get(pending.seat);
    if (personaCard) {
      const personaGuide = await getCachedGuideText(rt.userId, rt.boardId);
      const personaModelContext = modelContextTokens(cfg.model);
      const base = buildPrompt(pending, {
        retryNote: retryNote ?? undefined,
        resumeNote: resumeNote ?? undefined,
        guide: personaGuide,
        notes: rt.seatNotes?.get(pending.seat),
        studyNote: rt.studyNotes?.get(pending.seat),
        timeLimitSec: rt.options.aiTimeLimitSec,
        modelContext: personaModelContext,
      });
      // 人格圈层可见度：仅人格座位注入（普通 AI 不受影响）——
      // 三档（full 全见/partial 勾选迷雾/none 全员迷雾），不破身份壁垒；
      // 含人格名互称指引与羁绊注入（记事簿跨局关系 + 档案互提原作渊源）
      const circleText = buildPersonaCircleText(
        pending.seat,
        (rt.seatPersonas ?? []).map((b) => {
          const card = rt.personaCards?.get(b.seat);
          return {
            seat: b.seat,
            name: b.name,
            // 外貌气质与基本印象取自完整人格卡（断点恢复时卡已删的座位自动退化为仅姓名）
            appearance: card?.profile.appearance ?? null,
            summary: card?.profile.summary?.trim() ?? null,
            originSource: card?.originSource ?? null,
          };
        }),
        rt.options.personaVisibility,
        rt.options.personaFogSeats,
        (await getSeatBonds(rt, pending.seat)) ?? undefined,
      );
      if (circleText) {
        // 注入位铁律：必须落在【输出契约】之前——人格管线会截断契约后的部分
        //（对局 20260930001 实锤：尾部追加被静默切断，人格玩家全程互不认识）
        base.user = injectCircleText(base.user, circleText);
      }
      const personaRes = await runPersonaPipeline({
        cfg,
        card: personaCard,
        memoryText: rt.personaMemory?.get(pending.seat) ?? null,
        pending,
        base,
        modelContext: personaModelContext,
        deadlineAt,
        retryNote,
        resumeNote,
      });
      if (personaRes.personaMeta) {
        if (!rt.personaEventMeta) rt.personaEventMeta = new Map();
        rt.personaEventMeta.set(pending.seat, personaRes.personaMeta);
      }
      return { decision: personaRes.decision, error: personaRes.error };
    }
    // 接线2：每次 buildPrompt 前取经验指南（共通+本版型拼接，60s 内存缓存，不每步查库）
    const guide = await getCachedGuideText(rt.userId, rt.boardId);
    const { system, user } = buildPrompt(pending, {
      retryNote: retryNote ?? undefined,
      resumeNote: resumeNote ?? undefined,
      guide,
      // 该座位的对局笔记（其所思所为的知识库，仅本人可见）
      notes: rt.seatNotes?.get(pending.seat),
      // 赛前图书馆学习心得（开启图书馆且该座位已完成学习时注入）
      studyNote: rt.studyNotes?.get(pending.seat),
      // 决策总时限（用户设置时告知 AI 快速决断）
      timeLimitSec: rt.options.aiTimeLimitSec,
      // 按座位模型上下文动态分配公开记录/指南注入预算（防小上下文模型后期被撑爆）
      modelContext: modelContextTokens(cfg.model),
    });
    // 单次调用超时按模型能力画像分流（思考型 150s / 常规 90s，AI_TIMEOUT_MS 可全覆盖），
    // 且不超过剩余预算；预算紧张时压缩 callAi 内部重试次数；
    // deadlineAt 透传进 callAi——重试循环内逐次按剩余预算截断，预算真正具有约束力
    const cfgTimeoutMs = defaultCallTimeoutMs(cfg);
    const res = await callAi(cfg, system, user, {
      timeoutMs: Math.max(3_000, Math.min(cfgTimeoutMs, remaining - 500)),
      maxRetries: remaining > 100_000 ? 2 : remaining > 40_000 ? 1 : 0,
      deadlineAt,
    });
    if (res.ok && res.text) {
      const parsed = parseDecision(res.text, pending);
      // 证据采集：解析失败时带原始输出片段（折叠空白），下次直接在事件流看到模型真实输出
      const snippet = res.text.replace(/\s+/g, " ").slice(0, 200);
      return parsed
        ? { decision: parsed, error: null }
        : { decision: null, error: `模型输出无法解析：${snippet}` };
    }
    return { decision: null, error: res.error ?? "AI 调用失败" };
  } catch (err) {
    return { decision: null, error: errMessage(err).slice(0, 200) };
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// 应用一次待决决策，返回引擎产出的事件：
// - engine.decide() 校验抛错视为「AI 输出非法」：重试一次 AI（提示中附带错误原因），
//   仍失败则走启发式兜底（thought 标注 "[AI输出非法，系统托管]"），绝不因此暂停对局
// - 连保证合法的兜底决策都被引擎拒绝 → 判定为引擎内部异常，向上抛出（tick 循环据此置 paused）
// 暂停信号：与在飞的 AI 调用竞速，暂停先到则本次 AI 结果被丢弃（调用在后台自行完结，无害）。
// 返回 cancel 用于竞速结束后注销等待者，避免长对局中数组无界增长。
function pauseSignal(rt: GameRuntime): { promise: Promise<null>; cancel: () => void } {
  let wake: (() => void) | null = null;
  const promise = new Promise<null>((resolve) => {
    wake = () => resolve(null);
  });
  rt.pauseWaiters.push(wake!);
  return {
    promise,
    cancel: () => {
      const i = rt.pauseWaiters.indexOf(wake!);
      if (i >= 0) rt.pauseWaiters.splice(i, 1);
    },
  };
}

// 决策挂起信号：对局暂停时抛出——当前 pending 不结算、保留在 rt.pending，
// 待恢复后由 AI 重新思考（暂停前未完成的思考量存入 rt.suspendDraft 供参考）
class SuspendDecision extends Error {
  constructor() {
    super("对局已暂停，决策挂起待恢复");
    this.name = "SuspendDecision";
  }
}

// AI 输出意图保留式修正（engine.decide 硬校验之前）：
// 把「意图明确但触犯规则」的输出修正为最接近的合法等价——
// 典型事故（2026-08-02 线上实锤）：女巫解药首夜已用，第2/3夜仍输出 witchSave=true
// （引擎拒"解药已用完"→重试仍犯→整轮降级"[AI输出非法，系统托管]"，思考量全丢）；
// 白狼王带人时输出 selfDestruct（引擎拒"当前阶段不能自爆"）。
// 修正保住 AI 的思考与合法意图；实在无可保留才交给重试/兜底。修正说明写入事件 meta.repaired 供观测。
export function repairDecision(
  pending: PendingDecision,
  inp: DecisionInput,
): { input: DecisionInput; notes: string[] } {
  const notes: string[] = [];
  const out: DecisionInput = { ...inp };
  const kind = pending.kind;

  // 1) 目标合法性：剔除不在可选范围的目标（options 为空表示任意存活者，不过滤）
  if (out.targets?.length && pending.options.length) {
    const bad = out.targets.filter((t) => !pending.options.includes(t));
    if (bad.length) {
      notes.push(`目标${bad.join("/")}不在可选范围，已剔除`);
      const valid = out.targets.filter((t) => pending.options.includes(t));
      out.targets = valid.length ? valid : undefined;
    }
  }

  // 2) 女巫用药规则（引擎校验所需事实全部在 view 中可得，与引擎同源）
  if (kind === "witchAction") {
    const potions = pending.view.private.witchPotions;
    const victim = pending.view.private.witchVictimTonight ?? null;
    const selfSaveAllowed =
      pending.view.rules?.witchSelfSave === "firstNight" && pending.view.day === 1;
    if (out.witchSave) {
      if (potions && !potions.save) {
        notes.push("解药已用完，忽略解药");
        out.witchSave = undefined;
      } else if (victim == null) {
        notes.push("今夜无人被刀，忽略解药");
        out.witchSave = undefined;
      } else if (victim === pending.seat && !selfSaveAllowed) {
        notes.push("本版型女巫不能自救，忽略解药");
        out.witchSave = undefined;
      }
    }
    if (!out.skip && out.targets?.length && potions && !potions.poison) {
      notes.push("毒药已用完，忽略毒药");
      out.targets = undefined;
    }
    // 互斥：同一晚只能用一瓶药——优先保留解药（防御性意图），弃毒药
    if (out.witchSave && !out.skip && out.targets?.length) {
      notes.push("同一晚只能用一瓶药，保留解药、忽略毒药");
      out.targets = undefined;
    }
    // 修正后无任何有效动作 → 按不用药处理
    if (!out.witchSave && !out.targets?.length && !out.skip) {
      notes.push("无有效用药动作，按不用药处理");
      out.skip = true;
    }
  }

  // 3) 带人/开枪类：剥离不适用的技能字段（selfDestruct/duel 等仅白天技能窗口可用）
  if (kind === "whiteWolfTake" || kind === "hunterShoot") {
    for (const f of ["selfDestruct", "surrender", "declareVictory", "duel"] as const) {
      const v = out[f];
      if (v != null && v !== false) {
        notes.push(`${kind} 不可使用 ${f}，已忽略`);
        out[f] = undefined as never;
      }
    }
    if (out.skip && !pending.allowSkip) {
      notes.push("该决策不允许跳过，忽略 skip");
      out.skip = undefined;
    }
  }

  return { input: out, notes };
}

// 并行批次子决策清洗：保证合并后的批量决策必被引擎接受（批量结算不做整批重试，单点非法不应拖垮同轮其他人）。
// 分流规则：
// - daySkill 权衡子项：仅保留合法的 duel/selfDestruct，其余降级为按兵不动（保留 thought）
// - 其他批次（上警报名/警徽投票/放逐投票等）：AI 的合法选择（targets 落在 options 内、
//   或允许跳过时的 skip）原样保留；只有真正非法的输出才回退启发式兜底（保证该类型合法），
//   绝不把合法选择篡改为 skip——否则不允许跳过的类型（如报名）会被引擎整批拒绝
export function sanitizeBatchInput(sub: PendingDecision, inp: DecisionInput): DecisionInput {
  if (sub.kind === "daySkill") {
    if (inp.selfDestruct && MEETING_WOLVES.has(sub.role)) return { thought: inp.thought, selfDestruct: true };
    if (inp.surrender && MEETING_WOLVES.has(sub.role)) return { thought: inp.thought, surrender: true };
    if (inp.declareVictory && MEETING_WOLVES.has(sub.role)) return { thought: inp.thought, declareVictory: true };
    if (inp.duel != null && sub.role === "knight" && sub.options.includes(inp.duel))
      return { thought: inp.thought, duel: inp.duel };
    return { thought: inp.thought, skip: true };
  }
  // 发言类子项（发言与权衡并行后的合并批次会内嵌发言）：speech 即有效动作——
  // 有效发言必须原样保留，不得误判为非法而整体托管（历史 bug：校验只认 targets/skip，
  // 导致合并批次里每段发言都被打成"[AI输出非法，系统托管]"）；
  // 发言中的自爆/决斗（狼自爆、骑士决斗）合法时同样保留
  if (SPEECH_KINDS.has(sub.kind)) {
    const out: DecisionInput = { thought: inp.thought };
    if (inp.speech) out.speech = inp.speech;
    if (inp.selfDestruct && MEETING_WOLVES.has(sub.role)) out.selfDestruct = true;
    if (
      inp.duel != null &&
      sub.role === "knight" &&
      inp.duel !== sub.seat &&
      sub.view.aliveSeats.includes(inp.duel)
    )
      out.duel = inp.duel;
    if (!out.speech && !out.selfDestruct && out.duel == null)
      return heuristicDecision(sub, "[AI输出非法，系统托管]");
    return out;
  }
  // 纯思考类子项（狼队独立思考并行批次）：thought 即有效动作——
  // 有效思考必须原样保留，不得误判为非法而整体托管（同发言子项的历史误判）
  if (sub.kind === "wolfThink") {
    return inp.thought?.trim()
      ? { thought: inp.thought }
      : heuristicDecision(sub, "[AI输出非法，系统托管]");
  }
  // 赛后讨论子项：speech 即有效动作（哪怕同时给了 skip/无 targets）——发言优先保留；
  // 历史事故复刻防护：通用清洗只认 targets/skip，曾把全部赛后发言误判非法转托管（线上零发言）
  if (sub.kind === "postgameSpeak") {
    const out: DecisionInput = { thought: inp.thought };
    if (inp.speech?.trim()) out.speech = inp.speech.trim();
    if (inp.targets?.length && inp.targets.every((t) => sub.options.includes(t)))
      out.targets = inp.targets.slice(0, 1); // 点名对象至多 1 人
    if (out.speech) return out;
    if (inp.skip && sub.allowSkip) return { thought: inp.thought, skip: true };
    return heuristicDecision(sub, "[AI输出非法，系统托管]");
  }
  // 通用清洗（投票/报名等）：保留合法字段，丢弃非法字段
  const out: DecisionInput = { thought: inp.thought };
  if (inp.speech != null) out.speech = inp.speech;
  if (inp.targets?.length && inp.targets.every((t) => sub.options.includes(t)))
    out.targets = inp.targets;
  if (inp.skip && sub.allowSkip) out.skip = true;
  // 清洗后仍无任何有效动作（目标全非法且不可跳过/未选择跳过）→ 启发式兜底（保证合法）
  if (!out.targets && !out.skip) return heuristicDecision(sub, "[AI输出非法，系统托管]");
  return out;
}

// 并行权衡（daySkill batch）：同轮全部持技玩家并发询问（Promise.all），
// 墙钟≈单次调用，与正常流程双线并进；任一玩家失败仅本人兜底按兵不动，不影响同轮其他人
/** 批次内 AI 并发上限：并行批次（暗票/权衡/狼队思考）一次性并发过多会触发
 *  服务商限流与超时（线上实锤：投票批次 12 路并发导致超时/截断） */
const AI_BATCH_CONCURRENCY = 4;

async function decideBatchWithAi(
  rt: GameRuntime,
  pending: PendingDecision,
  gameId: string,
): Promise<{ events: EngineEvent[]; input: DecisionInput }> {
  const subs = pending.batch!;
  // 批量子决策托管的真实原因（seat → 最后一次失败原因）：结算后透出到本批事件 meta——
  // 历史教训：批量兜底只留「系统托管」标记、真实原因被吞（一局 38 次托管 25 次无从定位）
  const failReasons = new Map<number, string>();
  // 每个子待决各自的决策点总预算（思考型模型自动放宽下限）：
  // AI 故障时单座位最长静默有上限，预算耗尽即本人托管
  // 单点失败带错误原因重试一次，仍失败才本人兜底（批量结算不做整批重试）
  const askWithRetry = async (sub: PendingDecision): Promise<DecisionInput> => {
    const cfg = rt.seatAIs.find((s) => s.seat === sub.seat);
    if (!cfg) {
      failReasons.set(sub.seat, "座位缺少 AI 配置");
      return heuristicDecision(sub, "[AI连续无响应，系统托管]");
    }
    const deadlineAt = Date.now() + decisionDeadlineMs(rt, cfg);
    let res = await askAiOnce(cfg, sub, null, rt, null, deadlineAt);
    if (!res.decision) res = await askAiOnce(cfg, sub, res.error, rt, null, deadlineAt);
    if (!res.decision) {
      failReasons.set(sub.seat, (res.error ?? "AI 调用失败").slice(0, 120));
      return heuristicDecision(sub, "[AI连续无响应，系统托管]");
    }
    // 清洗落托管（「AI输出非法，系统托管」）时透出真实原因与原始输出截断——
    // 历史缺口：sanitizeBatchInput 兜底只换标记，事件 meta 无原因、原始输出丢失，
    // 线上排查无法复盘 AI 到底输出了什么（对局 20261009001 的 2 处托管即此类）
    const sanitized = sanitizeBatchInput(sub, res.decision);
    if (
      typeof sanitized.thought === "string" &&
      sanitized.thought.startsWith("[AI输出非法") &&
      res.decision.thought !== sanitized.thought
    ) {
      failReasons.set(
        sub.seat,
        `AI输出非法已兜底（原始输出：${JSON.stringify(res.decision).replace(/\s+/g, " ").slice(0, 120)}）`,
      );
    }
    return sanitized;
  };
  // 简易并发池：最多 AI_BATCH_CONCURRENCY 路并发
  const inputs: DecisionInput[] = new Array(subs.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < subs.length) {
      const i = cursor++;
      inputs[i] = await askWithRetry(subs[i]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(AI_BATCH_CONCURRENCY, subs.length) }, () => worker()),
  );
  // 竞速期间被暂停：丢弃本批结果，挂起保留 pending，恢复后重新整批权衡
  if (rt.status !== "running") {
    rt.suspendDraft = { thought: null, error: null };
    throw new SuspendDecision();
  }
  // 白日交刀宣布胜利审核（房规）：狼队宣布提前胜利前，先由分析师审核当下狼人胜率——
  // 未达 100% 则宣布无效，视作神民阵营取胜（审核不可用时按原规则放行）
  const declareIdx = inputs.findIndex((inp) => inp.declareVictory === true);
  if (declareIdx >= 0) {
    const audit = await auditDeclareVictory(gameId, rt);
    if (audit === "reject") {
      const seat = subs[declareIdx]!.seat;
      return settleDeclareAuditFail(gameId, rt, seat);
    }
  }
  const combined: DecisionInput = { thought: "", batchInputs: inputs };
  try {
    const events = rt.engine.decide(combined);
    // 批量托管原因透出：按座位汇总挂到本批全部事件（前端「托管原因」行直接可见，
    // 观察者不再只能看到「系统托管」标记却不知为何）
    if (failReasons.size > 0) {
      const reason = [...failReasons.entries()]
        .map(([seat, r]) => `${seat}号：${r}`)
        .join("；")
        .slice(0, 300);
      for (const ev of events) ev.meta = { ...(ev.meta ?? {}), fallbackReason: reason };
    }
    return { events, input: combined };
  } catch (err) {
    // 清洗后仍被拒（防御路径）：全员按兵不动必合法，绝不因此暂停对局
    const fb: DecisionInput = {
      thought: "",
      batchInputs: subs.map((s) => heuristicDecision(s, "[AI输出非法，系统托管]")),
    };
    try {
      const events = rt.engine.decide(fb);
      const reason = `AI输出非法：${errMessage(err).slice(0, 200)}`;
      for (const ev of events) ev.meta = { ...(ev.meta ?? {}), fallbackReason: reason };
      return { events, input: fb };
    } catch (err2) {
      throw new Error(`引擎拒绝保证合法的兜底决策，判定为引擎内部异常: ${errMessage(err2)}`);
    }
  }
}

/** 白日交刀宣布胜利审核：取最新胜率记录判断狼人胜率是否达 100%。
 * 即时性铁律（用户裁定）：拍刀时刻的局面必须即时重评——不沿用既有记录
 *（记录对拍刀时刻必然滞后：上次评估可能生成于数步之前，滞后读数安在当前局面=误判）。
 * 审核不可用（评估失败且无任何记录）时按原规则放行。 */
/** 白日交刀宣布胜利审核：取最新胜率记录判断狼人胜率是否达 100%。
 * 即时性铁律（用户裁定）：拍刀时刻的局面必须即时重评——不沿用既有记录
 *（记录对拍刀时刻必然滞后：上次评估可能生成于数步之前，滞后读数安在当前局面=误判）。
 * 审核不可用（评估失败且无任何记录）时按原规则放行。
 * 导出供测试：即时性语义（不沿用滞后记录）的单测锚点。 */
export async function auditDeclareVictory(gameId: string, rt: GameRuntime): Promise<"pass" | "reject"> {
  // 第一步永远是即时评估当前局面（结果经锚点单调守门禁乱序；与上次相同则按最新读数处理）
  const fresh = rt.winRateEnabled
    ? await runWinRateAnalysis(gameId, rt).catch(() => "skip" as const)
    : ("skip" as const);
  if (fresh === "stored" || fresh === "same") {
    // stored=新评估已落库；same=即时评估与最近记录一致（此刻该记录即当前局面的读数）
    const latest = await getLatestWinRate(gameId);
    if (latest) return latest.wolfPct >= 100 ? "pass" : "reject";
  }
  // 即时评估不可用（AI 故障/解析失败）：回落最近记录兜底；记录也没有 → 审核不可用放行
  const latest = await getLatestWinRate(gameId);
  if (!latest) return "pass";
  return latest.wolfPct >= 100 ? "pass" : "reject";
}

/** 宣布胜利未通过审核：宣布无效，神民阵营取胜（房规结算）。
 * 经引擎外部结算落定（settleExternal）——胜者进引擎快照、结果事件与自然终局同格式、
 * 赛后讨论/终局收尾（胜率终评/人格心理检查/分析报告）走同一 finalize 路径。
 * 历史事故（对局 20261009001）：旁路直写 rt.status+updateGame，引擎完全不知情——
 * 快照 winner 取引擎 → 横幅显示「对局已手动终止」；赛后讨论与心理检查永不触发；
 * 决策日志记的是 batch 待决配单条 skip，恢复重放必分叉。 */
function settleDeclareAuditFail(
  _gameId: string,
  rt: GameRuntime,
  seat: number,
): { events: EngineEvent[]; input: DecisionInput } {
  const snap = rt.engine.getSnapshot();
  const auditEvent: EngineEvent = {
    day: snap.day,
    phase: snap.phase,
    type: "system",
    actor: null,
    title: "宣布胜利未通过审核",
    content: `${seat}号代表狼队宣布提前胜利——分析师审核当前狼人胜率未达 100%，宣布无效！神民阵营获胜。`,
    thought: null,
    meta: { auditReject: true },
  };
  // 引擎外部结算：落定胜者 + 结果事件（含存活表，与自然终局同格式；缘由注记写入结果文案）；
  // 公开广播行携带完整裁决缘由——玩家公开记录必须知道「狼队拍了刀但被驳回」，
  // 否则赛后讨论对胜负逆转毫不知情（对局 20261009001 实锤：全员零提及）
  const engineEvents = rt.engine.settleExternal(
    "good",
    "（白日交刀宣布胜利未通过审核）",
    `【审核】${seat}号代表狼队宣布提前胜利——分析师即时复审当前局面，狼人胜率未达 100%，宣布无效！神民阵营获胜。`,
  );
  return {
    events: [auditEvent, ...engineEvents],
    // 决策日志记 auditSettle（重放时直接调 settleExternal 精确重建，不进 advance/decide 校验）
    input: {
      thought: "",
      auditSettle: "good",
      auditNote: "（白日交刀宣布胜利未通过审核）",
      auditPub: `【审核】${seat}号代表狼队宣布提前胜利——分析师即时复审当前局面，狼人胜率未达 100%，宣布无效！神民阵营获胜。`,
    },
  };
}

// 返回引擎事件 + 实际被引擎采纳的决策输入（供决策日志落盘，断点重放恢复的原料）
async function decideWithAi(
  rt: GameRuntime,
  pending: PendingDecision,
  gameId: string,
): Promise<{ events: EngineEvent[]; input: DecisionInput }> {
  // 并行权衡批次：走并发专线，不进入单人串行流程
  if (pending.batch && pending.batch.length > 1) return decideBatchWithAi(rt, pending, gameId);
  const cfg = rt.seatAIs.find((s) => s.seat === pending.seat);
  let validationError: string | null = null;
  let lastFailedThought: string | null = null; // 最近一次校验失败尝试的思考内容（挂起时保存用）
  let lastAiError: string | null = null; // 最近一次 AI 调用失败原因（兜底事件 meta 可观测用）

  // 恢复重想：若该决策点是暂停后恢复的，把挂起时保存的「未完成思考量」注入 prompt 供参考
  let resumeNote: string | null = null;
  if (rt.suspendDraft) {
    const d = rt.suspendDraft;
    resumeNote = d.thought
      ? `本决策点此前曾暂停，你暂停前的一轮思考（未生效）供参考：「${d.thought}」${d.error ? `（该次选择因「${d.error}」未通过校验，请勿重复）` : ""}。请基于当前局势重新完整思考后决策，可以采纳、修正或抛弃之前的想法。`
      : "本决策点此前曾暂停，现恢复对局。请基于当前局势重新完整思考后决策。";
    rt.suspendDraft = null; // 只注入一次
  }

  // 托管兜底结算：AI 失败兜底用；兜底决策保证合法，被拒即引擎内部异常。
  // 兜底事件 meta 附真实失败原因（fallbackReason）：观察者可直接在事件流定位托管根因
  const settleByFallback = (note: string): { events: EngineEvent[]; input: DecisionInput } => {
    const fallback = heuristicDecision(pending, note);
    try {
      const events = rt.engine.decide(fallback);
      const reason = validationError
        ? `AI输出非法：${validationError}`
        : lastAiError
          ? `AI调用失败：${lastAiError}`
          : null;
      if (reason) {
        for (const ev of events) {
          ev.meta = { ...(ev.meta ?? {}), fallbackReason: reason.slice(0, 200) };
        }
      }
      return { events, input: fallback };
    } catch (err) {
      throw new Error(`引擎拒绝保证合法的兜底决策，判定为引擎内部异常: ${errMessage(err)}`);
    }
  };

  if (cfg) {
    // 决策点总预算：两次尝试共享同一截止线（AI 故障时最长静默预算，超时即托管；
    // 思考模式提供方自动放宽下限——过紧预算只会批量超时转托管）
    const deadlineAt = Date.now() + decisionDeadlineMs(rt, cfg);
    for (let attempt = 0; attempt < 2; attempt++) {
      // 已暂停：挂起而非接管——保留 pending 与已完成思考量，待恢复后重新思考
      if (rt.status !== "running") {
        rt.suspendDraft = { thought: lastFailedThought, error: validationError };
        throw new SuspendDecision();
      }
      if (Date.now() >= deadlineAt) {
        lastAiError = "AI响应总预算耗尽，转入托管";
        break;
      }
      const sig = pauseSignal(rt);
      const res = await Promise.race([
        askAiOnce(cfg, pending, validationError, rt, resumeNote, deadlineAt),
        sig.promise,
      ]);
      sig.cancel();
      // 暂停先到（或竞速期间被暂停）：丢弃本次 AI 结果，保存未完成思考量后挂起停链
      if (rt.status !== "running") {
        rt.suspendDraft = { thought: lastFailedThought, error: validationError };
        throw new SuspendDecision();
      }
      if (res === null) break; // 暂停信号竞速胜出（防御路径；正常已被上面 status 检查拦截）
      const { decision, error } = res;
      if (!decision) {
        lastAiError = error;
        break; // AI 无响应/输出损坏：直接启发式兜底
      }
      // 意图保留式修正后再交引擎校验（修正说明写入事件 meta.repaired，可观测）
      const repaired = repairDecision(pending, decision);
      try {
        const result = { events: rt.engine.decide(repaired.input), input: repaired.input };
        if (repaired.notes.length) {
          const tag = `AI输出修正：${repaired.notes.join("；")}`.slice(0, 200);
          for (const ev of result.events) ev.meta = { ...(ev.meta ?? {}), repaired: tag };
        }
        return result;
      } catch (err) {
        validationError = errMessage(err).slice(0, 200);
        lastFailedThought = decision.thought ?? null;
        // 修正后仍非法：视为 AI 输出非法，带错误原因重试一次
      }
    }
  }

  return settleByFallback(
    validationError ? "[AI输出非法，系统托管]" : "[AI连续无响应，系统托管]",
  );
}

// ---------- tick 循环（setTimeout 链，绝不阻塞） ----------
function scheduleTick(gameId: string, rt: GameRuntime, delayMs: number): void {
  if (rt.timer) clearTimeout(rt.timer);
  rt.timer = setTimeout(() => {
    rt.timer = null;
    void runTick(gameId);
  }, delayMs);
}

// ---------- 分析任务流水线：analyze（复盘报告→落库→内存检查点）→ distill（蒸馏进经验指南） ----------
// 分段 + 检查点：每段开始都刷新 updatedAt 心跳；analyze 产物落库的同时写入 job.report，
// 任务中途死亡（进程波动/调用悬挂）时可从检查点复活——有 report 则跳过 analyze 直接续跑 distill。
// 负责维护 analysisJobs 状态；异常向上抛出（调用方决定记日志还是仅置 failed）
async function runAnalysisJob(gameId: string, cfg: AnalystAiConfig): Promise<void> {
  // 检查点恢复：既有任务停在 distill 阶段且持有 report → 复用任务对象续跑，否则从头开始
  const existing = analysisJobs.get(gameId);
  const job: AnalysisJob =
    existing && existing.report && existing.stage === "distill"
      ? existing
      : { status: "running", stage: null, error: null, updatedAt: 0, report: null, commonDone: false, cfg, snapshot: null };
  job.status = "running";
  job.error = null;
  job.cfg = cfg;
  job.updatedAt = Date.now();
  analysisJobs.set(gameId, job);
  // 指南蒸馏归属：对局属主（账户隔离）；读取失败不放行他人经验（蒸馏跳过指南段较安全？——
  // 实际选择：无法确认归属则抛错终止任务，绝不让经验写入错误账户）
  const ownerRow = await getGame(gameId);
  const ownerId = ownerRow?.userId;
  if (!ownerId) throw new Error(`无法确认对局 ${gameId} 的归属用户，分析任务终止`);

  try {
    // ---------- 阶段 1：analyze（导出对局 → AI 复盘 → 报告落库 + 内存检查点） ----------
    if (!job.report) {
      job.stage = "analyze";
      job.updatedAt = Date.now();
      const { snapshot, events } = await exportGame(gameId);
      job.snapshot = snapshot;
      const report = await runAnalysis(cfg, snapshot, events as GameEvent[]);
      await upsertAnalysis(gameId, report, cfg.model);
      job.report = report; // 内存检查点：此后任务死亡可跳过 analyze 直接续跑 distill
      job.updatedAt = Date.now();
    }

    // ---------- 阶段 2：distill 两段式（共通指南 → 版型指南，各自独立 scope 落库） ----------
    job.stage = "distill";
    job.updatedAt = Date.now();
    // 复活路径上快照可能不在内存（如外部构造的检查点任务）：回退到重新导出
    const snapshot = job.snapshot ?? (await exportGame(gameId)).snapshot;
    const boardId = snapshot.boardId;
    const winnerLabel =
      snapshot.winner === "wolf" ? "狼人胜" : snapshot.winner === "good" ? "好人胜" : "胜负未知";

    // 段 1：共通经验（scope="common"）；commonDone 检查点命中则跳过（自愈重跑不重复落库）
    let commonGuide: string | null = null;
    if (!job.commonDone) {
      const latestCommon = await getLatestGuide(ownerId, "common");
      commonGuide = await runDistillCommon(cfg, latestCommon?.content ?? null, job.report);
      await insertGuideVersion({
        scope: "common",
        version: (latestCommon?.version ?? 0) + 1,
        content: commonGuide,
        gameId,
        note: `共通｜收录对局 ${gameId.slice(0, 8)}：${snapshot.boardName} ${winnerLabel}`,
        userId: ownerId,
      });
      job.commonDone = true; // 内存检查点：此后任务死亡可跳过共通段直接续跑版型段
      job.updatedAt = Date.now();
    } else {
      // 跳过共通段时仍需其最新内容，用于刷新注入缓存
      commonGuide = (await getLatestGuide(ownerId, "common"))?.content ?? null;
    }

    // 段 2：版型特定经验（scope=版型 id）
    const boardCtx = {
      boardName: snapshot.boardName,
      rolesSummary: BOARDS.find((b) => b.id === boardId)?.summary ?? snapshot.boardName,
      // 本版型规则文本：蒸馏 prompt 据此禁止与规则相悖的建议（如 12 人场女巫自救）
      rulesText: buildBoardRulesText(boardId),
    };
    const latestBoard = await getLatestGuide(ownerId, boardId);
    const boardGuide = await runDistillBoard(cfg, boardCtx, latestBoard?.content ?? null, job.report);
    await insertGuideVersion({
      scope: boardId,
      version: (latestBoard?.version ?? 0) + 1,
      content: boardGuide,
      gameId,
      note: `${snapshot.boardName}｜收录对局 ${gameId.slice(0, 8)}：${winnerLabel}`,
      userId: ownerId,
    });
    // 指南已更新：立即刷新该版型的注入缓存，后续决策用上最新版
    guideCache.set(`${ownerId}:${boardId}`, {
      at: Date.now(),
      text: combineGuideText(boardId, commonGuide ?? "", boardGuide),
    });
    job.stage = null;
    job.status = "done";
    job.updatedAt = Date.now();
  } catch (err) {
    job.status = "failed";
    job.error = errMessage(err).slice(0, 500); // 保留原始 API 错误，前端「分析失败 · 重试」可见
    job.updatedAt = Date.now();
    throw err;
  }
}

// ---------- 胜率推测（分析师实时评估双方胜率，非阻塞、不排队） ----------
// 触发时机：对局启动 / 每批事件落盘后 / 断点恢复续跑 / 终局（保底再评估一次）。
// 在飞去重：一次分析未结束时跳过新触发——只分析最新状态，绝不排队积压（保证及时性）。
// 失败静默：AI 调用失败/输出无法解析/越界一律跳过，不污染事件流、不阻塞对局循环。

/** 胜率输出解析：去围栏截取首个 { 到末个 }；good 必须落在 0-100，reasons 裁剪到 ≤6 条 ≤120 字 */
export function parseWinRateOutput(text: string): { good: number; reasons: string[]; causeLabel: string | null } | null {
  const cleaned = text.replace(/```(?:json)?/gi, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  const jsonText = cleaned.slice(start, end + 1);
  let obj: unknown;
  try {
    obj = JSON.parse(jsonText);
  } catch {
    // 模型把原始控制字符直接写进字符串的高频失败形态：替换为空格再试一次
    try {
      obj = JSON.parse(jsonText.replace(/[\x00-\x1F]/g, " "));
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  const good = typeof o.good === "number" ? Math.round(o.good) : NaN;
  if (!Number.isFinite(good) || good < 0 || good > 100) return null;
  const reasons = (Array.isArray(o.reasons) ? o.reasons : [])
    .filter((r): r is string => typeof r === "string" && r.trim().length > 0)
    .slice(0, 6)
    .map((r) => r.trim().slice(0, 120));
  // 胜率变化的直接缘由标签（格式：第N天/第N夜 · 人物（可选）· 具体事件）；缺失/非法回退 null
  const causeLabel =
    typeof o.causeLabel === "string" && o.causeLabel.trim().length >= 4
      ? o.causeLabel.trim().slice(0, 80)
      : null;
  return { good, reasons, causeLabel };
}

/** 上帝视角 prompt：引擎快照（身份全亮）+ 座位模型表 + 版型 + 用户选项 + 最近事件 + 经验指南。
 * 快照由调用方在「prompt 构建时刻」捕获传入：标签与内容同源（杜绝 AI 思考期间对局推进
 * 导致落库的 day/phase 与 prompt 内容不匹配） */
function buildWinRatePrompt(
  rt: GameRuntime,
  snap: ReturnType<Engine["getSnapshot"]>,
  events: GameEvent[],
  prevGood: number | null,
  guide: string,
  recentLabels: string[] = [],
): { system: string; user: string } {
  const board = BOARDS.find((b) => b.id === rt.boardId);
  const campLabel = (camp: string) => (camp === "wolf" ? "狼人" : camp === "god" ? "神" : "民");
  const playerLines = snap.players.map((p) => {
    const ai = rt.seatAIs.find((a) => a.seat === p.seat);
    const status = [p.alive ? "存活" : `已死亡（${p.deathInfo ?? "死因未知"}）`];
    if (p.sheriff) status.push("警长");
    // 技能存量与查验记录是引擎权威事实（女巫解药已用就是已用），分析师据此评估，杜绝编造
    return `${p.seat}号 ${ROLE_META[p.role]?.name ?? p.role}（${campLabel(p.camp)}阵营）${status.join("·")}，模型：${ai?.model ?? "未知"}${p.stock.length ? `，技能存量：${p.stock.join("、")}` : ""}${p.checks.length ? `，查验记录：${p.checks.join("，")}` : ""}`;
  });
  const eventLines = events.map(
    (e) =>
      `#${e.seq} 第${e.day}天 ${e.phase} [${e.type}] ${e.actorLabel ?? "系统"}《${e.title}》${e.content.slice(0, 200)}`,
  );
  const system = [
    "你是狼人杀对局的分析师，拥有上帝视角（知晓所有玩家真实身份与全部事件）。",
    "你的任务：基于当前对局的一切要素，实时评估「神民阵营」的胜率（0-100 的整数）。",
    "综合考量：人数与阵营比、轮次与游戏节奏、神职存活与技能存量（女巫解药/毒药、守卫守护等）、警徽归属、死亡链、发言与投票行为的可信度、各座位所用 AI 模型的强弱对阵营表现的影响等一切要素。",
    '严格只输出 JSON（不要输出任何其他文字）：{"good": 0-100的整数, "causeLabel": "胜率变化的直接缘由标签", "reasons": ["理由1", "理由2", ...]}',
    prevGood != null
      ? `你上一次评估的神民阵营胜率是 ${prevGood}%。reasons 只写「相比上次评估、导致胜率发生变化」的新原因（新的事件、新的信息、局势转折）——不要重复此前已经给出的理由；若你的判断与上次相同，reasons 返回空数组。`
      : "reasons 只写导致胜率判断的原因与依据（这是首次评估）。",
    "causeLabel：从最近事件中定位「导致本次胜率变化的直接缘由」——它不是当前时刻的事件，而是造成胜率变动的那个具体事件；格式为「第N天/第N夜 · 人物（可选）· 具体事件」，例如「第1夜 · 3号女巫 · 毒杀5号狼人」「第2天 · 放逐投票 · 5号出局」（无明确人物时省略人物段）。",
    recentLabels.length > 0
      ? `以下缘由标签已被最近记录占用：${recentLabels.map((l) => `「${l}」`).join("")}——同一事件只允许对应一次胜率变化，不得重复引用；若你的评估与其中某条缘由相同，说明与上次判断一致：good 必须等于上次值（该次评估不落库）。`
      : "每个胜率变化事件只能对应一次胜率变化：若与上次的直接缘由是同一事件，good 必须与上次相同。",
    "reasons 最多 6 条，每条不超过 120 字。",
    "数值方向必须与理由一致：若你写的理由主要利于狼人阵营，则神民胜率 good 必须比上次下降；主要利于神民则 good 必须上升——理由与数值矛盾会被视为无效评估。",
    "每条理由必须细化到具体的行为主体与动作——写明「几号玩家（角色名）做了什么、对局势产生什么影响」（例如「3号女巫昨夜毒杀了5号狼人，狼队人数优势被抹平」），不要只写「狼队夜刀成功」「白天出了个平安夜」这类不含主体的宏观概括。",
  ].join("\n");
  const userLines = [
    `版型：${board?.name ?? rt.boardId}（${rt.boardId}）`,
    `用户配置选项：${JSON.stringify(rt.options)}`,
    `当前进度：第${snap.day}天 · ${snap.phaseLabel}（${snap.phase}）；${snap.finished ? `对局已结束，${snap.winner === "wolf" ? "狼人阵营获胜" : snap.winner === "good" ? "神民阵营获胜" : "未分胜负"}` : "对局进行中"}`,
    "",
    "玩家（上帝视角，身份全亮）：",
    ...playerLines,
    "",
    "最近事件（按时间顺序）：",
    ...(eventLines.length > 0 ? eventLines : ["（暂无事件）"]),
  ];
  // 经验指南为空时不注入该小节；超长截断到 4000 字符，防止指南膨胀导致 prompt 爆 token
  const guideText = guide.trim().slice(0, 4000);
  if (guideText) {
    userLines.push(
      "",
      "经验指南（通用指南 + 本版型指南，分析师经验沉淀，供你评估时参考）：",
      guideText,
    );
  }
  const user = userLines.join("\n");
  return { system, user };
}

/** 胜率分析结果："stored"=落库 / "same"=胜率未变不落库 / "stale"=内容已过时丢弃（调用方立即重评） / "skip"=其余静默跳过 */
export type WinRateAnalysisResult = "stored" | "same" | "stale" | "skip";

/** 执行一次胜率分析：AI 评估 → 解析校验 → 新鲜度守门 → 落库（入库后无需更新 rt，前端走轮询游标拉取）。
 * 标签与内容同源：落库的 day/phase/triggerLabel 全部锚定「prompt 构建时刻」的快照与事件，
 * 不再用 AI 返回时刻的状态（AI 思考 30-90s 期间对局可能已推进数步，旧写法标签严重滞后内容） */
async function runWinRateAnalysis(gameId: string, rt: GameRuntime): Promise<WinRateAnalysisResult> {
  // 分析配置：优先分析师配置，缺省回落到 1 号座位的座位配置（分析师与玩家共用同一 agent）
  const base = rt.analystAi ?? (rt.seatAIs[0] ? {
    provider: rt.seatAIs[0].provider,
    baseUrl: rt.seatAIs[0].baseUrl,
    model: rt.seatAIs[0].model,
    apiKey: rt.seatAIs[0].apiKey,
  } : null);
  if (!base) return "skip";
  // 上一次评估：prompt 据此聚焦「导致胜率变化的新原因」（不重复旧理由）；
  // 胜率判断不变时本条不予落库（理由列表只呈现胜率实际发生变化的记录）
  const prev = await getLatestWinRate(gameId);
  // 最近已占用缘由标签（防同一事件重复对应胜率变化——prompt 警示 + 落库前去重双保险）
  const recentRows = prev ? await getWinRatesAfter(gameId, Math.max(0, prev.id - 3)) : [];
  const recentLabels = recentRows
    .map((r) => r.triggerLabel)
    .filter((l): l is string => typeof l === "string" && l.length > 0)
    .slice(-4);
  // 近乎即时：事件窗口收窄到最近 15 条（prompt 更小、评估更快），胜率依据集中在近期动态
  const events = await getLatestEvents(gameId, 15);
  // prompt 构建时刻的快照与事件游标：落库标签与内容同源 + 新鲜度守门基准
  const promptSnap = rt.engine.getSnapshot();
  const promptSeq = events.length > 0 ? events[events.length - 1].seq : 0;
  // 预演循环基准：本次评估锚定的状态游标与时刻
  rt.winRateLastEvalAt = Date.now();
  rt.winRateLastSeq = promptSeq;
  // 触发事件锚点：取本次 prompt 最近一条事件（如「4号狼人独立思考」「3号警上发言」，
  // 角色名与事件标题之间不加空格）；无事件（开局评估）为 null
  const triggerEvent = events.length > 0 ? events[events.length - 1] : null;
  const triggerLabel = triggerEvent
    ? triggerEvent.actor != null
      ? `${triggerEvent.actor}号${
          ROLE_META[
            promptSnap.players.find((p) => p.seat === triggerEvent.actor)?.role as RoleId
          ]?.name ?? ""
        }${triggerEvent.title}`
      : triggerEvent.title
    : null;
  // 经验指南注入（与玩家决策同一缓存机制：60s 缓存 + 超时/失败退回空，绝不阻塞分析）
  const guide = await getCachedGuideText(rt.userId, rt.boardId);
  const { system, user } = buildWinRatePrompt(rt, promptSnap, events, prev?.goodPct ?? null, guide, recentLabels);
  // 单次上限：评估是即时性辅助功能，超时就放（dirty 追逐/守门外层兜底），绝不拖长战线；
  // 思考型模型（kimi-k3 等）思考链耗时长，60s 必然大面积超时 → 放宽到 120s
  const res = await callAi({ ...base, seat: 0 }, system, user, {
    maxRetries: 1,
    timeoutMs: isThinkingModel(base) ? 120_000 : 60_000,
  });
  if (!res.ok || !res.text) return "skip";
  const parsed = parseWinRateOutput(res.text);
  if (!parsed) return "skip"; // 输出无法解析/越界：静默跳过，不污染记录
  // 新鲜度策略（提速对局适配）：AI 思考期间对局又推进 ≠ 丢弃——该评估锚定的是
  // 「prompt 构建时刻」的状态（day/phase/triggerLabel/causeLabel 全部同源），作为
  // 该时刻的合法读数照常落库；新事件已由 dirty 标记驱动立即重评最新状态。
  // （旧策略 stale 即丢弃：提速后对局每分钟都有新事件，慢分析师被永久判过期 → 记录饿死）
  if (prev && parsed.good === prev.goodPct) return "same"; // 胜率未变：不落库、不显示
  // 同一事件只允许对应一次胜率变化：缘由标签与上一条记录相同（归一化比对）→ 按未变化处理
  const norm = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, "");
  if (parsed.causeLabel && norm(parsed.causeLabel) === norm(prev?.triggerLabel)) return "same";
  // 锚点单调性：只接受「锚定游标比已落库记录更新」的评估——乱序/同状态的评估会造成
  // 阵营颜色与涨跌方向错乱、同一变动重复出现（提速后乱序窗口显著，必须单调落库）
  if (promptSeq <= rt.winRateLastStoredSeq) return "skip";
  // 开局尚未进入第1天（初始化态无任何实质进展）不落记录：面板维持 50/50 初始态，
  // 首个事件批（第1夜降临）落盘后的触发立即补上首次评估
  if (promptSnap.day < 1) return "skip";
  await insertWinRate({
    gameId,
    day: promptSnap.day,
    phase: promptSnap.phase,
    goodPct: parsed.good,
    wolfPct: 100 - parsed.good,
    reasons: parsed.reasons,
    // 标签=胜率变化的直接缘由（分析师从事件中定位；缺省回退系统锚定的触发事件）
    triggerLabel: parsed.causeLabel ?? triggerLabel,
  });
  rt.winRateLastStoredSeq = promptSeq;
  return "stored";
}

/** 章节选读解析：从 AI 输出中提取「书名 → 章节名」选择（JSON 优先，宽容匹配）；失败返回 null */
function parseChapterSelection(
  text: string,
  docs: { name: string; chapters: { title: string; text: string }[] }[],
): Map<string, Set<string>> | null {
  try {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]) as { read?: { doc?: unknown; chapters?: unknown }[] };
    if (!Array.isArray(parsed?.read)) return null;
    const out = new Map<string, Set<string>>();
    for (const item of parsed.read) {
      const docName = String(item?.doc ?? "");
      const doc = docs.find(
        (d) => d.name === docName || d.name.replace(/\.[^.]+$/, "") === docName.replace(/\.[^.]+$/, ""),
      );
      if (!doc) continue;
      const titles = new Set<string>();
      const requested = Array.isArray(item?.chapters) ? item.chapters : [];
      for (const ct of requested) {
        const want = String(ct);
        const hit = doc.chapters.find(
          (c) => c.title === want || c.title.includes(want) || want.includes(c.title),
        );
        if (hit) titles.add(hit.title);
      }
      if (titles.size > 0) out.set(doc.name, titles);
    }
    return out.size > 0 ? out : null;
  } catch {
    return null;
  }
}

/** 赛前学习（图书馆研读 + 历史对局参考）：全部座位同时并发学习（全员一起，节省等待时间）。
 * 每个座位的学习路径：书名选读（≥3 本时）→ 章节选读（大部头按目录，书名-章节为线索）
 * → 精简实战心得（≤900 字锦囊，可完整注入决策 prompt）→ 自主选择最相关的 1-2 局
 * 历史对局复盘摘要（≤280 字/局）。心得重试直至学成——保证全员都已学习完毕才开赛；
 * 历史参考失败仅跳过该段，不影响已得心得。暂停/终止即中断学习。笔记落 game_studies。 */
async function runStudyPhase(gameId: string, rt: GameRuntime): Promise<void> {
  if (!rt.studyNotes) rt.studyNotes = new Map();
  if (!rt.studyDoneSeats) rt.studyDoneSeats = new Set();
  const docs = await getAllLibraryContents(rt.userId ?? "");
  const libText = docs
    .map((d) => `《${d.name}》\n${d.content}`)
    .join("\n\n")
    .slice(0, 12_000); // 总量封顶（再按模型预算截断）
  if (!libText.trim()) return; // 图书馆为空：直接视为学完
  const board = BOARDS.find((b) => b.id === rt.boardId);
  const boardName = board?.name ?? rt.boardId;
  const perCallMs = Math.max(5, rt.options.libraryMaxSec ?? 120) * 1000;
  const seats = rt.seatAIs.map((s) => s.seat);
  const roleOf = (seat: number) => {
    const r = rt.engine.getSnapshot().players.find((p) => p.seat === seat)?.role;
    return r ? (ROLE_META[r]?.name ?? r) : "";
  };
  if (!rt.studyInFlight) rt.studyInFlight = new Set();

  // 章节线索预切分（确定性，全座位共享）
  const SMALL_DOC = 3_000; // 小文档直接通读，不做章节选读
  const chaptered = docs.map((d) => ({ ...d, chapters: splitDocChapters(d.content) }));

  // 历史对局候选（全座位共享一次性查询）：已分胜负的已结束对局，最新 20 局；查询失败则跳过历史参考
  let historyRows: Awaited<ReturnType<typeof listGames>> = [];
  try {
    historyRows = (await listGames(rt.userId ?? ""))
      .filter((r) => r.id !== gameId && r.status === "finished" && r.winner != null)
      .slice(0, 20);
  } catch {
    /* 历史候选查询失败：跳过历史参考段 */
  }

  const studySeat = async (seat: number) => {
    const cfg = rt.seatAIs.find((s) => s.seat === seat);
    if (!cfg) {
      rt.studyDoneSeats!.add(seat);
      return;
    }
    rt.studyInFlight!.add(seat);
    try {
      const roleName = roleOf(seat);
      // 思考型模型（DeepSeek 默认思考 / kimi-k3 永远思考等）耗时长，单次下限放宽到 150s
      const callTimeoutMs = isThinkingModel(cfg) ? Math.max(perCallMs, 150_000) : perCallMs;

      // ---- 历史对局参考轨（与书籍学习轨并行开跑）----
      // 选局与摘要的输入只依赖座位/身份/版型，与书籍心得互不依赖——串行排队曾是纯浪费
      // （最坏链 60+60+180+60+2×180s ≈ 12 分钟；并行后关键路径=max(书籍轨, 历史轨)）。
      // 书籍轨失败时 refs 算白算（小概率失败路径的零星浪费，换成功路径省一半时间）。
      const historyTrack: Promise<string[]> = (async (): Promise<string[]> => {
        const refs: string[] = [];
        if (historyRows.length === 0 || rt.status !== "created") return refs;
        try {
          const candidates = historyRows.map((r) => ({
            id8: r.id.slice(0, 8),
            boardName: r.boardName,
            result: r.winner === "wolf" ? "狼人胜" : "神民胜",
            dayCount: r.dayCount,
            date: (r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt)).slice(0, 10),
          }));
          const hp = buildHistoryPickPrompt(seat, roleName, boardName, candidates);
          const hres = await callAi(cfg, hp.system, hp.user, {
            timeoutMs: Math.min(perCallMs, 60_000),
            maxRetries: 0,
          });
          let chosenIds = hres.ok && hres.text
            ? candidates.filter((c) => hres.text!.includes(c.id8)).map((c) => c.id8)
            : [];
          if (chosenIds.length === 0) {
            // 选取失败兜底：同版型最近一局，否则最新一局
            const sameBoard = candidates.find((c) => c.boardName === boardName);
            chosenIds = [(sameBoard ?? candidates[0]).id8];
          }
          // 两局摘要并行（相互独立）；暂停/终止即各自中断
          const summaries = await Promise.all(
            chosenIds.slice(0, 2).map(async (id8) => {
              if (rt.status !== "created") return null;
              const row = historyRows.find((r) => r.id.startsWith(id8));
              if (!row) return null;
              const events = await getAllEvents(row.id);
              if (events.length === 0) return null;
              const snap = snapshotFromRow(row.id, row, events[events.length - 1].seq);
              const d0 = buildLogDigest(snap, events);
              const digest = d0.length > 2_500
                ? `${d0.slice(0, 1_700)}\n……（中段省略）……\n${d0.slice(-700)}`
                : d0;
              const sp = buildHistoryRefPrompt(seat, roleName, row.boardName, digest);
              const sres = await callAi(cfg, sp.system, sp.user, {
                jsonMode: false,
                timeoutMs: callTimeoutMs,
                maxRetries: 0,
              });
              return sres.ok && sres.text?.trim()
                ? `${row.boardName}·${row.winner === "wolf" ? "狼人胜" : "神民胜"}：${sres.text.trim().replace(/\s+/g, " ").slice(0, 280)}`
                : null;
            }),
          );
          for (const s of summaries) if (s) refs.push(s);
        } catch {
          /* 历史参考失败仅跳过该段，不影响已得心得 */
        }
        return refs;
      })();
      historyTrack.catch(() => []); // 防御：轨道内已全捕，此处仅杜绝未处理拒绝

      // ---- 阶段一：书名选读（≥3 本时按身份与主题相关性选书，小馆直接全读）----
      let chosen = chaptered;
      if (chaptered.length > 2) {
        const pick = buildStudyPickPrompt(seat, roleName, chaptered.map((d) => d.name));
        const pres = await callAi(cfg, pick.system, pick.user, {
          timeoutMs: Math.min(perCallMs, 60_000),
          maxRetries: 0,
        });
        if (pres.ok && pres.text) {
          const picked = new Set<number>();
          for (let i = 0; i < chaptered.length; i++) {
            if (pres.text.includes(chaptered[i].name) || pres.text.includes(chaptered[i].name.replace(/\.[^.]+$/, ""))) {
              picked.add(i);
            }
          }
          if (picked.size > 0) chosen = chaptered.filter((_, i) => picked.has(i));
        }
      }

      // ---- 阶段二：章节选读（大部头按目录按需研读；小文档直接通读）----
      const isBig = (d: (typeof chaptered)[number]) => d.content.length > SMALL_DOC && d.chapters.length > 1;
      const smallText = chosen
        .filter((d) => !isBig(d))
        .map((d) => `《${d.name}》\n${d.content}`)
        .join("\n\n");
      const bigDocs = chosen.filter(isBig);
      let chapterText = "";
      if (bigDocs.length > 0) {
        const pick = buildChapterPickPrompt(
          seat,
          roleName,
          boardName,
          bigDocs.map((d) => ({ name: d.name, chapters: d.chapters.map((c) => c.title).slice(0, 50) })),
        );
        const pres = await callAi(cfg, pick.system, pick.user, {
          timeoutMs: Math.min(perCallMs, 60_000),
          maxRetries: 0,
        });
        const sel = pres.ok && pres.text ? parseChapterSelection(pres.text, bigDocs) : null;
        const parts: string[] = [];
        for (const d of bigDocs) {
          const titles = sel?.get(d.name);
          const use = titles ? d.chapters.filter((c) => titles.has(c.title)) : d.chapters.slice(0, 2); // 选读失败兜底：前两章
          for (const c of (use.length > 0 ? use : d.chapters.slice(0, 2))) {
            parts.push(`《${d.name}》${c.title}\n${c.text}`);
          }
        }
        chapterText = parts.join("\n\n");
      }
      let reading = [smallText, chapterText].filter((t) => t.trim()).join("\n\n").slice(0, 15_000);
      if (!reading.trim()) {
        // 极端兜底（章节切分异常等）：退回书首通读
        reading = chosen.map((d) => `《${d.name}》\n${d.content.slice(0, 9_000)}`).join("\n\n").slice(0, 15_000);
      }

      // ---- 阶段三：撰写精简实战心得（重试直至学成）----
      const { system, user } = buildStudyPrompt(seat, boardName, reading, roleName, rt.options.libraryMaxSec);
      let noteText = "";
      // 重试直至学成（保证全员学习完毕才开赛）：最多 8 次（约覆盖小时级瞬时故障）；
      // 持续不可用（如密钥失效）时该座位按未学习开赛，避免对局永远无法开始；
      // 暂停/终止（status 离开 created）即中断
      for (let attempt = 0; attempt < 8; attempt++) {
        if (rt.status !== "created") return;
        const res = await callAi(cfg, system, user, {
          jsonMode: false,
          timeoutMs: callTimeoutMs,
          maxRetries: 0,
        });
        const note = res.ok && res.text ? res.text.trim().slice(0, 900) : "";
        if (note) {
          noteText = note;
          break;
        }
        // 退避后重试：3s → 6s → … 封顶 30s
        await new Promise((r) => setTimeout(r, Math.min(30_000, 3_000 * (attempt + 1))));
      }

      // ---- 阶段四：历史对局参考（并行轨汇合——轨道在书籍学习启动前已开跑）----
      const refs = await historyTrack;

      // ---- 合并成稿：精简心得 + 历史参考，整体 ≤1400 字符（可完整注入决策 prompt）----
      if (noteText) {
        const historySection = refs.length > 0
          ? `\n\n【历史对局参考】\n${refs.map((r) => `- ${r}`).join("\n")}`
          : "";
        const finalNote = `${noteText}${historySection}`.slice(0, 1_400);
        rt.studyNotes!.set(seat, finalNote);
        void upsertStudyNote(gameId, seat, finalNote).catch(() => {
          /* 笔记落库失败不阻塞 */
        });
      }
    } finally {
      rt.studyInFlight!.delete(seat);
      rt.studyDoneSeats!.add(seat);
    }
  };
  // 全员同时学习（无并发上限——学习为一次性长调用，用户明确要求并行省时）
  await Promise.all(seats.map(studySeat));
}

/** 胜率预演循环（「预判断」机制）：对局 running 期间每 ~3.5s 巡检一次——
 * 有新事件（seq 推进）立即评估；无新事件的空隙每 20s 也做一次预演（利用玩家思考的
 * 时间空隙提前完成当前状态评估，事件落地即可秒出结果）；暂停/终局自动停止，
 * control("start")/startPostGame 恢复时重新拉起。定时器 unref，绝不阻碍进程退出。 */
function startWinRateLoop(gameId: string, rt: GameRuntime): void {
  if (!rt.winRateEnabled || rt.winRateLoopTimer) return;
  const tick = () => {
    rt.winRateLoopTimer = null;
    if (!rt.winRateEnabled || rt.status !== "running") return;
    const advanced = rt.seq !== rt.winRateLastSeq;
    const idleMs = Date.now() - rt.winRateLastEvalAt;
    if (!rt.winRateInFlight && (advanced || idleMs >= 20_000)) {
      maybeWinRateTick(gameId, rt); // 事件追逐 / 空隙预演
    }
    const t = setTimeout(tick, 3_500);
    (t as { unref?: () => void }).unref?.();
    rt.winRateLoopTimer = t;
  };
  const t = setTimeout(tick, 3_500);
  (t as { unref?: () => void }).unref?.();
  rt.winRateLoopTimer = t;
}

/** 触发一次胜率分析（非阻塞）：在飞则记脏标记（完成后立即用最新状态重评，近乎即时），
 * 终局时记保底标记（在飞完成后补一次） */
function maybeWinRateTick(gameId: string, rt: GameRuntime): void {
  if (!rt.winRateEnabled) return;
  if (rt.status !== "running" && rt.status !== "finished") return;
  if (rt.winRateInFlight) {
    if (rt.status === "finished") rt.winRateFinalPending = true; // 终局保底：在飞完成后补终局评估
    else rt.winRateDirty = true; // 在飞期间又有新事件：完成后立即重评（追逐最新状态）
    return;
  }
  rt.winRateDirty = false; // 本次评估自最新状态起步
  rt.winRateInFlight = true;
  void runWinRateAnalysis(gameId, rt)
    .catch((): WinRateAnalysisResult => "skip") // 静默：AI/DB 失败绝不阻塞对局循环
    .then((result) => {
      rt.winRateInFlight = false;
      // 终局保底：在飞期间对局收官，补一次终局状态分析
      if (rt.winRateFinalPending) {
        rt.winRateFinalPending = false;
        maybeWinRateTick(gameId, rt);
      } else if (rt.winRateDirty || result === "stale") {
        // 在飞期间又有新事件（stale 为旧路径兼容，现已不判丢弃）：立即用最新状态重评
        maybeWinRateTick(gameId, rt);
      }
    });
}

// ---------- 犯规裁判已迁入法官模块（judge/foulReferee.ts） ----------
// 版图拆分第一批（2026-10-10）：法官=流程秩序唯一写者；书记员（runtime/）隐而不现；
// 判罚落定经 JudgeRecorder 窄接口回调本文件的 persist/markDecided/finishIfDone/scheduleTick。

/** 配置了分析师且选择「自动生成」的对局，分出胜负后自动复盘并蒸馏进指南
 *（「手动生成」的对局在观察室由用户点击生成；失败只落系统事件，绝不上抛阻塞对局） */
function triggerAutoAnalysis(gameId: string, rt: GameRuntime, snap: { day: number; phase: string }): void {
  if (!rt.analystAi || rt.analystAi.autoGenerate === false) return;
  const cfg = rt.analystAi;
  void runAnalysisJob(gameId, cfg).catch(async (err) => {
    try {
      await appendEvents([
        {
          gameId,
          seq: ++rt.seq,
          day: snap.day,
          phase: snap.phase,
          type: "system",
          actor: null,
          actorLabel: null,
          title: "分析任务失败",
          content: `分析师复盘失败：${errMessage(err).slice(0, 300)}`,
          thought: null,
          meta: null,
        },
      ]);
    } catch {
      /* 记日志失败也不再上抛 */
    }
  });
}

/** 分出胜负即落库 + 触发自动分析（赛后讨论期间 status 仍 running，但报告已可生成） */
async function markDecidedIfNeeded(gameId: string, rt: GameRuntime): Promise<void> {
  if (rt.decidedPersisted) return;
  const snap = rt.engine.getSnapshot();
  if (!snap.winner) return;
  rt.decidedPersisted = true;
  await withTimeout(
    updateGame(gameId, { winner: snap.winner, dayCount: snap.day }),
    DB_TIMEOUT_MS,
    "DB操作超时: 胜负落库",
  );
  triggerAutoAnalysis(gameId, rt, snap);
}

async function finishIfDone(gameId: string, rt: GameRuntime): Promise<boolean> {
  // 分出胜负即落库（赛后讨论场景：引擎未 finished 但 winner 已定，先行持久化 + 触发自动分析）；
  // 真正的自动分析触发统一走 markDecidedIfNeeded（decidedPersisted 旗标保证只启动一次）
  await markDecidedIfNeeded(gameId, rt);
  if (!rt.engine.isFinished()) return false;
  const snap = rt.engine.getSnapshot();
  rt.status = "finished";
  rt.pending = null;
  if (rt.timer) {
    clearTimeout(rt.timer);
    rt.timer = null;
  }
  // 超时保护：挂起时抛错 → runTick 捕获走 handleTickError
  await withTimeout(
    updateGame(gameId, {
      status: "finished",
      winner: snap.winner,
      dayCount: snap.day,
    }),
    DB_TIMEOUT_MS,
    "DB操作超时: 终局落库",
  );
  // 自动分析触发：统一由开头 markDecidedIfNeeded 完成（分出胜负即启动，此处不重复启动）
  // 终局保底：最后再评估一次胜率（在飞则记 winRateFinalPending，在飞完成的 finally 里补）
  maybeWinRateTick(gameId, rt);
  // 心理检查（记事簿回写+心理检查报告）为主动开启环节：分出胜负后顶栏出现「开始心理检查」按钮，
  // 由 startPsyCheck 启动（可续跑）——不再终局自动触发（被动中断难以补齐，见对局 20261009001）
  return true;
}

// ---------- 心理检查（手动开启的终局收尾，可续跑） ----------
// 语义变迁（对局 20261009001 实锤）：曾是终局自动触发——被动模式一旦中断（未配分析师/
// 进程重启丢内存配置/平台回收）就难以补齐，该局心理检查从未发生。
// 现改为用户主动开启：分出胜负后顶栏出现「开始心理检查」，点击启动；中断后再点只补未完成座位
//（已有报告的座位不重跑；已有回写事件的座位不重写——人格演进不重复入账）。

/** 心理检查在飞座位与完成座位的运行时状态键（rt.psyCheckRunning / rt.psyCheckDone） */

/** 单个人格的检查链（局部保序：记事簿回写 → 心理检查报告 → 参战计数）；
 * 续跑跳过：已有回写事件的座位不重写（防记忆重复入账），报告由调用方按 todo 控制 */
async function runPsyCheckForSeat(
  gameId: string,
  rt: GameRuntime,
  ctx: {
    cfg: SeatAiConfig;
    snapshot: GameSnapshot;
    digest: string;
    winnerText: string;
    titleNo: string;
    others: { seat: number; name: string; personaId: number; known: boolean }[];
    writebackDoneSeats: Set<number>;
  },
  seat: number,
  card: PersonaCard,
): Promise<void> {
  const { cfg, snapshot, digest, winnerText, titleNo, others, writebackDoneSeats } = ctx;
  const player = snapshot.players.find((p) => p.seat === seat);
  const roleName = player?.roleName ?? "未知身份";
  const outcome = `${winnerText}${player && !player.alive ? `；出局（${player.deathInfo ?? "死亡"}）` : "；存活"}`;
  // ---- 记事簿回写：记忆入库/强化/衰减、关系传递、人格漂移（续跑跳过已完成座位） ----
  if (writebackDoneSeats.has(seat)) {
    // 已回写过：漂移已生效、记忆已入账——不重复执行
  } else {
    try {
      const wb = await runNotebookWriteback({
        cfg,
        card,
        seat,
        roleName,
        outcome,
        gameTitleNo: titleNo,
        digest,
        gameId,
        otherPersonas: others.filter((o) => o.seat !== seat),
      });
      if (wb) {
        await appendEvents([
          {
            gameId,
            seq: ++rt.seq,
            day: snapshot.day,
            phase: snapshot.phase,
            type: "system",
            actor: null,
            actorLabel: null,
            title: "记事簿回写",
            content: `「${card.name}」（${seat}号）记忆回写完成：新增记忆 ${wb.memoriesAdded} 条、强化 ${wb.memoriesReinforced} 条、关系更新 ${wb.relationshipsTouched} 项、人格漂移 ${wb.driftApplied.length} 处${wb.driftApplied.length ? `（${wb.driftApplied.map((d) => d.path).join("、")}）` : ""}。`,
            thought: null,
            meta: { personaNotebook: wb.text },
          },
        ]);
      }
    } catch (err) {
      await appendEvents([
        {
          gameId,
          seq: ++rt.seq,
          day: snapshot.day,
          phase: snapshot.phase,
          type: "system",
          actor: null,
          actorLabel: null,
          title: "记事簿回写失败",
          content: `「${card.name}」（${seat}号）记忆回写失败：${errMessage(err).slice(0, 200)}`,
          thought: null,
          meta: null,
        },
      ]);
    }
  }
  // ---- 心理检查师：《心理检查报告》 ----
  try {
    const report = await runPsyCheck(cfg, { card, seat, roleName, outcome, digest, gameTitleNo: titleNo });
    await upsertPersonaReport({ gameId, personaId: card.id, seat, report, model: cfg.model });
    await appendEvents([
      {
        gameId,
        seq: ++rt.seq,
        day: snapshot.day,
        phase: snapshot.phase,
        type: "system",
        actor: null,
        actorLabel: null,
        title: "心理检查报告已生成",
        content: `「${card.name}」（${seat}号）的《心理检查报告》已生成：三个转折点 + 参数撕裂还原 + 人格状态与走向，可在本页「心理检查」按钮与人格详情页查看。`,
        thought: null,
        meta: null,
      },
    ]);
    rt.psyCheckDone?.add(seat);
  } catch (err) {
    await appendEvents([
      {
        gameId,
        seq: ++rt.seq,
        day: snapshot.day,
        phase: snapshot.phase,
        type: "system",
        actor: null,
        actorLabel: null,
        title: "心理检查报告生成失败",
        content: `「${card.name}」（${seat}号）心理检查报告生成失败：${errMessage(err).slice(0, 200)}`,
        thought: null,
        meta: null,
      },
    ]);
  }
  // ---- 参战计数：已迁移至 createGame「落座即计」（对局创建成功即入数）——
  // 收尾链不再重复计数（重启续跑/补跑检查都不再触碰计数） ----
}

/** 心理检查后台任务：todo 座位并行（并发 3），完成进度写 rt.psyCheckRunning/done（poll 透出） */
async function runPsyCheckJob(
  gameId: string,
  rt: GameRuntime,
  cfg: SeatAiConfig,
  todoSeats: number[],
): Promise<void> {
  const row = await getGame(gameId);
  if (!row) return;
  const events = await getAllEvents(gameId);
  const snapshot = snapshotFromRuntime(gameId, row, rt);
  const digest = buildLogDigest(snapshot, events);
  const winnerText = snapshot.winner === "wolf" ? "狼人阵营胜利" : snapshot.winner === "good" ? "神民阵营胜利" : "未分胜负";
  // 人格可知性名册（迷雾规则：full 全可见；partial 中 personaFogSeats 被上迷雾；none 全迷雾）——
  // 记事簿回写的锚点双轨依据：可知的归人格名，迷雾/无人格的归「标题号·代号」
  const visibility = rt.options.personaVisibility ?? "full";
  const fogSeats = new Set(rt.options.personaFogSeats ?? []);
  const others = (rt.seatPersonas ?? []).map((b) => ({
    seat: b.seat,
    name: rt.personaCards?.get(b.seat)?.name ?? b.name,
    personaId: b.personaId,
    known: visibility === "full" || (visibility === "partial" && !fogSeats.has(b.seat)),
  }));
  // 回写完成判定：事件流里该座位的「记事簿回写」成功事件（内容以「名字」（N号）开头）
  const writebackDoneSeats = new Set(
    events
      .filter((e) => e.title === "记事簿回写")
      .map((e) => /^「.+」（(\d+)号）/.exec(e.content)?.[1])
      .filter((s): s is string => !!s)
      .map(Number),
  );
  const ctx = {
    cfg,
    snapshot,
    digest,
    winnerText,
    titleNo: row.titleNo ?? "",
    others,
    writebackDoneSeats,
  };
  const CONCURRENCY = 3; // 各人格链相互独立；过高并发只会撞限流转重试，不降质量
  let cursor = 0;
  const worker = async () => {
    while (cursor < todoSeats.length) {
      const seat = todoSeats[cursor++]!;
      const card = rt.personaCards?.get(seat);
      if (!card) {
        rt.psyCheckRunning?.delete(seat);
        continue;
      }
      await runPsyCheckForSeat(gameId, rt, ctx, seat, card);
      rt.psyCheckRunning?.delete(seat);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, todoSeats.length) }, () => worker()),
  );
}

/** 心理检查任务的进度透出载荷：有人格座位且已分出胜负的对局，逐座位 pending/running/done */
async function psyCheckPayload(
  gameId: string,
  row: GameRow,
  rt: GameRuntime | null,
): Promise<PollResult["psyCheck"]> {
  const binds = rt?.seatPersonas ?? ((row.setup as StoredSetup)?.seatPersonas ?? []);
  if (binds.length === 0 || row.winner == null) return null;
  const reports = await getPersonaReportsForGame(gameId).catch(() => []);
  const doneIds = new Set(reports.map((r) => r.personaId));
  return {
    seats: binds.map((b) => ({
      seat: b.seat,
      status: rt?.psyCheckRunning?.has(b.seat)
        ? ("running" as const)
        : doneIds.has(b.personaId)
          ? ("done" as const)
          : ("pending" as const),
    })),
  };
}

/** 开始心理检查（用户主动开启，可续跑）：分出胜负即可（无赛后讨论/赛后待开始同样开放）。
 *  AI 配置：前端分析师配置 → 对局分析师配置 → 1 号座位配置（逐级兜底，与胜率分析同规）。
 *  幂等：进行中的调用直接复视；已完成座位跳过；写库失败记事件不阻塞其余座位。 */
async function startPsyCheck(
  gameId: string,
  analystCfg: AnalystAiConfig | null | undefined,
  userId?: string,
): Promise<{ started: boolean; reason?: string }> {
  const row = await requireOwnedGame(gameId, userId);
  if (row.winner == null) return { started: false, reason: "对局尚未分出胜负——心理检查在分出胜负后开放" };
  const setup = row.setup as StoredSetup;
  const binds = setup.seatPersonas ?? [];
  if (binds.length === 0) return { started: false, reason: "本局没有人格座位" };
  // 运行时缺失则重放重建（读人格卡/快照；paused/finished 对局不补链不续跑）
  let rt = registry.get(gameId) ?? null;
  if (!rt) {
    rt = await recoverGame(gameId).catch(() => null);
    if (!rt) return { started: false, reason: "对局恢复原料缺失，无法开始心理检查" };
  }
  if (!rt.personaCards || rt.personaCards.size === 0) {
    return { started: false, reason: "人格卡已不可用（可能被删除），无法检查" };
  }
  if ((rt.psyCheckRunning?.size ?? 0) > 0) return { started: true }; // 幂等复视：已在进行中
  const cfgSource = analystCfg ?? rt.analystAi ?? (rt.seatAIs[0] ?? null);
  if (!cfgSource) return { started: false, reason: "没有可用的 AI 配置" };
  const cfg: SeatAiConfig = { ...cfgSource, seat: 0 };
  // 续跑核心：只补「还没有心理检查报告」的座位
  const reports = await getPersonaReportsForGame(gameId).catch(() => []);
  const doneIds = new Set(reports.map((r) => r.personaId));
  const todoSeats = binds.filter((b) => !doneIds.has(b.personaId)).map((b) => b.seat);
  if (todoSeats.length === 0) return { started: false, reason: "全部人格的心理检查已完成" };
  rt.psyCheckRunning = new Set(todoSeats);
  void runPsyCheckJob(gameId, rt, cfg, todoSeats)
    .catch(async (err) => {
      try {
        const snap = rt.engine.getSnapshot();
        await appendEvents([
          {
            gameId,
            seq: ++rt.seq,
            day: snap.day,
            phase: snap.phase,
            type: "system",
            actor: null,
            actorLabel: null,
            title: "心理检查失败",
            content: `心理检查任务异常中断：${errMessage(err).slice(0, 300)}——重新点击「开始心理检查」可从断点续跑。`,
            thought: null,
            meta: null,
          },
        ]);
      } catch {
        /* 记日志失败也不再上抛 */
      }
    })
    .finally(() => {
      rt.psyCheckRunning?.clear();
    });
  return { started: true };
}


async function handleTickError(gameId: string, rt: GameRuntime, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  rt.status = "paused";
  rt.pending = null;
  if (rt.timer) {
    clearTimeout(rt.timer);
    rt.timer = null;
  }
  // 事件流记录错误，绝不允许静默卡死；落库失败不阻塞状态收敛
  let day = 1;
  let phase = "system";
  try {
    const snap = rt.engine.getSnapshot();
    day = snap.day;
    phase = snap.phase;
  } catch {
    /* 引擎快照也不可用了，用默认值 */
  }
  try {
    // 超时保护：此处挂起会导致 tick 锁永久不释放，必须限时（失败仅丢错误事件，状态已收敛）
    await withTimeout(
      appendEvents([
        {
          gameId,
          seq: ++rt.seq,
          day,
          phase,
          type: "system",
          actor: null,
          actorLabel: null,
          title: "系统错误",
          content: `对局循环异常，已自动暂停：${message.slice(0, 500)}`,
          thought: null,
          meta: null,
        },
      ]),
      DB_TIMEOUT_MS,
      "DB操作超时: 错误事件落库",
    );
  } catch {
    /* 忽略 */
  }
  try {
    await withTimeout(
      updateGame(gameId, { status: "paused" }),
      DB_TIMEOUT_MS,
      "DB操作超时: 暂停状态落库",
    );
  } catch {
    /* 忽略 */
  }
}

async function runTick(gameId: string): Promise<void> {
  const rt = registry.get(gameId);
  if (!rt || rt.status !== "running" || rt.ticking) return;
  rt.ticking = true;
  rt.lastTickAt = Date.now(); // tick 开始：刷新心跳（断链检测依据）
  try {
    // 恢复路径：rt.pending 非空说明此前暂停挂起了决策——跳过 advance（引擎协程正停在该待决点），
    // 直接由 AI 重新思考该 pending；正常路径才推进引擎取新待决
    let pending = rt.pending;
    let events: EngineEvent[] = [];
    if (!pending) {
      const adv = rt.engine.advance();
      events = adv.events;
      pending = adv.pending;

      await persistWithPhaseBreak(gameId, rt, events);
      rt.acts = rt.engine.getSnapshot().pendingActs; // 状态圈随内容落盘同步刷新
      await markDecidedIfNeeded(gameId, rt); // 分出胜负即落库（赛后讨论期间引擎仍 running）
      if (await finishIfDone(gameId, rt)) return;
      if (events.length > 0) maybeWinRateTick(gameId, rt); // 事件落盘后触发胜率评估（非阻塞）
      if (events.length > 0) maybeFoulCheck(gameId, rt, events); // 公开发言落盘后触发犯规审查（非阻塞）
    }

    if (pending) {
      // 赛后讨论挂起：对局已分出胜负、引擎产出首个 postgameSpeak 待决时自动暂停——
      // 等用户点「开启赛后讨论」后开始生成；开启「赛后自动开始讨论」（postGameAutoStart）
      // 的对局不挂起，径直进入赛后讨论生成
      if (pending.kind === "postgameSpeak" && !rt.postgameAutoHeld && !rt.options.postGameAutoStart) {
        rt.postgameAutoHeld = true;
        rt.pending = pending;
        rt.status = "paused";
        if (rt.timer) {
          clearTimeout(rt.timer);
          rt.timer = null;
        }
        // 事件流记录挂起原因（seq/落库模式照 handleTickError 的事件落库写法）；
        // 落库失败不阻塞状态收敛（内存已 paused，用户仍可手动继续）
        let holdDay = 1;
        let holdPhase = "postgame.discuss";
        try {
          const snap = rt.engine.getSnapshot();
          holdDay = snap.day;
          holdPhase = snap.phase;
        } catch {
          /* 引擎快照不可用时用默认值 */
        }
        try {
          await withTimeout(
            appendEvents([
              {
                gameId,
                seq: ++rt.seq,
                day: holdDay,
                phase: holdPhase,
                type: "system",
                actor: null,
                actorLabel: null,
                title: "赛后讨论待开始",
                content:
                  "赛后讨论待开始：对局已分出胜负。点击页面顶部「开启赛后讨论」按钮，即可开始生成赛后讨论。",
                thought: null,
                meta: null,
              },
            ]),
            DB_TIMEOUT_MS,
            "DB操作超时: 赛后讨论挂起事件落库",
          );
        } catch {
          /* 忽略：状态已收敛，仅丢提示事件 */
        }
        try {
          await withTimeout(
            updateGame(gameId, { status: "paused" }),
            DB_TIMEOUT_MS,
            "DB操作超时: 暂停状态落库",
          );
        } catch {
          /* 忽略：内存已 paused */
        }
        return;
      }
      rt.pending = pending;
      try {
        // decideWithAi 内部消化「AI 输出非法」（重试+启发式兜底，绝不暂停对局）；
        // 仅引擎内部异常（连合法兜底都被拒）才向上抛出 → 外层 catch 置 paused
        const { events: decideEvents, input } = await decideWithAi(rt, pending, gameId);
        rt.pending = null;
        // 先落决策日志（断点重放的原料），再落事件：最坏情况只丢该决策的事件流水，状态不分叉
        // 外部结算（审核驳回等房规裁决）记 auditSettle 类：重放时调 settleExternal 精确重建，
        // 不进 advance/decide 一致性校验（其时刻引擎待决被封存而非消费）
        await withTimeout(
          appendDecision({
            gameId,
            idx: rt.decisionIdx,
            kind: input.auditSettle ? "auditSettle" : pending.kind,
            seat: pending.seat,
            decision: input,
          }),
          DB_TIMEOUT_MS,
          "决策日志写入超时",
        );
        rt.decisionIdx += 1;
        recordSeatNotes(rt, pending, input); // 对局笔记：各座位「所知所思所为」实时留存
        enrichPersonaEvents(rt, decideEvents); // 人格注解合并进该座位事件 meta（双视角/撕裂组）
        // AI 产出的思考/发言事件同样持久化（同批可能含跨时段交界事件，如结算+天亮）
        await persistWithPhaseBreak(gameId, rt, decideEvents);
        rt.acts = rt.engine.getSnapshot().pendingActs; // 状态圈随内容落盘同步刷新
        await markDecidedIfNeeded(gameId, rt); // 分出胜负即落库（赛后讨论期间引擎仍 running）
        if (await finishIfDone(gameId, rt)) return;
        if (decideEvents.length > 0) maybeWinRateTick(gameId, rt); // 事件落盘后触发胜率评估（非阻塞）
        if (decideEvents.length > 0) maybeFoulCheck(gameId, rt, decideEvents); // 公开发言落盘后触发犯规审查（非阻塞）
      } catch (err) {
        if (err instanceof SuspendDecision) {
          // 暂停挂起：rt.pending 保留（决策未结算），tick 链到此停稳；待 control("start") 恢复
          return;
        }
        throw err;
      }
    }

    if (rt.status === "running") {
      // 无进展看门狗：连续「无事件且无待决且未结束」（未结束则上面不会 return）的 tick 计数，
      // 超过上限判定为引擎停滞 → 按引擎内部异常抛错走 handleTickError；有任何进展立即清零
      if (events.length === 0 && !pending) {
        rt.noProgressTicks += 1;
        if (rt.noProgressTicks > MAX_NO_PROGRESS_TICKS) {
          throw new Error(
            `引擎无进展停滞：连续 ${rt.noProgressTicks} 个 tick 无事件/无待决/未结束，判定为引擎内部异常`,
          );
        }
      } else {
        rt.noProgressTicks = 0;
      }
      scheduleTick(gameId, rt, rt.options.stepDelayMs);
    }
  } catch (err) {
    await handleTickError(gameId, rt, err);
  } finally {
    rt.lastTickAt = Date.now(); // tick 结束（含异常路径）：刷新心跳
    rt.ticking = false;
  }
}

// ---------- 快照组装 ----------
function snapshotFromRuntime(gameId: string, row: GameRow, rt: GameRuntime): GameSnapshot {
  const snap = rt.engine.getSnapshot();
  // 显示阶段只反映已落盘内容：引擎阶段值在 decide() 中先行推进但新阶段内容未落盘时，
  // 界面阶段/色调/时段标签一律不跟进（杜绝日夜交界主题反复抖动）
  const shown = rt.displayPhase ?? { day: snap.day, phase: snap.phase, phaseLabel: snap.phaseLabel };
  // 人格名冗余快照（setup 里的绑定快照兜底内存运行时）
  const personaNameOf = (seat: number): string | null =>
    rt.personaCards?.get(seat)?.name ??
    ((row.setup as StoredSetup)?.seatPersonas ?? []).find((s) => s.seat === seat)?.name ??
    null;
  // 显式标注 GameSnapshot：避免对象字面量属性拓宽（如 phaseBreaking 拓宽成 string）
  const result: GameSnapshot = {
    gameId,
    boardId: row.boardId,
    boardName: row.boardName,
    titleNo: row.titleNo ?? "",
    status: rt.status,
    day: shown.day,
    phase: shown.phase,
    phaseLabel: shown.phaseLabel,
    // 观察者上帝视角：角色全亮 + 该座位的模型名
    players: snap.players.map((p) => ({
      seat: p.seat,
      role: p.role,
      roleName: ROLE_META[p.role]?.name ?? p.role,
      camp: p.camp,
      alive: p.alive,
      sheriff: p.sheriff,
      sheriffCandidate: p.sheriffCand, // 上警竞选中 → 前端灰色警徽
      deathInfo: p.deathInfo,
      aiModel: rt.seatAIs.find((a) => a.seat === p.seat)?.model ?? "",
      personaName: personaNameOf(p.seat),
    })),
    winner: snap.winner,
    seq: rt.seq,
    // 状态圈跟随内容显示：pendingActs 以「上一个交互内容已落盘」后的值为准——
    // 角色的状态圈在其交互内容显示出来的瞬间才切换/消失（停歇期间继续冻结）
    pendingSeat: rt.pendingHold ? null : (rt.acts?.[0]?.seat ?? snap.pendingSeat ?? null),
    pendingKind: rt.pendingHold ? null : (rt.acts?.[0]?.kind ?? snap.pendingKind ?? null),
    pendingSeats: rt.pendingHold
      ? []
      : (rt.acts ?? snap.pendingSeats ?? []).map((a) => (typeof a === "number" ? a : a.seat)),
    pendingActs: rt.pendingHold ? [] : (rt.acts ?? snap.pendingActs ?? []),
    phaseBreaking: rt.pendingHold ? (rt.breakKind ?? "thinkBeat") : "none",
    phaseBreakTotalMs: rt.pendingHold ? (rt.options.phaseBreakMs ?? 5000) : 0,
    phaseBreakStartedAt: rt.breakStartedAt ?? 0,
    speechRoundsLimit: rt.options.speechRoundsLimit,
    studyingSeats: rt.studying ? [...(rt.studyInFlight ?? new Set<number>())] : [],
    createdAt: toIso(row.createdAt),
  };
  return result;
}

function snapshotFromRow(gameId: string, row: GameRow, seq: number): GameSnapshot {
  const setup = row.setup as StoredSetup;
  const finished = row.status === "finished";
  return {
    gameId,
    boardId: row.boardId,
    boardName: row.boardName,
    titleNo: row.titleNo ?? "",
    status: row.status as GameStatus,
    day: row.dayCount,
    phase: finished ? "finished" : "interrupted",
    phaseLabel: finished ? "对局已结束" : "对局已中断（服务重启后仅可查看事件流）",
    // 内存丢失后无法还原存活/警长状态，角色仍全亮（上帝视角），存活信息以事件流为准
    players: (setup.seatRoles ?? []).map((role, i) => ({
      seat: i + 1,
      role,
      roleName: ROLE_META[role]?.name ?? String(role),
      camp: ROLE_META[role]?.camp ?? "villager",
      alive: true,
      sheriff: false,
      deathInfo: null,
      aiModel: setup.seatModels?.[i] ?? "",
      personaName: (setup.seatPersonas ?? []).find((s) => s.seat === i + 1)?.name ?? null,
    })),
    winner: (row.winner as "wolf" | "good" | null) ?? null,
    seq,
    pendingSeat: null,
    pendingKind: null,
    pendingSeats: [],
    pendingActs: [],
    phaseBreaking: "none",
    phaseBreakTotalMs: 0,
    phaseBreakStartedAt: 0,
    speechRoundsLimit: setup.options?.speechRoundsLimit ?? 2,
    createdAt: toIso(row.createdAt),
  };
}

// ---------- 服务实现 ----------
async function createGame(input: CreateGameInput, userId?: string): Promise<{ gameId: string }> {
  const board = BOARDS.find((b) => b.id === input.boardId);
  if (!board) throw new Error(`未知版型: ${input.boardId}`);

  const seats = [...input.seats].sort((a, b) => a.seat - b.seat);
  if (seats.length !== board.playerCount) {
    throw new Error(`版型「${board.name}」需要 ${board.playerCount} 个座位，收到 ${seats.length} 个`);
  }
  seats.forEach((s, i) => {
    if (s.seat !== i + 1) {
      throw new Error(`座位号必须完整覆盖 1~${board.playerCount}（发现重复或缺失）`);
    }
    if (!s.baseUrl.trim() || !s.model.trim() || !s.apiKey.trim()) {
      throw new Error(`座位 ${s.seat} 的 AI 配置不完整（baseUrl/model/apiKey 必填）`);
    }
  });

  // 随机洗牌分配角色；先建引擎（失败则不落库，保持一致性）
  const seatRoles = shuffle([...board.roles]);
  const engine = createEngine({ boardId: board.id, seatRoles, options: input.options });

  // 人格研究库：座位人格绑定校验与加载（卡必须属于当前用户；绑定座位走心镜→涌现管线）
  let personaInfos: PersonaSeatInfo[] | undefined;
  let personaCards: Map<number, PersonaCard> | undefined;
  let personaMemory: Map<number, string> | undefined;
  if (input.seatPersonas && input.seatPersonas.length > 0) {
    const seen = new Set<number>();
    for (const b of input.seatPersonas) {
      if (b.seat < 1 || b.seat > board.playerCount) {
        throw new Error(`人格绑定座位 ${b.seat} 超出本版型范围（1~${board.playerCount}）`);
      }
      if (seen.has(b.seat)) throw new Error(`座位 ${b.seat} 重复绑定人格`);
      seen.add(b.seat);
    }
    personaInfos = [];
    personaCards = new Map();
    personaMemory = new Map();
    for (const b of input.seatPersonas) {
      const card = await getPersona(b.personaId, userId ?? "");
      if (!card) {
        throw new Error(`座位 ${b.seat} 绑定的人格卡不存在或不属于当前用户（id=${b.personaId}）`);
      }
      personaCards.set(b.seat, card);
      personaInfos.push({ seat: b.seat, personaId: b.personaId, name: card.name });
      // 记事簿：跨对局记忆与关系图谱注入（铁律3：人格记得自己的对局）
      personaMemory.set(b.seat, await loadMemoryContext(card.id));
    }
  }

  const gameId = crypto.randomUUID();
  // 对局标题号：本地日期 YYYYMMDD + 该用户当日第 N 局（3 位序号）——人格讨论/引用对局的统一编号
  const now = new Date();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dayEnd = new Date(dayStart.getTime() + 24 * 3600 * 1000);
  const titleNo = formatGameTitleNo(now, (await countGamesOnDate(userId ?? null, dayStart, dayEnd)) + 1);
  // setup 存 seatAIsEnc（AES-GCM 密文）：服务重启/崩溃后据此解密重放恢复对局；
  // 明文 key 绝不落库（账户体系安全要求）
  await insertGame({
    id: gameId,
    boardId: board.id,
    boardName: board.name,
    titleNo,
    status: "created",
    playerCount: board.playerCount,
    userId,
    setup: {
      seatRoles,
      seatModels: seats.map((s) => s.model),
      options: input.options,
      seatAIsEnc: encryptSecret(JSON.stringify(seats)),
      // 胜率推测开关随 setup 落库：服务重启/恢复后功能仍在
      winRateEnabled: input.winRateEnabled === true,
      // 人格绑定快照（含人格名冗余）：断点恢复与快照展示的依据
      ...(personaInfos ? { seatPersonas: personaInfos } : {}),
    } satisfies StoredSetup,
  });

  // 人格参战计数「落座即计」（契约语义：对局落座即计）——对局创建成功即入数，
  // 不再挂在收尾链上（历史 bug：计数在心理检查链末端，对局中断/未跑检查即漏计——
  // 对局 20260930002 被手动终止后五人格各漏计一局，用户实锤「参赛次数少了」）
  if (personaInfos) {
    for (const info of personaInfos) {
      await incrementPersonaGameCount(info.personaId).catch(() => {
        /* 计数失败无害，不阻塞建局 */
      });
    }
  }

  registry.set(gameId, {
    engine,
    seatAIs: seats,
    boardId: board.id,
    userId: userId ?? null,
    status: "created",
    seq: 0,
    timer: null,
    pending: null,
    options: input.options,
    ticking: false,
    lastTickAt: Date.now(),
    noProgressTicks: 0,
    pauseWaiters: [],
    suspendDraft: null,
    decisionIdx: 0,
    analystAi: input.analystAi ?? null, // 仅存内存注册表，不落库
    lastDayPart: "",
    lastEventPhase: null,
    displayPhase: null,
    pendingHold: false,
    breakKind: null,
    acts: null,
    breakStartedAt: null,
    winRateEnabled: input.winRateEnabled === true,
    winRateInFlight: false,
    winRateFinalPending: false,
    winRateDirty: false,
    winRateLastEvalAt: 0,
    winRateLastSeq: -1,
    winRateLoopTimer: null,
    winRateLastStoredSeq: 0,
    decidedPersisted: false, // 新对局尚未分出胜负
    postgameAutoHeld: false, // 新对局尚未进入赛后讨论
    studyNotes: new Map(),
    studyDoneSeats: new Set(),
    studying: false,
    studyDone: false,
    // 人格研究库：绑定人格的座位（心镜→涌现管线 + 记事簿注入 + 涌现注解暂存）
    personaCards,
    personaMemory,
    personaEventMeta: personaCards ? new Map() : undefined,
    seatPersonas: personaInfos,
  });
  return { gameId };
}

async function control(gameId: string, action: "start" | "pause" | "terminate" | "stopPostGame", userId?: string): Promise<{ ok: boolean }> {
  await requireOwnedGame(gameId, userId); // 账户隔离：仅本人可操控对局
  let rt = registry.get(gameId);

  // 终止赛后讨论：仅赛后讨论生成中可用——停掉赛后循环、落「赛后讨论已手动终止」标记、
  // 对局收敛 finished（胜负早已落库，不受影响）；与「继续/暂停」职责完全分离
  if (action === "stopPostGame") {
    if (!rt || rt.status !== "running") return { ok: false };
    let inPostGame = false;
    try {
      inPostGame = rt.engine.getSnapshot().phase.startsWith("postgame");
    } catch {
      /* 引擎快照不可用按非赛后处理 */
    }
    if (!inPostGame) return { ok: false };
    if (rt.timer) {
      clearTimeout(rt.timer);
      rt.timer = null;
    }
    rt.status = "finished"; // 先收敛：被唤醒的在飞决策据此挂起停链，不再产出新的赛后发言
    const waiters = rt.pauseWaiters.splice(0);
    for (const wake of waiters) wake();
    rt.pending = null;
    rt.suspendDraft = null;
    try {
      const snap = rt.engine.getSnapshot();
      await withTimeout(
        appendEvents([
          {
            gameId,
            seq: ++rt.seq,
            day: snap.day,
            phase: snap.phase,
            type: "system",
            actor: null,
            actorLabel: null,
            title: "赛后讨论终止",
            content: "赛后讨论已被手动终止。",
            thought: null,
            meta: null,
          },
        ]),
        DB_TIMEOUT_MS,
        "赛后终止事件落库超时",
      );
    } catch {
      /* 状态已收敛，仅丢标记事件 */
    }
    try {
      const snap = rt.engine.getSnapshot();
      await withTimeout(
        updateGame(gameId, { status: "finished", dayCount: snap.day }),
        DB_TIMEOUT_MS,
        "赛后终止状态落库超时",
      );
    } catch {
      /* 内存已 finished，DB 抖动不阻塞 */
    }
    return { ok: true };
  }

  // 终止：随时结束对局（不可逆，用于随时收掉测试局开新局）。
  // 内存即时收敛（停 tick 链、唤醒在飞决策走挂起停链——status 已 finished 不会再重想）、
  // 事件流留「对局终止」标记，DB 置 finished（winner 保持 null=未分胜负，dayCount 记终止时天数）。
  // 不触发分析师自动复盘（非完整对局，避免浪费 API）；需要分析可在前端手动生成。
  // 已 finished 幂等返回 ok；rt 不在内存（服务重启后）只落库，终止后仍可经断点重放复盘到终止瞬间。
  if (action === "terminate") {
    if (rt && rt.status !== "finished") {
      if (rt.timer) {
        clearTimeout(rt.timer);
        rt.timer = null;
      }
      rt.status = "finished"; // 先收敛状态：被唤醒的在飞决策据此挂起停链，绝不再结算
      const waiters = rt.pauseWaiters.splice(0);
      for (const wake of waiters) wake();
      rt.pending = null;
      rt.suspendDraft = null;
      try {
        const snap = rt.engine.getSnapshot();
        await withTimeout(
          appendEvents([
            {
              gameId,
              seq: ++rt.seq,
              day: snap.day,
              phase: snap.phase,
              type: "system",
              actor: null,
              actorLabel: null,
              title: "对局终止",
              content: "对局已被手动终止，未分胜负。",
              thought: null,
              meta: null,
            },
          ]),
          DB_TIMEOUT_MS,
          "终止事件落库超时",
        );
      } catch {
        /* 状态已收敛，仅丢标记事件 */
      }
    }
    try {
      const row = await withTimeout(getGame(gameId), DB_TIMEOUT_MS, "读取对局超时");
      if (!row) return { ok: false };
      if (row.status !== "finished") {
        let dayCount = row.dayCount;
        try {
          if (rt) dayCount = rt.engine.getSnapshot().day;
        } catch {
          /* 引擎快照不可用则保留原值 */
        }
        await withTimeout(
          updateGame(gameId, { status: "finished", dayCount }),
          DB_TIMEOUT_MS,
          "终止状态落库超时",
        );
      }
    } catch {
      /* 内存已 finished，DB 抖动不阻塞 */
    }
    return { ok: true };
  }

  if (action === "start") {
    // 运行时缺失：先尝试断点重放恢复；原料缺失（旧对局）才无法启动
    if (!rt) rt = (await recoverGame(gameId)) ?? undefined;
    if (!rt) return { ok: false };
    if (rt.status !== "created" && rt.status !== "paused") return { ok: false };
    // 图书馆赛前学习：开启开关且未完成学习时，「开始对局」先触发学习——学习全程在对局页
    // 可见（祖母绿状态环+进度+点击座位看详情），全部学完自动开赛进入黑夜
    // （学习期间 status 保持 created 白天态，poll.study 透出进度）
    if (rt.status === "created" && rt.options.libraryEnabled && !rt.studyDone) {
      if (!rt.studying) {
        const rtRef = rt; // 闭包内保持类型收窄
        rtRef.studying = true;
        void runStudyPhase(gameId, rtRef)
          .catch(() => {
            /* 学习阶段整体异常不阻塞开赛（单座容错已在内部） */
          })
          .finally(() => {
            rtRef.studying = false;
            rtRef.studyDone = true;
            // 学习期间被终止/暂停（status 已离开 created）则不自动开赛
            if (rtRef.status === "created") void control(gameId, "start", userId); // 全部学完自动开赛（进入黑夜）
          });
      }
      return { ok: true };
    }
    rt.status = "running";
    // DB 抖动不阻塞启动（内存是活对局的权威状态；失败仅影响重启后可见性）
    try {
      await withTimeout(updateGame(gameId, { status: "running" }), DB_TIMEOUT_MS, "更新对局状态超时");
    } catch { /* 内存已 running，继续 */ }
    // 若上一个 tick 仍在飞（如 pause 后立刻 start），让它自己链式调度
    if (!rt.ticking) scheduleTick(gameId, rt, 0);
    maybeWinRateTick(gameId, rt); // 启动即评估一次初始胜率（非阻塞）
    startWinRateLoop(gameId, rt); // 胜率预演循环：利用交互空隙持续预演，事件落地秒出结果
    return { ok: true };
  }

  // pause：先收敛内存状态（即时生效），DB 只做尽力而为的持久化
  if (rt) {
    if (rt.status === "running" || rt.status === "created") {
      rt.status = "paused";
    }
    if (rt.timer) {
      clearTimeout(rt.timer);
      rt.timer = null;
    }
    // 唤醒在飞决策的暂停等待者：当前决策挂起（不结算、保留 pending 与未完成思考量），
    // tick 链马上停稳，不再出现「点了暂停，对局还在跑几十秒甚至几分钟」的假象
    const waiters = rt.pauseWaiters.splice(0);
    for (const wake of waiters) wake();
  }
  try {
    const row = await withTimeout(getGame(gameId), DB_TIMEOUT_MS, "读取对局超时");
    if (!row) return { ok: false };
    if (row.status !== "finished") {
      await withTimeout(updateGame(gameId, { status: "paused" }), DB_TIMEOUT_MS, "更新对局状态超时");
    }
  } catch {
    // DB 失败不影响暂停本身：内存已 paused，tick 链已停；返回成功避免前端误报「操作失败」
  }
  return { ok: true };
}

// 断点重放恢复：服务重启/崩溃后，用落盘的 setup（座位角色+AI配置+选项）与决策日志
// 确定性重放（引擎无任何随机源），把对局精确重建到断点——包括停在某个待决点的中间态。
// 恢复后 running 立即补链继续跑；paused/created 保持原状态待用户启动；finished 仅用于完整复盘。
// 旧对局 setup 无 seatAIs → 返回 null（保持「重启后仅可查看事件」的旧行为）。
async function recoverGame(gameId: string): Promise<GameRuntime | null> {
  const inflight = recoveringGames.get(gameId);
  if (inflight) return inflight;
  const task = doRecoverGame(gameId).finally(() => recoveringGames.delete(gameId));
  recoveringGames.set(gameId, task);
  return task;
}

async function doRecoverGame(gameId: string): Promise<GameRuntime | null> {
  const rt = await buildRuntimeFromStore(gameId);
  // running 的对局立即补链继续跑（恢复前的服务中断等价于一次长卡顿）
  if (rt && rt.status === "running") {
    scheduleTick(gameId, rt, 0);
    maybeWinRateTick(gameId, rt); // 恢复续跑后补一次胜率评估（开关随 setup 落库）
  }
  return rt;
}

// 从落盘原料重建运行时（doRecoverGame 的主体，纯搬运；唯一扩展：optionsOverride 覆盖
// setup.options——已结束对局补开赛后讨论时强制 postGameDiscuss:true 重放，让生成器
// 越过 endGame 继续进入 postGamePhase）。
// 旧对局 setup 无 seatAIs → 返回 null（保持「重启后仅可查看事件」的旧行为）。
async function buildRuntimeFromStore(
  gameId: string,
  opts?: { optionsOverride?: Partial<AdvancedOptions> },
): Promise<GameRuntime | null> {
  const row = await withTimeout(getGame(gameId), DB_TIMEOUT_MS, "读取对局超时");
  if (!row) return null;
  const setup = (row.setup ?? null) as StoredSetup | null;
  const seatAIs = setup ? seatAIsOfSetup(setup) : undefined;
  if (!seatAIs || !setup?.seatRoles?.length) return null; // 旧对局：无恢复原料
  const board = BOARDS.find((b) => b.id === row.boardId);
  if (!board) return null;

  const options: AdvancedOptions = { ...setup.options, ...opts?.optionsOverride };
  const engine = createEngine({ boardId: board.id, seatRoles: setup.seatRoles, options });
  const decisions = await withTimeout(getDecisions(gameId), DB_TIMEOUT_MS, "决策日志读取超时");
  const maxSeq = await withTimeout(getMaxEventSeq(gameId), DB_TIMEOUT_MS, "事件游标读取超时");
  // displayPhase 以库中最后一条阶段提醒为准（显示跟随已落盘内容，而非引擎活阶段值）
  const latestPhaseEvt = await withTimeout(
    getLatestPhaseEvent(gameId),
    DB_TIMEOUT_MS,
    "阶段提醒读取超时",
  );
  // 确定性重放：逐条重放已采纳决策；每个待决点应与记录一致（kind+seat 一致性校验）。
  // 关键：捕获最后一条决策 decide() 排出的事件批——运行时是「决策日志先于事件落盘」
  // （appendDecision → persistWithPhaseBreak），崩溃/重启若落在两者之间（含交界静歇的
  // 数秒睡眠窗口），该批事件会全部或部分（交界切分的前半已落、后半未落）丢失；
  // 重放只能恢复引擎状态，事件必须由恢复流程比对补齐（见下方断点事件补漏）。
  let lastDrained: EngineEvent[] = [];
  for (let i = 0; i < decisions.length; i++) {
    const rec = decisions[i];
    // 外部结算条目（auditSettle）：不喂 advance/decide（其时刻待决是被封存而非消费），
    // 直接调引擎 settleExternal 落定胜者——引擎快照 winner/phase 与赛后衔接全部精确重建
    //（kind 落库为自由字符串；auditSettle 不在 DecisionKind 枚举内——它是服务层结算标记）
    if ((rec.kind as string) === "auditSettle") {
      const d = rec.decision as { auditSettle?: unknown; auditNote?: unknown; auditPub?: unknown };
      if (d.auditSettle !== "wolf" && d.auditSettle !== "good") {
        throw new Error(`恢复重放分叉：auditSettle 条目胜者非法（${JSON.stringify(d.auditSettle)}，${gameId}）`);
      }
      lastDrained = engine.settleExternal(
        d.auditSettle,
        typeof d.auditNote === "string" ? d.auditNote : undefined,
        typeof d.auditPub === "string" ? d.auditPub : undefined,
      );
      continue;
    }
    const adv = engine.advance();
    if (!adv.pending) throw new Error(`恢复重放分叉：第 ${i} 步前引擎已无待决（${gameId}）`);
    if (adv.pending.kind !== rec.kind || adv.pending.seat !== rec.seat) {
      throw new Error(
        `恢复重放分叉：第 ${i} 步期望 ${rec.kind}@seat${rec.seat}，实际 ${adv.pending.kind}@seat${adv.pending.seat}（${gameId}）`,
      );
    }
    lastDrained = engine.decide(rec.decision);
  }

  // 已落盘事件尾部：① lastDayPart/lastEventPhase 必须以「已落盘内容」为基准——
  // 引擎活阶段值在 decide() 中先行推进，崩溃恢复时可能领先落盘内容一整个时段
  // （历史 bug：以引擎活阶段为基准，补漏批的日夜交界被误判为同时段，停歇静默跳过）；
  // ② 供最后一条决策事件批的落盘前缀比对（断点事件补漏）
  const persistedTail = await withTimeout(
    getLatestEvents(gameId, lastDrained.length + 10),
    DB_TIMEOUT_MS,
    "事件尾部读取超时",
  );
  // 赛前学习笔记（图书馆开启时）：恢复可读，未学全则开赛时补足
  const studyRows = options.libraryEnabled
    ? await withTimeout(getStudyNotes(gameId), DB_TIMEOUT_MS, "学习笔记读取超时").catch(() => [] as { seat: number; notes: string }[])
    : [];
  const studyMap = new Map<number, string>(studyRows.map((r) => [r.seat, r.notes]));
  const latestEvt = persistedTail[persistedTail.length - 1] ?? null;

  const rt: GameRuntime = {
    engine,
    boardId: board.id,
    userId: row.userId ?? null,
    options,
    seatAIs,
    status: row.status as GameStatus,
    pending: null,
    seq: maxSeq,
    decisionIdx: decisions.length,
    timer: null,
    ticking: false,
    lastTickAt: Date.now(),
    noProgressTicks: 0,
    pauseWaiters: [],
    suspendDraft: null,
    analystAi: null, // 分析师配置仅存内存，恢复后由前端再次发起分析时携带/回落座位配置
    // 时段基准以「已落盘内容」为准（而非引擎活阶段值——崩溃时后者可能领先一整个时段，
    // 导致补漏批的交界被静默跳过）；无任何落盘事件时按引擎阶段兜底（等价于空基准）
    lastDayPart: latestEvt
      ? (partOfPhase(latestEvt.phase) ?? "")
      : engine.getSnapshot().phase.startsWith("night.")
        ? "night"
        : engine.getSnapshot().phase.startsWith("day.")
          ? "day"
          : "",
    lastEventPhase: latestEvt?.phase ?? null,
    displayPhase: latestPhaseEvt
      ? {
          day: latestPhaseEvt.day,
          phase: latestPhaseEvt.phase,
          phaseLabel: latestPhaseEvt.title,
        }
      : null,
    pendingHold: false,
    breakKind: null,
    acts: null,
    breakStartedAt: null,
    winRateEnabled: setup.winRateEnabled === true, // 恢复依据：开关随 setup 落库
    winRateInFlight: false,
    winRateFinalPending: false,
    winRateDirty: false,
    winRateLastEvalAt: 0,
    winRateLastSeq: -1,
    winRateLoopTimer: null,
    winRateLastStoredSeq: 0,
    // 胜负落库状态随 row 重建：已落过 winner 的对局（含赛后讨论中断恢复）不再重复落库/触发分析
    decidedPersisted: row.winner != null,
    // 恢复重建为 false：只有 running 对局会被恢复，恢复时 rt.pending 非空走直接决策路径，
    // 挂起只会在「新 advance 出 postgameSpeak」时触发一次（正常对局只会出现一次赛后讨论）
    postgameAutoHeld: false,
    // 对局笔记随决策日志重建（与引擎状态同源，重放一致性天然成立）
    seatNotes: rebuildSeatNotesFromLog(decisions),
    studyNotes: studyMap,
    studyDoneSeats: new Set(studyMap.keys()),
    studying: false,
    studyDone: options.libraryEnabled ? studyMap.size >= seatAIs.length : true,
  };
  registry.set(gameId, rt);

  // 人格研究库：断点恢复时重载人格卡与记事簿（卡被删除的座位自动降级为普通 AI，不阻断对局恢复）
  if (setup?.seatPersonas?.length) {
    rt.seatPersonas = setup.seatPersonas;
    try {
      const cards = await getPersonaCardsInternal(setup.seatPersonas.map((s) => s.personaId));
      rt.personaCards = new Map();
      rt.personaMemory = new Map();
      rt.personaEventMeta = new Map();
      for (const info of setup.seatPersonas) {
        const card = cards.find((c) => c.id === info.personaId);
        if (!card) continue;
        rt.personaCards.set(info.seat, card);
        rt.personaMemory.set(info.seat, await loadMemoryContext(card.id));
      }
    } catch {
      /* 人格数据不可用时整局按普通 AI 继续 */
    }
  }

  // ---------- 断点事件补漏 ----------
  // 运行时顺序是「appendDecision（决策日志）→ persistWithPhaseBreak（事件）」：崩溃/重启
  // 若落在两者之间——尤其是交界静歇的数秒睡眠窗口（前半已落盘、后半未落盘）——最后一条
  // 决策的事件批会全部或部分丢失，且引擎重放只恢复状态不补事件（decide 排出即弃）。
  // 这里把重放捕获的最后一批事件与已落盘尾部做前缀比对，缺失后缀经 persistWithPhaseBreak
  // 补齐：事件流完整（天亮/夜临公告不再凭空消失），日夜交界停歇也随之恢复。
  // 倒数第二条及更早的决策必有后续决策落盘背书（其 tick 完整走完），不会缺失。
  if (lastDrained.length > 0) {
    const sameEvt = (dbEvt: { day: number; phase: string; type: string; actor: number | null; title: string; content: string; thought: string | null }, ev: EngineEvent): boolean =>
      dbEvt.day === ev.day &&
      dbEvt.phase === ev.phase &&
      dbEvt.type === ev.type &&
      dbEvt.actor === ev.actor &&
      dbEvt.title === ev.title &&
      dbEvt.content === ev.content &&
      dbEvt.thought === ev.thought;
    // 已落盘的最长前缀：在尾部任意位置找「lastDrained 前缀的最长连续匹配」——
    // 崩溃只可能丢失后缀（逐次原子落盘），但批后可能已追加系统类事件（对局终止/系统错误/
    // 分析失败），故匹配段不一定恰在尾部末端；取最长匹配（并列取更靠后位置），
    // 杜绝把已完整落盘的批次误判为未落盘而整批重落造成重复（线上事故：终止标记
    // 跟在批后，旧版只从尾部末端对齐 → 匹配失败 → 整批评重事件 seq 71-78 重复）
    let bestLen = 0;
    let bestPos = -1;
    for (let p = 0; p + bestLen < persistedTail.length; p++) {
      if (!sameEvt(persistedTail[p], lastDrained[0])) continue;
      let k = 1;
      while (
        p + k < persistedTail.length &&
        k < lastDrained.length &&
        sameEvt(persistedTail[p + k], lastDrained[k])
      ) {
        k++;
      }
      if (k > bestLen || (k === bestLen && p > bestPos)) {
        bestLen = k;
        bestPos = p;
      }
    }
    const missing = lastDrained.slice(bestLen);
    if (missing.length > 0) {
      await persistWithPhaseBreak(gameId, rt, missing);
    }
  }

  return rt;
}

// 已结束对局补开赛后讨论：用户显式点击「开启赛后讨论」。
// 引擎决策日志是确定性重放的——用 {...setup.options, postGameDiscuss: true} 重建引擎并
// 重放全部决策，原对局在最后一条决策处跑完 endGame；强制开启后生成器会继续进入
// postGamePhase 并停在第一个 postgameSpeak 单待决上（聊天室机制：按座位顺序逐个单问；
// decide 已排出赛后开场事件，由 buildRuntimeFromStore 的断点事件补漏作为缺失后缀补齐落盘）。
// 之后按普通 running 对局 tick 直播生成讨论（单 pending 走 decideWithAi，AI 失败启发式兜底=本轮弃权）。
async function startPostGame(
  gameId: string,
  userId?: string,
): Promise<{ started: boolean; reason?: string }> {
  const row = await requireOwnedGame(gameId, userId);

  // 路径A：分出胜负后挂起待开始（内存有运行时、停在 postgameSpeak）——
  // 「开启赛后讨论」的专用恢复通道：不再占用 control("start")（与继续键职责分离）
  if (row.status === "paused" && row.winner != null) {
    // 内存没有运行时则先重放重建（paused 不自动补链）——覆盖「服务重启后待开始」的场景
    const rt = registry.get(gameId) ?? (await recoverGame(gameId));
    if (!rt) return { started: false, reason: "对局恢复原料缺失，无法开启赛后讨论" };
    // 重放只恢复引擎状态、rt.pending 为空：从引擎补取当前待决（引擎幂等——待决在飞则原样返回；
    // 外部结算修复的对局由此推进出首个赛后待决，其开场事件经 persistWithPhaseBreak 落盘）
    if (!rt.pending && !rt.engine.isFinished()) {
      const adv = rt.engine.advance();
      if (adv.events.length > 0) await persistWithPhaseBreak(gameId, rt, adv.events);
      rt.pending = adv.pending;
    }
    if (!rt.pending || rt.pending.kind !== "postgameSpeak") {
      return { started: false, reason: "当前不在赛后讨论待开始状态" };
    }
    rt.postgameAutoHeld = true; // 用户显式开启：挂起拦截已消费
    rt.status = "running";
    try {
      await withTimeout(updateGame(gameId, { status: "running" }), DB_TIMEOUT_MS, "状态落库超时");
    } catch {
      /* 内存已 running，DB 抖动不阻塞 */
    }
    if (!rt.ticking) scheduleTick(gameId, rt, 0);
    startWinRateLoop(gameId, rt); // 赛后生成期间胜率预演同样继续
    return { started: true };
  }

  // 路径B：已结束对局补开（决策日志重放续跑）
  if (row.status !== "finished" || row.winner == null) {
    return { started: false, reason: "对局未结束或未分胜负" };
  }
  // 幂等：已有赛后内容（生成过/生成中）则不重复补开
  if (await hasPostGameEvents(gameId)) {
    return { started: false, reason: "赛后讨论已生成" };
  }
  const setup = (row.setup ?? null) as StoredSetup | null;
  if (!setup || !seatAIsOfSetup(setup) || !setup.seatRoles?.length) {
    return { started: false, reason: "该对局缺少回放原料，无法补开" };
  }
  let rt: GameRuntime | null = null;
  try {
    rt = await buildRuntimeFromStore(gameId, { optionsOverride: { postGameDiscuss: true } });
  } catch {
    // 重放分叉（决策日志早于新增检查点等）：清掉 registry 里可能被污染的 rt，
    // 避免影响后续 poll（poll 遇无 rt 会走行快照路径，finished 对局完全够用）
    registry.delete(gameId);
    return { started: false, reason: "对局过旧，决策日志无法重放" };
  }
  if (!rt) {
    return { started: false, reason: "该对局缺少回放原料，无法补开" };
  }
  // 引擎重放后在 decide 内已停在 postgameSpeak 待决上：advance 只取 pending 不推进
  const adv = rt.engine.advance();
  if (!adv.pending || adv.pending.kind !== "postgameSpeak") {
    registry.delete(gameId);
    return { started: false, reason: "无法进入赛后讨论" };
  }
  rt.pending = adv.pending;
  rt.acts = rt.engine.getSnapshot().pendingActs;
  rt.status = "running";
  rt.postgameAutoHeld = true; // 用户显式点击开启：不再触发挂起拦截
  rt.decidedPersisted = true; // winner 已落库，杜绝重复触发分析
  await withTimeout(updateGame(gameId, { status: "running" }), DB_TIMEOUT_MS, "状态落库超时");
  scheduleTick(gameId, rt, 0);
  startWinRateLoop(gameId, rt); // 赛后生成期间胜率预演同样继续
  return { started: true };
}

/** 赛前学习心得查询：内存（实时）优先，落库（恢复/重启后）补齐 */
async function studyNotes(gameId: string, userId?: string): Promise<{ seat: number; notes: string }[]> {
  await requireOwnedGame(gameId, userId);
  const rt = registry.get(gameId);
  const merged = new Map<number, string>();
  try {
    for (const r of await withTimeout(getStudyNotes(gameId), DB_TIMEOUT_MS, "学习笔记读取超时")) {
      merged.set(r.seat, r.notes);
    }
  } catch {
    /* 库读取失败仅用内存值 */
  }
  if (rt?.studyNotes) {
    for (const [seat, notes] of rt.studyNotes) merged.set(seat, notes);
  }
  return [...merged.entries()].map(([seat, notes]) => ({ seat, notes })).sort((a, b) => a.seat - b.seat);
}

// 轮询 tickKey 的组成（完整变更签名，不含引擎快照重建）：
// 状态/事件游标/待决/显示阶段/停歇状态——任何实际变化都会改变 tickKey（玩家状态变化
// 必伴随事件（seq 递增），故 seq 已隐含覆盖）
function tickKeyOf(rt: GameRuntime): string {
  return [
    rt.status,
    rt.seq,
    JSON.stringify(rt.acts ?? []),
    rt.displayPhase?.day ?? "",
    rt.displayPhase?.phase ?? "",
    rt.displayPhase?.phaseLabel ?? "",
    rt.pendingHold ? 1 : 0,
    rt.breakKind ?? "",
    rt.breakStartedAt ?? 0,
    // 赛前学习状态必须计入签名：学习进度变化时轮询不得走 unchanged 快路径
    // （曾因此前端看不到学习进度与自动开赛，观感=「无法启动对局」）
    rt.studying ? `study:${rt.studyInFlight?.size ?? 0}:${rt.studyDoneSeats?.size ?? 0}` : "",
  ].join("|");
}

/** 胜率推测轮询载荷：仅本局开启开关（rt 存活且 winRateEnabled）时查询；查库失败不阻断轮询主路径 */
async function winRatePayload(
  gameId: string,
  rt: GameRuntime | null | undefined,
  afterWinRateId: number,
): Promise<PollResult["winRate"] | undefined> {
  if (!rt?.winRateEnabled) return undefined;
  try {
    const [entries, latest] = await Promise.all([
      getWinRatesAfter(gameId, afterWinRateId),
      getLatestWinRate(gameId),
    ]);
    return {
      goodPct: latest?.goodPct ?? 50, // 尚无评估记录：初始 50/50 面板
      wolfPct: latest?.wolfPct ?? 50,
      entries,
    };
  } catch {
    return undefined;
  }
}

async function poll(gameId: string, afterSeq: number, lastSig?: string, userId?: string, afterWinRateId?: number): Promise<PollResult> {
  let row = await getGame(gameId);
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: `对局不存在: ${gameId}` });
  if (row.userId !== userId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "无权访问该对局" });
  }

  let rt: GameRuntime | null | undefined = registry.get(gameId);
  // 运行时缺失（服务重启/崩溃）：优先断点重放恢复；
  // 原料缺失的旧对局、或决策日志早于新增检查点（如遗言后/技能询问后权衡）导致重放分叉的，
  // 一律优雅降级为「暂停+行快照」（事件仍可查看），绝不让轮询抛 500
  if (!rt) {
    rt = null;
    try {
      rt = await recoverGame(gameId);
    } catch {
      rt = null;
    }
    if (!rt && (row.status === "created" || row.status === "running")) {
      // 旧对局（setup 无 seatAIs 或日志分叉）：标记暂停（事件仍可看）
      await updateGame(gameId, { status: "paused" });
      row = { ...row, status: "paused" };
    }
  }

  // 断链自愈：running 但长时间没有任何 tick 推进（timer 丢失/进程挂起恢复等）且无在飞 tick，
  // 判定 tick 链断裂 → 立即补链复活循环。前端轮询即充当看门狗触发器。
  // lastTickAt 前移兼作节流：最多每 STALE_TICK_MS 复活一次，避免并发轮询惊群。
  // 阈值取 max(15s, 2×步长)，避免大 stepDelayMs 的慢速对局被误判断链而打乱节奏。
  if (
    rt &&
    rt.status === "running" &&
    !rt.ticking &&
    Date.now() - rt.lastTickAt > Math.max(STALE_TICK_MS, rt.options.stepDelayMs * 2)
  ) {
    rt.lastTickAt = Date.now();
    scheduleTick(gameId, rt, 0);
  }

  // 304 式快路径：tickKey 未变意味着 seq 未变 → 必无新事件、快照内容必同——
  // 跳过 getEventsAfter 的 DB 往返与快照重建（AI 思考期占多数的空轮询因此零开销）
  if (rt) {
    const tickKey = tickKeyOf(rt);
    // 快路径说明：胜率记录入库不改变 tickKey（事件驱动的轮询节奏足够），
    // unchanged 快路径不附 winRate——前端保留既有游标，下一个非快路径响应自然带出新记录
    if (lastSig && lastSig === tickKey && afterSeq >= rt.seq) {
      return { unchanged: true, events: [] };
    }
    const snapshot = rt.snapCache?.tickKey === tickKey ? rt.snapCache.snapshot : snapshotFromRuntime(gameId, row, rt);
    rt.snapCache = { tickKey, snapshot };
    const events = await getEventsAfter(gameId, afterSeq);
    const winRate = await winRatePayload(gameId, rt, afterWinRateId ?? 0);
    // 补开赛后讨论资格透出：已结束或暂停待续、分了胜负、且库里确无赛后事件 →
    // 前端据此显示「开启赛后讨论」按钮；查库失败静默不附旗标。
    //（paused 纳入：分出胜负即落库 winner——审核驳回修复等对局停在「胜负已定、赛后未启」的
    //  暂停态，与「赛后挂起待开始」同权；options 不再过滤——开启赛后讨论的对局若因异常
    //  没跑成赛后，同样需要补开入口）
    let postGameEligible: boolean | undefined;
    if ((rt.status === "finished" || rt.status === "paused") && row.winner != null) {
      try {
        if (!(await hasPostGameEvents(gameId))) postGameEligible = true;
      } catch {
        /* 查库失败静默不附旗标 */
      }
    }
    // 心理检查进度透出（有人格座位且分出胜负的对局）
    const psyCheck = await psyCheckPayload(gameId, row, rt);
    return {
      unchanged: false,
      tickKey,
      snapshot,
      events,
      ...(winRate ? { winRate } : {}),
      ...(postGameEligible ? { postGameEligible } : {}),
      ...(psyCheck ? { psyCheck } : {}),
      // 赛前学习进度透出（仅开启图书馆的对局）
      ...(rt.options.libraryEnabled
        ? {
            study: {
              done: rt.studyDoneSeats?.size ?? 0,
              total: rt.seatAIs.length,
              studying: rt.studying === true,
              inFlight: [...(rt.studyInFlight ?? new Set<number>())],
            },
          }
        : {}),
    };
  }

  const events = await getEventsAfter(gameId, afterSeq);
  // 无 runtime 时用增量事件的最大 seq 作为游标（无新事件则维持 afterSeq）
  const seqHint = events.length > 0 ? events[events.length - 1].seq : afterSeq;
  const snapshot = snapshotFromRow(gameId, row, seqHint);
  const tickKey = `row|${snapshot.status}|${seqHint}`;
  if (lastSig && lastSig === tickKey && events.length === 0) {
    return { unchanged: true, events: [] };
  }
  // 补开赛后讨论资格透出（行快照路径：恢复原料缺失/重放分叉的旧对局同样可能补开失败，
  // 但资格语义只看「已结束或暂停待续、分了胜负、还没有赛后内容」；补开可行性由 startPostGame 裁决）
  let postGameEligible: boolean | undefined;
  if ((row.status === "finished" || row.status === "paused") && row.winner != null) {
    try {
      if (!(await hasPostGameEvents(gameId))) postGameEligible = true;
    } catch {
      /* 查库失败静默不附旗标 */
    }
  }
  // 心理检查进度透出（行快照路径同样透出：无运行时的旧对局也能看到检查状态）
  const psyCheckRow = await psyCheckPayload(gameId, row, null);
  return {
    unchanged: false,
    tickKey,
    snapshot,
    events,
    ...(postGameEligible ? { postGameEligible } : {}),
    ...(psyCheckRow ? { psyCheck: psyCheckRow } : {}),
  };
}

async function list(userId: string): Promise<GameSummary[]> {
  // 本地桌面端：历史对局不限数量，全量返回（玩家可自由访问任意历史对局）
  const rows = await listGames(userId);
  return rows.map((r: GameRow) => {
    const rt = registry.get(r.id);
    return {
      id: r.id,
      boardName: r.boardName,
      titleNo: r.titleNo ?? "",
      status: rt ? rt.status : (r.status as GameStatus),
      winner: (r.winner as "wolf" | "good" | null) ?? null,
      dayCount: r.dayCount,
      createdAt: toIso(r.createdAt),
      playerCount: r.playerCount,
    };
  });
}

async function exportGame(
  gameId: string,
  userId?: string,
): Promise<{ snapshot: GameSnapshot; events: unknown[] }> {
  // userId 由路由层强制传入（归属校验）；服务内部复盘路径（distill 复活）可不传
  const row = userId ? await requireOwnedGame(gameId, userId) : await getGame(gameId);
  if (!row) throw new Error(`对局不存在: ${gameId}`);
  const rt = registry.get(gameId);
  const events = await getAllEvents(gameId);
  const snapshot = rt
    ? snapshotFromRuntime(gameId, row, rt)
    : snapshotFromRow(gameId, row, events.length > 0 ? events[events.length - 1].seq : 0);
  return { snapshot, events };
}

async function aiTest(input: AiTestInput): Promise<AiTestResult> {
  const res = await callAi(
    {
      seat: 0,
      provider: input.provider,
      baseUrl: input.baseUrl,
      model: input.model,
      apiKey: input.apiKey,
    },
    "你是连通性测试助手，请严格按要求输出。",
    '回复{"ok":true}',
  );
  return {
    ok: res.ok,
    message: res.ok ? (res.text ?? "").slice(0, 200) : (res.error ?? "调用失败"),
    latencyMs: res.latencyMs,
  };
}

// ---------- 分析师与经验指南 ----------

async function guide(userId: string): Promise<GuideOverview> {
  // 有指南的全部 scope：common 归入 common，其余按版型逐个组装（boardName 从契约 BOARDS 查）
  const scopes = await listGuideScopes(userId);
  const common = await guideInfoOf(userId, "common");
  const boards: GuideBoardEntry[] = [];
  for (const scope of scopes) {
    if (scope === "common") continue;
    const info = await guideInfoOf(userId, scope);
    if (info.version <= 0) continue; // 仅包含有特定内容的版型
    boards.push({
      boardId: scope,
      boardName: BOARDS.find((b) => b.id === scope)?.name ?? scope,
      guide: info,
    });
  }
  // 按契约 BOARDS 顺序排列，未知版型排最后，保证展示稳定
  boards.sort((a, b) => {
    const ia = BOARDS.findIndex((x) => x.id === a.boardId);
    const ib = BOARDS.findIndex((x) => x.id === b.boardId);
    return (ia === -1 ? BOARDS.length : ia) - (ib === -1 ? BOARDS.length : ib);
  });
  return { common, boards };
}

async function guideVersions(userId: string, scope: string): Promise<GuideVersionSummary[]> {
  const rows = await listGuideVersions(userId, scope, 50);
  return rows.map((r: { version: number; gameId: string | null; note: string; createdAt: Date }) => ({
    version: r.version,
    gameId: r.gameId,
    note: r.note,
    createdAt: toIso(r.createdAt),
  }));
}

async function guideVersion(
  userId: string,
  scope: string,
  version: number,
): Promise<{ version: number; content: string; createdAt: string } | null> {
  const row = await getGuideVersion(userId, scope, version);
  if (!row) return null;
  return { version: row.version, content: row.content, createdAt: toIso(row.createdAt) };
}

// 用户手动编辑指南：以编辑后内容生成该 scope 的新版本（历史保留，可随时回看旧版）
async function updateGuide(userId: string, scope: string, content: string): Promise<GuideInfo> {
  const text = content.trim();
  if (!text) throw new Error("指南内容不能为空");
  const latest = await getLatestGuide(userId, scope);
  await insertGuideVersion({
    scope,
    version: (latest?.version ?? 0) + 1,
    content: text,
    gameId: null,
    note: "用户手动编辑",
    userId,
  });
  // 指南变了：清空注入缓存，后续决策立即用上编辑后内容（common 影响全部版型，直接全清）
  guideCache.clear();
  return guideInfoOf(userId, scope);
}

async function guideInfoOf(userId: string, scope: string): Promise<GuideInfo> {
  const [row, entryCount] = await Promise.all([getLatestGuide(userId, scope), countGuides(userId, scope)]);
  if (!row) return { version: 0, content: "", updatedAt: null, entryCount: 0 };
  return {
    version: row.version,
    content: row.content,
    updatedAt: toIso(row.createdAt),
    entryCount,
  };
}

async function getAnalysis(
  gameId: string,
  userId: string,
): Promise<{ report: AnalysisReport | null; jobStatus: AnalysisJobStatus; jobStage: AnalysisJobStage; jobError: string | null }> {
  await requireOwnedGame(gameId, userId); // 账户隔离
  const row = await getAnalysisRow(gameId);
  // 内存 Map 优先；重启后（Map 丢失）按库里有无论 done/idle
  const job = analysisJobs.get(gameId);
  // 自愈：running 但超过 ANALYSIS_STALE_MS 没有任何心跳 → 任务已死（进程波动/调用悬挂），
  // 从当前 stage 的检查点重新发起（有 report 跳过 analyze 直接 distill；无则从头）。
  // updatedAt 前移兼作节流：最多每 ANALYSIS_STALE_MS 复活一次，避免并发轮询惊群。
  if (job?.status === "running" && Date.now() - job.updatedAt > ANALYSIS_STALE_MS) {
    job.updatedAt = Date.now();
    void runAnalysisJob(gameId, job.cfg).catch(() => {
      /* 复活失败状态已置 failed，无需再上抛 */
    });
  }
  const jobStatus: AnalysisJobStatus = job?.status ?? (row ? "done" : "idle");
  return {
    report: row
      ? { gameId, report: row.report, model: row.model, createdAt: toIso(row.createdAt) }
      : null,
    jobStatus,
    jobStage: job?.status === "running" ? job.stage : null,
    jobError: job?.error ?? null,
  };
}

async function generateAnalysis(
  gameId: string,
  userId: string,
  analyst?: AnalystAiConfig,
): Promise<{ started: boolean }> {
  const row = await requireOwnedGame(gameId, userId); // 账户隔离 + 存在性校验
  // 已结束/已暂停/已中断的对局均可分析（未完结的对局按已有日志做阶段性复盘）
  if (row.status === "created") throw new Error("对局尚未开始，无内容可分析");
  // 分出胜负（winner 已落库）后即使仍在赛后讨论（status=running）也放行：对局结束后即可生成报告
  if (row.status === "running" && !row.winner)
    throw new Error("对局进行中：请先暂停或等待分出胜负后再生成分析报告");
  if (analysisJobs.get(gameId)?.status === "running") return { started: false };
  // 未指定分析师配置时，复用该对局内存中的座位 agent 配置（分析师与玩家共用同一 agent）
  let cfg = analyst;
  if (!cfg) {
    const rt = registry.get(gameId);
    cfg = rt?.seatAIs[0]
      ? { provider: rt.seatAIs[0].provider, baseUrl: rt.seatAIs[0].baseUrl, model: rt.seatAIs[0].model, apiKey: rt.seatAIs[0].apiKey }
      : undefined;
    if (!cfg) throw new Error("未提供分析师配置，且该对局的玩家 agent 配置已不在内存中（服务重启后请在页面配置分析师）");
  }
  // 不 await：立即返回，任务状态通过 getAnalysis 的 jobStatus 轮询
  void runAnalysisJob(gameId, cfg).catch(() => {
    /* 状态已置 failed，无需再上抛 */
  });
  return { started: true };
}

/** 人格研究库：本局人格座位的《心理检查报告》列表（归属校验后返回） */
async function personaReports(gameId: string, userId: string) {
  await requireOwnedGame(gameId, userId);
  return getPersonaReportsForGame(gameId);
}

export const gameService: GameService = {
  createGame,
  control,
  startPostGame,
  startPsyCheck,
  studyNotes,
  poll,
  list,
  exportGame,
  aiTest,
  guide,
  guideVersions,
  guideVersion,
  updateGuide,
  getAnalysis,
  generateAnalysis,
  personaReports,
};

// ---------- 模块装配：为法官模块注入书记员实现（模块加载即完成，运行时零开销） ----------
initJudgeRecorder({
  persistEvents: (gameId, rt, events) => persistWithPhaseBreak(gameId, rt, events),
  markDecided: markDecidedIfNeeded,
  finishIfDone,
  scheduleTick,
});

