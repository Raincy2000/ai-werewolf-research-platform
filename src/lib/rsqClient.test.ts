/**
 * RSQ 前端纯逻辑单测（对应审计 P1-3 / P1-12 / P1-22）
 */
import { describe, expect, it } from 'vitest'
import {
  RSQ_DIM_GROUPS,
  RSQ_DIM_KEYS,
  RSQ_DIMENSION_COUNT,
  RSQ_LEVEL_META,
  RSQ_SCORED_ITEM_COUNT,
  RSQ_SELF_SUMMARY_NO,
  buildRsqSubmitPayload,
  emptyAnswerState,
  normalizeRawAnswers,
  normalizeRsqItems,
  pageOfItem,
  paginateRsqItems,
  scoredAnswerCount,
  toReportData,
  toReportDataList,
  validateRsqAnswers,
  type RsqItemView,
} from './rsqClient'

const item = (no: number, patch: Partial<RsqItemView> = {}): RsqItemView => ({
  no,
  module: 'NRI 关系结构',
  dim: 'companionship',
  text: '题目 ' + no,
  scale: 'L7',
  ...patch,
})

const ITEMS: RsqItemView[] = [
  item(1), item(2), item(3), item(4), item(5), item(6), item(7), item(8), item(9), item(10), item(11),
  item(12, { module: '总体评语', scale: 'open', dim: null, text: '用一句话概括' }),
  item(120, { module: '总体评语', scale: 'open', dim: null, text: '一句话自评' }),
]

function answerAll(items: RsqItemView[], value = 4) {
  const answers = emptyAnswerState()
  for (const it of items) {
    if (it.scale !== 'open') answers.likert[it.no] = value
  }
  return answers
}

describe('题库归一 / 分页', () => {
  it('normalizeRsqItems：按题号排序、字段兜底、非法题丢弃', () => {
    const view = normalizeRsqItems({
      version: 'rsq-2.0.0',
      level: 'M',
      items: [
        { no: '2', module: 'M1', text: 'b', scale: 'L7' },
        { no: 1, module: 'M1', text: 'a', scale: 'L7' },
        { no: 0, module: 'M1', text: 'bad' },
        { no: 3, module: 'M1', text: '' },
      ],
    })
    expect(view.version).toBe('rsq-2.0.0')
    expect(view.level).toBe('M')
    expect(view.items.map((i) => i.no)).toEqual([1, 2])
    expect(normalizeRsqItems({}).level).toBe('L')
  })

  it('paginateRsqItems：按模块分组，长模块拆页且每页不超上限', () => {
    const pages = paginateRsqItems(ITEMS, 5)
    expect(pages.length).toBe(4) // 11 题 → 3 页 NRI；开放题模块 2 题 → 1 页
    expect(pages[0]!.title).toBe('NRI 关系结构（1/3）')
    expect(pages[2]!.title).toBe('NRI 关系结构（3/3）')
    expect(pages[3]!.title).toBe('总体评语')
    for (const p of pages) expect(p.items.length).toBeLessThanOrEqual(5)
    expect(pages.flatMap((p) => p.items.map((i) => i.no))).toEqual(ITEMS.map((i) => i.no))
  })
})

describe('作答校验 / 提交载荷', () => {
  it('validateRsqAnswers：开放题不要求作答，缺失题号按升序返回', () => {
    const answers = answerAll(ITEMS, 5)
    expect(validateRsqAnswers(ITEMS, answers)).toEqual({ ok: true, missing: [], total: 11, answered: 11 })

    delete answers.likert[3]
    delete answers.likert[9]
    const v = validateRsqAnswers(ITEMS, answers)
    expect(v.ok).toBe(false)
    expect(v.missing).toEqual([3, 9])
    expect(v.answered).toBe(9)
  })

  it('超出 1–7 的答案不计入已答', () => {
    const answers = answerAll(ITEMS, 5)
    answers.likert[1] = 9
    const v = validateRsqAnswers(ITEMS, answers)
    expect(v.ok).toBe(false)
    expect(v.missing).toEqual([1])
  })

  it('pageOfItem 定位到缺失题所在页', () => {
    const pages = paginateRsqItems(ITEMS, 4)
    expect(pageOfItem(pages, 12)).toBe(3)
    expect(pageOfItem(pages, 999)).toBe(0)
    expect(pageOfItem(pages, undefined)).toBe(0)
  })

  it('buildRsqSubmitPayload：开放题不入 raw；107–109→feedback；110/111→文字反馈；120→自评截断', () => {
    const answers = answerAll(ITEMS, 4)
    answers.open[110] = '  第 7 题最难，因为没经历过  '
    answers.open[111] = '  想加一个信任崩塌的方面  '
    answers.open[RSQ_SELF_SUMMARY_NO] = '  ' + '我和他是一起扛过事的人。'.repeat(6) + '  '
    const payload = buildRsqSubmitPayload({
      fromPersonaId: 3,
      toPersonaId: 9,
      level: 'S',
      items: ITEMS,
      answers,
    })
    expect(payload.raw['120']).toBeUndefined()
    expect(payload.raw['110']).toBeUndefined()
    expect(Object.keys(payload.raw)).toHaveLength(11)
    expect(payload.batteryLevel).toBe('S')
    expect(payload.model).toBeNull()
    expect(payload.feedback).not.toBeNull()
    expect(payload.feedback!.hardestItems[0]!.reason).toContain('第 7 题最难')
    expect(payload.feedback!.missingDimensions[0]!.suggestion).toContain('信任崩塌')
    expect(payload.selfSummary!.length).toBe(36)
  })

  it('buildRsqSubmitPayload：没填体验/开放题时 feedback 为 null', () => {
    const payload = buildRsqSubmitPayload({
      fromPersonaId: 1,
      toPersonaId: 2,
      level: 'L',
      items: ITEMS,
      answers: answerAll(ITEMS),
    })
    expect(payload.feedback).toBeNull()
    expect(payload.selfSummary).toBeNull()
  })
})

