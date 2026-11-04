/**
 * 现实层（L1）记忆手录弹窗：新增 / 编辑一条 manual canon 事件。
 *
 * 审计 P1-4 / P2-3：RelationDetailPanel 早就有 onAdd/onEdit/onDelete 回调，
 * 但 RelationGraphBar 从未传进去，三个 mutation 也从未被调用——
 * 用户只能看只读时间线，AI 写错的记忆无法人工修正。本弹窗补上入口，
 * 并为后端 zod 补充 age/place（拿不到时传 undefined/null，不伪造）。
 */
import { useEffect, useState } from 'react'
import { Loader2, Save } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  canonFormError,
  emptyCanonForm,
  toCanonSubmitValue,
  type CanonEventFormValue,
  type CanonEventSubmitValue,
} from '@/lib/canonClient'

export interface CanonEventDialogProps {
  open: boolean
  onOpenChange: (v: boolean) => void
  mode: 'add' | 'edit'
  /** 视角两端（仅用于标题提示） */
  fromName: string
  toName: string
  /** 编辑时的初始值（新增为 null） */
  initial?: Partial<CanonEventFormValue> | null
  /** 提交（新增 = addCanonEvent；编辑 = updateCanonEvent） */
  onSubmit: (value: CanonEventSubmitValue) => Promise<void>
}

export function CanonEventDialog(props: CanonEventDialogProps) {
  const { open, onOpenChange, mode, fromName, toName, initial, onSubmit } = props
  const [form, setForm] = useState<CanonEventFormValue>(emptyCanonForm(initial))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setForm(emptyCanonForm(initial))
    setError(null)
    setBusy(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode, initial?.era, initial?.eventText, initial?.feeling, initial?.age, initial?.place, initial?.impact])

  const patch = (key: keyof CanonEventFormValue, value: string) => {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  const submit = async () => {
    if (busy) return
    const err = canonFormError(form)
    if (err) { setError(err); return }
    const value = toCanonSubmitValue(form)
    if (!value) { setError('表单不完整，请检查必填项'); return }
    setBusy(true)
    setError(null)
    try {
      await onSubmit(value)
      onOpenChange(false)
    } catch (e) {
      setError('保存失败：' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="text-base">
            {mode === 'add' ? '手动补充记忆' : '编辑记忆'} · {fromName} → {toName}
          </DialogTitle>
          <DialogDescription className="text-xs">
            手录内容标记为「manual」来源，不再走 AI 核查；用于修正错误或补充原作没写到的经历。
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[58vh] space-y-3 overflow-y-auto pr-1">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="canon-era" className="text-xs">时间 <span className="text-destructive">*</span></Label>
              <Input
                id="canon-era"
                value={form.era}
                placeholder="如：2006年夏 / 845年"
                maxLength={64}
                onChange={(e) => patch('era', e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="canon-age" className="text-xs">当时年龄（选填）</Label>
              <Input
                id="canon-age"
                value={form.age}
                inputMode="numeric"
                placeholder="不清楚可留空"
                onChange={(e) => patch('age', e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-1">
            <Label htmlFor="canon-place" className="text-xs">发生地点（选填）</Label>
            <Input
              id="canon-place"
              value={form.place}
              placeholder="如：希干希纳区地下街"
              maxLength={40}
              onChange={(e) => patch('place', e.target.value)}
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor="canon-event" className="text-xs">事件经过 <span className="text-destructive">*</span></Label>
            <Textarea
              id="canon-event"
              value={form.eventText}
              rows={3}
              maxLength={400}
              placeholder="发生了什么（尽量具体，便于 AI 检索时引用）"
              onChange={(e) => patch('eventText', e.target.value)}
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor="canon-feeling" className="text-xs">当时的感受 <span className="text-destructive">*</span></Label>
            <Textarea
              id="canon-feeling"
              value={form.feeling}
              rows={4}
              maxLength={1200}
              placeholder="可写复合感受：当时 / 中途 / 现在分别怎么想"
              onChange={(e) => patch('feeling', e.target.value)}
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor="canon-impact" className="text-xs">对关系的影响（选填）</Label>
            <Input
              id="canon-impact"
              value={form.impact}
              maxLength={200}
              placeholder="如：从此不再信任对方"
              onChange={(e) => patch('impact', e.target.value)}
            />
          </div>

          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>取消</Button>
          <Button size="sm" onClick={() => void submit()} disabled={busy}>
            {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Save className="mr-1 h-3.5 w-3.5" />}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
