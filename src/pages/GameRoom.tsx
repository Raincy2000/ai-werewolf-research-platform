/**
 * 对局观察室 /game/:id（上帝视角）。
 *
 * 核心约定（最高优先级）：
 * - 进入页面后绝不做路由跳转 / 整页刷新
 * - setInterval 每 1500ms 调用 pollGame({gameId, afterSeq}) 增量拉取
 * - afterSeq 游标保存在 useRef；新事件只追加（稳定 key = event.seq），快照整体替换
 * - 轮询错误静默重试；仅对局不存在（NOT_FOUND）时给出友好提示
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import {
  ArrowLeft,
  Brain,
  ChevronDown,
  CircleAlert,
  Download,
  FileText,
  Loader2,
  MessagesSquare,
  OctagonX,
  Pause,
  Play,
  Sparkles,
  Trophy,
} from 'lucide-react'
import type {
  AnalysisJobStage,
  AnalysisJobStatus,
  AnalysisReport,
  GameEvent,
  GameSnapshot,
  GameStatus,
  WinRateEntry,
} from '@contracts/game'
import type { PersonaReport } from '@contracts/persona'
import { resolveAnalystAiConfig, useGameApi } from '@/lib/gameApi'
import { MarkdownBoard } from '@/components/MarkdownBoard'
import { MvpSvpPanels } from '@/components/game/MvpSvp'
import { ReportCharts } from '@/components/game/ReportCharts'
import { ReplayBar } from '@/components/game/ReplayBar'
import { useReplay } from '@/lib/useReplay'
import { downloadGameLogs } from '@/lib/exportLog'
import { groupEventsIntoSessions, withCurrentSession } from '@/lib/eventSessions'
import { usePanelFollow } from '@/lib/usePanelFollow'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { elapsedLabel, formatElapsed, gameStartStorageKey, phaseLabel, statusLabelOf } from '@/lib/gameLabels'
import { cn, isUnauthorizedError } from '@/lib/utils'
import { useAuth } from '@/providers/auth'
import { LoginRequiredCard } from '@/components/AuthDialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { EventStream } from '@/components/game/EventStream'
import { PlayerPanel } from '@/components/game/PlayerPanel'
import { SeatGrid } from '@/components/game/SeatGrid'

/** 轮询间隔（design/game.md：约 1500ms） */
const POLL_INTERVAL_MS = 1500
/** 分析任务状态轮询间隔（对局结束后） */
const ANALYSIS_POLL_INTERVAL_MS = 3000

function formatTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * 胜率记录的涨跌方向：基于完整时间序（winRateEntries 按 id 升序追加）找时间上一条记录
 * 比较 goodPct（首条与初始 50/50 基准相比）——上升='good'（神民胜率增加），下降='wolf'
 */
function directionOf(entries: WinRateEntry[], entry: WinRateEntry): 'good' | 'wolf' {
  const idx = entries.findIndex((e) => e.id === entry.id)
  const prevGood = idx > 0 ? entries[idx - 1].goodPct : 50
  return entry.goodPct > prevGood ? 'good' : 'wolf'
}

/** 判断错误是否为「对局不存在」（其余错误一律静默重试） */
function isNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const data = (err as { data?: { code?: string; httpStatus?: number } }).data
  if (data?.code === 'NOT_FOUND' || data?.httpStatus === 404) return true
  const message = (err as { message?: string }).message ?? ''
  return /not[- ]?found|不存在|未找到/i.test(message)
}

/** 白日主动技能的发动权衡记录：持有白天主动技能的角色的实时心理活动。
 * 与对局记录同款时段标签页（第N日）；吸底跟随（共享机制）；
 * 最新标签呼吸灯：有角色正在权衡思考时红色呼吸，否则灰色静止；
 * 条目三标签：身份 + 思考对象 + 按兵/发动；发动条目三标签与文字全部红色加粗 */
