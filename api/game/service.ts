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
import { assertBoardSeatRoles, assertStudyOptions, BOARDS, ROLE_META, formatGameTitleNo, studySourcesOf } from "../../contracts/game";
import type { GameRow } from "../../db/schema";
import { TRPCError } from "@trpc/server";
import { encryptSecret } from "../lib/authCrypto";
import {
  appendEvents,
  countGamesOnDate,
  deathSeatsFromEvents,
  getAllEvents,
  getEventsAfter,
  getGame,
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
} from "../queries/guide";
import { appendDecision, getDecisions } from "../queries/decisions";
import { getAllLibraryContents, upsertStudyNote, getStudyNotes } from "../queries/library";
import { getLatestWinRate, getWinRatesAfter } from "../queries/winrates";
import { buildStudyPrompt, buildStudyPickPrompt, buildChapterPickPrompt, buildHistoryPickPrompt, buildHistoryRefPrompt, splitDocChapters } from "./analyst";
import { buildLogDigest } from "./logDigest";
import { runVictoryAiAudit } from "./victory-ai-audit";
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
import { isQuotaErrorText, isOutageErrorText, isBudgetErrorText } from "./ai/quota";
import { defaultCallTimeoutMs, isThinkingModel } from "./ai/modelCaps";
import { buildPrompt, modelContextTokens } from "./ai/prompts";
import { buildLiveCognition, type LiveCognition } from "./evidence";
import { parseDecision } from "./ai/parse";
import { buildPersonaCircleText, buildPostgamePersonaFactText, injectCircleText, personaGenderFromSetup, assertPersonaCircleCoverage } from "./personaVisibility";
import { deathInfoBySeatFromEvents, deathSeatsFromEvent, finalSurvivorsFromEvents } from "../../src/lib/playerEventState";
import type { PersonaCard, PersonaEventMeta, PersonaSeatInfo } from "../../contracts/persona";
import {
  getPersona,
  getPersonaCardsInternal,
  getPersonaReportsForGame,
  incrementPersonaGameCount,
  loadMemoryPool,
  renderMemoryText,
  type MemoryPool,
} from "../queries/personas";
import { runPersonaPipeline, shouldUseDualPipeline } from "../persona/pipeline";
import { createPersonaSnapshot, type PersonaSnapshot } from "../persona/context";
import { buildSituationSignature } from "../persona/memory";
import { withTimeout, DB_TIMEOUT_MS } from "./runtime/timing";
import {
  elapsedAt,
  finishTiming,
  initialGameTiming,
  pauseTiming,
  startTiming,
  type GameTiming,
} from "./timing";
import { initJudgeRecorder, maybeFoulCheck } from "./judge/foulReferee";

export interface GameService {
  // userId 由路由层强制传入（归属校验）；测试/内部路径可省略（省略时不做归属拦截）
  createGame(input: CreateGameInput, userId?: string): Promise<{ gameId: string }>;
  control(gameId: string, action: "start" | "pause" | "terminate" | "stopPostGame", userId?: string, seatRoles?: RoleId[]): Promise<{ ok: boolean }>;
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
  /** 人格研究站：本局人格座位的《心理检查报告》列表（对局页查看入口） */
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
  /** 开始/暂停/继续/终止共用的累计计时，随 setup 持久化。 */
  timing: GameTiming;
  seq: number;
  timer: ReturnType<typeof setTimeout> | null;
  pending: PendingDecision | null;
  options: AdvancedOptions;
  /** 开局冻结的指南资料；未选择指南来源时为空，赛后蒸馏不得改写当前局。 */
  guideTextSnapshot: string;
  /** 手动角色是否已提交并持久化；后续赛前学习/暂停续跑复用，不重复要求 seatRoles */
  manualRolesAssigned?: boolean;
  ticking: boolean; // tick 执行锁，防止重入
  lastTickAt: number; // 最近一次 tick 开始/结束的时间戳（断链检测依据）
  noProgressTicks: number; // 连续「无事件且无待决且未结束」的 tick 数（引擎停滞看门狗）
  pauseWaiters: Array<() => void>; // 在飞决策的暂停等待者：暂停时唤醒，挂起当前决策（resume 时重新思考）
  // 控制代次：暂停/终止递增。即使暂停后立即继续，旧 tick 也不能消费旧代次的 AI 结果。
  decisionEpoch: number;
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
  // 带真实对局编号（#seq）的公开记录缓存：maxSeq 与 rt.seq 一致即命中，新事件落盘后失效重建
  pubLogCache?: { maxSeq: number; lines: string[]; events: GameEvent[] } | null;
  // 赛前图书馆学习：座位 → 学习心得；studyDoneSeats 完成计数；studying/studyDone 状态
  studyNotes?: Map<number, string>;
  studyDoneSeats?: Set<number>;
  studyInFlight?: Set<number>; // 正在学习的座位（快照透出 → 祖母绿「学习中」状态环）
  studying?: boolean;
  studyDone?: boolean;
  // ---------- 人格研究站（铁律2/4/6 对局执行） ----------
  // 人格卡按座位注册：绑定人格的座位决策走「心镜→涌现」管线而非普通 buildPrompt
  personaCards?: Map<number, PersonaCard>;
  /** 开局冻结的人格与记忆版本：恢复优先于研究站现卡。 */
  personaSnapshots?: Map<number, PersonaSnapshot<MemoryPool>>;
  // 座位人格绑定快照（seat/personaId/name）：人格圈层可见度的全场绑定表（创建/恢复时写入）
  seatPersonas?: PersonaSeatInfo[];
  // 记事簿注入文本（跨对局记忆与关系图谱）：创建/恢复时加载，随记忆回写跨局演进
  /** 「记性」记忆池缓存（结构化）；注入文本每回合按当前情境现算 */
  personaMemory?: Map<number, MemoryPool>;
  // 涌现事件注解暂存（座位 → 本决策点的人格注解）：事件落盘前富化到 meta.persona 后清空
  personaEventMeta?: Map<number, PersonaEventMeta>;
  // 心理检查（手动开启环节）运行时状态：在飞座位 / 已完成座位（poll 透出进度）
  psyCheckRunning?: Set<number>;
  psyCheckDone?: Set<number>;
  // 暂停原因（AI 额度耗尽等需要用户知情的暂停）：poll 透出到「继续」按钮旁；恢复时清空
  pauseReason?: string | null;
  // AI 调用层连续失效计数（熔断依据；成功决策清零；输出非法不计——那是模型行为而非服务中断）
  aiOutageStreak?: number;
  // ---------- 犯规裁判（分析师担任，实时审查公开发言的内容级犯规） ----------
  // 赛后讨论与狼人频道豁免；判罚经 settleExternal 落定对立阵营获胜（与拍刀驳回同一外部结算路径）
  foulQueue?: EngineEvent[]; // 待审公开发言事件（事件落盘即入队，逐个审查）
  foulInFlight?: boolean;    // 审查在飞标记（只审最新，不排队积压审查调用）
  foulSettled?: boolean;     // 本局已判罚（一局至多一次判罚结算，防止重复落定）
}

  /** 当前处境包含阵营与具体决策类型；检索只作认知联想，不生成战术建议。 */
  function memorySignatureOf(rt: GameRuntime, seat: number, pending: PendingDecision): string {
    const camp = rt.engine.getSnapshot().players.find((p) => p.seat === seat)?.camp ?? "good";
    return buildSituationSignature({ scenarioKind: "game", phase: pending.kind, role: camp });
  }

  /** 每回合现算注入文本：被动联想 + 主体当前任务 + 在场关系。 */
  function memorySignatureText(rt: GameRuntime, seat: number, pending: PendingDecision): string | null {
    const fog = new Set(rt.options.personaFogSeats ?? []);
    const visibility = rt.options.personaVisibility ?? "full";
    const presentNames = visibility === "none"
      ? []
      : (rt.seatPersonas ?? [])
          .filter((b) => b.seat !== seat && !(visibility === "partial" && fog.has(b.seat)))
          .map((b) => b.name);
    const text = renderMemoryText(rt.personaMemory?.get(seat), {
      signature: memorySignatureOf(rt, seat, pending),
      concerns: [pending.hint],
      presentNames,
    });
    return text.trim() ? text : null;
  }

export const registry = new Map<string, GameRuntime>();

// 断点重放恢复模块（书记员层，api/game/recovery.ts）：依赖注入杜绝环引用——
// registry/scheduleTick/maybeWinRateTick/persistWithPhaseBreak 属主仍在本文件
import { createWinRate } from "./winrate";
import { createPsyCheck, psyCheckPayload } from "./psy-check";
import { analysisJobs, createAnalysisPipeline } from "./analysis";
export { analysisJobs };
export type { AnalysisJob } from "./analysis";
export { parseWinRateOutput } from "./winrate";
import { createRecovery, seatAIsOfSetup, partOfPhase } from "./recovery";
import { describeActionForNote, SEAT_NOTE_CHARS, SEAT_NOTE_MAX } from "./seat-notes";
// 胜率集群已迁入 api/game/winrate.ts（与 recovery 同法：依赖注入杜绝环引用）
const { maybeWinRateTick, startWinRateLoop } = createWinRate({ getCachedGuideText });
const { recoverGame, buildRuntimeFromStore } = createRecovery({
  registry,
  scheduleTick,
  maybeWinRateTick,
  persistWithPhaseBreak,
});

