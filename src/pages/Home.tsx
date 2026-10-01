import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import {
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Fingerprint,
  Loader2,
  ShieldCheck,
  X,
} from 'lucide-react'
import type {
  AdvancedOptions,
  AiProvider,
  AnalystSettings,
  ApiPreset,
  BoardDef,
  PersonaCardSummary,
  SeatAiConfig,
} from '@/lib/gameApi'
import {
  PROVIDER_LIST,
  PROVIDER_PRESETS,
  boardRoleBreakdown,
  buildAnalystConfig,
  defaultAnalystSettings,
  getProviderPreset,
  loadAnalystSettings,
  saveAnalystSettings,
  useGameApi,
} from '@/lib/gameApi'
import {
  createLocalPreset,
  deleteLocalPresets,
  loadLocalPresets,
  loadMirrorPresets,
  saveLocalPresets,
  saveMirrorPresets,
  updateLocalPreset,
} from '@/lib/localPresets'
import { useAuth } from '@/providers/auth'
import { useSettingsSync } from '@/hooks/useSettingsSync'
import { cn, isUnauthorizedError } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

// ---------------------------------------------------------------------------
// localStorage 持久化（Key 只存浏览器，不上传存储）
// ---------------------------------------------------------------------------

/** v2：字段与 @contracts/game 对齐（stepDelayMs 等），旧 v1 数据自动作废 */
const STORAGE_KEY = 'aiwerewolf.lobby.v2'
const DEFAULT_BOARD_ID = 'standard12'

/** 批量配置（作为每个座位的默认继承来源） */
interface BatchConfig {
  provider: AiProvider
  baseUrl: string
  model: string
  apiKey: string
}

interface PersistedLobby {
  selectedBoardId: string
  batch: BatchConfig
  seats: SeatAiConfig[]
  options: AdvancedOptions
  /** 人格研究库：座位 → 人格卡 id 绑定（随大厅配置持久化与云端同步） */
  seatPersonas?: Record<number, number>
}

const DEFAULT_OPTIONS: AdvancedOptions = {
  stepDelayMs: 500,
  phaseBreakMs: 2000,
  sheriffEnabled: true,
  allowSelfDestruct: true,
  allowSurrender: true,
  speechRoundsLimit: 2,
  postGameDiscuss: true, // 赛后讨论：UI 默认开（引擎默认关，不传即关闭）
  postGameAutoStart: false, // 赛后自动开始讨论：默认关（分出胜负后挂起，手动开启）
  postGameSpeechLimit: 5, // 每玩家赛后最多发言机会（默认 5）
  personaVisibility: 'full', // 玩家人格可见度：默认完全可见（人格圈层互知名，无人格者为迷雾）
}

/** 旧出厂默认值迁移：这些值若仍是「上一版出厂默认」（用户从未主动改过、只是随默认落盘），
 *  随默认值升级一起换新；用户显式改成的其他值一律不动。
 *  （旧默认 stepDelayMs 2000 / phaseBreakMs 5000 → 新默认 500 / 2000，提速研究节奏） */
function migrateLegacyOptions(o: Partial<AdvancedOptions>): Partial<AdvancedOptions> {
  const out = { ...o }
  if (out.stepDelayMs === 2000) out.stepDelayMs = DEFAULT_OPTIONS.stepDelayMs
  if (out.phaseBreakMs === 5000) out.phaseBreakMs = DEFAULT_OPTIONS.phaseBreakMs
  return out
}

function defaultBatch(): BatchConfig {
  const preset = getProviderPreset('kimi')
  return {
    provider: preset.provider,
    baseUrl: preset.baseUrl,
    model: '', // Model 初始态为空，避免默认型号误导用户（规格更新快）
    apiKey: '',
  }
}

function buildSeats(count: number, batch: BatchConfig, prev: SeatAiConfig[] = []): SeatAiConfig[] {
  return Array.from({ length: count }, (_, i) => {
    const existing = prev[i]
    if (existing) return { ...existing, seat: i + 1 }
    return { seat: i + 1, provider: batch.provider, baseUrl: batch.baseUrl, model: batch.model, apiKey: batch.apiKey }
  })
}

function loadPersisted(): PersistedLobby | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as PersistedLobby
    if (!parsed || typeof parsed !== 'object' || !parsed.batch || !Array.isArray(parsed.seats)) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

/** 云端下发的大厅配置校验：结构破损/未知 provider 一律视为无云端配置（防脏数据打挂大厅） */
function sanitizeSyncedLobby(raw: unknown): PersistedLobby | null {
  if (!raw || typeof raw !== 'object') return null
  const p = raw as Partial<PersistedLobby>
  if (typeof p.selectedBoardId !== 'string' || !p.selectedBoardId) return null
  if (!p.batch || typeof p.batch !== 'object' || !Array.isArray(p.seats)) return null
  const batch = p.batch as Partial<BatchConfig>
  if (typeof batch.provider !== 'string' || !(batch.provider in PROVIDER_PRESETS)) return null
  return {
    selectedBoardId: p.selectedBoardId,
    batch: {
      provider: batch.provider as AiProvider,
      baseUrl: typeof batch.baseUrl === 'string' ? batch.baseUrl : '',
      model: typeof batch.model === 'string' ? batch.model : '',
      apiKey: typeof batch.apiKey === 'string' ? batch.apiKey : '',
    },
    seats: p.seats,
    // 旧云端数据缺新增字段时以默认值补齐（与本地持久化同款策略）；
    // 旧出厂默认的间隔值随默认升级迁移（用户显式改过的值不动）
    options: { ...DEFAULT_OPTIONS, ...migrateLegacyOptions((p.options as Partial<AdvancedOptions>) ?? {}) },
    // 人格绑定：仅接受 {座位号: 人格id} 的扁平记录（防脏数据）
    seatPersonas:
      p.seatPersonas && typeof p.seatPersonas === 'object' && !Array.isArray(p.seatPersonas)
        ? Object.fromEntries(
            Object.entries(p.seatPersonas as Record<string, unknown>).filter(
              ([k, v]) => Number.isInteger(Number(k)) && Number.isInteger(v),
            ),
          ) as Record<number, number>
        : {},
  }
}

/** 云端下发的分析师配置校验：对象即与默认值合并（宽容补齐缺省字段） */
function sanitizeSyncedAnalyst(raw: unknown): AnalystSettings | null {
  if (!raw || typeof raw !== 'object') return null
  return { ...defaultAnalystSettings(), ...(raw as Partial<AnalystSettings>) }
}

// ---------------------------------------------------------------------------
// 展示辅助
// ---------------------------------------------------------------------------

type TestState =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'ok'; message: string }
  | { kind: 'fail'; message: string }

// ---------------------------------------------------------------------------
// 大厅页
// ---------------------------------------------------------------------------

