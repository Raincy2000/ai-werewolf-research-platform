/**
 * 事件流时段分组（开局/第N夜/第N日）纯逻辑。
 * 从 EventStream.tsx 抽离：纯函数独立成文件便于单测（api 侧 tsconfig 无 jsx）。
 */

import type { GameEvent } from '@contracts/game'

/** 中文序数（1-20；超出回退阿拉伯数字） */
const CN_NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十',
  '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十']
function cnNum(n: number): string {
  return CN_NUM[n - 1] ?? String(n)
}

export interface EventSession {
  key: string
  label: string
  events: GameEvent[]
}

/**
 * 把事件流按时段（开局/第N夜/第N日）分组，保持时间顺序。
 * 顺序扫描：推定 key 与当前组一致则归入，否则开新组（时间单调推进，同 key 组唯一有序）。
 * game.over 等无法判定昼夜的事件跟随当前组，不单独成组。
 */
export function groupEventsIntoSessions(events: GameEvent[]): EventSession[] {
  const sessions: EventSession[] = []
  for (const ev of events) {
    let key: string | null = null
    let label = ''
    if (ev.phase === 'game.init' || ev.phase === 'game.start') {
      key = 'init'
      label = '开局'
    } else if (ev.phase.startsWith('postgame')) {
      // 赛后发言独立成组：以对局记录的时间标签形式呈现（不再走右侧独立频道）
      key = 'postgame'
      label = '赛后发言'
    } else if (ev.phase.startsWith('night.')) {
      key = `d${ev.day}-night`
      label = `第${cnNum(ev.day)}夜`
    } else if (ev.phase.startsWith('day.')) {
      key = `d${ev.day}-day`
      label = `第${cnNum(ev.day)}日`
    }
    // game.over / 其他无法判定昼夜的阶段：跟随当前组
    const cur = sessions[sessions.length - 1]
    if (key === null) {
      if (cur) cur.events.push(ev)
      else sessions.push({ key: 'init', label: '开局', events: [ev] })
    } else if (cur && cur.key === key) {
      cur.events.push(ev)
    } else {
      sessions.push({ key, label, events: [ev] })
    }
  }
  return sessions
}

/**
 * 保证「当前时段」的标签存在：只要对局进入新的夜/日（以快照 phase+day 为准），
 * 即使该时段还没有任何事件，也补出一个空时段标签——呼吸灯随之移到新标签待定，
 * 不会滞留在上一时段（如已到第二日，灯却亮在第一日标签）。
 */
export function withCurrentSession(
  sessions: EventSession[],
  day: number,
  phase: string,
): EventSession[] {
  let key: string | null = null
  let label = ''
  if (phase.startsWith('postgame')) {
    key = 'postgame'
    label = '赛后发言'
  } else if (phase.startsWith('night.')) {
    key = `d${day}-night`
    label = `第${cnNum(day)}夜`
  } else if (phase.startsWith('day.')) {
    key = `d${day}-day`
    label = `第${cnNum(day)}日`
  }
  if (!key) return sessions
  const last = sessions[sessions.length - 1]
  if (last && last.key === key) return sessions
  return [...sessions, { key, label, events: [] }]
}
