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
} from '@contracts/game'
import { PROVIDER_PRESETS, ROLE_META } from '@contracts/game'
import type {
  CastJobStart,
  CastProgressState,
  PersonaCard,
  PersonaCardInput,
  PersonaCardSummary,
  PersonaDriftEntry,
  PersonaMemory,
  PersonaRelationship,
  PersonaRelationshipHistory,
  PersonaReport,
  PersonaResearchResult,
  PersonaTrashEntry,
} from '@contracts/persona'
import { trpc } from '@/providers/trpc'

// ---------------------------------------------------------------------------
// 契约类型 re-export（页面层统一从这里取，避免散落 import 路径）
// ---------------------------------------------------------------------------

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

// 人格研究库契约 re-export（页面层统一从这里取）
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
  relationshipHistory: PersonaRelationshipHistory[] // 人格锚点关系的逐局沿革（折叠栏）
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
  controlGame(gameId: string, action: 'start' | 'pause' | 'terminate' | 'stopPostGame'): Promise<{ ok: boolean }>
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
  /** 人格卡详情一屏数据（persona.detail：卡 + 记忆 + 关系 + 漂移） */
  getPersonaDetail(id: number): Promise<PersonaDetail | null>
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
  /** 取走/放弃草稿后确认（persona.castAck，条目清除不再恢复） */
  ackCast(castId: string): Promise<{ ok: boolean }>
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

/**
 * 获取命令式 GameApi。内部复用 trpc provider 的单例 client，
 * 返回对象引用稳定（client 不变时不重建），可安全放入 useEffect 依赖。
 */
export function useGameApi(): GameApi {
  const client = trpc.useUtils().client
  return useMemo<GameApi>(
    () => ({
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
      controlGame: (gameId, action) => client.game.control.mutate({ gameId, action }),
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
      getPersonaDetail: (id) => client.persona.detail.query({ id }),
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
      controlCast: (castId, action) => client.persona.castControl.mutate({ castId, action }),
      fetchPortrait: (url) => client.persona.fetchPortrait.mutate({ url }),
      createCastedPersona: (input) => client.persona.createCasted.mutate(input),
      listPersonaReports: (id) => client.persona.reports.query({ id }),
      getGamePersonaReports: (gameId) => client.game.personaReports.query({ gameId }),
    }),
    [client],
  )
}
