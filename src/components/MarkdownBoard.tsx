/**
 * MarkdownBoard：把「## 小节」结构的 markdown 风格纯文本渲染为看板式布局——
 * 每个小节一个彩色文字框（不同大小与配色），重点内容（小节标题、加粗、列表）
 * 以字号/颜色区分层级，用于分析报告与经验指南的突出展示。
 * 仅支持有限语法：## 标题、**加粗**、- / 数字 列表，零依赖。
 */

import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface Section {
  title: string | null
  lines: string[]
}

/** 按 ## 标题切分小节；标题前的内容为导语块（title=null） */
function parseSections(content: string): Section[] {
  const sections: Section[] = []
  let cur: Section = { title: null, lines: [] }
  const flush = () => {
    if (cur.title !== null || cur.lines.some((l) => l.trim())) sections.push(cur)
  }
  for (const line of content.split('\n')) {
    const m = line.match(/^#{1,3}\s+(.+?)\s*$/)
    if (m) {
      flush()
      cur = { title: m[1], lines: [] }
    } else {
      cur.lines.push(line)
    }
  }
  flush()
  return sections
}

/** 看板配色（低饱和、与阵营色系一致） */
interface Palette {
  bar: string // 左侧色条
  bg: string // 框底色
  titleText: string // 标题色
  marker: string // 列表符号色
}
const PALETTES = {
  gold: { bar: 'border-l-god', bg: 'bg-god/5', titleText: 'text-god', marker: 'text-god' },
  green: { bar: 'border-l-good', bg: 'bg-good/5', titleText: 'text-good', marker: 'text-good' },
  red: { bar: 'border-l-wolf', bg: 'bg-wolf/5', titleText: 'text-wolf', marker: 'text-wolf' },
  blue: { bar: 'border-l-villager', bg: 'bg-villager/5', titleText: 'text-villager', marker: 'text-villager' },
  gray: { bar: 'border-l-stone-400', bg: 'bg-stone-500/5', titleText: 'text-stone-600', marker: 'text-stone-500' },
} as const

/** 标题关键词 → 配色（语义优先，未命中按序轮换） */
const KEYWORD_PALETTE: [RegExp, Palette][] = [
  [/概述|概要|总览/, PALETTES.gray],
  [/转折|关键/, PALETTES.gold],
  [/心理|发言/, PALETTES.blue],
  [/阵营|表现|点评/, PALETTES.green],
  [/经验|教训|教训/, PALETTES.red],
  [/狼人|狼队/, PALETTES.red],
  [/好人|神民|平民/, PALETTES.green],
  [/投票|放逐/, PALETTES.blue],
  [/夜间|夜晚/, PALETTES.gray],
]
const ROTATION: Palette[] = [PALETTES.gold, PALETTES.green, PALETTES.blue, PALETTES.red, PALETTES.gray]

function paletteOf(title: string | null, index: number): Palette {
  if (title) {
    for (const [re, p] of KEYWORD_PALETTE) if (re.test(title)) return p
  }
  return ROTATION[index % ROTATION.length]
}

/** 行内 **加粗** 解析 */
function renderInline(text: string): ReactNode {
  if (!text.includes('**')) return text
  const parts = text.split(/(\*\*[^*]+\*\*)/g)
  return parts.map((part, i) => {
    const m = part.match(/^\*\*([^*]+)\*\*$/)
    return m ? (
      <strong key={i} className="font-semibold text-foreground">
        {m[1]}
      </strong>
    ) : (
      part
    )
  })
}

/** 小节正文：区分列表项与段落，空行折叠 */
function SectionBody({ lines, palette }: { lines: string[]; palette: Palette }) {
  const items: ReactNode[] = []
  let key = 0
  for (const raw of lines) {
    const line = raw.trimEnd()
    if (!line.trim()) continue
    const bullet = line.match(/^\s*(?:[-•·]|\d+[.、)）])\s+(.*)$/)
    if (bullet) {
      items.push(
        <div key={key++} className="flex gap-1.5">
          <span className={cn('shrink-0 font-bold', palette.marker)} aria-hidden>
            ·
          </span>
          <span>{renderInline(bullet[1])}</span>
        </div>,
      )
    } else {
      items.push(<p key={key++}>{renderInline(line)}</p>)
    }
  }
  return <div className="space-y-1.5 break-words text-[13px] leading-6 text-foreground/90">{items}</div>
}

export function MarkdownBoard({ content, className }: { content: string; className?: string }) {
  const sections = parseSections(content)
  if (sections.length === 0) {
    return <p className={cn('text-sm text-muted-foreground', className)}>（内容为空）</p>
  }
  // 单小节（无标题纯文本）直接平铺，不套看板框
  if (sections.length === 1 && sections[0].title === null) {
    return (
      <div className={cn('whitespace-pre-wrap break-words text-sm leading-6 text-foreground', className)}>
        {sections[0].lines.join('\n')}
      </div>
    )
  }
  return (
    <div className={cn('grid grid-cols-1 gap-3 md:grid-cols-2', className)}>
      {sections.map((sec, i) => {
        const palette = paletteOf(sec.title, i)
        // 首个有标题的小节（通常为概述）通栏大框，其余半栏
        const lead = sec.title !== null && i === sections.findIndex((s) => s.title !== null)
        if (sec.title === null) {
          return (
            <div key={i} className="md:col-span-2">
              <SectionBody lines={sec.lines} palette={palette} />
            </div>
          )
        }
        return (
          <section
            key={i}
            className={cn(
              'rounded-md border border-border/60 border-l-4 p-3.5',
              palette.bar,
              palette.bg,
              lead && 'md:col-span-2',
            )}
          >
            <h3 className={cn('mb-2 text-[15px] font-bold tracking-tight', palette.titleText)}>
              {renderInline(sec.title)}
            </h3>
            <SectionBody lines={sec.lines} palette={palette} />
          </section>
        )
      })}
    </div>
  )
}
