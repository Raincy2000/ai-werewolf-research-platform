/**
 * MVP / SVP 评选（分析报告用，纯确定性规则评分，不依赖 AI 输出）：
 * - MVP：胜方阵营贡献最高分；SVP：败方阵营贡献最高分
 * - 评分因子全部来自对局事件与死因记录（放逐票型 / 技能成果 / 狼刀成果 / 存活），
 *   每个因子列出图标 + 理由 + 分值，并以小条形直观对比贡献构成
 */

import { memo, useMemo } from 'react'
import {
  Crosshair,
  Eye,
  Flame,
  FlaskConical,
  HeartPulse,
  Medal,
  MoonStar,
  Pill,
  ShieldCheck,
  Skull,
  Swords,
  Target,
  Trophy,
  Vote,
} from 'lucide-react'
import type { GameEvent, PlayerSnapshot } from '@contracts/game'
import { cn } from '@/lib/utils'

type FactorKind =
  | 'vote'   // 放逐票型
  | 'poison' // 女巫毒
  | 'shot'   // 开枪
  | 'duel'   // 骑士决斗
  | 'guard'  // 守卫守护
  | 'save'   // 女巫解药
  | 'dream'  // 摄梦
  | 'hunt'   // 猎魔人狩猎
  | 'seer'   // 预言家查验
  | 'knife'  // 狼刀成果
  | 'boom'   // 自爆/带人
  | 'down'   // 出局惩罚
  | 'alive'  // 存活至终局

const KIND_ICON: Record<FactorKind, typeof Vote> = {
  vote: Vote,
  poison: FlaskConical,
  shot: Crosshair,
  duel: Swords,
  guard: ShieldCheck,
  save: Pill,
  dream: MoonStar,
  hunt: Target,
  seer: Eye,
  knife: Skull,
  boom: Flame,
  down: Skull,
  alive: HeartPulse,
}

interface Factor {
  kind: FactorKind
  label: string
  pts: number
}

interface ScoreEntry {
  score: number
  factors: Factor[]
}

