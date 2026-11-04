import { describe, expect, it } from 'vitest'
import type { GameEvent } from '@contracts/game'
import { resultViewOf } from './replayPresentation'

function event(seq: number, type: string, content = ''): GameEvent {
  return {
    seq,
    day: 5,
    phase: type === 'result' ? 'game.over' : 'day.speech',
    type: type as GameEvent['type'],
    actor: null,
    actorLabel: null,
    title: type,
    content,
    thought: null,
    meta: null,
    createdAt: '2026-11-03T00:00:00.000Z',
  }
}

describe('回放游标与终局展示一致性', () => {
  it('游标未到结果事件时不显示最终胜负', () => {
    expect(resultViewOf([event(1, 'death'), event(2, 'death')])).toEqual({ showResult: false, winner: null })
  })

  it('游标到达狼胜结果时才显示狼胜', () => {
    expect(resultViewOf([event(1, 'death'), event(2, 'result', '狼人阵营胜利！')])).toEqual({ showResult: true, winner: 'wolf' })
  })

  it('游标到达神民胜结果时才显示神民胜', () => {
    expect(resultViewOf([event(1, 'result', '好人阵营胜利！')])).toEqual({ showResult: true, winner: 'good' })
  })
})
