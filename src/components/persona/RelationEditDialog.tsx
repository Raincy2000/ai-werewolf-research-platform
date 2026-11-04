/**
 * 手动关系编辑弹窗（2026-10-22）
 *
 * 用途：人格详情「关系」页签里新建/编辑一条原世界关系。
 * - 新建：选择目标人格 + 关系类别 + Fiske 形式 + 备注
 * - 编辑：目标固定，只改类别/形式/备注（后端 kind/form 变更走校正留痕）
 */
import { useEffect, useState } from 'react'
import { Loader2, Save } from 'lucide-react'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  RELATION_FORMS,
  RELATION_FORM_LABEL,
  RELATION_KINDS,
  RELATION_KIND_LABEL,
} from '@contracts/interpersonal'

export interface RelationEditValue {
  /** 新建时必填；编辑时忽略（沿用原目标） */
  targetPersonaId?: number
  kind: string
  form: string
  basis: string
}

export interface RelationEditDialogProps {
  open: boolean
  onOpenChange: (v: boolean) => void
  mode: 'create' | 'edit'
  selfName: string
  /** 新建时可选的目标人格（编辑时不使用） */
  targets: Array<{ id: number; name: string }>
  /** 编辑时展示的目标名 */
  targetName?: string
  initial?: Partial<RelationEditValue> | null
  busy?: boolean
  error?: string | null
  onSubmit: (value: RelationEditValue) => void | Promise<void>
}

export function RelationEditDialog(props: RelationEditDialogProps) {
  const { open, onOpenChange, mode, selfName, targets, targetName, initial, busy, error, onSubmit } = props
  const [targetId, setTargetId] = useState<string>('')
  const [kind, setKind] = useState('unspecified')
  const [form, setForm] = useState('CS')
  const [basis, setBasis] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setTargetId(initial?.targetPersonaId != null ? String(initial.targetPersonaId) : '')
    setKind(initial?.kind && (RELATION_KINDS as readonly string[]).includes(initial.kind) ? initial.kind : 'unspecified')
    setForm(initial?.form && (RELATION_FORMS as readonly string[]).includes(initial.form) ? initial.form : 'CS')
    setBasis(initial?.basis ?? '')
    setLocalError(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode, initial?.targetPersonaId, initial?.kind, initial?.form, initial?.basis])

  const submit = async () => {
    if (busy) return
    if (mode === 'create' && !targetId) { setLocalError('请选择目标人格'); return }
    setLocalError(null)
    await onSubmit({
      targetPersonaId: targetId ? Number(targetId) : undefined,
      kind,
      form,
      basis: basis.trim(),
    })
  }

  const shownError = localError ?? error ?? null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{mode === 'create' ? '新建关系' : '编辑关系'}</DialogTitle>
          <DialogDescription>
            {mode === 'create'
              ? `为「${selfName}」建立一条原世界关系；建立后可在详情页继续补充事件。`
              : `编辑「${selfName}」→「${targetName ?? 'TA'}」的关系类别与备注。`}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {mode === 'create' ? (
            <div>
              <Label className="mb-1 block text-xs">目标人格</Label>
              <Select value={targetId} onValueChange={setTargetId}>
                <SelectTrigger className="h-9">
                  <SelectValue placeholder={targets.length ? '选择人格' : '暂无可选人格'} />
                </SelectTrigger>
                <SelectContent>
                  {targets.map((t) => (
                    <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : (
            <div>
              <Label className="mb-1 block text-xs">目标人格</Label>
              <p className="rounded-md border border-border bg-secondary/40 px-2.5 py-1.5 text-sm">{targetName ?? 'TA'}</p>
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label className="mb-1 block text-xs">关系类别</Label>
              <Select value={kind} onValueChange={setKind}>
                <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {RELATION_KINDS.map((k) => (
                    <SelectItem key={k} value={k}>{RELATION_KIND_LABEL[k]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="mb-1 block text-xs">关系形式（Fiske）</Label>
              <Select value={form} onValueChange={setForm}>
                <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {RELATION_FORMS.map((f) => (
                    <SelectItem key={f} value={f}>{f} · {RELATION_FORM_LABEL[f]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div>
            <Label className="mb-1 block text-xs">备注（可选）</Label>
            <Textarea
              value={basis}
              onChange={(e) => setBasis(e.target.value)}
              placeholder="一句话说明这段关系（原作依据/你的判断）"
              maxLength={300}
              rows={3}
            />
          </div>

          {shownError ? <p className="text-xs text-wolf">{shownError}</p> : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>取消</Button>
          <Button onClick={() => void submit()} disabled={busy}>
            {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Save className="mr-1 h-4 w-4" />}
            {mode === 'create' ? '建立关系' : '保存修改'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
