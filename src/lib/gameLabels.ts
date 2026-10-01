/**
 * 对局展示用中文标签映射（UI 与导出日志共用）。
 * 类型来自 @contracts/game，仅做展示层映射，不重复定义契约。
 */

import type { Camp, EventType, GameStatus } from '@contracts/game'

export const CAMP_LABEL: Record<Camp, string> = {
  wolf: '狼人阵营',
  god: '神职',
  villager: '平民',
}

export const EVENT_TYPE_LABEL: Record<EventType, string> = {
  system: '系统',
  phase: '阶段',
  speech: '发言',
  action: '行动',
  vote: '投票',
  death: '死亡',
  result: '结果',
}

/**
 * 引擎阶段 id → 中文短名（事件流阶段 Badge 用）。
 * 事件的 phase 是引擎内部 id（如 "night.wolf"）；未命中映射时回退展示原始 id，
 * 以兼容引擎后续新增阶段。与后端 setPhase 的中文阶段名保持一致。
 */
export const PHASE_LABEL: Record<string, string> = {
  'game.init': '初始化',
  'game.start': '游戏开始',
  'game.over': '游戏结束',
  'night.start': '夜幕降临',
  'night.nightmare': '噩梦之影',
  'night.wolfThink': '狼队独立思考',
  'night.wolfDiscuss': '狼队讨论',
  'night.wolf': '狼人行动',
  'night.mechwolf': '机械狼模仿',
  'night.gargoyle': '石像鬼查验',
  'night.guard': '守卫守护',
  'night.dreamer': '摄梦人',
  'night.witch': '女巫行动',
  'night.seer': '预言家查验',
  'night.psychic': '通灵师查验',
  'night.demonhunter': '猎魔人狩猎',
  'night.crow': '乌鸦诽谤',
  'night.settle': '夜间结算',
  'day.start': '天亮',
  'day.dawn': '公布夜亡',
  'day.shoot': '开枪',
  'day.sheriff.run': '警长竞选报名',
  'day.sheriff.speech': '警上发言',
  'day.sheriff.withdraw': '退水环节',
  'day.sheriff.vote': '警徽投票',
  'day.sheriff.pk': '警上PK',
  'day.sheriffOrder': '警长定序',
  'day.skill': '主动技能窗口',
  'day.exileSkill': '技能发动询问',
  'day.speech': '白天发言',
  'day.vote': '放逐投票',
  'day.pk': '平票PK',
  'day.lastwords': '遗言',
  'postgame.discuss': '赛后讨论',
  system: '系统',
}

/** 阶段 id → 展示标签（未命中回退原始 id） */
export function phaseLabel(phase: string): string {
  return PHASE_LABEL[phase] ?? phase
}

/**
 * 事件标题 → 展示标签。
 * 后端 title 一般已是中文可直接展示，此处对必须保证有稳定标签的标题做显式映射：
 * - 「狼人频道」：狼队夜间私密讨论（meta.channel === "wolf"），仅观察者可见
 */
export const EVENT_TITLE_LABEL: Record<string, string> = {
  狼人频道: '狼人频道',
}

/** 事件标题 → 展示标签（未命中回退原标题） */
export function eventTitleLabel(title: string): string {
  return EVENT_TITLE_LABEL[title] ?? title
}

export const STATUS_LABEL: Record<GameStatus, string> = {
  created: '未启动',
  running: '运行中',
  paused: '已暂停',
  finished: '已结束',
}

/**
 * 状态展示标签：被手动终止的终局（finished 且无胜者）显示「已终止」，
 * 与自然结束（有胜负）区分；其余状态同 STATUS_LABEL。
 */
export function statusLabelOf(status: GameStatus, winner: 'wolf' | 'good' | null): string {
  if (status === 'finished' && winner === null) return '已终止'
  return STATUS_LABEL[status]
}

export function winnerLabel(winner: 'wolf' | 'good' | null): string {
  if (winner === 'wolf') return '狼人阵营胜利'
  if (winner === 'good') return '神民阵营胜利'
  return '—'
}

/** 对局总计时起点（点击「开始对局」的时刻）在 localStorage 的键 */
export function gameStartStorageKey(gameId: string): string {
  return `werewolf.gameStart.${gameId}`
}

/** 秒数 → 计时文本（mm:ss，超一小时 h:mm:ss） */
export function formatElapsed(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(sec).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

/** 距对局开始的经过时间标签（事件条目旁的小字数字时间）；无起点或时间非法返回 null */
export function elapsedLabel(t0: number | null | undefined, iso: string): string | null {
  if (t0 == null) return null
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  return formatElapsed((t - t0) / 1000)
}
