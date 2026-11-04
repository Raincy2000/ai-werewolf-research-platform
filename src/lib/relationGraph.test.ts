/**
 * 关系网纯逻辑单测（对应审计 P0-13 / P1-20 / P1-21 / P2-20）
 */
import { describe, expect, it } from 'vitest'
import {
  LINE_PALETTE,
  defaultPerspective,
  dyadKeyOf,
  filterVisibleDyads,
  flipPerspective,
  hasDarkClass,
  layerLabel,
  mergeDyads,
  perspectiveEndpoints,
  relationLineColor,
  visibleDyadCount,
  visibleNodeIds,
  type GraphEdgeView,
  type GraphNodeView,
} from './relationGraph'

const edge = (patch: Partial<GraphEdgeView> & Pick<GraphEdgeView, 'id' | 'from' | 'to'>): GraphEdgeView => ({
  toName: null,
  kind: 'peer',
  form: 'CS',
  layer: 'canon',
  positivity: 50,
  negativity: 10,
  trust: 50,
  involvement: 50,
  ambivalence: 10,
  dangling: false,
  ...patch,
})

const NODES: GraphNodeView[] = [
  { id: 1, name: '艾伦', source: 'ai-cast' },
  { id: 2, name: '三笠', source: 'ai-cast' },
  { id: 3, name: '阿尔敏', source: 'ai-cast' },
]

describe('mergeDyads（一对人 = 一条线）', () => {
  it('A↔B 多层多 kind 合并为一条，主导关系取 involvement 最高', () => {
    const dyads = mergeDyads([
      edge({ id: 1, from: 1, to: 2, layer: 'canon', involvement: 60, kind: 'kin' }),
      edge({ id: 2, from: 2, to: 1, layer: 'canon', involvement: 90, kind: 'beloved' }),
      edge({ id: 3, from: 1, to: 2, layer: 'vale', involvement: 40, kind: 'team' }),
    ])
    expect(dyads).toHaveLength(1)
    expect(dyads[0]!.key).toBe('1-2')
    expect(dyads[0]!.a).toBe(1)
    expect(dyads[0]!.b).toBe(2)
    expect(dyads[0]!.edges).toHaveLength(3)
    expect(dyads[0]!.dominant.kind).toBe('beloved')
    expect(dyads[0]!.dangling).toBe(false)
  })

  it('悬空边按 (from,toName) 独立成 dyad，不同库外角色不合并（P0-5）', () => {
    const dyads = mergeDyads([
      edge({ id: 1, from: 3, to: 0, toName: '芙卡洛斯', dangling: true, kind: 'kin' }),
      edge({ id: 2, from: 3, to: 0, toName: '那维莱特', dangling: true, kind: 'kin' }),
      edge({ id: 3, from: 3, to: 0, toName: '芙卡洛斯', dangling: true, kind: 'mentor' }),
      edge({ id: 4, from: 3, to: 1, toName: '艾伦', kind: 'peer' }),
    ])
    expect(dyads).toHaveLength(3)
    const named = dyads.filter((d) => d.dangling)
    expect(named).toHaveLength(2)
    const fukalos = named.find((d) => d.toName === '芙卡洛斯')!
    expect(fukalos.edges).toHaveLength(2)
    expect(fukalos.key).toBe('d:3:芙卡洛斯')
    expect(fukalos.b).toBe(0)
  })

  it('自环（from===to）单独成一个 dyad，键用 ~ 标记', () => {
    const dyads = mergeDyads([
      edge({ id: 1, from: 2, to: 2, kind: 'self' }),
      edge({ id: 2, from: 2, to: 2, layer: 'vale', kind: 'self' }),
    ])
    expect(dyads).toHaveLength(1)
    expect(dyads[0]!.key).toBe('2~2')
    expect(dyads[0]!.a).toBe(2)
    expect(dyads[0]!.b).toBe(2)
    expect(dyads[0]!.edges).toHaveLength(2)
    expect(dyadKeyOf(2, 2)).toBe('2~2')
    expect(dyadKeyOf(9, 3)).toBe('3-9')
  })
})

