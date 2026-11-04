/**
 * 对局数据接口层 — tRPC 薄封装。
 *
 * 类型唯一事实源为 @contracts/game（前后端共享契约），本文件只做转发，
 * 不重复定义任何契约类型。通过 useGameApi() 获取命令式调用集合，
 * 内部复用 @/providers/trpc 的单例 client（trpc.useUtils().client）。
 */

import { useMemo } from 'react'
import type {
  AiProvider,
  AiTestInput,
  AiTestResult,
  AnalysisJobStage,
  AnalysisJobStatus,
  AnalysisReport,
  AnalystAiConfig,
  ApiPreset,
  ApiPresetInput,
  BoardDef,
  CreateGameInput,
  GameEvent,
  GameSnapshot,
  GameSummary,
  GuideInfo,
  GuideOverview,
  GuideVersionSummary,
  PollResult,
  RoleId,
} from '@contracts/game'
import { PROVIDER_PRESETS, ROLE_META } from '@contracts/game'
import type {
  CastJobStart,
  CastProgressState,
  CastTrace,
  PersonaCard,
  PersonaCardInput,
  PersonaCardSummary,
  PersonaDriftEntry,
  PersonaMemory,
  PersonaRelationship,
  PersonaRelationshipHistory,
  PersonaCognitionNote,
  PersonaReport,
  PersonaResearchResult,
  PersonaTrashEntry,
} from '@contracts/persona'
import { COGNITION_NOTE_ENABLED } from '@contracts/persona'
import { trpc } from '@/providers/trpc'
import type { RsqBatteryLevel, RsqItemsView, RsqSubmitPayload } from '@/lib/rsqClient'

// ---------------------------------------------------------------------------
// 契约类型 re-export（页面层统一从这里取，避免散落 import 路径）
// ---------------------------------------------------------------------------

/** 机制开关再导出：页面层统一从本模块取（见 @contracts/persona 注释） */
export { COGNITION_NOTE_ENABLED }

export type {
  AdvancedOptions,
  AiProvider,
  AiTestInput,
  AiTestResult,
  AnalysisJobStage,
  AnalysisJobStatus,
  AnalysisReport,
  AnalystAiConfig,
  ApiPreset,
  ApiPresetInput,
  BoardDef,
  Camp,
  CreateGameInput,
  EventType,
  GameEvent,
  GameSnapshot,
  GameStatus,
  GameSummary,
  GuideInfo,
  GuideOverview,
  GuideVersionSummary,
  PlayerSnapshot,
  PollResult,
  RoleId,
  SeatAiConfig,
  WinRateEntry,
} from '@contracts/game'

export { PROVIDER_PRESETS, ROLE_META } from '@contracts/game'

// RSQ 视图模型 re-export（报告/问卷统一从 gameApi 或 rsqClient 取）
export type {
  RsqBatteryLevel,
  RsqItemView,
  RsqItemsView,
  RsqSubmitPayload,
  RSQReportData,
} from '@/lib/rsqClient'

// 人格研究站契约 re-export（页面层统一从这里取）
export type {
  BigFiveParams,
  CastJobStart,
  CastProgressState,
  CasterCandidate,
  CognitiveBiasEntry,
  DefenseMechanismEntry,
  PersonaCard,
  PersonaCardInput,
  PersonaCardSummary,
  PersonaCastResult,
  PersonaDriftEntry,
  PersonaEventMeta,
  PersonaMemory,
  PersonaParams,
  PersonaProfile,
  PersonaRelationship,
  PersonaReport,
  PersonaResearchResult,
  PersonaSeatBinding,
  PersonaTrashEntry,
} from '@contracts/persona'
export {
  COGNITIVE_BIAS_CATALOG,
  DEFENSE_MECHANISM_CATALOG,
  attachmentLabel,
  defaultPersonaParams,
  emptyPersonaProfile,
} from '@contracts/persona'

/** 人格详情一屏数据（persona.detail 返回） */
export interface PersonaDetail {
  card: PersonaCard
  memories: PersonaMemory[]
  relationships: PersonaRelationship[]
  drift: PersonaDriftEntry[]
  relationshipHistory: PersonaRelationshipHistory[] // 人格锚点关系的逐局沿革（折叠栏；双向）
  incomingRelationships: (PersonaRelationship & { sourceName: string })[] // TA 对我（反向汇总）
  cognitionNotes: PersonaCognitionNote[] // 自我认知笔记沿革（新的在前）
  cognitionWritingAt?: string | null // 认知笔记书写中的开始时刻（ISO）；null=无在飞书写
}

// ---------------------------------------------------------------------------
// Provider 预设辅助（契约 PROVIDER_PRESETS 是 Record，这里给出有序列表形态）
// ---------------------------------------------------------------------------

export interface ProviderPresetEntry {
  provider: AiProvider
  label: string
  baseUrl: string
  /** 该 provider 的默认模型 */
  defaultModel: string
}

const PROVIDER_ORDER: AiProvider[] = ['kimi', 'openai', 'deepseek', 'custom', 'anthropic']

