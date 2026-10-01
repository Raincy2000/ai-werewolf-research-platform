/**
 * 中栏：对局事件流（按「开局 / 第一夜 / 第一日 / 第二夜…」时段标签页分类）。
 * - 分组规则：依事件流顺序扫描，night.* → 第N夜，day.* → 第N日，
 *   game.init/start → 开局，game.over 跟随当前组（终局事件不单独成组）
 * - 默认停留在最新时段；对局推进产生新时段时自动跟随；
 *   用户翻看旧时段时不打扰，切回最新时段后恢复跟随
 * - 仅渲染激活时段的内容（天然窗口化，长对局 DOM 可控）
 * - 事件只追加，稳定 key = event.seq（父组件保证）
 * - ScrollArea 自动吸底：用户上翻时暂停吸底，回到底部附近后恢复；切换时段时回到顶部从头读
 * - thought（心理活动）以暗金左边框斜体折叠块附在条目下，默认展开
 * - 狼人频道（meta.channel === "wolf"）：暗红左边框 + 狼色系「狼人频道」Badge，
 *   狼队私密讨论仅观察者可见，与公开发言视觉区分
 */

import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { Brain, ChevronDown, Lock } from 'lucide-react'
import type { EventType, GameEvent } from '@contracts/game'
import type { PersonaEventMeta } from '@contracts/persona'
import { EVENT_TYPE_LABEL, elapsedLabel, eventTitleLabel, phaseLabel } from '@/lib/gameLabels'
import { groupEventsIntoSessions, withCurrentSession } from '@/lib/eventSessions'
import { usePanelFollow } from '@/lib/usePanelFollow'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { PersonaThought } from '@/components/game/PersonaThought'

const TYPE_BADGE_CLASS: Record<EventType, string> = {
  system: 'border-border bg-secondary text-secondary-foreground',
  phase: 'border-border bg-transparent text-muted-foreground',
  speech: 'border-good/50 bg-good/10 text-good',
  action: 'border-god/50 bg-god/10 text-god',
  vote: 'border-villager/50 bg-villager/10 text-villager',
  death: 'border-wolf/50 bg-wolf/10 text-wolf',
  result: 'border-good/50 bg-good/10 text-good',
}

