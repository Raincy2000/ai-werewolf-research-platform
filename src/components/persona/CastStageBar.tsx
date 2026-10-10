/**
 * 铸魂师三节点生成进度条：① 搜集资料 → ② 深读人格 → ③ 整合量化。
 * 当前节点由后端进度 label 推断（含 ③/整合/肖像 → 3；②/深读/批判 → 2；否则 1），
 * 未回传时用轮播阶段兜底；活动节点带扩散脉冲环，已完成节点打勾，连接线渐进填充。
 * compact 模式用于人格卡列表里的「生成中」小卡。
 */

import { Check } from 'lucide-react'

const STAGES = ['搜集资料', '深读人格', '整合量化'] as const

/** 从后端进度 label 推断当前节点（1-3） */
export function stageFromLabel(label: string | null | undefined, fallback: number): number {
  if (!label) return Math.min(3, Math.max(1, fallback))
  if (label.includes('③') || label.includes('整合') || label.includes('肖像')) return 3
  if (label.includes('②') || label.includes('深读') || label.includes('批判')) return 2
  return 1
}

export function CastStageBar({
  label,
  fallbackStage = 1,
  done = false,
  compact = false,
}: {
  label?: string | null
  fallbackStage?: number
  done?: boolean
  compact?: boolean
}) {
  const current = done ? 4 : stageFromLabel(label, fallbackStage)
  const node = compact ? 'h-5 w-5 text-[10px]' : 'h-8 w-8 text-xs'
  const gapLine = compact ? 'h-px' : 'h-0.5'
  return (
    <div className={`flex items-center ${compact ? 'gap-1' : 'gap-2'}`} aria-label="铸造进度">
      {STAGES.map((name, i) => {
        const idx = i + 1
        const state = idx < current ? 'done' : idx === current ? 'active' : 'todo'
        return (
          <div key={name} className={`flex items-center ${compact ? 'gap-1' : 'gap-2'} ${i > 0 ? 'flex-1' : ''}`}>
            {i > 0 ? (
              <span className={`relative flex-1 overflow-hidden rounded-full bg-border ${gapLine}`}>
                <span
                  className={`absolute inset-y-0 left-0 rounded-full bg-god transition-all duration-700 ease-out ${
                    state !== 'todo' ? 'w-full' : 'w-0'
                  }`}
                />
              </span>
            ) : null}
            <span className="relative flex shrink-0 items-center justify-center">
              {state === 'active' && !compact ? (
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-god/40" aria-hidden />
              ) : null}
              <span
                className={`relative flex items-center justify-center rounded-full border font-medium transition-colors duration-500 ${node} ${
                  state === 'done'
                    ? 'border-god bg-god text-white'
                    : state === 'active'
                      ? 'border-god bg-god/15 text-god'
                      : 'border-border bg-secondary text-muted-foreground'
                }`}
                title={name}
              >
                {state === 'done' ? <Check className={compact ? 'h-3 w-3' : 'h-4 w-4'} aria-hidden /> : idx}
              </span>
            </span>
            {!compact ? (
              <span
                className={`whitespace-nowrap text-xs transition-colors duration-500 ${
                  state === 'active'
                    ? 'font-medium text-god'
                    : state === 'done'
                      ? 'text-foreground'
                      : 'text-muted-foreground'
                }`}
              >
                {name}
              </span>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
