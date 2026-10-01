/**
 * 右栏：玩家详情 / 心路历程面板。
 * 选中座位后展示：身份、阵营、AI 模型、存活状态、信息壁垒说明，以及
 * 「心路历程与交互记录」——该玩家全部交互（发言/行动/投票/抉择）与其心理活动
 * 各自合并为一条，按时间倒序（最新在上，可切换正序）展示；
 * 限高滚动框，点击查看时自动贴附最顶端。
 * 未选中时显示全场概览（当前待决提示）。
 */

import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDownWideNarrow, ArrowUpNarrowWide, BookOpen, Brain, Eye, Hourglass, Loader2 } from 'lucide-react'
import { SheriffBadge } from '@/components/icons/SheriffBadge'
import type { Camp, GameEvent, PlayerSnapshot } from '@contracts/game'
import { CAMP_LABEL, elapsedLabel } from '@/lib/gameLabels'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'

const CAMP_TEXT_CLASS: Record<Camp, string> = {
  wolf: 'text-wolf',
  god: 'text-god',
  villager: 'text-villager',
}

/** 单条「心路历程与交互记录」：一条交互（内容）+ 其心理活动（如出同炉）。
 * memo：轮询追加事件时旧行不重渲染——选中玩家后页面不再随对局推进而卡顿的关键 */