export default function Home() {
  const navigate = useNavigate()
  const api = useGameApi()
  const { user } = useAuth()
  /** 当前登录用户 id（未登录为 null：设置与存档走纯本地，不打断使用） */
  const userId = user?.id ?? null

  // 初始 state 直接从 localStorage 惰性恢复
  const [persisted] = useState<PersistedLobby | null>(() => loadPersisted())
  const [boards, setBoards] = useState<BoardDef[]>([])
  const [selectedBoardId, setSelectedBoardId] = useState<string>(
    persisted?.selectedBoardId ?? DEFAULT_BOARD_ID,
  )
  const [batch, setBatch] = useState<BatchConfig>(() => persisted?.batch ?? defaultBatch())
  const [seats, setSeats] = useState<SeatAiConfig[]>(() =>
    persisted?.seats?.length ? persisted.seats : buildSeats(12, persisted?.batch ?? defaultBatch()),
  )
  const [options, setOptions] = useState<AdvancedOptions>(
    // 旧持久化数据缺新增字段时以默认值补齐（如 phaseBreakMs）；
    // 旧出厂默认的间隔值随默认升级迁移（用户显式改过的值不动）
    () => ({ ...DEFAULT_OPTIONS, ...migrateLegacyOptions(persisted?.options ?? {}) }),
  )
  // 人格研究库：座位 → 人格卡 id 绑定（拖拽/点击指派；随大厅配置持久化与云同步）
  const [seatPersonas, setSeatPersonas] = useState<Record<number, number>>(
    () => persisted?.seatPersonas ?? {},
  )
  // 人格卡库（侧栏；登录后拉取）
  const [personaList, setPersonaList] = useState<PersonaCardSummary[]>([])
  // 拖拽悬停的座位行（高亮提示投放目标）
  const [personaDragOver, setPersonaDragOver] = useState<number | null>(null)
  // 分析师配置（独立 localStorage key，对局观察室手动触发分析时也会读取）
  const [analyst, setAnalyst] = useState<AnalystSettings>(
    () => loadAnalystSettings() ?? defaultAnalystSettings(),
  )
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  // API 存档（服务端保存，多端共享）
  // 三段式：1.saveForm=存档保存表单（纯输入入库）2.batch=存档选取的工作配置（调整+测试）3.座位应用
  const [saveForm, setSaveForm] = useState<BatchConfig>(() => defaultBatch())
  const [presets, setPresets] = useState<ApiPreset[]>([])
  const [selectedPresetId, setSelectedPresetId] = useState<string>('')
  const [presetMsg, setPresetMsg] = useState<string | null>(null)
  const [presetBusy, setPresetBusy] = useState(false)
  // 保存存档弹窗（保存端：命名后把当前配置行内容存入存档库）
  const [saveDialogOpen, setSaveDialogOpen] = useState(false)
  const [saveName, setSaveName] = useState('')
  // 座位勾选（一键定向应用：把批量配置应用到勾选的座位）
  const [checkedSeats, setCheckedSeats] = useState<ReadonlySet<number>>(new Set())
  // 1. 存档编辑：保存表单的测试连接状态
  const [saveTestState, setSaveTestState] = useState<TestState>({ kind: 'idle' })
  // 2. 存档选取：选中存档后自动被动测试的连接状态
  const [presetTestState, setPresetTestState] = useState<TestState>({ kind: 'idle' })
  // 1. 存档编辑：已有存档的编辑弹窗（五要素可改）
  const [editDialog, setEditDialog] = useState<{
    id: number
    name: string
    provider: AiProvider
    baseUrl: string
    model: string
    apiKey: string
  } | null>(null)
  // 存档表栏删除模式：展开全部删除/选定删除，最左列出现勾选框
  const [deleteMode, setDeleteMode] = useState(false)
  const [deleteChecked, setDeleteChecked] = useState<ReadonlySet<number>>(new Set())
  // 存档表栏每行的测试连接状态（按存档 id）
  const [rowTests, setRowTests] = useState<Record<number, TestState>>({})
  // 分析师-选择存档：选中后自动被动测试的连接状态
  const [analystPresetTestState, setAnalystPresetTestState] = useState<TestState>({ kind: 'idle' })
  // 分析师-定制选项：测试连接状态与保存确认提示
  const [analystTestState, setAnalystTestState] = useState<TestState>({ kind: 'idle' })
  const [analystSavedMsg, setAnalystSavedMsg] = useState(false)

  // 拉取版型（公开接口，无需登录）
  useEffect(() => {
    let cancelled = false
    api
      .listBoards()
      .then((bs) => {
        if (!cancelled) setBoards(bs)
      })
      .catch(() => {
        if (!cancelled) setBoards([])
      })
    return () => {
      cancelled = true
    }
  }, [api])

  // AI 存档库：登录态以云端为准（云端为空且本地有存档则逐条上传）；未登录用本地存档库
  // serverSyncedRef：本轮登录是否已成功与云端对齐；对齐后 presets 每次变更都写入按账户隔离的浏览器镜像
  const serverSyncedRef = useRef(false)
  useEffect(() => {
    let cancelled = false
    serverSyncedRef.current = false
    async function syncPresets() {
      if (!userId) {
        setPresets(loadLocalPresets())
        return
      }
      try {
        const serverPresets = await api.listPresets()
        if (cancelled) return
        const locals = loadLocalPresets()
        if (serverPresets.length === 0 && locals.length > 0) {
          // 云端为空且本地有存档：逐条上传（apiKey 由后端 AES-GCM 加密落库）
          const uploaded: ApiPreset[] = []
          const failed: ApiPreset[] = []
          for (const p of locals) {
            try {
              uploaded.push(
                await api.createPreset({
                  name: p.name,
                  provider: p.provider,
                  baseUrl: p.baseUrl,
                  model: p.model,
                  apiKey: p.apiKey,
                }),
              )
            } catch {
              failed.push(p)
            }
            if (cancelled) return
          }
          // 上传成功的从本地移除；失败的保留在本地，下次登录时重试
          saveLocalPresets(failed)
          serverSyncedRef.current = true
          setPresets(uploaded)
          setPresetMsg(
            failed.length > 0
              ? `已同步 ${uploaded.length} 个本地存档到云端，${failed.length} 个上传失败已保留在本地`
              : `已把 ${uploaded.length} 个本地存档同步到云端`,
          )
        } else {
          // 云端有数据（或本地为空）：以云端为准覆盖本地 state（镜像由下方 effect 统一写入）
          serverSyncedRef.current = true
          setPresets(serverPresets)
        }
      } catch (err) {
        if (cancelled) return
        // 加载失败回退该账户的云端镜像（其次才是游客本地库），不打断使用
        const mirror = loadMirrorPresets(userId)
        setPresets(mirror.length > 0 ? mirror : loadLocalPresets())
        if (!isUnauthorizedError(err)) setPresetMsg('云端存档库加载失败，已切换为本地镜像')
      }
    }
    void syncPresets()
    return () => {
      cancelled = true
    }
  }, [api, userId])

  // 与云端对齐后：presets 任何变更（含增删改）都同步写入该账户的浏览器镜像（防云端单点故障再丢档）
  useEffect(() => {
    if (userId && serverSyncedRef.current) saveMirrorPresets(userId, presets)
  }, [userId, presets])

  // 人格卡库：登录后拉取（未登录为空，侧栏显示引导）
  useEffect(() => {
    if (!userId) {
      setPersonaList([])
      return
    }
    let cancelled = false
    api
      .listPersonas()
      .then((rows) => {
        if (!cancelled) setPersonaList(rows)
      })
      .catch(() => {
        if (!cancelled) setPersonaList([])
      })
    return () => {
      cancelled = true
    }
  }, [api, userId])

  // 任何配置变更都持久化到 localStorage
  useEffect(() => {
    const payload: PersistedLobby = { selectedBoardId, batch, seats, options, seatPersonas }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
    } catch {
      // 隐私模式等写入失败场景直接忽略
    }
  }, [selectedBoardId, batch, seats, options, seatPersonas])

  // 分析师配置变更持久化（独立 key）
  useEffect(() => {
    saveAnalystSettings(analyst)
  }, [analyst])

  // 大厅工作配置快照（云同步载荷，与 localStorage 持久化同结构）
  const lobbySnapshot = useMemo<PersistedLobby>(
    () => ({ selectedBoardId, batch, seats, options, seatPersonas }),
    [selectedBoardId, batch, seats, options, seatPersonas],
  )

  // 云端设置应用到本地 state（上方两个持久化 effect 会顺带写回 localStorage）
  const applySyncedSettings = useCallback((synced: { lobby?: unknown; analyst?: unknown }) => {
    const lobby = sanitizeSyncedLobby(synced.lobby)
    if (lobby) {
      setSelectedBoardId(lobby.selectedBoardId)
      setBatch(lobby.batch)
      setSeats(lobby.seats)
      setOptions(lobby.options)
      setSeatPersonas(lobby.seatPersonas ?? {})
    }
    const analystCfg = sanitizeSyncedAnalyst(synced.analyst)
    if (analystCfg) setAnalyst(analystCfg)
  }, [])

  // 设置云同步：登录后拉取/首登上传/本地变更防抖推送（未登录完全不触发）
  useSettingsSync({ userId, lobby: lobbySnapshot, analyst, applySynced: applySyncedSettings })

  // 存档库内容变化（第1部分编辑/删除）时，同步刷新分析师选中存档的四要素快照
  useEffect(() => {
    setAnalyst((prev) => {
      if (!prev.presetId) return prev
      const preset = presets.find((p) => String(p.id) === prev.presetId)
      if (!preset) return prev.presetConfig === null ? prev : { ...prev, presetConfig: null }
      const same =
        prev.presetConfig &&
        prev.presetConfig.provider === preset.provider &&
        prev.presetConfig.baseUrl === preset.baseUrl &&
        prev.presetConfig.model === preset.model &&
        prev.presetConfig.apiKey === preset.apiKey
      return same
        ? prev
        : {
            ...prev,
            presetConfig: {
              provider: preset.provider,
              baseUrl: preset.baseUrl,
              model: preset.model,
              apiKey: preset.apiKey,
            },
          }
    })
  }, [presets])

  const selectedBoard = useMemo(
    () => boards.find((b) => b.id === selectedBoardId) ?? null,
    [boards, selectedBoardId],
  )

  // 当前选中的存档（第2部分只读信息展示 + 第3部分命名显示）
  const selectedPreset = useMemo(
    () => presets.find((p) => String(p.id) === selectedPresetId) ?? null,
    [presets, selectedPresetId],
  )

  // ------------------------------------------------------------------
  // 事件处理
  // ------------------------------------------------------------------

  function handleSelectBoard(board: BoardDef) {
    setSelectedBoardId(board.id)
    setSeats((prev) => buildSeats(board.playerCount, batch, prev))
    // 警长竞选默认值跟随版型
    setOptions((prev) => ({ ...prev, sheriffEnabled: board.sheriff }))
    // 版型切换：超出新座位数的人格绑定一并剪除
    setSeatPersonas((prev) =>
      Object.fromEntries(Object.entries(prev).filter(([s]) => Number(s) <= board.playerCount)),
    )
  }

  // ---------- 人格绑卡（拖拽指派 / 点击移除） ----------
  function assignPersona(seat: number, personaId: number) {
    setSeatPersonas((prev) => {
      const next = { ...prev }
      // 同一张人格卡不重复占座：先从其他座位摘下
      for (const [s, id] of Object.entries(next)) {
        if (id === personaId) delete next[Number(s)]
      }
      next[seat] = personaId
      return next
    })
  }

  function unassignPersona(seat: number) {
    setSeatPersonas((prev) => {
      const next = { ...prev }
      delete next[seat]
      return next
    })
    // 解绑同步摘下迷雾标记
    setOptions((prev) => ({
      ...prev,
      personaFogSeats: (prev.personaFogSeats ?? []).filter((s) => s !== seat),
    }))
  }

  // ---------- 人格迷雾勾选（partial 档：给已绑人格的座位上迷雾） ----------
  function toggleFogSeat(seat: number) {
    setOptions((prev) => {
      const cur = new Set(prev.personaFogSeats ?? [])
      if (cur.has(seat)) cur.delete(seat)
      else cur.add(seat)
      return { ...prev, personaFogSeats: [...cur].sort((a, b) => a - b) }
    })
  }

  function applyBatchToAllSeats() {
    setSeats((prev) =>
      prev.map((s) => ({
        ...s,
        provider: batch.provider,
        baseUrl: batch.baseUrl,
        model: batch.model,
        apiKey: batch.apiKey,
      })),
    )
  }

  // ------------------------------------------------------------------
  // API 存档：载入 / 保存 / 覆盖写回 / 删除；座位勾选与定向应用
  // ------------------------------------------------------------------

  /** 选中存档：载入到批量配置编辑框（仅载入，不写回；可再临时调整如模型规格） */
  function handleSelectPreset(id: string) {
    setSelectedPresetId(id)
    setPresetMsg(null)
    if (!id) return
    const preset = presets.find((p) => String(p.id) === id)
    if (preset) {
      setBatch({
        provider: preset.provider,
        baseUrl: preset.baseUrl,
        model: preset.model,
        apiKey: preset.apiKey,
      })
    }
  }

  /** 1. 存档保存：Provider 切换联动预设 */
  function handleSaveFormProviderChange(provider: AiProvider) {
    // 仅联动 Base URL；Model 不自动填充（模型规格更新快，自动填充易误导）
    const preset = getProviderPreset(provider)
    setSaveForm((prev) => ({ ...prev, provider, baseUrl: preset.baseUrl }))
  }

  /** 打开保存弹窗：预填建议存档名（保存表单的模型） */
  function openSaveDialog() {
    setSaveName(saveForm.model ? `${saveForm.model}` : `${saveForm.provider} 存档`)
    setSaveDialogOpen(true)
  }

  /** 保存「存档保存」表单内容为新存档（弹窗确认，内容入库归类） */
  async function handleSavePresetAs() {
    const name = saveName.trim()
    if (!name || presetBusy) return
    if (!userId) {
      // 未登录：写入本地存档库（登录后自动上传到云端）
      const created = createLocalPreset({ name, ...saveForm })
      setPresets((prev) => [created, ...prev.filter((p) => p.id !== created.id)])
      setSelectedPresetId(String(created.id))
      setSaveDialogOpen(false)
      // 保存后同步载入到「2. 存档选取」，用户可立即测试与应用
      setBatch({ provider: created.provider, baseUrl: created.baseUrl, model: created.model, apiKey: created.apiKey })
      setPresetMsg(`已保存存档「${created.name}」并载入到「2. 存档选取」（本地存档，登录后自动同步云端）`)
      return
    }
    setPresetBusy(true)
    setPresetMsg(null)
    try {
      const created = await api.createPreset({ name, ...saveForm })
      setPresets((prev) => [created, ...prev.filter((p) => p.id !== created.id)])
      setSelectedPresetId(String(created.id))
      setSaveDialogOpen(false)
      // 保存后同步载入到「2. 存档选取」，用户可立即测试与应用
      setBatch({ provider: created.provider, baseUrl: created.baseUrl, model: created.model, apiKey: created.apiKey })
      setPresetMsg(`已保存存档「${created.name}」并载入到「2. 存档选取」`)
    } catch (err) {
      setPresetMsg(err instanceof Error ? err.message : '保存存档失败')
    } finally {
      setPresetBusy(false)
    }
  }

  /** 1. 存档编辑：测试保存表单的连接（不入库） */
  async function handleTestSaveForm() {
    setSaveTestState({ kind: 'testing' })
    try {
      const result = await api.testAiKey(saveForm)
      const latency = typeof result.latencyMs === 'number' ? `（${result.latencyMs}ms）` : ''
      setSaveTestState(
        result.ok
          ? { kind: 'ok', message: `${result.message}${latency}` }
          : { kind: 'fail', message: result.message },
      )
    } catch (err) {
      setSaveTestState({ kind: 'fail', message: err instanceof Error ? err.message : '测试失败' })
    }
  }

  /** 1. 存档编辑：保存编辑弹窗的五要素回已有存档 */
  async function handleSaveEdit() {
    if (!editDialog || presetBusy) return
    if (!userId) {
      // 未登录：更新本地存档库
      const { id, name, provider, baseUrl, model, apiKey } = editDialog
      const updated = updateLocalPreset(id, { name, provider, baseUrl, model, apiKey })
      if (updated) {
        setPresets((prev) => prev.map((p) => (p.id === updated.id ? updated : p)))
        setEditDialog(null)
        setPresetMsg(`已更新存档「${updated.name}」（本地存档，登录后自动同步云端）`)
      }
      return
    }
    setPresetBusy(true)
    setPresetMsg(null)
    try {
      const { id, name, provider, baseUrl, model, apiKey } = editDialog
      const updated = await api.updatePreset(id, { name, provider, baseUrl, model, apiKey })
      if (updated) {
        setPresets((prev) => prev.map((p) => (p.id === updated.id ? updated : p)))
        setEditDialog(null)
        setPresetMsg(`已更新存档「${updated.name}」`)
      }
    } catch (err) {
      setPresetMsg(err instanceof Error ? err.message : '更新存档失败')
    } finally {
      setPresetBusy(false)
    }
  }

  /** 1. 存档编辑：删除全部存档（无论是否勾选） */
  async function handleDeleteAllPresets() {
    if (presetBusy) return
    if (!userId) {
      // 未登录：清空本地存档库
      saveLocalPresets([])
      setPresets([])
      setSelectedPresetId('')
      setAnalyst((prev) => ({ ...prev, presetId: '', presetConfig: null }))
      setDeleteMode(false)
      setDeleteChecked(new Set())
      setPresetMsg('全部存档已删除')
      return
    }
    setPresetBusy(true)
    setPresetMsg(null)
    try {
      for (const p of presets) await api.deletePreset(p.id)
      setPresets([])
      setSelectedPresetId('')
      setAnalyst((prev) => ({ ...prev, presetId: '', presetConfig: null }))
      setDeleteMode(false)
      setDeleteChecked(new Set())
      setPresetMsg('全部存档已删除')
    } catch (err) {
      setPresetMsg(err instanceof Error ? err.message : '删除全部存档失败')
    } finally {
      setPresetBusy(false)
    }
  }

  /** 1. 存档编辑：删除勾选的存档 */
  async function handleDeleteCheckedPresets() {
    if (presetBusy || deleteChecked.size === 0) return
    if (!userId) {
      // 未登录：从本地存档库删除勾选项
      const next = deleteLocalPresets(deleteChecked)
      setPresets(next)
      if (deleteChecked.has(Number(selectedPresetId))) setSelectedPresetId('')
      setAnalyst((prev) =>
        prev.presetId && deleteChecked.has(Number(prev.presetId))
          ? { ...prev, presetId: '', presetConfig: null }
          : prev,
      )
      setDeleteChecked(new Set())
      setPresetMsg(`已删除 ${deleteChecked.size} 个存档`)
      return
    }
    setPresetBusy(true)
    setPresetMsg(null)
    try {
      for (const id of deleteChecked) await api.deletePreset(id)
      setPresets((prev) => prev.filter((p) => !deleteChecked.has(p.id)))
      if (deleteChecked.has(Number(selectedPresetId))) setSelectedPresetId('')
      setAnalyst((prev) =>
        prev.presetId && deleteChecked.has(Number(prev.presetId))
          ? { ...prev, presetId: '', presetConfig: null }
          : prev,
      )
      setDeleteChecked(new Set())
      setPresetMsg(`已删除 ${deleteChecked.size} 个存档`)
    } catch (err) {
      setPresetMsg(err instanceof Error ? err.message : '删除勾选存档失败')
    } finally {
      setPresetBusy(false)
    }
  }

  /** 存档勾选切换（删除模式） */
  function toggleDeleteCheck(id: number) {
    setDeleteChecked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  /** 1. 存档编辑：测试某一行存档的连接（结果显示在测试键旁） */
  async function handleTestRow(p: ApiPreset) {
    setRowTests((prev) => ({ ...prev, [p.id]: { kind: 'testing' } }))
    try {
      const result = await api.testAiKey(p)
      const latency = typeof result.latencyMs === 'number' ? `（${result.latencyMs}ms）` : ''
      setRowTests((prev) => ({
        ...prev,
        [p.id]: result.ok
          ? { kind: 'ok', message: `${result.message}${latency}` }
          : { kind: 'fail', message: result.message },
      }))
    } catch (err) {
      setRowTests((prev) => ({
        ...prev,
        [p.id]: { kind: 'fail', message: err instanceof Error ? err.message : '测试失败' },
      }))
    }
  }

  /** 座位勾选切换 */
  function toggleSeatCheck(seatNo: number) {
    setCheckedSeats((prev) => {
      const next = new Set(prev)
      if (next.has(seatNo)) next.delete(seatNo)
      else next.add(seatNo)
      return next
    })
  }

  /** 把批量配置一键应用到勾选的座位（混合 AI 部署的核心路径） */
  function applyBatchToCheckedSeats() {
    setSeats((prev) =>
      prev.map((s) =>
        checkedSeats.has(s.seat)
          ? { ...s, provider: batch.provider, baseUrl: batch.baseUrl, model: batch.model, apiKey: batch.apiKey }
          : s,
      ),
    )
    setCheckedSeats(new Set()) // 应用后勾选自动消失
  }

  /** 随机应用存档到座位：在尽可能把全部存档用上的前提下，随机给座位分配 AI 模型 */
  function applyRandomPresets() {
    if (presets.length === 0) {
      setPresetMsg('存档库为空，请先在第 1 部分保存存档')
      return
    }
    const shuffledPresets = [...presets].sort(() => Math.random() - 0.5)
    setSeats((prev) => {
      const shuffledSeats = [...prev].sort(() => Math.random() - 0.5)
      const assignment = new Map<number, (typeof presets)[number]>()
      if (shuffledPresets.length <= shuffledSeats.length) {
        // 存档数 ≤ 座位数：每个存档至少用上 1 次，剩余座位再随机分配存档
        shuffledSeats.forEach((s, i) => {
          assignment.set(
            s.seat,
            i < shuffledPresets.length
              ? shuffledPresets[i]
              : shuffledPresets[Math.floor(Math.random() * shuffledPresets.length)],
          )
        })
      } else {
        // 存档数 > 座位数：随机挑选尽可能多的存档
        shuffledSeats.forEach((s, i) => assignment.set(s.seat, shuffledPresets[i]))
      }
      return prev.map((s) => {
        const p = assignment.get(s.seat)!
        return { ...s, provider: p.provider, baseUrl: p.baseUrl, model: p.model, apiKey: p.apiKey }
      })
    })
    setPresetMsg(
      `已把 ${Math.min(shuffledPresets.length, seats.length)} 个存档随机应用到全部座位`,
    )
  }

  function updateSeat(seatNo: number, patch: Partial<SeatAiConfig>) {
    setSeats((prev) => prev.map((s) => (s.seat === seatNo ? { ...s, ...patch } : s)))
  }

  function handleSeatProviderChange(seatNo: number, provider: AiProvider) {
    // 仅联动 Base URL；Model 不自动填充（模型规格更新快，自动填充易误导）
    const preset = getProviderPreset(provider)
    updateSeat(seatNo, { provider, baseUrl: preset.baseUrl })
  }

  /** 2. 存档选取：选中存档后自动被动测试连接（结果展示在选择栏旁） */
  useEffect(() => {
    if (!selectedPresetId) {
      setPresetTestState({ kind: 'idle' })
      return
    }
    const preset = presets.find((p) => String(p.id) === selectedPresetId)
    if (!preset) {
      setPresetTestState({ kind: 'idle' })
      return
    }
    let cancelled = false
    setPresetTestState({ kind: 'testing' })
    api
      .testAiKey(preset)
      .then((result) => {
        if (cancelled) return
        const latency = typeof result.latencyMs === 'number' ? `（${result.latencyMs}ms）` : ''
        setPresetTestState(
          result.ok
            ? { kind: 'ok', message: `${result.message}${latency}` }
            : { kind: 'fail', message: result.message },
        )
      })
      .catch((err) => {
        if (!cancelled)
          setPresetTestState({
            kind: 'fail',
            message: err instanceof Error ? err.message : '测试失败',
          })
      })
    return () => {
      cancelled = true
    }
  }, [selectedPresetId, presets, api])

  /** 分析师-选择存档：选中存档后自动被动测试连接（结果显示在选取栏旁） */
  useEffect(() => {
    if (!analyst.usePreset || !analyst.presetId || !analyst.presetConfig) {
      setAnalystPresetTestState({ kind: 'idle' })
      return
    }
    let cancelled = false
    setAnalystPresetTestState({ kind: 'testing' })
    api
      .testAiKey(analyst.presetConfig)
      .then((result) => {
        if (cancelled) return
        const latency = typeof result.latencyMs === 'number' ? `（${result.latencyMs}ms）` : ''
        setAnalystPresetTestState(
          result.ok
            ? { kind: 'ok', message: `${result.message}${latency}` }
            : { kind: 'fail', message: result.message },
        )
      })
      .catch((err) => {
        if (!cancelled)
          setAnalystPresetTestState({
            kind: 'fail',
            message: err instanceof Error ? err.message : '测试失败',
          })
      })
    return () => {
      cancelled = true
    }
  }, [analyst.usePreset, analyst.presetId, analyst.presetConfig, api])

  /** 分析师：选择存档（拷贝四要素快照，观察室离线可用） */
  function handleAnalystPresetSelect(id: string) {
    const preset = presets.find((p) => String(p.id) === id)
    setAnalyst((prev) => ({
      ...prev,
      presetId: id,
      presetConfig: preset
        ? {
            provider: preset.provider,
            baseUrl: preset.baseUrl,
            model: preset.model,
            apiKey: preset.apiKey,
          }
        : null,
    }))
  }

  /** 分析师-定制选项：测试连接（手动按钮） */
  async function handleTestAnalyst() {
    setAnalystTestState({ kind: 'testing' })
    try {
      const result = await api.testAiKey({
        provider: analyst.provider,
        baseUrl: analyst.baseUrl,
        model: analyst.model,
        apiKey: analyst.apiKey,
      })
      const latency = typeof result.latencyMs === 'number' ? `（${result.latencyMs}ms）` : ''
      setAnalystTestState(
        result.ok
          ? { kind: 'ok', message: `${result.message}${latency}` }
          : { kind: 'fail', message: result.message },
      )
    } catch (err) {
      setAnalystTestState({ kind: 'fail', message: err instanceof Error ? err.message : '测试失败' })
    }
  }

  /** 分析师-定制选项：保存应用（四要素持久化，切换选择存档开关不丢失） */
  function handleAnalystSave() {
    saveAnalystSettings(analyst)
    setAnalystSavedMsg(true)
    setTimeout(() => setAnalystSavedMsg(false), 2000)
  }

  async function handleCreateGame() {
    if (creating) return
    if (!selectedBoard) {
      setCreateError('版型列表尚未加载完成，请稍候再试')
      return
    }
    const incomplete = seats.find(
      (s) => !s.model.trim() || !s.apiKey.trim() || (s.provider !== 'anthropic' && !s.baseUrl.trim()),
    )
    if (incomplete) {
      setCreateError(`座位 ${incomplete.seat} 尚未填写完整（Base URL / 模型 / API Key），请补全后再创建对局`)
      return
    }
    setCreating(true)
    setCreateError(null)
    try {
      // 分析师配置完整则随对局创建提交（对局结束自动复盘并沉淀指南）；
      // 配置推导为空（如开了「选择存档」却未选、定制项也不完整）时回落到座位批量配置
      const analystAi =
        buildAnalystConfig(analyst) ??
        (batch.model.trim() && batch.apiKey.trim() && (batch.provider === 'anthropic' || batch.baseUrl.trim())
          ? { ...batch, autoGenerate: analyst.autoGenerate }
          : null)
      const result = await api.createGame({
        boardId: selectedBoard.id,
        seats,
        options,
        analystAi,
        winRateEnabled: analyst.winRateEnabled,
        // 人格研究库：座位人格绑定（拖拽自人格卡库；绑定座位以该人格参赛）
        ...(Object.keys(seatPersonas).length > 0
          ? {
              seatPersonas: Object.entries(seatPersonas).map(([seat, personaId]) => ({
                seat: Number(seat),
                personaId,
              })),
            }
          : {}),
      })
      navigate(`/game/${result.gameId}`)
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : '创建对局失败，请重试')
      setCreating(false)
    }
  }

  function handleAnalystProviderChange(provider: AiProvider) {
    // 仅联动 Base URL；Model 不自动填充（模型规格更新快，自动填充易误导）
    const preset = getProviderPreset(provider)
    setAnalyst((prev) => ({ ...prev, provider, baseUrl: preset.baseUrl }))
  }

  // ------------------------------------------------------------------
  // 渲染
  // ------------------------------------------------------------------

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      {/* 1. 顶部标题栏 */}
      <section className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          AI模拟狼人杀研究平台
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          全AI驱动 · 博弈论与心理学研究沙盒
        </p>
      </section>

      {/* 2. 版型选择区 */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-lg">选择版型</CardTitle>
          <CardDescription>选择后座位数与警长设置自动匹配</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {boards.map((board) => {
              const active = board.id === selectedBoardId
              const breakdown = boardRoleBreakdown(board)
              return (
                <button
                  key={board.id}
                  type="button"
                  onClick={() => handleSelectBoard(board)}
                  aria-pressed={active}
                  className={cn(
                    'flex h-full flex-col gap-2 rounded-lg border bg-card p-4 text-left transition-colors',
                    active
                      ? 'border-good ring-1 ring-good'
                      : 'border-border hover:border-muted-foreground/40',
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-foreground">{board.name}</span>
                    <Badge variant={active ? 'default' : 'secondary'}>{board.playerCount}人局</Badge>
                  </div>
                  <p className="text-sm text-muted-foreground">{board.summary}</p>
                  <p className="text-xs leading-5">
                    <span className="text-god">神职：{breakdown.gods.join('、')}</span>
                    <span className="mx-1 text-border">|</span>
                    <span className="text-wolf">狼方：{breakdown.wolves.join('、')}</span>
                    <span className="mx-1 text-border">|</span>
                    <span className="text-villager">平民×{breakdown.villagerCount}</span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {board.sheriff ? '有警长' : '无警长'} · 女巫
                    {board.witchSelfSave === 'firstNight' ? '首夜可自救' : '全程不可自救'}
                  </p>
                </button>
              )
            })}
            {boards.length === 0 ? (
              <p className="col-span-full py-6 text-center text-sm text-muted-foreground">
                版型加载中…
              </p>
            ) : null}
          </div>
        </CardContent>
      </Card>

      {/* 3. AI 接入配置区 */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-lg">AI 接入配置</CardTitle>
          <CardDescription className="flex items-center gap-1.5">
            <ShieldCheck className="h-4 w-4 text-good" aria-hidden />
            工作配置保存在本浏览器，存档保存在数据库、多端共享
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* ============ 1. 存档编辑：四要素输入 + 测试连接 + 保存入库 + 全部存档表栏 ============ */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">1. 存档编辑</span>
              <span className="text-xs text-muted-foreground">
                填入 API 四要素，可测试连接，命名后保存入库
              </span>
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-[180px_1fr_1fr_1fr_auto]">
              <div className="space-y-1.5">
                <Label htmlFor="save-provider">Provider</Label>
                <Select
                  value={saveForm.provider}
                  onValueChange={(v) => handleSaveFormProviderChange(v as AiProvider)}
                >
                  <SelectTrigger id="save-provider">
                    <SelectValue placeholder="选择 Provider" />
                  </SelectTrigger>
                  <SelectContent>
                    {PROVIDER_LIST.map((p) => (
                      <SelectItem key={p.provider} value={p.provider}>
                        {p.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="save-baseurl">Base URL</Label>
                <Input
                  id="save-baseurl"
                  value={saveForm.baseUrl}
                  onChange={(e) => setSaveForm((prev) => ({ ...prev, baseUrl: e.target.value }))}
                  placeholder="https://api.example.com/v1"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="save-model">Model</Label>
                <Input
                  id="save-model"
                  value={saveForm.model}
                  onChange={(e) => setSaveForm((prev) => ({ ...prev, model: e.target.value }))}
                  placeholder="模型名称"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="save-key">API Key</Label>
                <Input
                  id="save-key"
                  type="password"
                  value={saveForm.apiKey}
                  onChange={(e) => setSaveForm((prev) => ({ ...prev, apiKey: e.target.value }))}
                  placeholder="sk-..."
                  autoComplete="off"
                />
              </div>
              <div className="flex items-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void handleTestSaveForm()}
                  disabled={saveTestState.kind === 'testing'}
                >
                  {saveTestState.kind === 'testing' ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  ) : null}
                  测试连接
                </Button>
                <Button type="button" onClick={openSaveDialog}>
                  保存为存档…
                </Button>
              </div>
            </div>
            {saveTestState.kind === 'ok' ? (
              <p className="flex items-center gap-1.5 text-sm text-good">
                <CheckCircle2 className="h-4 w-4" aria-hidden />
                连接成功：{saveTestState.message}
              </p>
            ) : null}
            {saveTestState.kind === 'fail' ? (
              <p className="flex items-center gap-1.5 text-sm text-wolf">
                <CircleAlert className="h-4 w-4" aria-hidden />
                连接失败：{saveTestState.message}
              </p>
            ) : null}
            {presetMsg ? <p className="text-xs text-muted-foreground">{presetMsg}</p> : null}

            {/* 全部存档表栏：查看 / 编辑五要素 / 删除特定 / 删除全部 */}
            <div className="rounded-md border border-border">
              <div className="flex items-center gap-2 border-b border-border px-3 py-2">
                <span className="text-xs font-medium text-foreground">
                  全部存档（{presets.length}）
                </span>
                <span className="flex-1" />
                {presets.length > 0 ? (
                  deleteMode ? (
                    <>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7 px-2 text-xs text-wolf"
                        onClick={() => void handleDeleteAllPresets()}
                        disabled={presetBusy}
                      >
                        全部删除
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7 px-2 text-xs text-wolf"
                        onClick={() => void handleDeleteCheckedPresets()}
                        disabled={presetBusy || deleteChecked.size === 0}
                      >
                        选定删除（{deleteChecked.size}）
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        onClick={() => {
                          setDeleteMode(false)
                          setDeleteChecked(new Set())
                        }}
                      >
                        取消
                      </Button>
                    </>
                  ) : (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs text-wolf"
                      onClick={() => setDeleteMode(true)}
                    >
                      删除
                    </Button>
                  )
                ) : null}
              </div>
              {presets.length === 0 ? (
                <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                  暂无存档，先在上方填写四要素并保存
                </p>
              ) : (
                <div className="max-h-[320px] overflow-auto">
                  <Table>
                    <TableHeader className="sticky top-0 bg-card">
                      <TableRow>
                        {deleteMode ? <TableHead className="w-10" /> : null}
                        <TableHead className="w-36">命名</TableHead>
                        <TableHead className="w-28">Provider</TableHead>
                        <TableHead className="hidden md:table-cell">Base URL</TableHead>
                        <TableHead>Model</TableHead>
                        <TableHead className="hidden w-28 md:table-cell">API Key</TableHead>
                        <TableHead className="w-56">操作</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {presets.map((p) => {
                        const rowTest = rowTests[p.id]
                        return (
                        <TableRow key={p.id}>
                          {deleteMode ? (
                            <TableCell>
                              <Checkbox
                                checked={deleteChecked.has(p.id)}
                                onCheckedChange={() => toggleDeleteCheck(p.id)}
                                aria-label={`勾选存档 ${p.name}`}
                              />
                            </TableCell>
                          ) : null}
                          <TableCell className="text-sm font-medium">{p.name}</TableCell>
                          <TableCell className="text-xs">{p.provider}</TableCell>
                          <TableCell className="hidden max-w-56 truncate text-xs text-muted-foreground md:table-cell">
                            {p.baseUrl || '—'}
                          </TableCell>
                          <TableCell className="max-w-40 truncate text-xs">{p.model}</TableCell>
                          <TableCell className="hidden font-mono text-xs text-muted-foreground md:table-cell">
                            {p.apiKey ? `••••${p.apiKey.slice(-4)}` : '—'}
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-1.5">
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="h-7 px-2 text-xs"
                                onClick={() =>
                                  setEditDialog({
                                    id: p.id,
                                    name: p.name,
                                    provider: p.provider,
                                    baseUrl: p.baseUrl,
                                    model: p.model,
                                    apiKey: p.apiKey,
                                  })
                                }
                              >
                                编辑
                              </Button>
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="h-7 px-2 text-xs"
                                onClick={() => void handleTestRow(p)}
                                disabled={rowTest?.kind === 'testing'}
                              >
                                {rowTest?.kind === 'testing' ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                                ) : null}
                                测试
                              </Button>
                              {rowTest?.kind === 'ok' ? (
                                <span
                                  className="max-w-40 truncate text-xs text-good"
                                  title={rowTest.message}
                                >
                                  {rowTest.message}
                                </span>
                              ) : null}
                              {rowTest?.kind === 'fail' ? (
                                <span
                                  className="max-w-40 truncate text-xs text-wolf"
                                  title={rowTest.message}
                                >
                                  {rowTest.message}
                                </span>
                              ) : null}
                            </div>
                          </TableCell>
                        </TableRow>
                        )
                      })}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          </div>

          {/* ============ 2. 存档选取：选择存档 + 查看其全部信息 + 选中后自动被动测试 ============ */}
          <div className="space-y-3 border-t border-border/60 pt-4">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">2. 存档选取</span>
              <span className="text-xs text-muted-foreground">
                选择存档后即自动测试连接，全部信息只读查看
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Select value={selectedPresetId} onValueChange={handleSelectPreset}>
                <SelectTrigger className="w-full sm:w-72">
                  <SelectValue placeholder="选择存档" />
                </SelectTrigger>
                <SelectContent>
                  {presets.length === 0 ? (
                    <SelectItem value="__empty__" disabled>
                      暂无存档，先在第 1 部分保存
                    </SelectItem>
                  ) : (
                    presets.map((p) => (
                      <SelectItem key={p.id} value={String(p.id)}>
                        {p.name}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
              {/* 被动连接状态：选择存档后自动测试，成功绿字附延迟、失败红字附事由（限宽截断，与选择框保持距离防重叠） */}
              {presetTestState.kind === 'testing' ? (
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                  正在测试连接…
                </span>
              ) : null}
              {presetTestState.kind === 'ok' ? (
                <span
                  className="flex max-w-md items-center gap-1.5 truncate text-xs text-good"
                  title={presetTestState.message}
                >
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  <span className="truncate">连接成功：{presetTestState.message}</span>
                </span>
              ) : null}
              {presetTestState.kind === 'fail' ? (
                <span
                  className="flex max-w-md items-center gap-1.5 text-xs text-wolf"
                  title={presetTestState.message}
                >
                  <CircleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  <span className="truncate">连接失败：{presetTestState.message}</span>
                </span>
              ) : null}
            </div>
            {selectedPreset ? (
              <div className="grid grid-cols-1 gap-2 rounded-md border border-border bg-muted/30 px-3 py-2.5 text-xs sm:grid-cols-2 xl:grid-cols-4">
                <div>
                  <span className="text-muted-foreground">Provider：</span>
                  <span className="text-foreground">{selectedPreset.provider}</span>
                </div>
                <div className="truncate">
                  <span className="text-muted-foreground">Base URL：</span>
                  <span className="text-foreground">{selectedPreset.baseUrl || '—'}</span>
                </div>
                <div className="truncate">
                  <span className="text-muted-foreground">Model：</span>
                  <span className="text-foreground">{selectedPreset.model}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">API Key：</span>
                  <span className="font-mono text-foreground">
                    {selectedPreset.apiKey ? `••••${selectedPreset.apiKey.slice(-4)}` : '—'}
                  </span>
                </div>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                未选择存档——从下拉框选择后，其配置将作为第 3 部分应用的来源
              </p>
            )}
          </div>

          {/* ============ 3. 存档应用：应用交互（一个/多个/全部）+ 玩家列表 ============ */}
          <div className="space-y-3 border-t border-border/60 pt-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">3. 存档应用</span>
              <span className="text-xs text-muted-foreground">
                把上方配置一键应用到勾选或全部座位
              </span>
              <span className="flex-1" />
              <span className="text-xs text-muted-foreground">
                当前配置来源：
                {selectedPreset ? (
                  <span className="font-medium text-foreground">
                    存档「{selectedPreset.name}」（{selectedPreset.model || selectedPreset.provider}）
                  </span>
                ) : (
                  '未选择存档（浏览器内工作配置）'
                )}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => setCheckedSeats(new Set(seats.map((s) => s.seat)))}
              >
                全选
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => setCheckedSeats(new Set())}
              >
                清空
              </Button>
              <span className="text-xs text-muted-foreground">已选 {checkedSeats.size} 座</span>
              <Button
                type="button"
                size="sm"
                onClick={applyBatchToCheckedSeats}
                disabled={checkedSeats.size === 0}
                title="把第 2 部分配置一键应用到勾选座位"
              >
                应用到勾选座位
              </Button>
              <span className="text-xs text-muted-foreground">或</span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={applyBatchToAllSeats}
                title="把第 2 部分配置一键应用到全部座位"
              >
                应用到全部座位
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={applyRandomPresets}
                disabled={presets.length === 0}
                title="在尽可能用上全部存档的前提下，随机给座位分配 AI 模型"
              >
                随机应用存档到座位
              </Button>
            </div>
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_300px]">
            {/* 座位表（人格投放目标：从右侧人格卡库拖卡入行即绑定） */}
            <div className="max-h-[420px] overflow-auto rounded-md border border-border">
            <Table>
              <TableHeader className="sticky top-0 bg-card">
                <TableRow>
                  <TableHead className="w-10" />
                  <TableHead className="w-16">座位号</TableHead>
                  <TableHead className="w-44">Provider</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead>API Key</TableHead>
                  <TableHead className="w-40">人格</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {seats.map((seat) => {
                  const boundId = seatPersonas[seat.seat]
                  const boundPersona = boundId ? personaList.find((p) => p.id === boundId) : null
                  return (
                  <TableRow
                    key={seat.seat}
                    onDragOver={(e) => {
                      if (e.dataTransfer.types.includes('application/x-persona-id')) {
                        e.preventDefault()
                        setPersonaDragOver(seat.seat)
                      }
                    }}
                    onDragLeave={() => setPersonaDragOver((v) => (v === seat.seat ? null : v))}
                    onDrop={(e) => {
                      const raw = e.dataTransfer.getData('application/x-persona-id')
                      if (raw) {
                        e.preventDefault()
                        assignPersona(seat.seat, Number(raw))
                      }
                      setPersonaDragOver(null)
                    }}
                    className={cn(personaDragOver === seat.seat && 'bg-god/5 ring-1 ring-inset ring-god/50')}
                  >
                    <TableCell>
                      <Checkbox
                        checked={checkedSeats.has(seat.seat)}
                        onCheckedChange={() => toggleSeatCheck(seat.seat)}
                        aria-label={`勾选座位 ${seat.seat}`}
                      />
                    </TableCell>
                    <TableCell className="font-mono text-sm">{seat.seat}</TableCell>
                    <TableCell>
                      <Select
                        value={seat.provider}
                        onValueChange={(v) => handleSeatProviderChange(seat.seat, v as AiProvider)}
                      >
                        <SelectTrigger className="h-8 min-w-36">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {PROVIDER_LIST.map((p) => (
                            <SelectItem key={p.provider} value={p.provider}>
                              {p.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell>
                      <Input
                        className="h-8 min-w-28"
                        value={seat.model}
                        onChange={(e) => updateSeat(seat.seat, { model: e.target.value })}
                        placeholder="模型名称"
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        className="h-8 min-w-28"
                        type="password"
                        value={seat.apiKey}
                        onChange={(e) => updateSeat(seat.seat, { apiKey: e.target.value })}
                        placeholder="sk-..."
                        autoComplete="off"
                      />
                    </TableCell>
                    <TableCell>
                      {boundId ? (
                        <span className="flex items-center gap-1">
                          <span className="flex items-center gap-1 rounded-full border border-god/50 bg-god/10 px-2 py-0.5 text-xs text-god">
                            <Fingerprint className="h-3 w-3 shrink-0" aria-hidden />
                            <span className="max-w-24 truncate" title={boundPersona?.name ?? `人格#${boundId}`}>
                              {boundPersona?.name ?? `人格#${boundId}`}
                            </span>
                            <button
                              type="button"
                              aria-label={`移除座位 ${seat.seat} 的人格绑定`}
                              className="shrink-0 rounded-full hover:bg-god/20"
                              onClick={() => unassignPersona(seat.seat)}
                            >
                              <X className="h-3 w-3" aria-hidden />
                            </button>
                          </span>
                          {/* 部分可见档：给该人格玩家上迷雾（被其他人格玩家视为迷雾；TA 自己知道） */}
                          {(options.personaVisibility ?? 'full') === 'partial' ? (
                            <label
                              className="flex cursor-pointer items-center gap-1 text-[11px] text-muted-foreground"
                              title="上迷雾：其他有人格的玩家将不知道 TA 的人格姓名（TA 自己知道自己在雾里）"
                            >
                              <Checkbox
                                checked={(options.personaFogSeats ?? []).includes(seat.seat)}
                                onCheckedChange={() => toggleFogSeat(seat.seat)}
                                aria-label={`给座位 ${seat.seat} 上迷雾`}
                              />
                              迷雾
                            </label>
                          ) : null}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground/60">拖入人格卡</span>
                      )}
                    </TableCell>
                  </TableRow>
                  )
                })}
              </TableBody>
            </Table>
            </div>

            {/* 人格卡库（拖拽源；点击卡片可查看/前往管理） */}
            <div className="flex max-h-[420px] flex-col rounded-md border border-border">
              <div className="flex items-center gap-2 border-b border-border px-3 py-2">
                <Fingerprint className="h-4 w-4 text-god" aria-hidden />
                <span className="text-xs font-medium text-foreground">人格卡库</span>
                <span className="text-[10px] text-muted-foreground">拖入座位即以其人格参赛</span>
                <span className="flex-1" />
                <Link to="/personas" className="text-xs text-foreground underline underline-offset-2">
                  管理
                </Link>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-2">
                {!userId ? (
                  <p className="px-2 py-6 text-center text-xs text-muted-foreground">
                    登录后可使用人格研究库
                  </p>
                ) : personaList.length === 0 ? (
                  <p className="px-2 py-6 text-center text-xs text-muted-foreground">
                    还没有人格卡。到
                    <Link to="/personas" className="mx-1 text-foreground underline underline-offset-2">
                      人格研究库
                    </Link>
                    手动建卡或 AI 铸造。
                  </p>
                ) : (
                  <ul className="space-y-1.5">
                    {personaList.map((p) => {
                      const usedSeat = Object.entries(seatPersonas).find(([, id]) => id === p.id)?.[0]
                      return (
                        <li
                          key={p.id}
                          draggable
                          onDragStart={(e) => {
                            e.dataTransfer.setData('application/x-persona-id', String(p.id))
                            e.dataTransfer.effectAllowed = 'move'
                          }}
                          onDragEnd={() => setPersonaDragOver(null)}
                          className={cn(
                            'cursor-grab rounded-md border px-2.5 py-2 transition-colors active:cursor-grabbing',
                            usedSeat
                              ? 'border-god/60 bg-god/10'
                              : 'border-border bg-card hover:border-god/50',
                          )}
                          title={`拖到座位行即绑定（${p.name}）`}
                        >
                          <div className="flex items-center gap-1.5">
                            <Fingerprint className="h-3.5 w-3.5 shrink-0 text-god" aria-hidden />
                            <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
                              {p.name}
                            </span>
                            {p.source === 'ai-cast' ? (
                              <Badge variant="outline" className="px-1 text-[9px] font-normal">AI</Badge>
                            ) : null}
                          </div>
                          <div className="mt-0.5 flex items-center gap-1 text-[10px] text-muted-foreground">
                            {p.originName ? <span className="truncate">{p.originName}</span> : <span>原创人格</span>}
                            {usedSeat ? <span className="ml-auto shrink-0 text-god">已入座 {usedSeat}号</span> : null}
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            共 {seats.length} 个座位，也可直接在行内单独修改
            {Object.keys(seatPersonas).length > 0
              ? `；已绑定 ${Object.keys(seatPersonas).length} 个人格（对局中该座位的一切言行都由其人格驱动）`
              : ''}
          </p>
          </div>
        </CardContent>
      </Card>

      {/* 3.5 分析师配置 */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-lg">分析师配置</CardTitle>
          <CardDescription>
            赛后自动复盘生成分析报告，并把经验沉淀到
            <Link to="/guide" className="mx-1 text-foreground underline underline-offset-2">
              经验指南
            </Link>
            ，建议长上下文模型（如 kimi-k2.5）
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* 选择存档：开关默认开启，从存档库调用已有存档作为分析师配置 */}
          <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
            <Label htmlFor="analyst-use-preset" className="cursor-pointer">
              选择存档
              <span className="ml-2 text-xs text-muted-foreground">
                从存档库调用已有存档；关闭则改用下方定制选项
              </span>
            </Label>
            <Switch
              id="analyst-use-preset"
              checked={analyst.usePreset}
              onCheckedChange={(checked) =>
                setAnalyst((prev) => ({ ...prev, usePreset: checked }))
              }
            />
          </div>

          {analyst.usePreset ? (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <Select value={analyst.presetId} onValueChange={handleAnalystPresetSelect}>
                  <SelectTrigger className="w-full sm:w-96">
                    <SelectValue placeholder="从存档库选择存档" />
                  </SelectTrigger>
                  <SelectContent>
                    {presets.length === 0 ? (
                      <SelectItem value="__empty__" disabled>
                        暂无存档，先在第 1 部分保存
                      </SelectItem>
                    ) : (
                      presets.map((p) => (
                        <SelectItem key={p.id} value={String(p.id)}>
                          {p.name}
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
                {/* 被动连接状态：选择存档后自动测试，成功绿字附延迟、失败红字附事由 */}
                {analystPresetTestState.kind === 'testing' ? (
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                    正在测试连接…
                  </span>
                ) : null}
                {analystPresetTestState.kind === 'ok' ? (
                  <span
                    className="flex max-w-md items-center gap-1.5 text-xs text-good"
                    title={analystPresetTestState.message}
                  >
                    <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    <span className="truncate">连接成功：{analystPresetTestState.message}</span>
                  </span>
                ) : null}
                {analystPresetTestState.kind === 'fail' ? (
                  <span
                    className="flex max-w-md items-center gap-1.5 text-xs text-wolf"
                    title={analystPresetTestState.message}
                  >
                    <CircleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    <span className="truncate">连接失败：{analystPresetTestState.message}</span>
                  </span>
                ) : null}
              </div>
              {analyst.presetConfig ? (
                <p className="text-xs text-muted-foreground">
                  {presets.find((p) => String(p.id) === analyst.presetId)?.name ?? '已选存档'}：
                  {analyst.presetConfig.provider} · {analyst.presetConfig.baseUrl || '—'} ·{' '}
                  {analyst.presetConfig.model} · Key ••••{analyst.presetConfig.apiKey.slice(-4)}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  未选择存档——将依次回退到「定制选项」/ 座位批量配置（若已填写完整）
                </p>
              )}
            </div>
          ) : (
            /* 定制选项：选择存档开关关闭时出现，四要素可测试连接并保存应用（持久保存，开关切换不丢失） */
            <div className="space-y-3">
              <p className="text-xs font-medium text-muted-foreground">定制选项</p>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-[180px_1fr_1fr_1fr]">
                <div className="space-y-1.5">
                  <Label htmlFor="analyst-provider">Provider</Label>
                  <Select
                    value={analyst.provider}
                    onValueChange={(v) => handleAnalystProviderChange(v as AiProvider)}
                  >
                    <SelectTrigger id="analyst-provider">
                      <SelectValue placeholder="选择 Provider" />
                    </SelectTrigger>
                    <SelectContent>
                      {PROVIDER_LIST.map((p) => (
                        <SelectItem key={p.provider} value={p.provider}>
                          {p.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="analyst-baseurl">Base URL</Label>
                  <Input
                    id="analyst-baseurl"
                    value={analyst.baseUrl}
                    onChange={(e) =>
                      setAnalyst((prev) => ({ ...prev, baseUrl: e.target.value }))
                    }
                    placeholder="https://api.example.com/v1"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="analyst-model">Model</Label>
                  <Input
                    id="analyst-model"
                    value={analyst.model}
                    onChange={(e) => setAnalyst((prev) => ({ ...prev, model: e.target.value }))}
                    placeholder="长上下文模型，如 kimi-k2.5"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="analyst-key">API Key</Label>
                  <Input
                    id="analyst-key"
                    type="password"
                    value={analyst.apiKey}
                    onChange={(e) =>
                      setAnalyst((prev) => ({ ...prev, apiKey: e.target.value }))
                    }
                    placeholder="sk-..."
                    autoComplete="off"
                  />
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void handleTestAnalyst()}
                  disabled={analystTestState.kind === 'testing'}
                >
                  {analystTestState.kind === 'testing' ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  ) : null}
                  测试连接
                </Button>
                <Button type="button" size="sm" onClick={handleAnalystSave}>
                  保存应用
                </Button>
                {analystSavedMsg ? (
                  <span className="text-xs text-good">已保存应用</span>
                ) : null}
                {analystTestState.kind === 'ok' ? (
                  <span className="flex items-center gap-1.5 text-xs text-good">
                    <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
                    连接成功：{analystTestState.message}
                  </span>
                ) : null}
                {analystTestState.kind === 'fail' ? (
                  <span className="flex items-center gap-1.5 text-xs text-wolf">
                    <CircleAlert className="h-3.5 w-3.5" aria-hidden />
                    连接失败：{analystTestState.message}
                  </span>
                ) : null}
              </div>
            </div>
          )}

          {/* 报告生成方式：位置在选择存档/定制选项之下 */}
          <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
            <Label htmlFor="analyst-autogen" className="cursor-pointer">
              对局结束后自动生成报告
              <span className="ml-2 text-xs text-muted-foreground">
                关闭则仅在观察室手动生成
              </span>
            </Label>
            <Switch
              id="analyst-autogen"
              checked={analyst.autoGenerate}
              onCheckedChange={(checked) =>
                setAnalyst((prev) => ({ ...prev, autoGenerate: checked }))
              }
            />
          </div>

          {/* 胜率推测：对局中实时评估双方胜率（自创建对局时生效，创建后不可再改） */}
          <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
            <Label htmlFor="analyst-winrate" className="cursor-pointer">
              胜率推测
              <span className="ml-2 text-xs text-muted-foreground">
                对局中实时推测神民/狼人胜率并记录理由（自创建对局时生效）
              </span>
            </Label>
            <Switch
              id="analyst-winrate"
              checked={analyst.winRateEnabled}
              onCheckedChange={(checked) =>
                setAnalyst((prev) => ({ ...prev, winRateEnabled: checked }))
              }
            />
          </div>

          <p className="text-xs text-muted-foreground">
            当前分析师：
            {buildAnalystConfig(analyst) ? (
              <span className="text-good">已配置（{buildAnalystConfig(analyst)!.model}）</span>
            ) : (
              <span>未配置完整（仍可事后在对局页手动生成）</span>
            )}
          </p>
        </CardContent>
      </Card>

      {/* 4. 高级选项（可折叠） */}
      <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen} className="mb-6">
        <Card>
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex w-full items-center justify-between px-6 py-4 text-left"
            >
              <span className="text-base font-medium text-foreground">高级选项</span>
              <ChevronDown
                className={cn(
                  'h-4 w-4 text-muted-foreground transition-transform',
                  advancedOpen && 'rotate-180',
                )}
                aria-hidden
              />
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <CardContent className="grid grid-cols-1 gap-5 border-t border-border pt-5 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="opt-interval">每步操作间隔（秒）</Label>
                <Input
                  id="opt-interval"
                  type="number"
                  min={0.2}
                  max={30}
                  step={0.5}
                  value={options.stepDelayMs / 1000}
                  onChange={(e) =>
                    setOptions((prev) => ({
                      ...prev,
                      stepDelayMs:
                        Math.round(Number(e.target.value) * 1000) || DEFAULT_OPTIONS.stepDelayMs,
                    }))
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="opt-phase-break">日夜交界停歇（秒）</Label>
                <Input
                  id="opt-phase-break"
                  type="number"
                  min={0}
                  max={60}
                  step={1}
                  value={(options.phaseBreakMs ?? 5000) / 1000}
                  onChange={(e) =>
                    setOptions((prev) => ({
                      ...prev,
                      phaseBreakMs:
                        Math.round(Number(e.target.value) * 1000) ||
                        (Number(e.target.value) === 0 ? 0 : (DEFAULT_OPTIONS.phaseBreakMs ?? 5000)),
                    }))
                  }
                />
                <p className="text-xs text-muted-foreground">
                  一个夜/日的互动轮次结束后、进入下一日/夜前的阅读缓冲；0 = 不停歇
                </p>
              </div>
              <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
                <Label htmlFor="opt-ai-timelimit" className="cursor-pointer">
                  AI 互动限时
                  <span className="ml-2 text-xs text-muted-foreground">
                    单个决策点的最长等待（超时转托管） · 关闭=不限制 · DeepSeek 思考模式自动放宽至 260 秒下限
                  </span>
                </Label>
                <Switch
                  id="opt-ai-timelimit"
                  checked={(options.aiTimeLimitSec ?? 0) > 0}
                  onCheckedChange={(checked) =>
                    setOptions((prev) => ({
                      ...prev,
                      aiTimeLimitSec: checked ? 120 : 0, // 开启默认 120 秒；0=不限制
                    }))
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="opt-ai-timelimit-sec">限时时长（秒，下限 120）</Label>
                <Input
                  id="opt-ai-timelimit-sec"
                  type="number"
                  min={120}
                  max={300}
                  step={5}
                  disabled={!(options.aiTimeLimitSec ?? 0)}
                  value={options.aiTimeLimitSec ?? 120}
                  onChange={(e) => {
                    // 下限 120s（两分钟）：思考模式单次决策的合理最低耗时，再低只会逼出草率输出或批量超时
                    const v = Math.max(120, Math.min(300, Math.floor(Number(e.target.value)) || 120))
                    setOptions((prev) => ({ ...prev, aiTimeLimitSec: v }))
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  思考模式下 AI 单次狼人杀决策至少需约两分钟（下限）；限时后 prompt 会告知 AI 快速决断
                </p>
              </div>
              <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
                <Label htmlFor="opt-library" className="cursor-pointer">
                  图书馆赛前学习
                  <span className="ml-2 text-xs text-muted-foreground">
                    开赛前各座位 AI 先自主学习图书馆资料形成心得，学完才开赛 · 默认关
                  </span>
                </Label>
                <Switch
                  id="opt-library"
                  checked={options.libraryEnabled ?? false}
                  onCheckedChange={(checked) =>
                    setOptions((prev) => ({ ...prev, libraryEnabled: checked }))
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="opt-library-max">最长学习时间（秒/座位）</Label>
                <Input
                  id="opt-library-max"
                  type="number"
                  min={5}
                  max={600}
                  step={5}
                  disabled={!(options.libraryEnabled ?? false)}
                  value={options.libraryMaxSec ?? 120}
                  onChange={(e) => {
                    // 不设下限（用户要求）：多少秒都行；超时座位按未学习开赛
                    const v = Math.max(1, Math.floor(Number(e.target.value)) || 120)
                    setOptions((prev) => ({ ...prev, libraryMaxSec: v }))
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  每个座位阅读资料+写心得的最长耗时（不设下限）；超时座位按未学习直接开赛
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="opt-persona-visibility">玩家人格可见度</Label>
                <Select
                  value={options.personaVisibility ?? 'full'}
                  onValueChange={(v) =>
                    setOptions((prev) => ({ ...prev, personaVisibility: v as 'full' | 'partial' | 'none' }))
                  }
                >
                  <SelectTrigger id="opt-persona-visibility" className="h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="full">完全可见：人格玩家互知名，无人格者为迷雾</SelectItem>
                    <SelectItem value="partial">部分可见：可给人格玩家上迷雾</SelectItem>
                    <SelectItem value="none">不可见：全员皆为迷雾</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  仅有人格卡的玩家获得「人格圈层」知晓（只共享人格姓名，不泄露身份与详细人格）；
                  部分可见时在座位表给人格玩家勾选迷雾（被上迷雾者自己知道自己在雾里）
                </p>
              </div>
              <div className="space-y-1.5">
                <Label>发言规则</Label>
                <p className="rounded-md border border-dashed border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
                  警上发言 + 每日全体发言 1 轮，警长定序归票
                </p>
              </div>
              <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
                <Label htmlFor="opt-sheriff" className="cursor-pointer">
                  开启警长竞选
                  <span className="ml-2 text-xs text-muted-foreground">
                    默认随版型（{selectedBoard?.sheriff ? '开' : '关'}）
                  </span>
                </Label>
                <Switch
                  id="opt-sheriff"
                  checked={options.sheriffEnabled}
                  onCheckedChange={(checked) =>
                    setOptions((prev) => ({ ...prev, sheriffEnabled: checked }))
                  }
                />
              </div>
              <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
                <Label htmlFor="opt-selfdestruct" className="cursor-pointer">
                  允许狼人自爆
                  <span className="ml-2 text-xs text-muted-foreground">默认开启</span>
                </Label>
                <Switch
                  id="opt-selfdestruct"
                  checked={options.allowSelfDestruct}
                  onCheckedChange={(checked) =>
                    setOptions((prev) => ({ ...prev, allowSelfDestruct: checked }))
                  }
                />
              </div>
              <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
                <Label htmlFor="opt-surrender" className="cursor-pointer">
                  允许白日交刀
                  <span className="ml-2 text-xs text-muted-foreground">
                    狼队自认为必输或必胜时发动，以提前终局 · 默认开启
                  </span>
                </Label>
                <Switch
                  id="opt-surrender"
                  checked={options.allowSurrender ?? true}
                  onCheckedChange={(checked) =>
                    setOptions((prev) => ({ ...prev, allowSurrender: checked }))
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="opt-postgame-speech-limit">赛后发言机会（次/人）</Label>
                <Input
                  id="opt-postgame-speech-limit"
                  type="number"
                  min={1}
                  max={10}
                  step={1}
                  disabled={!(options.postGameDiscuss ?? true)}
                  value={options.postGameSpeechLimit ?? 5}
                  onChange={(e) => {
                    const v = Math.max(1, Math.min(10, Math.floor(Number(e.target.value)) || (DEFAULT_OPTIONS.postGameSpeechLimit ?? 5)))
                    setOptions((prev) => ({ ...prev, postGameSpeechLimit: v }))
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  每位玩家在赛后讨论中的最多发言次数（弃权不消耗）；随赛后讨论开启生效
                </p>
              </div>
              <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
                <Label htmlFor="opt-postgame-discuss" className="cursor-pointer">
                  赛后讨论
                  <span className="ml-2 text-xs text-muted-foreground">
                    对局结束后全员进入赛后频道自由讨论 · 默认开启
                  </span>
                </Label>
                <Switch
                  id="opt-postgame-discuss"
                  checked={options.postGameDiscuss ?? true}
                  onCheckedChange={(checked) =>
                    setOptions((prev) => ({ ...prev, postGameDiscuss: checked }))
                  }
                />
              </div>
              <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
                <Label htmlFor="opt-postgame-autostart" className="cursor-pointer">
                  赛后自动开始讨论
                  <span className="ml-2 text-xs text-muted-foreground">
                    分出胜负后无需手动开启，径直生成赛后讨论 · 默认关
                  </span>
                </Label>
                <Switch
                  id="opt-postgame-autostart"
                  disabled={!(options.postGameDiscuss ?? true)}
                  checked={(options.postGameAutoStart ?? false) && (options.postGameDiscuss ?? true)}
                  onCheckedChange={(checked) =>
                    setOptions((prev) => ({ ...prev, postGameAutoStart: checked }))
                  }
                />
              </div>
            </CardContent>
          </CollapsibleContent>
        </Card>
      </Collapsible>

      {/* 5. 创建对局 */}
      <div className="mb-8">
        <Button
          type="button"
          size="lg"
          className="w-full text-base"
          onClick={handleCreateGame}
          disabled={creating}
        >
          {creating ? <Loader2 className="h-5 w-5 animate-spin" aria-hidden /> : null}
          {creating ? '创建中…' : '创建对局'}
        </Button>
        {createError ? (
          <p className="mt-2 flex items-center justify-center gap-1.5 text-sm text-wolf">
            <CircleAlert className="h-4 w-4" aria-hidden />
            {createError}
          </p>
        ) : (
          <p className="mt-2 text-center text-xs text-muted-foreground">
            创建成功后自动进入对局观察室
          </p>
        )}
      </div>

      {/* 保存存档弹窗：命名后把配置行内容存入存档库 */}
      {/* 存档编辑弹窗：编辑已有存档的五要素（命名/Provider/Base URL/Model/API Key） */}
      <Dialog open={editDialog !== null} onOpenChange={(open) => !open && setEditDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>编辑存档</DialogTitle>
            <DialogDescription>修改该存档的五要素，保存后立即生效。</DialogDescription>
          </DialogHeader>
          {editDialog ? (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="edit-preset-name">存档名称</Label>
                <Input
                  id="edit-preset-name"
                  value={editDialog.name}
                  onChange={(e) => setEditDialog((prev) => (prev ? { ...prev, name: e.target.value } : prev))}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Provider</Label>
                <Select
                  value={editDialog.provider}
                  onValueChange={(v) =>
                    setEditDialog((prev) => (prev ? { ...prev, provider: v as AiProvider } : prev))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PROVIDER_LIST.map((p) => (
                      <SelectItem key={p.provider} value={p.provider}>
                        {p.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="edit-preset-baseurl">Base URL</Label>
                <Input
                  id="edit-preset-baseurl"
                  value={editDialog.baseUrl}
                  onChange={(e) =>
                    setEditDialog((prev) => (prev ? { ...prev, baseUrl: e.target.value } : prev))
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="edit-preset-model">Model</Label>
                <Input
                  id="edit-preset-model"
                  value={editDialog.model}
                  onChange={(e) =>
                    setEditDialog((prev) => (prev ? { ...prev, model: e.target.value } : prev))
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="edit-preset-key">API Key</Label>
                <Input
                  id="edit-preset-key"
                  type="password"
                  value={editDialog.apiKey}
                  onChange={(e) =>
                    setEditDialog((prev) => (prev ? { ...prev, apiKey: e.target.value } : prev))
                  }
                  autoComplete="off"
                />
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setEditDialog(null)}>
              取消
            </Button>
            <Button
              type="button"
              onClick={() => void handleSaveEdit()}
              disabled={!editDialog?.name.trim() || presetBusy}
            >
              {presetBusy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
              保存修改
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={saveDialogOpen} onOpenChange={setSaveDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>保存为新存档</DialogTitle>
            <DialogDescription>
              将当前四要素配置保存到存档库，下次一键取用。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="save-preset-name">存档名称</Label>
            <Input
              id="save-preset-name"
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              placeholder="如 Moonshot-128K"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter' && saveName.trim()) void handleSavePresetAs()
              }}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setSaveDialogOpen(false)}>
              取消
            </Button>
            <Button
              type="button"
              onClick={() => void handleSavePresetAs()}
              disabled={!saveName.trim() || presetBusy}
            >
              {presetBusy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
