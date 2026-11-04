/**
 * 三维关系图（§40）：人格 = 玻璃球（内嵌头像），关系线在三维空间穿梭。
 *
 * 两种布局：
 *  - 全局：所有球均匀分布在球面
 *  - 焦点（点击某人）：该人居中，与之相关者环绕展开，无关者推远
 * 布局切换带平滑插值动画。
 *
 * 审计修正（P1-20 / P1-21 / P2-19 / P2-20 / P2-25）：
 *  - 画布颜色按浅色纸面主题取（不再是深色硬编码），深色主题有独立分支；
 *  - 悬停/选中关系线显示中文关系类型 + 数值 tooltip；
 *  - 自环画成小圆环；悬空边不画线（由侧栏列出）；
 *  - 首屏 yaw/pitch 不再被 mount effect 归零；头像缓存按 URL 版本刷新；
 *  - 命中半径跟随 zoom/选中放大；双击节点不再 focus→unfocus 抵消；
 *  - 搜索同时过滤球与线，无命中显示空态；canvas 有 role/aria/tabIndex/键盘操作。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  filterVisibleDyads,
  visibleNodeIds,
  type GraphNodeView,
  type DyadView,
} from '@/lib/relationGraph'

export type Node3D = GraphNodeView
export type Dyad = DyadView

type Vec3 = { x: number; y: number; z: number }

export interface RelationGraph3DProps {
  nodes: Node3D[]
  dyads: DyadView[]
  /** 聚焦人格：居中显示（null = 全局球面） */
  focusedId: number | null
  /** 变化时复位视角与缩放（复位按钮用）*/
  resetToken?: number
  /** 点击球体 → 聚焦；点击空白 → 取消聚焦 */
  onFocus: (id: number | null) => void
  hoverDyad: string | null
  onHoverDyad: (key: string | null) => void
  selectedDyad: string | null
  onSelectDyad: (key: string | null) => void
  query: string
  /** 线条颜色（由上层按视图层 / 跨世界 / 主题决定） */
  colorOf: (kind: string, layer: string, mixed?: boolean) => string
  /** 关系类型中文标签（tooltip 用） */
  labelOf: (kind: string, layer: string) => string
  /** 当前主题是否为深色（浅色纸面为应用根主题） */
  isDark?: boolean
}

const GOLDEN = Math.PI * (3 - Math.sqrt(5))
/** 纵向压扁系数：<1 时整体呈扁平椭圆观感（用户指定）*/
const SQUASH_Y = 0.64
const FOV = 1100

interface CanvasTheme {
  grid: string
  glowCenter: string
  glowEdge: string
  nameFill: string
  nameStroke: string
  focusRing: string
  fallbackInner: string
  fallbackMid: string
  fallbackOuter: string
  sphereGlow: string
  nodeStroke: string
  focusNodeStroke: string
  rim: string
  tooltipBg: string
  tooltipBorder: string
  tooltipText: string
  tooltipSub: string
}

const LIGHT_THEME: CanvasTheme = {
  grid: 'rgba(90,98,112,0.10)',
  glowCenter: 'rgba(96,140,200,0.10)',
  glowEdge: 'rgba(96,140,200,0)',
  nameFill: 'rgba(38,36,31,0.92)',
  nameStroke: 'rgba(247,245,240,0.92)',
  focusRing: 'rgba(58,98,150,0.55)',
  fallbackInner: 'rgba(255,255,255,0.95)',
  fallbackMid: 'rgba(176,190,210,0.75)',
  fallbackOuter: 'rgba(120,136,158,0.85)',
  sphereGlow: 'rgba(120,160,210,0.20)',
  nodeStroke: 'rgba(110,125,145,0.65)',
  focusNodeStroke: 'rgba(58,98,150,0.9)',
  rim: 'rgba(247,245,240,0)',
  tooltipBg: 'rgba(255,255,255,0.97)',
  tooltipBorder: 'rgba(38,36,31,0.18)',
  tooltipText: '#26241f',
  tooltipSub: '#6b675c',
}

const DARK_THEME: CanvasTheme = {
  grid: 'rgba(148,163,184,0.09)',
  glowCenter: 'rgba(96,165,250,0.06)',
  glowEdge: 'rgba(96,165,250,0)',
  nameFill: 'rgba(226,232,240,0.95)',
  nameStroke: 'rgba(10,14,26,0.85)',
  focusRing: 'rgba(150,200,255,0.55)',
  fallbackInner: 'rgba(255,255,255,0.92)',
  fallbackMid: 'rgba(150,172,198,0.55)',
  fallbackOuter: 'rgba(52,66,86,0.6)',
  sphereGlow: 'rgba(180,215,255,0.14)',
  nodeStroke: 'rgba(190,215,245,0.55)',
  focusNodeStroke: 'rgba(255,255,255,1)',
  rim: 'rgba(6,10,20,0.82)',
  tooltipBg: 'rgba(24,28,38,0.94)',
  tooltipBorder: 'rgba(226,232,240,0.22)',
  tooltipText: '#eceae4',
  tooltipSub: '#a8aeb8',
}

