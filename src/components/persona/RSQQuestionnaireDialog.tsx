/**
 * RSQ 关系测评问卷填写弹窗（审计 P1-3 / P1-12：把「可填可看」闭环补上）
 *
 * 流程：
 *   1. 选电池级别（L 完整 / M 标准 / S 精简）；
 *   2. 按级别拉取题库（network.rsqItems）→ 按模块分组分页；
 *   3. 1–7 计分题逐题作答，110/111 开放题与第 120 题一句话自评选填；
 *   4. 进度条 + 校验（必答题未答不允许提交，自动跳到第一个缺口）；
 *   5. 组装 raw / feedback / selfSummary → network.submitRSQ；
 *   6. 成功/失败都有明确反馈（失败可重试）。
 *
 * 题库与提交均通过 props 注入，组件本身零后端依赖（preview / 测试可注入 mock）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, Loader2, Send } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import {
  RSQ_LEVEL_META,
  RSQ_SELF_SUMMARY_NO,
  buildRsqSubmitPayload,
  emptyAnswerState,
  isOpenItem,
  pageOfItem,
  paginateRsqItems,
  validateRsqAnswers,
  type RsqAnswerState,
  type RsqBatteryLevel,
  type RsqItemView,
  type RsqItemsView,
  type RsqSubmitPayload,
} from '@/lib/rsqClient'

const LEVELS: RsqBatteryLevel[] = ['L', 'M', 'S']
const PAGE_SIZE = 10

export interface RSQQuestionnaireDialogProps {
  open: boolean
  onOpenChange: (v: boolean) => void
  fromPersonaId: number
  toPersonaId: number
  fromName: string
  toName: string
  /** 拉取某级别题库（network.rsqItems） */
  loadItems: (level: RsqBatteryLevel) => Promise<RsqItemsView>
  /** 提交答卷（network.submitRSQ） */
  onSubmit: (payload: RsqSubmitPayload) => Promise<{ id: number }>
  /** 提交成功回调（上层刷新面板/报告） */
  onSubmitted?: (result: { id: number }) => void
}

