import { afterEach, describe, expect, it, vi } from 'vitest'
import { notifyRelationsChanged, subscribeRelationsChanged } from './relationRefresh'

describe('relationRefresh（详情页补完/手录后的刷新广播）', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('订阅后能收到关系变化事件与 personaIds', () => {
    vi.stubGlobal('window', new EventTarget())
    const seen: Array<{ personaIds?: number[]; reason?: string }> = []
    const off = subscribeRelationsChanged((d) => seen.push(d))
    notifyRelationsChanged({ personaIds: [5, 7], reason: 'completion' })
    expect(seen).toEqual([{ personaIds: [5, 7], reason: 'completion' }])
    off()
    notifyRelationsChanged({ reason: 'after-unsubscribe' })
    expect(seen.length).toBe(1)
  })

  it('无 window 环境下安全空转（SSR/测试）', () => {
    expect(() => notifyRelationsChanged({ personaIds: [1] })).not.toThrow()
    expect(() => subscribeRelationsChanged(() => {})()).not.toThrow()
  })
})
