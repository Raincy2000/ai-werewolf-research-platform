/**
 * 左栏：圆桌座位区（上帝视角全员身份亮明）。
 * 多状态圈显示机制（同一座位可叠加多个状态圈，越早出现的状态圈越靠内）：
 * - 用户选中查看：白色；思考：橙色；发言：蓝色；技能发动：黄色（狼人落刀投票也算）；
 *   上票：紫色；权衡：红色
 * - 座位内状态描述分段着色（如「思考/发言中」：思考/橙色、发言中蓝色，
 *   「/」与「中」跟随其前面状态文字的颜色）
 * - 出局原因：座位框右侧灰底白字竖向滚动条
 */

import { memo, useEffect, useRef, useState } from 'react'
import { SheriffBadge } from '@/components/icons/SheriffBadge'
import type { Camp, PlayerSnapshot } from '@contracts/game'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'

const CAMP_BADGE_CLASS: Record<Camp, string> = {
  wolf: 'border-wolf/50 bg-wolf/10 text-wolf',
  god: 'border-god/50 bg-god/10 text-god',
  villager: 'border-villager/50 bg-villager/10 text-villager',
}

/** 座位状态种类与配色（ring=状态圈颜色，text=状态文字颜色）
 * 权衡=技能发动前的思考（狼队独立思考、警长定序、白日主动技能权衡）；
 * 上票=暗票类选择（上警报名同为暗票机制，归入上票） */
type SeatStateKind = 'selected' | 'speech' | 'skillFire' | 'vote' | 'weigh' | 'study'

const STATE_META: Record<SeatStateKind, { label: string; ring: string; text: string }> = {
  selected: { label: '查看', ring: '#78716c', text: '#78716c' },
  speech: { label: '发言', ring: '#1e4b8f', text: '#1e4b8f' },
  skillFire: { label: '技能发动', ring: '#ca8a04', text: '#ca8a04' },
  vote: { label: '上票', ring: '#6d28a8', text: '#6d28a8' },
  weigh: { label: '权衡', ring: '#b3433a', text: '#b3433a' },
  // 赛前学习中（祖母绿）：图书馆对局的学习阶段，正在通读资料的座位
  study: { label: '学习', ring: '#059669', text: '#059669' },
}

/** 引擎待决类型 → 座位状态（狼人落刀 wolfKill 归入技能发动；夜间技能使用同归技能发动） */
function pendingKindToState(kind: string | null): SeatStateKind | null {
  switch (kind) {
    case 'study': // 赛前学习中（非引擎待决，由快照 studyingSeats 合成）
      return 'study'
    case 'wolfThink':
    case 'sheriffOrder':
    case 'sheriffWithdraw': // 退水抉择：权衡中状态环
    case 'daySkill':
    case 'exileSkill':
    case 'badgePass':
      return 'weigh'
    case 'sheriffRun':
    case 'sheriffVote':
    case 'dayVote':
      return 'vote'
    case 'wolfDiscuss':
    case 'sheriffSpeech':
    case 'pkSpeech':
    case 'daySpeech':
    case 'lastWords':
    case 'postgameSpeak': // 赛后讨论：正在发言的玩家同样应用「发言中」状态环
      return 'speech'
    case 'wolfKill':
    case 'nightmareFear':
    case 'seerCheck':
    case 'gargoyleCheck':
    case 'psychicCheck':
    case 'witchAction':
    case 'guardProtect':
    case 'dreamerDream':
    case 'demonHunterHunt':
    case 'crowCurse':
    case 'mechWolfMimic':
    case 'hunterShoot':
    case 'whiteWolfTake':
      return 'skillFire'
    default:
      return null
  }
}

interface SeatState {
  kind: SeatStateKind
  since: number
}

interface SeatGridProps {
  players: PlayerSnapshot[]
  /** 当前待决按座位展开（快照 pendingActs；合并批次中每座位类型可不同，如权衡+发言） */
  pendingActs: { seat: number; kind: string }[]
  /** 右栏当前选中的座位 */
  selectedSeat: number | null
  onSelect: (seat: number) => void
}