// 恢复中的对局（并发 poll/control 去重共享同一 Promise，避免惊群重复重放）

// ---------- 超时/看门狗常量 ----------
// 计时工具已迁入书记员层（runtime/timing.ts）：withTimeout / DB_TIMEOUT_MS
const STALE_TICK_MS = 15_000; // running 状态下超过该时长没有任何 tick 推进 → 判定 tick 链断裂
const MAX_NO_PROGRESS_TICKS = 30; // 连续无进展 tick 上限，超过判定为引擎停滞

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

/** 复盘前置的唯一就绪门槛：报告已落库，且本局两类经验指南已写入玩家认知库。
 *  与用户是否打开报告无关；自动讨论也只等待这项客观条件。 */
async function postGameReviewReady(gameId: string, row: GameRow): Promise<boolean> {
  if (!row.userId) return false;
  const report = await getAnalysisRow(gameId).catch(() => null);
  if (!report?.report?.trim()) return false;
  const job = analysisJobs.get(gameId);
  if (job && job.status !== "done") return false;
  const [common, board] = await Promise.all([
    getLatestGuide(row.userId, "common"),
    getLatestGuide(row.userId, row.boardId),
  ]).catch(() => [null, null]);
  if (!common?.content || !board?.content || common.gameId !== gameId || board.gameId !== gameId) return false;
  guideCache.set(`${row.userId}:${row.boardId}`, {
    at: Date.now(),
    text: combineGuideText(row.boardId, common.content, board.content),
  });
  return true;
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

// 心理检查集群已迁入 api/game/psy-check.ts（与 recovery/winrate 同法：依赖注入杜绝环引用）
const { maybeAutoPsyCheck, startPsyCheck } = createPsyCheck({
  errMessage, snapshotFromRuntime, requireOwnedGame, recoverGame, registry,
});

// 分析流水线已迁入 api/game/analysis.ts（analysisJobs 状态随迁，上方再导出供测试/诊断）
const { runAnalysisJob, triggerAutoAnalysis } = createAnalysisPipeline({
  exportGame, maybeAutoPsyCheck, resumePostGameAfterReview, combineGuideText, errMessage, registry, guideCache,
});

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

async function persistGameTiming(
  gameId: string,
  timing: GameTiming,
  patch: Parameters<typeof updateGame>[1] = {},
): Promise<void> {
  const row = await getGame(gameId);
  if (!row) return;
  await updateGame(gameId, {
    ...patch,
    setup: { ...(row.setup as StoredSetup), timing },
  });
}

export interface StoredSetup {
  seatRoles: RoleId[];
  /** 手动分配已确认；创建时的版型占位角色不得被误当作用户分配结果 */
  manualRolesAssigned?: boolean;
  seatModels: string[];
  options: AdvancedOptions;
  /** 开局冻结的指南资料；旧对局缺省时按无资料处理。 */
  guideTextSnapshot?: string;
  // 断点恢复需要完整 AI 配置（含 key）：账户体系后以 AES-GCM 密文存 seatAIsEnc；
  // 旧对局的明文 seatAIs 仅作兼容回退；更老的对局两者皆无 → 不可自动恢复（仅可查看事件）
  seatAIs?: SeatAiConfig[];
  seatAIsEnc?: string;
  // 胜率推测开关（重启恢复后功能仍在的依据）
  winRateEnabled?: boolean;
  /** 分析师配置与自动复盘开关（AES-GCM 密文，恢复后自动生成不再丢配置） */
  analystAiEnc?: string;
  analystAutoGenerate?: boolean;
  // 人格研究站：座位人格绑定快照（含人格名冗余——断点恢复与快照展示不再查库）
  seatPersonas?: PersonaSeatInfo[];
  /** 座位号 → 开局人格及记忆快照；旧对局缺省时回退现卡。 */
  personaSnapshots?: Record<string, PersonaSnapshot<MemoryPool>>;
  /** 对局累计计时；旧对局缺省时按事件时间回退。 */
  timing?: GameTiming;
}

/** 从 StoredSetup 解出座位 AI 配置：优先密文，兼容明文存量 */
// ---------- 事件持久化（每条赋递增 seq） ----------
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
/** 人格事件富化：把本决策点涌现管线产出的人格注解合并进该座位的发言/行动/投票事件
 * （event.meta.persona：双视角解释 + 撕裂组摘要，观察者双栏展示；富化后即清空防串用） */
export function enrichPersonaEvents(rt: GameRuntime, events: EngineEvent[]): void {
  if (!rt.personaEventMeta || rt.personaEventMeta.size === 0) return;
  for (const ev of events) {
    if (ev.actor == null) continue;
    const meta = rt.personaEventMeta.get(ev.actor);
    // 警长定序同时产出权衡事件与公开事件：两侧都展示同一份标准心镜，
    // 但公开事实仍只取 content，观察者心理不会写入其他玩家的公开记录。
    const publicSheriffOrder = ev.type === "system" && ev.title === "警长定序" && ev.meta?.channel !== "skillThink";
    if (meta && (ev.type === "speech" || ev.type === "action" || ev.type === "vote" || ev.meta?.channel === "skillThink" || publicSheriffOrder)) {
      ev.meta = { ...(ev.meta ?? {}), persona: meta };
      // 展示层才使用观察模板；决策日志与座位笔记在此之前已保存主体原文。
      if (meta.observerThought) ev.thought = meta.observerThought;
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

// 输出非法的「标记生成器」（2026-10-15 托管抹消后）：只用于清洗层给非法输出打标记，
// 调用方凭标记即停——该函数产出的内容绝不进入引擎、绝不落事件流（历史用途=兜底决策，已废止）
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
// 人格双程管线（心镜+涌现=两次完整思考调用）预算下限翻倍：520s。
// 2026-10-14 实锤（20261014001 第5天夜神月发言托管）：260s 单程预算下，大上下文对局后期
// 心镜烧掉 35%、涌现首发 150s 超时、涌现重试只剩 43s 必败——双程必须用双程的预算。
// 非思考型双程（两次 90s 常规调用+重试余量）：240s。
const THINKING_DUAL_MIN_BUDGET_MS = 520_000;
const DUAL_MIN_BUDGET_MS = 240_000;

export function decisionDeadlineMs(rt: GameRuntime, cfg?: SeatAiConfig, seat?: number): number {
  const envOverride = Number(process.env.AI_DECISION_DEADLINE_MS);
  if (envOverride) return envOverride;
  const sec = rt.options.aiTimeLimitSec;
  const base =
    typeof sec === "number" && sec > 0 ? Math.max(120, sec) * 1000 : Number.POSITIVE_INFINITY;
  if (!cfg) return base;
  // 人格双程管线判定：座位绑了人格且模型上下文够走双程（单程合并不翻倍）
  const dual =
    seat != null &&
    (rt.personaCards?.has(seat) ?? false) &&
    shouldUseDualPipeline(modelContextTokens(cfg.model));
  const thinking = isThinkingModel(cfg);
  // 思考型模型：预算下限放宽（思考链耗时长，过紧预算只会批量超时转托管）
  const floor = dual
    ? thinking
      ? THINKING_DUAL_MIN_BUDGET_MS
      : DUAL_MIN_BUDGET_MS
    : thinking
      ? THINKING_MIN_BUDGET_MS
      : 0;
  return Math.max(base, floor);
}

async function askAiOnce(
  cfg: SeatAiConfig,
  pending: PendingDecision,
  retryNote: string | null,
  rt: GameRuntime,
  resumeNote: string | null = null,
  deadlineAt?: number,
  gameId?: string,
): Promise<{ decision: DecisionInput | null; error: string | null }> {
  try {
    let cognition: LiveCognition | undefined;
    // 公开记录换用带真实对局编号（#seq）的事件流重建（行号与公屏对不上的事故根治，
    // 2026-10-15 实锤：玩家引用「第136条」而公屏已是 [358]）——失败保持引擎 pub 口径
    if (gameId) {
      const seqLog = await seqPublicLog(gameId, rt);
      if (seqLog) {
        pending = { ...pending, view: { ...pending.view, publicLog: seqLog } };
        const events = rt.pubLogCache?.maxSeq === rt.seq ? rt.pubLogCache.events : undefined;
        if (events) {
          let decisions;
          try {
            decisions = await getDecisions(gameId);
          } catch {
            decisions = undefined; // 决策日志读取失败回退既有提示，绝不注入其他座位记录。
          }
          cognition = buildLiveCognition(gameId, pending.seat, events, {
            wolfTeam: pending.view.private?.wolfTeammates !== undefined,
            postgame: pending.kind === "postgameSpeak",
            targetSeats: pending.options,
            decisions,
          });
        }
      }
    }
    // 总预算守卫：剩余预算不足一次最短调用时直接判失败（调用方走兜底）
    const remaining = deadlineAt != null ? deadlineAt - Date.now() : Number.POSITIVE_INFINITY;
    if (remaining <= 3_000) {
      return { decision: null, error: "AI响应总预算耗尽，转入托管" };
    }
    // 人格研究站：绑定人格的座位改走「心镜→涌现」管线（铁律2参数溢出/铁律4双视角/铁律6撕裂），
    // 基础博弈情境仍由 buildPrompt 单一事实源生成（信息壁垒铁律不破）
    const personaCard = rt.personaCards?.get(pending.seat);
    if (personaCard) {
      const personaGuide = rt.guideTextSnapshot;
      const personaModelContext = modelContextTokens(cfg.model);
      const base = buildPrompt(pending, {
        retryNote: retryNote ?? undefined,
        resumeNote: resumeNote ?? undefined,
        guide: personaGuide,
        notes: rt.seatNotes?.get(pending.seat),
        studyNote: rt.studyNotes?.get(pending.seat),
        cognition,
        timeLimitSec: rt.options.aiTimeLimitSec,
        modelContext: personaModelContext,
      });
      // 人格圈层可见度：仅人格座位注入（普通 AI 不受影响）——
      // 三档（full 全见/partial 勾选迷雾/none 全员迷雾），不破身份壁垒；
      // 含人格名互称指引与羁绊注入（记事簿跨局关系 + 档案互提原作渊源）
      const bindings = (rt.seatPersonas ?? []).map((b) => {
        const card = rt.personaCards?.get(b.seat);
        return {
          seat: b.seat,
          name: b.name,
          // 外貌气质与基本印象取自完整人格卡（断点恢复时卡已删的座位自动退化为仅姓名）
          appearance: card?.profile.appearance ?? null,
          summary: card?.profile.summary?.trim() ?? null,
          originSource: card?.originSource ?? null,
          gender: card?.profile.gender || null,
        };
      });
      const circleText = buildPersonaCircleText(
        pending.seat,
        bindings,
        rt.options.personaVisibility,
        rt.options.personaFogSeats,
        undefined,
      );
      if (circleText) {
        // 注入位铁律：必须落在【输出契约】之前——人格管线会截断契约后的部分
        //（对局 20260930001 实锤：尾部追加被静默切断，人格玩家全程互不认识）
        base.user = injectCircleText(base.user, circleText);
        assertPersonaCircleCoverage(base.user, circleText);
      }
      if (pending.kind === "postgameSpeak") {
        const factText = buildPostgamePersonaFactText(
          pending.seat,
          bindings,
          pending.view.deathTimeline,
          rt.options.personaVisibility,
          rt.options.personaFogSeats,
        );
        if (factText) base.user = injectCircleText(base.user, factText);
      }
      const personaRes = await runPersonaPipeline({
        cfg,
        card: personaCard,
        memoryText: memorySignatureText(rt, pending.seat, pending),
        pending,
        base,
        modelContext: personaModelContext,
        deadlineAt,
        relationDigest: null,
        retryNote,
        resumeNote,
      });
      if (personaRes.personaMeta) {
        if (!rt.personaEventMeta) rt.personaEventMeta = new Map();
        rt.personaEventMeta.set(pending.seat, personaRes.personaMeta);
      }
      return { decision: personaRes.decision, error: personaRes.error };
    }
    // 只使用开局冻结的指南；未选择指南来源时为空，赛后蒸馏不回流当前局。
    const guide = rt.guideTextSnapshot;
    const { system, user } = buildPrompt(pending, {
      retryNote: retryNote ?? undefined,
      resumeNote: resumeNote ?? undefined,
      guide,
      // 该座位的对局笔记（其所思所为的知识库，仅本人可见）
      notes: rt.seatNotes?.get(pending.seat),
      // 赛前图书馆学习心得（开启图书馆且该座位已完成学习时注入）
      studyNote: rt.studyNotes?.get(pending.seat),
      cognition,
      // 决策总时限（用户设置时告知 AI 快速决断）
      timeLimitSec: rt.options.aiTimeLimitSec,
      // 按座位模型上下文动态分配公开记录/指南注入预算（防小上下文模型后期被撑爆）
      modelContext: modelContextTokens(cfg.model),
    });
    // 单次调用超时按模型能力画像分流（思考型 150s / 常规 90s，AI_TIMEOUT_MS 可全覆盖），
    // 且不超过剩余预算；普通决策与人格管线共用 providers 默认退避重试。
    // deadlineAt 透传进 callAi——重试循环内逐次按剩余预算截断，预算真正具有约束力
    const cfgTimeoutMs = defaultCallTimeoutMs(cfg);
    const res = await callAi(cfg, system, user, {
      timeoutMs: Math.max(3_000, Math.min(cfgTimeoutMs, remaining - 500)),
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
/** AI 账户额度耗尽（余额/token 不足）：立即暂停对局的专用错误——
 * 此类故障重试与托管兜底都只会批量产出低质量发言（20261011001 实锤：DeepSeek 额度耗尽后
 * 全场托管「我这边没什么头绪」，对局质量崩塌），正确做法是当即暂停、提示用户充值/换配置。 */
/** AI 服务连续失效（调用层故障连续超限）：熔断暂停——断电/休眠后的连接假死、
 *  服务商宕机等会让每个决策点都烧满预算再托管，对局被垃圾发言淹没还照跑（20261011003 实锤）。
 *  正确做法：连续失效即暂停，把处置权交还用户。 */
export class AiOutageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiOutageError";
  }
}

export class AiQuotaExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiQuotaExhaustedError";
  }
}

/** 连续失效熔断阈值：连续 3 个决策点调用层落空即暂停（误判代价=一次暂停；放任代价=整局报废） */
const AI_OUTAGE_STREAK_LIMIT = 3;

/** 熔断计数与判定：调用层故障累加并在超限时抛出；任何成功决策由调用方清零 */
function trackOutageOrThrow(rt: GameRuntime, errorText: string | null): void {
  if (!isOutageErrorText(errorText)) return;
  rt.aiOutageStreak = (rt.aiOutageStreak ?? 0) + 1;
  if (rt.aiOutageStreak >= AI_OUTAGE_STREAK_LIMIT) {
    throw new AiOutageError(
      `AI 服务连续无响应，对局已自动暂停：已连续 ${rt.aiOutageStreak} 个决策点得不到任何回应（网络中断、API 服务故障，或断电/休眠后的连接假死）。请检查网络与 API 配置后点击「继续」——当前进度不会丢失。`,
    );
  }
}

class SuspendDecision extends Error {
  constructor() {
    super("对局已暂停，决策挂起待恢复");
    this.name = "SuspendDecision";
  }
}

// 动作主权边界：不做语义修复，不替主体把非法意图改成另一个合法动作。
// 返回原始输入交引擎校验；非法时由现有流程带原因重问，仍非法则暂停。
export function repairDecision(
  pending: PendingDecision,
  inp: DecisionInput,
): { input: DecisionInput; notes: string[] } {
  void pending;
  return { input: { ...inp }, notes: [] };
}

// 并行批次子决策清洗：保证合并后的批量决策必被引擎接受（批量结算不做整批重试，单点非法不应拖垮同轮其他人）。
// 分流规则：
// - daySkill 权衡子项：合法技能原样保留；非法技能意图打退回标记，由调用方暂停，绝不静默改成按兵不动
// - 其他批次（上警报名/警徽投票/放逐投票等）：AI 的合法选择（targets 落在 options 内、
//   或允许跳过时的 skip）原样保留；只有真正非法的输出才回退启发式兜底（保证该类型合法），
//   绝不把合法选择篡改为 skip——否则不允许跳过的类型（如报名）会被引擎整批拒绝
function sanitizeBatchInputAction(sub: PendingDecision, inp: DecisionInput): DecisionInput {
  if (sub.kind === "daySkill") {
    if (inp.selfDestruct) {
      return MEETING_WOLVES.has(sub.role)
        ? { thought: inp.thought, selfDestruct: true }
        : heuristicDecision(sub, "[AI输出非法，系统托管]");
    }
    if (inp.surrender) {
      return MEETING_WOLVES.has(sub.role)
        ? { thought: inp.thought, surrender: true }
        : heuristicDecision(sub, "[AI输出非法，系统托管]");
    }
    if (inp.declareVictory) {
      return MEETING_WOLVES.has(sub.role)
        ? { thought: inp.thought, declareVictory: true }
        : heuristicDecision(sub, "[AI输出非法，系统托管]");
    }
    if (inp.duel != null) {
      return sub.role === "knight" && sub.options.includes(inp.duel)
        ? { thought: inp.thought, duel: inp.duel }
        : heuristicDecision(sub, "[AI输出非法，系统托管]");
    }
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

/** 动作清洗与认知保存分轨：非法动作不会被意图字段合法化，合法动作也不丢失主体当下认知。 */
export function sanitizeBatchInput(sub: PendingDecision, inp: DecisionInput): DecisionInput {
  const out = sanitizeBatchInputAction(sub, inp);
  return inp.intent ? { ...out, intent: structuredClone(inp.intent) } : out;
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
  decisionEpoch: number,
): Promise<{ events: EngineEvent[]; input: DecisionInput }> {
  const subs = pending.batch!;
  // 批量子决策失败原因（seat → 失败原因）：2026-10-15 用户裁定——托管机制彻底抹消，
  // 任何阻碍对局流程完成的失败一律即停（不再有兜底发言/兜底动作），仅用于暂停消息的诊断
  const failReasons = new Map<number, string>();
  // 每个子待决各自的决策点总预算（思考型模型自动放宽下限）：
  // 单点失败带错误原因重试一次，仍失败即暂停（托管已抹消）
  const askWithRetry = async (sub: PendingDecision): Promise<DecisionInput> => {
    const cfg = rt.seatAIs.find((s) => s.seat === sub.seat);
    if (!cfg) {
      throw new AiOutageError(
        `对局已自动暂停：${sub.seat}号座位缺少 AI 配置，决策无法进行。请为该座位补齐配置后点击「继续」恢复——当前进度不会丢失。`,
      );
    }
    const deadlineAt = Date.now() + decisionDeadlineMs(rt, cfg, sub.seat);
    let res = await askAiOnce(cfg, sub, null, rt, null, deadlineAt, gameId);
    if (!res.decision) res = await askAiOnce(cfg, sub, res.error, rt, null, deadlineAt, gameId);
    if (!res.decision) {
      // 额度耗尽：同池换人无用（共享账户额度），立即暂停整局（抛出经 Promise.all 上传播）
      if (isQuotaErrorText(res.error)) {
        throw new AiQuotaExhaustedError(
          `AI 额度不足，对局已自动暂停：${sub.seat}号座位的 ${cfg.model} 账户余额/token 已耗尽。请先给该账户充值（或更换该座位的 AI 配置），然后点击「继续」恢复对局——当前进度不会丢失。`,
        );
      }
      // 预算耗尽：该模型此刻实质无响应——立即暂停等用户处置（20261014001 实锤）
      if (isBudgetErrorText(res.error)) {
        throw new AiOutageError(
          `AI 服务连续无响应，对局已自动暂停：${sub.seat}号座位的 ${cfg.model} 在决策预算内多次调用均超时落空（网络波动或服务端拥塞）。请检查网络与该模型服务状态，然后点击「继续」恢复对局——当前进度不会丢失。`,
        );
      }
      // 托管抹消（2026-10-15 用户裁定）：任何调用层失败一律即停，不再兜底替 AI 发言
      throw new AiOutageError(
        `AI 服务连续无响应，对局已自动暂停：${sub.seat}号座位的 ${cfg.model} 两次调用均未成功（${(res.error ?? "AI 调用失败").slice(0, 80)}）。请检查网络与该模型服务状态，然后点击「继续」恢复对局——当前进度不会丢失，该座位的决策将重新提问。`,
      );
    }
    // 输出非法（清洗兜底已抹消）：AI 产出了但不合法——同样属阻碍流程，即停并附原始输出截断
    const sanitized = sanitizeBatchInput(sub, res.decision);
    if (
      typeof sanitized.thought === "string" &&
      sanitized.thought.startsWith("[AI输出非法")
    ) {
      throw new AiOutageError(
        `AI 连续输出非法，对局已自动暂停：${sub.seat}号座位的 ${cfg.model} 输出的内容无法通过规则校验（原始输出：${JSON.stringify(res.decision).replace(/\s+/g, " ").slice(0, 120)}）。请检查该模型状态或更换其配置，然后点击「继续」恢复对局——当前进度不会丢失，该座位的决策将重新提问。`,
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
  // 批量决策也要响应立即暂停；后台 AI 请求可自然结束，但其结果不得越过暂停代次。
  const pause = pauseSignal(rt);
  await Promise.race([
    Promise.all(Array.from({ length: Math.min(AI_BATCH_CONCURRENCY, subs.length) }, () => worker())),
    pause.promise,
  ]);
  pause.cancel();
  // 批量熔断：整批全员落空且至少一个是调用层故障 → 计一次连续失效；有任何人成功 → 清零
  if (failReasons.size >= subs.length && subs.length > 0) {
    const hasOutage = [...failReasons.values()].some((r) => isOutageErrorText(r));
    if (hasOutage) trackOutageOrThrow(rt, "批量全灭：调用失败");
    else rt.aiOutageStreak = 0;
  } else if (failReasons.size < subs.length) {
    rt.aiOutageStreak = 0;
  }
  // 竞速期间被暂停：丢弃本批结果，挂起保留 pending，恢复后重新整批权衡。
  // 即使已经立即继续，只要代次不同，旧批次同样不得消费。
  if (rt.status !== "running" || rt.decisionEpoch !== decisionEpoch) {
    rt.suspendDraft = { thought: null, error: null };
    throw new SuspendDecision();
  }
  // 白日拍刀：分析师 AI 按真实轮次、完整进程、规则与技能存量推演。
  // 审核不可用立即暂停，保留当前待决，绝不继续推进或借故障结算。
  const declareIdx = inputs.findIndex((inp) => inp.declareVictory === true);
  if (declareIdx >= 0) {
    const audit = await auditDeclareVictory(gameId, rt);
    if (audit.outcome === "unavailable") {
      throw new AiOutageError(`拍刀审核分析师无响应，对局已自动暂停：${audit.reason}。请检查分析师配置后点击「继续」——当前拍刀待决不会丢失，恢复后将重新按轮次与规则审核。`);
    }
    if (audit.outcome === "reject") {
      const seat = subs[declareIdx]!.seat;
      return settleDeclareAuditFail(gameId, rt, seat, audit.reason);
    }
  }
  const combined: DecisionInput = { thought: "", batchInputs: inputs };
  try {
    const events = rt.engine.decide(combined);
    // 批量故障透出（仅诊断辅助）：无失败时为空集，不附加任何信息
    if (failReasons.size > 0) {
      const reason = [...failReasons.entries()]
        .map(([seat, r]) => `${seat}号：${r}`)
        .join("；")
        .slice(0, 300);
      for (const ev of events) ev.meta = { ...(ev.meta ?? {}), fallbackReason: reason };
    }
    return { events, input: combined };
  } catch (err) {
    // 引擎拒绝经清洗的批量决策：对局流程受阻——即停（托管抹消后不再有兜底批次）
    throw new AiOutageError(
      `AI 输出未通过引擎校验，对局已自动暂停：${errMessage(err).slice(0, 160)}。请检查对局状态后点击「继续」恢复——当前进度不会丢失，本批决策将重新提问。`,
    );
  }
}

/** 白日交刀宣布胜利审核：只读取引擎的存活与技能存量，使用保守确定性规则。
 * 胜率模型只供观察，不参与胜负裁决；相同引擎状态必得相同审核结果。 */
export async function auditDeclareVictory(gameId: string, rt: GameRuntime) {
  return runVictoryAiAudit({ gameId, rt });
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
  reason: string,
): { events: EngineEvent[]; input: DecisionInput } {
  const snap = rt.engine.getSnapshot();
  const analysis = `分析师 AI 按轮次与规则推演后认为仍存在反制路径（${reason}），不能确认狼人必胜`;
  const auditEvent: EngineEvent = {
    day: snap.day,
    phase: snap.phase,
    type: "system",
    actor: null,
    title: "宣布胜利未通过审核",
    content: `${seat}号代表狼队宣布提前胜利——${analysis}，宣布无效！神民阵营获胜。`,
    thought: null,
    meta: { auditReject: true, auditReason: reason },
  };
  // 引擎外部结算：落定胜者 + 结果事件（含存活表，与自然终局同格式；缘由注记写入结果文案）；
  // 公开广播行携带完整裁决缘由——玩家公开记录必须知道「狼队拍了刀但被驳回」，
  // 否则赛后讨论对胜负逆转毫不知情（对局 20261009001 实锤：全员零提及）
  const engineEvents = rt.engine.settleExternal(
    "good",
    "（白日交刀宣布胜利未通过审核）",
    `【审核】${seat}号代表狼队宣布提前胜利——${analysis}，宣布无效！神民阵营获胜。`,
  );
  return {
    events: [auditEvent, ...engineEvents],
    // 决策日志记 auditSettle（重放时直接调 settleExternal 精确重建，不进 advance/decide 校验）
    input: {
      thought: "",
      auditSettle: "good",
      auditNote: "（白日交刀宣布胜利未通过审核）",
      auditPub: `【审核】${seat}号代表狼队宣布提前胜利——${analysis}，宣布无效！神民阵营获胜。`,
    },
  };
}

// 返回引擎事件 + 实际被引擎采纳的决策输入（供决策日志落盘，断点重放恢复的原料）
async function decideWithAi(
  rt: GameRuntime,
  pending: PendingDecision,
  gameId: string,
  decisionEpoch: number,
): Promise<{ events: EngineEvent[]; input: DecisionInput }> {
  // 并行权衡批次：走并发专线，不进入单人串行流程
  if (pending.batch && pending.batch.length > 1) return decideBatchWithAi(rt, pending, gameId, decisionEpoch);
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
  // 托管抹消（2026-10-15 用户裁定）：AI 输出经修正仍被引擎拒绝 = 对局流程受阻——
  // 即停并附校验原因，不再有兜底决策替 AI 完成动作（settleByFallback 已删）
  const settleByFallback = (note: string): { events: EngineEvent[]; input: DecisionInput } => {
    void note;
    throw new AiOutageError(
      `AI 连续输出非法，对局已自动暂停：${pending.seat}号座位的 ${cfg?.model ?? "未知模型"} 输出未通过规则校验（${(validationError ?? "输出非法").slice(0, 120)}）。请检查该模型状态或更换其配置，然后点击「继续」恢复对局——当前进度不会丢失，该座位的决策将重新提问。`,
    );
  };

  if (cfg) {
    // 决策点总预算：两次尝试共享同一截止线（AI 故障时最长静默预算，超时即托管；
    // 思考模式提供方自动放宽下限——过紧预算只会批量超时转托管；人格双程管线翻倍）
    const deadlineAt = Date.now() + decisionDeadlineMs(rt, cfg, pending.seat);
    for (let attempt = 0; attempt < 2; attempt++) {
      // 已暂停或控制代次已变：挂起而非接管——保留 pending 与已完成思考量，待恢复后重新思考。
      // 代次检查可识别「暂停后立即继续」，防止旧 tick 在新一轮运行中消费旧结果。
      if (rt.status !== "running" || rt.decisionEpoch !== decisionEpoch) {
        rt.suspendDraft = { thought: lastFailedThought, error: validationError };
        throw new SuspendDecision();
      }
      if (Date.now() >= deadlineAt) {
        lastAiError = "AI响应总预算耗尽，转入托管";
        break;
      }
      const sig = pauseSignal(rt);
      const res = await Promise.race([
        askAiOnce(cfg, pending, validationError, rt, resumeNote, deadlineAt, gameId),
        sig.promise,
      ]);
      sig.cancel();
      // 暂停先到（或竞速期间被暂停）：丢弃本次 AI 结果，保存未完成思考量后挂起停链
      if (rt.status !== "running" || rt.decisionEpoch !== decisionEpoch) {
        rt.suspendDraft = { thought: lastFailedThought, error: validationError };
        throw new SuspendDecision();
      }
      if (res === null) break; // 暂停信号竞速胜出（防御路径；正常已被上面 status 检查拦截）
      const { decision, error } = res;
      if (!decision) {
        // 额度耗尽：重试/托管只会批量产出垃圾发言——立即暂停对局并告知用户（20261011001 实锤）
        if (isQuotaErrorText(error)) {
          throw new AiQuotaExhaustedError(
            `AI 额度不足，对局已自动暂停：${pending.seat}号座位的 ${cfg.model} 账户余额/token 已耗尽。请先给该账户充值（或更换该座位的 AI 配置），然后点击「继续」恢复对局——当前进度不会丢失。`,
          );
        }
        // 预算耗尽：该模型此刻实质无响应——立即暂停等用户处置（20261014001 第5天 10号发言托管实锤：
        // 单点预算耗尽硬塞「没什么头绪」兜底发言，直接污染人格对局的研究价值）
        if (isBudgetErrorText(error)) {
          throw new AiOutageError(
            `AI 服务连续无响应，对局已自动暂停：${pending.seat}号座位的 ${cfg.model} 在决策预算内多次调用均超时落空（网络波动或服务端拥塞）。请检查网络与该模型服务状态，然后点击「继续」恢复对局——当前进度不会丢失。`,
          );
        }
        trackOutageOrThrow(rt, error); // 调用层故障计入熔断（超限价即暂停）
        lastAiError = error;
        break; // AI 无响应/输出损坏：直接启发式兜底
      }
      // 意图保留式修正后再交引擎校验（修正说明写入事件 meta.repaired，可观测）
      const repaired = repairDecision(pending, decision);
      try {
        rt.aiOutageStreak = 0; // 成功决策：熔断计数清零
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

  // 预算耗尽（含循环前预检直接 break 的路径）：该模型此刻实质无响应，单点即暂停不托管
  if (isBudgetErrorText(lastAiError)) {
    throw new AiOutageError(
      `AI 服务连续无响应，对局已自动暂停：${pending.seat}号座位的 ${cfg?.model ?? "未知模型"} 在决策预算内多次调用均超时落空（网络波动或服务端拥塞）。请检查网络与该模型服务状态，然后点击「继续」恢复对局——当前进度不会丢失。`,
    );
  }

  // 赛后讨论发言的调用层故障（超时/断网/拥塞类实质无响应）：暂停等用户处置，
  // 绝不托管吞掉人格的赛后之声（2026-10-15 实锤：3号赛后第二轮被托管成 skip，人格失声）；
  // 输出非法/解析失败属模型行为，仍走兜底弃权（模型产出了但格式坏，不构成服务中断）
  if (pending.kind === "postgameSpeak" && isOutageErrorText(lastAiError)) {
    throw new AiOutageError(
      `AI 服务连续无响应，对局已自动暂停：${pending.seat}号座位的赛后讨论发言多次调用均无回应（网络波动或服务端拥塞）。请检查网络与该模型服务状态，然后点击「继续」恢复——当前进度不会丢失，TA 的发言机会原样保留。`,
    );
  }

  // 循环耗尽仍无合法决策（托管抹消，2026-10-15 用户裁定）：
  // 调用层故障 → 「连续无响应」暂停；输出非法（修正后仍被引擎拒绝）→ 「连续输出非法」暂停；
  // 不再有任何兜底发言/兜底动作——阻碍对局流程完成的情况一律即停
  if (validationError) return settleByFallback("[AI输出非法，系统托管]");
  throw new AiOutageError(
    `AI 服务连续无响应，对局已自动暂停：${pending.seat}号座位的 ${cfg?.model ?? "未知模型"} 多次调用均未成功（${(lastAiError ?? "AI 调用失败").slice(0, 80)}）。请检查网络与该模型服务状态，然后点击「继续」恢复对局——当前进度不会丢失，该座位的决策将重新提问。`,
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

/** 用已落盘事件流重建 AI 可见的公开记录（带真实对局编号 #seq）——
 * 2026-10-15 实锤：引擎 pub() 的公开记录是「行号」（第136条），而公屏对局记录用的是
 * 事件序号（[358]）——玩家引用「第136条」时观察者根本无从定位。重建后与公屏严格同源同号。
 * 公开性过滤与引擎 pub() 同口径：狼频道/权衡思考不进公开记录；夜间行动细节不公开。 */
function publicLogFromEvents(events: GameEvent[]): string[] {
  const out: string[] = [];
  for (const e of events) {
    const ch = e.meta?.channel;
    if (ch === "wolf" || ch === "skillThink") continue; // 狼队私密/技能权衡：不进公开记录
    if (e.phase.startsWith("night.") && e.type === "action") continue; // 夜间行动细节不公开
    out.push(`[#${e.seq}] ${e.actorLabel ?? "系统"}《${e.title}》${e.content}`);
  }
  return out;
}

/** 带真实对局编号（#seq）的公开记录缓存：rt.seq 为已落盘最大事件序号——
 * 新事件落盘后 rt.seq 自增即失效重建；DB 抖动返回 null（保持引擎 pub 口径，绝不阻断决策） */
async function seqPublicLog(gameId: string, rt: GameRuntime): Promise<string[] | null> {
  try {
    if (rt.pubLogCache && rt.pubLogCache.maxSeq === rt.seq) return rt.pubLogCache.lines;
    const events = await getAllEvents(gameId);
    const lines = publicLogFromEvents(events);
    rt.pubLogCache = { maxSeq: rt.seq, lines, events };
    return lines;
  } catch {
    return null;
  }
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

/** 赛前学习（对局历史 + 经验指南 + 图书馆，可独立或组合）：全部座位同时并发学习。
 * 每个来源独立取数与容错；研读心得和历史参考均可单独成稿，也可合并。
 * 全部选中来源为空时直接完成，不发起无意义 AI 调用。笔记落 game_studies。 */
async function runStudyPhase(gameId: string, rt: GameRuntime): Promise<void> {
  if (!rt.studyNotes) rt.studyNotes = new Map();
  if (!rt.studyDoneSeats) rt.studyDoneSeats = new Set();
  const sources = studySourcesOf(rt.options);
  const docs = sources.library ? await getAllLibraryContents(rt.userId ?? "") : [];
  const guideText = sources.guide ? rt.guideTextSnapshot : "";
  const board = BOARDS.find((b) => b.id === rt.boardId);
  const boardName = board?.name ?? rt.boardId;
  const perCallMs = Math.max(5, rt.options.libraryMaxSec ?? 120) * 1000;
  const seats = rt.seatAIs.map((s) => s.seat);
  const roleOf = (seat: number) => {
    const r = rt.engine.getSnapshot().players.find((p) => p.seat === seat)?.role;
    return r ? (ROLE_META[r]?.name ?? r) : "";
  };
  if (!rt.studyInFlight) rt.studyInFlight = new Set();

  // 章节线索预切分（确定性，全座位共享；未选图书馆时为空，不影响其他来源）
  const SMALL_DOC = 3_000; // 小文档直接通读，不做章节选读
  const chaptered = docs.map((d) => ({ ...d, chapters: splitDocChapters(d.content) }));

  // 历史对局候选（全座位共享一次性查询）：已分胜负的已结束对局，最新 20 局；未选择则不查询
  let historyRows: Awaited<ReturnType<typeof listGames>> = [];
  if (sources.history) {
    try {
      historyRows = (await listGames(rt.userId ?? ""))
        .filter((r) => r.id !== gameId && r.status === "finished" && r.winner != null)
        .slice(0, 20);
    } catch {
      /* 历史候选查询失败：只跳过历史参考段 */
    }
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
          const chosenIds = hres.ok && hres.text
            ? candidates.filter((c) => hres.text!.includes(c.id8)).map((c) => c.id8)
            : [];
          // 没有作出有效选择时允许不读，不由系统代选最近对局。
          // 两局摘要并行（相互独立）；暂停/终止即各自中断
          const summaries = await Promise.all(
            chosenIds.slice(0, 2).map(async (id8) => {
              if (rt.status !== "created") return null;
              const row = historyRows.find((r) => r.id.startsWith(id8));
              if (!row) return null;
              const events = await getAllEvents(row.id);
              if (events.length === 0) return null;
              const snap = snapshotFromRow(row.id, row, events[events.length - 1].seq, deathSeatsFromEvents(events));
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
      let chosen = chaptered.length > 2 ? [] : chaptered;
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
          const use = titles ? d.chapters.filter((c) => titles.has(c.title)) : [];
          for (const c of use) {
            parts.push(`《${d.name}》${c.title}\n${c.text}`);
          }
        }
        chapterText = parts.join("\n\n");
      }
      let reading = sources.library
        ? [smallText, chapterText].filter((t) => t.trim()).join("\n\n")
        : "";
      if (guideText.trim()) {
        reading = [reading, `【经验指南】\n${guideText.trim()}`].filter((t) => t.trim()).join("\n\n");
      }
      reading = reading.slice(0, 15_000);

      // ---- 阶段三：撰写精简实战心得（重试直至学成；无研读材料时跳过）----
      const { system, user } = buildStudyPrompt(seat, boardName, reading, roleName, rt.options.libraryMaxSec);
      let noteText = "";
      // 重试直至学成（保证全员学习完毕才开赛）：最多 8 次（约覆盖小时级瞬时故障）；
      // 持续不可用（如密钥失效）时该座位按未学习开赛，避免对局永远无法开始；
      // 暂停/终止（status 离开 created）即中断
      for (let attempt = 0; reading.trim() && attempt < 8; attempt++) {
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

      // ---- 合并成稿：研读心得与历史参考均可独立成立，整体 ≤1400 字符 ----
      const sections: string[] = [];
      if (noteText) sections.push(noteText);
      if (refs.length > 0) {
        sections.push(`【历史对局参考】\n${refs.map((r) => `- ${r}`).join("\n")}`);
      }
      const finalNote = sections.join("\n\n").slice(0, 1_400);
      if (finalNote) {
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

// ---------- 犯规裁判已迁入法官模块（judge/foulReferee.ts） ----------
// 版图拆分第一批（2026-10-10）：法官=流程秩序唯一写者；书记员（runtime/）隐而不现；
// 判罚落定经 JudgeRecorder 窄接口回调本文件的 persist/markDecided/finishIfDone/scheduleTick。

/** 分出胜负即落库 + 触发自动分析（赛后讨论期间 status 仍 running，但报告已可生成） */
async function markDecidedIfNeeded(gameId: string, rt: GameRuntime): Promise<void> {
  if (rt.decidedPersisted) {
    const snap = rt.engine.getSnapshot();
    if (snap.winner) triggerAutoAnalysis(gameId, rt, snap);
    return;
  }
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
  rt.timing = finishTiming(rt.timing, Date.now());
  rt.status = "finished";
  rt.pending = null;
  if (rt.timer) {
    clearTimeout(rt.timer);
    rt.timer = null;
  }
  // 超时保护：挂起时抛错 → runTick 捕获走 handleTickError
  await withTimeout(
    persistGameTiming(gameId, rt.timing, {
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
  // 由 startPsyCheck 启动（可续跑）——不再终局自动触发（被动中断难以补齐，见对局 20261009001）；
  // 开了「自动心理检查」的赛后讨论对局：赛后讨论在引擎收尾处结束，此处（终局落库点）自动开始
  maybeAutoPsyCheck(gameId, rt.options, "postgameEnd");
  return true;
}

async function handleTickError(gameId: string, rt: GameRuntime, err: unknown): Promise<void> {
  const quotaExhausted = err instanceof AiQuotaExhaustedError;
  const outage = err instanceof AiOutageError;
  const message = err instanceof Error ? err.message : String(err);
  // 额度耗尽/服务中断：暂停原因透出到「继续」按钮旁（用户需要知道为什么停、怎么办）
  rt.pauseReason = quotaExhausted || outage ? message : null;
  rt.timing = pauseTiming(rt.timing, Date.now());
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
          title: quotaExhausted ? "AI 额度耗尽" : outage ? "AI 服务中断" : "系统错误",
          content: quotaExhausted ? message.slice(0, 500) : `对局循环异常，已自动暂停：${message.slice(0, 500)}`,
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
      persistGameTiming(gameId, rt.timing, { status: "paused" }),
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
  const decisionEpoch = rt.decisionEpoch;
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
      const reviewGate = rt.options.postGameReviewFirst === true &&
        !(await postGameReviewReady(gameId, await requireOwnedGame(gameId, rt.userId ?? undefined)));
      if (pending.kind === "postgameSpeak" && !rt.postgameAutoHeld && (!rt.options.postGameAutoStart || reviewGate)) {
        rt.postgameAutoHeld = true;
        rt.pending = pending;
        rt.timing = pauseTiming(rt.timing, Date.now());
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
                content: reviewGate
                  ? "赛后讨论待开始：等待复盘报告生成并写入玩家认知库，无需打开或查看报告。"
                  : "赛后讨论待开始：对局已分出胜负。点击页面顶部「开启赛后讨论」按钮，即可开始生成赛后讨论。",
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
            persistGameTiming(gameId, rt.timing, { status: "paused" }),
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
        const { events: decideEvents, input } = await decideWithAi(rt, pending, gameId, decisionEpoch);
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
    // 暂停挂起时若用户已立即继续，旧 tick 退出必须补上下一次调度；
    // 否则会出现 status=running 但没有 timer、没有后续 AI 调用的「假运行」。
    if (rt.status === "running" && !rt.timer) scheduleTick(gameId, rt, 0);
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
  const personaGenderOf = (seat: number): string | null =>
    rt.personaCards?.get(seat)?.profile.gender ??
    personaGenderFromSetup(row.setup as StoredSetup, seat);
  // 显式标注 GameSnapshot：避免对象字面量属性拓宽（如 phaseBreaking 拓宽成 string）
  const result: GameSnapshot = {
    gameId,
    manualRoleAssignEnabled: rt.options.manualRoleAssignEnabled === true,
    pauseReason: rt.pauseReason ?? null,
    thoughtCollapsed: rt.options.thoughtCollapsed === true,
    boardId: row.boardId,
    boardName: row.boardName,
    titleNo: row.titleNo ?? "",
    status: rt.status,
    postGameReviewFirst: rt.options.postGameReviewFirst === true,
    postGameAutoStart: rt.options.postGameAutoStart === true,
    elapsedMs: elapsedAt(rt.timing, Date.now()),
    timerRunning: rt.status === "running" && rt.timing.runningSince != null,
    timingSyncedAt: Date.now(),
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
      personaGender: personaGenderOf(p.seat),
      personaImageData: rt.personaCards?.get(p.seat)?.imageData ?? null,
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

/** 历史只读快照的人格头像：开局快照优先，旧对局才回退研究站现卡。 */
async function personaImagesOf(row: GameRow): Promise<Map<number, string | null> | undefined> {
  const setup = row.setup as StoredSetup;
  const binds = setup.seatPersonas ?? [];
  if (binds.length === 0) return undefined;
  try {
    const cards = await getPersonaCardsInternal(binds.map((bind) => bind.personaId));
    return new Map(binds.map((bind) => [
      bind.seat,
      setup.personaSnapshots?.[String(bind.seat)]?.card.imageData ??
        cards.find((card) => card.id === bind.personaId)?.imageData ?? null,
    ]));
  } catch {
    return undefined;
  }
}

function snapshotFromRow(gameId: string, row: GameRow, seq: number, deadSeats?: Set<number>, events?: GameEvent[], personaImages?: Map<number, string | null>): GameSnapshot {
  const setup = row.setup as StoredSetup;
  const finished = row.status === "finished";
  const dead = deadSeats ?? new Set<number>();
  const deathInfo = deathInfoBySeatFromEvents(events ?? []);
  let sheriffSeat: number | null = null;
  let eventDay: number | null = null;
  for (const event of events ?? []) {
    eventDay = Math.max(eventDay ?? 0, event.day);
    for (const seat of deathSeatsFromEvent(event)) dead.add(seat);
    if (event.title === "警长落地") {
      sheriffSeat = Number(/(\d+)号玩家当选警长/.exec(event.content)?.[1] ?? 0) || null;
    } else if (event.title === "警徽移交") {
      sheriffSeat = Number(/移交给(\d+)号玩家/.exec(event.content)?.[1] ?? 0) || null;
    } else if (event.title === "警长定序" && event.actor != null) {
      sheriffSeat = event.actor;
    } else if (event.title === "警徽流失") {
      sheriffSeat = null;
    }
  }
  const finalSurvivors = finalSurvivorsFromEvents(events ?? []);
  if (finalSurvivors) {
    for (let seat = 1; seat <= (setup.seatRoles?.length ?? 0); seat++) {
      if (!finalSurvivors.has(seat)) dead.add(seat);
    }
  }
  const createdMs = row.createdAt instanceof Date ? row.createdAt.getTime() : Date.parse(String(row.createdAt));
  const updatedMs = row.updatedAt instanceof Date ? row.updatedAt.getTime() : Date.parse(String(row.updatedAt));
  const rowTiming = setup.timing ?? {
    ...initialGameTiming(),
    startedAt: createdMs,
    accumulatedMs: Math.max(0, updatedMs - createdMs),
    endedAt: finished ? updatedMs : null,
    savedAt: updatedMs,
  };
  return {
    gameId,
    manualRoleAssignEnabled: setup.options?.manualRoleAssignEnabled === true,
    boardId: row.boardId,
    boardName: row.boardName,
    titleNo: row.titleNo ?? "",
    status: row.status as GameStatus,
    postGameReviewFirst: setup.options?.postGameReviewFirst === true,
    postGameAutoStart: setup.options?.postGameAutoStart === true,
    elapsedMs: elapsedAt(rowTiming, row.status === "running" ? Date.now() : updatedMs),
    timerRunning: row.status === "running" && rowTiming.runningSince != null,
    timingSyncedAt: Date.now(),
    // 只读历史以事件日为准；尚未开始且零事件的对局不应虚标为第1天。
    day: eventDay ?? (row.status === "created" ? 0 : row.dayCount),
    phase: finished ? "finished" : "interrupted",
    phaseLabel: finished ? "对局已结束" : "对局已中断（服务重启后仅可查看事件流）",
    players: (setup.seatRoles ?? []).map((role, i) => ({
      seat: i + 1,
      role,
      roleName: ROLE_META[role]?.name ?? String(role),
      camp: ROLE_META[role]?.camp ?? "villager",
      alive: !dead.has(i + 1),
      sheriff: sheriffSeat === i + 1,
      deathInfo: deathInfo.get(i + 1) ?? (finalSurvivors && !finalSurvivors.has(i + 1) ? '出局' : null),
      aiModel: setup.seatModels?.[i] ?? "",
      personaName: (setup.seatPersonas ?? []).find((s) => s.seat === i + 1)?.name ?? null,
      personaGender: personaGenderFromSetup(setup, i + 1),
      personaImageData: personaImages?.get(i + 1) ?? null,
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
  assertStudyOptions(input.options);
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

  // 非手动模式随机洗牌；手动模式先按版型原顺序占位，开始时以用户分配结果重建引擎。
  const seatRoles = input.options.manualRoleAssignEnabled ? [...board.roles] : shuffle([...board.roles]);
  const engine = createEngine({ boardId: board.id, seatRoles, options: input.options });

  // 人格研究站：座位人格绑定校验与加载（卡必须属于当前用户；绑定座位走心镜→涌现管线）
  let personaInfos: PersonaSeatInfo[] | undefined;
  let personaCards: Map<number, PersonaCard> | undefined;
  let personaMemory: Map<number, MemoryPool> | undefined;
  let personaSnapshots: Map<number, PersonaSnapshot<MemoryPool>> | undefined;
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
    personaSnapshots = new Map();
    for (const b of input.seatPersonas) {
      const card = await getPersona(b.personaId, userId ?? "");
      if (!card) {
        throw new Error(`座位 ${b.seat} 绑定的人格卡不存在或不属于当前用户（id=${b.personaId}）`);
      }
      const memory = await loadMemoryPool(card.id);
      const snapshot = createPersonaSnapshot(card, memory);
      personaCards.set(b.seat, snapshot.card);
      personaMemory.set(b.seat, snapshot.memory);
      personaSnapshots.set(b.seat, snapshot);
      personaInfos.push({ seat: b.seat, personaId: b.personaId, name: card.name });
    }
  }

  const guideTextSnapshot = studySourcesOf(input.options).guide
    ? await getCachedGuideText(userId ?? null, board.id).catch(() => "")
    : "";

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
      guideTextSnapshot,
      timing: initialGameTiming(),
      seatAIsEnc: encryptSecret(JSON.stringify(seats)),
      // 胜率推测开关随 setup 落库：服务重启/恢复后功能仍在
      winRateEnabled: input.winRateEnabled === true,
      analystAutoGenerate: input.analystAi ? input.analystAi.autoGenerate !== false : false,
      ...(input.analystAi ? { analystAiEnc: encryptSecret(JSON.stringify(input.analystAi)) } : {}),
      // 人格绑定与开局内容快照：恢复不得被研究站后续修改覆盖
      ...(personaInfos ? { seatPersonas: personaInfos } : {}),
      ...(personaSnapshots ? { personaSnapshots: Object.fromEntries(personaSnapshots) } : {}),
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
    timing: initialGameTiming(),
    seq: 0,
    timer: null,
    pending: null,
    options: input.options,
    guideTextSnapshot,
    manualRolesAssigned: false,
    ticking: false,
    lastTickAt: Date.now(),
    noProgressTicks: 0,
    pauseWaiters: [],
    decisionEpoch: 0,
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
    // 人格研究站：绑定人格的座位（心镜→涌现管线 + 记事簿注入 + 涌现注解暂存）
    personaCards,
    personaMemory,
    personaSnapshots,
    personaEventMeta: personaCards ? new Map() : undefined,
    seatPersonas: personaInfos,
  });
  return { gameId };
}

async function control(gameId: string, action: "start" | "pause" | "terminate" | "stopPostGame", userId?: string, seatRoles?: RoleId[]): Promise<{ ok: boolean }> {
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
    rt.decisionEpoch += 1;
    if (rt.timer) {
      clearTimeout(rt.timer);
      rt.timer = null;
    }
    rt.timing = finishTiming(rt.timing, Date.now());
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
        persistGameTiming(gameId, rt.timing, { status: "finished", dayCount: snap.day }),
        DB_TIMEOUT_MS,
        "赛后终止状态落库超时",
      );
    } catch {
      /* 内存已 finished，DB 抖动不阻塞 */
    }
    // 「自动心理检查」的赛后讨论对局：赛后讨论被手动终止同样视为赛后结束，自动开始心理检查
    maybeAutoPsyCheck(gameId, rt.options, "postgameEnd");
    return { ok: true };
  }

  // 终止：随时结束对局（不可逆，用于随时收掉测试局开新局）。
  // 内存即时收敛（停 tick 链、唤醒在飞决策走挂起停链——status 已 finished 不会再重想）、
  // 事件流留「对局终止」标记，DB 置 finished（winner 保持 null=未分胜负，dayCount 记终止时天数）。
  // 不触发分析师自动复盘（非完整对局，避免浪费 API）；需要分析可在前端手动生成。
  // 已 finished 幂等返回 ok；rt 不在内存（服务重启后）只落库，终止后仍可经断点重放复盘到终止瞬间。
  if (action === "terminate") {
    if (rt && rt.status !== "finished") {
      rt.decisionEpoch += 1;
      if (rt.timer) {
        clearTimeout(rt.timer);
        rt.timer = null;
      }
      rt.timing = finishTiming(rt.timing, Date.now());
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
        const timing = rt?.timing ?? finishTiming((row.setup as StoredSetup).timing ?? initialGameTiming(), Date.now());
        await withTimeout(
          persistGameTiming(gameId, timing, { status: "finished", dayCount }),
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
    rt.pauseReason = null; // 恢复即清空暂停原因（额度耗尽提示等）
    // 手动分配：首次提交时校验并重建引擎、持久化；赛前学习/暂停续跑只复用，
    // 不重复要求 seatRoles，也不重建引擎而丢掉挂起待决。
    const currentRt = rt;
    if (currentRt.decisionIdx === 0 && (currentRt.status === "created" || currentRt.status === "paused") && currentRt.options.manualRoleAssignEnabled) {
      const board = BOARDS.find((b) => b.id === currentRt.boardId);
      if (!board) return { ok: false };
      if (seatRoles) {
        assertBoardSeatRoles(board, seatRoles);
        currentRt.engine = createEngine({ boardId: board.id, seatRoles, options: currentRt.options });
        const row = await withTimeout(getGame(gameId), DB_TIMEOUT_MS, "读取对局超时");
        if (!row) return { ok: false };
        await withTimeout(
          updateGame(gameId, {
            setup: { ...(row.setup as StoredSetup), seatRoles, manualRolesAssigned: true },
          }),
          DB_TIMEOUT_MS,
          "保存角色分配超时",
        );
        currentRt.manualRolesAssigned = true;
        rt.pending = null;
        rt.acts = null;
        rt.displayPhase = null;
      } else if (!currentRt.manualRolesAssigned) {
        assertBoardSeatRoles(board, []);
      }
    }
    rt.timing = startTiming(rt.timing, Date.now());
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
      try {
        await withTimeout(persistGameTiming(gameId, rt.timing), DB_TIMEOUT_MS, "保存计时状态超时");
      } catch { /* 内存计时继续，下一保存点补齐 */ }
      return { ok: true };
    }
    rt.status = "running";
    // DB 抖动不阻塞启动（内存是活对局的权威状态；失败仅影响重启后可见性）
    try {
      await withTimeout(persistGameTiming(gameId, rt.timing, { status: "running" }), DB_TIMEOUT_MS, "更新对局状态超时");
    } catch { /* 内存已 running，继续 */ }
    // 若上一个 tick 仍在飞（如 pause 后立刻 start），让它自己链式调度
    if (!rt.ticking) scheduleTick(gameId, rt, 0);
    maybeWinRateTick(gameId, rt); // 启动即评估一次初始胜率（非阻塞）
    startWinRateLoop(gameId, rt); // 胜率预演循环：利用交互空隙持续预演，事件落地秒出结果
    return { ok: true };
  }

  // pause：先收敛内存状态（即时生效），DB 只做尽力而为的持久化
  if (rt) {
    rt.decisionEpoch += 1;
    rt.timing = pauseTiming(rt.timing, Date.now());
    if (rt.status === "running" || rt.status === "created") {
      rt.status = "paused";
    }
    // 手动暂停不带原因文本（2026-10-15 用户裁定：原因提示只属于额度耗尽/服务中断等异常暂停，
    // 手动暂停时按钮旁与横幅一律不显示——此前旧额度事件经事件流兜底反复诈尸）
    rt.pauseReason = null;
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
      const timing = rt?.timing ?? pauseTiming((row.setup as StoredSetup).timing ?? initialGameTiming(), Date.now());
      await withTimeout(persistGameTiming(gameId, timing, { status: "paused" }), DB_TIMEOUT_MS, "更新对局状态超时");
    }
  } catch {
    // DB 失败不影响暂停本身：内存已 paused，tick 链已停；返回成功避免前端误报「操作失败」
  }
  return { ok: true };
}

/** 报告与认知指南全部就绪后的自动续跑入口；手动模式只解除开始条件。 */
async function resumePostGameAfterReview(gameId: string): Promise<void> {
  const row = await getGame(gameId);
  if (!row || row.status !== "paused" || row.winner == null) return;
  const options = (row.setup as StoredSetup).options;
  if (options.postGameReviewFirst !== true || options.postGameAutoStart !== true) return;
  const result = await startPostGame(gameId, row.userId);
  if (!result.started) {
    console.warn(`[postgame] 对局 ${gameId} 复盘就绪后自动续跑未启动：${result.reason ?? "未知原因"}`);
  }
}

async function startPostGame(
  gameId: string,
  userId?: string,
): Promise<{ started: boolean; reason?: string }> {
  const row = await requireOwnedGame(gameId, userId);
  const setup = row.setup as StoredSetup;
  if (setup.options.postGameReviewFirst === true && !(await postGameReviewReady(gameId, row))) {
    return { started: false, reason: "复盘报告尚未生成完成并写入玩家认知库，暂不能开始赛后讨论；无需查看报告" };
  }

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
    rt.timing = startTiming(rt.timing, Date.now());
    rt.status = "running";
    try {
      await withTimeout(persistGameTiming(gameId, rt.timing, { status: "running" }), DB_TIMEOUT_MS, "状态落库超时");
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
  const replaySetup = (row.setup ?? null) as StoredSetup | null;
  if (!replaySetup || !seatAIsOfSetup(replaySetup) || !replaySetup.seatRoles?.length) {
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
  rt.timing = startTiming({ ...rt.timing, endedAt: null }, Date.now());
  rt.status = "running";
  rt.postgameAutoHeld = true; // 用户显式点击开启：不再触发挂起拦截
  rt.decidedPersisted = true; // winner 已落库，杜绝重复触发分析
  await withTimeout(persistGameTiming(gameId, rt.timing, { status: "running" }), DB_TIMEOUT_MS, "状态落库超时");
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
  enabled: boolean,
  afterWinRateId: number,
): Promise<PollResult["winRate"] | undefined> {
  if (!enabled) return undefined;
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
  // 续跑对局在运行时缺失时优先断点重放；已结束对局是只读历史，
  // 直接以最终事件组装快照，避免旧规则兼容问题在每次打开时反复触发。
  if (!rt && row.status !== "finished") {
    rt = null;
    try {
      rt = await recoverGame(gameId);
    } catch (recoverErr) {
      // 恢复失败可见性（重放分叉/原料异常不再静默降级）：控制台留一行诊断，对前端仍优雅降级
      console.warn(`[recover] 对局 ${gameId} 断点重放失败：`, recoverErr instanceof Error ? recoverErr.message : recoverErr);
      rt = null;
    }
    if (!rt && (row.status === "created" || row.status === "running")) {
      // 旧对局（setup 无 seatAIs 或日志分叉）：标记暂停（事件仍可看）
      await updateGame(gameId, { status: "paused" });
      row = { ...row, status: "paused" };
    }
  }

  // 运行中每 5 秒落一个计时保存点：崩溃恢复只累计到最后保存点，不把停机时间算入对局。
  if (rt?.status === "running" && rt.timing.runningSince != null && Date.now() - rt.timing.savedAt >= 5_000) {
    rt.timing = { ...rt.timing, savedAt: Date.now() };
    try {
      await persistGameTiming(gameId, rt.timing);
    } catch {
      /* 下一保存点重试，不阻断对局轮询 */
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
    const winRate = await winRatePayload(gameId, rt.winRateEnabled, afterWinRateId ?? 0);
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
  const [allEvents, personaImages] = await Promise.all([getAllEvents(gameId), personaImagesOf(row)]);
  const snapshot = snapshotFromRow(gameId, row, seqHint, undefined, allEvents, personaImages);
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
  const winRate = await winRatePayload(gameId, (row.setup as StoredSetup).winRateEnabled === true, afterWinRateId ?? 0);
  return {
    unchanged: false,
    tickKey,
    snapshot,
    events,
    ...(winRate ? { winRate } : {}),
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
  const [events, personaImages] = await Promise.all([getAllEvents(gameId), personaImagesOf(row)]);
  const snapshot = rt
    ? snapshotFromRuntime(gameId, row, rt)
    : snapshotFromRow(gameId, row, events.length > 0 ? events[events.length - 1].seq : 0, deathSeatsFromEvents(events), events, personaImages);
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

/** 人格研究站：本局人格座位的《心理检查报告》列表（归属校验后返回） */
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