describe('可见性（计数 / 绘制 / 命中同口径）', () => {
  const dyads = mergeDyads([
    edge({ id: 1, from: 1, to: 2 }),
    edge({ id: 2, from: 2, to: 3 }),
    edge({ id: 3, from: 1, to: 0, toName: '库外法师', dangling: true }),
  ])
  const nameOf = (id: number) => NODES.find((n) => n.id === id)?.name ?? ''

  it('聚焦只保留与焦点相连的 dyad（含悬空边）', () => {
    const focused = filterVisibleDyads(dyads, { focusedId: 1, nameOf })
    expect(focused.map((d) => d.key).sort()).toEqual(['1-2', 'd:1:库外法师'])
    expect(visibleDyadCount(focused)).toBe(2)
    const nodeIds = visibleNodeIds(NODES, focused, { focusedId: 1 })
    expect([...nodeIds].sort()).toEqual([1, 2])
  })

  it('搜索按两端名字过滤 dyad；悬空边可用库外角色名命中（P2-20）', () => {
    expect(filterVisibleDyads(dyads, { query: '三笠', nameOf }).map((d) => d.key)).toEqual(['1-2', '2-3'])
    expect(filterVisibleDyads(dyads, { query: '库外', nameOf }).map((d) => d.key)).toEqual(['d:1:库外法师'])
    expect(filterVisibleDyads(dyads, { query: '不存在', nameOf })).toHaveLength(0)
  })

  it('搜索只显示命中的球；无命中时为空集合（旧 bug：回退画全部球）', () => {
    const all = filterVisibleDyads(dyads, { nameOf })
    expect([...visibleNodeIds(NODES, all, { query: '三笠' })]).toEqual([2])
    expect(visibleNodeIds(NODES, all, { query: '不存在' }).size).toBe(0)
  })

  it('一条边都没有时退回显示全部球（空关系网仍可见人）', () => {
    expect([...visibleNodeIds(NODES, [], {})].sort()).toEqual([1, 2, 3])
  })
})

describe('详情视角（P0-13）', () => {
  it('默认视角 = 聚焦者视角；无聚焦从 a 看 b', () => {
    expect(defaultPerspective(2, 1, 2)).toBe('b')
    expect(defaultPerspective(1, 1, 2)).toBe('a')
    expect(defaultPerspective(null, 1, 2)).toBe('a')
  })

  it('切换视角后端点方向互换；再切回', () => {
    const flipped = flipPerspective(defaultPerspective(2, 1, 2))
    expect(flipped).toBe('a')
    expect(perspectiveEndpoints({ a: 1, b: 2 }, flipped)).toEqual({ from: 1, to: 2 })
    expect(perspectiveEndpoints({ a: 1, b: 2 }, 'b')).toEqual({ from: 2, to: 1 })
  })
})

describe('关系线双色（用户 2026-10 定案：灰/绿）', () => {
  it('有原世界关系 → 绿；纯山谷 → 灰', () => {
    const canon = relationLineColor({ layer: 'canon', hasCanon: true, hasVale: false })
    const vale = relationLineColor({ layer: 'vale', hasCanon: false, hasVale: true })
    const mixed = relationLineColor({ layer: 'canon', hasCanon: true, hasVale: true })
    expect(canon).toBe(LINE_PALETTE.light.canon)
    expect(vale).toBe(LINE_PALETTE.light.vale)
    expect(mixed).toBe(LINE_PALETTE.light.canon)
    expect(new Set([canon, vale, mixed]).size).toBe(2)
  })

  it('深色主题沿用同一绿/灰语义（不再按主题换蓝/金）', () => {
    const light = relationLineColor({ isDark: false, layer: 'canon', hasCanon: true, hasVale: false })
    const dark = relationLineColor({ isDark: true, layer: 'canon', hasCanon: true, hasVale: false })
    expect(dark).toBe(light)
    expect(LINE_PALETTE.dark.canon).toBe(LINE_PALETTE.light.canon)
    expect(LINE_PALETTE.dark.vale).toBe(LINE_PALETTE.light.vale)
  })

  it('未知层兜底深蓝', () => {
    expect(relationLineColor({ layer: 'unknown', hasCanon: false, hasVale: false })).toBe(LINE_PALETTE.light.fallback)
  })

  it('层名中文兜底；dark 类名判定', () => {
    expect(layerLabel('canon')).toBe('原世界')
    expect(layerLabel('vale')).toBe('山谷')
    expect(layerLabel('unknown')).toBe('全部')
    expect(hasDarkClass('dark')).toBe(true)
    expect(hasDarkClass('foo dark bar')).toBe(true)
    expect(hasDarkClass('darkness')).toBe(false)
  })
})

describe('点击标题人物名切换视角（2026-10-22）', () => {
  it('该机制已按用户要求撤销：只保留「换视角」按钮，不再导出 perspectiveForPerson', async () => {
    const mod = await import('./relationGraph')
    expect('perspectiveForPerson' in mod).toBe(false)
  })
})
