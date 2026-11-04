import { describe, expect, it } from 'vitest'
import type { GameEvent, PlayerSnapshot } from '@contracts/game'
import { playersWithEventDeaths } from './playerEventState'

function player(seat: number): PlayerSnapshot {
  return { seat, role: 'villager', roleName: '平民', camp: 'villager', alive: true, sheriff: false, deathInfo: null, aiModel: 'mock' }
}

function death(seat: number, day = 2): GameEvent {
  return {
    seq: seat,
    day,
    phase: 'day.speech',
    type: 'death',
    actor: seat,
    actorLabel: `${seat}号玩家`,
    title: '死亡公告',
    content: `${seat}号玩家出局。`,
    thought: null,
    meta: null,
    createdAt: '2026-11-03T00:00:00.000Z',
  }
}

describe('事件流重建座位存活状态', () => {
  it('即使快照仍是存活，也必须按死亡事件更正座位并显示正文死因', () => {
    const players = Array.from({ length: 4 }, (_, index) => player(index + 1))
    const result = playersWithEventDeaths(players, [death(1), death(3)])
    expect(result.map((p) => p.alive)).toEqual([false, true, false, true])
    expect(result[0]!.deathInfo).toBe('第2天 · 出局')
  })

  it('夜间集体公告还原座位，并从旧对局技能结算中还原真实死因', () => {
    const players = Array.from({ length: 12 }, (_, index) => player(index + 1))
    const night = (seq: number, day: number, content: string): GameEvent => ({
      ...death(1, day), seq, actor: null, actorLabel: null, phase: 'day.dawn', content,
    })
    const action = (seq: number, day: number, title: string, content: string): GameEvent => ({
      ...death(1, day), seq, type: 'action', actor: null, actorLabel: null, phase: 'night.settle', title, content,
    })
    const result = playersWithEventDeaths(players, [
      action(263, 2, '毒药', '女巫使用毒药毒杀2号玩家。'),
      night(270, 2, '昨夜2号玩家死亡。'),
      action(317, 3, '狼刀落定', '狼队最终决定袭击7号玩家。'),
      action(318, 3, '毒药', '女巫使用毒药毒杀11号玩家。'),
      night(326, 3, '昨夜7号、11号玩家死亡。'),
      action(327, 4, '同守同救', '1号玩家同守同救，奶穿身亡。'),
      night(328, 4, '昨夜1号玩家死亡。'),
      { ...action(329, 5, '狩猎', '猎魔人今夜狩猎了8号玩家。'), actor: 6 },
      action(330, 5, '狩猎失败', '猎魔人狩猎8号玩家，对方是好人，猎魔人自己死亡。'),
      night(331, 5, '昨夜6号玩家死亡。'),
      action(332, 6, '摄梦致死', '8号玩家连续两晚被摄梦，摄梦致死。'),
      night(333, 6, '昨夜8号玩家死亡。'),
      action(334, 7, '梦境坍塌', '摄梦人阵亡，9号被摄者同死。'),
      night(335, 7, '昨夜9号玩家死亡。'),
      action(336, 8, '血月诅咒', '血月使徒10号的诅咒降临，其在夜终死亡。'),
      night(337, 8, '昨夜10号玩家死亡。'),
      night(338, 8, '昨夜平安夜，无人死亡。'),
    ])
    expect(result.filter((p) => !p.alive).map((p) => p.seat)).toEqual([1, 2, 6, 7, 8, 9, 10, 11])
    expect(result[1]!.deathInfo).toBe('第2夜 · 被女巫毒杀')
    expect(result[6]!.deathInfo).toBe('第3夜 · 被狼人袭击')
    expect(result[10]!.deathInfo).toBe('第3夜 · 被女巫毒杀')
    expect(result[0]!.deathInfo).toBe('第4夜 · 被狼人袭击&被同守同救')
    expect(result[5]!.deathInfo).toBe('第5夜 · 被猎魔人狩猎')
    expect(result[7]!.deathInfo).toBe('第6夜 · 摄梦致死')
    expect(result[8]!.deathInfo).toBe('第7夜 · 因摄梦人阵亡而同死')
    expect(result[9]!.deathInfo).toBe('第8夜 · 血月诅咒降临')
  })

  it('没有事件时保留原快照，避免未开始对局被误判', () => {
    const players = [player(1)]
    expect(playersWithEventDeaths(players, [])).toEqual(players)
  })

  it('死亡事件缺失时以最终结算名单校正终局座位', () => {
    const players = Array.from({ length: 12 }, (_, index) => player(index + 1))
    const result: GameEvent = {
      ...death(1, 5),
      type: 'result',
      title: '游戏结果',
      content: '狼人阵营胜利！1号【狼人】出局，2号【平民】出局，3号【猎魔人】出局，4号【平民】出局，5号【女巫】出局，6号【狼人】出局，7号【狼人】存活，8号【预言家】出局，9号【平民】出局，10号【血月使徒】出局，11号【白痴】存活，12号【平民】出局',
    }
    const rebuilt = playersWithEventDeaths(players, [result])
    expect(rebuilt.filter((p) => p.alive).map((p) => p.seat)).toEqual([7, 11])
    expect(rebuilt.filter((p) => !p.alive).map((p) => p.seat)).toEqual([1, 2, 3, 4, 5, 6, 8, 9, 10, 12])
  })
})
