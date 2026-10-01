/**
 * 对局日志导出工具：由 game.export 的研究数据生成
 *  - .txt 人类可读日志（座位表 + 事件流 + 心理活动），单一文件便于查看分析
 * 文件通过浏览器 Blob 本地下载，无图片等外部素材。
 */

import type { GameEvent, GameSnapshot } from '@contracts/game'
import { CAMP_LABEL, EVENT_TYPE_LABEL, statusLabelOf, winnerLabel } from './gameLabels'

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** ISO 时间 → "YYYY-MM-DD HH:mm:ss"（本地时区），非法输入原样返回 */
export function formatTimestamp(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** 生成人类可读纯文本日志（无 Markdown 符号，适合任意文本编辑器查看分析） */
export function buildTextLog(snapshot: GameSnapshot, events: GameEvent[]): string {
  const lines: string[] = []
  const SEP = '='.repeat(60)
  const SEP2 = '-'.repeat(60)
  lines.push(SEP)
  lines.push('AI模拟狼人杀对局日志')
  lines.push(SEP)
  lines.push(`对局 ID：${snapshot.gameId}`)
  lines.push(`版型：${snapshot.boardName}`)
  lines.push(`状态：${statusLabelOf(snapshot.status, snapshot.winner)}`)
  lines.push(`结果：${winnerLabel(snapshot.winner)}`)
  lines.push(`进行天数：第 ${snapshot.day} 天`)
  lines.push(`创建时间：${formatTimestamp(snapshot.createdAt)}`)
  lines.push(`导出时间：${formatTimestamp(new Date().toISOString())}`)
  lines.push('')
  lines.push(SEP2)
  lines.push('座位表（上帝视角）')
  lines.push(SEP2)
  for (const p of snapshot.players) {
    const status = p.alive ? '存活' : `死亡（${p.deathInfo ?? '原因未知'}）`
    const sheriff = p.sheriff ? ' 警长' : ''
    lines.push(
      `${p.seat} 号位 | ${p.roleName} | ${CAMP_LABEL[p.camp]} | ${p.aiModel} | ${status}${sheriff}`,
    )
  }
  lines.push('')
  lines.push(SEP2)
  lines.push('事件流（含心理活动，仅观察者可见）')
  lines.push(SEP2)
  for (const e of events) {
    const actor = e.actorLabel ? ` · ${e.actorLabel}` : ''
    lines.push(`[#${e.seq}] 第${e.day}天 · ${e.phase} · ${EVENT_TYPE_LABEL[e.type]} · ${e.title}${actor}`)
    if (e.content) {
      for (const c of e.content.split('\n')) lines.push(`  ${c}`)
    }
    if (e.thought) {
      lines.push(`  心理活动（未公开）：`)
      for (const t of e.thought.split('\n')) lines.push(`    ${t}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

/** 触发浏览器下载一个文本文件 */
export function downloadTextFile(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // 延迟回收，确保下载已开始
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** 导出单一 .txt 日志文件（人类可读，含座位表 + 事件流 + 心理活动） */
export function downloadGameLogs(snapshot: GameSnapshot, events: GameEvent[]): void {
  const base = `werewolf-${snapshot.gameId}`
  const txt = buildTextLog(snapshot, events)
  downloadTextFile(`${base}.txt`, txt, 'text/plain')
}