/** 单条事件（memo 保证追加新事件时旧条目不重渲染） */
const EventItem = memo(function EventItem({ event, t0, highlighted }: { event: GameEvent; t0?: number | null; highlighted?: boolean }) {
  // 心理活动折叠块：默认展开
  const [thoughtOpen, setThoughtOpen] = useState(true)
  // 距对局开始的经过时间（小字数字时间，附在序号旁）
  const elapsed = elapsedLabel(t0, event.createdAt)
  // 狼人频道：狼队夜间私密讨论（meta.channel === "wolf"），仅观察者可见，
  // 用暗红左边框 + 狼色系 Badge 与公开发言区分
  const isWolfChannel = event.meta?.channel === 'wolf'
  // 赛后发言点名标注：meta.addressTo（单人 number / 多人 number[] / 所有人 "all"）→ 黄色 @标
  const rawAddress = event.phase.startsWith('postgame') ? event.meta?.addressTo : undefined
  const addressLabels: string[] =
    rawAddress === 'all'
      ? ['所有人']
      : typeof rawAddress === 'number'
        ? [`${rawAddress}号`]
        : Array.isArray(rawAddress)
          ? rawAddress.filter((t): t is number => typeof t === 'number').map((t) => `${t}号`)
          : []
  // 托管原因（服务层兜底时落入 meta）：让观察者直接看到 AI 失败的真实根因
  const fallbackReason =
    typeof event.meta?.fallbackReason === 'string' ? event.meta.fallbackReason : null
  // 人格研究库：该事件由人格座位产出时的人格注解（双视角/撕裂组，铁律4/6）
  const personaMeta = (event.meta?.persona ?? null) as PersonaEventMeta | null
  return (
    <li
      className={cn(
        'border-b border-border/60 px-3 py-2.5 last:border-b-0',
        isWolfChannel && 'border-l-2 border-l-wolf/70 bg-wolf/5',
        // 回放游标位：最新揭示事件高亮一圈（回放推进的视觉锚点）
        highlighted && 'bg-god/10 ring-1 ring-inset ring-god/50',
      )}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-mono text-xs text-muted-foreground">[{event.seq}]</span>
        {elapsed ? (
          <span className="font-mono text-[10px] text-muted-foreground/70" title="距对局开始的经过时间">
            {elapsed}
          </span>
        ) : null}
        <Badge variant="outline" className="font-mono text-[11px] font-normal">
          第{event.day}天 · {phaseLabel(event.phase)}
        </Badge>
        <Badge variant="outline" className={cn('text-[11px] font-normal', TYPE_BADGE_CLASS[event.type])}>
          {EVENT_TYPE_LABEL[event.type]}
        </Badge>
        {isWolfChannel ? (
          <Badge
            variant="outline"
            className="border-wolf/50 bg-wolf/10 text-[11px] font-normal text-wolf"
            title="狼队私密频道，仅观察者可见"
          >
            <Lock aria-hidden />
            {eventTitleLabel(event.title)}
          </Badge>
        ) : null}
        {event.actorLabel ? (
          <span className="text-xs font-medium text-foreground">{event.actorLabel}</span>
        ) : null}
        {addressLabels.length > 0 ? (
          <Badge
            variant="outline"
            className="border-amber-500/50 bg-amber-500/10 text-[11px] font-medium text-amber-600 dark:text-amber-400"
            title="赛后发言点名回复对象"
          >
            @{addressLabels.join(' @')}
          </Badge>
        ) : null}
        {isWolfChannel ? null : (
          <span className="text-xs text-muted-foreground">{eventTitleLabel(event.title)}</span>
        )}
      </div>

      {event.content ? (
        <p className="mt-1.5 whitespace-pre-wrap break-words text-sm leading-6 text-foreground">
          {event.content}
        </p>
      ) : null}

      {event.thought ? (
        <div className="mt-2 border-l-2 border-god/70 pl-2.5">
          <button
            type="button"
            onClick={() => setThoughtOpen((v) => !v)}
            aria-expanded={thoughtOpen}
            className="flex items-center gap-1 text-xs font-medium text-god hover:underline underline-offset-2"
          >
            <Brain className="h-3.5 w-3.5" aria-hidden />
            {personaMeta ? '心镜 · 人格状态报告（仅观察者可见）' : '心理活动（仅观察者可见）'}
            <ChevronDown
              className={cn('h-3 w-3 transition-transform', thoughtOpen && 'rotate-180')}
              aria-hidden
            />
          </button>
          {thoughtOpen ? (
            <div className="mt-1">
              {personaMeta ? (
                <PersonaThought thought={event.thought} persona={personaMeta} />
              ) : (
                <p className="whitespace-pre-wrap break-words text-sm italic leading-6 text-god/90">
                  {event.thought}
                </p>
              )}
            </div>
          ) : null}
          {fallbackReason ? (
            <p className="mt-1 text-[11px] text-muted-foreground">托管原因：{fallbackReason}</p>
          ) : null}
        </div>
      ) : null}
    </li>
  )
})

// ---------------------------------------------------------------------------
// 时段分组（纯逻辑在 @/lib/eventSessions，便于单测）
// ---------------------------------------------------------------------------

interface EventStreamProps {
  events: GameEvent[]
  className?: string
  /** 对局是否进行中：最新时段标签显示「进行中」呼吸点 */
  live?: boolean
  /** 当前对局天数与阶段（保证当前时段标签即使暂无事件也出现，呼吸灯不滞留旧时段） */
  currentDay?: number
  currentPhase?: string
  /** 停歇类型：none=无；nightToDay/dayToNight=日夜交替停歇（对局记录黄灯亮起）；
   *  thinkBeat=独立思考节拍（对局记录不亮黄灯） */
  phaseBreaking?: 'none' | 'nightToDay' | 'dayToNight' | 'thinkBeat'
  /** 外部请求聚焦某时段标签（如「查看赛后发言」→ postgame）；处理后回调清除 */
  focusSessionKey?: string | null
  onFocusHandled?: () => void
  /** 对局总计时起点（epoch ms）：每条事件旁附距开始的经过时间 */
  t0?: number | null
  /** 回放游标高亮：该 seq 事件加圈标出（回放推进的视觉锚点） */
  highlightSeq?: number | null
}