const JourneyRow = memo(function JourneyRow({ event, t0 }: { event: GameEvent; t0?: number | null }) {
  const fired = event.meta?.channel === 'skillFired'
  const isWolf = event.meta?.channel === 'wolf'
  const elapsed = elapsedLabel(t0, event.createdAt)
  return (
    <li
      className={cn(
        'border-b border-border/60 px-3 py-2 last:border-b-0',
        isWolf && 'border-l-2 border-l-wolf/70 bg-wolf/5',
      )}
    >
      <p
        className={cn(
          'font-mono text-[11px]',
          fired ? 'font-bold text-wolf' : 'text-muted-foreground',
        )}
      >
        [#{event.seq}] 第{event.day}天 · {event.title}
        {elapsed ? <span className="ml-1.5 text-muted-foreground/70">{elapsed}</span> : null}
      </p>
      {event.content ? (
        <p
          className={cn(
            'mt-0.5 whitespace-pre-wrap break-words text-xs leading-5',
            fired ? 'font-bold text-wolf' : 'text-foreground',
          )}
        >
          {event.content}
        </p>
      ) : null}
      {event.thought ? (
        <p
          className={cn(
            'mt-1 whitespace-pre-wrap break-words border-l-2 pl-2 text-xs italic leading-5',
            fired ? 'border-wolf/70 font-bold text-wolf' : 'border-god/70 text-god/90',
          )}
        >
          {event.thought}
        </p>
      ) : null}
    </li>
  )
})

interface PlayerPanelProps {
  /** 当前选中的玩家；null 表示未选中（全场概览） */
  player: PlayerSnapshot | null
  /** 全量事件（用于过滤该玩家的心路历程与交互记录） */
  events: GameEvent[]
  /** 当前待决按座位展开（多人同时行动时全部列出） */
  pendingActs: { seat: number; kind: string }[]
  /** 赛前学习心得（图书馆对局；null=未学习/未开启） */
  studyNote?: string | null
  /** 该座位是否正在学习中（实时状态） */
  studying?: boolean
  /** 对局总计时起点（epoch ms）：每条记录旁附距开始的经过时间 */
  t0?: number | null
  className?: string
}

export const PlayerPanel = memo(function PlayerPanel({ player, events, pendingActs, studyNote, studying, t0, className }: PlayerPanelProps) {
  /** 排序：false=倒序（默认，最新在上）；true=正序（最早在上） */
  const [asc, setAsc] = useState(false)
  const selectedSeat = player?.seat ?? null

  // 心路历程与交互记录：该玩家全部交互事件（发言/行动/投票/带行为主体的系统事件）
  const journey = useMemo(() => {
    const list = events.filter(
      (e) =>
        player !== null &&
        e.actor === player.seat &&
        (e.type === 'speech' ||
          e.type === 'action' ||
          e.type === 'vote' ||
          (e.type === 'system' && e.actor != null)),
    )
    return asc ? [...list].sort((a, b) => a.seq - b.seq) : [...list].sort((a, b) => b.seq - a.seq)
  }, [events, player, asc])

  // 点击查看时自动贴附最顶端（倒序=最新在上；切换排序时同样回顶）
  const wrapRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const vp = wrapRef.current?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')
    if (vp) vp.scrollTop = 0
  }, [selectedSeat, asc])

  if (!player) {
    return (
      <div className={cn('flex flex-col gap-3', className)}>
        <h3 className="text-sm font-semibold text-foreground">全场概览</h3>
        <div className="rounded-md border border-border bg-card p-3">
          <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <Hourglass className="h-4 w-4 text-god" aria-hidden />
            {pendingActs.length > 0
              ? `当前等待 ${[...new Set(pendingActs.map((a) => a.seat))]
                  .sort((a, b) => a - b)
                  .join('、')} 号玩家行动/发言`
              : '当前无等待中的行动方'}
          </p>
        </div>
        <p className="text-xs leading-5 text-muted-foreground">
          点击左侧座位查看该玩家的身份、模型与完整心路历程。
        </p>
      </div>
    )
  }

  return (
    <div className={cn('flex min-h-0 flex-col gap-3', className)}>
      {/* 基本信息 */}
      <div className="rounded-md border border-border bg-card p-3">
        <div className="flex items-center gap-2">
          <span className="font-mono text-lg font-semibold text-foreground">{player.seat}号</span>
          <span className={cn('text-sm font-semibold', CAMP_TEXT_CLASS[player.camp])}>
            {player.roleName}
          </span>
          {player.sheriff ? <SheriffBadge className="h-4 w-4 text-god" aria-label="警长" /> : null}
        </div>
        <dl className="mt-2 space-y-1 text-xs text-muted-foreground">
          <div className="flex justify-between gap-2">
            <dt>阵营</dt>
            <dd className={CAMP_TEXT_CLASS[player.camp]}>{CAMP_LABEL[player.camp]}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt>AI 模型</dt>
            <dd className="break-all text-right font-mono text-foreground">{player.aiModel}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt>状态</dt>
            <dd className={player.alive ? 'text-good' : 'text-wolf'}>
              {player.alive ? '存活' : `死亡${player.deathInfo ? `（${player.deathInfo}）` : ''}`}
            </dd>
          </div>
        </dl>
        {/* 信息壁垒说明 */}
        <p className="mt-3 flex items-start gap-1.5 rounded-sm bg-secondary px-2 py-1.5 text-[11px] leading-4 text-secondary-foreground">
          <Eye className="mt-px h-3 w-3 shrink-0" aria-hidden />
          该玩家仅可见：公开记录 + 自身角色信息（不知道其他玩家身份与夜间行动）
        </p>
      </div>

      {/* 赛前学习详情（图书馆对局）：学习中显示实时状态，学完成显示心得全文 */}
      {studying || studyNote ? (
        <div className="rounded-md border border-emerald-600/40 bg-emerald-500/5 p-3">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-emerald-700 dark:text-emerald-400">
            <BookOpen className="h-4 w-4" aria-hidden />
            赛前学习（图书馆）
          </h3>
          {studying ? (
            <p className="mt-1.5 flex items-center gap-1.5 text-xs text-emerald-700 dark:text-emerald-400">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              正在通读选中的馆藏资料（按身份选读），随后写下学习心得…
            </p>
          ) : null}
          {studyNote ? (
            // 心得全文较长：限高滚动框，避免把下方心路历程挤出首屏
            <div className="mt-1.5 max-h-44 overflow-y-auto pr-1">
              <p className="whitespace-pre-wrap break-words text-xs leading-5 text-foreground">
                {studyNote}
              </p>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* 心路历程与交互记录（交互含发言，各自合并为一条；默认倒序，可切换正序） */}
      <div className="flex min-h-0 flex-col gap-1.5">
        <div className="flex items-center gap-1.5">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
            <Brain className="h-4 w-4 text-god" aria-hidden />
            心路历程与交互记录
          </h3>
          <Badge variant="secondary" className="ml-auto font-mono text-[11px]">
            {journey.length}
          </Badge>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0"
            onClick={() => setAsc((v) => !v)}
            title={asc ? '切换为倒序（最新在上）' : '切换为正序（最早在上）'}
            aria-label="切换排序"
          >
            {asc ? (
              <ArrowUpNarrowWide className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
            ) : (
              <ArrowDownWideNarrow className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
            )}
          </Button>
        </div>
        <div ref={wrapRef}>
          <ScrollArea className="h-[420px] rounded-md border border-border bg-card">
            {journey.length === 0 ? (
              <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                暂无心路历程与交互记录
              </p>
            ) : (
              <ul>
                {journey.map((e) => (
                  <JourneyRow key={e.seq} event={e} t0={t0} />
                ))}
              </ul>
            )}
          </ScrollArea>
        </div>
      </div>
    </div>
  )
})
