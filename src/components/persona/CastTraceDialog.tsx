// ============================================================
// 生成留痕查看器（2026-10-14 用户裁定）
// 草稿箱=生成进程全程镜像的读面：进度标记点横排，点击选择查看该阶段
// 已落盘的研究文本；默认全部折叠（不选不看），再点一次收起。
// 生成中的条目 2s 轮询，文本随阶段推进实时变长。
// ============================================================

import { useEffect, useState } from 'react'
import { History, Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { useGameApi } from '@/lib/gameApi'
import type { CastTrace } from '@contracts/persona'

const STATUS_LABEL: Record<string, string> = {
  queued: '排队中',
  running: '生成中',
  paused: '已暂停',
  interrupted: '已中断',
  failed: '失败',
  done: '草稿已铸成',
  saved: '已入库',
}

export function CastTraceDialog({
  castId,
  onClose,
}: {
  castId: string | null
  onClose: () => void
}) {
  const api = useGameApi()
  const [trace, setTrace] = useState<CastTrace | null>(null)
  const [selected, setSelected] = useState<string | null>(null) // 默认折叠：不选不看

  useEffect(() => {
    if (!castId) {
      setTrace(null)
      setSelected(null)
      return
    }
    let cancelled = false
    const tick = async () => {
      try {
        const t = await api.getCastTrace(castId)
        if (!cancelled && t) setTrace(t)
      } catch {
        /* 下轮再试 */
      }
    }
    void tick()
    const timer = setInterval(() => void tick(), 2000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [api, castId])

  const selectedStage = trace?.stages.find((s) => s.key === selected && s.available)

  return (
    <Dialog open={castId !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History className="h-5 w-5 text-god" aria-hidden />
            生成留痕——「{trace?.name ?? '…'}」
            {trace ? (
              <Badge variant="outline" className="px-1.5 text-[10px] font-normal">
                {STATUS_LABEL[trace.status] ?? trace.status}
              </Badge>
            ) : null}
          </DialogTitle>
          <DialogDescription>
            生成进程的每一步产物即写即存。点击进度标记点查看该阶段已生成的研究文本，再点一次收起。
          </DialogDescription>
        </DialogHeader>

        {!trace ? (
          <p className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            读取留痕中…
          </p>
        ) : trace.stages.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            尚无落盘产物——进程刚起步，阶段文本生成后会出现在这里。
          </p>
        ) : (
          <>
            {/* 进度标记点横排：可用=实心可点，未到=灰色虚点 */}
            <div className="flex flex-wrap items-center gap-y-2">
              {trace.stages.map((s, i) => (
                <div key={s.key} className="flex items-center">
                  {i > 0 ? <span className="mx-1.5 h-px w-4 bg-border" aria-hidden /> : null}
                  <button
                    type="button"
                    disabled={!s.available}
                    onClick={() => setSelected((cur) => (cur === s.key ? null : s.key))}
                    className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
                      selected === s.key
                        ? 'border-god bg-god/15 text-god'
                        : s.available
                          ? 'border-god/50 bg-god/5 text-foreground hover:bg-god/10'
                          : 'border-border text-muted-foreground/50'
                    }`}
                  >
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${s.available ? 'bg-god' : 'bg-muted-foreground/40'}`}
                      aria-hidden
                    />
                    {s.label}
                  </button>
                </div>
              ))}
            </div>
            {/* 文本面板：折叠为默认，选中才展开 */}
            {selectedStage ? (
              <div className="mt-3 min-h-0 flex-1 overflow-y-auto rounded-lg border border-border bg-secondary/40 p-4">
                <p className="mb-2 text-xs font-medium text-god">{selectedStage.label}</p>
                <pre className="whitespace-pre-wrap break-words font-sans text-[13px] leading-6 text-foreground">
                  {selectedStage.text}
                </pre>
              </div>
            ) : (
              <p className="mt-3 rounded-lg border border-dashed border-border py-6 text-center text-xs text-muted-foreground">
                已折叠——点上方任一标记点展开对应阶段的文本
              </p>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