/** 逐事件 + 逐死因累计评分（确定性规则；正负分都记录为因子） */
function scorePlayers(
  events: GameEvent[],
  players: PlayerSnapshot[],
): Map<number, ScoreEntry> {
  const bySeat = new Map(players.map((p) => [p.seat, p]))
  const isWolf = (s: number) => bySeat.get(s)?.camp === 'wolf'
  const findRole = (name: string) => players.find((p) => p.roleName === name)?.seat ?? null
  const witch = findRole('女巫')
  const guard = findRole('守卫')
  const dreamer = findRole('摄梦人')
  const demonHunter = findRole('猎魔人')
  const knight = findRole('骑士')

  const acc = new Map<number, Factor[]>()
  const add = (seat: number | null, kind: FactorKind, label: string, pts: number) => {
    if (seat == null || !bySeat.has(seat)) return
    const list = acc.get(seat) ?? []
    list.push({ kind, label, pts })
    acc.set(seat, list)
  }

  // ---------- 事件驱动因子 ----------
  for (const e of events) {
    if (e.type === 'vote' && e.actor != null && e.title === '放逐投票') {
      const m = e.content.match(/投给(\d+)号/)
      if (m) {
        const t = Number(m[1])
        if (!bySeat.has(t)) continue
        if (!isWolf(e.actor) && isWolf(t)) add(e.actor, 'vote', `放逐投票投中 ${t} 号狼人`, 2)
        else if (isWolf(e.actor) && !isWolf(t)) add(e.actor, 'vote', `放逐投票推动放逐 ${t} 号好人`, 2)
      }
      continue
    }
    if (e.type !== 'action') continue
    switch (e.title) {
      case '守护成功': {
        const m = e.content.match(/(\d+)号玩家/)
        add(guard, 'guard', `守住狼刀${m ? `（${m[1]}号平安）` : ''}`, 3)
        break
      }
      case '解药生效': {
        const m = e.content.match(/(\d+)号玩家/)
        add(witch, 'save', `解药救下${m ? ` ${m[1]} 号` : '被刀者'}`, 3)
        break
      }
      case '摄梦保护': {
        const m = e.content.match(/(\d+)号玩家/)
        add(dreamer, 'dream', `摄梦保护${m ? ` ${m[1]} 号` : ''}免刀`, 3)
        break
      }
      case '狩猎成功':
        add(demonHunter, 'hunt', '狩猎命中狼人', 5)
        break
      case '狩猎失败':
        add(demonHunter, 'hunt', '狩猎误伤好人（自死）', -4)
        break
      case '预言家查验': {
        const m = e.content.match(/查验(\d+)号玩家，结果为【(狼人|好人)】/)
        if (m) {
          add(
            e.actor,
            'seer',
            m[2] === '狼人' ? `验出 ${m[1]} 号狼人` : `查验 ${m[1]} 号为好人`,
            m[2] === '狼人' ? 3 : 1,
          )
        }
        break
      }
      case '开枪': {
        const m = e.content.match(/带走了(\d+)号/)
        if (m && e.actor != null) {
          const t = Number(m[1])
          if (!bySeat.has(t)) break
          if (isWolf(e.actor)) {
            // 狼王开枪
            if (isWolf(t)) add(e.actor, 'shot', `开枪误带 ${t} 号队友`, -4)
            else add(e.actor, 'shot', `开枪带走 ${t} 号好人`, 4)
          } else {
            if (isWolf(t)) add(e.actor, 'shot', `开枪带走 ${t} 号狼人`, 4)
            else add(e.actor, 'shot', `开枪误伤 ${t} 号好人`, -4)
          }
        }
        break
      }
      case '狼人自爆':
        add(e.actor, 'boom', '自爆掩护狼队节奏', 1)
        break
      case '白狼王带人': {
        const m = e.content.match(/带走了(\d+)号/)
        if (m && e.actor != null) {
          const t = Number(m[1])
          if (!bySeat.has(t)) break
          if (isWolf(t)) add(e.actor, 'boom', `自爆误带 ${t} 号队友`, -4)
          else add(e.actor, 'boom', `自爆带走 ${t} 号好人`, 3)
        }
        break
      }
    }
  }

  // ---------- 死因驱动因子 ----------
  for (const p of players) {
    if (p.alive || !p.deathInfo) continue
    const d = p.deathInfo
    if (d.includes('被女巫毒杀')) {
      add(witch, 'poison', isWolf(p.seat) ? `毒杀 ${p.seat} 号狼人` : `误毒 ${p.seat} 号好人`, isWolf(p.seat) ? 5 : -4)
    }
    if (d.includes('决斗出局')) {
      add(knight, 'duel', isWolf(p.seat) ? `决斗处决 ${p.seat} 号狼人` : `决斗误判 ${p.seat} 号好人`, isWolf(p.seat) ? 6 : -6)
    }
    if (d.includes('摄梦致死')) {
      add(dreamer, 'dream', isWolf(p.seat) ? `摄梦致死 ${p.seat} 号狼人` : `摄梦误杀 ${p.seat} 号好人`, isWolf(p.seat) ? 4 : -3)
    }
    if (p.camp === 'wolf' && d.includes('被放逐')) {
      add(p.seat, 'down', '被放逐出局', -2)
    }
  }

  // ---------- 狼刀成果（含同守同救奶穿）：全体狼人按击杀数计 ----------
  const knifeDeaths = players.filter((p) => !p.alive && p.deathInfo?.includes('被狼人袭击')).length
  if (knifeDeaths > 0) {
    for (const p of players) {
      if (p.camp === 'wolf') add(p.seat, 'knife', `狼刀成果（本局 ${knifeDeaths} 人死于狼刀）`, knifeDeaths)
    }
  }

  // ---------- 存活至终局 ----------
  for (const p of players) {
    if (p.alive) add(p.seat, 'alive', '存活至终局', p.camp === 'wolf' ? 2 : 1)
  }

  const out = new Map<number, ScoreEntry>()
  for (const [seat, factors] of acc) {
    out.set(seat, { score: factors.reduce((a, f) => a + f.pts, 0), factors })
  }
  return out
}

interface PickResult {
  player: PlayerSnapshot
  score: number
  factors: Factor[]
}