export const SeatGrid = memo(function SeatGrid({
  players,
  pendingActs,
  selectedSeat,
  onSelect,
}: SeatGridProps) {
  // 引擎状态（发言/技能发动/上票/权衡）按座位跟踪，since 保留首次出现时间
  const [engineStates, setEngineStates] = useState<ReadonlyMap<number, SeatState>>(new Map())
  const actsKey = pendingActs.map((a) => `${a.seat}:${a.kind}`).join(',')
  useEffect(() => {
    const now = Date.now()
    setEngineStates((prev) => {
      const next = new Map<number, SeatState>()
      for (const act of pendingActs) {
        const stateKind = pendingKindToState(act.kind)
        if (!stateKind) continue
        const p = prev.get(act.seat)
        next.set(act.seat, p && p.kind === stateKind ? p : { kind: stateKind, since: now })
      }
      return next
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actsKey])

  // 用户选中查看状态：点击瞬间记录出现时间（早于下一次渲染，保证内外排序正确）
  const selectedSinceRef = useRef(0)
  const handleSelect = (seat: number) => {
    selectedSinceRef.current = Date.now()
    onSelect(seat)
  }

  return (
    <div className="grid grid-cols-3 gap-2.5">
      {players.map((p) => {
        // 组装该座位的状态列表：越早出现的越靠内（inner → outer 按 since 升序）
        const states: SeatState[] = []
        const engine = engineStates.get(p.seat)
        if (engine) states.push(engine)
        if (selectedSeat === p.seat) states.push({ kind: 'selected', since: selectedSinceRef.current })
        states.sort((a, b) => a.since - b.since)

        return (
          <button
            key={p.seat}
            type="button"
            onClick={() => handleSelect(p.seat)}
            aria-pressed={selectedSeat === p.seat}
            title={p.alive ? `${p.seat}号 ${p.roleName}` : `${p.seat}号 ${p.roleName} · ${p.deathInfo ?? '已死亡'}`}
            className={cn(
              'relative flex items-stretch rounded-lg border bg-card text-center transition-colors',
              p.alive ? 'border-border' : 'border-border/60 opacity-60 grayscale',
            )}
          >
            {/* 多状态圈：内圈=最早出现的状态，逐圈向外扩散 */}
            {states.map((s, i) => (
              <span
                key={s.kind}
                aria-hidden
                className="pointer-events-none absolute rounded-lg border-2"
                style={{
                  inset: `${-2 - i * 3}px`,
                  borderColor: STATE_META[s.kind].ring,
                }}
              />
            ))}

            {/* 主内容列 */}
            <div className="flex min-w-0 flex-1 flex-col items-center gap-1.5 px-2 py-3">
              <span className="flex items-center gap-1">
                <span className="font-mono text-lg font-semibold leading-6 text-foreground">
                  {p.seat}
                </span>
                {p.sheriff ? (
                  <SheriffBadge className="h-4 w-4 text-god" aria-label="警长" />
                ) : p.sheriffCandidate ? (
                  // 上警竞选中（≥2 人才标记）：亮蓝警徽，与警长金色高区分度（警长落地/警徽流失/退水后消失）
                  <SheriffBadge className="h-4 w-4 text-sky-500" aria-label="上警竞选中" />
                ) : null}
              </span>

              <Badge variant="outline" className={cn('text-xs font-normal', CAMP_BADGE_CLASS[p.camp])}>
                {p.roleName}
              </Badge>

              {/* 人格研究库：该座位绑定的人格名（其一切言行由该人格驱动） */}
              {p.personaName ? (
                <span
                  className="max-w-full truncate rounded-full border border-purple-500/50 bg-purple-500/10 px-1.5 py-0.5 text-[10px] text-purple-600 dark:text-purple-300"
                  title={`人格：${p.personaName}`}
                >
                  {p.personaName}
                </span>
              ) : null}

              {/* 状态描述：分段着色（如「思考/发言中」——「/」与「中」跟随其前面状态文字的颜色） */}
              {states.length > 0 ? (
                <span className="text-[11px] font-medium leading-4">
                  {states.map((s, i) => {
                    const meta = STATE_META[s.kind]
                    const last = i === states.length - 1
                    return (
                      <span key={s.kind} style={{ color: meta.text }}>
                        {meta.label}
                        {last ? '中' : '/'}
                      </span>
                    )
                  })}
                </span>
              ) : (
                <span className="text-[11px] text-muted-foreground">
                  {p.alive ? '存活' : '出局'}
                </span>
              )}
            </div>

            {/* 出局原因：右侧灰底白字竖向滚动条 */}
            {!p.alive ? (
              // 灰色条右缘圆角 = 卡片圆角(8px) - 边框(1px)，完美贴合卡片的两个右侧圆角
              <div className="relative w-7 shrink-0 overflow-hidden rounded-r-[7px] bg-stone-500/80">
                <div className="seat-marquee absolute inset-x-0 top-0 flex flex-col items-center">
                  {[0, 1].map((k) => (
                    <span
                      key={k}
                      className="py-2 text-[10px] font-medium tracking-wider text-white [writing-mode:vertical-rl]"
                    >
                      {`${p.deathInfo ?? '死亡'} · ${p.deathInfo ?? '死亡'}`}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}
          </button>
        )
      })}
    </div>
  )
})
