/**
 * 回放控制条（置于总计时旁）：跳章/播放暂停/进度条/时刻/倍速。
 * 未激活时仅显示「回放」入口按钮；激活后展开完整传输控制。
 */

import { Pause, Play, SkipBack, SkipForward, X } from 'lucide-react'
import type { ReplayController } from '@/lib/useReplay'
import { REPLAY_SPEEDS } from '@/lib/useReplay'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { formatElapsed } from '@/lib/gameLabels'

export function ReplayBar({ replay }: { replay: ReplayController }) {
  if (!replay.active) {
    return (
      <Button size="sm" variant="outline" className="h-7 gap-1 px-2 text-xs" onClick={replay.start}>
        <Play className="h-3.5 w-3.5" aria-hidden />
        查看回放
      </Button>
    )
  }
  const ev = replay.currentEvent
  return (
    <span className="flex w-full flex-wrap items-center justify-center gap-1.5 rounded-md border border-god/40 bg-god/5 px-3 py-1.5">
      <span className="text-[10px] font-medium text-god">回放中</span>
      <Button
        size="sm"
        variant="ghost"
        className="h-6 w-6 p-0"
        title="上一时段"
        onClick={() => replay.jumpSession(-1)}
      >
        <SkipBack className="h-3.5 w-3.5" aria-hidden />
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="h-6 w-6 p-0"
        title={replay.playing ? '暂停' : '播放'}
        onClick={replay.toggle}
      >
        {replay.playing ? (
          <Pause className="h-3.5 w-3.5" aria-hidden />
        ) : (
          <Play className="h-3.5 w-3.5" aria-hidden />
        )}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="h-6 w-6 p-0"
        title="下一时段"
        onClick={() => replay.jumpSession(1)}
      >
        <SkipForward className="h-3.5 w-3.5" aria-hidden />
      </Button>
      <Slider
        className="mx-2 w-full max-w-[560px] flex-1"
        min={0}
        max={replay.total}
        step={1}
        value={[replay.cursorIdx]}
        onValueChange={([v]) => replay.seek(v ?? 0)}
        aria-label="回放进度"
      />
      <span className="font-mono text-[10px] text-muted-foreground">
        {formatElapsed(replay.positionMs / 1000)}/{formatElapsed(replay.totalMs / 1000)}
        {ev ? ` · 第${ev.day}天` : ''}
      </span>
      <span className={cn('font-mono text-[10px]', replay.cursorIdx >= replay.total ? 'text-good' : 'text-muted-foreground')}>
        {replay.cursorIdx}/{replay.total}
      </span>
      <Select value={String(replay.speed)} onValueChange={(v) => replay.changeSpeed(Number(v))}>
        <SelectTrigger className="h-6 w-[70px] px-1.5 text-[10px]" aria-label="倍速">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {REPLAY_SPEEDS.map((s) => (
            <SelectItem key={s} value={String(s)} className="text-xs">
              {s.toFixed(1)}x
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button size="sm" variant="ghost" className="h-6 w-6 p-0" title="退出回放" onClick={replay.exit}>
        <X className="h-3.5 w-3.5" aria-hidden />
      </Button>
    </span>
  )
}