/** 椭球均匀分布：squashY < 1 时纵向压扁（用户要的"扁平椭圆"观感）*/
function spherePoints(n: number, R: number, squashY = 1): Vec3[] {
  const out: Vec3[] = []
  for (let i = 0; i < n; i++) {
    const y = n === 1 ? 0 : 1 - (i / (n - 1)) * 2
    const r = Math.sqrt(Math.max(0, 1 - y * y))
    const theta = GOLDEN * i
    out.push({ x: Math.cos(theta) * r * R, y: y * R * squashY, z: Math.sin(theta) * r * R })
  }
  return out
}

function rotate(p: Vec3, yaw: number, pitch: number): Vec3 {
  const cy = Math.cos(yaw), sy = Math.sin(yaw)
  const x1 = p.x * cy - p.z * sy
  const z1 = p.x * sy + p.z * cy
  const cp = Math.cos(pitch), sp = Math.sin(pitch)
  const y1 = p.y * cp - z1 * sp
  const z2 = p.y * sp + z1 * cp
  return { x: x1, y: y1, z: z2 }
}

/**
 * 计算目标布局。
 * 焦点模式：被聚焦者居中（原点），相关者按关系强度排序后环绕在球壳上，
 * 无关者推到外圈（仍在视野但淡化）。
 */
export function computeLayout(
  nodes: Node3D[],
  dyads: DyadView[],
  focusedId: number | null,
  R: number,
  /** 画布尺寸：用于把聚焦布局限制在可视范围内 */
  view?: { w: number; h: number },
): Map<number, Vec3> {
  const m = new Map<number, Vec3>()
  if (focusedId == null) {
    const pts = spherePoints(Math.max(1, nodes.length), R, SQUASH_Y)
    nodes.forEach((n, i) => m.set(n.id, pts[i]!))
    return m
  }

  const related = new Map<number, number>() // id → 最强关联强度
  for (const d of dyads) {
    if (d.dangling) continue
    if (d.a === focusedId && d.b !== focusedId) {
      related.set(d.b, Math.max(related.get(d.b) ?? 0, d.dominant.involvement))
    }
    if (d.b === focusedId && d.a !== focusedId) {
      related.set(d.a, Math.max(related.get(d.a) ?? 0, d.dominant.involvement))
    }
  }

  // 聚焦者居原点
  m.set(focusedId, { x: 0, y: 0, z: 0 })

  const relNodes = nodes
    .filter((n) => related.has(n.id))
    .sort((a, b) => (related.get(b.id) ?? 0) - (related.get(a.id) ?? 0))

  // ★ 相关者：在 XY 平面**放射状均匀展开**（不再用球壳，避免 z 轴重叠）
  //   强弱分层：强关系内圈、弱关系外圈；仅给极轻的 z 交错制造层次，不造成遮挡
  const n2 = Math.max(1, relNodes.length)
  // ★ 视野安全边界：按画布比例算，并预留「球半径 + 名字标签」的空间
  const safeX = view ? Math.max(60, view.w / 2 - 110) : R * 1.9
  const safeY = view ? Math.max(50, view.h / 2 - 78) : R * 1.4
  relNodes.forEach((n, i) => {
    const strength = related.get(n.id) ?? 0
    const ring = strength >= 70 ? 1.1 : strength >= 40 ? 1.45 : 1.8
    // 聚焦也走扁椭圆：横向尽量铺满安全区，纵向只取 72%（更扁更舒展）
    const rx = Math.min(R * ring * 1.55, safeX)
    const ry = Math.min(R * ring * 0.72, safeY * 0.82)
    const a = (i / n2) * Math.PI * 2 - Math.PI / 2
    const z = (i % 2 === 0 ? -1 : 1) * R * 0.06
    m.set(n.id, { x: Math.cos(a) * rx, y: Math.sin(a) * ry, z })
  })

  // 无关者：推到最外圈（焦点视图里本就不绘制，位置仅作动画起点）
  const others = nodes.filter((n) => n.id !== focusedId && !related.has(n.id))
  const R3 = R * 2.4
  others.forEach((n, i) => {
    const a = (i / Math.max(1, others.length)) * Math.PI * 2
    m.set(n.id, { x: Math.cos(a) * R3, y: Math.sin(a) * R3, z: 0 })
  })

  return m
}

type Projected = { x: number; y: number; scale: number; depth: number }