function SkillThinkPanel({
  events,
  live,
  thinking,
  roleNameOf,
  currentDay,
  currentPhase,
  phaseBreaking,
  shrink,
  fitBanner,
  t0,
}: {
  events: GameEvent[]
  live: boolean
  /** 是否有持技玩家正在进行权衡思考（当前待决含 daySkill 时） */
  thinking: boolean
  /** 座位 → 身份名（观察者视角全亮） */
  roleNameOf: (seat: number) => string | null
  /** 当前对局天数与阶段（保证当前时段标签即使暂无权衡事件也出现，呼吸灯不滞留旧时段） */
  currentDay: number
  currentPhase: string
  /** 停歇类型：none=无；dayToNight=日→夜交替停歇（发动权衡黄灯仅此时亮起）；
   *  nightToDay/thinkBeat 与其他时间不亮黄灯 */
  phaseBreaking?: 'none' | 'nightToDay' | 'dayToNight' | 'thinkBeat'
  /** 赛后讨论频道出现时收缩为半高（36dvh），两框合计底部与中对局记录框基本对齐 */
  shrink?: boolean
  /** 胜利横幅出现时同幅收缩（与中对局记录+胜率条保持底部对齐） */
  fitBanner?: boolean
  /** 对局总计时起点（epoch ms）：每条权衡记录旁附距开始的经过时间 */
  t0?: number | null
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const getViewport = () =>
    wrapRef.current?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]') ?? null
  // 权衡框不显示夜间时段标签：夜晚停留最近一日标签（灰色待定），次日直接更新第N日标签
  const sessions = useMemo(() => {
    const grouped = groupEventsIntoSessions(events)
    return currentPhase.startsWith('day.')
      ? withCurrentSession(grouped, currentDay, currentPhase)
      : grouped
  }, [events, currentDay, currentPhase])
  const latestKey = sessions.length > 0 ? sessions[sessions.length - 1].key : ''
  const { stickRef, followLatestRef, scrollToBottom } = usePanelFollow(
    getViewport,
    sessions.length > 0,
  )
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const tabsListRef = useRef<HTMLDivElement>(null)

  // 绿灯闩锁：新一天标签先灰色待定，当天首次权衡思考出现后才变绿并保持到白天结束（夜晚复位为灰）
  const [greenDay, setGreenDay] = useState(0)
  useEffect(() => {
    if (currentPhase.startsWith('night.')) {
      setGreenDay(0)
    } else if (thinking && currentPhase.startsWith('day.')) {
      setGreenDay(currentDay)
    }
  }, [thinking, currentDay, currentPhase])
  const greenLit = live && greenDay === currentDay

  // 新时段出现：处于最新时段时立即切换（日夜交替停歇已提供完整阅读时间，
  // 停歇一结束须随主题同步更新到最新时段，不得滞后延迟）
  useEffect(() => {
    if (followLatestRef.current && latestKey) {
      setSelectedKey(latestKey)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestKey])

  const activeKey =
    selectedKey && sessions.some((s) => s.key === selectedKey) ? selectedKey : latestKey
  const activeSession = sessions.find((s) => s.key === activeKey) ?? null

  // 标签条横向自动滚动：激活标签变化时滚入可视区
  useEffect(() => {
    const list = tabsListRef.current
    if (!list) return
    const active = list.querySelector<HTMLElement>('[data-state="active"]')
    if (active) {
      // 仅横向滚动标签条自身使激活标签居中——scrollIntoView 会连带滚动整个页面（翻动体验差）
      const listRect = list.getBoundingClientRect()
      const elRect = active.getBoundingClientRect()
      const delta = elRect.left - listRect.left - (listRect.width - elRect.width) / 2
      list.scrollTo({ left: list.scrollLeft + delta, behavior: 'smooth' })
    }
  }, [activeKey])

  const handleTabChange = (key: string) => {
    followLatestRef.current = key === latestKey
    setSelectedKey(key)
  }

  const lastSeq =
    activeSession && activeSession.events.length > 0
      ? activeSession.events[activeSession.events.length - 1].seq
      : 0
  useEffect(() => {
    if (stickRef.current) scrollToBottom()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastSeq])

  return (
    <div ref={wrapRef}>
      <h2 className="mb-2 flex items-baseline gap-4 text-sm font-semibold text-foreground">
        白日主动技能的发动权衡
        <span className="font-mono text-xs font-normal text-muted-foreground">
          {events.length} 条
        </span>
      </h2>
      {sessions.length === 0 ? (
        <div className="rounded-md border border-border bg-muted/30 px-3 py-8">
          <p className="text-center text-xs text-muted-foreground">
            持有白天主动技能的角色的权衡心理活动，将在白天实时显示在这里
          </p>
        </div>
      ) : (
        <Tabs value={activeKey} onValueChange={handleTabChange} className="flex flex-col gap-2">
          <TabsList ref={tabsListRef} className="h-auto w-full justify-start gap-1 overflow-x-auto p-1">
            {sessions.map((s) => (
              <TabsTrigger key={s.key} value={s.key} className="shrink-0 gap-1.5 px-2.5 py-1">
                {live && s.key === latestKey ? (
                  // 黄灯仅在「日→夜」交替停歇期间亮起；
                  // 当天首次权衡思考出现后 → 绿色呼吸直到白天结束；否则灰色静止
                  phaseBreaking === 'dayToNight' ? (
                    <span className="relative flex h-1.5 w-1.5" aria-hidden>
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-500 opacity-60" />
                      <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-amber-500" />
                    </span>
                  ) : greenLit ? (
                    <span className="relative flex h-1.5 w-1.5" aria-hidden>
                      {/* 中亮绿呼吸（green-500）：与对局页面色调协调，夜间可辨，区别于学习环祖母绿 */}
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-500 opacity-60" />
                      <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-green-500" />
                    </span>
                  ) : (
                    <span
                      className="inline-flex h-1.5 w-1.5 rounded-full bg-muted-foreground/40"
                      aria-hidden
                    />
                  )
                ) : null}
                {s.label}
                <span className="font-mono text-[10px] text-muted-foreground">
                  {s.events.length}
                </span>
              </TabsTrigger>
            ))}
          </TabsList>
          <ScrollArea
            className={cn(
              'h-[calc(50dvh-2.75rem)] rounded-md border border-border bg-muted/30',
              // 收缩态：与赛后讨论框各半（36dvh），两框+两个 h2 标题+间距合计 ≈ 中栏 h2+72dvh，底部基本对齐
              shrink
                ? 'min-h-[180px] lg:h-[calc(50dvh-2rem)]'
                : fitBanner
                  ? 'lg:h-[calc(100dvh-360px)]'
                  : 'lg:h-[calc(100dvh-292px)]',
            )}
          >
            {activeSession && activeSession.events.length === 0 ? (
              <p className="px-4 py-10 text-center text-xs text-muted-foreground">
                本时段暂无权衡记录，出现白日主动技能权衡时将显示在这里
              </p>
            ) : null}
            <div className="space-y-2.5 p-2.5">
              {activeSession?.events.map((e) => {
                // 技能发动条目（自爆/决斗/带人）：引擎显式标记 channel=skillFired，加粗红字定位
                const fired = e.meta?.channel === 'skillFired'
                // 三标签：身份（如「骑士」「狼人」）+ 思考对象 + 权衡选择（按兵/发动）
                const skillObject =
                  typeof e.meta?.skillObject === 'string' ? e.meta.skillObject : undefined
                const roleName = e.actor != null ? roleNameOf(e.actor) : null
                return (
                  <div key={e.seq}>
                    <p className="flex flex-wrap items-center gap-1.5 text-xs">
                      {elapsedLabel(t0, e.createdAt) ? (
                        <span
                          className="font-mono text-[10px] text-muted-foreground/70"
                          title="距对局开始的经过时间"
                        >
                          {elapsedLabel(t0, e.createdAt)}
                        </span>
                      ) : null}
                      <span
                        className={fired ? 'font-bold text-wolf' : 'font-medium text-foreground'}
                      >
                        {e.actorLabel ?? `${e.actor}号玩家`}
                      </span>
                      {roleName ? (
                        <span
                          className={cn(
                            'rounded border px-1 py-0.5 text-[10px] leading-none',
                            fired
                              ? 'border-wolf/50 bg-wolf/10 font-bold text-wolf'
                              : 'border-border bg-secondary text-secondary-foreground',
                          )}
                        >
                          {roleName}
                        </span>
                      ) : null}
                      {skillObject ? (
                        <span
                          className={cn(
                            'rounded border px-1 py-0.5 text-[10px] leading-none',
                            fired
                              ? 'border-wolf/50 bg-wolf/10 font-bold text-wolf'
                              : 'border-border bg-muted text-muted-foreground',
                          )}
                        >
                          {skillObject}
                        </span>
                      ) : null}
                      {fired ? (
                        <span className="rounded border border-wolf/50 bg-wolf/10 px-1 py-0.5 text-[10px] font-bold leading-none text-wolf">
                          发动
                        </span>
                      ) : (
                        <span className="rounded border border-border px-1 py-0.5 text-[10px] leading-none text-muted-foreground">
                          按兵
                        </span>
                      )}
                      {fired ? <span className="break-words font-bold text-wolf">{e.content}</span> : null}
                    </p>
                    {e.thought ? (
                      <p
                        className={cn(
                          'mt-0.5 whitespace-pre-wrap break-words text-xs leading-5',
                          fired ? 'font-bold text-wolf' : 'text-muted-foreground',
                        )}
                      >
                        {e.thought}
                      </p>
                    ) : null}
                  </div>
                )
              })}
            </div>
          </ScrollArea>
        </Tabs>
      )}
    </div>
  )
}

/** 日夜交替停歇倒计时：「还有 X 秒进入下一日/夜」，颜色与黄灯一致 */
function PhaseBreakCountdown({
  totalMs,
  startedAt,
  direction,
}: {
  totalMs: number
  startedAt: number
  direction: 'day' | 'night'
}) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(t)
  }, [])
  const remaining = Math.max(0, Math.ceil((totalMs - (now - startedAt)) / 1000))
  return (
    <span className="text-xs font-medium text-amber-500">
      还有 {remaining} 秒进入下一{direction === 'day' ? '日' : '夜'}
    </span>
  )
}

/** 运行状态呼吸点 */
function StatusDot({ status }: { status: GameStatus }) {  if (status === 'running') {
    // 绿色呼吸灯：与对局记录（蓝）、权衡记录（红）的标签呼吸灯区分（green-500，协调且可辨）
    return (
      <span className="relative flex h-2.5 w-2.5" aria-hidden>
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-500 opacity-60" />
        <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-green-500" />
      </span>
    )
  }
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex h-2.5 w-2.5 rounded-full',
        status === 'paused' && 'bg-amber-500',
        status === 'finished' && 'bg-muted-foreground/50',
        status === 'created' && 'bg-muted-foreground/30',
      )}
    />
  )
}

/** 总计时：从点击「开始对局」起（mm:ss / h:mm:ss）；终局后冻结在最后一条事件时刻 */
function GameElapsed({ t0, frozenAt }: { t0: number; frozenAt: number | null }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (frozenAt != null) return
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [frozenAt])
  return (
    <span
      className="font-mono text-xs text-muted-foreground"
      title="从点击开始对局起的总计时"
    >
      总计时 {formatElapsed(((frozenAt ?? now) - t0) / 1000)}
    </span>
  )
}