// memo 包裹整体：父组件因选中玩家等原因重渲染时，若 events 引用未变则事件流完全不重渲染
export const EventStream = memo(function EventStream({ events, className, live, currentDay, currentPhase, phaseBreaking, focusSessionKey, onFocusHandled, t0, highlightSeq }: EventStreamProps) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const getViewport = () =>
    wrapRef.current?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]') ?? null
  // 时段分组（事件引用不变时 memo 命中，零成本）；当前时段无事件也补出标签
  const sessions = useMemo(
    () =>
      currentDay != null && currentPhase != null
        ? withCurrentSession(groupEventsIntoSessions(events), currentDay, currentPhase)
        : groupEventsIntoSessions(events),
    [events, currentDay, currentPhase],
  )
  const latestKey = sessions.length > 0 ? sessions[sessions.length - 1].key : ''
  // 无操作自动跟随：用户操作时尊重其翻阅，闲置超时后自动回到最新时段/底端；
  // sessions 从无到有时重挂滚动监听（空态与内容态是不同的 viewport）
  const { stickRef, followLatestRef, scrollToBottom } = usePanelFollow(
    getViewport,
    sessions.length > 0,
  )
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const tabsListRef = useRef<HTMLDivElement>(null)

  // 外部聚焦请求（如「查看赛后发言」）：目标时段存在则切过去并回调清除
  useEffect(() => {
    if (!focusSessionKey) return
    if (sessions.some((s) => s.key === focusSessionKey)) {
      followLatestRef.current = focusSessionKey === latestKey
      setSelectedKey(focusSessionKey)
    }
    onFocusHandled?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusSessionKey, sessions])

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

  // 标签条横向自动滚动：激活标签变化时，把它滚入可视区（最新标签始终可见）
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

  // 切换时段：回到顶部从头读（研究视角按顺序看该时段全程）
  useEffect(() => {
    const viewport = getViewport()
    if (viewport) viewport.scrollTop = 0
  }, [activeKey])

  // 当前时段内新事件到达：未上翻（或闲置超时）则吸底
  const lastSeq =
    activeSession && activeSession.events.length > 0
      ? activeSession.events[activeSession.events.length - 1].seq
      : 0
  useEffect(() => {
    if (stickRef.current) scrollToBottom()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastSeq])

  return (
    <div ref={wrapRef} className={className}>
      {sessions.length === 0 ? (
        <ScrollArea className="h-full rounded-md border border-border bg-card">
          <p className="px-4 py-10 text-center text-sm text-muted-foreground">
            暂无事件，对局启动后将在此逐步产生记录
          </p>
        </ScrollArea>
      ) : (
        <Tabs
          value={activeKey}
          onValueChange={handleTabChange}
          className="flex h-full flex-col gap-2"
        >
          {/* 时段标签栏：横向可滚动，标签含事件条数；最新时段在对局进行中带呼吸点 */}
          <TabsList ref={tabsListRef} className="h-auto w-full justify-start gap-1 overflow-x-auto p-1">
            {sessions.map((s) => (
              <TabsTrigger key={s.key} value={s.key} className="shrink-0 gap-1.5 px-2.5 py-1">
                {live && s.key === latestKey ? (
                  // 黄灯仅日夜交替停歇期间亮（夜→日 / 日→夜）；思考节拍与其他时间不亮黄灯
                  phaseBreaking === 'nightToDay' || phaseBreaking === 'dayToNight' ? (
                    <span className="relative flex h-1.5 w-1.5" aria-hidden>
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-500 opacity-60" />
                      <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-amber-500" />
                    </span>
                  ) : (
                    <span className="relative flex h-1.5 w-1.5" aria-hidden>
                      {/* 中亮绿呼吸（green-500）：与对局页面色调协调，夜间可辨，区别于学习环祖母绿 */}
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-500 opacity-60" />
                      <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-green-500" />
                    </span>
                  )
                ) : null}
                {s.label}
                <span className="font-mono text-[10px] text-muted-foreground">
                  {s.events.length}
                </span>
              </TabsTrigger>
            ))}
          </TabsList>

          {/* 仅渲染激活时段（长对局 DOM 规模恒定可控） */}
          <ScrollArea className="min-h-0 flex-1 rounded-md border border-border bg-card">
            {activeSession && activeSession.events.length === 0 ? (
              <p className="px-4 py-10 text-center text-sm text-muted-foreground">
                本时段暂无记录，随流程推进将逐步产生
              </p>
            ) : (
              <ul className="divide-y-0">
                {activeSession?.events.map((event) => (
                  <EventItem key={event.seq} event={event} t0={t0} highlighted={event.seq === highlightSeq} />
                ))}
              </ul>
            )}
          </ScrollArea>
        </Tabs>
      )}
    </div>
  )
})