describe('报告适配（P1-22 契约漂移）', () => {
  const dims = Object.fromEntries(RSQ_DIM_KEYS.map((k, i) => [k, i % 101]))
  const record = {
    id: 7,
    dims,
    derived: { involvement: 66, ambivalence: 12 },
    validity: {
      consistency: 0.8,
      socialDesirability: 0.2,
      lieScale: 0.1,
      darkTriad: 22,
      behavioralGap: 0.15,
      experienceConsistency: 0.9,
      overall: 0.77,
      verdict: 'reliable',
      flags: ['straight-lining'],
    },
    raw: { '1': 4, '2': 5, '119': 3 } as Record<string, number>,
    selfSummary: '同生共死',
    answeredAt: '2026-10-20T10:00:00.000Z',
    itemsVersion: 'rsq-2.0.0',
    batteryLevel: 'M',
    radar: [{ axis: 'affection', label: '喜爱', value: 88 }],
  }

  it('45 维总表与后端实测一致；分组覆盖全部维度且无重复', () => {
    expect(RSQ_DIM_KEYS).toHaveLength(RSQ_DIMENSION_COUNT)
    const grouped = RSQ_DIM_GROUPS.flatMap((g) => g.keys.map(([k]) => k))
    expect(grouped).toHaveLength(45)
    expect(new Set(grouped).size).toBe(45)
    expect([...grouped].sort()).toEqual([...RSQ_DIM_KEYS].sort())
    expect(RSQ_SCORED_ITEM_COUNT).toBe(119)
  })

  it('toReportData：dims → dims（不是 dimensions），45 维齐全', () => {
    const r = toReportData(record)
    expect(Object.keys(r.dims)).toHaveLength(45)
    expect(r.dims.companionship).toBe(0)
    expect(r.validity.verdict).toBe('reliable')
    expect(r.raw[1]).toBe(4) // JSON 字符串键归一成数字键
    expect(r.raw[119]).toBe(3)
    expect(scoredAnswerCount(r.raw)).toBe(3)
    expect(r.selfSummary).toBe('同生共死')
    expect(r.radar).toHaveLength(1)
  })

  it('toReportData：旧记录用 dimensions 字段、validity 缺失/非数字也不崩', () => {
    const old = toReportData({
      id: 3,
      dimensions: { affection: 50, faith: 60 },
      validity: { verdict: 'bogus', consistency: 'x' },
      raw: {},
      answeredAt: 'not-a-date',
    })
    expect(old.dims.affection).toBe(50)
    expect(old.dims.faith).toBe(60)
    expect(old.dims.closeness).toBeNull()
    expect(old.validity.verdict).toBeNull()
    expect(old.validity.consistency).toBe(0)
    expect(old.validity.flags).toEqual([])
    expect(old.radar).toHaveLength(8) // 无 radar → 8 轴兜底
    expect(old.itemsVersion).toBe('unknown')
  })

  it('toReportDataList 批量适配并保留顺序', () => {
    const list = toReportDataList([record, { dims: {}, raw: {} }])
    expect(list).toHaveLength(2)
    expect(list[0]!.id).toBe(7)
    expect(list[1]!.id).toBe(-2)
  })

  it('normalizeRawAnswers 丢弃非法值；scoredAnswerCount 不把第 120 题算进 119', () => {
    const raw = normalizeRawAnswers({ '1': 7, '2': 0, '3': 8, '120': 3, x: 4 } as never)
    expect(raw).toEqual({ 1: 7, 120: 3 })
    expect(scoredAnswerCount(raw)).toBe(1)
  })

  it('RSQ_LEVEL_META 覆盖 L/M/S', () => {
    expect(Object.keys(RSQ_LEVEL_META).sort()).toEqual(['L', 'M', 'S'])
  })
})
