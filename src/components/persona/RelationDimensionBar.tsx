/** 单维参数条（0-100）：用于关系详情面板 */
import { cn } from '@/lib/utils'

export function RelationDimensionBar(props: {
  label: string
  value: number
  className?: string
  /** 无数据（淡化显示，避免误导为 0 分） */
  dim?: boolean
}) {
  const v = Math.max(0, Math.min(100, Math.round(props.value)))
  return (
    <div className="flex items-center gap-1.5 text-[10px]">
      <span className="w-12 shrink-0 text-muted-foreground">{props.label}</span>
      <div className={cn('h-1.5 flex-1 overflow-hidden rounded-full bg-muted', props.dim && 'opacity-40')}>
        <span className={cn('block h-full bg-foreground/60', props.className)} style={{ width: v + '%' }} />
      </div>
      <span className={cn('w-6 shrink-0 text-right tabular-nums text-muted-foreground', props.dim && 'opacity-40')}>{props.dim ? '—' : v}</span>
    </div>
  )
}

/** 双极条（-100..100）：用于 powerBalance */
export function RelationBipolarBar(props: { label: string; value: number }) {
  const v = Math.max(-100, Math.min(100, Math.round(props.value)))
  const pct = Math.abs(v) / 2
  return (
    <div className="flex items-center gap-1.5 text-[10px]">
      <span className="w-12 shrink-0 text-muted-foreground">{props.label}</span>
      <div className="relative h-1.5 flex-1 rounded-full bg-muted">
        <span className="absolute left-1/2 top-0 h-full w-px bg-border" />
        <span
          className={cn('absolute top-0 h-full', v >= 0 ? 'bg-god/70' : 'bg-wolf/70')}
          style={v >= 0 ? { left: '50%', width: pct + '%' } : { right: '50%', width: pct + '%' }}
        />
      </div>
      <span className="w-6 shrink-0 text-right tabular-nums text-muted-foreground">{v}</span>
    </div>
  )
}