export function RSQQuestionnaireDialog(props: RSQQuestionnaireDialogProps) {
  const {
    open, onOpenChange, fromPersonaId, toPersonaId, fromName, toName,
    loadItems, onSubmit, onSubmitted,
  } = props

  const [level, setLevel] = useState<RsqBatteryLevel>('L')
  const [itemsView, setItemsView] = useState<RsqItemsView | null>(null)
  const [answers, setAnswers] = useState<RsqAnswerState>(emptyAnswerState)
  const [pageIndex, setPageIndex] = useState(0)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [savedId, setSavedId] = useState<number | null>(null)

  // 每次打开重置现场
  useEffect(() => {
    if (!open) return
    setItemsView(null)
    setAnswers(emptyAnswerState())
    setPageIndex(0)
    setLoadError(null)
    setSubmitError(null)
    setSubmitting(false)
    setSavedId(null)
  }, [open])

  const items: RsqItemView[] = useMemo(() => itemsView?.items ?? [], [itemsView])
  const pages = useMemo(() => paginateRsqItems(items, PAGE_SIZE), [items])
  const validation = useMemo(() => validateRsqAnswers(items, answers), [items, answers])
  const page = pages[Math.min(pageIndex, Math.max(0, pages.length - 1))] ?? null
  const progressPct = validation.total === 0 ? 0 : Math.round((validation.answered / validation.total) * 100)

  const load = useCallback(async (lv: RsqBatteryLevel) => {
    setLoading(true)
    setLoadError(null)
    try {
      const view = await loadItems(lv)
      if (view.items.length === 0) {
        setLoadError('题库为空（后端未返回题目），请检查 API 是否已实现 network.rsqItems。')
        setItemsView(null)
        return
      }
      setItemsView(view)
      setAnswers(emptyAnswerState())
      setPageIndex(0)
    } catch (e) {
      setLoadError('题库加载失败：' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setLoading(false)
    }
  }, [loadItems])

  const start = (lv: RsqBatteryLevel) => {
    setLevel(lv)
    void load(lv)
  }

  const setLikert = (no: number, value: number) => {
    setAnswers((prev) => ({ ...prev, likert: { ...prev.likert, [no]: value } }))
  }

  const setOpenText = (no: number, text: string) => {
    setAnswers((prev) => ({ ...prev, open: { ...prev.open, [no]: text } }))
  }

  const submit = async () => {
    if (submitting || !itemsView) return
    const v = validateRsqAnswers(itemsView.items, answers)
    if (!v.ok) {
      setSubmitError('还有 ' + v.missing.length + ' 道必答题未作答（已跳到第一处缺口）。')
      setPageIndex(pageOfItem(pages, v.missing[0]))
      return
    }
    setSubmitError(null)
    setSubmitting(true)
    try {
      const payload = buildRsqSubmitPayload({
        fromPersonaId,
        toPersonaId,
        level: itemsView.level,
        items: itemsView.items,
        answers,
      })
      const r = await onSubmit(payload)
      setSavedId(r.id)
      onSubmitted?.(r)
    } catch (e) {
      setSubmitError('提交失败：' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setSubmitting(false)
    }
  }

  const missingSet = new Set(validation.missing)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="text-base">
            关系测评（RSQ）· {fromName} → {toName}
          </DialogTitle>
          <DialogDescription className="text-xs">
            以「{fromName}」自己的感受作答，不是按角色应然的方向。1 = 完全不符，4 = 一般，7 = 完全符合。
          </DialogDescription>
        </DialogHeader>

        {/* 第 1 步：选级别 */}
        {!itemsView && !loading && !loadError ? (
          <div className="space-y-2">
            {LEVELS.map((lv) => (
              <button
                key={lv}
                type="button"
                className="flex w-full items-start gap-3 rounded-lg border border-border px-3 py-2.5 text-left transition-colors hover:border-god/60 hover:bg-god/5"
                onClick={() => start(lv)}
              >
                <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                  {lv}
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-foreground">{RSQ_LEVEL_META[lv].label}</span>
                  <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">
                    {RSQ_LEVEL_META[lv].hint}
                  </span>
                </span>
              </button>
            ))}
          </div>
        ) : null}

        {loading ? (
          <p className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> 正在加载题库…
          </p>
        ) : null}

        {loadError ? (
          <div className="space-y-2 py-6 text-center">
            <p className="text-sm text-destructive">{loadError}</p>
            <Button size="sm" variant="outline" onClick={() => void load(level)}>重试</Button>
          </div>
        ) : null}

        {/* 第 2/3 步：作答 */}
        {itemsView && !loading ? (
          savedId != null ? (
            <div className="space-y-3 py-6 text-center">
              <p className="text-sm font-medium text-foreground">答卷已保存（#{savedId}）</p>
              <p className="text-xs text-muted-foreground">
                计分完成，已写入关系测评历史。可以关闭本窗口查看报告。
              </p>
            </div>
          ) : (
            <>
              {/* 进度 + 题库版本 */}
              <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                <span>
                  第 {Math.min(pageIndex + 1, pages.length)} / {pages.length} 页 · 已答 {validation.answered}/
                  {validation.total} 题
                </span>
                <span className="ml-auto">题库版本 {itemsView.version} · {itemsView.level} 级</span>
              </div>
              <div
                className="h-1.5 overflow-hidden rounded-full bg-muted"
                role="progressbar"
                aria-label="RSQ 作答进度"
                aria-valuemin={0}
                aria-valuemax={validation.total}
                aria-valuenow={validation.answered}
              >
                <div
                  className="h-full bg-primary transition-all"
                  style={{ width: progressPct + '%' }}
                />
              </div>

              {page ? (
                <div className="max-h-[46vh] space-y-3 overflow-y-auto pr-1">
                  <div className="text-[11px] font-medium text-muted-foreground">{page.title}</div>
                  {page.items.map((it) => {
                    const value = answers.likert[it.no]
                    const openText = answers.open[it.no] ?? ''
                    const missing = missingSet.has(it.no)
                    return (
                      <div
                        key={it.no}
                        className={cn(
                          'rounded-lg border px-3 py-2.5',
                          missing ? 'border-destructive/50 bg-destructive/5' : 'border-border',
                        )}
                      >
                        <div className="flex items-start gap-2">
                          <span className="mt-0.5 shrink-0 rounded bg-accent px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
                            {it.no}
                          </span>
                          <p className="min-w-0 flex-1 text-[13px] leading-relaxed text-foreground/90">
                            {it.text.replace(/\{对象\}/g, toName)}
                          </p>
                        </div>
                        {isOpenItem(it) ? (
                          it.no === RSQ_SELF_SUMMARY_NO ? (
                            <div className="mt-2 space-y-1">
                              <Input
                                value={openText}
                                maxLength={36}
                                placeholder="用一句话（≤36 字）概括你和 TA 的关系（选填）"
                                onChange={(e) => setOpenText(it.no, e.target.value)}
                                aria-label={'第 ' + it.no + ' 题（一句话自评）'}
                              />
                              <p className="text-right text-[10px] text-muted-foreground/60">
                                {openText.length}/36
                              </p>
                            </div>
                          ) : (
                            <Textarea
                              value={openText}
                              rows={2}
                              placeholder="选填"
                              className="mt-2 text-[12px]"
                              onChange={(e) => setOpenText(it.no, e.target.value)}
                              aria-label={'第 ' + it.no + ' 题（开放题）'}
                            />
                          )
                        ) : (
                          <div className="mt-2 flex flex-wrap gap-1" role="group" aria-label={'第 ' + it.no + ' 题评分'}>
                            {[1, 2, 3, 4, 5, 6, 7].map((score) => (
                              <button
                                key={score}
                                type="button"
                                onClick={() => setLikert(it.no, score)}
                                aria-pressed={value === score}
                                aria-label={'第 ' + it.no + ' 题选 ' + score + ' 分'}
                                className={cn(
                                  'h-7 w-7 rounded-md border text-[11px] tabular-nums transition-colors',
                                  value === score
                                    ? 'border-primary bg-primary text-primary-foreground'
                                    : 'border-border text-muted-foreground hover:border-primary/50 hover:bg-accent',
                                )}
                              >
                                {score}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              ) : null}

              {submitError ? <p className="text-xs text-destructive">{submitError}</p> : null}
            </>
          )
        ) : null}

        <DialogFooter className="gap-2 sm:gap-2">
          {itemsView && !loading && savedId == null ? (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={pageIndex <= 0}
                onClick={() => setPageIndex((i) => Math.max(0, i - 1))}
              >
                <ChevronLeft className="mr-1 h-3.5 w-3.5" /> 上一页
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={pageIndex >= pages.length - 1}
                onClick={() => setPageIndex((i) => Math.min(pages.length - 1, i + 1))}
              >
                下一页 <ChevronRight className="ml-1 h-3.5 w-3.5" />
              </Button>
              <Button
                size="sm"
                className="ml-auto"
                onClick={() => void submit()}
                disabled={submitting}
              >
                {submitting ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Send className="mr-1 h-3.5 w-3.5" />}
                提交答卷
              </Button>
            </>
          ) : null}
          <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
            {savedId != null ? '完成' : '取消'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
