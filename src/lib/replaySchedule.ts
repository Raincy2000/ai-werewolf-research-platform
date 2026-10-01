/**
 * 回放事件时刻表（纯函数）：把事件 createdAt 序列换算为逐事件出现的延时序列。
 * - 首个事件立即出现；
 * - 相邻间隔按 createdAt 差值（回放=按真实节奏重现），超长思考/停歇间隔截断到 MAX_GAP；
 * - 倍速 = 间隔 / speed（0.5x 更慢、3x 更快）。
 */

export interface ReplayScheduleEntry {
  seq: number
  delayMs: number // 距上一个事件的等待时长（已按倍速缩放）
}

export const REPLAY_MAX_GAP_MS = 5_000 // 真实对局中 AI 长思考/日夜停歇的间隔，回放时压缩到该上限

export function buildReplaySchedule(
  events: { seq: number; createdAt: string }[],
  speed: number,
): ReplayScheduleEntry[] {
  const s = speed > 0 ? speed : 1
  const out: ReplayScheduleEntry[] = []
  let prev = 0
  for (let i = 0; i < events.length; i++) {
    const t = Date.parse(events[i]!.createdAt)
    const raw = i === 0 ? 0 : Math.max(0, (Number.isFinite(t) ? t : prev) - prev)
    out.push({ seq: events[i]!.seq, delayMs: Math.min(raw, REPLAY_MAX_GAP_MS) / s })
    prev = Number.isFinite(t) ? t : prev
  }
  return out
}
