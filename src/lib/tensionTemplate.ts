/**
 * 张力模板解析（铁律6）：把人格座位 thought 的四段式模板解析为结构化小节，
 * 供观察室分层渲染；非模板文本（普通座位/兜底思考）返回 isTemplate=false 走原有样式。
 * 模板结构：
 *   【当前撕裂】（可多组）
 *   - 参数A："诉求"
 *   - 参数B："诉求"
 *   冲突强度：0.XX
 *   【参数触发】/【防御启动】/【创伤唤醒】（可选段）
 *   【身体痕迹】副语言
 *   【涌现输出】角色真实反应
 */

export interface TensionSection {
  key: string // 段名（如 当前撕裂/身体痕迹/涌现输出/参数触发/防御启动/创伤唤醒）
  body: string // 段体（不含段标题）
  /** 冲突强度（仅撕裂段；0-1，可能多组） */
  intensities: number[]
}

export interface ParsedTensionTemplate {
  isTemplate: boolean
  sections: TensionSection[]
}

const SECTION_RE = /【([^】]+)】/g
const INTENSITY_RE = /冲突强度：\s*(\d+(?:\.\d+)?)/g

export function parseTensionTemplate(thought: string): ParsedTensionTemplate {
  const marks: { name: string; index: number; end: number }[] = []
  for (const m of thought.matchAll(SECTION_RE)) {
    marks.push({ name: m[1] ?? '', index: m.index ?? 0, end: (m.index ?? 0) + m[0].length })
  }
  const has = (key: string) => marks.some((m) => m.name === key)
  // 模板判定：必须同时含撕裂段（或参数触发段）与涌现输出段
  const isTemplate = has('涌现输出') && (has('当前撕裂') || has('参数触发'))
  if (!isTemplate) return { isTemplate: false, sections: [] }

  const sections: TensionSection[] = marks.map((m, i) => {
    const bodyEnd = i + 1 < marks.length ? marks[i + 1]!.index : thought.length
    const body = thought.slice(m.end, bodyEnd).trim()
    const intensities: number[] = []
    if (m.name === '当前撕裂') {
      for (const im of body.matchAll(INTENSITY_RE)) {
        const v = Number(im[1])
        intensities.push(v > 1 ? Math.min(1, v / 100) : Math.max(0, Math.min(1, v)))
      }
    }
    return { key: m.name, body, intensities }
  })
  return { isTemplate: true, sections }
}
