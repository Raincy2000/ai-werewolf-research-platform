/**
 * 人格研究库 /personas —— 「数字人类心理学实验场」的人格参数卡管理页。
 * 铁律1「人格量化」：每个角色一张人格参数卡（大五/依恋/黑暗四/认知偏差/防御机制/情绪调节/SDT），
 * 全部 0-100 连续量化，禁止二选一。
 * P1 范围：手动建卡/编辑/详情/删除；AI 铸造（铸魂师）在 P2 接入。
 */

import { useEffect, useState } from 'react'
import {
  Brain,
  CircleAlert,
  Fingerprint,
  Loader2,
  Pause,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Sparkles,
  Square,
  Trash,
  Trash2,
} from 'lucide-react'
import type {
  ApiPreset,
  CastProgressState,
  CognitiveBiasEntry,
  DefenseMechanismEntry,
  PersonaCard,
  PersonaCardInput,
  PersonaCardSummary,
  PersonaDetail,
  PersonaParams,
  PersonaReport,
  PersonaTrashEntry,
} from '@/lib/gameApi'
import {
  COGNITIVE_BIAS_CATALOG,
  DEFENSE_MECHANISM_CATALOG,
  attachmentLabel,
  defaultPersonaParams,
  emptyPersonaProfile,
  useGameApi,
} from '@/lib/gameApi'
import { useAuth } from '@/providers/auth'
import { LoginRequiredCard } from '@/components/AuthDialog'
import { isUnauthorizedError } from '@/lib/utils'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Slider } from '@/components/ui/slider'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { CastWizard } from '@/components/persona/CastWizard'
import { MarkdownBoard } from '@/components/MarkdownBoard'

// ---------------------------------------------------------------------------
// 常量与工具
// ---------------------------------------------------------------------------

const BIG_FIVE_LABELS: ReadonlyArray<{ key: keyof PersonaParams['bigFive']; label: string }> = [
  { key: 'openness', label: '开放性' },
  { key: 'conscientiousness', label: '尽责性' },
  { key: 'extraversion', label: '外向性' },
  { key: 'agreeableness', label: '宜人性' },
  { key: 'neuroticism', label: '神经质' },
]

const DARK_LABELS: ReadonlyArray<{ key: keyof PersonaParams['darkTetrad']; label: string }> = [
  { key: 'machiavellianism', label: '马基雅维利' },
  { key: 'narcissism', label: '自恋' },
  { key: 'psychopathy', label: '精神病态' },
  { key: 'sadism', label: '施虐' },
]

const EMO_LABELS: ReadonlyArray<{ key: keyof PersonaParams['emotionRegulation']; label: string }> = [
  { key: 'cognitiveReappraisal', label: '认知重评' },
  { key: 'expressiveSuppression', label: '表达抑制' },
  { key: 'rumination', label: '反刍倾向' },
]

const SDT_LABELS: ReadonlyArray<{ key: keyof PersonaParams['sdt']; label: string }> = [
  { key: 'autonomy', label: '自主需要' },
  { key: 'competence', label: '胜任需要' },
  { key: 'relatedness', label: '归属需要' },
]

const MATURITY_LABEL: Record<DefenseMechanismEntry['maturity'], string> = {
  primitive: '原始',
  neurotic: '神经质',
  mature: '成熟',
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 编辑表单状态（quotes 以换行文本编辑，保存时拆分） */
interface PersonaFormState {
  name: string
  originName: string
  originSource: string
  summary: string
  persona: string
  experiences: string
  relationships: string
  quotesText: string
  speechStyle: string
  appearance: string
  values: string
  desires: string
  fears: string
  socialMask: string
  innerWorld: string
  quirks: string
  essence: string
  aliveStatus: 'alive' | 'deceased' | null
  specialAbilities: string
  notes: string
  imageData: string | null
  params: PersonaParams
}

function formFromCard(card: PersonaCard): PersonaFormState {
  const pr = card.profile
  return {
    name: card.name,
    originName: card.originName ?? '',
    originSource: card.originSource ?? '',
    summary: pr.summary,
    persona: pr.persona,
    experiences: pr.experiences,
    relationships: pr.relationships,
    quotesText: pr.quotes.join('\n'),
    speechStyle: pr.speechStyle,
    appearance: pr.appearance ?? '',
    values: pr.values ?? '',
    desires: pr.desires ?? '',
    fears: pr.fears ?? '',
    socialMask: pr.socialMask ?? '',
    innerWorld: pr.innerWorld ?? '',
    quirks: pr.quirks ?? '',
    essence: pr.essence ?? '',
    aliveStatus: pr.aliveStatus ?? null,
    specialAbilities: pr.specialAbilities ?? '',
    notes: card.notes,
    imageData: card.imageData,
    params: card.params,
  }
}

function blankForm(): PersonaFormState {
  const p = emptyPersonaProfile()
  return {
    name: '',
    originName: '',
    originSource: '',
    summary: p.summary,
    persona: p.persona,
    experiences: p.experiences,
    relationships: p.relationships,
    quotesText: '',
    speechStyle: '',
    appearance: '',
    values: '',
    desires: '',
    fears: '',
    socialMask: '',
    innerWorld: '',
    quirks: '',
    essence: '',
    aliveStatus: null,
    specialAbilities: '',
    notes: '',
    imageData: null,
    params: defaultPersonaParams(),
  }
}

function formToInput(form: PersonaFormState): PersonaCardInput {
  return {
    name: form.name.trim(),
    originName: form.originName.trim() || null,
    originSource: form.originSource.trim() || null,
    profile: {
      summary: form.summary.trim(),
      persona: form.persona.trim(),
      experiences: form.experiences.trim(),
      relationships: form.relationships.trim(),
      quotes: form.quotesText
        .split('\n')
        .map((q) => q.trim())
        .filter(Boolean)
        .slice(0, 5),
      speechStyle: form.speechStyle.trim(),
      appearance: form.appearance.trim(),
      values: form.values.trim(),
      desires: form.desires.trim(),
      fears: form.fears.trim(),
      socialMask: form.socialMask.trim(),
      innerWorld: form.innerWorld.trim(),
      quirks: form.quirks.trim(),
      essence: form.essence.trim(),
      aliveStatus: form.aliveStatus,
      specialAbilities: form.specialAbilities.trim(),
    },
    params: form.params,
    notes: form.notes.trim(),
    imageData: form.imageData,
  }
}

// ---------------------------------------------------------------------------
// 参数展示/编辑小组件
// ---------------------------------------------------------------------------

/** 只读参数条（列表与详情用） */
function ParamBar({ label, value, tone }: { label: string; value: number; tone?: 'wolf' }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-16 shrink-0 text-xs text-muted-foreground">{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-secondary">
        <div
          className={cn('h-full rounded-full', tone === 'wolf' ? 'bg-wolf/70' : 'bg-god/70')}
          style={{ width: `${value}%` }}
        />
      </div>
      <span className="w-7 shrink-0 text-right font-mono text-xs text-foreground">{value}</span>
    </div>
  )
}

