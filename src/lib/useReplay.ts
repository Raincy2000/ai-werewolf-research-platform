/**
 * 对局回放控制器（历史对局的事件流按真实节奏重现）：
 * 进度条拖动 / 播放暂停 / 上一时段·下一时段跳章 / 0.5x-3.0x 倍速。
 * 纯前端：事件数据即回放素材（对局记录 = 回放带），无任何服务端改动。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { GameEvent } from '@contracts/game'
import { buildReplaySchedule } from '@/lib/replaySchedule'
import { groupEventsIntoSessions } from '@/lib/eventSessions'

export const REPLAY_SPEEDS = [0.5, 1, 1.5, 2, 3] as const

export interface ReplayController {
  /** 回放模式已激活（进入后事件流按游标截断显示） */
  active: boolean
  playing: boolean
  speed: number
  /** 已揭示事件数（0..total；events[0..cursorIdx-1] 可见） */
  cursorIdx: number
  total: number
  /** 游标处的对局内时刻（相对首事件，ms） */
  positionMs: number
  totalMs: number
  /** 游标处事件（无=尚未开始） */
  currentEvent: GameEvent | null
  start: () => void
  exit: () => void
  toggle: () => void
  seek: (idx: number) => void
  /** 跳章：dir=1 下一时段（第N夜/第N日），dir=-1 上一时段（章首再按一次回上一章） */
  jumpSession: (dir: 1 | -1) => void
  changeSpeed: (s: number) => void
}

export function useReplay(events: GameEvent[]): ReplayController {
  const [active, setActive] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState<number>(1)
  const [cursorIdx, setCursorIdx] = useState(0)
  const total = events.length

  // 时刻表按 speed=1 计算，播放时除以当前倍速（切倍速不重置播放位置）
  const baseSchedule = useMemo(() => buildReplaySchedule(events, 1), [events])
  const t0 = events.length > 0 ? Date.parse(events[0]!.createdAt) : 0
  const totalMs =
    events.length > 1 ? Math.max(0, Date.parse(events[events.length - 1]!.createdAt) - t0) : 0
  const positionMs =
    cursorIdx > 0 && cursorIdx <= total
      ? Math.max(0, Date.parse(events[cursorIdx - 1]!.createdAt) - t0)
      : 0

  // 时段分组（快进/快退的章节边界）
  const sessions = useMemo(() => groupEventsIntoSessions(events), [events])

  // 播放驱动：逐事件延时揭示；到尾自动停
  useEffect(() => {
    if (!playing || !active) return
    if (cursorIdx >= total) {
      setPlaying(false)
      return
    }
    const delay = (baseSchedule[cursorIdx]?.delayMs ?? 300) / (speed > 0 ? speed : 1)
    const timer = window.setTimeout(() => setCursorIdx((c) => Math.min(c + 1, total)), Math.max(30, delay))
    return () => window.clearTimeout(timer)
  }, [playing, active, cursorIdx, total, baseSchedule, speed])

  const start = useCallback(() => {
    setCursorIdx(0)
    setActive(true)
    setPlaying(true)
  }, [])

  const exit = useCallback(() => {
    setPlaying(false)
    setActive(false)
  }, [])

  const toggle = useCallback(() => {
    if (!active) {
      start()
      return
    }
    setPlaying((p) => {
      // 已到末尾再按播放 = 从头再来
      if (!p && cursorIdx >= total) setCursorIdx(0)
      return !p
    })
  }, [active, cursorIdx, total, start])

  const seek = useCallback(
    (idx: number) => {
      setCursorIdx(Math.max(0, Math.min(total, Math.round(idx))))
    },
    [total],
  )

  const jumpSession = useCallback(
    (dir: 1 | -1) => {
      if (sessions.length === 0) return
      // 游标当前所在组（游标在 0 视为 -1 组之前）
      let cur = -1
      let acc = 0
      for (let i = 0; i < sessions.length; i++) {
        const size = sessions[i]!.events.length
        if (cursorIdx > acc) cur = i // 游标落在该组内（acc < cursorIdx）
        acc += size
      }
      if (dir === 1) {
        const next = Math.min(sessions.length - 1, cur + 1)
        if (next === cur) {
          seek(total) // 已是最后一章：跳到末尾
          return
        }
        const idx = sessions.slice(0, next).reduce((n, s) => n + s.events.length, 0)
        seek(idx)
      } else {
        // 章首（游标恰在组首或组内第一个事件后）→ 上一章章首；否则回本章章首
        const startOf = (g: number) => sessions.slice(0, g).reduce((n, s) => n + s.events.length, 0)
        const curStart = cur >= 0 ? startOf(cur) : 0
        if (cur > 0 && cursorIdx <= curStart + 1) {
          seek(startOf(cur - 1))
        } else {
          seek(cur >= 0 ? curStart : 0)
        }
      }
    },
    [sessions, cursorIdx, total, seek],
  )

  const changeSpeed = useCallback((s: number) => setSpeed(s), [])

  return {
    active,
    playing,
    speed,
    cursorIdx,
    total,
    positionMs,
    totalMs,
    currentEvent: cursorIdx > 0 && cursorIdx <= total ? events[cursorIdx - 1]! : null,
    start,
    exit,
    toggle,
    seek,
    jumpSession,
    changeSpeed,
  }
}
