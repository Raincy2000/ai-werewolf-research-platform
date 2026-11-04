import type { GameEvent, GameSnapshot } from '@contracts/game'

export interface ReplayResultView {
  showResult: boolean
  winner: GameSnapshot['winner']
}

/** 回放只允许显示游标已经揭示的结局，禁止把最终快照提前套到中间时间线。 */
export function resultViewOf(events: readonly GameEvent[]): ReplayResultView {
  const result = [...events].reverse().find((event) => event.type === 'result')
  if (!result) return { showResult: false, winner: null }
  if (result.content.startsWith('狼人阵营胜利')) return { showResult: true, winner: 'wolf' }
  if (result.content.startsWith('好人阵营胜利')) return { showResult: true, winner: 'good' }
  return { showResult: true, winner: null }
}
