/**
 * 分析报告可视化图表（纯 SVG，零依赖）：
 * - 胜率走势：单折线围绕 50% 基线上下波动（基线上方=神民优势区/琥珀，下方=狼人优势区/红）
 * - 发言分布：各座位公开发言次数条形图
 * - 出局时间线：各玩家出局天数散点
 * 数据全部来自前端已有的对局事件与胜率记录（确定性渲染，不依赖 AI 输出格式）。
 */

import { useMemo } from 'react'
import type { GameEvent, WinRateEntry } from '@contracts/game'

function WinRateChart({ entries }: { entries: WinRateEntry[] }) {
  if (entries.length < 2) return null
  const W = 560
  const H = 160
  const pad = 10
  const max = entries.length - 1
  const x = (i: number) => pad + (i / max) * (W - pad * 2)
  // 单折线：值 = 神民胜率 - 50（基线上方=神民优势/琥珀，下方=狼人优势/红，避免双线轴对称信息重复）
  const y = (v: number) => pad + ((50 - v) / 100) * (H - pad * 2)
  const vals = entries.map((e) => e.goodPct - 50)
  // 过零点插值：折线换色与区域填色在基线处精确衔接
  type Pt = { x: number; y: number; v: number }
  const pts: Pt[] = []
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i]
    if (i > 0) {
      const pv = vals[i - 1]
      if ((pv > 0 && v < 0) || (pv < 0 && v > 0)) {
        pts.push({ x: x(i - 1) + ((0 - pv) / (v - pv)) * (x(i) - x(i - 1)), y: y(0), v: 0 })
      }
    }
    pts.push({ x: x(i), y: y(v), v })
  }
  // 按符号分段：每段 = 基线与折线围成的区域（上=神民琥珀 / 下=狼人红）
  const regions: { good: boolean; pts: Pt[] }[] = []
  let cur: Pt[] = [pts[0]]
  for (let i = 1; i < pts.length; i++) {
    cur.push(pts[i])
    const lastOfRun = pts[i].v === 0 || i === pts.length - 1
    if (lastOfRun) {
      const nonZero = cur.find((p) => p.v !== 0)
      if (nonZero && cur.length >= 2) regions.push({ good: nonZero.v > 0, pts: cur })
      cur = [pts[i]]
    }
  }
  const lastV = vals[max]
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-foreground">胜率走势（基线上方=神民优势，下方=狼人优势）</p>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full rounded-md border border-border bg-background">
        {/* 优势区域填充 */}
        {regions.map((r, i) => (
          <polygon
            key={i}
            points={`${r.pts[0].x},${y(0)} ${r.pts.map((p) => `${p.x},${p.y}`).join(' ')} ${r.pts[r.pts.length - 1].x},${y(0)}`}
            fill={r.good ? '#f59e0b' : '#ef4444'}
            fillOpacity="0.18"
          />
        ))}
        {/* 50% 基准线 */}
        <line x1={pad} y1={y(0)} x2={W - pad} y2={y(0)} stroke="currentColor" strokeOpacity="0.25" strokeDasharray="4 3" />
        {/* 单折线：按所在半区着色（过零点两侧颜色在基线处相接） */}
        {pts.slice(1).map((p, i) => {
          const prev = pts[i]
          const good = (p.v + prev.v) / 2 >= 0
          return (
            <line
              key={i}
              x1={prev.x}
              y1={prev.y}
              x2={p.x}
              y2={p.y}
              stroke={good ? '#f59e0b' : '#ef4444'}
              strokeWidth="2"
            />
          )
        })}
        <circle cx={x(max)} cy={y(lastV)} r="3.5" fill={lastV >= 0 ? '#f59e0b' : '#ef4444'} />
        <text x={pad + 2} y={y(50) + 10} fontSize="9" fill="#f59e0b">神民 {entries[max].goodPct}%</text>
        <text x={W - pad - 2} y={y(-50) - 2} fontSize="9" fill="#ef4444" textAnchor="end">狼人 {entries[max].wolfPct}%</text>
      </svg>
    </div>
  )
}

function SpeechChart({ events }: { events: GameEvent[] }) {
  const counts = useMemo(() => {
    const m = new Map<number, number>()
    for (const e of events) {
      if (e.type === 'speech' && e.actor != null) {
        m.set(e.actor, (m.get(e.actor) ?? 0) + 1)
      }
    }
    return [...m.entries()].sort((a, b) => a[0] - b[0])
  }, [events])
  if (counts.length === 0) return null
  const max = Math.max(...counts.map(([, c]) => c), 1)
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-foreground">发言分布（公开发言条数/座位）</p>
      <div className="flex items-end gap-1.5 rounded-md border border-border bg-background p-2">
        {counts.map(([seat, c]) => (
          <div key={seat} className="flex flex-1 flex-col items-center gap-1">
            <span className="font-mono text-[10px] text-muted-foreground">{c}</span>
            <div
              className="w-full rounded-sm bg-good/70"
              style={{ height: `${Math.max(4, (c / max) * 72)}px` }}
              title={`${seat}号：${c} 条发言`}
            />
            <span className="font-mono text-[10px] text-foreground">{seat}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function DeathTimeline({ events, playerCount }: { events: GameEvent[]; playerCount: number }) {
  const deaths = useMemo(
    () =>
      events
        .filter((e) => e.type === 'death' && e.actor != null)
        .map((e) => ({ seat: e.actor!, day: e.day })),
    [events],
  )
  if (deaths.length === 0) return null
  const maxDay = Math.max(...deaths.map((d) => d.day), 1)
  const seats = Array.from({ length: playerCount }, (_, i) => i + 1)
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-foreground">出局时间线（天数 × 座位）</p>
      <div className="rounded-md border border-border bg-background p-2">
        <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${maxDay}, minmax(0,1fr))` }}>
          {Array.from({ length: maxDay }, (_, d) => (
            <span key={d} className="text-center font-mono text-[10px] text-muted-foreground">
              第{d + 1}天
            </span>
          ))}
          {seats.map((seat) => {
            const death = deaths.find((d) => d.seat === seat)
            return Array.from({ length: maxDay }, (_, d) => (
              <div
                key={`${seat}-${d}`}
                className={
                  death && death.day === d + 1
                    ? 'h-3.5 rounded-sm bg-wolf/80'
                    : 'h-3.5 rounded-sm bg-muted/40'
                }
                title={death && death.day === d + 1 ? `${seat}号 第${d + 1}天出局` : undefined}
              />
            ))
          })}
          {seats.map((seat) => (
            <span key={`l${seat}`} className="hidden" aria-hidden>{seat}</span>
          ))}
        </div>
        <p className="mt-1 text-[10px] text-muted-foreground">红色格=该座位出局日（自上而下为 1-{playerCount} 号座位）</p>
      </div>
    </div>
  )
}

export function ReportCharts({
  events,
  winRateEntries,
  playerCount,
}: {
  events: GameEvent[]
  winRateEntries: WinRateEntry[]
  playerCount: number
}) {
  return (
    <div className="mb-4 grid grid-cols-1 gap-4 rounded-lg border border-border bg-muted/30 p-3 lg:grid-cols-3">
      <WinRateChart entries={winRateEntries} />
      <SpeechChart events={events} />
      <DeathTimeline events={events} playerCount={playerCount} />
    </div>
  )
}