export function RelationGraph3D(props: RelationGraph3DProps) {
  const {
    nodes, dyads, focusedId, resetToken, onFocus, hoverDyad, onHoverDyad,
    selectedDyad, onSelectDyad, query, colorOf, labelOf, isDark = false,
  } = props
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)

  const [size, setSize] = useState({ w: 900, h: 560 })
  const [yaw, setYaw] = useState(0.6)
  const [pitch, setPitch] = useState(-0.28)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const zoomRef = useRef({ zoom: 1, pan: { x: 0, y: 0 } })
  const sizeRef = useRef({ w: 900, h: 560 })
  const dyadsRef = useRef(dyads)
  /** 球半径的当前缩放值（用于选中放大时做平滑过渡，不瞬变）*/
  const radiusScaleRef = useRef<Map<number, number>>(new Map())
  useEffect(() => { dyadsRef.current = dyads }, [dyads])

  const theme = isDark ? DARK_THEME : LIGHT_THEME

  const dragRef = useRef<{ on: boolean; x: number; y: number; moved: number } | null>(null)
  const animRef = useRef<Map<number, Vec3>>(new Map())
  const targetRef = useRef<Map<number, Vec3>>(new Map())
  const rafRef = useRef<number>(0)

  // 滚轮缩放：仅当光标位于画布内时拦截（画布外保持页面滚动）
  useEffect(() => {
    const cv = canvasRef.current
    if (!cv) return
    // ★ 以光标为中心的平滑指数缩放（120 → 约 1.15 倍/格）
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault()
      ev.stopPropagation()
      const rect = cv.getBoundingClientRect()
      const mx = ev.clientX - rect.left
      const my = ev.clientY - rect.top
      const { w, h } = sizeRef.current
      const cx = w / 2, cy = h / 2
      const { zoom: oldZoom, pan: oldPan } = zoomRef.current
      const factor = Math.exp(-ev.deltaY * 0.0013)
      const newZoom = Math.max(0.35, Math.min(4, oldZoom * factor))
      // 让光标下的点保持不动
      const wx = (mx - cx - oldPan.x) / oldZoom
      const wy = (my - cy - oldPan.y) / oldZoom
      const newPan = { x: mx - cx - wx * newZoom, y: my - cy - wy * newZoom }
      zoomRef.current = { zoom: newZoom, pan: newPan }
      setZoom(newZoom)
      setPan(newPan)
    }
    cv.addEventListener('wheel', onWheel, { passive: false })
    return () => cv.removeEventListener('wheel', onWheel)
  }, [])

  // 头像缓存：★ 按 image URL 版本刷新（旧 bug：首次载入后永不更新，换头像不生效）
  const imgCache = useRef<Map<number, { img: HTMLImageElement; src: string }>>(new Map())
  const [imgTick, setImgTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    const seen = new Set<number>()
    for (const n of nodes) {
      const src = n.image
      if (!src) continue
      seen.add(n.id)
      const cached = imgCache.current.get(n.id)
      if (cached && cached.src === src) continue
      imgCache.current.delete(n.id)
      const img = new Image()
      img.onload = () => {
        if (cancelled) return
        imgCache.current.set(n.id, { img, src })
        setImgTick((t) => t + 1)
      }
      img.src = src
    }
    for (const id of [...imgCache.current.keys()]) {
      if (!seen.has(id)) imgCache.current.delete(id)
    }
    return () => { cancelled = true }
  }, [nodes])

  // 尺寸自适应（同时写入 ref 供原生事件使用）
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver((es) => {
      const r = es[0]?.contentRect
      if (!r || r.width < 40 || r.height < 40) return
      const next = { w: Math.round(r.width), h: Math.round(r.height) }
      sizeRef.current = next
      setSize(next)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => { zoomRef.current = { zoom, pan } }, [zoom, pan])

  // ★ 进入聚焦 / 退出聚焦时，视角归正。**跳过首挂**（P2-19：首屏 yaw/pitch 被归零）
  const focusMountedRef = useRef(false)
  useEffect(() => {
    if (!focusMountedRef.current) { focusMountedRef.current = true; return }
    setYaw(0)
    setPitch(0)
    zoomRef.current = { zoom: 1, pan: { x: 0, y: 0 } }
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }, [focusedId])

  // ★ 重置按钮：无条件复位视角、缩放、球体半径缩放（跳过首挂）
  const resetMountedRef = useRef(false)
  useEffect(() => {
    if (resetToken == null) return
    if (!resetMountedRef.current) { resetMountedRef.current = true; return }
    setYaw(0)
    setPitch(0)
    zoomRef.current = { zoom: 1, pan: { x: 0, y: 0 } }
    setZoom(1)
    setPan({ x: 0, y: 0 })
    radiusScaleRef.current.clear()
  }, [resetToken])

  // 目标布局变化 → 初始化目标位置
  useEffect(() => {
    const R = Math.min(size.w, size.h) * 0.56
    const next = computeLayout(nodes, dyads, focusedId, R, { w: size.w, h: size.h })
    targetRef.current = next
    // 首次出现直接落位，避免从原点飞入
    for (const [id, p] of next) {
      if (!animRef.current.has(id)) animRef.current.set(id, { ...p })
    }
  }, [nodes, dyads, focusedId, size.w, size.h])

  /** 当前可见 dyad（搜索/聚焦同一口径；含悬空，画线时跳过悬空） */
  const visibleDyads = useMemo(() => {
    const nameOf = (id: number) => nodes.find((n) => n.id === id)?.name ?? ''
    return filterVisibleDyads(dyads, { focusedId, query, nameOf })
  }, [dyads, nodes, focusedId, query])
  const visibleIds = useMemo(
    () => visibleNodeIds(nodes, visibleDyads, { focusedId, query }),
    [nodes, visibleDyads, focusedId, query],
  )
  const searchEmpty = query.trim().length > 0 && visibleIds.size === 0
  const visibleRef = useRef({ dyads: visibleDyads, ids: visibleIds })
  useEffect(() => {
    visibleRef.current = { dyads: visibleDyads, ids: visibleIds }
  }, [visibleDyads, visibleIds])

  const draw = useCallback(() => {
    const cv = canvasRef.current
    if (!cv) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const { w, h } = size
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr)
      cv.height = Math.round(h * dpr)
    }
    const ctx = cv.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)

    const cx = w / 2, cy = h / 2
    const R = Math.min(w, h) * 0.56
    const { dyads: vis, ids: visIds } = visibleRef.current

    // 旋转 + 投影（叠加 zoom / pan）
    const proj = new Map<number, Projected>()
    for (const n of nodes) {
      const base = animRef.current.get(n.id) ?? targetRef.current.get(n.id)
      if (!base) continue
      const p = rotate(base, yaw, pitch)
      const s2 = FOV / (FOV + p.z)
      proj.set(n.id, {
        x: cx + pan.x + p.x * s2 * zoom,
        y: cy + pan.y + p.y * s2 * zoom,
        scale: s2 * zoom,
        depth: p.z,
      })
    }

    // 背景光晕
    const bg = ctx.createRadialGradient(cx, cy, R * 0.1, cx, cy, R * 1.3)
    bg.addColorStop(0, theme.glowCenter)
    bg.addColorStop(1, theme.glowEdge)
    ctx.fillStyle = bg
    ctx.beginPath(); ctx.arc(cx + pan.x, cy + pan.y, R * 1.3 * zoom, 0, Math.PI * 2); ctx.fill()

    // 经纬线（空间参照）
    ctx.strokeStyle = theme.grid
    ctx.lineWidth = 1
    for (let lat = -60; lat <= 60; lat += 30) {
      const rad = (lat * Math.PI) / 180
      ctx.beginPath()
      for (let lon = 0; lon <= 360; lon += 6) {
        const lr = (lon * Math.PI) / 180
        const p = rotate({ x: Math.cos(lr) * Math.cos(rad) * R, y: Math.sin(rad) * R, z: Math.sin(lr) * Math.cos(rad) * R }, yaw, pitch)
        const s2 = FOV / (FOV + p.z)
        const X = cx + pan.x + p.x * s2 * zoom, Y = cy + pan.y + p.y * s2 * zoom
        if (lon === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y)
      }
      ctx.stroke()
    }

    // ===== 线：每条可见 dyad 一条（跳过悬空边），远→近 =====
    type LineView = { d: DyadView; a: Projected; b: Projected; depth: number }
    const lineDraw: LineView[] = []
    for (const d of vis) {
      if (d.dangling) continue // 悬空边：库外角色无坐标，由侧栏列出（P1-21）
      if (!visIds.has(d.a) || !visIds.has(d.b)) continue
      const a = proj.get(d.a), b = proj.get(d.b)
      if (!a || !b) continue
      lineDraw.push({ d, a, b, depth: (a.depth + b.depth) / 2 })
    }
    lineDraw.sort((p, q2) => q2.depth - p.depth)

    // 节点度（先算一次，避免 draw 内 O(N×E) —— P1-25）
    const degree = new Map<number, number>()
    for (const { d } of lineDraw) {
      degree.set(d.a, (degree.get(d.a) ?? 0) + 1)
      if (d.b !== d.a) degree.set(d.b, (degree.get(d.b) ?? 0) + 1)
    }
    const radiusOf = (id: number, depthScale: number) => {
      const isFocus = focusedId === id
      const baseR = isFocus ? 32 : 18 + Math.min(10, (degree.get(id) ?? 0) * 1.4)
      const selScale = radiusScaleRef.current.get(id) ?? 1
      return baseR * selScale * depthScale
    }

    for (const { d, a, b } of lineDraw) {
      const hovered = hoverDyad === d.key
      const picked = selectedDyad === d.key
      const strengthA = 0.35 + (d.dominant.involvement / 100) * 0.45
      const alpha = hovered ? 1 : picked ? 0.95 : Math.min(0.8, strengthA)
      const hasVale = d.edges.some((e) => e.layer === 'vale')
      const hasCanon = d.edges.some((e) => e.layer !== 'vale')
      const mixed = hasVale && hasCanon
      ctx.strokeStyle = colorOf(d.dominant.kind, d.dominant.layer, mixed)
      ctx.globalAlpha = alpha
      ctx.lineWidth = hovered ? 6.5 : 2.4
      ctx.setLineDash([])
      if (d.a === d.b) {
        // 自环：围绕球体画一圈小圆环（P1-21）
        const ringR = (radiusOf(d.a, a.scale) + 8) * (d.a === focusedId ? 1 : 1)
        ctx.beginPath()
        ctx.arc(a.x, a.y, Math.max(6, ringR), -Math.PI * 0.85, Math.PI * 0.55)
        ctx.stroke()
      } else {
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2
        const bend = 0.02
        ctx.beginPath()
        ctx.moveTo(a.x, a.y)
        ctx.quadraticCurveTo(mx + (my - cy) * bend, my - (mx - cx) * bend, b.x, b.y)
        ctx.stroke()
      }
    }
    ctx.globalAlpha = 1

    // 节点：远→近
    const nodeDraw = nodes
      .filter((n) => visIds.has(n.id))
      .map((n) => ({ n, p: proj.get(n.id)! }))
      .filter((x) => !!x.p)
      .sort((p, q2) => q2.p.depth - p.p.depth)

    for (const { n, p } of nodeDraw) {
      const isFocus = focusedId === n.id
      const r = radiusOf(n.id, p.scale)

      // 外发光
      const glow = ctx.createRadialGradient(p.x, p.y, r * 0.4, p.x, p.y, r * (isFocus ? 2.4 : 2.0))
      glow.addColorStop(0, theme.sphereGlow)
      glow.addColorStop(1, 'rgba(180,215,255,0)')
      ctx.fillStyle = glow
      ctx.beginPath(); ctx.arc(p.x, p.y, r * (isFocus ? 2.4 : 2.0), 0, Math.PI * 2); ctx.fill()

      // 聚焦者加一圈呼吸光环
      if (isFocus) {
        ctx.strokeStyle = theme.focusRing
        ctx.lineWidth = 1.5
        ctx.beginPath(); ctx.arc(p.x, p.y, r * 1.32, 0, Math.PI * 2); ctx.stroke()
      }

      const cached = imgCache.current.get(n.id)
      const img = cached?.img
      if (img && img.complete && img.naturalWidth > 0) {
        ctx.save()
        ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.clip()
        const sc = Math.max((2 * r) / img.naturalWidth, (2 * r) / img.naturalHeight)
        const dw = img.naturalWidth * sc, dh = img.naturalHeight * sc
        ctx.imageSmoothingQuality = 'high'
        ctx.drawImage(img, p.x - dw / 2, p.y - dh / 2, dw, dh)
        // 边缘压暗（玻璃球内壁）
        const rim = ctx.createRadialGradient(p.x, p.y, r * 0.46, p.x, p.y, r)
        rim.addColorStop(0, 'rgba(6,10,20,0)')
        rim.addColorStop(0.75, 'rgba(6,10,20,0.20)')
        rim.addColorStop(1, theme.rim)
        ctx.fillStyle = rim
        ctx.fillRect(p.x - r, p.y - r, 2 * r, 2 * r)
        // 高光
        const gl = ctx.createRadialGradient(p.x - r * 0.34, p.y - r * 0.4, 0, p.x - r * 0.34, p.y - r * 0.4, r * 0.9)
        gl.addColorStop(0, 'rgba(255,255,255,0.52)')
        gl.addColorStop(0.5, 'rgba(255,255,255,0.10)')
        gl.addColorStop(1, 'rgba(255,255,255,0)')
        ctx.fillStyle = gl
        ctx.fillRect(p.x - r, p.y - r, 2 * r, 2 * r)
        ctx.restore()
        ctx.strokeStyle = isFocus ? theme.focusNodeStroke : theme.nodeStroke
        ctx.lineWidth = isFocus ? 3 : 1.2
        ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.stroke()
      } else {
        const g = ctx.createRadialGradient(p.x - r * 0.35, p.y - r * 0.38, r * 0.08, p.x, p.y, r)
        g.addColorStop(0, theme.fallbackInner)
        g.addColorStop(0.45, theme.fallbackMid)
        g.addColorStop(1, theme.fallbackOuter)
        ctx.fillStyle = g
        ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill()
        ctx.strokeStyle = isFocus ? theme.focusNodeStroke : theme.nodeStroke
        ctx.lineWidth = isFocus ? 3 : 1.2
        ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.stroke()
      }

      // 名字
      const nameAlpha = Math.min(1, 0.35 + p.scale * 0.75)
      ctx.globalAlpha = nameAlpha
      ctx.font = `${Math.round((isFocus ? 12 : 8.5) + p.scale * 1.6)}px system-ui`
      ctx.textAlign = 'center'
      const label = n.name.length > 8 ? n.name.slice(0, 8) + '…' : n.name
      ctx.strokeStyle = theme.nameStroke
      ctx.lineWidth = 3
      ctx.strokeText(label, p.x, p.y + r + 17)
      ctx.fillStyle = theme.nameFill
      ctx.fillText(label, p.x, p.y + r + 17)
      ctx.globalAlpha = 1
    }

    // ===== 悬停/选中关系线 tooltip：中文类型 + 数值（P1-21）=====
    const activeKey = hoverDyad ?? selectedDyad
    const active = activeKey ? vis.find((d) => d.key === activeKey) : null
    if (active && !active.dangling) {
      const a = proj.get(active.a), b = proj.get(active.b)
      if (a && b) {
        const dom = active.dominant
        const title = labelOf(dom.kind, dom.layer) + (dom.layer === 'vale' ? ' · 山谷' : ' · 原世界')
        const line2 = '卷入 ' + Math.round(dom.involvement) + ' · 信任 ' + Math.round(dom.trust) +
          ' · 正/负 ' + Math.round(dom.positivity) + '/' + Math.round(dom.negativity)
        const line3 = active.edges.length > 1 ? '共 ' + active.edges.length + ' 条关系合并' : ''
        ctx.font = '11px system-ui'
        const w1 = ctx.measureText(title).width
        ctx.font = '10px system-ui'
        const w2 = ctx.measureText(line2).width
        const w3 = line3 ? ctx.measureText(line3).width : 0
        const boxW = Math.max(w1, w2, w3) + 14
        const boxH = line3 ? 46 : 32
        const midX = active.a === active.b ? a.x + 16 : (a.x + b.x) / 2
        const midY = active.a === active.b ? a.y + 16 : (a.y + b.y) / 2
        const bx = Math.max(4, Math.min(w - boxW - 4, midX + 12))
        const by = Math.max(4, Math.min(h - boxH - 4, midY - boxH / 2))
        ctx.globalAlpha = 1
        ctx.fillStyle = theme.tooltipBg
        ctx.strokeStyle = theme.tooltipBorder
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.roundRect(bx, by, boxW, boxH, 6)
        ctx.fill()
        ctx.stroke()
        ctx.textAlign = 'left'
        ctx.fillStyle = theme.tooltipText
        ctx.font = '11px system-ui'
        ctx.fillText(title, bx + 7, by + 15)
        ctx.fillStyle = theme.tooltipSub
        ctx.font = '10px system-ui'
        ctx.fillText(line2, bx + 7, by + 28)
        if (line3) ctx.fillText(line3, bx + 7, by + 41)
      }
    }
  }, [size, yaw, pitch, nodes, focusedId, colorOf, labelOf, zoom, pan.x, pan.y, hoverDyad, selectedDyad, theme])

  // 动画循环：位置插值 + 球半径插值 + 重绘
  useEffect(() => {
    let stop = false
    const tick = () => {
      if (stop) return
      let moving = false

      // 位置插值
      for (const [id, t] of targetRef.current) {
        const p = animRef.current.get(id)
        if (!p) { animRef.current.set(id, { ...t }); continue }
        const dx = t.x - p.x, dy = t.y - p.y, dz = t.z - p.z
        if (Math.hypot(dx, dy, dz) > 0.6) {
          moving = true
          p.x += dx * 0.2; p.y += dy * 0.2; p.z += dz * 0.2
        } else {
          p.x = t.x; p.y = t.y; p.z = t.z
        }
      }

      // ★ 球半径插值：选中关系线时，非中心那端平滑放大（不是瞬变）
      const sel = selectedDyad ? dyadsRef.current.find((d) => d.key === selectedDyad) : null
      for (const n of nodes) {
        const want = (sel && !sel.dangling && n.id !== focusedId && (sel.a === n.id || sel.b === n.id)) ? 1.35 : 1
        const cur = radiusScaleRef.current.get(n.id) ?? 1
        const diff = want - cur
        if (Math.abs(diff) > 0.004) {
          radiusScaleRef.current.set(n.id, cur + diff * 0.16)
          moving = true
        } else {
          radiusScaleRef.current.set(n.id, want)
        }
      }

      draw()
      if (moving) rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => { stop = true; cancelAnimationFrame(rafRef.current) }
  }, [draw, selectedDyad, focusedId, nodes])

  // ★ 悬停/选中是"外部状态"，不放进 draw 的依赖（避免每次 hover 都重建回调、重启动画循环），
  //   而是单独触发一次重绘
  useEffect(() => { draw() }, [draw, imgTick, hoverDyad, selectedDyad, visibleDyads, visibleIds])

  /** 当前视图的投影：绘制/命中测试共用同一套数学，保证「看得到就点得中」 */
  const projected = useCallback(() => {
    const { w, h } = size
    const cx = w / 2, cy = h / 2
    const out = new Map<number, { x: number; y: number; r: number }>()
    const { ids, dyads: vis } = visibleRef.current
    const degree = new Map<number, number>()
    for (const d of vis) {
      if (d.dangling) continue
      degree.set(d.a, (degree.get(d.a) ?? 0) + 1)
      if (d.b !== d.a) degree.set(d.b, (degree.get(d.b) ?? 0) + 1)
    }
    for (const n of nodes) {
      if (!ids.has(n.id)) continue
      const base = animRef.current.get(n.id)
      if (!base) continue
      const p = rotate(base, yaw, pitch)
      const s = FOV / (FOV + p.z)
      const isFocus = focusedId === n.id
      const baseR = isFocus ? 32 : 18 + Math.min(10, (degree.get(n.id) ?? 0) * 1.4)
      const selScale = radiusScaleRef.current.get(n.id) ?? 1
      out.set(n.id, {
        x: cx + zoomRef.current.pan.x + p.x * s * zoomRef.current.zoom,
        y: cy + zoomRef.current.pan.y + p.y * s * zoomRef.current.zoom,
        r: baseR * selScale * s * zoomRef.current.zoom,
      })
    }
    return out
  }, [size, nodes, yaw, pitch, focusedId])

  /** 命中测试：球体（半径跟随缩放/选中放大，P2-19） */
  const hitTest = (mx: number, my: number): number | null => {
    const proj = projected()
    let best: { id: number; d: number } | null = null
    for (const [id, p] of proj) {
      const d = Math.hypot(p.x - mx, p.y - my)
      if (d <= p.r + 8) {
        if (!best || d < best.d) best = { id, d }
      }
    }
    return best?.id ?? null
  }

  /** 线命中测试：搜索/聚焦后的可见线集合（P2-20），自环按圆环判定 */
  const hitTestLine = (mx: number, my: number): string | null => {
    const proj = projected()
    let best: { key: string; d: number } | null = null
    for (const d of visibleRef.current.dyads) {
      if (d.dangling) continue
      const a = proj.get(d.a), b = proj.get(d.b)
      if (!a || !b) continue
      if (d.a === d.b) {
        const ringR = a.r + 8
        const dd = Math.abs(Math.hypot(a.x - mx, a.y - my) - Math.max(6, ringR))
        if (dd < 10 && (!best || dd < best.d)) best = { key: d.key, d: dd }
        continue
      }
      const dx = b.x - a.x, dy = b.y - a.y
      const len2 = dx * dx + dy * dy
      if (len2 === 0) continue
      let t = ((mx - a.x) * dx + (my - a.y) * dy) / len2
      t = Math.max(0, Math.min(1, t))
      const px = a.x + t * dx, py = a.y + t * dy
      const dd = Math.hypot(mx - px, my - py)
      if (dd < 10 && (!best || dd < best.d)) best = { key: d.key, d: dd }
    }
    return best?.key ?? null
  }

  const getPos = (ev: { clientX: number; clientY: number }) => {
    const cv = canvasRef.current!
    const rect = cv.getBoundingClientRect()
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top }
  }

  /** 双击节流：记录上一次点中的节点，避免连续两次 pointerdown 把 focus 打开又关掉 */
  const lastNodeClickRef = useRef<{ id: number; t: number } | null>(null)

  const resetView = () => {
    zoomRef.current = { zoom: 1, pan: { x: 0, y: 0 } }
    setZoom(1)
    setPan({ x: 0, y: 0 })
    setYaw(0)
    setPitch(0)
  }

  const onCanvasKeyDown = (ev: React.KeyboardEvent<HTMLCanvasElement>) => {
    if (ev.key === 'Escape') {
      ev.stopPropagation()
      onFocus(null)
      onSelectDyad(null)
      onHoverDyad(null)
    } else if (ev.key === 'ArrowLeft') {
      ev.preventDefault(); setYaw((y) => y - 0.12)
    } else if (ev.key === 'ArrowRight') {
      ev.preventDefault(); setYaw((y) => y + 0.12)
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault(); setPitch((p) => Math.max(-1.2, p - 0.1))
    } else if (ev.key === 'ArrowDown') {
      ev.preventDefault(); setPitch((p) => Math.min(1.2, p + 0.1))
    } else if (ev.key === '+' || ev.key === '=') {
      ev.preventDefault()
      setZoom((z) => {
        const next = Math.min(4, z * 1.15)
        zoomRef.current = { ...zoomRef.current, zoom: next }
        return next
      })
    } else if (ev.key === '-' || ev.key === '_') {
      ev.preventDefault()
      setZoom((z) => {
        const next = Math.max(0.35, z / 1.15)
        zoomRef.current = { ...zoomRef.current, zoom: next }
        return next
      })
    } else if (ev.key === '0') {
      resetView()
    }
  }

  return (
    <div ref={wrapRef} className="absolute inset-0">
      <canvas
        ref={canvasRef}
        className="h-full w-full cursor-grab touch-none rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        role="application"
        tabIndex={0}
        aria-label={
          '三维人格关系网：' + nodes.length + ' 个人格 · ' + visibleDyads.length +
          ' 条可见关系。点击头像聚焦，点击关系线查看详情；方向键旋转，+/- 缩放，Esc 退出聚焦。'
        }
        onKeyDown={onCanvasKeyDown}
        onPointerDown={(ev) => {
          const p = getPos(ev)
          const id = hitTest(p.x, p.y)
          if (id != null) {
            // ★ 双击节流：350ms 内重复点同一人只保持聚焦，不再 focus→unfocus 抵消（P2-19）
            const last = lastNodeClickRef.current
            const now = Date.now()
            lastNodeClickRef.current = { id, t: now }
            if (!(last && last.id === id && now - last.t < 350)) {
              onFocus(id === focusedId ? null : id)
            }
            onSelectDyad(null)
            return
          }
          // 点击线：右侧展开该对的全部关系
          const dk = hitTestLine(p.x, p.y)
          if (dk != null) {
            onSelectDyad(dk)
            return
          }
          ;(ev.target as Element).setPointerCapture?.(ev.pointerId)
          dragRef.current = { on: true, x: ev.clientX, y: ev.clientY, moved: 0 }
        }}
        onPointerMove={(ev) => {
          const cv = canvasRef.current
          if (dragRef.current?.on) {
            const dx = ev.clientX - dragRef.current.x
            const dy = ev.clientY - dragRef.current.y
            dragRef.current.moved += Math.abs(dx) + Math.abs(dy)
            dragRef.current.x = ev.clientX
            dragRef.current.y = ev.clientY
            setYaw((y) => y + dx * 0.008)
            setPitch((pt) => Math.max(-1.2, Math.min(1.2, pt + dy * 0.008)))
            return
          }
          const p = getPos(ev)
          const overNode = hitTest(p.x, p.y) != null
          const key = overNode ? null : hitTestLine(p.x, p.y)
          if (key !== hoverDyad) onHoverDyad(key)
          if (cv && cv.style.cursor !== (key || overNode ? 'pointer' : 'grab')) {
            cv.style.cursor = key || overNode ? 'pointer' : 'grab'
          }
        }}
        onPointerUp={() => {
          const d = dragRef.current
          dragRef.current = null
          // 空白处轻点 → 退出聚焦并收起详情（研究数据不允许"标题还在、内容属于另一对"）
          if (d && d.moved < 6) {
            onFocus(null)
            onSelectDyad(null)
          }
        }}
        onPointerLeave={() => { dragRef.current = null; onHoverDyad(null) }}
        onDoubleClick={(ev) => {
          // ★ 仅空白处双击复位；双击节点不再与聚焦切换互相抵消（P2-19）
          const p = getPos(ev)
          if (hitTest(p.x, p.y) != null || hitTestLine(p.x, p.y) != null) return
          resetView()
        }}
      />
      {searchEmpty ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <p className="rounded-md border border-border bg-card/95 px-3 py-1.5 text-xs text-muted-foreground">
            没有匹配「{query.trim()}」的人格
          </p>
        </div>
      ) : null}
      <div className="pointer-events-none absolute right-2 top-2 max-w-[70%] rounded border border-border bg-card/85 px-2 py-1 text-[10px] text-muted-foreground">
        {focusedId == null
          ? '点击头像聚焦 · 拖拽旋转 · 滚轮缩放 · 双击空白复位'
          : '点击空白 / Esc 退出聚焦 · 点击关系线切换视角'}
      </div>
    </div>
  )
}