export default function GameRoom() {
  const { id } = useParams<{ id: string }>()
  const gameId = id ?? ''
  const api = useGameApi()
  const { user } = useAuth()
  // 登录态 id：登录成功后触发轮询重置（未登录守卫解除，自动恢复连接）
  const userId = user?.id ?? null

  const [snapshot, setSnapshot] = useState<GameSnapshot | null>(null)
  const [events, setEvents] = useState<GameEvent[]>([])
  const [notFound, setNotFound] = useState(false)
  // 未登录守卫：轮询接口要求登录，UNAUTHORIZED 时停轮询并展示登录提示（而非无限「正在连接」）
  const [unauthorized, setUnauthorized] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'control' | 'export' | 'postgame' | null>(null)
  const [selectedSeat, setSelectedSeat] = useState<number | null>(null)
  // 分析报告：任务状态 / 当前阶段 / 报告全文 / 查看弹窗 / 手动触发中的提示
  const [jobStatus, setJobStatus] = useState<AnalysisJobStatus>('idle')
  const [jobStage, setJobStage] = useState<AnalysisJobStage>(null)
  const [report, setReport] = useState<AnalysisReport | null>(null)
  const [reportOpen, setReportOpen] = useState(false)
  const [analysisMsg, setAnalysisMsg] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)
  // 人格研究库：心理尸检报告（终局由解剖师自动生成；打开弹窗时刷新）
  const [personaReports, setPersonaReports] = useState<PersonaReport[] | null>(null)
  const [personaReportOpen, setPersonaReportOpen] = useState(false)
  // 对局回放控制器（历史对局事件流按真实节奏重现）——
  // 注意：所有 replay 相关 hook 必须在下方条件早退（unauthorized/notFound/!snapshot）之前，
  // 否则加载态与就绪态 hook 数不一致直接白屏（线上实锤）
  const replay = useReplay(events)
  // 带 ?replay=1 跳入：事件就绪后自动进入回放（只触发一次）
  const [searchParams] = useSearchParams()
  const wantReplay = searchParams.get('replay') === '1'
  const replayAutoStarted = useRef(false)
  useEffect(() => {
    if (!wantReplay || replayAutoStarted.current || replay.active) return
    if (events.length === 0 || snapshot?.status === 'running') return
    replayAutoStarted.current = true
    replay.start()
  }, [wantReplay, replay, events.length, snapshot?.status])
  // 终止对局确认弹窗（终止不可逆，必须二次确认）
  const [terminateOpen, setTerminateOpen] = useState(false)
  // 胜率推测：评估记录（按 id 升序追加）/ 最新胜率 / 本局是否开启 / 理由列表排序（默认倒序=最新在顶）
  const [winRateEntries, setWinRateEntries] = useState<WinRateEntry[]>([])
  const [winRatePct, setWinRatePct] = useState<{ goodPct: number; wolfPct: number }>({
    goodPct: 50,
    wolfPct: 50,
  })
  const [hasWinRate, setHasWinRate] = useState(false)
  const [winRateOrder, setWinRateOrder] = useState<'desc' | 'asc'>('desc')
  // 胜率侧筛选：'good'=只看神民胜率上升的理由 / 'wolf'=只看狼人胜率上升 / null=全部
  //（点击胜率条下方的阵营-胜率文本切换，选中文本加粗；一方胜率为 0 时胜率条不可见，文本仍可点）
  const [winRateSide, setWinRateSide] = useState<'good' | 'wolf' | null>(null)
  // 胜率面板折叠：默认只显示胜率条与下方标注文本，变动理由列表折叠（点击展开）
  const [winRateExpanded, setWinRateExpanded] = useState(false)
  // 点击某侧阵营文本：切换筛选并自动展开理由列表
  const handleWinRateSide = (side: 'good' | 'wolf') => {
    setWinRateSide((prev) => (prev === side ? null : side))
    setWinRateExpanded(true)
  }
  // 理由列表只呈现「胜率实际发生变化」的记录：与上一条相比 goodPct 不同
  // （首条与初始 50/50 基准相比）——胜率不变的评估不予显示，理由自然不重复
  const changedWinRateEntries = useMemo(
    () =>
      winRateEntries.filter((e, i, arr) =>
        i === 0 ? e.goodPct !== 50 : e.goodPct !== arr[i - 1].goodPct,
      ),
    [winRateEntries],
  )
  // 点击胜率条后的筛选结果（方向基于完整时间序判定，不受筛选/排序影响）
  const visibleWinRateEntries = useMemo(
    () =>
      winRateSide
        ? changedWinRateEntries.filter((e) => directionOf(winRateEntries, e) === winRateSide)
        : changedWinRateEntries,
    [changedWinRateEntries, winRateEntries, winRateSide],
  )

  // 总计时起点：优先取点击「开始对局」的记录时刻（localStorage 按对局持久化）；
  // 无记录（如旧对局回看）回退首条事件时刻 → 对局创建时刻
  const gameT0 = useMemo(() => {
    try {
      const stored = Number(localStorage.getItem(gameStartStorageKey(gameId)))
      if (Number.isFinite(stored) && stored > 0) return stored
    } catch {
      /* localStorage 不可用时回退 */
    }
    const first = events[0]?.createdAt
    if (first) {
      const t = Date.parse(first)
      if (!Number.isNaN(t)) return t
    }
    return snapshot ? Date.parse(snapshot.createdAt) : null
  }, [gameId, events, snapshot])

  // 增量游标与去重集合放在 ref：轮询回调不随渲染重建
  const afterSeqRef = useRef(0)
  const lastSigRef = useRef('')
  // 胜率推测游标与去重集合（与事件流同一 ref+state 模式：轮询回调不随渲染重建）
  const afterWinRateIdRef = useRef(0)
  const seenWinRateIdRef = useRef<Set<number>>(new Set())
  // 自适应轮询间隔（ref）：轮询循环读取最新值但不以其为依赖——
  // 历史事故：intervalMs 曾作为 state 放进轮询 effect 依赖，间隔一切换就整体重置
  // （snapshot→null→间隔再变→再重置），形成乒乓死循环，页面永远「正在连接对局…」
  const intervalMsRef = useRef(POLL_INTERVAL_MS)
  const seenSeqRef = useRef<Set<number>>(new Set())
  const inFlightRef = useRef(false)
  const inFlightSinceRef = useRef(0)
  const stoppedRef = useRef(false)
  // 轮询健康度：最后一次成功时刻 + 连续失败计数（驱动「连接中断重连中」提示与停滞自愈）
  const lastSuccessAtRef = useRef(Date.now())
  const failCountRef = useRef(0)
  const [connIssue, setConnIssue] = useState(false)
  const apiRef = useRef(api)
  useEffect(() => {
    apiRef.current = api
  }, [api])

  // 快照渲染签名：视觉相关的字段不变时跳过 setState，避免 1.5s 轮询空转触发整页重渲染
  const snapshotSigRef = useRef('')
  /** 单次轮询：快照整体替换（无变化时跳过），事件只追加；错误静默（NOT_FOUND 除外） */
  const pollOnce = useCallback(async () => {
    if (!gameId || stoppedRef.current) return
    // 看门狗：上一拍超过 15s 未返回视为挂死（fetch 挂起且熔断也未生效时的自愈兜底），强制放行
    if (inFlightRef.current) {
      if (Date.now() - inFlightSinceRef.current < 15_000) return
      inFlightRef.current = false
    }
    inFlightRef.current = true
    inFlightSinceRef.current = Date.now()
    try {
      const result = await apiRef.current.pollGame(
        gameId,
        afterSeqRef.current,
        lastSigRef.current,
        afterWinRateIdRef.current,
      )
      // 成功落点：健康度复位（含 304 快路径——unchanged 也是成功响应）
      lastSuccessAtRef.current = Date.now()
      if (failCountRef.current > 0) {
        failCountRef.current = 0
        setConnIssue(false)
      }
      // 304 快路径：tickKey 未变——零处理（无快照重建/无签名计算/无重渲染）
      if (result.unchanged) return
      if (result.tickKey) lastSigRef.current = result.tickKey
      const s = result.snapshot
      if (s) {
        // 轻量签名：仅动态字段（存活/警长/死因），不再每次全量 JSON 序列化玩家对象
        const playersSig = s.players
          .map((p) => `${p.seat}:${p.alive ? 1 : 0}${p.sheriff ? 1 : 0}${p.deathInfo ?? ''}`)
          .join(',')
        const sig = `${s.status}|${s.day}|${s.phaseLabel}|${s.winner}|${s.pendingSeat}|${JSON.stringify(s.pendingActs)}|${s.phaseBreaking}|${s.phaseBreakStartedAt}|${s.seq}|${playersSig}|${(s.studyingSeats ?? []).join('.')}`
        if (sig !== snapshotSigRef.current) {
          snapshotSigRef.current = sig
          setSnapshot(s)
        }
        const maxEventSeq = result.events.reduce((m, e) => Math.max(m, e.seq), 0)
        afterSeqRef.current = Math.max(afterSeqRef.current, s.seq, maxEventSeq)
      }
      if (result.events.length > 0) {
        const fresh = result.events.filter((e) => !seenSeqRef.current.has(e.seq))
        if (fresh.length > 0) {
          for (const e of fresh) seenSeqRef.current.add(e.seq)
          setEvents((prev) => [...prev, ...fresh])
        }
      }
      // 补开赛后讨论资格（已结束+分胜负+无赛后内容）：后端透出即显示「开启赛后讨论」按钮
      if (result.postGameEligible) setPostGameEligible(true)
      if (result.study) setStudy(result.study)
      // 胜率推测：仅本局开启时后端返回该字段——收到即视为开启（面板据此显示）
      if (result.winRate) {
        setHasWinRate(true)
        setWinRatePct({ goodPct: result.winRate.goodPct, wolfPct: result.winRate.wolfPct })
        const freshRates = result.winRate.entries.filter((r) => !seenWinRateIdRef.current.has(r.id))
        if (freshRates.length > 0) {
          for (const r of freshRates) seenWinRateIdRef.current.add(r.id)
          afterWinRateIdRef.current = Math.max(afterWinRateIdRef.current, ...freshRates.map((r) => r.id))
          setWinRateEntries((prev) => [...prev, ...freshRates])
        }
      }
    } catch (err) {
      if (isNotFoundError(err)) {
        stoppedRef.current = true
        setNotFound(true)
      } else if (isUnauthorizedError(err)) {
        stoppedRef.current = true
        setUnauthorized(true)
      } else {
        // 其余错误静默重试：连续失败 ≥2 次亮「连接中断」提示（成功即自动熄灭）
        failCountRef.current += 1
        if (failCountRef.current >= 2) setConnIssue(true)
      }
    } finally {
      inFlightRef.current = false
    }
  }, [gameId])

  // 进入页面 / gameId 变化：重置游标与状态，启动递归轮询（setTimeout 链）。
  // 递归式优于 setInterval：间隔在响应返回后才起算（天然防重叠），且读取
  // intervalMsRef 最新值实现自适应——依赖恒定，绝不因间隔调整而重置状态。
  useEffect(() => {
    afterSeqRef.current = 0
    lastSigRef.current = ''
    afterWinRateIdRef.current = 0
    seenWinRateIdRef.current = new Set()
    snapshotSigRef.current = ''
    seenSeqRef.current = new Set()
    inFlightRef.current = false
    stoppedRef.current = false
    failCountRef.current = 0
    lastSuccessAtRef.current = Date.now()
    setConnIssue(false)
    setSnapshot(null)
    setEvents([])
    setNotFound(false)
    setUnauthorized(false)
    setSelectedSeat(null)
    setActionError(null)
    setJobStatus('idle')
    setJobStage(null)
    setReport(null)
    setReportOpen(false)
    setAnalysisMsg(null)
    setGenerating(false)
    setWinRateEntries([])
    setWinRatePct({ goodPct: 50, wolfPct: 50 })
    setHasWinRate(false)
    setWinRateOrder('desc')
    setWinRateSide(null)
    setWinRateExpanded(false)
    let alive = true
    let timer = 0
    const loop = async () => {
      await pollOnce()
      if (!alive) return
      timer = window.setTimeout(() => void loop(), intervalMsRef.current)
    }
    void loop()
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [gameId, pollOnce, userId])

  // 防停滞自愈（事故：后台标签页定时器被浏览器节流/冻结，轮询静默停摆，
  // 后端照常推进，用户误以为卡顿、刷新才发现已推进许多）：
  // 1) 回到前台/聚焦/网络恢复 → 立即补拉一次，不等被节流的下一个定时器
  // 2) 停滞看门狗：前台状态下距上次成功响应超过 12s（定时器链异常/请求挂死漏网）
  //    → 绕过间隔立即补拉。任何隐性停摆最多 12s 自愈，无需手动刷新
  useEffect(() => {
    const catchUp = () => {
      if (!document.hidden && !stoppedRef.current) void pollOnce()
    }
    const watchdog = window.setInterval(() => {
      if (document.hidden || stoppedRef.current) return
      if (inFlightRef.current) return
      if (Date.now() - lastSuccessAtRef.current > 12_000) void pollOnce()
    }, 4000)
    document.addEventListener('visibilitychange', catchUp)
    window.addEventListener('focus', catchUp)
    window.addEventListener('online', catchUp)
    return () => {
      window.clearInterval(watchdog)
      document.removeEventListener('visibilitychange', catchUp)
      window.removeEventListener('focus', catchUp)
      window.removeEventListener('online', catchUp)
    }
  }, [pollOnce])

  // 自适应轮询间隔：运行中高频、暂停降频、终局低频（减少无意义空转）
  // 只写 ref，不触发任何重渲染/ effect 重跑
  const pollStatus = snapshot?.status
  useEffect(() => {
    intervalMsRef.current =
      pollStatus === 'running' ? POLL_INTERVAL_MS : pollStatus === 'paused' ? 4000 : 8000
  }, [pollStatus])

  // 赛后讨论：分出胜负后服务层在 postgameSpeak 待决处挂起（paused），
  // 顶栏「开启赛后讨论」按钮按下即开始生成（专用通道 startPostGame，与继续键职责分离）；
  // 生成中按钮变为「终止赛后发言」；已生成则为「查看赛后发言」——对局记录切到「赛后发言」时间标签
  const [recordFocusKey, setRecordFocusKey] = useState<string | null>(null)
  // 补开资格（poll 透出）：已结束、分了胜负、还没有赛后内容的旧对局也能点「开启赛后讨论」
  const [postGameEligible, setPostGameEligible] = useState(false)
  // 赛前图书馆学习进度（开启图书馆的对局由轮询透出）
  const [study, setStudy] = useState<{ done: number; total: number; studying: boolean } | null>(null)
  // 各座位学习心得（点击座位查看详情；done 变化时增量拉取）
  const [studyNotes, setStudyNotes] = useState<Record<number, string>>({})
  const studyDoneCount = study?.done ?? 0
  useEffect(() => {
    if (!gameId || !study || studyDoneCount === 0) return
    let cancelled = false
    apiRef.current
      .getStudyNotes(gameId)
      .then((rows) => {
        if (cancelled) return
        setStudyNotes(Object.fromEntries(rows.map((r) => [r.seat, r.notes])))
      })
      .catch(() => {
        /* 静默：下拍重试 */
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameId, studyDoneCount])
  const recordSectionRef = useRef<HTMLElement>(null)
  useEffect(() => {
    setRecordFocusKey(null)
    setPostGameEligible(false)
  }, [gameId])

  // 对局分出胜负后即轮询分析任务状态（每 3s，done/failed 终态后停止）——
  // 含赛后发言生成中（winner 已定、status 仍 running），报告就绪即可查看
  const finished = snapshot?.status === 'finished'
  const analyzable = finished || snapshot?.status === 'paused' || snapshot?.winner != null
  useEffect(() => {
    if (!gameId || !analyzable) return
    let cancelled = false
    let timer = 0
    const tick = async () => {
      if (cancelled) return
      try {
        const res = await apiRef.current.getAnalysis(gameId)
        if (cancelled) return
        setJobStatus(res.jobStatus)
        setJobStage(res.jobStage)
        setReport(res.report)
        if (res.jobStatus === 'failed' && res.jobError) {
          setAnalysisMsg(`分析失败：${res.jobError}`)
        }
        if (res.jobStatus === 'done' || res.jobStatus === 'failed') {
          window.clearInterval(timer)
        }
      } catch {
        // 静默，下一拍重试
      }
    }
    void tick()
    timer = window.setInterval(() => void tick(), ANALYSIS_POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [gameId, analyzable])

  // 稳定引用：配合 memo(SeatGrid)，避免每次渲染都生成新回调击穿缓存
  const handleSelectSeat = useCallback((seat: number) => {
    setSelectedSeat((prev) => (prev === seat ? null : seat))
  }, [])

  /** 手动触发分析：分析师配置取 localStorage（大厅「分析师配置」卡片写入） */
  async function handleGenerateAnalysis() {
    if (generating) return
    const cfg = resolveAnalystAiConfig()
    // cfg 为 null 时仍调用后端：后端会尝试复用该对局座位的 agent 配置（分析师与玩家共用同一 agent）
    setGenerating(true)
    setAnalysisMsg(null)
    try {
      await api.generateAnalysis(gameId, cfg ?? undefined)
      const res = await api.getAnalysis(gameId)
      setJobStatus(res.jobStatus)
      setJobStage(res.jobStage)
      setReport(res.report)
    } catch (err) {
      setAnalysisMsg(err instanceof Error ? err.message : '启动分析失败，请重试')
    } finally {
      setGenerating(false)
    }
  }

  async function handleControl(action: 'start' | 'pause' | 'terminate' | 'stopPostGame') {
    if (busy) return
    setBusy('control')
    setActionError(null)
    try {
      await api.controlGame(gameId, action)
      // 总计时起点：首次点击「开始/启动对局」时记录（暂停恢复不重置）
      if (action === 'start') {
        try {
          const key = gameStartStorageKey(gameId)
          if (!localStorage.getItem(key)) localStorage.setItem(key, String(Date.now()))
        } catch {
          /* localStorage 不可用不影响对局 */
        }
      }
      await pollOnce()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '操作失败，请重试')
    } finally {
      setBusy(null)
    }
  }

  // 开启赛后讨论（专用通道 startPostGame，不与继续键重合）：
  // 挂起待开始 → 直接恢复生成；已结束旧对局 → 决策日志重放续跑
  async function handleStartPostGame() {
    if (busy) return
    setBusy('postgame')
    setActionError(null)
    try {
      const r = await api.startPostGame(gameId)
      if (!r.started) {
        setActionError(r.reason ?? '无法开启赛后讨论')
      }
      await pollOnce()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '开启赛后讨论失败，请重试')
    } finally {
      setBusy(null)
    }
  }

  async function handleExport() {
    if (busy) return
    setBusy('export')
    setActionError(null)
    try {
      const data = await api.exportGame(gameId)
      downloadGameLogs(data.snapshot, data.events)
    } catch (err) {
      setActionError(`导出失败：${err instanceof Error ? err.message : '未知错误'}`)
    } finally {
      setBusy(null)
    }
  }

  // ------------------------------------------------------------------
  // 异常 / 加载态
  // ------------------------------------------------------------------

  // 未登录：友好登录提示（内嵌登录入口），登录成功后上方 effect 自动重启轮询
  if (unauthorized) {
    return (
      <LoginRequiredCard
        title="对局观察室需要登录后查看"
        description={`对局编号：${gameId}。登录后即可继续观察这局 AI 博弈。`}
      />
    )
  }

  if (notFound) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6">
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <CircleAlert className="h-8 w-8 text-muted-foreground" aria-hidden />
            <p className="text-base font-medium text-foreground">未找到该对局</p>
            <p className="break-all font-mono text-sm text-muted-foreground">对局编号：{gameId}</p>
            <p className="text-sm text-muted-foreground">
              对局可能已被删除，或编号有误。你可以返回大厅查看历史对局。
            </p>
            <Button asChild variant="outline" className="mt-2">
              <Link to="/">返回大厅</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  if (!snapshot) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6">
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-hidden />
            <p className="text-base text-foreground">正在连接对局…</p>
            <p className="break-all font-mono text-sm text-muted-foreground">对局编号：{gameId}</p>
          </CardContent>
        </Card>
      </div>
    )
  }

  // ------------------------------------------------------------------
  // 派生展示状态
  // ------------------------------------------------------------------

  const status = snapshot.status
  const isNight = snapshot.phase.startsWith('night')
  // 回放可用性（控制器本体在上方 hook 区；这里只做派生计算）
  const replayAvailable = events.length > 0 && status !== 'running'
  const visibleEvents = replay.active ? events.slice(0, replay.cursorIdx) : events
  // 回放态座位重构：死亡信息按游标处事件流推导（角色/警长沿用快照）
  const displayPlayers = (() => {
    if (!replay.active) return snapshot.players
    const deaths = new Map<number, string>()
    for (const e of visibleEvents) {
      if (e.type === 'death' && e.actor != null) deaths.set(e.actor, `第${e.day}天 · ${e.title}`)
    }
    return snapshot.players.map((p) =>
      deaths.has(p.seat)
        ? { ...p, alive: false, deathInfo: deaths.get(p.seat)! }
        : { ...p, alive: true, deathInfo: null },
    )
  })()
  const selectedPlayer = displayPlayers.find((p) => p.seat === selectedSeat) ?? null
  const alivePlayers = displayPlayers.filter((p) => p.alive)
  // 回放游标处的时段（驱动事件流标签页跟随）
  const cursorEvent = replay.active && visibleEvents.length > 0 ? visibleEvents[visibleEvents.length - 1]! : null
  const highlightSeq = replay.active && cursorEvent ? cursorEvent.seq : null
  // 技能权衡事件（daySkill 按兵不动的心理活动）分流：不进对局记录，进右侧权衡框；
  // 权衡框同时收录真正发动技能的事件（phase=day.skill 且无标记，加粗红字呈现）——主线也保留这些发动事件
  const isSkillThink = (e: GameEvent) => e.meta?.channel === 'skillThink'
  const streamEvents = visibleEvents.filter((e) => !isSkillThink(e))
  // 权衡框：按兵不动（skillThink）+ 技能发动（skillFired，引擎显式标记，杜绝误标）
  const skillThinkEvents = visibleEvents.filter(
    (e) => isSkillThink(e) || e.meta?.channel === 'skillFired',
  )
  // 赛后发言事件（phase=postgame.*）保留在主对局记录中，以「赛后发言」时间标签分组展示
  // （按钮/资格判定用全集，不随回放游标截断）
  const postGameEvents = events.filter((e) => e.phase.startsWith('postgame'))
  // 本局可开启/查看赛后讨论（引擎进入过 postgame 阶段：挂起提示事件已落盘；
  // 或旧对局已结束分胜负但无赛后内容，poll 透出补开资格）→ 顶栏出现按钮
  const postGameAvailable =
    postGameEvents.length > 0 || snapshot.phase.startsWith('postgame') || postGameEligible
  // 赛后讨论生成中：对局 running 且当前处于 postgame 阶段
  const postGameRunning = status === 'running' && snapshot.phase.startsWith('postgame')
  // 赛后讨论待开始：paused 且停在 postgame（分出胜负后挂起）
  const postGameHeld = status === 'paused' && snapshot.phase.startsWith('postgame')

  // 比赛结果出现（分出胜负或对局结束）后：继续/暂停与终止按钮消失
  const resultShown = snapshot.winner !== null || status === 'finished'

  const controlButton =
    resultShown ? null : status === 'running' ? (
      <Button
        size="sm"
        variant="outline"
        onClick={() => void handleControl('pause')}
        disabled={busy !== null}
      >
        {busy === 'control' ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        ) : (
          <Pause className="h-4 w-4" aria-hidden />
        )}
        暂停
      </Button>
    ) : (
      <Button
        size="sm"
        onClick={() => void handleControl('start')}
        disabled={busy !== null}
      >
        {busy === 'control' ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        ) : (
          <Play className="h-4 w-4" aria-hidden />
        )}
        {status === 'created' ? '启动' : '继续'}
      </Button>
    )

  // 终止按钮：对局未分胜负时可点（二次确认后不可逆终止，随时收掉测试局开新局）
  const terminateButton =
    resultShown ? null : (
      <Button
        size="sm"
        variant="outline"
        className="border-wolf/40 text-wolf hover:bg-wolf/10 hover:text-wolf"
        onClick={() => setTerminateOpen(true)}
        disabled={busy !== null}
        title="立即结束本局（不可逆），可随时开启新的测试"
      >
        <OctagonX className="h-4 w-4" aria-hidden />
        终止
      </Button>
    )

  // 分析报告按钮（分出胜负后即出现：终局/暂停/赛后发言生成中都保持可见，不随赛后讨论开关消失）
  const analysisButton =
    !(status === 'finished' || status === 'paused' || snapshot.winner != null) ? null : report ? (
      <Button size="sm" variant="outline" onClick={() => setReportOpen(true)}>
        <FileText className="h-4 w-4" aria-hidden />
        查看分析报告
      </Button>
    ) : jobStatus === 'running' || generating ? (
      <Button size="sm" variant="outline" disabled>
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        {jobStage === 'analyze'
          ? '分析师复盘中（撰写报告…）'
          : jobStage === 'distill'
            ? '分析师复盘中（沉淀经验指南…）'
            : '分析师复盘中…'}
      </Button>
    ) : jobStatus === 'failed' ? (
      <Button
        size="sm"
        variant="outline"
        onClick={() => void handleGenerateAnalysis()}
        disabled={generating}
      >
        <CircleAlert className="h-4 w-4 text-wolf" aria-hidden />
        分析失败 · 重试
      </Button>
    ) : (
      <Button
        size="sm"
        variant="outline"
        onClick={() => void handleGenerateAnalysis()}
        disabled={generating}
      >
        <Sparkles className="h-4 w-4" aria-hidden />
        生成分析报告
      </Button>
    )

  // 心理尸检按钮（本局有人格座位即显示；报告由解剖师在终局异步生成，打开时拉取/刷新）
  const hasPersonaSeats = (snapshot?.players ?? []).some((p) => p.personaName)
  const openPersonaReports = async () => {
    if (!gameId) return
    setPersonaReportOpen(true)
    try {
      setPersonaReports(await api.getGamePersonaReports(gameId))
    } catch {
      setPersonaReports([])
    }
  }
  const personaButton = !hasPersonaSeats ? null : (
    <Button size="sm" variant="outline" onClick={() => void openPersonaReports()}>
      <Brain className="h-4 w-4 text-purple-500" aria-hidden />
      心理尸检
    </Button>
  )

  // 赛后讨论按钮（顶栏，与继续/暂停键职责完全分离）：
  // 待开始（挂起/旧对局补开）→「开启赛后讨论」（专用通道 startPostGame）；
  // 生成中 →「终止赛后发言」（control stopPostGame，停止赛后循环，胜负结果不受影响）；
  // 已生成 →「查看赛后发言」（对局记录切到「赛后发言」时间标签并滚动到位）
  const postGameButton = !postGameAvailable ? null : postGameRunning ? (
    <Button
      size="sm"
      variant="outline"
      className="border-wolf/40 text-wolf hover:bg-wolf/10 hover:text-wolf"
      onClick={() => void handleControl('stopPostGame')}
      disabled={busy !== null}
    >
      {busy === 'control' ? (
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      ) : (
        <OctagonX className="h-4 w-4" aria-hidden />
      )}
      终止赛后发言
    </Button>
  ) : postGameEvents.length === 0 || postGameHeld ? (
    <Button
      size="sm"
      variant="outline"
      onClick={() => void handleStartPostGame()}
      disabled={busy !== null}
    >
      {busy === 'postgame' ? (
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      ) : (
        <MessagesSquare className="h-4 w-4" aria-hidden />
      )}
      开启赛后讨论
    </Button>
  ) : (
    <Button
      size="sm"
      variant="outline"
      onClick={() => {
        setRecordFocusKey('postgame')
        recordSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      }}
    >
      <MessagesSquare className="h-4 w-4" aria-hidden />
      查看赛后发言
    </Button>
  )

  // ------------------------------------------------------------------
  // 渲染（夜晚阶段整体切深色调 .dark）
  // ------------------------------------------------------------------

  return (
    <div className={cn(isNight && 'dark')}>
      <div className="min-h-[calc(100dvh-3.5rem)] bg-background text-foreground transition-colors">
        {/* 顶栏（sticky，位于全局导航 h-14 之下） */}
        <div className="sticky top-14 z-40 border-b border-border bg-background">
          <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 sm:px-8">
            <span className="text-sm font-semibold text-foreground">{snapshot.boardName}</span>
            {snapshot.titleNo ? (
              <span className="font-mono text-xs text-muted-foreground" title="对局标题号（YYYYMMDD+当日序号）">
                #{snapshot.titleNo}
              </span>
            ) : null}
            {snapshot.day >= 1 ? (
              <span className="font-mono text-sm text-muted-foreground">
                第{snapshot.day}天
              </span>
            ) : null}
            <Badge variant="outline" className="font-normal">
              {snapshot.phaseLabel}
            </Badge>
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <StatusDot status={status} />
              {statusLabelOf(status, snapshot.winner)}
            </span>
            {/* 总计时：从点击开始对局起；未启动（且未在赛前学习）不显示；终局冻结 */}
            {gameT0 != null && (status !== 'created' || study?.studying) ? (
              <GameElapsed
                t0={gameT0}
                frozenAt={
                  status === 'finished'
                    ? events.length > 0
                      ? Date.parse(events[events.length - 1].createdAt)
                      : Date.now()
                    : null
                }
              />
            ) : null}
            {/* 对局回放入口（非运行中即可）：点击后控制条在下方独立一栏展开 */}
            {replayAvailable && !replay.active ? <ReplayBar replay={replay} /> : null}
            {connIssue ? (
              <span className="flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-400">
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                连接中断，正在自动重连…
              </span>
            ) : null}

            <span className="ml-auto flex flex-wrap items-center justify-end gap-2">
              {actionError ? (
                <span className="max-w-64 truncate text-xs text-wolf" title={actionError}>
                  {actionError}
                </span>
              ) : null}
              {controlButton}
              {terminateButton}
              {analysisButton}
              {personaButton}
              {postGameButton}
              <Button
                size="sm"
                variant="outline"
                onClick={() => void handleExport()}
                disabled={busy !== null}
              >
                {busy === 'export' ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <Download className="h-4 w-4" aria-hidden />
                )}
                导出日志
              </Button>
              {/* 返回大厅：仅对局结束或暂停时可点 */}
              {status === 'finished' || status === 'paused' ? (
                <Button asChild size="sm" variant="ghost">
                  <Link to="/">
                    <ArrowLeft className="h-4 w-4" aria-hidden />
                    返回大厅
                  </Link>
                </Button>
              ) : (
                <Button size="sm" variant="ghost" disabled title="对局进行/未启动时不离开观察室">
                  <ArrowLeft className="h-4 w-4" aria-hidden />
                  返回大厅
                </Button>
              )}
            </span>
          </div>
          {/* 回放控制栏：与上方同宽（max-w-[1600px] px-4 sm:px-8），进度条居中——
              点击「查看回放」后在此展开；退出后收起 */}
          {replayAvailable && replay.active ? (
            <div className="mx-auto flex max-w-[1600px] items-center justify-center px-4 pb-2.5 sm:px-8">
              <ReplayBar replay={replay} />
            </div>
          ) : null}
        </div>

        <div className="mx-auto max-w-[1600px] space-y-4 px-4 py-4 sm:px-8">
          {/* 结束横幅：分出胜负即出现（赛后发言进行不阻碍胜利结果）；胜负阵营 / 手动终止 + 存活名单 */}
          {resultShown ? (
            <div
              className={cn(
                'flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-4 py-3',
                snapshot.winner === 'wolf'
                  ? 'border-wolf/40 bg-wolf/5'
                  : snapshot.winner === 'good'
                    ? 'border-amber-400/50 bg-amber-400/10'
                    : 'border-border bg-muted/40',
              )}
            >
              {snapshot.winner === null ? (
                <OctagonX className="h-5 w-5 text-muted-foreground" aria-hidden />
              ) : (
                <Trophy
                  className={cn(
                    'h-5 w-5',
                    snapshot.winner === 'wolf' ? 'text-wolf' : 'text-amber-500',
                  )}
                  aria-hidden
                />
              )}
              <span
                className={cn(
                  'text-base font-semibold',
                  snapshot.winner === 'wolf'
                    ? 'text-wolf'
                    : snapshot.winner === 'good'
                      ? 'text-amber-600 dark:text-amber-400'
                      : 'text-muted-foreground',
                )}
              >
                {snapshot.winner === 'wolf'
                  ? '狼人阵营胜利'
                  : snapshot.winner === 'good'
                    ? '神民阵营胜利'
                    : '对局已手动终止'}
              </span>
              <span className="text-sm text-muted-foreground">
                存活名单：
                {alivePlayers.length > 0
                  ? alivePlayers.map((p) => `${p.seat}号 ${p.roleName}`).join('、')
                  : '无'}
              </span>
              {analysisMsg ? (
                <span className="flex w-full items-center gap-1.5 pt-1 text-xs text-wolf">
                  <CircleAlert className="h-3.5 w-3.5" aria-hidden />
                  {analysisMsg}
                </span>
              ) : null}
            </div>
          ) : null}

          {/* created：中央大按钮启动对局（开启图书馆时，启动后先进入赛前学习） */}
          {status === 'created' ? (
            <div className="flex flex-col items-center gap-3 rounded-lg border border-border bg-card px-6 py-12 text-center">
              {study?.studying ? (
                <>
                  <p className="text-lg font-semibold text-foreground">
                    AI 赛前学习中（{study.done}/{study.total}）
                  </p>
                  <p className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                    各座位正在选读图书馆资料并写下学习心得——点击座位可查看学习详情，
                    全部学完后自动开赛进入黑夜
                  </p>
                </>
              ) : study && study.done >= study.total && study.total > 0 ? (
                <>
                  <p className="text-lg font-semibold text-foreground">赛前学习完毕</p>
                  <p className="text-sm text-muted-foreground">
                    {study.total} 个座位均已完成图书馆学习（点击座位可回看各 AI 的学习心得）
                  </p>
                  <Button
                    size="lg"
                    className="mt-2 px-10 text-base"
                    onClick={() => void handleControl('start')}
                    disabled={busy !== null}
                  >
                    {busy === 'control' ? (
                      <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
                    ) : (
                      <Play className="h-5 w-5" aria-hidden />
                    )}
                    启动对局
                  </Button>
                </>
              ) : (
                <>
                  <p className="text-lg font-semibold text-foreground">对局已创建，尚未启动</p>
                  <p className="text-sm text-muted-foreground">
                    {snapshot.boardName} · {snapshot.players.length} 个座位 · 角色已分配
                    {study ? '；本局开启图书馆：开始后各座位先进行赛前学习，学完自动进入黑夜' : '，启动后引擎将逐步自动推演'}
                  </p>
                  <Button
                    size="lg"
                    className="mt-2 px-10 text-base"
                    onClick={() => void handleControl('start')}
                    disabled={busy !== null}
                  >
                    {busy === 'control' ? (
                      <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
                    ) : (
                      <Play className="h-5 w-5" aria-hidden />
                    )}
                    开始对局
                  </Button>
                </>
              )}
            </div>
          ) : null}

          {/* 三栏布局：左座位+玩家详情 / 中事件流 / 右技能权衡 */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
            {/* 左栏：圆桌座位区 + 玩家详情（座位框下方） */}
            <section className="lg:col-span-4">
              <h2 className="mb-2 text-sm font-semibold text-foreground">
                座位（上帝视角）
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  {alivePlayers.length}/{snapshot.players.length} 存活
                </span>
              </h2>
              <div>
                <SeatGrid
                  players={displayPlayers}
                  pendingActs={replay.active ? [] : [
                    ...snapshot.pendingActs,
                    ...(snapshot.studyingSeats ?? []).map((seat) => ({ seat, kind: 'study' })),
                  ]}
                  selectedSeat={selectedSeat}
                  onSelect={handleSelectSeat}
                />
              </div>
              <div className="mt-4">
                <PlayerPanel
                  player={selectedPlayer}
                  events={visibleEvents}
                  pendingActs={snapshot.pendingActs}
                  studyNote={selectedSeat != null ? (studyNotes[selectedSeat] ?? null) : null}
                  studying={selectedSeat != null && (snapshot.studyingSeats ?? []).includes(selectedSeat)}
                  t0={gameT0}
                />
              </div>
              {/* 日夜交替停歇倒计时框（全场概览下方；仅在交替停歇期间出现，平时消失） */}
              {snapshot.phaseBreaking === 'nightToDay' || snapshot.phaseBreaking === 'dayToNight' ? (
                <div className="mt-2 flex h-9 items-center justify-center rounded-md border border-border bg-muted/30">
                  <PhaseBreakCountdown
                    totalMs={snapshot.phaseBreakTotalMs}
                    startedAt={snapshot.phaseBreakStartedAt}
                    direction={snapshot.phaseBreaking === 'nightToDay' ? 'day' : 'night'}
                  />
                </div>
              ) : null}
            </section>

            {/* 中栏：对局事件流（只追加，自动吸底；赛后发言以「赛后发言」时间标签并入） */}
            <section className="lg:col-span-5" ref={recordSectionRef}>
              <h2 className="mb-2 text-sm font-semibold text-foreground">
                对局记录
                <span className="ml-2 font-mono text-xs font-normal text-muted-foreground">
                  {streamEvents.length} 条
                </span>
              </h2>
              <EventStream
                events={streamEvents}
                className={cn(
                  'min-h-[340px]',
                  resultShown ? 'h-[calc(100dvh-360px)]' : 'h-[calc(100dvh-292px)]',
                )}
                live={status === 'running' && !replay.active}
                currentDay={replay.active && cursorEvent ? cursorEvent.day : snapshot.day}
                currentPhase={replay.active && cursorEvent ? cursorEvent.phase : snapshot.phase}
                phaseBreaking={snapshot.phaseBreaking}
                focusSessionKey={recordFocusKey}
                onFocusHandled={() => setRecordFocusKey(null)}
                t0={gameT0}
                highlightSeq={highlightSeq}
              />

              {/* 胜率推测面板（仅本局开启时显示）：默认折叠（胜率条 + 阵营-胜率文本），
                  点击「变动理由」展开/收起；点击下方阵营文本筛选该方胜率上升理由（选中文本加粗，
                  一方胜率为 0 时胜率条不可见，文本仍可点击筛选） */}
              {hasWinRate ? (
                <div className="mt-3 rounded-lg border border-border bg-card p-3">
                  {/* 胜率条：纯双色分段被动展示（不再承担点击；百分比集中在下方文字行） */}
                  <div className="flex h-6 w-full overflow-hidden rounded-md">
                    <div
                      className="bg-amber-400 transition-all duration-500"
                      style={{ width: `${winRatePct.goodPct}%` }}
                    />
                    <div
                      className="bg-red-500 transition-all duration-500"
                      style={{ width: `${winRatePct.wolfPct}%` }}
                    />
                  </div>
                  <div className="mt-1 grid grid-cols-3 items-center text-xs font-medium">
                    <button
                      type="button"
                      onClick={() => handleWinRateSide('good')}
                      title="只看神民胜率上升的理由"
                      className={cn(
                        'cursor-pointer text-left text-amber-400',
                        winRateSide === 'good' && 'font-bold',
                      )}
                    >
                      神民阵营 {winRatePct.goodPct}%
                    </button>
                    {/* 居中「胜率」标题：夜间 .dark 容器下切换白字，保证昼夜可读 */}
                    <span className="text-center text-sm font-bold text-black dark:text-white">
                      胜率
                    </span>
                    <button
                      type="button"
                      onClick={() => handleWinRateSide('wolf')}
                      title="只看狼人胜率上升的理由"
                      className={cn(
                        'cursor-pointer text-right text-red-400',
                        winRateSide === 'wolf' && 'font-bold',
                      )}
                    >
                      {winRatePct.wolfPct}% 狼人阵营
                    </button>
                  </div>
                  <div className="mt-2 flex items-center justify-between border-t border-border pt-2">
                    <button
                      type="button"
                      onClick={() => setWinRateExpanded((v) => !v)}
                      aria-expanded={winRateExpanded}
                      className="flex cursor-pointer items-center gap-1 text-xs font-medium text-foreground"
                    >
                      胜率变动理由
                      <span className="font-mono font-normal text-muted-foreground">
                        {visibleWinRateEntries.length} 条
                      </span>
                      {winRateSide === 'good' ? (
                        <span className="text-amber-500">仅看神民上升</span>
                      ) : winRateSide === 'wolf' ? (
                        <span className="text-red-400">仅看狼人上升</span>
                      ) : null}
                      <ChevronDown
                        className={cn(
                          'h-3.5 w-3.5 text-muted-foreground transition-transform',
                          winRateExpanded && 'rotate-180',
                        )}
                        aria-hidden
                      />
                    </button>
                    {winRateExpanded ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 px-2 text-xs"
                        onClick={() =>
                          setWinRateOrder((prev) => (prev === 'desc' ? 'asc' : 'desc'))
                        }
                      >
                        {winRateOrder === 'desc' ? '最新在顶' : '最早在顶'}
                      </Button>
                    ) : null}
                  </div>
                  {winRateExpanded ? (
                    <div className="mt-1.5 max-h-40 space-y-2 overflow-y-auto pr-1">
                      {visibleWinRateEntries.length === 0 ? (
                        <p className="text-xs text-muted-foreground">
                          分析师正在评估，暂无胜率变动记录…
                        </p>
                      ) : (
                        (winRateOrder === 'desc'
                          ? [...visibleWinRateEntries].reverse()
                          : visibleWinRateEntries
                        ).map(
                          (entry) => (
                            // 条目底色按涨跌着色：神民胜率上升=琥珀，狼人胜率上升=红
                            <div
                              key={entry.id}
                              className={cn(
                                'rounded-md border px-2 py-1.5',
                                directionOf(winRateEntries, entry) === 'good'
                                  ? 'border-amber-400/40 bg-amber-400/15'
                                  : 'border-red-500/40 bg-red-500/15',
                              )}
                            >
                              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
                                {/* 标签=胜率变化的直接缘由（时间-人物（可选）-具体事件，分析师定位）；
                                    旧数据无标签回退「第N天 · 阶段名」 */}
                                <span className="font-medium text-foreground">
                                  {entry.triggerLabel ?? `第${entry.day}天 · ${phaseLabel(entry.phase)}`}
                                </span>
                                <span>
                                  神民 {entry.goodPct}% / 狼人 {entry.wolfPct}%
                                </span>
                              </div>
                              {entry.reasons.length > 0 ? (
                                <ul className="mt-0.5 list-disc space-y-0.5 pl-4 text-xs leading-relaxed break-words text-foreground">
                                  {entry.reasons.map((reason, i) => (
                                    <li key={i}>{reason}</li>
                                  ))}
                                </ul>
                              ) : null}
                            </div>
                          ),
                        )
                      )}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </section>

            {/* 右栏：技能权衡（实时心理活动） */}
            <section className="lg:col-span-3">
              <SkillThinkPanel
                events={skillThinkEvents}
                live={status === 'running'}
                thinking={snapshot.pendingActs.some((a) => a.kind === 'daySkill')}
                roleNameOf={(seat) =>
                  snapshot.players.find((p) => p.seat === seat)?.roleName ?? null
                }
                currentDay={snapshot.day}
                currentPhase={snapshot.phase}
                phaseBreaking={snapshot.phaseBreaking}
                fitBanner={resultShown}
                t0={gameT0}
              />
            </section>
          </div>
        </div>

        {/* 终止对局确认弹窗（不可逆操作，必须显式确认） */}
        <AlertDialog open={terminateOpen} onOpenChange={setTerminateOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>终止本局对局？</AlertDialogTitle>
              <AlertDialogDescription>
                对局将立即结束且无法继续（未分胜负），事件流完整保留可回看、可导出。
                终止后可返回大厅开启新的测试对局。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>取消</AlertDialogCancel>
              <AlertDialogAction
                className="bg-wolf text-white hover:bg-wolf/90"
                onClick={() => void handleControl('terminate')}
              >
                确认终止
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* 分析报告弹窗（看板式排版：各章节彩色文字框，重点突出） */}
        <Dialog open={reportOpen} onOpenChange={setReportOpen}>
          <DialogContent className="max-h-[88dvh] overflow-y-auto sm:max-w-[min(1560px,94dvw)]">
            <DialogHeader>
              <DialogTitle>分析报告</DialogTitle>
              {report ? (
                <DialogDescription>
                  分析师模型 {report.model} · 生成于 {formatTime(report.createdAt)} ·
                  心理学 + 博弈论复盘，经验已蒸馏入
                  <Link to="/guide" className="mx-1 underline underline-offset-2">
                    经验指南
                  </Link>
                </DialogDescription>
              ) : null}
            </DialogHeader>
            {report ? (
              <>
                {/* 可视化图表（确定性数据渲染：胜率走势/发言分布/出局时间线） */}
                <ReportCharts
                  events={events}
                  winRateEntries={winRateEntries}
                  playerCount={snapshot.players.length}
                />
                {/* MVP / SVP 评选（确定性规则评分 + 因子图标列表） */}
                <MvpSvpPanels
                  events={events}
                  players={snapshot.players}
                  winner={snapshot.winner}
                />
                <MarkdownBoard content={report.report} />
              </>
            ) : null}
          </DialogContent>
        </Dialog>

        {/* 心理尸检弹窗（解剖师终局产出：三转折点 + 双视角 + 参数撕裂还原；按人格座位分页签） */}
        <Dialog open={personaReportOpen} onOpenChange={setPersonaReportOpen}>
          <DialogContent className="max-h-[88dvh] overflow-y-auto sm:max-w-[min(1200px,94dvw)]">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Brain className="h-5 w-5 text-purple-500" aria-hidden />
                心理尸检报告
              </DialogTitle>
              <DialogDescription>
                解剖师为每个人格座位撰写的《心理尸检报告》：同一事件同时给出博弈论与人格动力学解释（铁律4）
              </DialogDescription>
            </DialogHeader>
            {personaReports === null ? (
              <p className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                正在读取…
              </p>
            ) : personaReports.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                尸检报告尚未生成。终局后由解剖师自动产出（需配置分析师
                AI）；生成后事件流会有「心理尸检报告已生成」提示，届时重新打开本窗即可。
              </p>
            ) : (
              <Tabs defaultValue={String(personaReports[0]!.seat)}>
                <TabsList>
                  {personaReports.map((r) => (
                    <TabsTrigger key={r.id} value={String(r.seat)}>
                      {r.seat}号 ·{' '}
                      {snapshot?.players.find((p) => p.seat === r.seat)?.personaName ??
                        `人格#${r.personaId}`}
                    </TabsTrigger>
                  ))}
                </TabsList>
                {personaReports.map((r) => (
                  <TabsContent key={r.id} value={String(r.seat)} className="mt-4">
                    <p className="mb-3 text-xs text-muted-foreground">
                      解剖师模型 {r.model} · 生成于 {formatTime(r.createdAt)}
                    </p>
                    <MarkdownBoard content={r.report} />
                  </TabsContent>
                ))}
              </Tabs>
            )}
          </DialogContent>
        </Dialog>
      </div>
    </div>
  )
}
