/**
 * 人格关系网（§39）：三维球体关系图。
 * - 人格 = 三维空间中的球体，关系线在球内穿梭
 * - 三种视图（全部 / 原世界 / 山谷）只过滤数据，不改变空间形态
 * - 拖拽旋转 / 滚轮缩放 / 点击选中 / 图例筛选
 *
 * 审计（批次 4）修正：
 *  - 研究闭环入口接线：RSQ 报告/历史/原始答卷/填写（P0-12/P1-3）、manual 记忆增改删（P1-4）；
 *  - 详情双向视角：默认聚焦者视角，可切换 A→B / B→A；切换 dyad 清面板 + loading + key 重置（P0-13）；
 *  - 详情轮询 8s 改为单 effect + cleanup（折叠/卸载即停，P1-17）；
 *  - 空关系网也有「关系补完」入口（P1-19）；补完完成自动刷新图；
 *  - 关系线三色（深蓝/灰/暗金）+ 浅色主题适配（P1-20）；悬空边侧栏列出、计数=可见 dyad（P1-21）；
 *  - canon 补完：防双击、timer 清理、显示当前 API、status none 两次即报错（P1-18）；
 *  - presets 只保存 {id,name,provider}，不常驻 apiKey（P2-25）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown, ChevronUp, Layers, Loader2, RotateCcw, Search, X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { useGameApi } from '@/lib/gameApi'
import type {
  CanonItemView,
  CompletionJobView,
  CompletionStats,
  RSQRecordView,
  ValleyItemView,
} from '@/lib/gameApi'
import { useIsDarkTheme } from '@/hooks/useIsDarkTheme'
import {
  LAYER_LABEL,
  defaultPerspective,
  filterVisibleDyads,
  flipPerspective,
  mergeDyads,
  relationLineColor,
  visibleNodeIds,
  type GraphEdgeView,
  type GraphNodeView,
  type LayerMode,
  type Perspective,
} from '@/lib/relationGraph'
import { toReportDataList } from '@/lib/rsqClient'
import type { RsqItemsView, RSQReportData, RsqBatteryLevel, RsqSubmitPayload } from '@/lib/rsqClient'
import { cn } from '@/lib/utils'
import { RelationGraph3D } from './RelationGraph3D'
import { RelationCompletionDialog, type ExistingCompletionJob } from './RelationCompletionDialog'
import { notifyRelationsChanged } from '@/lib/relationRefresh'
import { RelationDetailPanel, type ValleyItem } from './RelationDetailPanel'
import { RSQReportDialog } from './RSQReport'
import { RSQQuestionnaireDialog } from './RSQQuestionnaireDialog'
import { CanonEventDialog } from './CanonEventDialog'
import type { CanonEventSubmitValue } from '@/lib/canonClient'
import type { CanonItem } from './CanonTimeline'

/** 轻量 API 存档视图：只留 id/name/provider，不把 apiKey 常驻组件 state（P2-25） */
type PresetLite = { id: number; name: string; provider: string }

/** 一个方向（视角）拉到的数据 */
type DirData = {
  canonItems: CanonItem[]
  valleyItems: ValleyItem[]
  rsq: RSQRecordView | null
}

const EMPTY_DIR: DirData = { canonItems: [], valleyItems: [], rsq: null }

/** 关系网图标：六边形 —— 六顶点 + 中心均为圆，彼此连线 */
export function GraphHexIcon({ className }: { className?: string }) {
  const R = 8.2
  const pts = Array.from({ length: 6 }, (_, i) => {
    const a = (i / 6) * Math.PI * 2 - Math.PI / 2
    return { x: 12 + Math.cos(a) * R, y: 12 + Math.sin(a) * R }
  })
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
      {pts.map((p, i) => <line key={'s' + i} x1={12} y1={12} x2={p.x} y2={p.y} opacity="0.75" />)}
      {pts.map((p, i) => {
        const q = pts[(i + 1) % 6]!
        return <line key={'e' + i} x1={p.x} y1={p.y} x2={q.x} y2={q.y} opacity="0.55" />
      })}
      {pts.map((p, i) => <circle key={'c' + i} cx={p.x} cy={p.y} r="1.75" fill="currentColor" stroke="none" />)}
      <circle cx="12" cy="12" r="1.95" fill="currentColor" stroke="none" />
    </svg>
  )
}

/** 关系补完图标：三角形 —— 三顶点 + 中心均为圆，彼此连线 */
export function GraphTriangleIcon({ className }: { className?: string }) {
  const R = 9
  const pts = Array.from({ length: 3 }, (_, i) => {
    const a = (i / 3) * Math.PI * 2 - Math.PI / 2
    return { x: 12 + Math.cos(a) * R, y: 12 + Math.sin(a) * R }
  })
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
      {pts.map((p, i) => <line key={'s' + i} x1={12} y1={12} x2={p.x} y2={p.y} opacity="0.75" />)}
      {pts.map((p, i) => {
        const q = pts[(i + 1) % 3]!
        return <line key={'e' + i} x1={p.x} y1={p.y} x2={q.x} y2={q.y} opacity="0.55" />
      })}
      {pts.map((p, i) => <circle key={'c' + i} cx={p.x} cy={p.y} r="1.85" fill="currentColor" stroke="none" />)}
      <circle cx="12" cy="12" r="2.05" fill="currentColor" stroke="none" />
    </svg>
  )
}

