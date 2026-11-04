/**
 * 关系补完弹窗（联网检索原世界关系网）
 *
 * 交互设计：
 *  · 补完范围二选一：全部人格 / 指定人格
 *  · 任务可并行：部分人格补完进行中，仍可继续发起新任务
 *  · 但「全部人格」任务在跑时，禁止再发起（避免资源冲突）
 *  · 进度视图：每张任务卡独立「暂停 / 继续 / 终止 / 重试 / 关闭」
 *  · 打开弹窗时通过 getJobs 恢复后台任务现场；关闭弹窗即停止轮询（P1-18/P2-16）
 *  · 成功汇总显示后端真实 written/webSearched（P1-16）；失败显示原因 + 重试
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Loader2, Pause, Play, RotateCcw, Square, X } from 'lucide-react'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import type { CompletionStats } from '@/lib/gameApi'

export interface CompletionCard {
  id: number
  name: string
}

export interface CompletionProgress {
  phase?: string
  total?: number
  done?: number
  current?: string
  written?: number
  webSearched?: number
  corrected?: number
  generated?: number
  verified?: number
  rejected?: number
  log?: string[]
  /** 后置现实层补完队列进度（edges 写完后仍在跑；2026-10-22） */
  backfill?: { done: number; total: number }
}

/** getJobs 返回的后台任务（network.listCompletionJobs） */
export interface ExistingCompletionJob {
  id: number
  status: string
  scope?: string | null
  total?: number | null
  personaIds?: number[] | null
  /** resume 自恢复用的 API 存档 id（后端 job.scope.apiPresetId） */
  apiPresetId?: number | null
  progress?: CompletionProgress | null
  stats?: CompletionStats | null
  error?: string | null
}

export interface RunningJob {
  jobId: number
  scope: 'all' | 'partial'
  total: number
  names: string[]
  personaIds: number[]
  status: string
  progress: CompletionProgress | null
  stats: CompletionStats | null
  error: string | null
  /** 重试所需入参 */
  apiPresetId: number
  apiName: string
}

export interface RelationCompletionDialogProps {
  open: boolean
  onOpenChange: (v: boolean) => void
  presets: Array<{ id: number; name: string; provider: string }>
  allCards: CompletionCard[];
  /** 启动补完任务 */
  onStart: (input: { apiPresetId: number; personaIds?: number[] }) => Promise<{ jobId?: number; error?: string }>;
  /** 查询任务状态 */
  getStatus: (jobId: number) => Promise<{
    status?: string
    progress?: CompletionProgress | null
    stats?: CompletionStats | null
    error?: string | null
  } | null>;
  /** 打开弹窗时恢复全部后台任务（可选；后端 listCompletionJobs） */
  getJobs?: () => Promise<ExistingCompletionJob[]>;
  /** 暂停任务（保留进度）*/
  onPause?: (jobId: number) => Promise<void>;
  /** 继续已暂停的任务（network.resumeCompletion） */
  onResume?: (jobId: number) => Promise<void>;
  /** 终止任务（不可恢复）*/
  onCancel?: (jobId: number) => Promise<void>;
  /** 任一任务结束时回调（用于刷新图）*/
  onFinished?: () => void;
  providerLabel?: Record<string, string>;
}

/** 终态：这些状态不再轮询 */
const TERMINAL = new Set(['applied', 'failed', 'cancelled'])

function pctOf(p: CompletionProgress | null): number {
  if (!p || !p.total) return 0
  return Math.round(((p.done ?? 0) / p.total) * 100)
}

function statusText(status: string): string {
  if (status === 'applied') return '已完成'
  if (status === 'failed') return '已失败'
  if (status === 'cancelled') return '已终止'
  if (status === 'paused') return '已暂停'
  if (status === 'queued' || status === 'pending') return '排队中'
  return '进行中'
}

/** applied 但后置现实层补完还在跑：仍需轮询（否则详情页永远等不到新事件） */
function pendingBackfillOf(j: Pick<RunningJob, 'status' | 'progress'>): boolean {
  const b = j.progress?.backfill
  return (
    j.status === 'applied' &&
    b != null &&
    typeof b.done === 'number' &&
    typeof b.total === 'number' &&
    b.done < b.total
  )
}