function MvpCard({
  title,
  subtitle,
  pick,
  accent,
}: {
  title: string
  subtitle: string
  pick: PickResult
  /** MVP=琥珀（胜方荣耀），SVP=石板（败方虽败犹荣） */
  accent: 'amber' | 'slate'
}) {
  const Icon = accent === 'amber' ? Trophy : Medal
  const maxAbs = Math.max(1, ...pick.factors.map((f) => Math.abs(f.pts)))
  return (
    <div
      className={cn(
        'rounded-lg border p-3',
        accent === 'amber' ? 'border-amber-400/50 bg-amber-400/5' : 'border-slate-400/40 bg-slate-400/5',
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Icon className={cn('h-5 w-5', accent === 'amber' ? 'text-amber-500' : 'text-slate-400')} aria-hidden />
        <span className={cn('text-sm font-bold', accent === 'amber' ? 'text-amber-600 dark:text-amber-400' : 'text-slate-500 dark:text-slate-300')}>
          {title}
        </span>
        <span className="text-sm font-semibold text-foreground">
          {pick.player.seat}号 · {pick.player.roleName}
        </span>
        <span className="ml-auto font-mono text-xs text-muted-foreground">
          贡献分 {pick.score > 0 ? `+${pick.score}` : pick.score}
        </span>
      </div>
      <p className="mt-0.5 text-[11px] text-muted-foreground">{subtitle}</p>
      {pick.factors.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">无突出贡献记录</p>
      ) : (
        <ul className="mt-2 max-h-48 space-y-1.5 overflow-y-auto pr-1">
          {pick.factors.map((f, i) => {
            const FIcon = KIND_ICON[f.kind]
            return (
              <li key={i} className="flex items-center gap-1.5 text-xs">
                <FIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1 break-words text-foreground">{f.label}</span>
                <span
                  className={cn(
                    'shrink-0 font-mono text-[11px]',
                    f.pts >= 0 ? 'text-good dark:text-green-400' : 'text-wolf',
                  )}
                >
                  {f.pts > 0 ? `+${f.pts}` : f.pts}
                </span>
                <span className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-muted">
                  <span
                    className={cn('block h-full rounded-full', f.pts >= 0 ? 'bg-amber-400' : 'bg-wolf/70')}
                    style={{ width: `${(Math.abs(f.pts) / maxAbs) * 100}%` }}
                  />
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

export const MvpSvpPanels = memo(function MvpSvpPanels({
  events,
  players,
  winner,
}: {
  events: GameEvent[]
  players: PlayerSnapshot[]
  winner: 'wolf' | 'good' | null
}) {
  const picks = useMemo((): { mvp: PickResult; svp: PickResult } | null => {
    if (winner == null || players.length === 0) return null
    const scores = scorePlayers(events, players)
    const pick = (pred: (p: PlayerSnapshot) => boolean): PickResult | null => {
      const cands = players
        .filter(pred)
        .map((p) => ({ player: p, ...(scores.get(p.seat) ?? { score: 0, factors: [] }) }))
        .sort((a, b) => b.score - a.score || a.player.seat - b.player.seat)
      const top = cands[0]
      return top ? { player: top.player, score: top.score, factors: top.factors } : null
    }
    const isWinCamp = (p: PlayerSnapshot) => (winner === 'wolf' ? p.camp === 'wolf' : p.camp !== 'wolf')
    const mvp = pick(isWinCamp)
    const svp = pick((p) => !isWinCamp(p))
    return mvp && svp ? { mvp, svp } : null
  }, [events, players, winner])

  if (!picks) return null
  const winLabel = winner === 'wolf' ? '狼人阵营' : '神民阵营'
  const loseLabel = winner === 'wolf' ? '神民阵营' : '狼人阵营'
  return (
    <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
      <MvpCard
        title="MVP · 全场最佳"
        subtitle={`胜方（${winLabel}）贡献最高者；评分因子：放逐票型 / 技能成果 / 存活等`}
        pick={picks.mvp}
        accent="amber"
      />
      <MvpCard
        title="SVP · 虽败犹荣"
        subtitle={`败方（${loseLabel}）贡献最高者；同样的评分规则，败方阵营内的最佳表现`}
        pick={picks.svp}
        accent="slate"
      />
    </div>
  )
})