/** 原世界：情感关系词表 */
const KIND_STYLE: Record<string, { label: string; stroke: string }> = {
  kin: { label: '家人', stroke: 'hsl(200 70% 55%)' },
  beloved: { label: '挚爱', stroke: 'hsl(340 75% 62%)' },
  sworn_friend: { label: '生死之交', stroke: 'hsl(150 60% 50%)' },
  comrade: { label: '同伴', stroke: 'hsl(170 55% 47%)' },
  peer: { label: '同侪', stroke: 'hsl(220 20% 62%)' },
  mentor: { label: '师长', stroke: 'hsl(265 60% 64%)' },
  sovereign: { label: '上级', stroke: 'hsl(285 55% 60%)' },
  rival: { label: '对手', stroke: 'hsl(25 85% 58%)' },
  nemesis: { label: '宿敌', stroke: 'hsl(0 75% 60%)' },
  creditor: { label: '亏欠', stroke: 'hsl(45 85% 56%)' },
  kin_slayer: { label: '终结', stroke: 'hsl(0 70% 42%)' },
  unspecified: { label: '未定', stroke: 'hsl(0 0% 55%)' },
}

/** 山谷：对局关系词表（不是情感） */
const VALE_STYLE: Record<string, { label: string; stroke: string }> = {
  team: { label: '队友', stroke: 'hsl(170 55% 47%)' },
  cooperate: { label: '常协作', stroke: 'hsl(150 60% 50%)' },
  oppose: { label: '常对立', stroke: 'hsl(0 75% 60%)' },
  trading: { label: '攻防互现', stroke: 'hsl(25 85% 58%)' },
  suppress: { label: '单向压制', stroke: 'hsl(280 55% 58%)' },
  acquainted: { label: '偶有交集', stroke: 'hsl(220 15% 58%)' },
  none: { label: '无直接互动', stroke: 'hsl(0 0% 48%)' },
}

/** 模型供应商 → 中文说明（品牌名保留原样，加中文注解） */
const PROVIDER_LABEL: Record<string, string> = {
  kimi: '月之暗面',
  deepseek: '深度求索',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  zhipu: '智谱',
  qwen: '通义千问',
  doubao: '豆包',
  minimax: 'MiniMax',
}

const BACKFILL_STATUS_LABEL: Record<string, string> = {
  running: '运行中',
  done: '已完成',
  failed: '失败',
  none: '未创建',
  pending: '排队中',
}

function styleOf(kind: string, layer: string) {
  // ★ 兜底也用中文：宁可显示「未分类」，也不把英文代号露给用户
  if (layer === 'vale') return VALE_STYLE[kind] ?? { label: '未分类', stroke: 'hsl(220 15% 58%)' }
  return KIND_STYLE[kind] ?? KIND_STYLE.unspecified!
}

/** 后端 canon item → 时间线视图 */
function canonView(items: CanonItemView[]): CanonItem[] {
  return items.map((x) => ({
    id: x.id,
    seq: x.seq,
    sortOrder: x.sortOrder ?? null,
    era: x.era,
    age: x.age ?? null,
    place: x.place ?? null,
    eraBasis: x.eraBasis ?? null,
    eventText: x.eventText,
    feeling: x.feeling,
    impact: x.impact ?? null,
    certainty: x.certainty,
    verification: x.verification,
    origin: x.origin,
    sourceCount: x.sourceCount,
  }))
}

/** 后端 valley item → 时间线视图 */
function valleyView(items: ValleyItemView[]): ValleyItem[] {
  return items.map((x) => ({
    id: x.id,
    era: x.era,
    relation: x.relation,
    affinityDelta: x.affinityDelta,
    trustDelta: x.trustDelta,
    note: x.note,
    titleNo: x.titleNo,
  }))
}

/** 后端 job stats / statsRaw → 统一统计（真实写入/联网计数，P1-16） */
function parseCompletionStats(
  raw: string | null | undefined,
  fallback?: Record<string, unknown> | null,
): CompletionStats {
  let obj: Record<string, unknown> = {}
  if (raw) {
    try { obj = JSON.parse(raw) as Record<string, unknown> } catch { obj = {} }
  }
  if (fallback) obj = { ...obj, ...fallback }
  const pick = (k: string) => (typeof obj[k] === 'number' ? obj[k] as number : undefined)
  return {
    written: pick('written'),
    webSearched: pick('webSearched'),
    corrected: pick('corrected'),
    generated: pick('generated'),
    verified: pick('verified'),
    rejected: pick('rejected'),
    reason: typeof obj.reason === 'string' ? obj.reason : undefined,
  }
}