function jobNames(job: Pick<RunningJob, 'names' | 'personaIds' | 'scope' | 'total'>, allCards: CompletionCard[]): string {
  const names = job.names.length > 0
    ? job.names
    : job.personaIds
        .map((id) => allCards.find((c) => c.id === id)?.name)
        .filter((n): n is string => !!n)
  if (names.length === 0) {
    return job.scope === 'all' ? '全部 ' + job.total + ' 个人格' : '指定 ' + (job.total || job.personaIds.length) + ' 个人格'
  }
  const head = names.slice(0, 3).join('、')
  return head + (names.length > 3 ? ' 等 ' + names.length + ' 人' : '')
}

/** 真实写入/联网统计：优先 job.stats（后端修复后），回退 progress 字段 */
function summaryOf(job: RunningJob): string {
  const written = job.stats?.written ?? job.progress?.written ?? 0
  const web = job.stats?.webSearched ?? job.progress?.webSearched ?? 0
  const parts = ['写入 ' + written + ' 条', '联网成功 ' + web + ' 个']
  if (job.stats?.corrected != null) parts.push('修正 ' + job.stats.corrected + ' 条')
  const b = job.progress?.backfill
  if (b && typeof b.done === 'number' && typeof b.total === 'number') {
    parts.push('现实层补完 ' + b.done + '/' + b.total)
  }
  return '补完结束：' + parts.join(' · ')
}

function failureReasonOf(job: RunningJob): string {
  const reason = job.error ?? job.stats?.reason ?? job.progress?.log?.slice(-1)[0] ?? '未知原因'
  if (reason === 'stale') return '应用重启或任务中断，已自动收尾（可重试）'
  return reason
}

