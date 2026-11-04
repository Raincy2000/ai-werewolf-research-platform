/**
 * 人格座位心理块渲染（铁律4 双视角 + 铁律6 张力模板）：
 * - thought 为张力模板时：撕裂组/冲突强度条/参数触发/防御/创伤/身体痕迹/涌现输出 分层呈现
 * - event.meta.persona：博弈论解释与人格动力学解释双栏并列（同一事件必须同时输出两种解释）
 * - 非模板 thought（普通座位/托管兜底）回退为原有斜体纯文本
 * - mode（2026-10-14 轻量化）：full=全部；emergence=仅涌现正文（收起态与一般心理活动对齐）；
 *   detail=心镜分析层（徽标/撕裂/双视角，不含涌现正文——供收起态展开时补全）
 */

import { Flame, Scale, Sparkle } from 'lucide-react'
import type { PersonaEventMeta } from '@contracts/persona'
import { parseTensionTemplate } from '@/lib/tensionTemplate'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'

/** 段名 → 配色与图标语义 */
const SECTION_STYLE: Record<string, { label: string; cls: string }> = {
  当前撕裂: { label: '当前撕裂', cls: 'border-wolf/60 text-wolf' },
  参数触发: { label: '参数触发', cls: 'border-amber-500/60 text-amber-600 dark:text-amber-400' },
  防御启动: { label: '防御启动', cls: 'border-sky-500/60 text-sky-600 dark:text-sky-400' },
  创伤唤醒: { label: '创伤唤醒', cls: 'border-wolf/60 text-wolf' },
  身体痕迹: { label: '身体痕迹', cls: 'border-villager/60 text-villager' },
  涌现输出: { label: '涌现输出', cls: 'border-[#e0568a]/60 text-[#e0568a]' },
}

function IntensityBar({ value }: { value: number }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="text-[10px] text-muted-foreground">冲突强度</span>
      <span className="h-1 w-14 overflow-hidden rounded-full bg-secondary">
        <span
          className={cn(
            'block h-full rounded-full',
            value >= 0.7 ? 'bg-wolf/80' : value >= 0.4 ? 'bg-amber-500/80' : 'bg-[#e0568a]/70',
          )}
          style={{ width: `${Math.round(value * 100)}%` }}
        />
      </span>
      <span className="font-mono text-[10px] text-foreground">{value.toFixed(2)}</span>
    </span>
  )
}

/** 撕裂段体按「冲突强度：x.xx」切分，强度值渲染为进度条 */
function TensionBody({ body, intensities }: { body: string; intensities: number[] }) {
  const parts = body.split(/冲突强度：\s*\d+(?:\.\d+)?/).filter((s) => s.trim())
  return (
    <div className="space-y-1">
      {parts.map((part, i) => (
        <div key={i}>
          <p className="whitespace-pre-wrap break-words leading-5">{part.trim()}</p>
          {intensities[i] != null ? <IntensityBar value={intensities[i]!} /> : null}
        </div>
      ))}
    </div>
  )
}

/** 涌现正文（收起态的核心文字；无模板时回退为全文） */
function EmergenceText({ thought, parsed }: { thought: string; parsed: ReturnType<typeof parseTensionTemplate> }) {
  const body = parsed.isTemplate
    ? (parsed.sections.find((s) => s.key === '涌现输出')?.body ?? thought)
    : thought
  return (
    <p className="whitespace-pre-wrap break-words text-xs italic leading-5 text-foreground/85">
      {body}
    </p>
  )
}

export function PersonaThought({
  thought,
  persona,
  mode = 'full',
}: {
  thought: string
  persona: PersonaEventMeta | null
  mode?: 'full' | 'emergence' | 'detail'
}) {
  const parsed = parseTensionTemplate(thought)
  // 仅涌现正文（收起态）
  if (mode === 'emergence') {
    return <EmergenceText thought={thought} parsed={parsed} />
  }
  const showEmergence = mode === 'full'
  return (
    <div className="space-y-1.5">
      {/* 人格徽标行：人格名 + 双/单程管线标记 + 撕裂组摘要 */}
      {persona ? (
        <div className="flex flex-wrap items-center gap-1">
          <Badge
            variant="outline"
            className="border-[#e0568a]/50 bg-[#e0568a]/10 px-1.5 py-0 text-[10px] font-normal text-[#e0568a]"
          >
            {persona.name}
          </Badge>
          <Badge variant="outline" className="px-1.5 py-0 text-[10px] font-normal text-muted-foreground">
            {persona.dual ? '心镜→涌现 双程' : '小上下文 单程合并'}
          </Badge>
          {persona.tensions.map((t, i) => (
            <span
              key={i}
              className="inline-flex items-center gap-1 rounded-full border border-wolf/40 bg-wolf/5 px-1.5 py-0 text-[10px] text-wolf"
              title={`冲突强度 ${t.intensity.toFixed(2)}`}
            >
              <Flame className="h-2.5 w-2.5" aria-hidden />
              {t.poles.join(' ⇄ ')}（{t.intensity.toFixed(2)}）
            </span>
          ))}
        </div>
      ) : null}

      {/* 张力模板（detail 模式跳过涌现正文——它已在收起态常显；非模板回退全文） */}
      {parsed.isTemplate ? (
        <div className="space-y-1.5">
          {parsed.sections
            .filter((s) => showEmergence || s.key !== '涌现输出')
            .map((s) => {
              const style = SECTION_STYLE[s.key] ?? { label: s.key, cls: 'border-border text-muted-foreground' }
              return (
                <div key={s.key} className={cn('border-l-2 pl-2', style.cls.split(' ')[0])}>
                  <p className={cn('text-[10px] font-medium', style.cls.split(' ').slice(1).join(' '))}>
                    {style.label}
                  </p>
                  {s.key === '当前撕裂' ? (
                    <TensionBody body={s.body} intensities={s.intensities} />
                  ) : (
                    <p className="whitespace-pre-wrap break-words text-xs italic leading-5 text-foreground/90">
                      {s.body}
                    </p>
                  )}
                </div>
              )
            })}
        </div>
      ) : showEmergence ? (
        <p className="whitespace-pre-wrap break-words text-xs italic leading-5 text-foreground/85">{thought}</p>
      ) : null}

      {/* 双视角分析（铁律4：同一事件同时输出博弈论与人格动力学解释） */}
      {persona && (persona.gt || persona.psy) ? (
        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {persona.gt ? (
            <div className="rounded-md border border-god/40 bg-god/5 px-2 py-1">
              <p className="flex items-center gap-1 text-[10px] font-medium text-god">
                <Scale className="h-3 w-3" aria-hidden />
                博弈论解释
              </p>
              <p className="mt-0.5 text-[11px] leading-4.5 text-foreground/90">{persona.gt}</p>
            </div>
          ) : null}
          {persona.psy ? (
            <div className="rounded-md border border-[#e0568a]/40 bg-[#e0568a]/5 px-2 py-1">
              <p className="flex items-center gap-1 text-[10px] font-medium text-[#e0568a]">
                <Sparkle className="h-3 w-3" aria-hidden />
                人格动力学解释
              </p>
              <p className="mt-0.5 text-[11px] leading-4.5 text-foreground/90">{persona.psy}</p>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