export function RelationGraphBar(props: { initialFocus?: number | null; defaultOpen?: boolean } = {}) {
  const api = useGameApi()
  const isDark = useIsDarkTheme()

  const [open, setOpen] = useState(props.defaultOpen === true)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [allNodes, setAllNodes] = useState<GraphNodeView[]>([])
  const [allEdges, setAllEdges] = useState<GraphEdgeView[]>([])
  const [layer, setLayer] = useState<LayerMode>('all')

  const [focusedId, setFocusedId] = useState<number | null>(props.initialFocus ?? null)
  const [selectedDyad, setSelectedDyad] = useState<string | null>(null)
  const [perspective, setPerspective] = useState<Perspective>('a')
  const [hoverDyad, setHoverDyad] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  /** 每次 +1 通知 3D 组件复位视角与缩放 */
  const [resetToken, setResetToken] = useState(0)

  /** 轻量 API 存档（不含 apiKey） */
  const [presets, setPresets] = useState<PresetLite[]>([])
  const [allCards, setAllCards] = useState<{ id: number; name: string }[]>([])
  const [completionOpen, setCompletionOpen] = useState(false)

  /** 详情面板数据：双向都拉（P0-13） */
  const [dirs, setDirs] = useState<{ forward: DirData; reverse: DirData } | null>(null)
  const [panelLoading, setPanelLoading] = useState(false)
  const [panelError, setPanelError] = useState<string | null>(null)
  /** +1 触发面板重拉（补完/手录后） */
  const [panelRefreshTick, setPanelRefreshTick] = useState(0)

  /** 关系测评报告弹窗 */
  const [reportOpen, setReportOpen] = useState(false)
  const [reportMeta, setReportMeta] = useState<{ fromName: string; toName: string } | null>(null)
  const [reportRecords, setReportRecords] = useState<RSQReportData[]>([])
  const [reportInitialId, setReportInitialId] = useState<number | null>(null)

  /** RSQ 问卷弹窗 */
  const [rsqTarget, setRsqTarget] = useState<{
    fromId: number
    toId: number
    fromName: string
    toName: string
  } | null>(null)

  /** 手录 canon 弹窗 */
  const [canonDialog, setCanonDialog] = useState<{ mode: 'add' | 'edit'; item?: CanonItem } | null>(null)
  const [canonReordering, setCanonReordering] = useState(false)

  /** canon 现实层补完（双向） */
  const [backfilling, setBackfilling] = useState(false)
  const [backfillStatus, setBackfillStatus] = useState<{ a: string; b: string } | null>(null)
  const [backfillError, setBackfillError] = useState<string | null>(null)
  const backfillTimerRef = useRef<number | null>(null)
  const backfillTokenRef = useRef(0)

  const stopBackfillPolling = useCallback(() => {
    backfillTokenRef.current += 1
    if (backfillTimerRef.current != null) {
      window.clearInterval(backfillTimerRef.current)
      backfillTimerRef.current = null
    }
  }, [])

  /** 视图只过滤数据：节点始终是全部（换视图不改变球体形态） */
  const layerEdges = useMemo(
    () => (layer === 'all' ? allEdges : allEdges.filter((e) => e.layer === layer)),
    [allEdges, layer],
  )
  const nodes = allNodes
  const allDyads = useMemo(() => mergeDyads(allEdges), [allEdges])
  const dyads = useMemo(() => mergeDyads(layerEdges), [layerEdges])

  const nameOf = useCallback(
    (id: number) => allNodes.find((n) => n.id === id)?.name ?? '库外角色',
    [allNodes],
  )

  /** 可见关系（搜索/聚焦口径与 3D 内部一致；用于标题计数） */
  const visibleDyads = useMemo(
    () => filterVisibleDyads(dyads, { focusedId, query, nameOf }),
    [dyads, focusedId, query, nameOf],
  )
  const visibleIds = useMemo(
    () => visibleNodeIds(allNodes, visibleDyads, { focusedId, query }),
    [allNodes, visibleDyads, focusedId, query],
  )
  const visibleLineDyads = visibleDyads.filter((d) => !d.dangling)

  // -------------------------------------------------------------------------
  // 图加载
  // -------------------------------------------------------------------------

  const loadGraph = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const [g, presetList] = await Promise.all([
        api.relationGraph({ layer: 'all' }),
        api.listPresets().catch(() => []),
      ])
      setAllNodes((g.nodes ?? []) as GraphNodeView[])
      setAllEdges((g.edges ?? []) as GraphEdgeView[])
      setPresets((presetList ?? []).map((p) => ({ id: p.id, name: p.name, provider: p.provider })))
    } catch (e) {
      setError(e instanceof Error ? e.message : '关系网加载失败')
    } finally { setLoading(false) }
  }, [api])

  // 每次展开都重新拉图：新建/删除人格、补完收尾后不会停在旧快照（P2-16）
  useEffect(() => {
    if (open) void loadGraph()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // 预览/演示用：初始聚焦
  useEffect(() => {
    if (props.initialFocus != null && allNodes.length > 0) setFocusedId(props.initialFocus)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allNodes.length])

  // -------------------------------------------------------------------------
  // 详情面板：双向拉取 + 8s 轮询（单 effect + cleanup：折叠/卸载/切换即停，P1-17）
  // -------------------------------------------------------------------------

  const fetchDir = useCallback(async (from: number, to: number): Promise<DirData> => {
    // 注意：不把错误吞成空态（P1-17）——失败要冒到面板上显示原因 + 重试
    const [canon, valley, rsq] = await Promise.all([
      api.canonLog({ personaId: from, aboutPersonaId: to, order: 'asc' }),
      api.valleyHistory({ personaId: from, aboutPersonaId: to }),
      api.latestRSQ({ fromPersonaId: from, toPersonaId: to }),
    ])
    return { canonItems: canonView(canon), valleyItems: valleyView(valley), rsq }
  }, [api])

  const panelDyad = useMemo(
    () => (selectedDyad ? allDyads.find((d) => d.key === selectedDyad) ?? null : null),
    [allDyads, selectedDyad],
  )

  useEffect(() => {
    if (!open || !panelDyad) {
      setDirs(null); setPanelLoading(false); setPanelError(null)
      return
    }
    // 悬空边：库外角色没有可查的视角数据（不发起请求）
    if (panelDyad.dangling) {
      setDirs({ forward: EMPTY_DIR, reverse: EMPTY_DIR })
      setPanelLoading(false); setPanelError(null)
      return
    }
    let cancelled = false
    const load = async (silent: boolean) => {
      if (!silent) { setPanelLoading(true); setPanelError(null); setDirs(null) }
      try {
        const [forward, reverse] = await Promise.all([
          fetchDir(panelDyad.a, panelDyad.b),
          fetchDir(panelDyad.b, panelDyad.a),
        ])
        if (cancelled) return
        setDirs({ forward, reverse })
        setPanelError(null)
      } catch (e) {
        if (!cancelled) setPanelError('详情加载失败：' + (e instanceof Error ? e.message : String(e)))
      } finally {
        if (!cancelled) setPanelLoading(false)
      }
    }
    void load(false)
    // ★ 后台补完是异步队列（每对 3~5 分钟），面板要能自己刷出来；关闭面板/卸载即清理
    const timer = window.setInterval(() => { void load(true) }, 8000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [open, panelDyad, fetchDir, panelRefreshTick])

  // -------------------------------------------------------------------------
  // 选中 / 视角
  // -------------------------------------------------------------------------

  const handleSelectDyad = useCallback((key: string | null) => {
    setHoverDyad(null)
    if (!key) { setSelectedDyad(null); setDirs(null); return }
    setSelectedDyad(key)
    const d = allDyads.find((x) => x.key === key)
    if (d && !d.dangling) setPerspective(defaultPerspective(focusedId, d.a, d.b))
    else setPerspective('a')
  }, [allDyads, focusedId])

  const handleFocus = useCallback((id: number | null) => {
    setFocusedId(id)
    // 聚焦者变了 → 默认视角跟着聚焦者（P0-13）
    if (selectedDyad) {
      const d = allDyads.find((x) => x.key === selectedDyad)
      if (d && !d.dangling) setPerspective(defaultPerspective(id, d.a, d.b))
    }
  }, [allDyads, selectedDyad])

  const closePanel = useCallback(() => {
    setSelectedDyad(null)
    setDirs(null)
    setPerspective('a')
    setPanelError(null)
  }, [])

  const flipPerspectiveNow = useCallback(() => {
    setPerspective((p) => flipPerspective(p))
  }, [])

  /** 当前面板视角的方向端点与名字 */
  const activeDirection = useMemo(() => {
    if (!panelDyad) return null
    if (panelDyad.dangling) {
      return {
        from: panelDyad.a,
        to: panelDyad.b,
        fromName: nameOf(panelDyad.a),
        toName: panelDyad.toName ?? '库外角色',
        data: EMPTY_DIR,
        other: EMPTY_DIR,
      }
    }
    const dir = perspective === 'a'
      ? { from: panelDyad.a, to: panelDyad.b }
      : { from: panelDyad.b, to: panelDyad.a }
    const data: DirData = perspective === 'a' ? (dirs?.forward ?? EMPTY_DIR) : (dirs?.reverse ?? EMPTY_DIR)
    const other: DirData = perspective === 'a' ? (dirs?.reverse ?? EMPTY_DIR) : (dirs?.forward ?? EMPTY_DIR)
    return { ...dir, fromName: nameOf(dir.from), toName: nameOf(dir.to), data, other }
  }, [panelDyad, perspective, dirs, nameOf])

  const otherHasData = useMemo(() => {
    if (!activeDirection) return false
    const o = activeDirection.other
    return o.canonItems.length > 0 || o.valleyItems.length > 0 || o.rsq != null
  }, [activeDirection])

  /** latestRSQ → RelationCard props */
  const cardOf = useCallback((dir: DirData) => {
    const r = dir.rsq
    if (!r) return null
    return {
      selfSummary: r.selfSummary ?? null,
      radar: r.radar ?? [],
      answeredAt: r.answeredAt ? new Date(r.answeredAt) : null,
      verdict: r.validity?.verdict ?? null,
    }
  }, [])

  // -------------------------------------------------------------------------
  // RSQ 报告 / 原始答卷
  // -------------------------------------------------------------------------

  const openReport = useCallback(async () => {
    if (!activeDirection || activeDirection.from === 0 || activeDirection.to === 0) return
    try {
      const rows = await api.rsqHistory({
        fromPersonaId: activeDirection.from,
        toPersonaId: activeDirection.to,
        order: 'desc',
        limit: 100,
      })
      const adapted = toReportDataList(rows as unknown[])
      setReportRecords(adapted)
      setReportInitialId(adapted[0]?.id ?? null)
      setReportMeta({ fromName: activeDirection.fromName, toName: activeDirection.toName })
      setReportOpen(true)
    } catch (e) {
      setError('关系测评历史加载失败：' + (e instanceof Error ? e.message : String(e)))
    }
  }, [api, activeDirection])

  const openRSQ = useCallback(() => {
    if (!activeDirection) return
    setRsqTarget({
      fromId: activeDirection.from,
      toId: activeDirection.to,
      fromName: activeDirection.fromName,
      toName: activeDirection.toName,
    })
  }, [activeDirection])

  const loadRsqItems = useCallback(
    (level: RsqBatteryLevel): Promise<RsqItemsView> => api.rsqItems({ level }),
    [api],
  )
  const submitRsq = useCallback(
    async (payload: RsqSubmitPayload) => {
      const r = await api.submitRSQ(payload)
      return { id: r.id }
    },
    [api],
  )

  // -------------------------------------------------------------------------
  // manual canon：增 / 改 / 删（P1-4）
  // -------------------------------------------------------------------------

  const openAddCanon = useCallback(() => setCanonDialog({ mode: 'add' }), [])
  const openEditCanon = useCallback((item: CanonItem) => setCanonDialog({ mode: 'edit', item }), [])

  const submitCanon = useCallback(async (value: CanonEventSubmitValue) => {
    if (!activeDirection) throw new Error('没有选中的关系方向')
    if (canonDialog?.mode === 'edit' && canonDialog.item) {
      await api.updateCanonEvent({
        id: canonDialog.item.id,
        patch: {
          era: value.era,
          eventText: value.eventText,
          feeling: value.feeling,
          impact: value.impact,
          age: value.age,
          place: value.place,
        },
      })
    } else {
      await api.addCanonEvent({
        personaId: activeDirection.from,
        aboutPersonaId: activeDirection.to,
        era: value.era,
        eventText: value.eventText,
        feeling: value.feeling,
        impact: value.impact,
        age: value.age,
        place: value.place,
      })
    }
    setCanonDialog(null)
    setPanelRefreshTick((t) => t + 1)
    // 详情页（Personas 弹窗）若开着，立刻用空白 loading 重拉
    notifyRelationsChanged({ personaIds: [activeDirection.from, activeDirection.to], reason: 'canon-manual-save' })
  }, [api, activeDirection, canonDialog])

  const deleteCanon = useCallback(async (id: number) => {
    if (!window.confirm('删除这条现实记忆？（AI 或手录内容都会从时间线移除）')) return
    try {
      await api.deleteCanonEvent({ id })
      setPanelRefreshTick((t) => t + 1)
      if (activeDirection) {
        notifyRelationsChanged({ personaIds: [activeDirection.from, activeDirection.to], reason: 'canon-manual-delete' })
      }
    } catch (e) {
      setPanelError('删除失败：' + (e instanceof Error ? e.message : String(e)))
    }
  }, [api, activeDirection])

  const reorderCanon = useCallback(async (orderedIds: number[]) => {
    if (!activeDirection || canonReordering) return
    setCanonReordering(true)
    try {
      await api.reorderCanonEvents({
        personaId: activeDirection.from,
        aboutPersonaId: activeDirection.to,
        orderedIds,
      })
      setPanelRefreshTick((t) => t + 1)
      notifyRelationsChanged({ personaIds: [activeDirection.from, activeDirection.to], reason: 'canon-reorder' })
    } catch (e) {
      setPanelError('排序失败：' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setCanonReordering(false)
    }
  }, [api, activeDirection, canonReordering])

  // -------------------------------------------------------------------------
  // canon 现实层补完（双向、防双击、timer 清理、API 显式、none 两次报错，P1-18）
  // -------------------------------------------------------------------------

  useEffect(() => {
    return () => { stopBackfillPolling() }
  }, [stopBackfillPolling])

  // 切换关系线 / 折叠面板 → 立即停止旧补完轮询并复位状态
  useEffect(() => {
    stopBackfillPolling()
    setBackfilling(false)
    setBackfillStatus(null)
    setBackfillError(null)
  }, [selectedDyad, open, stopBackfillPolling])

  const handleBackfill = useCallback(async () => {
    if (!panelDyad || panelDyad.dangling || backfilling) return
    const a = panelDyad.a
    const b = panelDyad.b
    if (a === b) return

    stopBackfillPolling()
    setBackfilling(true)
    setBackfillStatus({ a: '启动中…', b: '启动中…' })
    setBackfillError(null)

    let presetId = presets[0]?.id ?? null
    if (!presetId) {
      try {
        const list = await api.listPresets()
        const lite = list.map((p) => ({ id: p.id, name: p.name, provider: p.provider }))
        setPresets(lite)
        presetId = lite[0]?.id ?? null
      } catch { /* 下面统一报错 */ }
    }
    if (!presetId) {
      setBackfilling(false)
      setBackfillStatus(null)
      setBackfillError('没有可用 API：请先到对局页的 AI 设置里保存一个')
      return
    }

    const pairs: Array<{ key: 'a' | 'b'; from: number; to: number }> = [
      { key: 'a', from: a, to: b },
      { key: 'b', from: b, to: a },
    ]
    const startErrors: Partial<Record<'a' | 'b', string>> = {}
    for (const p of pairs) {
      try {
        // force=true → 每次补完都按第一人称重写关系事件/感受（旧 AI 行软删、manual 保留）
        const r = await api.startBackfillCanon({
          personaId: p.from,
          aboutPersonaId: p.to,
          apiPresetId: presetId,
          force: true,
        })
        if (!r.started) startErrors[p.key] = r.error ?? '启动失败'
      } catch (e) {
        startErrors[p.key] = e instanceof Error ? e.message : String(e)
      }
    }
    if (Object.keys(startErrors).length === 2) {
      setBackfilling(false)
      setBackfillStatus(null)
      setBackfillError('补完启动失败：' + (startErrors.a ?? startErrors.b ?? '未知原因'))
      return
    }

    const token = ++backfillTokenRef.current
    const startedAt = Date.now()
    const noneCount: Record<'a' | 'b', number> = { a: 0, b: 0 }
    const label = (key: 'a' | 'b') => (key === 'a' ? nameOf(a) + '→' + nameOf(b) : nameOf(b) + '→' + nameOf(a))

    const timer = window.setInterval(async () => {
      if (backfillTokenRef.current !== token) return
      const results = await Promise.all(pairs.map(async (p) => {
        try {
          return await api.backfillCanonStatus({ personaId: p.from, aboutPersonaId: p.to })
        } catch { return null }
      }))
      if (backfillTokenRef.current !== token) return
      const texts: Record<'a' | 'b', string> = { a: '', b: '' }
      results.forEach((st, i) => {
        const key = pairs[i]!.key
        if (!st) { texts[key] = '查询失败'; return }
        if (st.status === 'none') noneCount[key] += 1
        else noneCount[key] = 0
        const statusLabel = BACKFILL_STATUS_LABEL[st.status] ?? st.status
        texts[key] = label(key) + '：' + statusLabel + (st.error ? '（' + st.error + '）' : '')
      })
      setBackfillStatus(texts)

      const noneTwice = noneCount.a >= 2 || noneCount.b >= 2
      const allSettled = results.every((x) => x && (x.status === 'done' || x.status === 'failed'))
      const anyFailed = results.some((x) => x?.status === 'failed')
      const timedOut = Date.now() - startedAt > 15 * 60_000
      if (noneTwice || allSettled || timedOut) {
        stopBackfillPolling()
        setBackfilling(false)
        if (noneTwice) {
          setBackfillError('补完任务未创建：后端没有返回任务记录（请检查 API 配置或后端是否正常）')
        } else if (anyFailed) {
          const failed = results.find((x) => x?.status === 'failed')
          setBackfillError('补完失败：' + (failed?.error ?? '未知原因'))
        } else if (timedOut) {
          setBackfillError('补完超时（15 分钟）：任务可能仍在后台运行，稍后刷新查看')
        }
        // ★ 关键：刷新面板，让新生成的现实层事件显示出来
        setPanelRefreshTick((t) => t + 1)
        notifyRelationsChanged({ personaIds: [a, b], reason: 'canon-backfill-settled' })
      }
    }, 2000)
    backfillTimerRef.current = timer
  }, [api, backfilling, nameOf, panelDyad, presets, stopBackfillPolling])

  // -------------------------------------------------------------------------
  // 关系补完弹窗
  // -------------------------------------------------------------------------

  const openCompletion = useCallback(async () => {
    setCompletionOpen(true)
    try {
      const [list, cards] = await Promise.all([api.listPresets(), api.listPersonas()])
      setPresets((list ?? []).map((p) => ({ id: p.id, name: p.name, provider: p.provider })))
      setAllCards((cards ?? []).map((c) => ({ id: c.id, name: c.name })))
    } catch {
      setAllCards([])
    }
  }, [api])

  const getStatus = useCallback(async (jobId: number) => {
    const st = await api.relationCompletionStatus(jobId)
    if (!st) return null
    const stats = parseCompletionStats(st.statsRaw, st.stats)
    const hasStats = Object.values(stats).some((v) => v !== undefined)
    return {
      status: st.status,
      progress: st.progress ?? null,
      stats: hasStats ? stats : null,
      // 失败原因：后端把 reason 写在 stats JSON（或 progress.reason）里，没有独立的 error 字段
      error: stats.reason ?? null,
    }
  }, [api])

  const listJobs = useCallback(async (): Promise<ExistingCompletionJob[]> => {
    try {
      const jobs = await api.listCompletionJobs()
      return (jobs as CompletionJobView[]).map((j) => {
        const stats = parseCompletionStats(j.statsRaw, j.stats)
        const hasStats = Object.values(stats).some((v) => v !== undefined)
        // 后端 scope 是对象 { personaIds, apiPresetId }（resume 自恢复依据）
        const scopeObj = j.scope && typeof j.scope === 'object' ? j.scope : null
        const personaIds = scopeObj?.personaIds ?? []
        const apiPresetId = typeof scopeObj?.apiPresetId === 'number' ? scopeObj.apiPresetId : 0
        return {
          id: j.id,
          status: j.status,
          scope: personaIds.length > 0 ? 'partial' : 'all',
          total: j.progress?.total ?? (personaIds.length > 0 ? personaIds.length : allCards.length),
          personaIds,
          progress: j.progress ?? null,
          stats: hasStats ? stats : null,
          error: stats.reason ?? null,
          apiPresetId,
        }
      })
    } catch {
      return []
    }
  }, [api, allCards.length])

  /** 补完任务操作（useCallback：避免弹窗内轮询 effect 因父组件重渲染而反复重挂） */
  const handleStartCompletion = useCallback(async (input: { apiPresetId: number; personaIds?: number[] }) => {
    const r = await api.startRelationCompletion(input)
    return { jobId: r.jobId, error: r.error }
  }, [api])

  const handlePauseJob = useCallback(async (jobId: number) => {
    await api.pauseCompletion({ jobId })
  }, [api])

  const handleResumeJob = useCallback(async (jobId: number) => {
    const r = await api.resumeCompletion({ jobId })
    if (!r.ok || r.error) throw new Error(r.error ?? '继续失败')
  }, [api])

  const handleCancelJob = useCallback(async (jobId: number) => {
    const r = await api.cancelCompletion({ jobId })
    if (!r.ok) throw new Error('终止失败')
  }, [api])

  const handleJobsFinished = useCallback(() => {
    void loadGraph()
    setPanelRefreshTick((t) => t + 1)
    // ★ 补完结束后通知人格详情页：空白 loading 后重拉整份 detail（用户实锤：详情页不更新）
    notifyRelationsChanged({ reason: 'relations-completion-finished' })
  }, [loadGraph])

  // -------------------------------------------------------------------------
  // 渲染
  // -------------------------------------------------------------------------

  const colorOf = useCallback((_kind: string, l: string, mixed?: boolean) => {
    const hasCanon = mixed ? true : l !== 'vale'
    const hasVale = mixed ? true : l === 'vale'
    return relationLineColor({ isDark, layer: l, hasCanon, hasVale })
  }, [isDark])
  const labelOf = useCallback((kind: string, l: string) => styleOf(kind, l).label, [])

  const panelDirection = activeDirection
    ? {
        fromName: activeDirection.fromName,
        toName: activeDirection.toName,
        card: cardOf(activeDirection.data),
        canonItems: activeDirection.data.canonItems,
        valleyItems: activeDirection.data.valleyItems,
      }
    : null

  const backfillStatusText = useMemo(() => {
    if (backfillError) return backfillError
    if (!backfillStatus) return null
    return backfillStatus.a + ' · ' + backfillStatus.b
  }, [backfillError, backfillStatus])

  const presetName = presets[0]?.name ?? null

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'mb-4 flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-left transition-colors',
          open ? 'border-god/60 bg-god/5' : 'border-border bg-card hover:bg-accent/40',
        )}
        aria-expanded={open}
      >
        <GraphHexIcon className="h-5 w-5 shrink-0 text-god" />
        <span className="text-sm font-semibold text-foreground">人格关系网</span>
        <span className="text-xs text-muted-foreground">
          {nodes.length > 0 ? nodes.length + ' 个人格 · ' + allDyads.length + ' 对关系' : '点击展开查看'}
        </span>
        <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          {open ? '点击收起' : '点击展开'}
          {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
          {open ? <ChevronUp className="h-4 w-4" aria-hidden /> : <ChevronDown className="h-4 w-4" aria-hidden />}
        </span>
      </button>

      {open ? (
        <Card className="mb-4">
          <CardContent className="pt-4">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <Layers className="h-3.5 w-3.5" aria-hidden /> 视图
              </span>
              {(['all', 'canon', 'vale'] as LayerMode[]).map((lv) => (
                <button
                  key={lv}
                  type="button"
                  onClick={() => setLayer(lv)}
                  aria-pressed={layer === lv}
                  className={cn(
                    'rounded-full border px-2.5 py-0.5 text-xs transition-colors',
                    layer === lv ? 'border-god/60 bg-god/10 text-foreground' : 'border-border text-muted-foreground hover:bg-accent/40',
                  )}
                >
                  {LAYER_LABEL[lv]}
                </button>
              ))}
              {/* 双色图例（用户定案：原世界=绿，纯山谷=灰） */}
              <span className="ml-1 hidden items-center gap-2 text-[10px] text-muted-foreground sm:flex">
                {([
                  ['原世界', relationLineColor({ isDark, layer: 'canon', hasCanon: true, hasVale: false })],
                  ['纯山谷', relationLineColor({ isDark, layer: 'vale', hasCanon: false, hasVale: true })],
                ] as const).map(([label, color]) => (
                  <span key={label} className="inline-flex items-center gap-1">
                    <span className="inline-block h-0.5 w-4 rounded" style={{ backgroundColor: color }} />
                    {label}
                  </span>
                ))}
              </span>
              <span className="ml-auto flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span>
                  {visibleLineDyads.length} 条关系线 · {visibleIds.size} 人
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void openCompletion()}
                >
                  <GraphTriangleIcon className="h-3.5 w-3.5" aria-hidden /> 关系补完
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    // 一键回到默认初始状态：清搜索、退出聚焦、取消选中、复位视角与缩放
                    setQuery('')
                    setFocusedId(null)
                    setSelectedDyad(null)
                    setDirs(null)
                    setHoverDyad(null)
                    setResetToken((t) => t + 1)
                  }}
                >
                  <RotateCcw className="h-3.5 w-3.5" aria-hidden /> 复位
                </Button>
              </span>
            </div>

            {error ? <p className="py-6 text-center text-sm text-wolf">{error}</p> : null}
            {loading && nodes.length === 0 ? (
              <p className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> 正在加载关系网…
              </p>
            ) : null}
            {!loading && nodes.length === 0 && !error ? (
              <div className="flex flex-col items-center justify-center gap-3 py-10 text-center">
                <p className="text-sm text-muted-foreground">
                  暂无结构化关系。可联网补全原世界关系。
                </p>
                <div className="flex flex-wrap items-center justify-center gap-2">
                  <Button size="sm" onClick={() => void openCompletion()}>
                    <GraphTriangleIcon className="h-4 w-4" /> 关系补完
                  </Button>
                </div>
              </div>
            ) : null}

            {nodes.length > 0 ? (
              <div className="flex flex-col gap-3 lg:flex-row">
                <div className="relative h-[560px] min-w-0 flex-1 overflow-hidden rounded-lg border border-border bg-background">
                  <RelationGraph3D
                    nodes={nodes}
                    dyads={dyads}
                    focusedId={focusedId}
                    resetToken={resetToken}
                    onFocus={handleFocus}
                    hoverDyad={hoverDyad}
                    onHoverDyad={setHoverDyad}
                    selectedDyad={selectedDyad}
                    onSelectDyad={handleSelectDyad}
                    query={query}
                    colorOf={colorOf}
                    labelOf={labelOf}
                    isDark={isDark}
                  />

                  <div className="absolute left-2 top-2 z-20 flex items-center gap-1.5 rounded-md border border-border bg-card/95 px-2 py-1">
                    <Search className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                    <input
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="搜索人格…"
                      className="w-24 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
                      aria-label="搜索人格"
                    />
                    {query ? (
                      <button type="button" onClick={() => setQuery('')} aria-label="清除">
                        <X className="h-3 w-3 text-muted-foreground" />
                      </button>
                    ) : null}
                  </div>
                </div>

                {/* 详情面板：① 人格名标签 + 视角切换 ② 关系卡片 ③ 现实层时间线 */}
                <div className="flex h-[560px] w-full shrink-0 flex-col overflow-hidden rounded-lg border border-border bg-card/60 lg:w-80">
                  {panelDirection ? (
                    <RelationDetailPanel
                      key={selectedDyad + ':' + perspective + ':' + (panelDyad?.dangling ? 'dangling' : 'normal')}
                      className="min-h-0 flex-1"
                      direction={panelDirection}
                      otherHasData={otherHasData}
                      onFlipPerspective={panelDyad?.dangling || panelDyad?.a === panelDyad?.b ? undefined : flipPerspectiveNow}
                      loading={panelLoading}
                      error={panelError}
                      onRetry={() => setPanelRefreshTick((t) => t + 1)}
                      onClose={closePanel}
                      onOpenReport={panelDirection.card ? () => void openReport() : undefined}
                      onOpenAnswers={panelDirection.card ? () => void openReport() : undefined}
                      onStartRSQ={panelDyad?.dangling || panelDyad?.a === panelDyad?.b ? undefined : () => openRSQ()}
                      onAddCanon={panelDyad?.dangling ? undefined : openAddCanon}
                      onEditCanon={panelDyad?.dangling ? undefined : openEditCanon}
                      onDeleteCanon={panelDyad?.dangling ? undefined : (id) => void deleteCanon(id)}
                      onReorderCanon={panelDyad?.dangling ? undefined : reorderCanon}
                      canonReordering={canonReordering}
                      onBackfill={panelDyad?.dangling || panelDyad?.a === panelDyad?.b ? undefined : () => void handleBackfill()}
                      backfillRunning={backfilling}
                      backfillApiName={presetName}
                      backfillStatusText={backfillStatusText}
                    />
                  ) : (
                    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-3 text-center text-muted-foreground">
                      <p className="text-sm leading-relaxed">
                        点击关系线查看详情
                        <br />
                        拖拽旋转 · 滚轮缩放
                      </p>
                      <div className="text-xs text-muted-foreground/70">
                        可见 {visibleLineDyads.length} 条关系 · {visibleIds.size} 个人格
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <RelationCompletionDialog
        open={completionOpen}
        onOpenChange={setCompletionOpen}
        presets={presets.map((p) => ({ id: p.id, name: p.name, provider: p.provider }))}
        allCards={allCards}
        onStart={handleStartCompletion}
        getStatus={getStatus}
        getJobs={listJobs}
        onPause={handlePauseJob}
        onResume={handleResumeJob}
        onCancel={handleCancelJob}
        onFinished={handleJobsFinished}
        providerLabel={PROVIDER_LABEL}
      />

      {/* RSQ 填写问卷（按电池级别拉题、1–7 作答、校验提交） */}
      {rsqTarget ? (
        <RSQQuestionnaireDialog
          open={rsqTarget != null}
          onOpenChange={(v) => { if (!v) setRsqTarget(null) }}
          fromPersonaId={rsqTarget.fromId}
          toPersonaId={rsqTarget.toId}
          fromName={rsqTarget.fromName}
          toName={rsqTarget.toName}
          loadItems={loadRsqItems}
          onSubmit={submitRsq}
          onSubmitted={() => {
            setPanelRefreshTick((t) => t + 1)
          }}
        />
      ) : null}

      {/* RSQ 报告：报告 / 历史 / 原始答卷（打开时才挂载 → 内部状态每次重置） */}
      {reportOpen ? (
        <RSQReportDialog
          open
          onOpenChange={setReportOpen}
          fromName={reportMeta?.fromName ?? ''}
          toName={reportMeta?.toName ?? ''}
          records={reportRecords}
          initialId={reportInitialId ?? undefined}
        />
      ) : null}

      {/* 手录现实记忆：新增 / 编辑 */}
      {canonDialog ? (
        <CanonEventDialog
          open={canonDialog != null}
          onOpenChange={(v) => { if (!v) setCanonDialog(null) }}
          mode={canonDialog.mode}
          fromName={panelDirection?.fromName ?? ''}
          toName={panelDirection?.toName ?? ''}
          initial={canonDialog.item ? {
            era: canonDialog.item.era,
            age: canonDialog.item.age != null ? String(canonDialog.item.age) : '',
            place: canonDialog.item.place ?? '',
            eventText: canonDialog.item.eventText,
            feeling: canonDialog.item.feeling,
            impact: canonDialog.item.impact ?? '',
          } : null}
          onSubmit={submitCanon}
        />
      ) : null}
    </>
  )
}