export function RelationCompletionDialog(props: RelationCompletionDialogProps) {
  const {
    open, onOpenChange, presets, allCards, onStart, getStatus, getJobs,
    onPause, onResume, onCancel, onFinished,
    providerLabel = {},
  } = props

  const [pickedPreset, setPickedPreset] = useState<number | null>(null)
  const [scopeMode, setScopeMode] = useState<'all' | 'partial'>('all')
  const [pickedIds, setPickedIds] = useState<number[]>([])
  const [panelView, setPanelView] = useState<'launch' | 'progress'>('launch')
  const [runningJobs, setRunningJobs] = useState<RunningJob[]>([])
  const [result, setResult] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [restoring, setRestoring] = useState(false)
  /** 单卡操作中（防止双击 / 并发操作同一任务） */
  const [busyJobs, setBusyJobs] = useState<Set<number>>(new Set())

  const jobsRef = useRef<RunningJob[]>([])
  useEffect(() => { jobsRef.current = runningJobs }, [runningJobs])
  /** 已完成任务的回调去重（每个 job 只 onFinished 一次；applied+后置补完时先通知一次、补完再通知一次） */
  const finishedNotifiedRef = useRef<Set<number>>(new Set())
  /** applied 但后置补完未完成 → 先通知详情页一次（边已写入），补完完成后再通知一次 */
  const appliedNotifiedRef = useRef<Set<number>>(new Set())
  /** applied 且后置补完进度长时间不变（应用中断）→ 5 分钟后不再等 */
  const backfillSeenRef = useRef<Map<number, { sig: string; at: number }>>(new Map())

  function pendingBackfill(j: RunningJob): boolean {
    if (!pendingBackfillOf(j)) {
      backfillSeenRef.current.delete(j.jobId)
      return false
    }
    const b = j.progress?.backfill
    const sig = `${b?.done ?? 0}/${b?.total ?? 0}`
    const prev = backfillSeenRef.current.get(j.jobId)
    const now = Date.now()
    if (!prev || prev.sig !== sig) {
      backfillSeenRef.current.set(j.jobId, { sig, at: now })
      return true
    }
    // 5 分钟无变化：认为后置队列已中断（job 已是 applied 终态，不能无限转圈）
    return now - prev.at < 5 * 60_000
  }

  /** 本地 settled 判定：含 applied 后置补完 + 5 分钟中断超时 */
  function isSettledLocal(j: RunningJob): boolean {
    return TERMINAL.has(j.status) && !pendingBackfill(j)
  }

  /** 有「全部人格」任务在跑 → 禁止再起新任务 */
  const hasAllJob = runningJobs.some(
    (j) => j.scope === 'all' && !isSettledLocal(j),
  )
  const activeJobs = runningJobs.filter(
    (j) => !isSettledLocal(j) && j.status !== 'paused',
  )

  /** 用户要求：完成/终止/失败的任务立即从进度列表消失，不再堆成一堆“进程” */
  const visibleJobs = runningJobs.filter((j) => !TERMINAL.has(j.status))

  /** 已终态的任务（含 applied 但后置补完已结束）自动从本地状态清掉；applied+补完中保留在后台轮询但不渲染 */
  useEffect(() => {
    const kept = runningJobs.filter((j) => !isSettledLocal(j))
    if (kept.length !== runningJobs.length) setRunningJobs(kept)
  }, [runningJobs])

  /** 没有可见任务时，进度页自动回到发起页，避免停在空列表 */
  useEffect(() => {
    if (!restoring && visibleJobs.length === 0 && panelView === 'progress') setPanelView('launch')
  }, [restoring, visibleJobs.length, panelView])

  /** 发起条件：选了 API + 范围合法（指定模式至少 2 人）+ 没有全部任务在跑 */
  const canStart =
    !!pickedPreset &&
    !hasAllJob &&
    (scopeMode === 'all' ? allCards.length >= 2 : pickedIds.length >= 2)

  const presetName = (id: number) => presets.find((p) => p.id === id)?.name ?? '#' + id

  /** 打开时：恢复后台任务 + 切到进度视图（若有）；保留本地任务列表，关窗不丢 */
  const prevOpen = useRef(false)
  useEffect(() => {
    if (!(open && !prevOpen.current)) { prevOpen.current = open; return }
    prevOpen.current = open
    setResult(null)
    setRestoring(true)
    void (async () => {
      try {
        const jobs = getJobs ? await getJobs() : []
        if (jobs.length > 0) {
          const restored: RunningJob[] = jobs
            .filter((j) => Number.isFinite(j.id))
            .map((j) => {
              const personaIds = j.personaIds ?? []
              const scope: 'all' | 'partial' = j.scope === 'partial' || personaIds.length > 0 ? 'partial' : 'all'
              return {
                jobId: j.id,
                scope,
                total: j.total ?? j.progress?.total ?? (personaIds.length > 0 ? personaIds.length : allCards.length),
                names: personaIds
                  .map((id) => allCards.find((c) => c.id === id)?.name)
                  .filter((n): n is string => !!n),
                personaIds,
                status: j.status,
                progress: j.progress ?? null,
                stats: j.stats ?? null,
                error: j.error ?? null,
                apiPresetId: typeof j.apiPresetId === 'number' ? j.apiPresetId : 0,
                apiName: typeof j.apiPresetId === 'number' && j.apiPresetId > 0 ? presetName(j.apiPresetId) : '（恢复的任务）',
              }
            })
          // 与本地任务合并：后端状态为准；本地发起时知道的 API 名称作为补充（恢复任务后端只带 presetId）
          setRunningJobs((prev) => {
            const byId = new Map<number, RunningJob>()
            for (const j of prev) byId.set(j.jobId, j)
            for (const j of restored) {
              const local = byId.get(j.jobId)
              byId.set(j.jobId, {
                ...j,
                apiPresetId: j.apiPresetId || local?.apiPresetId || 0,
                apiName: j.apiPresetId > 0 ? j.apiName : (local?.apiName ?? j.apiName),
              })
            }
            return [...byId.values()]
          })
          setPanelView('progress')
        } else {
          setPanelView(runningJobs.length > 0 ? 'progress' : 'launch')
        }
      } catch {
        setPanelView(runningJobs.length > 0 ? 'progress' : 'launch')
      } finally {
        setRestoring(false)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  /** 轮询：单 effect；任务结束/全部暂停/卸载停止。
   *  ★ 不依赖 open：用户关闭进度弹窗去详情页等待时，后台仍要继续轮询并触发 onFinished（否则详情页不会自动刷新）。 */
  const activeSig = activeJobs.map((j) => j.jobId).join(',')
  useEffect(() => {
    if (activeSig === '') return
    let stopped = false
    const poll = async () => {
      const current = jobsRef.current.filter((j) => !isSettledLocal(j) && j.status !== 'paused')
      if (current.length === 0) return
      const next = await Promise.all(
        current.map(async (j) => {
          try {
            const st = await getStatus(j.jobId)
            if (!st) return j
            return {
              ...j,
              status: st.status ?? j.status,
              progress: st.progress ?? j.progress ?? null,
              stats: st.stats ?? j.stats ?? null,
              error: st.error ?? st.progress?.log?.slice(-1)[0] ?? j.error ?? null,
            } satisfies RunningJob
          } catch {
            return j
          }
        }),
      )
      if (stopped) return
      // 与最新状态合并（期间可能有新任务加入或被手动更新）
      setRunningJobs((prev) => {
        const byId = new Map(prev.map((j) => [j.jobId, j]))
        for (const j of next) byId.set(j.jobId, j)
        return [...byId.values()]
      })
      // applied 但后置现实层补完在跑：先通知一次（边已落库），补完完成后再通知一次
      for (const j of next) {
        if (j.status === 'applied' && pendingBackfill(j) && !appliedNotifiedRef.current.has(j.jobId)) {
          appliedNotifiedRef.current.add(j.jobId)
          await Promise.resolve(onFinished?.())
        }
      }
      // 真正 settled（含后置补完完成 / 判定中断超时）才标记完成
      let justSettled = false
      for (const j of next) {
        if (isSettledLocal(j) && !finishedNotifiedRef.current.has(j.jobId)) {
          finishedNotifiedRef.current.add(j.jobId)
          justSettled = true
        }
      }
      if (justSettled) await Promise.resolve(onFinished?.())
    }
    void poll()
    const timer = setInterval(() => { void poll() }, 1200)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [activeSig, getStatus, onFinished])

  /** 单卡操作加锁 */
  const withBusyJob = useCallback(async (jobId: number, fn: () => Promise<void>) => {
    if (busyJobs.has(jobId)) return
    setBusyJobs((prev) => new Set(prev).add(jobId))
    try {
      await fn()
    } finally {
      setBusyJobs((prev) => {
        const next = new Set(prev)
        next.delete(jobId)
        return next
      })
    }
  }, [busyJobs])

  const updateJob = (jobId: number, patch: Partial<RunningJob>) => {
    setRunningJobs((prev) => prev.map((j) => (j.jobId === jobId ? { ...j, ...patch } : j)))
  }

  const start = async () => {
    if (!pickedPreset) { setResult('请先选择存档中的 API。'); return }
    const isAll = scopeMode === 'all'
    const ids = isAll ? allCards.map((c) => c.id) : pickedIds
    if (!isAll && ids.length < 2) { setResult('指定人格至少选 2 个。'); return }
    setResult(null)
    setStarting(true)
    try {
      const r = await onStart({ apiPresetId: pickedPreset, personaIds: isAll ? undefined : ids })
      if (r.error) { setResult(r.error); return }
      if (r.jobId) {
        setRunningJobs((prev) => [
          ...prev,
          {
            jobId: r.jobId!,
            scope: isAll ? 'all' : 'partial',
            total: ids.length,
            names: isAll ? [] : allCards.filter((c) => ids.includes(c.id)).map((c) => c.name),
            personaIds: isAll ? [] : ids,
            status: 'running',
            progress: { phase: 'init', total: ids.length, done: 0 },
            stats: null,
            error: null,
            apiPresetId: pickedPreset,
            apiName: presetName(pickedPreset),
          },
        ])
        setPanelView('progress')
      }
    } catch (e) {
      setResult('启动失败：' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setStarting(false)
    }
  }

  const pauseJob = (job: RunningJob) => withBusyJob(job.jobId, async () => {
    try {
      await onPause?.(job.jobId)
      updateJob(job.jobId, { status: 'paused' })
    } catch (e) {
      updateJob(job.jobId, { error: '暂停失败：' + (e instanceof Error ? e.message : String(e)) })
    }
  })

  const resumeJob = (job: RunningJob) => withBusyJob(job.jobId, async () => {
    try {
      await onResume?.(job.jobId)
      updateJob(job.jobId, { status: 'running', error: null })
    } catch (e) {
      updateJob(job.jobId, { error: '继续失败：' + (e instanceof Error ? e.message : String(e)) })
    }
  })

  const cancelJob = (job: RunningJob) => withBusyJob(job.jobId, async () => {
    try {
      await onCancel?.(job.jobId)
      updateJob(job.jobId, { status: 'cancelled' })
    } catch (e) {
      updateJob(job.jobId, { error: '终止失败：' + (e instanceof Error ? e.message : String(e)) })
    }
  })

  /** 失败重试：用原 API/范围重新发起一个任务 */
  const retryJob = (job: RunningJob) => withBusyJob(job.jobId, async () => {
    if (!job.apiPresetId) {
      updateJob(job.jobId, { error: '该任务来自后台恢复，缺少 API 参数，请重新发起补完' })
      return
    }
    try {
      const r = await onStart({
        apiPresetId: job.apiPresetId,
        personaIds: job.scope === 'partial' ? job.personaIds : undefined,
      })
      if (r.error) { updateJob(job.jobId, { error: r.error }); return }
      if (r.jobId) {
        setRunningJobs((prev) =>
          prev.map((j) =>
            j.jobId === job.jobId
              ? {
                  ...j,
                  jobId: r.jobId!,
                  status: 'running',
                  progress: { phase: 'init', total: j.total, done: 0 },
                  stats: null,
                  error: null,
                }
              : j,
          ),
        )
      }
    } catch (e) {
      updateJob(job.jobId, { error: '重试失败：' + (e instanceof Error ? e.message : String(e)) })
    }
  })

  const dismissJob = (jobId: number) => {
    setRunningJobs((prev) => prev.filter((j) => j.jobId !== jobId))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>关系补完 · 联网检索原世界关系网</DialogTitle>
          <DialogDescription>
            用所选 API 联网检索人格在原作中的真实人际关系与关键事件，写入原世界层。
          </DialogDescription>
        </DialogHeader>

        {visibleJobs.length > 0 ? (
          <div className="flex gap-0.5 rounded-md border border-border/70 bg-accent/20 p-0.5">
            {(['launch', 'progress'] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setPanelView(v)}
                className={cn(
                  'flex-1 rounded px-2 py-1 text-[11px] transition-colors',
                  panelView === v
                    ? 'bg-background font-medium text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {v === 'launch' ? '发起补完' : '生成进度（' + visibleJobs.length + '）'}
              </button>
            ))}
          </div>
        ) : null}

        {panelView === 'launch' ? (
          <div className="space-y-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                选择存档中的 API <span className="text-wolf">（必选）</span>
              </label>
              <Select
                value={pickedPreset != null ? String(pickedPreset) : ''}
                onValueChange={(v) => setPickedPreset(v ? Number(v) : null)}
                disabled={hasAllJob}
              >
                <SelectTrigger className="h-9 w-full">
                  <SelectValue placeholder="从存档导入" />
                </SelectTrigger>
                <SelectContent>
                  {presets.length === 0 ? (
                    <SelectItem value="__none__" disabled>暂无存档</SelectItem>
                  ) : (
                    presets.map((p) => (
                      <SelectItem key={p.id} value={String(p.id)}>
                        {p.name}
                        <span className="ml-1.5 text-[10px] text-muted-foreground">
                          {providerLabel[p.provider] ?? p.provider}
                        </span>
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
              {pickedPreset != null ? (
                <p className="mt-1 text-[11px] text-muted-foreground">
                  当前 API：<span className="font-medium text-foreground">{presetName(pickedPreset)}</span>
                </p>
              ) : null}
              {presets.length === 0 ? (
                <p className="mt-1 text-[11px] text-wolf">
                  没有存档 API：请先到对局页的 AI 设置里保存一个。
                </p>
              ) : null}
            </div>

            <div>
              <div className="mb-1 text-xs font-medium text-muted-foreground">补完范围</div>
              <div className="space-y-1.5">
                <label
                  className={cn(
                    'flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 transition-colors',
                    scopeMode === 'all' ? 'border-god/60 bg-god/10' : 'border-border hover:bg-accent/30',
                    hasAllJob && 'cursor-not-allowed opacity-50',
                  )}
                >
                  <input
                    type="radio" name="scope" className="mt-0.5"
                    checked={scopeMode === 'all'}
                    onChange={() => setScopeMode('all')}
                    disabled={hasAllJob}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs text-foreground">全部 {allCards.length} 个人格</span>
                    <span className="mt-0.5 block text-[10px] text-muted-foreground">
                      一次性补完全站原世界关系；耗时较长，期间不可再发起新任务
                    </span>
                  </span>
                </label>
                <label
                  className={cn(
                    'flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 transition-colors',
                    scopeMode === 'partial' ? 'border-god/60 bg-god/10' : 'border-border hover:bg-accent/30',
                    hasAllJob && 'cursor-not-allowed opacity-50',
                  )}
                >
                  <input
                    type="radio" name="scope" className="mt-0.5"
                    checked={scopeMode === 'partial'}
                    onChange={() => setScopeMode('partial')}
                    disabled={hasAllJob}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs text-foreground">指定人格</span>
                    <span className="mt-0.5 block text-[10px] text-muted-foreground">
                      只补这几个人；可与其它任务并行
                    </span>
                  </span>
                </label>
              </div>
            </div>

            {scopeMode === 'partial' ? (
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <label className="text-xs font-medium text-muted-foreground">
                    选择人格（已选 {pickedIds.length}）
                  </label>
                  {pickedIds.length > 0 ? (
                    <button type="button" className="text-[11px] text-muted-foreground underline"
                      onClick={() => setPickedIds([])} disabled={hasAllJob}>清空</button>
                  ) : null}
                </div>
                <div className="max-h-32 overflow-y-auto rounded-md border border-border p-2">
                  {allCards.map((c) => {
                    const on = pickedIds.includes(c.id)
                    return (
                      <label key={c.id} className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-xs hover:bg-accent/40">
                        <input type="checkbox" checked={on} disabled={hasAllJob}
                          onChange={(e) =>
                            setPickedIds((prev) => (e.target.checked ? [...prev, c.id] : prev.filter((x) => x !== c.id)))}
                        />
                        <span className="truncate">{c.name}</span>
                      </label>
                    )
                  })}
                  {allCards.length === 0 ? <p className="text-xs text-muted-foreground">暂无可用人格</p> : null}
                </div>
              </div>
            ) : null}

            {result ? (
              <p className="whitespace-pre-wrap rounded-md border border-border bg-accent/40 px-3 py-2 text-xs">{result}</p>
            ) : null}
          </div>
        ) : (
          <div className="max-h-[52vh] space-y-2 overflow-y-auto pr-0.5">
            {restoring && visibleJobs.length === 0 ? (
              <p className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> 正在恢复后台任务…
              </p>
            ) : null}
            {visibleJobs.map((j) => {
              const p = j.progress
              const percent = pctOf(p)
              const pendingBackfillJob = pendingBackfill(j)
              const backfillProgress = p?.backfill
              const backfillInProgress = !!backfillProgress && backfillProgress.done < backfillProgress.total
              const done = TERMINAL.has(j.status)
              const paused = j.status === 'paused'
              const failed = j.status === 'failed'
              const busy = busyJobs.has(j.jobId)
              return (
                <div key={j.jobId} className="space-y-1.5 rounded-md border border-border bg-accent/20 p-2.5">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="flex min-w-0 items-center gap-1.5 font-medium">
                      <span className={cn(
                        'h-1.5 w-1.5 shrink-0 rounded-full',
                        done
                          ? j.status === 'applied' ? 'bg-good' : j.status === 'cancelled' ? 'bg-muted-foreground' : 'bg-wolf'
                          : paused ? 'bg-amber-500' : 'animate-pulse bg-god',
                      )} />
                      <span className="truncate">{jobNames(j, allCards)}</span>
                    </span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      {(p?.done ?? 0)}/{(p?.total ?? j.total)} · {percent}%
                    </span>
                  </div>
                  <div
                    className="h-1.5 overflow-hidden rounded-full bg-muted"
                    role="progressbar"
                    aria-label={'任务 ' + j.jobId + ' 进度'}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={percent}
                  >
                    <div
                      className={cn('h-full transition-all', failed ? 'bg-wolf' : j.status === 'cancelled' ? 'bg-muted-foreground' : 'bg-god')}
                      style={{ width: percent + '%' }}
                    />
                  </div>
                  {p?.current && !done ? (
                    <div className="truncate text-[11px] text-muted-foreground">正在检索「{p.current}」</div>
                  ) : null}
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
                    <span>已写入 {j.stats?.written ?? p?.written ?? 0} 条</span>
                    <span>联网成功 {j.stats?.webSearched ?? p?.webSearched ?? 0} 个</span>
                    <span>API：{j.apiName}</span>
                    <span className={cn('ml-auto font-medium', failed ? 'text-wolf' : paused ? 'text-amber-600' : '')}>
                      {backfillInProgress
                        ? `现实层补完中（${backfillProgress!.done}/${backfillProgress!.total}）`
                        : pendingBackfillJob
                          ? '已完成（现实层补完中…）'
                          : statusText(j.status)}
                    </span>
                  </div>
                  {j.status === 'applied' ? (
                    <p className="rounded bg-background/60 px-1.5 py-1 text-[10px] text-foreground/80">{summaryOf(j)}</p>
                  ) : null}
                  {failed ? (
                    <p className="flex items-start gap-1 rounded bg-wolf/5 px-1.5 py-1 text-[10px] text-wolf">
                      <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
                      失败原因：{failureReasonOf(j)}
                    </p>
                  ) : null}
                  {j.error && !failed && done === false ? (
                    <p className="text-[10px] text-amber-600">{j.error}</p>
                  ) : null}
                  {p?.log && p.log.length > 0 ? (
                    <div className="max-h-20 overflow-y-auto rounded bg-background/60 p-1.5 text-[10px] leading-relaxed text-muted-foreground">
                      {p.log.map((l, k) => <div key={k}>· {l}</div>)}
                    </div>
                  ) : null}

                  {/* 每张任务卡独立操作（P1-16） */}
                  <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                    {!done && !paused ? (
                      <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]"
                        disabled={busy} onClick={() => void pauseJob(j)}>
                        <Pause className="mr-1 h-3 w-3" /> 暂停
                      </Button>
                    ) : null}
                    {paused ? (
                      <Button size="sm" className="h-6 px-2 text-[10px]" disabled={busy} onClick={() => void resumeJob(j)}>
                        <Play className="mr-1 h-3 w-3" /> 继续
                      </Button>
                    ) : null}
                    {!done ? (
                      <Button size="sm" variant="destructive" className="h-6 px-2 text-[10px]"
                        disabled={busy} onClick={() => void cancelJob(j)}>
                        <Square className="mr-1 h-3 w-3" /> 终止
                      </Button>
                    ) : null}
                    {failed ? (
                      <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]"
                        disabled={busy} onClick={() => void retryJob(j)}>
                        <RotateCcw className="mr-1 h-3 w-3" /> 重试
                      </Button>
                    ) : null}
                    {done ? (
                      <Button size="sm" variant="ghost" className="h-6 px-2 text-[10px]"
                        disabled={busy} onClick={() => dismissJob(j.jobId)}>
                        <X className="mr-1 h-3 w-3" /> 关闭
                      </Button>
                    ) : null}
                    {busy ? <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" aria-hidden /> : null}
                  </div>
                </div>
              )
            })}
            {visibleJobs.length === 0 && !restoring ? (
              <p className="py-6 text-center text-xs text-muted-foreground">暂无进行中的补完任务</p>
            ) : null}
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-2">
          {panelView === 'launch' ? (
            <Button
              className={cn(
                'w-full',
                !canStart && 'cursor-not-allowed bg-good/20 text-muted-foreground hover:bg-good/20',
              )}
              onClick={() => void start()}
              disabled={!canStart || starting}
            >
              {starting ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
              {hasAllJob
                ? '全部人格补完中…'
                : scopeMode === 'partial' && pickedIds.length < 2
                  ? '发起补完（至少选 2 个人格）'
                  : '发起补完'}
            </Button>
          ) : (
            <Button variant="ghost" className="ml-auto" onClick={() => onOpenChange(false)}>
              关闭
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