/** 有序 Provider 预设列表（下拉框渲染用） */
export const PROVIDER_LIST: ProviderPresetEntry[] = PROVIDER_ORDER.map((provider) => ({
  provider,
  label: PROVIDER_PRESETS[provider].label,
  baseUrl: PROVIDER_PRESETS[provider].baseUrl,
  defaultModel: PROVIDER_PRESETS[provider].model,
}))

export function getProviderPreset(provider: AiProvider): ProviderPresetEntry {
  const entry = PROVIDER_LIST.find((p) => p.provider === provider)
  if (!entry) throw new Error(`未知 provider: ${provider}`)
  return entry
}

// ---------------------------------------------------------------------------
// 版型展示辅助（从 roles + ROLE_META 推导阵容摘要）
// ---------------------------------------------------------------------------

export interface BoardRoleBreakdown {
  /** 神职角色名列表（含重复） */
  gods: string[]
  /** 狼人阵营角色名列表（含重复） */
  wolves: string[]
  /** 平民数量 */
  villagerCount: number
}

export function boardRoleBreakdown(board: BoardDef): BoardRoleBreakdown {
  const gods: string[] = []
  const wolves: string[] = []
  let villagerCount = 0
  for (const role of board.roles) {
    const meta = ROLE_META[role]
    if (meta.camp === 'wolf') wolves.push(meta.name)
    else if (meta.camp === 'god') gods.push(meta.name)
    else villagerCount += 1
  }
  return { gods, wolves, villagerCount }
}

// ---------------------------------------------------------------------------
// 分析师配置（localStorage 持久化，大厅与对局观察室共用）
// ---------------------------------------------------------------------------

/** 分析师配置存储 key（独立于大厅配置，避免旧数据结构冲突） */
export const ANALYST_STORAGE_KEY = 'aiwerewolf.analyst.v1'
/** 大厅配置存储 key（与 src/pages/Home.tsx 的 STORAGE_KEY 保持一致） */
export const LOBBY_STORAGE_KEY = 'aiwerewolf.lobby.v2'

/** API 四要素（存档/定制通用的最小配置单元） */
export interface ApiQuad {
  provider: AiProvider
  baseUrl: string
  model: string
  apiKey: string
}

export interface AnalystSettings {
  /** true = 从存档库选择存档（默认开启；关闭则下方存档选择窗口隐藏，改用定制选项） */
  usePreset: boolean
  /** 选中的存档 id（'' = 未选） */
  presetId: string
  /** 选中存档的四要素快照（选取时拷贝；观察室手动分析离线读取，存档被编辑后由大厅负责同步刷新） */
  presetConfig: ApiQuad | null
  /** 定制选项的四要素（usePreset=false 时生效；保存应用后持久保存，开关切换不丢失） */
  provider: AiProvider
  baseUrl: string
  model: string
  apiKey: string
  /** 对局结束后自动生成分析报告（false = 仅在对局观察室手动生成） */
  autoGenerate: boolean
  /** 胜率推测：对局中实时推测神民/狼人胜率并记录理由（自创建对局时生效） */
  winRateEnabled: boolean
}

export function defaultAnalystSettings(): AnalystSettings {
  const preset = getProviderPreset('kimi')
  return {
    usePreset: true,
    presetId: '',
    presetConfig: null,
    provider: preset.provider,
    baseUrl: preset.baseUrl,
    model: '', // Model 初始态为空，避免默认型号误导用户（规格更新快）
    apiKey: '',
    autoGenerate: true,
    winRateEnabled: true, // 默认全部设置开启（胜率推测默认开）
  }
}

