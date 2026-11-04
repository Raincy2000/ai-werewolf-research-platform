import { describe, it, expect } from 'vitest'
import { eraSortKey, orderCanonItems } from './canonTimelineOrder'

describe('canonTimelineOrder（详情页关系事件时间线）', () => {
  it('无手动排序时按时代时间：年/季节/年末/未知', () => {
    const items = [
      { id: 1, era: '2005年末' },
      { id: 2, era: '2004年夏' },
      { id: 3, era: '2004年' },
      { id: 4, era: '（时间不明）' },
    ]
    expect(orderCanonItems(items, false).map((x) => x.id)).toEqual([3, 2, 1, 4])
    expect(eraSortKey('2004年夏')).toBe('2004-06-00')
    expect(eraSortKey('2005年末')).toBe('2005-13-00')
    expect(eraSortKey('无年份')).toBe('9999-99-99')
  })

  it('有 sortOrder 时按手动顺序（拖动结果），并支持倒序', () => {
    const items = [
      { id: 10, era: '2020年', sortOrder: 2 },
      { id: 11, era: '2001年', sortOrder: 1 },
      { id: 12, era: '1999年', sortOrder: 3 },
    ]
    expect(orderCanonItems(items, false).map((x) => x.id)).toEqual([11, 10, 12])
    expect(orderCanonItems(items, true).map((x) => x.id)).toEqual([12, 10, 11])
  })

  it('手动排序缺失的项排最后，不破坏已有顺序', () => {
    const items = [
      { id: 21, era: '2003年', sortOrder: null },
      { id: 22, era: '2001年', sortOrder: 1 },
      { id: 23, era: '2002年', sortOrder: 2 },
    ]
    expect(orderCanonItems(items, false).map((x) => x.id)).toEqual([22, 23, 21])
  })
})
