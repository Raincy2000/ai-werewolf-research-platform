/**
 * 关系网纯逻辑（无 React / DOM / canvas 依赖，可直接单测）。
 *
 * 职责：
 *  - 把 A↔B 的多层/多 kind 关系边合并成「一条线 = 一对人」（dyad）；
 *  - 按层/搜索/聚焦计算真正可见的 dyad 与节点（计数、命中测试、绘制共用同一口径）；
 *  - 关系线三色（原世界深蓝 / 纯山谷灰 / 跨世界暗金）与浅色/深色主题适配；
 *  - 详情面板默认视角（聚焦者 → 对方）。
 *
 * 审计对应：P0-13（视角）、P1-20（颜色）、P1-21（悬空边/自环/计数）、P2-20（搜索过滤）。
 */

// ---------------------------------------------------------------------------
// 视图类型（与 gameApi.relationGraph 返回同构；只列前端用到的字段）
// ---------------------------------------------------------------------------

export type LayerMode = 'all' | 'canon' | 'vale'

export type GraphNodeView = {
  id: number
  name: string
  source: string
  image?: string | null
}

export type GraphEdgeView = {
  id: number
  from: number
  to: number
  toName: string | null
  kind: string
  form: string
  layer: string
  positivity: number
  negativity: number
  trust: number
  involvement: number
  ambivalence: number
  closeness?: number
  dependence?: number
  reciprocity?: number
  powerBalance?: number
  formality?: number
  commitment?: number
  dangling: boolean
}

/** 一对人物 = 一条线（多层/多 kind 合并后的视图） */
export type DyadView = {
  /** 稳定标识：普通 dyad 用 "小id-大id"；悬空边用 "d:from:toName"；自环用 "id~id" */
  key: string
  /** 端点（普通 dyad 按数值升序；悬空边 a=from、b=0；自环 a=b=id） */
  a: number
  b: number
  /** 该对在当前视图下的全部关系（供详情展开） */
  edges: GraphEdgeView[]
  /** 主导关系（involvement 最高），决定线条颜色与悬停提示 */
  dominant: GraphEdgeView
  /** 悬空边：指向库外角色（to=0 / toName） */
  dangling: boolean
  /** 悬空边指向的库外角色名（非悬空为 null） */
  toName: string | null
}

export const LAYER_LABEL: Record<LayerMode, string> = {
  all: '全部',
  canon: '原世界',
  vale: '山谷',
}

/** 关系所属层 → 中文 */
export function layerLabel(layer: string): string {
  if (layer === 'canon') return '原世界'
  if (layer === 'vale') return '山谷'
  return '全部'
}

/** 悬空边判定：后端 to=0 或显式 dangling 标记 */
export function isDanglingEdge(edge: { dangling?: boolean; to?: number }): boolean {
  return edge.dangling === true || edge.to === 0 || edge.to == null
}

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

/** dyad 合并键：普通 dyad 无序（min-max），自环单独键 */
export function dyadKeyOf(a: number, b: number): string {
  if (a === b) return a + '~' + b
  return Math.min(a, b) + '-' + Math.max(a, b)
}

function dominantScore(e: GraphEdgeView): number {
  // involvement 为主；同分时正面情感略优先（保证排序稳定、可复现）
  return num(e.involvement) * 1000 + num(e.positivity)
}

/**
 * 合并 dyad：
 *  - A↔B 的 canon/vale 多行合并为一条；
 *  - 悬空边按 (from, toName) 独立成 dyad（不同库外角色不能合并——P0-5）；
 *  - 自环（from===to）单独一个 dyad，绘制时画小圆环。
 */
export function mergeDyads(edges: GraphEdgeView[]): DyadView[] {
  const map = new Map<string, DyadView>()
  for (const e of edges) {
    const dangling = isDanglingEdge(e)
    let key: string
    let a: number
    let b: number
    let toName: string | null = null
    if (dangling) {
      toName = (e.toName ?? '').trim() || '库外角色'
      key = 'd:' + e.from + ':' + toName
      a = e.from
      b = 0
    } else {
      a = Math.min(e.from, e.to)
      b = Math.max(e.from, e.to)
      key = dyadKeyOf(e.from, e.to)
    }
    const cur = map.get(key)
    if (!cur) {
      map.set(key, { key, a, b, edges: [e], dominant: e, dangling, toName })
      continue
    }
    cur.edges.push(e)
    if (dominantScore(e) > dominantScore(cur.dominant)) cur.dominant = e
  }
  return [...map.values()]
}

function normalizedQuery(query: string): string {
  return query.trim().toLowerCase()
}

/**
 * 按「层（调用方已过滤）→ 聚焦 → 搜索」筛出可见 dyad。
 * 计数、绘制、命中测试全部用这同一口径，避免「看得到点不中 / 数得到画不出」。
 */
export function filterVisibleDyads(
  dyads: DyadView[],
  opts: {
    focusedId?: number | null
    query?: string
    /** id → 名字（悬空边两侧都参与搜索） */
    nameOf?: (id: number) => string
  } = {},
): DyadView[] {
  const q = normalizedQuery(opts.query ?? '')
  const nameOf = opts.nameOf ?? (() => '')
  return dyads.filter((d) => {
    if (opts.focusedId != null && d.a !== opts.focusedId && d.b !== opts.focusedId) return false
    if (!q) return true
    const names = [nameOf(d.a), d.dangling ? (d.toName ?? '') : nameOf(d.b)]
    return names.some((n) => n.toLowerCase().includes(q))
  })
}