export function loadAnalystSettings(): AnalystSettings | null {
  try {
    const raw = localStorage.getItem(ANALYST_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<AnalystSettings> & { followBatch?: boolean }
    if (!parsed || typeof parsed !== 'object') return null
    const defaults = defaultAnalystSettings()
    // 旧版迁移：followBatch=true ≈ 选择存档开关开启；其独立四要素保留为定制选项
    if (typeof parsed.followBatch === 'boolean') {
      return {
        ...defaults,
        usePreset: parsed.followBatch,
        provider: parsed.provider ?? defaults.provider,
        baseUrl: parsed.baseUrl ?? defaults.baseUrl,
        model: parsed.model ?? defaults.model,
        apiKey: parsed.apiKey ?? defaults.apiKey,
        autoGenerate: parsed.autoGenerate !== false,
        winRateEnabled: parsed.winRateEnabled !== false, // 默认开启；仅显式关闭才保留关
      }
    }
    return { ...defaults, ...parsed }
  } catch {
    return null
  }
}

export function saveAnalystSettings(settings: AnalystSettings): void {
  try {
    localStorage.setItem(ANALYST_STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // 隐私模式等写入失败场景直接忽略
  }
}

/** 分析师配置完整性：模型与 Key 必填，非 anthropic 还需 Base URL */
export function isCompleteAnalystConfig(cfg: AnalystAiConfig): boolean {
  return Boolean(
    cfg.model.trim() && cfg.apiKey.trim() && (cfg.provider === 'anthropic' || cfg.baseUrl.trim()),
  )
}

interface LobbyBatchLike {
  provider: AiProvider
  baseUrl: string
  model: string
  apiKey: string
}

/** 从大厅 localStorage 配置中读取批量配置（不存在/损坏返回 null） */
function loadLobbyBatch(): LobbyBatchLike | null {
  try {
    const raw = localStorage.getItem(LOBBY_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { batch?: LobbyBatchLike }
    const batch = parsed?.batch
    if (!batch || typeof batch !== 'object' || !(batch.provider in PROVIDER_PRESETS)) return null
    return batch
  } catch {
    return null
  }
}

/**
 * 由分析师设置推导 AnalystAiConfig：
 * usePreset=true 时取用选中存档的四要素快照，否则取用定制选项的四要素。
 * 字段不完整时返回 null（调用方按「未配置」处理）。
 */
/** API 四要素完整性（baseUrl/Model/Key 必填，anthropic 免 Base URL） */
function isCompleteQuad(q: ApiQuad): boolean {
  return Boolean(q.model.trim() && q.apiKey.trim() && (q.provider === 'anthropic' || q.baseUrl.trim()))
}

export function buildAnalystConfig(settings: AnalystSettings): AnalystAiConfig | null {
  const custom: ApiQuad = {
    provider: settings.provider,
    baseUrl: settings.baseUrl,
    model: settings.model,
    apiKey: settings.apiKey,
  }
  // 「选择存档」开启但未选中存档（presetConfig 为空）时，回退到定制选项的四要素——
  // 否则开关开着却没选存档会被静默判为「未配置」，自动生成永不触发（线上实锤）
  const core: ApiQuad | null = settings.usePreset
    ? (settings.presetConfig ?? (isCompleteQuad(custom) ? custom : null))
    : isCompleteQuad(custom)
      ? custom
      : null
  if (!core) return null
  const cfg: AnalystAiConfig = { ...core, autoGenerate: settings.autoGenerate }
  return isCompleteAnalystConfig(cfg) ? cfg : null
}

/**
 * 从 localStorage 解析当前可用的分析师配置（对局观察室手动触发分析用）。
 * 未做过分析师配置 / 字段不完整时均返回 null。
 */
export function resolveAnalystAiConfig(): AnalystAiConfig | null {
  const settings = loadAnalystSettings()
  const batch = loadLobbyBatch()
  if (!settings) {
    // 未单独配置过分析师：回落到大厅工作配置（分析师与玩家共用同一 agent）
    if (!batch) return null
    return isCompleteAnalystConfig(batch)
      ? { provider: batch.provider, baseUrl: batch.baseUrl, model: batch.model, apiKey: batch.apiKey }
      : null
  }
  // 分析师配置推导为空（如开了「选择存档」却未选、定制项也不完整）：
  // 同样回落到大厅工作配置，保证手动/自动生成都有可用配置
  const cfg = buildAnalystConfig(settings)
  if (cfg) return cfg
  if (!batch) return null
  return isCompleteAnalystConfig(batch)
    ? { ...batch, autoGenerate: settings.autoGenerate }
    : null
}

// ---------------------------------------------------------------------------
// tRPC 命令式调用封装
// ---------------------------------------------------------------------------

/** game.export 的返回形态（后端 events 声明为 unknown[]，这里按契约收窄） */
export interface GameExportData {
  snapshot: GameSnapshot
  events: GameEvent[]
}

/** game.guideVersion 的返回形态 */
export interface GuideVersionDetail {
  version: number
  content: string
  createdAt: string
}

/** game.analysis 的返回形态 */
export interface AnalysisResult {
  report: AnalysisReport | null
  jobStatus: AnalysisJobStatus
  /** 运行中任务的当前阶段：analyze=撰写报告 / distill=沉淀经验指南；非运行中为 null */
  jobStage: AnalysisJobStage
  jobError: string | null
}

/** RSQ 雷达数据点（与后端 toRadarData 同构）*/
export interface RadarDatumView { axis: string; label: string; value: number }

/** RSQ 维度分（39 维，全部 0–100）*/
export interface RSQDimensionsView {
  companionship: number; conflict: number; instrumentalAid: number; antagonism: number
  emotionalSupport: number; nurturance: number; relativePower: number; intimateDisclosure: number
  reliableAlliance: number; affection: number; admiration: number; reassuranceOfWorth: number
  satisfactionNRI: number; intimacy: number; passion: number; commitmentTLS: number
  attachmentAnxiety: number; attachmentAvoidance: number; predictability: number; dependability: number
  faith: number; satisfactionIMS: number; alternatives: number; investment: number; commitment: number
  conflictReasoning: number; conflictVerbal: number; conflictAvoidance: number; closeness: number
  metaWorth: number; metaAbility: number; metaDefensiveness: number; metaDisclosure: number
  metaCertainty: number; metaMismatch: number; jealousy: number; ipcAgency: number; ipcAffiliation: number
  equityBalance: number; indebtedness: number; grievance: number
  forgiveness: number; revenge: number; avoidance: number; benevolence: number
}

export interface RSQResultView {
  dims: RSQDimensionsView
  derived: { involvement: number; ambivalence: number; netAffect: number; powerBalance: number; perceivedGap: number; forgiveGap: number; equityStrain: number }
  validity: {
    consistency: number; socialDesirability: number; lieScale: number; darkTriad: number
    behavioralGap: number; experienceConsistency: number; overall: number
    verdict: 'reliable' | 'questionable' | 'likely-deceptive'
    flags: string[]
  }
  feedback: unknown | null
  selfSummary: string | null
  raw: Record<string, number>
  itemsVersion: string
}

export interface RSQRecordView extends RSQResultView {
  id: number
  fromPersonaId: number
  toPersonaId: number
  gameId: string | null
  batteryLevel: string
  model: string | null
  answeredAt: string | Date
  createdAt: string | Date
  radar: RadarDatumView[]
}

export interface ValleyItemView {
  id: number
  titleNo: string
  era: string
  relation: string
  affinityDelta: number
  trustDelta: number
  affinity: number
  trust: number
  note: string | null
  gameId: string | null
}

/** 关系补完进度（与后端 completionStatus.progress 同构） */
export interface CompletionProgressView {
  phase?: string
  total?: number
  done?: number
  current?: string
  written?: number
  webSearched?: number
  log?: string[]
  /** 后端可能补充的真实统计（stats JSON 摊平后） */
  corrected?: number
  generated?: number
  verified?: number
  rejected?: number
}

/** 关系补完真实统计（后端 job.stats / statsRaw 解析后；P1-16） */
export interface CompletionStats {
  written?: number
  webSearched?: number
  corrected?: number
  generated?: number
  verified?: number
  rejected?: number
  reason?: string
}

/** 补完任务 scope（后端 job.scope JSON：resume 自恢复用） */
export interface CompletionJobScopeView {
  personaIds?: number[]
  apiPresetId?: number | null
}

/** 关系补完任务台账（network.listCompletionJobs / completionStatus 行） */
export interface CompletionJobView {
  id: number
  status: string
  /** 后端原始 scope：对象 {personaIds, apiPresetId}（老数据可能是字符串） */
  scope?: CompletionJobScopeView | string | null
  progress?: CompletionProgressView | null
  progressRaw?: string | null
  /** 后端 job.stats 解析结果（真实 written/webSearched 等） */
  stats?: Record<string, unknown> | null
  statsRaw?: string | null
  createdAt?: string | Date | null
  finishedAt?: string | Date | null
}

/** 现实层补完任务台账（network.backfillJobs 行） */
export interface BackfillJobView {
  id?: number
  personaId?: number
  aboutPersonaId?: number
  status?: string
  itemCount?: number
  error?: string | null
  createdAt?: string | Date | null
  finishedAt?: string | Date | null
}

export interface CanonItemView {
  id: number
  personaId: number
  aboutPersonaId: number
  seq: number
  /** 手动排序位（null=按时代时间线排序；拖动排序后写入） */
  sortOrder?: number | null
  era: string
  age: number | null
  place: string | null
  /** 时间依据（原作明载 / 推定链）——P2-24 契约漂移补齐 */
  eraBasis: string | null
  eventText: string
  feeling: string
  impact: string | null
  certainty: string
  sourceRef: string | null
  sourceCount: number
  sources: Array<{ title: string; url: string; tier: string; reason: string; quote?: string }>
  verification: string
  origin: string
  createdAt: string | Date
}

export interface GameApi {
  /** 全部可用版型（game.boards） */
  listBoards(): Promise<BoardDef[]>
  /** 历史对局（game.list，后端按时间倒序全量返回——本地桌面端不限数量） */
  listGames(): Promise<GameSummary[]>
  /** 创建对局（game.create），成功后跳转 /game/:id */
  createGame(input: CreateGameInput): Promise<{ gameId: string }>
  /** 测试 AI Key 连通性（game.aiTest） */
  testAiKey(input: AiTestInput): Promise<AiTestResult>
  /** 增量轮询（game.poll）：返回最新快照 + seq > afterSeq 的事件；afterWinRateId 为胜率推测游标 */
  pollGame(gameId: string, afterSeq: number, lastSig?: string, afterWinRateId?: number): Promise<PollResult>
  /** 启动/暂停/终止（game.control） */
  controlGame(gameId: string, action: 'start' | 'pause' | 'terminate' | 'stopPostGame', seatRoles?: RoleId[]): Promise<{ ok: boolean }>
  /** 已结束对局补开赛后讨论（game.startPostGame）；started=false 时 reason 给出原因（幂等） */
  startPostGame(gameId: string): Promise<{ started: boolean; reason?: string }>
  /** 开始心理检查（game.startPsyCheck）：分出胜负即可；可续跑（已完成座位不重跑）；
   *  分析师配置由前端携带（缺省后端回落对局座位配置） */
  startPsyCheck(gameId: string, analystAi?: AnalystAiConfig | null): Promise<{ started: boolean; reason?: string }>
  /** 导出完整研究数据（game.export） */
  exportGame(gameId: string): Promise<GameExportData>
  /** 经验指南总览（game.guide）：共通内容 + 各版型特定内容；GuideInfo.version=0 表示该 scope 暂无 */
  getGuide(): Promise<GuideOverview>
  /** 指定 scope 的经验指南版本历史（game.guideVersions，新版本在前）；scope="common" 或版型 id */
  getGuideVersions(scope: string): Promise<GuideVersionSummary[]>
  /** 指定 scope 的某版指南全文（game.guideVersion），不存在返回 null */
  getGuideVersion(scope: string, version: number): Promise<GuideVersionDetail | null>
  /** 手动编辑指南（game.updateGuide）：以编辑后内容生成该 scope 的新版本（历史保留，note="用户手动编辑"），返回最新 GuideInfo */
  updateGuide(scope: string, content: string): Promise<GuideInfo>
  /** 对局分析报告与任务状态（game.analysis） */
  getAnalysis(gameId: string): Promise<AnalysisResult>
  /** 异步启动分析（game.generateAnalysis），返回 {started}；analystAi 可省略（后端复用座位 agent 配置） */
  generateAnalysis(gameId: string, analystAi?: AnalystAiConfig): Promise<{ started: boolean }>
  /** API 存档列表（preset.list） */
  // ---- 关系网（§29/§30）----
  /** 关系网图数据（network.graph） */
  relationGraph(input?: { layer?: "canon" | "vale" | "all" }): Promise<{
    edges: { id: number; from: number; to: number; toName: string | null; kind: string; form: string; layer: string; positivity: number; negativity: number; trust: number; involvement: number; ambivalence: number; closeness: number; dependence: number; reciprocity: number; powerBalance: number; formality: number; commitment: number; dangling: boolean }[]
    nodes: { id: number; name: string; source: string; image: string | null }[]
    nodeIds: number[]
  }>
  /** 启动关系补完（network.startCompletion） */
  startRelationCompletion(input: { personaIds?: number[]; apiPresetId?: number | null }): Promise<{
    jobId: number
    error?: string
  }>
  /** 暂停补完（network.pauseCompletion）*/
  pauseCompletion(input: { jobId: number }): Promise<{ ok: boolean }>
  /** 恢复已暂停/失败的任务（network.resumeCompletion，从 job.scope 自恢复）*/
  resumeCompletion(input: { jobId: number }): Promise<{ ok: boolean; started?: boolean; jobId?: number; error?: string }>
  /** 终止补完（network.cancelCompletion）*/
  cancelCompletion(input: { jobId: number }): Promise<{ ok: boolean }>
  /** 全部补完任务台账（network.listCompletionJobs，后端新增；打开弹窗时恢复现场） */
  listCompletionJobs(): Promise<CompletionJobView[]>
  /** 补完任务进度（network.completionStatus；轮询用） */
  relationCompletionStatus(jobId: number): Promise<CompletionJobView | null>

  // ---- L2 主观层：RSQ 关系测评 ----
  /** 按 batteryLevel 拉取题库（network.rsqItems，后端新增） */
  rsqItems(input: { level: RsqBatteryLevel }): Promise<RsqItemsView>
  /** 提交答卷 → 计分 → 落库（network.submitRSQ） */
  submitRSQ(input: RsqSubmitPayload): Promise<{ id: number; result: RSQResultView; radar: RadarDatumView[] }>
  /** 最新测评（含雷达） */
  latestRSQ(input: { fromPersonaId: number; toPersonaId: number }): Promise<RSQRecordView | null>
  /** 历史答卷（时间轴） */
  rsqHistory(input: { fromPersonaId: number; toPersonaId: number; order?: 'asc' | 'desc'; limit?: number }): Promise<RSQRecordView[]>
  /** 某人格对所有人的最新认知 */
  rsqLatestFor(input: { fromPersonaId: number }): Promise<RSQRecordView[]>
  /** 测评覆盖率 */
  rsqCoverage(): Promise<{ pairs: number; total: number }>

  // ---- L1 现实层：单视角关系记忆 ----
  /** 山谷层关系变动时间线（现实层兜底）*/
  valleyHistory(input: { personaId: number; aboutPersonaId: number }): Promise<ValleyItemView[]>
  /** 某人格对某对象的全部记忆 */
  canonLog(input: { personaId: number; aboutPersonaId: number; order?: 'asc' | 'desc' }): Promise<CanonItemView[]>
  /** 手动补充一条记忆 */
  addCanonEvent(input: {
    personaId: number; aboutPersonaId: number
    era: string; eventText: string; feeling: string
    impact?: string | null; age?: number | null; place?: string | null
  }): Promise<number>
  /** 编辑一条记忆 */
  updateCanonEvent(input: { id: number; patch: Partial<{ era: string; eventText: string; feeling: string; impact: string | null; age: number | null; place: string | null }> }): Promise<{ ok: boolean }>
  /** 软删一条记忆 */
  deleteCanonEvent(input: { id: number }): Promise<{ ok: boolean }>
  /** 详情页拖动排序：按 orderedIds 重写该视角下全部现实层事件的排序位 */
  reorderCanonEvents(input: { personaId: number; aboutPersonaId: number; orderedIds: number[] }): Promise<{ updated: number }>
  /** 手动新建关系（原世界层） */
  createManualRelation(input: {
    fromPersonaId: number
    toPersonaId: number
    kind: string
    form?: string
    basis?: string | null
  }): Promise<{ relationId: number; created: boolean }>
  /** 手动编辑关系（kind/form 校正留痕；basis 直改） */
  updateManualRelation(input: {
    relationId: number
    patch: { kind?: string; form?: string; basis?: string | null }
  }): Promise<{ ok: boolean; relationId: number }>
  /** 某人格发出的原始关系行（详情页编辑用，含 kind/form/dims 原始值） */
  listPersonaRelationRows(personaId: number): Promise<Array<{
    id: number
    fromPersonaId: number
    toPersonaId: number
    toName: string | null
    layer: string
    form: string
    kind: string
    positivity: number
    negativity: number
    trust: number
    closeness: number
    dependence: number
    reciprocity: number
    powerBalance: number
    formality: number
    commitment: number
    basis: string | null
  }>>
  /** 现实层覆盖率 */
  canonCoverage(input?: { personaId?: number }): Promise<{ pairs: number; items: number }>
  /** 补完任务台账 */
  backfillJobs(input?: { personaId?: number }): Promise<BackfillJobView[]>
  /** 启动现实层补完（异步：立即返回，后台跑）*/
  startBackfillCanon(input: { personaId: number; aboutPersonaId: number; apiPresetId?: number | null; force?: boolean }): Promise<{ started: boolean; error?: string }>
  /** 现实层补完任务状态（轮询用）*/
  backfillCanonStatus(input: { personaId: number; aboutPersonaId: number }): Promise<{ status: string; itemCount: number; error: string | null }>
  /** 启动现实层补完（同步执行，含全量核查） */
  backfillCanon(input: { personaId: number; aboutPersonaId: number; apiPresetId?: number | null; force?: boolean }): Promise<{
    jobId: number
    generated: number
    verified: number
    rejected: number
    written: number
    /** 是否真的联网（API 实证）*/
    webSearched?: boolean
    /** 无联网时的警告 */
    webWarning?: string
    skipped?: boolean
    error?: string
  }>

  listPresets(): Promise<ApiPreset[]>
  /** 新建 API 存档（preset.create） */
  createPreset(input: ApiPresetInput): Promise<ApiPreset>
  /** 更新 API 存档（preset.update，覆盖写回选中存档） */
  updatePreset(id: number, patch: Partial<ApiPresetInput>): Promise<ApiPreset | null>
  /** 删除 API 存档（preset.remove） */
  deletePreset(id: number): Promise<boolean>
  /** 图书馆文档列表（library.list） */
  listLibraryDocs(): Promise<LibraryDocMeta[]>
  /** 上传图书馆文档（library.upload；base64 内容，服务端提取文本） */
  uploadLibraryDoc(input: { name: string; contentBase64: string }): Promise<{ id: number; chars: number }>
  /** 读取图书馆文档全文（library.read） */
  readLibraryDoc(id: number): Promise<LibraryDocDetail | null>
  /** 删除图书馆文档（library.remove） */
  removeLibraryDoc(id: number): Promise<boolean>
  /** 赛前学习心得（game.studyNotes）：按座位返回各 AI 的学习记录 */
  getStudyNotes(gameId: string): Promise<{ seat: number; notes: string }[]>
  /** 人格卡列表（persona.list，摘要行） */
  listPersonas(): Promise<PersonaCardSummary[]>
  /** 人格卡详情一屏数据（persona.detail：卡 + 记忆 + 关系 + 漂移）；可传 signal 取消过期请求 */
  getPersonaDetail(id: number, signal?: AbortSignal): Promise<PersonaDetail | null>
  /** 手动创建人格卡（persona.create） */
  createPersona(input: PersonaCardInput): Promise<PersonaCard>
  /** 更新人格卡（persona.update，覆盖写回） */
  updatePersona(id: number, patch: Partial<PersonaCardInput>): Promise<PersonaCard | null>
  /** 删除人格卡（persona.remove——软删入回收站，30 天内可还原） */
  deletePersona(id: number): Promise<boolean>
  /** 回收站列表（persona.trash；先惰性清理 30 天过期项） */
  listPersonaTrash(): Promise<PersonaTrashEntry[]>
  /** 回收站还原（persona.restore；记忆/关系/漂移/报告原样回来） */
  restorePersona(id: number): Promise<boolean>
  /** 回收站彻底删除（persona.destroy；级联清除记忆/关系/漂移） */
  destroyPersona(id: number): Promise<boolean>
  /** 铸魂师第一步：人名消歧检索（persona.research；Kimi 联网；castId 用于进度轮询） */
  researchPersona(input: { name: string; hint?: string; searchAi: AiTestInput; webSearch?: boolean; castId?: string }): Promise<PersonaResearchResult>
  /** 铸魂师三步铸造（异步任务模式：启动立即返回 castId；进度与结果经 getCastProgress 轮询） */
  castPersona(input: {
    name: string
    source?: string
    hint?: string
    searchAi: AiTestInput
    understandAi: AiTestInput
    synthAi: AiTestInput
    web?: { stage1?: boolean; stage2?: boolean; stage3?: boolean }
    deepRead?: { segmented?: boolean; selfCritique?: boolean }
    castId?: string
  }): Promise<CastJobStart>
  /** 铸造进度轮询（persona.castProgress）：阶段 label + 细节行 detail + 完成产物 result */
  getCastProgress(castId: string): Promise<CastProgressState | null>
  /** 找回最近铸造（进行中优先；persona.castActive）——向导重开恢复现场 */
  getCastActive(): Promise<CastProgressState | null>
  /** 全部活跃铸造（进行中优先，上限 8 条；persona.castActives）——卡列表「生成中」卡片组 */
  getCastActives(): Promise<CastProgressState[]>
  /** 批量并发铸造（persona.castBatch）：每人一条任务链（消歧自动取首候选→铸造），并发闸门 2 */
  castPersonaBatch(input: {
    items: { name: string; hint?: string }[]
    searchAi: AiTestInput
    understandAi: AiTestInput
    synthAi: AiTestInput
    web?: { stage1?: boolean; stage2?: boolean; stage3?: boolean }
    deepRead?: { segmented?: boolean; selfCritique?: boolean }
  }): Promise<{ items: { castId: string; name: string }[] }>
  /** 核对入库核销（persona.castAck）：草稿转 saved 留痕保留（不删除） */
  ackCast(castId: string): Promise<{ ok: boolean }>
  /** 用户主动删除草稿（persona.castDraftDiscard）：清库唯一通道——条目+草稿+检查点全清 */
  discardCastDraft(castId: string): Promise<{ ok: boolean }>
  /** 生成留痕（persona.castTrace）：进度标记点 + 各阶段已落盘研究文本（服务端脱敏） */
  getCastTrace(castId: string): Promise<CastTrace | null>
  /** 赛后自动书写开关（persona.setAutoCognition）：心理检查完后由参赛绑定模型自动书写 */
  setAutoCognition(input: {
    personaId: number
    enabled: boolean
    includeReports?: boolean
    includeDrift?: boolean
  }): Promise<{ ok: boolean }>
  /** 记录认知（persona.writeCognition）：人格以第一人称书写自我认知笔记（两程管线；同步等待） */
  writeCognition(input: {
    personaId: number
    cfg: { provider: AiProvider; baseUrl: string; model: string; apiKey: string }
    includeReports?: boolean
    includeDrift?: boolean
  }): Promise<{ started: boolean }>
  /** 编辑认知笔记（persona.updateCognitionNote；最新篇被编辑时现役认知同步） */
  updateCognitionNote(input: { noteId: number; personaId: number; content: string }): Promise<{ ok: boolean }>
  /** 删除认知笔记（persona.deleteCognitionNote；最新篇被删时现役认知回退） */
  deleteCognitionNote(input: { noteId: number; personaId: number }): Promise<{ ok: boolean }>
  /** 断点续铸（persona.resumeCast）：中断条目从检查点恢复继续铸造 */
  resumeCast(castId: string): Promise<{ ok: boolean }>
  /** 铸造控制（persona.castControl）：暂停/继续/终止（终止=取消并删除整个铸造流程） */
  controlCast(castId: string, action: 'pause' | 'resume' | 'cancel'): Promise<{ ok: boolean }>
  /** 从链接抓取肖像（persona.fetchPortrait；图片/页面链接均可，服务端转 data URL） */
  fetchPortrait(url: string): Promise<{ imageData: string | null }>
  /** 铸造草稿确认入库（persona.createCasted，source="ai-cast"） */
  createCastedPersona(input: PersonaCardInput): Promise<PersonaCard>
  /** 该人格的全部心理检查报告（persona.reports） */
  listPersonaReports(id: number): Promise<PersonaReport[]>
  /** 本局人格座位的心理检查报告（game.personaReports） */
  getGamePersonaReports(gameId: string): Promise<PersonaReport[]>
}

/** 图书馆文档全文（library.read 返回） */
export interface LibraryDocDetail {
  id: number
  name: string
  format: string
  sizeBytes: number
  content: string
}

/** 图书馆文档元信息（library.list 行） */
export interface LibraryDocMeta {
  id: number
  name: string
  format: string
  sizeBytes: number
  createdAt: string
}

// 保留的关系模块仍参与主仓与 preview 类型检查，但 network 后端已经移除。
// 用这一处显式、类型安全的禁用实现替代所有 client.network 调用；生产人格页不会触达这些方法。
const relationNetworkRemoved = (): Promise<never> =>
  Promise.reject(new Error('关系网功能已移除'))

const disabledRelationNetworkApi = {
  relationGraph: relationNetworkRemoved,
  startRelationCompletion: relationNetworkRemoved,
  pauseCompletion: relationNetworkRemoved,
  resumeCompletion: relationNetworkRemoved,
  cancelCompletion: relationNetworkRemoved,
  listCompletionJobs: relationNetworkRemoved,
  relationCompletionStatus: relationNetworkRemoved,
  rsqItems: relationNetworkRemoved,
  submitRSQ: relationNetworkRemoved,
  latestRSQ: relationNetworkRemoved,
  rsqHistory: relationNetworkRemoved,
  rsqLatestFor: relationNetworkRemoved,
  rsqCoverage: relationNetworkRemoved,
  valleyHistory: relationNetworkRemoved,
  canonLog: relationNetworkRemoved,
  addCanonEvent: relationNetworkRemoved,
  updateCanonEvent: relationNetworkRemoved,
  deleteCanonEvent: relationNetworkRemoved,
  reorderCanonEvents: relationNetworkRemoved,
  createManualRelation: relationNetworkRemoved,
  updateManualRelation: relationNetworkRemoved,
  listPersonaRelationRows: relationNetworkRemoved,
  canonCoverage: relationNetworkRemoved,
  backfillJobs: relationNetworkRemoved,
  startBackfillCanon: relationNetworkRemoved,
  backfillCanonStatus: relationNetworkRemoved,
  backfillCanon: relationNetworkRemoved,
}

/**
 * 获取命令式 GameApi。内部复用 trpc provider 的单例 client，
 * 返回对象引用稳定（client 不变时不重建），可安全放入 useEffect 依赖。
 */
export function useGameApi(): GameApi {
  const client = trpc.useUtils().client
  return useMemo<GameApi>(() => {
    return {
      listBoards: () => client.game.boards.query(),
      listGames: async () => {
        // 历史对局不限数量：后端全量返回，前端不再截取
        return client.game.list.query()
      },
      createGame: (input) => client.game.create.mutate(input),
      testAiKey: (input) => client.game.aiTest.mutate(input),
      // 轮询带 12s 熔断：请求挂起（代理半开连接/后端慢）会永久卡死轮询循环（历史事故）
      pollGame: (gameId, afterSeq, lastSig, afterWinRateId) =>
        client.game.poll.query(
          { gameId, afterSeq, lastSig, afterWinRateId },
          { signal: AbortSignal.timeout(12_000) },
        ),
      controlGame: (gameId, action, seatRoles) => client.game.control.mutate({ gameId, action, seatRoles }),
      startPostGame: (gameId) => client.game.startPostGame.mutate({ gameId }),
      startPsyCheck: (gameId, analystAi) => client.game.startPsyCheck.mutate({ gameId, analystAi }),
      exportGame: async (gameId) => {
        const data = await client.game.export.query({ gameId })
        return { snapshot: data.snapshot, events: data.events as GameEvent[] }
      },
      getGuide: () => client.game.guide.query(),
      getGuideVersions: (scope) => client.game.guideVersions.query({ scope }),
      getGuideVersion: (scope, version) => client.game.guideVersion.query({ scope, version }),
      updateGuide: (scope, content) => client.game.updateGuide.mutate({ scope, content }),
      getAnalysis: (gameId) => client.game.analysis.query({ gameId }),
      generateAnalysis: (gameId, analystAi) =>
        client.game.generateAnalysis.mutate({ gameId, analystAi }),
      ...disabledRelationNetworkApi,
      listPresets: () => client.preset.list.query(),
      createPreset: (input) => client.preset.create.mutate(input),
      updatePreset: (id, patch) => client.preset.update.mutate({ id, patch }),
      deletePreset: (id) => client.preset.remove.mutate({ id }),
      listLibraryDocs: () => client.library.list.query(),
      uploadLibraryDoc: (input) => client.library.upload.mutate(input),
      readLibraryDoc: (id) => client.library.read.query({ id }),
      removeLibraryDoc: (id) => client.library.remove.mutate({ id }),
      getStudyNotes: (gameId) => client.game.studyNotes.query({ gameId }),
      listPersonas: () => client.persona.list.query(),
      getPersonaDetail: (id, signal) => client.persona.detail.query({ id }, { signal }),
      createPersona: (input) => client.persona.create.mutate(input),
      updatePersona: (id, patch) => client.persona.update.mutate({ id, patch }),
      deletePersona: (id) => client.persona.remove.mutate({ id }),
      listPersonaTrash: () => client.persona.trash.query(),
      restorePersona: (id) => client.persona.restore.mutate({ id }),
      destroyPersona: (id) => client.persona.destroy.mutate({ id }),
      researchPersona: (input) => client.persona.research.mutate(input),
      castPersona: (input) => client.persona.cast.mutate(input),
      getCastProgress: (castId) => client.persona.castProgress.query({ castId }),
      getCastActive: () => client.persona.castActive.query(),
      getCastActives: () => client.persona.castActives.query(),
      castPersonaBatch: (input) => client.persona.castBatch.mutate(input),
      ackCast: (castId) => client.persona.castAck.mutate({ castId }),
      discardCastDraft: (castId) => client.persona.castDraftDiscard.mutate({ castId }),
      getCastTrace: (castId) => client.persona.castTrace.query({ castId }),
      writeCognition: (input) => client.persona.writeCognition.mutate(input),
      updateCognitionNote: (input: { noteId: number; personaId: number; content: string }) =>
        client.persona.updateCognitionNote.mutate(input),
      deleteCognitionNote: (input: { noteId: number; personaId: number }) =>
        client.persona.deleteCognitionNote.mutate(input),
      setAutoCognition: (input) => client.persona.setAutoCognition.mutate(input),
      resumeCast: (castId) => client.persona.resumeCast.mutate({ castId }),
      controlCast: (castId, action) => client.persona.castControl.mutate({ castId, action }),
      fetchPortrait: (url) => client.persona.fetchPortrait.mutate({ url }),
      createCastedPersona: (input) => client.persona.createCasted.mutate(input),
      listPersonaReports: (id) => client.persona.reports.query({ id }),
      getGamePersonaReports: (gameId) => client.game.personaReports.query({ gameId }),
    }
  }, [client])
}
