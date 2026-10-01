/**
 * 对局历史 /history —— 历史对局列表（本地桌面端不限数量，全量展示，点击进入回看）。
 * 入口在右上角导航（大厅右侧）；从大厅页迁出。
 */

import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { History as HistoryIcon, Loader2 } from 'lucide-react'
import type { GameSummary } from '@contracts/game'
import { statusLabelOf, winnerLabel } from '@/lib/gameLabels'
import { useGameApi } from '@/lib/gameApi'
import { useAuth } from '@/providers/auth'
import { cn, isUnauthorizedError } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

const STATUS_BADGE_VARIANT: Record<GameSummary['status'], 'default' | 'secondary' | 'outline'> = {
  created: 'outline',
  running: 'default',
  paused: 'secondary',
  finished: 'secondary',
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export default function History() {
  const navigate = useNavigate()
  const api = useGameApi()
  const { user } = useAuth()
  const userId = user?.id ?? null

  const [games, setGames] = useState<GameSummary[]>([])
  const [gamesLoading, setGamesLoading] = useState(true)
  const [gamesUnauthorized, setGamesUnauthorized] = useState(false)

  // 历史对局（game.list 需登录）：未登录/会话失效显示占位提示；登录态变化后自动重拉
  useEffect(() => {
    let cancelled = false
    setGamesLoading(true)
    api
      .listGames()
      .then((gs) => {
        if (cancelled) return
        setGames(gs)
        setGamesUnauthorized(false)
      })
      .catch((err) => {
        if (cancelled) return
        if (isUnauthorizedError(err)) {
          setGamesUnauthorized(true)
          setGames([])
        } else {
          setGames([])
        }
      })
      .finally(() => {
        if (!cancelled) setGamesLoading(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId])

  return (
    <div className="mx-auto max-w-[1600px] px-4 py-6 sm:px-8">
      <div className="mb-5 flex items-center gap-3">
        <HistoryIcon className="h-6 w-6 text-foreground" aria-hidden />
        <h1 className="text-xl font-semibold text-foreground">对局历史</h1>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">历史对局</CardTitle>
          <CardDescription>全部已保存对局（不限数量），点击进入回看</CardDescription>
        </CardHeader>
        <CardContent>
          {gamesUnauthorized ? (
            <div className="py-6 text-center">
              <p className="text-sm text-muted-foreground">登录后查看对局历史</p>
              <p className="mt-1 text-xs text-muted-foreground">
                点击右上角「登录 / 注册」，登录后自动加载
              </p>
            </div>
          ) : gamesLoading ? (
            <p className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              历史对局加载中…
            </p>
          ) : games.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              暂无历史对局，创建一局开始观察 AI 博弈
            </p>
          ) : (
            <div className="max-h-[72dvh] overflow-y-auto rounded-md border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>标题号</TableHead>
                    <TableHead>版型</TableHead>
                    <TableHead className="hidden sm:table-cell">时间</TableHead>
                    <TableHead>结果</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead className="text-right">天数</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {games.map((game) => (
                    <TableRow
                      key={game.id}
                      className="cursor-pointer"
                      onClick={() => navigate(`/game/${game.id}`)}
                    >
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {game.titleNo ? `#${game.titleNo}` : '—'}
                      </TableCell>
                      <TableCell className="whitespace-normal font-medium sm:whitespace-nowrap">
                        {game.boardName}
                      </TableCell>
                      <TableCell className="hidden font-mono text-sm text-muted-foreground sm:table-cell">
                        {formatTime(game.createdAt)}
                      </TableCell>
                      <TableCell>
                        {game.winner ? (
                          <span
                            className={cn(
                              'text-sm',
                              game.winner === 'wolf' ? 'text-wolf' : 'text-amber-600 dark:text-amber-400',
                            )}
                          >
                            {winnerLabel(game.winner)}
                          </span>
                        ) : (
                          <span className="text-sm text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            game.status === 'finished' && !game.winner
                              ? 'outline'
                              : STATUS_BADGE_VARIANT[game.status]
                          }
                        >
                          {statusLabelOf(game.status, game.winner)}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm">{game.dayCount}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
