import type { GameEvent, PlayerSnapshot } from '@contracts/game'

/** 从最终结算名单提取存活座位；没有完整结果名单时返回 null。 */
export function finalSurvivorsFromEvents(events: readonly GameEvent[]): Set<number> | null {
  const result = [...events].reverse().find((event) => event.type === 'result')
  if (!result) return null
  const survivors = new Set<number>()
  let found = false
  for (const match of result.content.matchAll(/(\d+)号【[^】]+】(存活|出局)/g)) {
    found = true
    if (match[2] === '存活') survivors.add(Number(match[1]))
  }
  return found ? survivors : null
}

/** 死亡座位统一来源：普通事件读 actor；清晨集体公告从正文还原全部死者。 */
export function deathSeatsFromEvent(event: GameEvent): number[] {
  if (event.type !== 'death') return []
  if (event.actor != null) return [event.actor]
  const match = /^昨夜((?:\d+号)(?:、\d+号)*)玩家死亡。$/.exec(event.content)
  if (!match) return []
  return [...match[1].matchAll(/(\d+)号/g)].map((seat) => Number(seat[1]))
}

function usableSnapshotDeathInfo(info: string | null | undefined): info is string {
  return Boolean(info && info !== '出局' && !info.endsWith('死亡公告'))
}

/**
 * 逐座位还原死因：新事件读引擎元数据，运行中读引擎快照，
 * 旧事件按正文与同夜结算记录回退；绝不再把“死亡公告”标题当成死因。
 */
export function deathInfoBySeatFromEvents(
  events: readonly GameEvent[],
  current: ReadonlyMap<number, string | null> = new Map(),
): Map<number, string> {
  const result = new Map<number, string>()
  const inferred = new Map<number, string>()
  let lastHunter: number | null = null
  const seatOf = (text: string, pattern: RegExp): number | null => {
    const match = pattern.exec(text)
    return match ? Number(match[1]) : null
  }
  for (const event of events) {
    if (event.type === 'action') {
      let seat: number | null = null
      switch (event.title) {
        case '狼刀落定':
          seat = seatOf(event.content, /袭击(\d+)号玩家/)
          if (seat != null) inferred.set(seat, '被狼人袭击')
          break
        case '同守同救':
          seat = seatOf(event.content, /^(\d+)号玩家/)
          if (seat != null) inferred.set(seat, '被狼人袭击&被同守同救')
          break
        case '守护成功':
        case '解药生效':
        case '摄梦保护':
          seat = seatOf(event.content, /^(\d+)号玩家/)
          if (seat != null) inferred.delete(seat)
          break
        case '毒药':
          seat = seatOf(event.content, /毒杀(\d+)号玩家/)
          if (seat != null) inferred.set(seat, '被女巫毒杀')
          break
        case '免疫毒药':
          seat = seatOf(event.content, /^(\d+)号玩家/)
          if (seat != null && inferred.get(seat) === '被女巫毒杀') inferred.delete(seat)
          break
        case '狩猎':
          lastHunter = event.actor
          break
        case '狩猎成功':
          seat = seatOf(event.content, /狩猎(\d+)号玩家/)
          if (seat != null) inferred.set(seat, '被猎魔人狩猎')
          break
        case '狩猎失败':
          if (lastHunter != null) inferred.set(lastHunter, '被猎魔人狩猎')
          break
        case '摄梦致死':
          seat = seatOf(event.content, /^(\d+)号玩家/)
          if (seat != null) inferred.set(seat, '摄梦致死')
          break
        case '梦境坍塌':
          seat = seatOf(event.content, /，(\d+)号被摄者同死/)
          if (seat != null) inferred.set(seat, '因摄梦人阵亡而同死')
          break
        case '血月诅咒':
          seat = seatOf(event.content, /血月使徒(\d+)号/)
          if (seat != null) inferred.set(seat, '血月诅咒降临')
          break
      }
      continue
    }
    if (event.type !== 'death') continue
    const meta = event.meta?.deathInfoBySeat
    const metaMap = meta && typeof meta === 'object' && !Array.isArray(meta)
      ? meta as Record<string, unknown>
      : {}
    const direct = /^\d+号玩家(.+)。$/.exec(event.content)?.[1] ?? null
    for (const seat of deathSeatsFromEvent(event)) {
      const fromMeta = metaMap[String(seat)]
      const currentInfo = current.get(seat)
      const inferredInfo = inferred.get(seat)
      const info = typeof fromMeta === 'string' && fromMeta
        ? fromMeta
        : usableSnapshotDeathInfo(currentInfo)
          ? currentInfo
          : direct
            ? `第${event.day}天 · ${direct}`
            : inferredInfo
              ? `第${event.day}夜 · ${inferredInfo}`
              : event.phase === 'day.dawn'
                ? `第${event.day}夜 · 夜间出局`
                : `第${event.day}天 · 出局`
      result.set(seat, info)
      inferred.delete(seat)
    }
  }
  return result
}

/** 座位状态以事件推进；终局优先使用完整结算名单，容忍个别死亡事件缺失。 */
export function playersWithEventDeaths(
  players: readonly PlayerSnapshot[],
  events: readonly GameEvent[],
): PlayerSnapshot[] {
  if (events.length === 0) return [...players]
  const deaths = deathInfoBySeatFromEvents(events, new Map(players.map((player) => [player.seat, player.deathInfo])))
  const finalSurvivors = finalSurvivorsFromEvents(events)
  if (finalSurvivors) {
    return players.map((player) => ({
      ...player,
      alive: finalSurvivors.has(player.seat),
      deathInfo: finalSurvivors.has(player.seat) ? null : (deaths.get(player.seat) ?? player.deathInfo ?? '出局'),
    }))
  }
  return players.map((player) =>
    deaths.has(player.seat)
      ? { ...player, alive: false, deathInfo: deaths.get(player.seat)! }
      : { ...player, alive: true, deathInfo: null },
  )
}