/** 编辑滑杆：0-100 连续量化；推断项标记随手动修改消除（推断→实证） */
function ParamSlider({
  label,
  value,
  onChange,
  inferred,
  hint,
}: {
  label: string
  value: number
  onChange: (v: number) => void
  inferred?: boolean
  hint?: string
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-foreground">{label}</span>
        {inferred ? (
          <Badge variant="outline" className="border-amber-500/50 text-[10px] font-normal text-amber-600">
            推断项
          </Badge>
        ) : null}
        {hint ? <span className="text-[10px] text-muted-foreground">{hint}</span> : null}
        <span className="ml-auto font-mono text-xs text-muted-foreground">{value}</span>
      </div>
      <Slider value={[value]} min={0} max={100} step={1} onValueChange={(v) => onChange(v[0])} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// 页面主体
// ---------------------------------------------------------------------------

export default function Personas() {
  const api = useGameApi()
  const { user } = useAuth()
  const userId = user?.id ?? null

  const [cards, setCards] = useState<PersonaCardSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // 编辑器：null=关闭；{id:null}=新建；{id:n}=编辑；casted=true 表示 AI 铸造草稿（保存走 createCasted）
  const [editor, setEditor] = useState<{ id: number | null; form: PersonaFormState; casted?: boolean } | null>(null)
  // 详情
  const [detail, setDetail] = useState<PersonaDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  // 详情页心理检查报告（打开详情时一并拉取）
  const [detailReports, setDetailReports] = useState<PersonaReport[]>([])
  // 心理检查报告阅读窗
  const [reportView, setReportView] = useState<PersonaReport | null>(null)
  // 删除确认
  const [deleteTarget, setDeleteTarget] = useState<PersonaCardSummary | null>(null)
  // 回收站（软删人格：30 天保留期内可一键还原）
  const [trashOpen, setTrashOpen] = useState(false)
  const [trashList, setTrashList] = useState<PersonaTrashEntry[]>([])
  const [trashLoading, setTrashLoading] = useState(false)
  // 彻底删除确认（回收站内二次确认）
  const [destroyTarget, setDestroyTarget] = useState<PersonaTrashEntry | null>(null)
  // 铸造中卡片组（后台铸造任务透出：批量并发时逐卡显示姓名+进度+暂停/继续/终止；向导误关也不丢进度）
  const [activeCasts, setActiveCasts] = useState<CastProgressState[]>([])
  // 终止生成确认（取消并删除整个铸造流程；记录待终止的 castId）
  const [cancelConfirm, setCancelConfirm] = useState<string | null>(null)

  // 铸造任务轮询：进页找回全部进行中的铸造（进行中/已完成未取走都透出），每 2s 刷新
  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      try {
        const actives = await api.getCastActives()
        if (!cancelled) setActiveCasts(actives)
      } catch { /* 忽略，下轮再试 */ }
    }
    void tick()
    const t = setInterval(() => void tick(), 2000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [api])

  /** 铸造控制：暂停/继续（乐观更新）/终止（取消并删除整个流程） */
  async function handleCastControl(castId: string, action: 'pause' | 'resume' | 'cancel') {
    try {
      await api.controlCast(castId, action)
      if (action === 'cancel') setActiveCasts((prev) => prev.filter((c) => c.castId !== castId))
      else setActiveCasts((prev) => prev.map((c) => (c.castId === castId ? { ...c, paused: action === 'pause' } : c)))
    } catch {
      setError('操作失败，请重试')
    }
  }
  // AI 铸造向导与存档库（向导「从存档导入」用）
  const [castOpen, setCastOpen] = useState(false)
  const [presets, setPresets] = useState<ApiPreset[]>([])
  // 配图：从链接获取的状态（编辑器内）
  const [portraitUrl, setPortraitUrl] = useState('')
  const [portraitBusy, setPortraitBusy] = useState(false)

  /** 上传图片 → 画布缩放到 ≤320px JPEG data URL（库列与载荷可控） */
  async function handlePortraitFile(file: File | null) {
    if (!file) return
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const img = new Image()
        const objUrl = URL.createObjectURL(file)
        img.onload = () => {
          const scale = Math.min(1, 320 / Math.max(img.width, img.height))
          const w = Math.max(1, Math.round(img.width * scale))
          const h = Math.max(1, Math.round(img.height * scale))
          const canvas = document.createElement('canvas')
          canvas.width = w
          canvas.height = h
          const ctx = canvas.getContext('2d')
          URL.revokeObjectURL(objUrl)
          if (!ctx) return reject(new Error('画布不可用'))
          ctx.drawImage(img, 0, 0, w, h)
          resolve(canvas.toDataURL('image/jpeg', 0.85))
        }
        img.onerror = () => {
          URL.revokeObjectURL(objUrl)
          reject(new Error('图片读取失败'))
        }
        img.src = objUrl
      })
      setEditor((p) => p && { ...p, form: { ...p.form, imageData: dataUrl } })
    } catch {
      setError('图片处理失败，请换一张')
    }
  }

  /** 从链接获取肖像（图片直链或人物资料页链接，服务端下载转 data URL） */
  async function handlePortraitFetch() {
    const url = portraitUrl.trim()
    if (!url || portraitBusy) return
    setPortraitBusy(true)
    try {
      const r = await api.fetchPortrait(url)
      if (r.imageData) {
        setEditor((p) => p && { ...p, form: { ...p.form, imageData: r.imageData } })
        setPortraitUrl('')
      } else {
        setError('没能从该链接取到图片（页面无代表图或图片过大）')
      }
    } catch {
      setError('获取图片失败，请检查链接')
    } finally {
      setPortraitBusy(false)
    }
  }

  useEffect(() => {
    if (!userId) {
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    api
      .listPersonas()
      .then((rows) => {
        if (!cancelled) setCards(rows)
      })
      .catch((err) => {
        if (!cancelled && !isUnauthorizedError(err)) setError('加载人格卡失败，请重试')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId])

  async function refreshList() {
    setCards(await api.listPersonas())
  }

  // ---------- 编辑器 ----------

  function openCreate() {
    setEditor({ id: null, form: blankForm() })
  }

  async function openEdit(id: number) {
    setBusy(true)
    try {
      const d = await api.getPersonaDetail(id)
      if (d) setEditor({ id, form: formFromCard(d.card) })
    } catch {
      setError('读取人格卡失败')
    } finally {
      setBusy(false)
    }
  }

  /** 更新参数并把该字段的推断标记消除（手动修改 = 实证化） */
  function patchParams(mutate: (p: PersonaParams) => PersonaParams, touchedPath?: string) {
    setEditor((prev) => {
      if (!prev) return prev
      let params = mutate(prev.form.params)
      if (touchedPath && params.inferred.includes(touchedPath)) {
        params = { ...params, inferred: params.inferred.filter((x) => x !== touchedPath) }
      }
      return { ...prev, form: { ...prev.form, params } }
    })
  }

  // ---------- AI 铸造 ----------

  /** 打开铸造向导（顺带拉取存档库供「从存档导入」） */
  async function openCast() {
    setCastOpen(true)
    try {
      setPresets(await api.listPresets())
    } catch {
      /* 存档不可用时向导内手动填四要素即可 */
    }
  }

  /** 铸造草稿送入编辑器：整卡预填（含推断项标记与肖像），保存时走 createCasted 入库 */
  function handleDraftReady(draft: PersonaCardInput) {
    setCastOpen(false)
    setEditor({
      id: null,
      casted: true,
      form: {
        name: draft.name,
        originName: draft.originName ?? '',
        originSource: draft.originSource ?? '',
        summary: draft.profile.summary,
        persona: draft.profile.persona,
        experiences: draft.profile.experiences,
        relationships: draft.profile.relationships,
        quotesText: draft.profile.quotes.join('\n'),
        speechStyle: draft.profile.speechStyle,
        appearance: draft.profile.appearance ?? '',
        values: draft.profile.values ?? '',
        desires: draft.profile.desires ?? '',
        fears: draft.profile.fears ?? '',
        socialMask: draft.profile.socialMask ?? '',
        innerWorld: draft.profile.innerWorld ?? '',
        quirks: draft.profile.quirks ?? '',
        essence: draft.profile.essence ?? '',
        aliveStatus: draft.profile.aliveStatus ?? null,
        specialAbilities: draft.profile.specialAbilities ?? '',
        notes: draft.notes ?? '',
        imageData: draft.imageData ?? null,
        params: draft.params,
      },
    })
  }

  async function handleSave() {
    if (!editor || busy) return
    const input = formToInput(editor.form)
    if (!input.name) {
      setError('人格名不能为空')
      return
    }
    setBusy(true)
    setError(null)
    try {
      if (editor.id === null) {
        if (editor.casted) {
          await api.createCastedPersona(input) // AI 铸造草稿入库（source="ai-cast"）
        } else {
          await api.createPersona(input)
        }
      } else {
        await api.updatePersona(editor.id, input)
      }
      await refreshList()
      setEditor(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败，请重试')
    } finally {
      setBusy(false)
    }
  }

  // ---------- 详情 ----------

  async function openDetail(id: number) {
    setDetailLoading(true)
    try {
      const d = await api.getPersonaDetail(id)
      if (d) {
        setDetail(d)
        // 心理检查报告随详情一并拉取（心理检查师终局产出，可能为空）
        setDetailReports(await api.listPersonaReports(id).catch(() => []))
      }
    } catch {
      setError('读取人格详情失败')
    } finally {
      setDetailLoading(false)
    }
  }

  // ---------- 删除 ----------

  async function handleDelete() {
    if (!deleteTarget) return
    try {
      await api.deletePersona(deleteTarget.id)
      setCards((prev) => prev.filter((c) => c.id !== deleteTarget.id))
    } catch {
      setError('移入回收站失败，请重试')
    } finally {
      setDeleteTarget(null)
    }
  }

  // ---------- 回收站 ----------

  async function openTrash() {
    setTrashOpen(true)
    setTrashLoading(true)
    try {
      setTrashList(await api.listPersonaTrash())
    } catch {
      setError('回收站读取失败，请重试')
    } finally {
      setTrashLoading(false)
    }
  }

  /** 剩余天数（到期自动彻底清除） */
  function trashDaysLeft(e: PersonaTrashEntry): number {
    return Math.max(0, Math.ceil((new Date(e.expiresAt).getTime() - Date.now()) / 86_400_000))
  }

  async function handleRestore(entry: PersonaTrashEntry) {
    try {
      await api.restorePersona(entry.id)
      setTrashList((prev) => prev.filter((x) => x.id !== entry.id))
      await refreshList()
    } catch {
      setError('还原失败，请重试')
    }
  }

  async function handleDestroy() {
    if (!destroyTarget) return
    try {
      await api.destroyPersona(destroyTarget.id)
      setTrashList((prev) => prev.filter((x) => x.id !== destroyTarget.id))
    } catch {
      setError('彻底删除失败，请重试')
    } finally {
      setDestroyTarget(null)
    }
  }

  if (!userId) {
    return (
      <div className="mx-auto max-w-[1600px] px-4 py-10 sm:px-8">
        <LoginRequiredCard />
      </div>
    )
  }

  const form = editor?.form ?? null

  return (
    <div className="mx-auto max-w-[1600px] px-4 py-6 sm:px-8">
      {/* 页头 */}
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <Fingerprint className="h-6 w-6 text-foreground" aria-hidden />
        <div>
          <h1 className="text-xl font-semibold text-foreground">人格研究库</h1>
          <p className="text-sm text-muted-foreground">
            数字人类心理学实验场：把虚拟/现实人物铸造成可量化、有记忆、会变形、能跨对局成长的数字人格
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" onClick={() => void openTrash()}>
            <Trash className="h-4 w-4" aria-hidden />
            回收站
          </Button>
          <Button variant="outline" onClick={() => void openCast()}>
            <Sparkles className="h-4 w-4" aria-hidden />
            AI 铸造
          </Button>
          <Button onClick={openCreate} disabled={busy}>
            <Plus className="h-4 w-4" aria-hidden />
            手动建卡
          </Button>
        </div>
      </div>

      {error ? (
        <p className="mb-4 flex items-center gap-1.5 text-sm text-wolf">
          <CircleAlert className="h-4 w-4" aria-hidden />
          {error}
        </p>
      ) : null}

      {/* 人格卡列表 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">人格参数卡</CardTitle>
          <CardDescription>
            每张卡含大五人格、依恋类型、黑暗四人格、核心认知偏差、防御机制、情绪调节策略、SDT
            动机七组量化参数；创建对局时可把人格卡拖入座位参赛
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              正在加载…
            </p>
          ) : cards.length === 0 && activeCasts.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              还没有人格卡。点击「手动建卡」亲手调节七组量化参数；下一阶段还可用「AI
              铸造」输入现实/虚拟人物名自动生成参数卡。
            </p>
          ) : (
            <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {/* 铸造中卡片组（始终在最前/最新位置）：批量并发时逐卡显示；姓名+进度+暂停/继续+终止 */}
              {activeCasts.map((activeCast) => (
                <li key={activeCast.castId} className="flex gap-3 rounded-lg border border-god/50 bg-god/5 p-3">
                  <span className="flex h-24 w-[72px] shrink-0 items-center justify-center rounded-md border border-god/40 bg-secondary">
                    {activeCast.done ? (
                      <Sparkles className="h-7 w-7 text-god" aria-hidden />
                    ) : (
                      <Loader2 className={`h-7 w-7 text-god ${activeCast.paused ? '' : 'animate-spin'}`} aria-hidden />
                    )}
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col">
                    <div className="mb-0.5 flex items-center gap-1.5">
                      <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
                        {activeCast.name ?? '新人格'}
                      </span>
                      <Badge variant="default" className="px-1.5 text-[10px]">
                        {activeCast.done
                          ? activeCast.error
                            ? '铸造失败'
                            : '草稿已铸成'
                          : activeCast.paused
                            ? '已暂停'
                            : '生成中'}
                      </Badge>
                    </div>
                    <p className="mb-1 truncate text-[11px] text-god">
                      {activeCast.error ?? activeCast.label}
                    </p>
                    {activeCast.detail ? (
                      <p className="mb-1 truncate text-[10px] text-muted-foreground">{activeCast.detail}</p>
                    ) : null}
                    <div className="mt-auto flex items-center gap-1.5 pt-1">
                      {activeCast.done ? (
                        activeCast.error ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-xs"
                            onClick={() => {
                              void api.ackCast(activeCast.castId)
                              setActiveCasts((prev) => prev.filter((x) => x.castId !== activeCast.castId))
                            }}
                          >
                            知道了
                          </Button>
                        ) : (
                          <Button size="sm" className="h-7 px-2.5 text-xs" onClick={() => setCastOpen(true)}>
                            打开核对草稿
                          </Button>
                        )
                      ) : (
                        <>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 px-2.5 text-xs"
                            onClick={() => void handleCastControl(activeCast.castId, activeCast.paused ? 'resume' : 'pause')}
                          >
                            {activeCast.paused ? (
                              <Play className="mr-1 h-3.5 w-3.5" aria-hidden />
                            ) : (
                              <Pause className="mr-1 h-3.5 w-3.5" aria-hidden />
                            )}
                            {activeCast.paused ? '继续生成' : '暂停生成'}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-xs text-wolf hover:bg-wolf/10 hover:text-wolf"
                            onClick={() => setCancelConfirm(activeCast.castId)}
                          >
                            <Square className="mr-1 h-3 w-3" aria-hidden />
                            终止生成
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="ml-auto h-7 px-2 text-xs text-muted-foreground"
                            onClick={() => setCastOpen(true)}
                          >
                            详情
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                </li>
              ))}
              {cards.map((c) => (
                <li key={c.id} className="flex gap-3 rounded-lg border border-border bg-card p-3">
                  {/* 肖像（身份证式配图；无图用首字占位） */}
                  {c.imageData ? (
                    <img
                      src={c.imageData}
                      alt={c.name}
                      className="h-24 w-[72px] shrink-0 rounded-md border border-border object-cover"
                    />
                  ) : (
                    <span className="flex h-24 w-[72px] shrink-0 items-center justify-center rounded-md border border-border bg-secondary text-3xl font-semibold text-muted-foreground">
                      {c.name.slice(0, 1)}
                    </span>
                  )}
                  <div className="flex min-w-0 flex-1 flex-col">
                    <div className="mb-0.5 flex items-center gap-1.5">
                      <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
                        {c.name}
                      </span>
                      <Badge variant={c.source === 'ai-cast' ? 'default' : 'secondary'} className="px-1.5 text-[10px]">
                        {c.source === 'ai-cast' ? 'AI 铸造' : '手动'}
                      </Badge>
                      {c.inferredCount > 0 ? (
                        <Badge
                          variant="outline"
                          className="border-amber-500/50 px-1.5 text-[10px] font-normal text-amber-600"
                          title="铸魂师资料不足时按心理学原型补全的参数数"
                        >
                          推断 {c.inferredCount}
                        </Badge>
                      ) : null}
                    </div>
                    <p className="mb-1.5 truncate text-[11px] text-muted-foreground">
                      {c.originName
                        ? `${c.originName}${c.originSource ? ` · ${c.originSource}` : ''}`
                        : '原创人格'}
                      {' · '}参战 {c.gameCount} 局
                    </p>
                    <div className="mb-1.5 space-y-0.5">
                      {BIG_FIVE_LABELS.map(({ key, label }) => (
                        <ParamBar key={key} label={label} value={c.bigFive[key]} />
                      ))}
                    </div>
                    <div className="mt-auto flex items-center gap-1.5 pt-1">
                      <span className="flex-1 text-[10px] text-muted-foreground">
                        {formatTime(c.updatedAt)}
                      </span>
                      <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => void openDetail(c.id)} disabled={detailLoading}>
                        详情
                      </Button>
                      <Button size="sm" variant="outline" className="h-7 px-2" onClick={() => void openEdit(c.id)} disabled={busy} aria-label={`编辑 ${c.name}`}>
                        <Pencil className="h-3.5 w-3.5" aria-hidden />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-wolf hover:bg-wolf/10 hover:text-wolf"
                        onClick={() => setDeleteTarget(c)}
                        aria-label={`删除 ${c.name}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden />
                      </Button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <p className="mt-4 text-xs text-muted-foreground">
        下一步：在大厅创建对局时，人格卡库将出现在座位表旁，拖入座位即可以该人格参赛；
        对局中心镜输出人格状态报告，台词由涌现层在参数约束下自由生长（双视角分析、记忆回写在后续阶段接入）。
      </p>

      {/* ================= 编辑器弹窗（新建/编辑共用） ================= */}
      <Dialog open={editor !== null} onOpenChange={(open) => !open && setEditor(null)}>
        <DialogContent className="max-h-[90dvh] max-w-4xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editor?.id === null
                ? editor?.casted
                  ? `铸造草稿核对「${form?.name}」`
                  : '手动建卡'
                : `编辑人格卡「${form?.name}」`}
            </DialogTitle>
            <DialogDescription>
              七组参数全部 0-100 连续量化——不存在二选一，相互冲突的参数会被心镜同时拉扯（铁律6）
            </DialogDescription>
          </DialogHeader>

          {form ? (
            <div className="space-y-6">
              {/* 基本信息 */}
              <section className="space-y-3">
                <h3 className="text-sm font-medium text-foreground">基本信息</h3>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
                  <div className="space-y-1.5">
                    <Label>人格名 *</Label>
                    <Input
                      value={form.name}
                      onChange={(e) =>
                        setEditor((p) => p && { ...p, form: { ...p.form, name: e.target.value } })
                      }
                      placeholder="如：曹操 / 原创人格名"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>原型人物（可空）</Label>
                    <Input
                      value={form.originName}
                      onChange={(e) =>
                        setEditor((p) => p && { ...p, form: { ...p.form, originName: e.target.value } })
                      }
                      placeholder="如：曹操"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>出处（可空）</Label>
                    <Input
                      value={form.originSource}
                      onChange={(e) =>
                        setEditor((p) =>
                          p && { ...p, form: { ...p.form, originSource: e.target.value } },
                        )
                      }
                      placeholder="如：《三国演义》/ 现实人物"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label title="决定其对局中的自我认知：在世=忽然穿越到米勒山谷；已故=死后穿越；原创人格（手动建卡）默认为山谷原住民">
                      在世状态
                    </Label>
                    <Select
                      value={form.aliveStatus ?? 'unset'}
                      onValueChange={(v) =>
                        setEditor((p) =>
                          p && {
                            ...p,
                            form: {
                              ...p.form,
                              aliveStatus: v === 'unset' ? null : (v as 'alive' | 'deceased'),
                            },
                          },
                        )
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="unset">未设定</SelectItem>
                        <SelectItem value="alive">在世（忽然穿越到米勒山谷）</SelectItem>
                        <SelectItem value="deceased">已故（死后穿越到米勒山谷）</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </section>

              {/* 肖像配图（身份证式；可上传/换链/移除） */}
              <section className="space-y-2">
                <h3 className="text-sm font-medium text-foreground">肖像配图</h3>
                <div className="flex items-start gap-3">
                  {form.imageData ? (
                    <img
                      src={form.imageData}
                      alt="肖像"
                      className="h-24 w-[72px] rounded-md border border-border object-cover"
                    />
                  ) : (
                    <span className="flex h-24 w-[72px] items-center justify-center rounded-md border border-dashed border-border bg-secondary/50 text-2xl text-muted-foreground">
                      {form.name.slice(0, 1) || '？'}
                    </span>
                  )}
                  <div className="flex-1 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => document.getElementById('persona-portrait-input')?.click()}
                      >
                        上传图片
                      </Button>
                      <input
                        id="persona-portrait-input"
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={(e) => void handlePortraitFile(e.target.files?.[0] ?? null)}
                      />
                      {form.imageData ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="text-wolf"
                          onClick={() => setEditor((p) => p && { ...p, form: { ...p.form, imageData: null } })}
                        >
                          移除
                        </Button>
                      ) : null}
                    </div>
                    <div className="flex gap-1.5">
                      <Input
                        className="h-8 text-xs"
                        placeholder="或粘贴图片直链 / 人物资料页链接，回车获取"
                        value={portraitUrl}
                        onChange={(e) => setPortraitUrl(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && void handlePortraitFetch()}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-8 shrink-0"
                        disabled={portraitBusy || !portraitUrl.trim()}
                        onClick={() => void handlePortraitFetch()}
                      >
                        {portraitBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : '获取'}
                      </Button>
                    </div>
                    <p className="text-[10px] text-muted-foreground">
                      上传自动缩放到 320px；从链接获取支持图片直链或维基/百科等资料页（自动提取代表图）
                    </p>
                  </div>
                </div>
              </section>

              {/* 人物档案 */}
              <section className="space-y-3">
                <h3 className="text-sm font-medium text-foreground">人物档案（供心镜与涌现层约束）</h3>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label>基本概要</Label>
                    <Textarea
                      rows={3}
                      value={form.summary}
                      onChange={(e) =>
                        setEditor((p) => p && { ...p, form: { ...p.form, summary: e.target.value } })
                      }
                      placeholder="是谁、出处、时代背景（一段）"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>人设与性格画像</Label>
                    <Textarea
                      rows={3}
                      value={form.persona}
                      onChange={(e) =>
                        setEditor((p) => p && { ...p, form: { ...p.form, persona: e.target.value } })
                      }
                      placeholder="性格核心、行事风格、内在矛盾"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>关键经历</Label>
                    <Textarea
                      rows={3}
                      value={form.experiences}
                      onChange={(e) =>
                        setEditor((p) =>
                          p && { ...p, form: { ...p.form, experiences: e.target.value } },
                        )
                      }
                      placeholder="塑造人格的关键事件（创伤/成就/背叛…）"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>重要关系</Label>
                    <Textarea
                      rows={3}
                      value={form.relationships}
                      onChange={(e) =>
                        setEditor((p) =>
                          p && { ...p, form: { ...p.form, relationships: e.target.value } },
                        )
                      }
                      placeholder="人物关系网（谁信任谁、宿怨、羁绊）"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>标志性语录（每行一条，≤5 条）</Label>
                    <Textarea
                      rows={3}
                      value={form.quotesText}
                      onChange={(e) =>
                        setEditor((p) =>
                          p && { ...p, form: { ...p.form, quotesText: e.target.value } },
                        )
                      }
                      placeholder={'宁教我负天下人，休教天下人负我'}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>语言风格</Label>
                    <Textarea
                      rows={3}
                      value={form.speechStyle}
                      onChange={(e) =>
                        setEditor((p) =>
                          p && { ...p, form: { ...p.form, speechStyle: e.target.value } },
                        )
                      }
                      placeholder="用词/节奏/口癖（涌现层的语气锚点）"
                    />
                  </div>
                </div>
              </section>

              {/* 完整档案扩展区（三步铸魂师自动填充；展示/心理检查/记事簿用） */}
              <section className="space-y-3">
                <h3 className="text-sm font-medium text-foreground">
                  完整档案扩展区
                  <span className="ml-2 text-xs font-normal text-muted-foreground">让 TA 更立体（可空；AI 铸造会自动填充）</span>
                </h3>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {(
                    [
                      ['appearance', '外貌与气质', '肖像、体态、给人的感觉（文字版）'],
                      ['values', '价值观与信念', 'TA 信奉什么、底线在哪'],
                      ['desires', '欲望与驱动力', 'TA 想要什么、为什么停不下来'],
                      ['fears', '恐惧与软肋', '什么会点燃 TA、什么让 TA 失眠'],
                      ['socialMask', '社交面具与对外形象', '人前的 TA 是什么样子'],
                      ['innerWorld', '内心世界与隐秘面', '人后的 TA、不敢示人的部分'],
                      ['quirks', '习惯与癖好', '小动作、偏执、怪癖'],
                      ['specialAbilities', '特殊能力（可空）', '原作/设定中的超常能力；到达米勒山谷后全部失效——TA 只是个普通人'],
                    ] as const
                  ).map(([key, label, ph]) => (
                    <div key={key} className="space-y-1.5">
                      <Label>{label}</Label>
                      <Textarea
                        rows={2}
                        value={form[key]}
                        onChange={(e) =>
                          setEditor((p) => p && { ...p, form: { ...p.form, [key]: e.target.value } })
                        }
                        placeholder={ph}
                      />
                    </div>
                  ))}
                </div>
                <div className="space-y-1.5">
                  <Label>
                    人格精粹
                    <span className="ml-2 text-xs font-normal text-god">
                      对局注入专用（≤500 字行为指导）：完整档案再大，对局中驱动 TA 的就是这段
                    </span>
                  </Label>
                  <Textarea
                    rows={4}
                    value={form.essence}
                    onChange={(e) =>
                      setEditor((p) => p && { ...p, form: { ...p.form, essence: e.target.value } })
                    }
                    placeholder="TA 的核心冲突如何表现为具体言行；什么情境会点燃 TA；TA 怎样说话、如何隐藏（AI 铸造会自动生成，可在此基础上精修）"
                  />
                  <p className="text-[10px] text-muted-foreground">
                    心镜与涌现层只注入精粹与语气锚点，完整档案用于展示/心理检查/记事簿——保证信息量大但对局中不失效
                  </p>
                </div>
              </section>

              {/* 参数：大五 */}
              <section className="space-y-3">
                <h3 className="text-sm font-medium text-foreground">大五人格</h3>
                <div className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
                  {BIG_FIVE_LABELS.map(({ key, label }) => (
                    <ParamSlider
                      key={key}
                      label={label}
                      value={form.params.bigFive[key]}
                      inferred={form.params.inferred.includes(`bigFive.${key}`)}
                      onChange={(v) =>
                        patchParams(
                          (p) => ({ ...p, bigFive: { ...p.bigFive, [key]: v } }),
                          `bigFive.${key}`,
                        )
                      }
                    />
                  ))}
                </div>
              </section>

              {/* 参数：依恋 */}
              <section className="space-y-3">
                <h3 className="text-sm font-medium text-foreground">
                  依恋类型
                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                    当前派生：{attachmentLabel(form.params.attachment)}（双轴连续，非二选一）
                  </span>
                </h3>
                <div className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
                  <ParamSlider
                    label="依恋焦虑"
                    hint="对被抛弃/被背叛的敏感度"
                    value={form.params.attachment.anxiety}
                    inferred={form.params.inferred.includes('attachment.anxiety')}
                    onChange={(v) =>
                      patchParams(
                        (p) => ({ ...p, attachment: { ...p.attachment, anxiety: v } }),
                        'attachment.anxiety',
                      )
                    }
                  />
                  <ParamSlider
                    label="依恋回避"
                    hint="对亲密与依赖的回避倾向"
                    value={form.params.attachment.avoidance}
                    inferred={form.params.inferred.includes('attachment.avoidance')}
                    onChange={(v) =>
                      patchParams(
                        (p) => ({ ...p, attachment: { ...p.attachment, avoidance: v } }),
                        'attachment.avoidance',
                      )
                    }
                  />
                </div>
              </section>

              {/* 参数：黑暗四 */}
              <section className="space-y-3">
                <h3 className="text-sm font-medium text-foreground">黑暗四人格</h3>
                <div className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
                  {DARK_LABELS.map(({ key, label }) => (
                    <ParamSlider
                      key={key}
                      label={label}
                      value={form.params.darkTetrad[key]}
                      inferred={form.params.inferred.includes(`darkTetrad.${key}`)}
                      onChange={(v) =>
                        patchParams(
                          (p) => ({ ...p, darkTetrad: { ...p.darkTetrad, [key]: v } }),
                          `darkTetrad.${key}`,
                        )
                      }
                    />
                  ))}
                </div>
              </section>

              {/* 参数：情绪调节 + SDT */}
              <section className="grid grid-cols-1 gap-6 sm:grid-cols-2">
                <div className="space-y-3">
                  <h3 className="text-sm font-medium text-foreground">情绪调节策略</h3>
                  {EMO_LABELS.map(({ key, label }) => (
                    <ParamSlider
                      key={key}
                      label={label}
                      value={form.params.emotionRegulation[key]}
                      inferred={form.params.inferred.includes(`emotionRegulation.${key}`)}
                      onChange={(v) =>
                        patchParams(
                          (p) => ({
                            ...p,
                            emotionRegulation: { ...p.emotionRegulation, [key]: v },
                          }),
                          `emotionRegulation.${key}`,
                        )
                      }
                    />
                  ))}
                </div>
                <div className="space-y-3">
                  <h3 className="text-sm font-medium text-foreground">SDT 动机（自我决定论）</h3>
                  {SDT_LABELS.map(({ key, label }) => (
                    <ParamSlider
                      key={key}
                      label={label}
                      value={form.params.sdt[key]}
                      inferred={form.params.inferred.includes(`sdt.${key}`)}
                      onChange={(v) =>
                        patchParams((p) => ({ ...p, sdt: { ...p.sdt, [key]: v } }), `sdt.${key}`)
                      }
                    />
                  ))}
                </div>
              </section>

              {/* 参数：认知偏差 */}
              <BiasEditor form={form} patchParams={patchParams} />

              {/* 参数：防御机制 */}
              <DefenseEditor form={form} patchParams={patchParams} />

              {/* 研究备注 */}
              <section className="space-y-1.5">
                <Label>研究备注（可空）</Label>
                <Textarea
                  rows={2}
                  value={form.notes}
                  onChange={(e) =>
                    setEditor((p) => p && { ...p, form: { ...p.form, notes: e.target.value } })
                  }
                  placeholder="实验假设、观察重点等"
                />
              </section>

              <div className="flex justify-end gap-2 border-t border-border pt-4">
                <Button variant="outline" onClick={() => setEditor(null)} disabled={busy}>
                  取消
                </Button>
                <Button onClick={() => void handleSave()} disabled={busy}>
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
                  {editor?.id === null ? '创建人格卡' : '保存修改'}
                </Button>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      {/* ================= 详情弹窗 ================= */}
      <Dialog open={detail !== null} onOpenChange={(open) => !open && setDetail(null)}>
        <DialogContent className="max-h-[90dvh] max-w-4xl overflow-y-auto">
          {detail ? (
            <>
              <DialogHeader>
                <div className="flex items-start gap-3">
                  {detail.card.imageData ? (
                    <img
                      src={detail.card.imageData}
                      alt={detail.card.name}
                      className="h-20 w-[60px] rounded-md border border-border object-cover"
                    />
                  ) : (
                    <span className="flex h-20 w-[60px] items-center justify-center rounded-md border border-border bg-secondary text-2xl font-semibold text-muted-foreground">
                      {detail.card.name.slice(0, 1)}
                    </span>
                  )}
                  <div className="min-w-0">
                    <DialogTitle className="flex items-center gap-2">
                      <Brain className="h-5 w-5" aria-hidden />
                      {detail.card.name}
                      <Badge variant={detail.card.source === 'ai-cast' ? 'default' : 'secondary'}>
                        {detail.card.source === 'ai-cast' ? 'AI 铸造' : '手动'}
                      </Badge>
                    </DialogTitle>
                    <DialogDescription>
                      {detail.card.originName
                        ? `原型：${detail.card.originName}${detail.card.originSource ? ` · ${detail.card.originSource}` : ''} · `
                        : ''}
                      {detail.card.profile.aliveStatus === 'deceased'
                        ? '已故（死后穿越到米勒山谷） · '
                        : detail.card.profile.aliveStatus === 'alive'
                          ? '在世（忽然穿越到米勒山谷） · '
                          : detail.card.source === 'manual'
                            ? '米勒山谷原住民 · '
                            : ''}
                      参战 {detail.card.gameCount} 局 · 创建于 {formatTime(detail.card.createdAt)}
                    </DialogDescription>
                  </div>
                </div>
              </DialogHeader>

              <Tabs defaultValue="profile">
                <TabsList>
                  <TabsTrigger value="profile">人物档案</TabsTrigger>
                  <TabsTrigger value="params">人格参数</TabsTrigger>
                  <TabsTrigger value="memories">记忆（{detail.memories.length}）</TabsTrigger>
                  <TabsTrigger value="relations">关系（{detail.relationships.length}）</TabsTrigger>
                  <TabsTrigger value="drift">漂移（{detail.drift.length}）</TabsTrigger>
                  <TabsTrigger value="reports">心理检查报告（{detailReports.length}）</TabsTrigger>
                </TabsList>

                <TabsContent value="profile" className="mt-4 space-y-3 text-sm">
                  {detail.card.profile.essence ? (
                    <div className="rounded-md border border-god/40 bg-god/5 p-3">
                      <p className="mb-1 text-xs font-medium text-god">人格精粹（对局注入专用）</p>
                      <p className="whitespace-pre-wrap leading-6">{detail.card.profile.essence}</p>
                    </div>
                  ) : null}
                  {(
                    [
                      ['基本概要', detail.card.profile.summary],
                      ['人设与性格画像', detail.card.profile.persona],
                      ['外貌与气质', detail.card.profile.appearance ?? ''],
                      ['关键经历', detail.card.profile.experiences],
                      ['重要关系', detail.card.profile.relationships],
                      ['价值观与信念', detail.card.profile.values ?? ''],
                      ['欲望与驱动力', detail.card.profile.desires ?? ''],
                      ['恐惧与软肋', detail.card.profile.fears ?? ''],
                      ['社交面具与对外形象', detail.card.profile.socialMask ?? ''],
                      ['内心世界与隐秘面', detail.card.profile.innerWorld ?? ''],
                      ['习惯与癖好', detail.card.profile.quirks ?? ''],
                      ['特殊能力（山谷中失效）', detail.card.profile.specialAbilities ?? ''],
                      ['语言风格', detail.card.profile.speechStyle],
                    ] as const
                  ).map(([label, text]) =>
                    text ? (
                      <div key={label}>
                        <p className="mb-1 text-xs font-medium text-muted-foreground">{label}</p>
                        <p className="whitespace-pre-wrap rounded-md border border-border bg-secondary/30 p-3 leading-6">
                          {text}
                        </p>
                      </div>
                    ) : null,
                  )}
                  {detail.card.profile.quotes.length > 0 ? (
                    <div>
                      <p className="mb-1 text-xs font-medium text-muted-foreground">标志性语录</p>
                      <ul className="space-y-1">
                        {detail.card.profile.quotes.map((q, i) => (
                          <li key={i} className="text-sm italic text-foreground">
                            “{q}”
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {detail.card.notes ? (
                    <div>
                      <p className="mb-1 text-xs font-medium text-muted-foreground">研究备注</p>
                      <p className="whitespace-pre-wrap text-sm">{detail.card.notes}</p>
                    </div>
                  ) : null}
                </TabsContent>

                <TabsContent value="params" className="mt-4 grid grid-cols-1 gap-6 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <p className="text-xs font-medium text-muted-foreground">大五人格</p>
                    {BIG_FIVE_LABELS.map(({ key, label }) => (
                      <ParamBar key={key} label={label} value={detail.card.params.bigFive[key]} />
                    ))}
                    <p className="pt-2 text-xs font-medium text-muted-foreground">
                      依恋类型（{attachmentLabel(detail.card.params.attachment)}）
                    </p>
                    <ParamBar label="依恋焦虑" value={detail.card.params.attachment.anxiety} />
                    <ParamBar label="依恋回避" value={detail.card.params.attachment.avoidance} />
                  </div>
                  <div className="space-y-1.5">
                    <p className="text-xs font-medium text-muted-foreground">黑暗四人格</p>
                    {DARK_LABELS.map(({ key, label }) => (
                      <ParamBar
                        key={key}
                        label={label}
                        value={detail.card.params.darkTetrad[key]}
                        tone="wolf"
                      />
                    ))}
                  </div>
                  <div className="space-y-1.5">
                    <p className="text-xs font-medium text-muted-foreground">情绪调节策略</p>
                    {EMO_LABELS.map(({ key, label }) => (
                      <ParamBar
                        key={key}
                        label={label}
                        value={detail.card.params.emotionRegulation[key]}
                      />
                    ))}
                    <p className="pt-2 text-xs font-medium text-muted-foreground">SDT 动机</p>
                    {SDT_LABELS.map(({ key, label }) => (
                      <ParamBar key={key} label={label} value={detail.card.params.sdt[key]} />
                    ))}
                  </div>
                  <div className="space-y-2">
                    <p className="text-xs font-medium text-muted-foreground">核心认知偏差</p>
                    {detail.card.params.cognitiveBiases.map((b) => (
                      <ParamBar key={b.id} label={b.label} value={b.strength} />
                    ))}
                    <p className="pt-2 text-xs font-medium text-muted-foreground">防御机制</p>
                    {detail.card.params.defenseMechanisms.map((d) => (
                      <div key={d.id} className="flex items-center gap-2">
                        <Badge variant="outline" className="w-14 justify-center text-[10px] font-normal">
                          {MATURITY_LABEL[d.maturity]}
                        </Badge>
                        <div className="flex-1">
                          <ParamBar label={d.label} value={d.tendency} />
                        </div>
                      </div>
                    ))}
                    {detail.card.params.inferred.length > 0 ? (
                      <p className="pt-2 text-xs text-amber-600">
                        推断项（{detail.card.params.inferred.length}）：
                        {detail.card.params.inferred.join('、')}
                      </p>
                    ) : null}
                  </div>
                </TabsContent>

                <TabsContent value="memories" className="mt-4">
                  {detail.memories.length === 0 ? (
                    <p className="py-8 text-center text-sm text-muted-foreground">
                      暂无记忆。对局结束后，记事簿会把创伤事件与关系变迁自动写入，跨对局保留并支持衰减/强化。
                    </p>
                  ) : (
                    <ul className="space-y-2">
                      {detail.memories.map((m) => (
                        <li key={m.id} className="rounded-md border border-border p-3 text-sm">
                          <div className="mb-1 flex items-center gap-2">
                            <Badge variant={m.type === 'trauma' ? 'destructive' : 'outline'}>
                              {m.type === 'trauma' ? '创伤' : m.type === 'relationship' ? '关系' : '一般'}
                            </Badge>
                            <span className="text-xs text-muted-foreground">
                              强度 {m.strength} · 权重 {m.emotionalWeight} · {formatTime(m.updatedAt)}
                            </span>
                          </div>
                          <p className="whitespace-pre-wrap leading-6">{m.content}</p>
                        </li>
                      ))}
                    </ul>
                  )}
                </TabsContent>

                <TabsContent value="relations" className="mt-4">
                  {detail.relationships.length === 0 ? (
                    <p className="py-8 text-center text-sm text-muted-foreground">
                      暂无关系记录。人格在对局中与其他人格相遇后，关系图谱会自动生成并跨对局传递。
                    </p>
                  ) : (
                    <ul className="space-y-2">
                      {detail.relationships.map((r) => (
                        <li key={r.id} className="rounded-md border border-border p-3 text-sm">
                          <div className="mb-1 flex items-center gap-2">
                            <span className="font-medium">{r.targetName}</span>
                            <Badge variant="outline">{r.relation || '未命名关系'}</Badge>
                            <span className="text-xs text-muted-foreground">
                              亲疏 {r.affinity} · 信任 {r.trust}
                            </span>
                          </div>
                          {r.note ? <p className="text-xs text-muted-foreground">{r.note}</p> : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </TabsContent>

                <TabsContent value="drift" className="mt-4">
                  {detail.drift.length === 0 ? (
                    <p className="py-8 text-center text-sm text-muted-foreground">
                      暂无人格漂移。跨对局记忆可微调长期参数，每次调整都会在此留痕（报告附录）。
                    </p>
                  ) : (
                    <ul className="space-y-2">
                      {detail.drift.map((d) => (
                        <li key={d.id} className="rounded-md border border-border p-3 text-sm">
                          <p className="mb-1 text-xs text-muted-foreground">
                            {formatTime(d.createdAt)}
                            {d.gameId ? ` · 对局 ${d.gameId.slice(0, 8)}` : ''}
                            {d.note ? ` · ${d.note}` : ''}
                          </p>
                          <ul className="space-y-0.5">
                            {d.changes.map((c, i) => (
                              <li key={i} className="font-mono text-xs">
                                {c.path}: {c.from} → {c.to}（{c.reason}）
                              </li>
                            ))}
                          </ul>
                        </li>
                      ))}
                    </ul>
                  )}
                </TabsContent>

                <TabsContent value="reports" className="mt-4">
                  {detailReports.length === 0 ? (
                    <p className="py-8 text-center text-sm text-muted-foreground">
                      暂无心理检查报告。该人格完赛一局后，心理检查师会自动生成《心理检查报告》（三个转折点 +
                      参数撕裂还原）。
                    </p>
                  ) : (
                    <ul className="space-y-2">
                      {detailReports.map((r) => (
                        <li
                          key={r.id}
                          className="flex flex-wrap items-center gap-2 rounded-md border border-border p-3"
                        >
                          <Badge variant="outline" className="border-god/50 text-god">
                            {r.seat}号
                          </Badge>
                          <span className="text-sm font-medium text-foreground">
                            《心理检查报告》
                          </span>
                          <span className="text-xs text-muted-foreground">
                            对局 {r.gameId.slice(0, 8)} · {r.model} · {formatTime(r.createdAt)}
                          </span>
                          <span className="flex-1" />
                          <Button size="sm" variant="outline" onClick={() => setReportView(r)}>
                            阅读
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )}
                </TabsContent>
              </Tabs>
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      {/* 心理检查报告阅读窗 */}
      <Dialog open={reportView !== null} onOpenChange={(open) => !open && setReportView(null)}>
        <DialogContent className="max-h-[85dvh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>《心理检查报告》</DialogTitle>
            <DialogDescription>
              {reportView
                ? `对局 ${reportView.gameId.slice(0, 8)} · ${reportView.seat}号 · ${reportView.model} · ${formatTime(reportView.createdAt)}`
                : ''}
            </DialogDescription>
          </DialogHeader>
          {reportView ? <MarkdownBoard content={reportView.report} /> : null}
        </DialogContent>
      </Dialog>

      {/* AI 铸造向导（铸魂师） */}
      <CastWizard
        open={castOpen}
        onOpenChange={setCastOpen}
        presets={presets}
        onDraftReady={handleDraftReady}
      />

      {/* 删除确认（软删入回收站） */}
      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除人格卡「{deleteTarget?.name}」？</AlertDialogTitle>
            <AlertDialogDescription>
              将移入回收站：30 天内可一键还原（其记忆、关系与漂移历程连体保留、原样恢复），到期自动彻底清除；
              已生成对局中的事件与心理检查报告保留在研究档案中。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction className="bg-wolf text-white hover:bg-wolf/90" onClick={() => void handleDelete()}>
              移入回收站
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 回收站弹窗 */}
      <Dialog open={trashOpen} onOpenChange={setTrashOpen}>
        <DialogContent className="max-h-[85dvh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Trash className="h-5 w-5" aria-hidden />
              回收站
            </DialogTitle>
            <DialogDescription>
              删除的人格卡在此保留 30 天，记忆、关系与漂移历程连体保留；还原即原样恢复，到期自动彻底清除
            </DialogDescription>
          </DialogHeader>
          {trashLoading ? (
            <p className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              正在读取回收站…
            </p>
          ) : trashList.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">回收站为空</p>
          ) : (
            <ul className="space-y-2">
              {trashList.map((e) => (
                <li key={e.id} className="flex items-center gap-3 rounded-lg border border-border bg-card p-3">
                  {e.imageData ? (
                    <img src={e.imageData} alt={e.name} className="h-14 w-11 shrink-0 rounded border border-border object-cover" />
                  ) : (
                    <span className="flex h-14 w-11 shrink-0 items-center justify-center rounded border border-border bg-secondary text-xl font-semibold text-muted-foreground">
                      {e.name.slice(0, 1)}
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
                      <span className="truncate">{e.name}</span>
                      <span className="shrink-0 text-[10px] font-normal text-muted-foreground">
                        {e.originName ? `${e.originName}${e.originSource ? ` · ${e.originSource}` : ''}` : '原创人格'}
                        {' · '}参战 {e.gameCount} 局
                      </span>
                    </p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      删于 {formatTime(e.deletedAt)} · 剩 {trashDaysLeft(e)} 天
                    </p>
                  </div>
                  <Button size="sm" variant="outline" className="h-8 shrink-0 px-2.5 text-xs" onClick={() => void handleRestore(e)}>
                    <RotateCcw className="mr-1 h-3.5 w-3.5" aria-hidden />
                    还原
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-8 shrink-0 px-2 text-wolf hover:bg-wolf/10 hover:text-wolf"
                    onClick={() => setDestroyTarget(e)}
                    aria-label={`彻底删除 ${e.name}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </DialogContent>
      </Dialog>

      {/* 彻底删除二次确认（回收站内） */}
      <AlertDialog open={destroyTarget !== null} onOpenChange={(open) => !open && setDestroyTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>彻底删除「{destroyTarget?.name}」？</AlertDialogTitle>
            <AlertDialogDescription>
              人格卡及其全部记忆、关系与漂移历程将被永久清除，不可恢复（心理检查报告保留在研究档案中）。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>再想想</AlertDialogCancel>
            <AlertDialogAction className="bg-wolf text-white hover:bg-wolf/90" onClick={() => void handleDestroy()}>
              永久删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 终止生成确认（取消并删除整个铸造流程） */}
      <AlertDialog open={cancelConfirm !== null} onOpenChange={(open) => !open && setCancelConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              终止生成「{activeCasts.find((c) => c.castId === cancelConfirm)?.name ?? '新人格'}」？
            </AlertDialogTitle>
            <AlertDialogDescription>
              将取消并删除整个人格生成流程：后台任务立即停止，已生成的草稿一并丢弃，不可恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>继续生成</AlertDialogCancel>
            <AlertDialogAction
              className="bg-wolf text-white hover:bg-wolf/90"
              onClick={() => {
                if (cancelConfirm) void handleCastControl(cancelConfirm, 'cancel')
                setCancelConfirm(null)
              }}
            >
              终止生成
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 认知偏差编辑器：目录点选 + 强度滑杆 + 自定义条目
// ---------------------------------------------------------------------------

function BiasEditor({
  form,
  patchParams,
}: {
  form: PersonaFormState
  patchParams: (mutate: (p: PersonaParams) => PersonaParams, touchedPath?: string) => void
}) {
  const [custom, setCustom] = useState('')
  const selected = form.params.cognitiveBiases
  const has = (id: string) => selected.some((b) => b.id === id)

  function toggle(entry: { id: string; label: string }) {
    patchParams((p) => ({
      ...p,
      cognitiveBiases: has(entry.id)
        ? p.cognitiveBiases.filter((b) => b.id !== entry.id)
        : [...p.cognitiveBiases, { id: entry.id, label: entry.label, strength: 50 }],
    }))
  }

  function setStrength(id: string, v: number) {
    patchParams(
      (p) => ({
        ...p,
        cognitiveBiases: p.cognitiveBiases.map((b) => (b.id === id ? { ...b, strength: v } : b)),
      }),
      `cognitiveBiases.${id}`,
    )
  }

  function addCustom() {
    const label = custom.trim()
    if (!label || has(label)) return
    patchParams((p) => ({
      ...p,
      cognitiveBiases: [...p.cognitiveBiases, { id: label, label, strength: 50 }],
    }))
    setCustom('')
  }

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-medium text-foreground">
        核心认知偏差
        <span className="ml-2 text-xs font-normal text-muted-foreground">点选常用项后微调强度（2-7 条为宜）</span>
      </h3>
      <div className="flex flex-wrap gap-1.5">
        {COGNITIVE_BIAS_CATALOG.map((c) => (
          <button
            key={c.id}
            type="button"
            title={c.hint}
            onClick={() => toggle(c)}
            className={cn(
              'rounded-full border px-2.5 py-1 text-xs transition-colors',
              has(c.id)
                ? 'border-god bg-god/10 text-god'
                : 'border-border text-muted-foreground hover:border-muted-foreground/50',
            )}
          >
            {c.label}
          </button>
        ))}
        <span className="flex items-center gap-1">
          <Input
            className="h-7 w-28 text-xs"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            placeholder="自定义偏差"
            onKeyDown={(e) => e.key === 'Enter' && addCustom()}
          />
          <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={addCustom}>
            添加
          </Button>
        </span>
      </div>
      <div className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
        {selected.map((b: CognitiveBiasEntry) => (
          <ParamSlider
            key={b.id}
            label={b.label}
            value={b.strength}
            inferred={form.params.inferred.includes(`cognitiveBiases.${b.id}`)}
            onChange={(v) => setStrength(b.id, v)}
          />
        ))}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// 防御机制编辑器：目录点选（带成熟度） + 倾向滑杆 + 自定义条目
// ---------------------------------------------------------------------------

function DefenseEditor({
  form,
  patchParams,
}: {
  form: PersonaFormState
  patchParams: (mutate: (p: PersonaParams) => PersonaParams, touchedPath?: string) => void
}) {
  const [custom, setCustom] = useState('')
  const selected = form.params.defenseMechanisms
  const has = (id: string) => selected.some((d) => d.id === id)

  function toggle(entry: { id: string; label: string; maturity: DefenseMechanismEntry['maturity'] }) {
    patchParams((p) => ({
      ...p,
      defenseMechanisms: has(entry.id)
        ? p.defenseMechanisms.filter((d) => d.id !== entry.id)
        : [...p.defenseMechanisms, { ...entry, tendency: 50 }],
    }))
  }

  function setTendency(id: string, v: number) {
    patchParams(
      (p) => ({
        ...p,
        defenseMechanisms: p.defenseMechanisms.map((d) => (d.id === id ? { ...d, tendency: v } : d)),
      }),
      `defenseMechanisms.${id}`,
    )
  }

  function addCustom() {
    const label = custom.trim()
    if (!label || has(label)) return
    patchParams((p) => ({
      ...p,
      defenseMechanisms: [
        ...p.defenseMechanisms,
        { id: label, label, tendency: 50, maturity: 'neurotic' },
      ],
    }))
    setCustom('')
  }

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-medium text-foreground">
        防御机制
        <span className="ml-2 text-xs font-normal text-muted-foreground">压力下的人格护盾（2-7 条为宜）</span>
      </h3>
      <div className="flex flex-wrap gap-1.5">
        {DEFENSE_MECHANISM_CATALOG.map((c) => (
          <button
            key={c.id}
            type="button"
            title={`${MATURITY_LABEL[c.maturity]} · ${c.hint}`}
            onClick={() => toggle(c)}
            className={cn(
              'rounded-full border px-2.5 py-1 text-xs transition-colors',
              has(c.id)
                ? 'border-god bg-god/10 text-god'
                : 'border-border text-muted-foreground hover:border-muted-foreground/50',
            )}
          >
            {c.label}
          </button>
        ))}
        <span className="flex items-center gap-1">
          <Input
            className="h-7 w-28 text-xs"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            placeholder="自定义机制"
            onKeyDown={(e) => e.key === 'Enter' && addCustom()}
          />
          <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={addCustom}>
            添加
          </Button>
        </span>
      </div>
      <div className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
        {selected.map((d) => (
          <div key={d.id} className="flex items-center gap-2">
            <Badge variant="outline" className="w-14 shrink-0 justify-center text-[10px] font-normal">
              {MATURITY_LABEL[d.maturity]}
            </Badge>
            <div className="flex-1">
              <ParamSlider
                label={d.label}
                value={d.tendency}
                inferred={form.params.inferred.includes(`defenseMechanisms.${d.id}`)}
                onChange={(v) => setTendency(d.id, v)}
              />
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