/**
 * 当前视图需要绘制的节点 id：
 *  - 搜索：只显示命中名字的球（P2-20 旧 bug：搜索只过滤线不过滤球）；
 *  - 聚焦：显示焦点 + 可见 dyad 的另一端；
 *  - 全局：显示可见 dyad 的端点；一条边都没有时退回显示全部球（空关系网仍可看到人）。
 */
export function visibleNodeIds(
  nodes: GraphNodeView[],
  visibleDyads: DyadView[],
  opts: { focusedId?: number | null; query?: string } = {},
): Set<number> {
  const ids = new Set<number>()
  const q = normalizedQuery(opts.query ?? '')
  if (q) {
    for (const n of nodes) if (n.name.toLowerCase().includes(q)) ids.add(n.id)
    // 聚焦的人被搜索词排除时不强行保留：搜索结果就是唯一可见集合（避免"无命中却画了球"）
    return ids
  }
  for (const d of visibleDyads) {
    if (d.dangling) {
      ids.add(d.a)
    } else {
      ids.add(d.a)
      ids.add(d.b)
    }
  }
  if (opts.focusedId != null) ids.add(opts.focusedId)
  if (ids.size === 0) for (const n of nodes) ids.add(n.id)
  return ids
}

/** 可见 dyad 计数（含悬空边；层过滤由调用方完成）。标题/面板计数统一走这里。 */
export function visibleDyadCount(visibleDyads: DyadView[]): number {
  return visibleDyads.length
}

// ---------------------------------------------------------------------------
// 详情视角（P0-13）：默认「聚焦者 → 对方」，可切换 A→B / B→A
// ---------------------------------------------------------------------------

export type Perspective = 'a' | 'b'

/**
 * 默认视角 = 聚焦者视角：
 *  - 聚焦的是 b → 从 b 看 a；
 *  - 聚焦 a 或无聚焦 → 从 a 看 b。
 */
export function defaultPerspective(focusedId: number | null | undefined, a: number, b: number): Perspective {
  if (focusedId != null && focusedId === b) return 'b'
  if (focusedId != null && focusedId === a) return 'a'
  return 'a'
}

export function flipPerspective(p: Perspective): Perspective {
  return p === 'a' ? 'b' : 'a'
}

/** 视角 → 方向端点；自环/悬空边界调用方自行短路 */
export function perspectiveEndpoints(dyad: Pick<DyadView, 'a' | 'b'>, perspective: Perspective): { from: number; to: number } {
  return perspective === 'a' ? { from: dyad.a, to: dyad.b } : { from: dyad.b, to: dyad.a }
}

// ---------------------------------------------------------------------------
// 关系线双色（用户 2026-10 定案，2026-10-22 再次确认）：
//   原世界有关系 → 绿；只有山谷产物 → 灰；
//   不再设「跨世界金色」。两者都是半透明、低饱和，线宽统一。
// ---------------------------------------------------------------------------

export interface LinePalette {
  /** 原世界：绿 */
  canon: string
  /** 只有山谷：灰 */
  vale: string
  /** 两者兼有：同「原世界绿」，不再单设金色 */
  mixed: string
  /** 未知层的兜底深蓝 */
  fallback: string
}

/** 用户指定的绿/灰（半透明）；深浅主题保持同一语义，不再按主题换成蓝/金。 */
export const LINE_PALETTE: { light: LinePalette; dark: LinePalette } = {
  light: {
    canon: 'rgba(74,170,110,0.62)',
    vale: 'rgba(150,156,170,0.60)',
    mixed: 'rgba(74,170,110,0.62)',
    fallback: 'rgba(58,98,150,0.78)',
  },
  dark: {
    canon: 'rgba(74,170,110,0.62)',
    vale: 'rgba(150,156,170,0.60)',
    mixed: 'rgba(74,170,110,0.62)',
    fallback: 'rgba(58,98,150,0.78)',
  },
}

export function linePalette(isDark: boolean): LinePalette {
  return isDark ? LINE_PALETTE.dark : LINE_PALETTE.light
}

/** 一条 dyad 的颜色：有原世界关系 → 绿；纯山谷 → 灰；未知 → 兜底蓝 */
export function relationLineColor(opts: {
  isDark?: boolean
  layer: string
  hasCanon: boolean
  hasVale: boolean
}): string {
  const p = linePalette(opts.isDark === true)
  if (opts.hasCanon || opts.layer === 'canon') return p.canon
  if (opts.hasVale || opts.layer === 'vale') return p.vale
  return p.fallback
}

/** dyad 的两界构成（绘制/图例共用） */
export function dyadLayers(dyad: Pick<DyadView, 'edges'>): { hasCanon: boolean; hasVale: boolean } {
  let hasCanon = false
  let hasVale = false
  for (const e of dyad.edges) {
    if (e.layer === 'vale') hasVale = true
    else hasCanon = true
  }
  return { hasCanon, hasVale }
}

/** 主题 class 判定（document.documentElement.className） */
export function hasDarkClass(className: string): boolean {
  return /(^|\s)dark(\s|$)/.test(className)
}
