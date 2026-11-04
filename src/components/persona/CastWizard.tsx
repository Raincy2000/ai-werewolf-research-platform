/**
 * 铸魂师 AI 铸造向导：输入人物名 → 联网消歧检索 → 用户确认对象 → 双 AI 铸造 → 草稿送入编辑器。
 * 双 AI 协作（用户决策）：检索 AI（默认 Kimi，联网）负责信息采集；整合 AI 负责量化成卡。
 * 配置持久化在 localStorage（aiwerewolf.caster.v1），可从 API 存档库一键导入四要素。
 */

import { useEffect, useState } from 'react'
import { CircleAlert, Loader2, Pencil, RefreshCw, Search, Sparkles, Wand2 } from 'lucide-react'
import type {
  AiProvider,
  ApiPreset,
  CastProgressState,
  CasterCandidate,
  PersonaCardInput,
  PersonaCastResult,
} from '@/lib/gameApi'
import { COGNITION_NOTE_ENABLED, getProviderPreset, useGameApi } from '@/lib/gameApi'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { CastStageBar } from './CastStageBar'

// ---------------------------------------------------------------------------
// 铸魂师双 AI 配置（localStorage 持久化）
// ---------------------------------------------------------------------------

const CASTER_STORAGE_KEY = 'aiwerewolf.caster.v1'

interface Quad {
  provider: AiProvider
  baseUrl: string
  model: string
  apiKey: string
}

interface CasterSettings {
  search: Quad // ① 搜集 AI（默认 Kimi：联网检索，保证真实可靠）
  understand: Quad // ② 深读 AI（透过表象把握人物核心）
  synth: Quad // ③ 整合 AI（整合①②成果 → 完整档案 + 量化参数）
  web: { s1: boolean; s2: boolean; s3: boolean } // 分阶段联网检索开关（默认全开）
  deep: { segmented: boolean; critique: boolean } // 深读深度：分段深挖 + 自我批判复读（默认双开）
}

function defaultCasterSettings(): CasterSettings {
  const kimi = getProviderPreset('kimi')
  const blank: Quad = { provider: 'kimi', baseUrl: kimi.baseUrl, model: '', apiKey: '' }
  return {
    search: { ...blank },
    understand: { ...blank },
    synth: { ...blank },
    web: { s1: true, s2: true, s3: true },
    deep: { segmented: true, critique: true },
  }
}

function loadCasterSettings(): CasterSettings {
  const d = defaultCasterSettings()
  try {
    const raw = localStorage.getItem(CASTER_STORAGE_KEY)
    if (!raw) return d
    const parsed = JSON.parse(raw) as Partial<CasterSettings> & { search?: Quad; synth?: Quad }
    return {
      // v1 → v2 迁移：旧 search 沿用为①搜集；旧 synth 沿用为③整合；②深读默认随③
      search: { ...d.search, ...(parsed.search ?? {}) },
      understand: { ...d.understand, ...(parsed.understand ?? parsed.synth ?? {}) },
      synth: { ...d.synth, ...(parsed.synth ?? {}) },
      web: { ...d.web, ...(parsed.web ?? {}) },
      deep: { ...d.deep, ...(parsed.deep ?? {}) },
    }
  } catch {
    return d
  }
}

function saveCasterSettings(s: CasterSettings): void {
  try {
    localStorage.setItem(CASTER_STORAGE_KEY, JSON.stringify(s))
  } catch {
    /* 隐私模式忽略 */
  }
}

function quadComplete(q: Quad): boolean {
  return Boolean(q.model.trim() && q.apiKey.trim() && (q.provider === 'anthropic' || q.baseUrl.trim()))
}

// ---------------------------------------------------------------------------
// 配置编辑块（从存档导入 / 手动四要素）
// ---------------------------------------------------------------------------

function QuadEditor({
  title,
  desc,
  quad,
  presets,
  onChange,
}: {
  title: string
  desc: string
  quad: Quad
  presets: ApiPreset[]
  onChange: (q: Quad) => void
}) {
  return (
    <div className="space-y-3 rounded-lg border border-border bg-card p-4">
      {/* 标题行：环节名 + 职责说明 + 从存档导入 */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-sm font-semibold text-foreground">{title}</span>
        <span className="min-w-0 flex-1 text-[11px] leading-4 text-muted-foreground">{desc}</span>
        <Select
          value=""
          onValueChange={(id) => {
            const p = presets.find((x) => String(x.id) === id)
            if (p) onChange({ provider: p.provider, baseUrl: p.baseUrl, model: p.model, apiKey: p.apiKey })
          }}
        >
          <SelectTrigger className="h-8 w-36 shrink-0 text-xs">
            <SelectValue placeholder="从存档导入" />
          </SelectTrigger>
          <SelectContent>
            {presets.length === 0 ? (
              <SelectItem value="__none__" disabled>
                暂无存档
              </SelectItem>
            ) : (
              presets.map((p) => (
                <SelectItem key={p.id} value={String(p.id)}>
                  {p.name}
                </SelectItem>
              ))
            )}
          </SelectContent>
        </Select>
      </div>
      {/* 四要素：标签化两列网格，宽松不挤压 */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label className="text-xs">Provider</Label>
          <Select value={quad.provider} onValueChange={(v) => {
            const provider = v as AiProvider
            onChange({ ...quad, provider, baseUrl: getProviderPreset(provider).baseUrl })
          }}>
            <SelectTrigger className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(['kimi', 'openai', 'deepseek', 'custom', 'anthropic'] as const).map((p) => (
                <SelectItem key={p} value={p}>
                  {getProviderPreset(p).label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">模型</Label>
          <Input
            className="h-9"
            placeholder="如 kimi-k2.5 / deepseek-v4-pro"
            value={quad.model}
            onChange={(e) => onChange({ ...quad, model: e.target.value })}
          />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label className="text-xs">Base URL</Label>
          <Input
            className="h-9"
            placeholder="https://api.example.com/v1"
            value={quad.baseUrl}
            onChange={(e) => onChange({ ...quad, baseUrl: e.target.value })}
          />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label className="text-xs">API Key</Label>
          <Input
            className="h-9"
            type="password"
            placeholder="sk-..."
            autoComplete="off"
            value={quad.apiKey}
            onChange={(e) => onChange({ ...quad, apiKey: e.target.value })}
          />
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 向导主体
// ---------------------------------------------------------------------------

type Step = 'input' | 'candidates' | 'batchCands' | 'casting' | 'draft'

/** 行式名单的一行：人格名 + 消歧提示 + 该行独立的三 AI 配置与流程开关（配置框默认收起） */
interface CastRow {
  name: string
  hint: string
  cfg: CasterSettings
  expanded: boolean
}

export function CastWizard({
  open,
  onOpenChange,
  presets,
  onDraftReady,
  targetCastId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  presets: ApiPreset[]
  onDraftReady: (draft: PersonaCardInput, castId?: string | null) => void
  // 指名打开的铸造任务（草稿箱/生成中卡片入口）：精确恢复该任务，不再「猜最近的」
  targetCastId?: string | null
}) {
  const api = useGameApi()
  const [step, setStep] = useState<Step>('input')
  // 每行独立配置（新增行默认复制第一行此刻的配置；首行配置改动持久化到 localStorage）
  const [rows, setRows] = useState<CastRow[]>(() => [{ name: '', hint: '', cfg: loadCasterSettings(), expanded: false }])
  const [candidates, setCandidates] = useState<CasterCandidate[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [castResult, setCastResult] = useState<PersonaCastResult | null>(null)
  const [castStage, setCastStage] = useState(0)
  // 真实铸造进度（后端 persona.castProgress 轮询；castId 每次任务新生成）
  const [castId, setCastId] = useState<string | null>(null)
  const [progress, setProgress] = useState<CastProgressState | null>(null)
  // 批量身份核对（每人一格候选，默认选首候选；无候选的行自动跳过并注明）
  const [batchCands, setBatchCands] = useState<
    { name: string; hint: string; cfg: CasterSettings; cands: CasterCandidate[]; selected: number; error: string | null }[] | null
  >(null)
  // 单轮的 name/hint 即 rows[0]（行式名单的第一行）——派生存取，单一事实源
  const name = rows[0]?.name ?? ''
  const hint = rows[0]?.hint ?? ''


  // 铸造阶段的轮播提示（进度未回传时的兜底；有真实进度后由 progress 顶替）
  useEffect(() => {
    if (step !== 'casting') return
    setCastStage(0)
    const t1 = setTimeout(() => setCastStage(1), 10_000)
    const t2 = setTimeout(() => setCastStage(2), 40_000)
    const t3 = setTimeout(() => setCastStage(3), 90_000)
    return () => {
      clearTimeout(t1)
      clearTimeout(t2)
      clearTimeout(t3)
    }
  }, [step])

  // 任务进行期间每 2s 轮询一次真实进度（阶段 label + 细节行：生成字数/检索轮次）；
  // 终态接管：成功进草稿步，失败回候选步报错
  useEffect(() => {
    if (!busy || !castId) return
    let stop = false
    const tick = async () => {
      try {
        const p = await api.getCastProgress(castId)
        if (stop || !p) return
        setProgress(p)
        if (!p.done) return
        setBusy(false)
        if (p.error) {
          setError(p.error)
          setStep('candidates')
        } else if (p.result) {
          setCastResult(p.result)
          setNotice(p.result.notice ?? null)
          setStep('draft')
        } else {
          setError('铸造异常结束（无结果），可重试')
          setStep('candidates')
        }
      } catch {
        /* 轮询失败忽略，下轮再试 */
      }
    }
    void tick()
    const t = setInterval(() => void tick(), 2000)
    return () => {
      stop = true
      clearInterval(t)
    }
  }, [busy, castId, api])

  // 向导打开时的现场恢复（20261013 重订）：
  // - 指名 targetCastId（草稿箱/生成中卡片点入）：精确恢复该任务——完成且有产物→草稿步，
  //   进行中/已暂停→铸造步接管轮询（批量并发铸造不再串台：不再「猜最近一个」）
  // - 裸开（「AI 铸造」按钮）：只接管进行中的任务；已完成草稿一律留在草稿箱等用户点取，
  //   绝不自动弹出（草稿是用户资产，长期保存，只有用户主动删除才会消失）
  useEffect(() => {
    if (!open) return
    let cancelled = false
    void (async () => {
      try {
        const active = targetCastId
          ? await api.getCastProgress(targetCastId)
          : await api.getCastActive()
        if (cancelled) return
        if (!active) {
          // 指名打开但任务不存在（已被取走/清除）：显式告知，绝不静默落在新建页（20261014 实锤）
          if (targetCastId) setError('该铸造任务已不存在（草稿可能已被取走或删除）')
          return
        }
        if (active.done) {
          // 草稿步只在「指名打开」时进入（裸开不打扰草稿箱）；
          // 指名打开不受陈旧 step/busy 影响（上次会话残留曾把用户绊在新建页）
          if (targetCastId && active.result) {
            setCastId(active.castId)
            setCastResult(active.result)
            setNotice(active.result.notice ?? null)
            setBusy(false)
            setStep('draft')
          }
          return
        }
        // 进行中/已暂停：仅指名打开（人格卡「详情」/草稿箱「查看进度」）才接管进度页；
        // 裸开（点「AI 铸造」按钮）一律进新建主页——2026-10-14 用户裁定：
        // 进行中的进程已有固定入口，铸造按钮只负责发起新的铸造
        if (targetCastId) {
          setCastId(active.castId)
          setProgress(active)
          setBusy(true)
          setStep('casting')
        }
      } catch {
        /* 找回失败忽略 */
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, targetCastId])

  function updateRowCfg(i: number, patch: Partial<CasterSettings>) {
    setRows((prev) =>
      prev.map((r, j) => {
        if (j !== i) return r
        const next = { ...r.cfg, ...patch }
        if (j === 0) saveCasterSettings(next) // 首行配置持久化（新增行的默认模板）
        return { ...r, cfg: next }
      }),
    )
  }

  function reset() {
    setStep('input')
    setCandidates([])
    setCastResult(null)
    setError(null)
    setNotice(null)
    setCastId(null)
    setProgress(null)
    setBusy(false)
    setRows([{ name: '', hint: '', cfg: loadCasterSettings(), expanded: false }])
    setBatchCands(null)
  }

  /** 统一检索入口：一行=旧单轮流程；多行=逐行并行消歧检索，进批量身份核对步 */
  async function handleResearchAll() {
    const items = rows
      .map((r) => ({ name: r.name.trim(), hint: r.hint.trim(), cfg: r.cfg }))
      .filter((r) => r.name)
      .slice(0, 12)
    if (items.length === 0) {
      setError('请先输入人物名')
      return
    }
    if (items.length === 1) return handleResearch()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      // 逐行并行检索（复用单轮消歧接口；共享①搜集 AI 配置）
      const results = await Promise.all(
        items.map(async (it) => {
          try {
            if (!quadComplete(it.cfg.search)) {
              return { name: it.name, hint: it.hint, cands: [], selected: 0, error: 'AI 配置不完整（搜集 AI 缺模型或 Key）' }
            }
            const r = await api.researchPersona({
              name: it.name,
              hint: it.hint || undefined,
              searchAi: it.cfg.search,
              webSearch: it.cfg.web.s1,
              castId: crypto.randomUUID(),
            })
            return { name: it.name, hint: it.hint, cands: r.candidates, selected: 0, error: null }
          } catch (err) {
            return {
              name: it.name,
              hint: it.hint,
              cands: [],
              selected: 0,
              error: err instanceof Error ? err.message : '检索失败',
            }
          }
        }),
      )
      setBatchCands(results.map((r, i) => ({ ...r, cfg: items[i]!.cfg })))
      setStep('batchCands')
    } finally {
      setBusy(false)
    }
  }

  /** 批量确认铸造：逐行入队铸魂生产队列（选定的候选对象；无候选行跳过） */
  function handleBatchConfirm() {
    if (!batchCands) return
    const picked = batchCands.filter((r) => r.cands.length > 0 && r.selected >= 0)
    if (picked.length === 0) {
      setError('没有可铸造的对象（全部检索失败或无候选）')
      return
    }
    for (const r of picked) {
      const c = r.cands[r.selected]!
      void api.castPersona({
        name: c.name,
        source: c.source || undefined,
        hint: r.hint || undefined,
        searchAi: r.cfg.search,
        understandAi: r.cfg.understand,
        synthAi: r.cfg.synth,
        web: { stage1: r.cfg.web.s1, stage2: r.cfg.web.s2, stage3: r.cfg.web.s3 },
        deepRead: { segmented: r.cfg.deep.segmented, selfCritique: r.cfg.deep.critique },
        castId: crypto.randomUUID(),
      })
    }
    setNotice(
      `已入队 ${picked.length} 项铸造（滚动并发窗 2 个、排队进行）：各人格的生成进度见人格研究站卡列表顶部的卡片，可随时暂停/终止；完成后草稿入草稿箱长期保存。`,
    )
    setRows((prev) => [{ name: '', hint: '', cfg: prev[0]!.cfg, expanded: true }])
    setBatchCands(null)
    setStep('input')
  }

  async function handleResearch() {
    if (!name.trim() || busy) return
    setBusy(true)
    setError(null)
    const id = crypto.randomUUID()
    setCastId(id)
    setProgress(null)
    try {
      const r = await api.researchPersona({
        name: name.trim(),
        hint: hint.trim() || undefined,
        searchAi: rows[0]!.cfg.search,
        webSearch: rows[0]!.cfg.web.s1,
        castId: id,
      })
      setCandidates(r.candidates)
      setNotice(r.notice ?? null)
      if (r.candidates.length === 0) {
        setError(`没有找到与「${name.trim()}」对应的人物。可补充提示（如作品名/领域）后重试。`)
      } else {
        setStep('candidates')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '检索失败，请检查检索 AI 配置')
    } finally {
      setBusy(false)
    }
  }

  async function handleCast(c: CasterCandidate) {
    if (busy) return
    setBusy(true)
    setError(null)
    setStep('casting')
    const id = crypto.randomUUID()
    setCastId(id)
    setProgress(null)
    try {
      // 异步任务模式：启动立即返回；完成/失败由进度轮询接管（界面关掉重开也不丢）
      await api.castPersona({
        name: c.name,
        source: c.source || undefined,
        hint: hint.trim() || undefined,
        searchAi: rows[0]!.cfg.search,
        understandAi: rows[0]!.cfg.understand,
        synthAi: rows[0]!.cfg.synth,
        web: { stage1: rows[0]!.cfg.web.s1, stage2: rows[0]!.cfg.web.s2, stage3: rows[0]!.cfg.web.s3 },
        deepRead: { segmented: rows[0]!.cfg.deep.segmented, selfCritique: rows[0]!.cfg.deep.critique },
        castId: id,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : '铸造启动失败，可重试')
      setStep('candidates')
      setBusy(false)
    }
  }

  const searchOk = rows.every((r) => !r.name.trim() || quadComplete(r.cfg.search))
  const understandOk = rows.every((r) => !r.name.trim() || quadComplete(r.cfg.understand))
  const synthOk = rows.every((r) => !r.name.trim() || quadComplete(r.cfg.synth))

  const CAST_STAGES = [
    '① 搜集 AI 正在全网搜集人物资料（生平/人设/经历/关系/语录，真实可靠第一）…',
    '② 深读 AI 正在透过表象把握人物核心（分段深挖：人格结构/冲突防御/依恋关系/压力与语言）…',
    '② 深读 AI 正在自我批判复读（揪出无据推测、恢复被调和的冲突）…',
    '③ 整合 AI 正在生成完整档案并量化七组参数（含肖像挑选）…',
  ]

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) reset(); onOpenChange(o) }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-[min(1100px,94dvw)]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5" aria-hidden />
            AI 铸造 · 铸魂师
          </DialogTitle>
          <DialogDescription className="leading-6">
            输入现实或虚拟人物名，铸魂师联网检索并消歧；确认对象后三位 AI 接力铸造——①搜集资料（真实可靠）
            → ②深入理解（把握人物核心）→ ③整合量化（完整档案 + 七组参数 + 肖像搜取）
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <p className="flex items-center gap-1.5 text-sm text-wolf">
            <CircleAlert className="h-4 w-4 shrink-0" aria-hidden />
            {error}
          </p>
        ) : null}
        {notice ? (
          <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-[13px] leading-6 text-amber-600 dark:text-amber-400">
            {notice}
          </p>
        ) : null}

        {/* 第一步：人物名 + 双 AI 配置 */}
        {/* 第一步：行式名单 + 每行独立 AI 配置（新增行默认复制首行配置，后可自改） */}
        {step === 'input' ? (
          <div className="space-y-4">
            {/* 顶部提醒（用户裁定的两点提示）：并发额度与独立配置注意事项 */}
            <p className="rounded-md border border-god/30 bg-god/5 px-3 py-2 text-[12px] leading-5 text-muted-foreground">
              同一 API 最多同时铸造 2 个人格（约 6 条流程），超出自动排队——不同 API 的人格可以并行；每个人格可独立配置
              AI（新增行默认跟随第一行，点笔图标展开修改），配置不完整的行会在核对页标出、不会混入铸造。
            </p>
            {rows.map((row, i) => (
              <div key={i} className="space-y-2.5 rounded-xl border border-border p-3">
                {/* 名单框：人格名+消歧提示缩短，右侧双方块按钮（笔=展开/定位配置框，叉=删除行） */}
                <div className="flex items-start gap-2">
                  <div className="grid flex-1 grid-cols-1 gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      {i === 0 ? <Label>人物名 *</Label> : null}
                      <Input
                        value={row.name}
                        onChange={(e) =>
                          setRows((prev) => prev.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)))
                        }
                        placeholder={i === 0 ? '如：曹操 / 福尔摩斯 / 马斯克' : '再一个人物名'}
                        onKeyDown={(e) => e.key === 'Enter' && void handleResearchAll()}
                      />
                    </div>
                    <div className="space-y-1.5">
                      {i === 0 ? <Label>消歧提示（可空）</Label> : null}
                      <Input
                        value={row.hint}
                        onChange={(e) =>
                          setRows((prev) => prev.map((r, j) => (j === i ? { ...r, hint: e.target.value } : r)))
                        }
                        placeholder={i === 0 ? '如：《三国演义》里的，不是其他人' : '消歧提示（可空）'}
                      />
                    </div>
                  </div>
                  <div className={`flex shrink-0 gap-1.5 ${i === 0 ? 'mt-6' : ''}`}>
                    <Button
                      size="icon"
                      variant={row.expanded ? 'default' : 'outline'}
                      className="h-9 w-9"
                      title={row.expanded ? '收起该人格的 AI 配置' : '展开/编辑该人格的 AI 配置'}
                      onClick={() =>
                        setRows((prev) => prev.map((r, j) => (j === i ? { ...r, expanded: !r.expanded } : r)))
                      }
                    >
                      <Pencil className="h-4 w-4" aria-hidden />
                    </Button>
                    {rows.length > 1 ? (
                      <Button
                        size="icon"
                        variant="outline"
                        className="h-9 w-9 text-muted-foreground hover:text-wolf"
                        title="移除这个人格"
                        onClick={() => setRows((prev) => prev.filter((_, j) => j !== i))}
                      >
                        ✕
                      </Button>
                    ) : null}
                  </div>
                </div>
                {/* AI 配置框（手风琴动画：grid-rows 0fr→1fr 展开/收起过渡；
                    新增人格时旧配置框自动折叠、新框展开） */}
                <div
                  className={`grid transition-all duration-300 ease-in-out ${
                    row.expanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
                  }`}
                  aria-hidden={!row.expanded}
                >
                  <div className="overflow-hidden">
                    <div className="space-y-3 rounded-lg border border-god/30 bg-god/5 p-3">
                    {i > 0 ? (
                      <p className="text-[11px] text-muted-foreground">
                        「{row.name || `第 ${i + 1} 个人格`}」的独立配置（默认跟随第一行，可自改）
                      </p>
                    ) : null}
                    <QuadEditor
                      title="① 搜集 AI"
                      desc="全网搜集人物资料，真实可靠第一（默认 Kimi，内置 $web_search；换其他家则退化为内部知识）"
                      quad={row.cfg.search}
                      presets={presets}
                      onChange={(q) => updateRowCfg(i, { search: q })}
                    />
                    <QuadEditor
                      title="② 深读 AI"
                      desc="透过表象把握人物核心（核心人格结构/内在冲突/创伤防御/动机系统；建议推理强模型）"
                      quad={row.cfg.understand}
                      presets={presets}
                      onChange={(q) => updateRowCfg(i, { understand: q })}
                    />
                    <QuadEditor
                      title="③ 整合 AI"
                      desc="整合①②成果 → 完整人物档案 + 七组量化参数（建议长上下文模型）"
                      quad={row.cfg.synth}
                      presets={presets}
                      onChange={(q) => updateRowCfg(i, { synth: q })}
                    />
                    {/* 分阶段联网开关 + 深读深度（每行独立） */}
                    <div className="space-y-2.5 rounded-lg border border-border bg-card p-4">
                      <p className="text-sm font-semibold text-foreground">流程开关</p>
                      {(
                        [
                          ['s1', '①搜集时联网检索（模型原生联网 + 服务端证据池实搜）'],
                          ['s2', '②深读时联网检索（注入评论/访谈/分析旁证材料）'],
                          ['s3', '③整合时联网检索（事实核对与肖像佐证）'],
                        ] as const
                      ).map(([k, label]) => (
                        <div key={k} className="flex items-center justify-between gap-3">
                          <Label className="cursor-pointer text-xs font-normal leading-5 text-muted-foreground">{label}</Label>
                          <Switch
                            className="shrink-0"
                            checked={row.cfg.web[k]}
                            onCheckedChange={(v) => updateRowCfg(i, { web: { ...row.cfg.web, [k]: v } })}
                          />
                        </div>
                      ))}
                      <div className="flex items-center justify-between gap-3 border-t border-border/60 pt-2.5">
                        <Label className="cursor-pointer text-xs font-normal leading-5 text-muted-foreground">
                          ②深度深读（四段分段深挖 + 自我批判复读；更慢更透，关掉即快速模式）
                        </Label>
                        <Switch
                          className="shrink-0"
                          checked={row.cfg.deep.segmented && row.cfg.deep.critique}
                          onCheckedChange={(v) => updateRowCfg(i, { deep: { segmented: v, critique: v } })}
                        />
                      </div>
                    </div>
                    </div>
                  </div>
                </div>
                {!row.expanded ? (
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-md border border-dashed border-border px-3 py-1.5 text-left text-[11px] text-muted-foreground transition-colors hover:border-god/40 hover:text-god"
                    onClick={() =>
                      setRows((prev) => prev.map((r, j) => (j === i ? { ...r, expanded: true } : r)))
                    }
                  >
                    AI 配置：{row.cfg.search.model || '未设'} / {row.cfg.understand.model || '未设'} / {row.cfg.synth.model || '未设'}（点此处或笔图标展开）
                  </button>
                ) : null}
              </div>
            ))}
            {/* 批量加行入口：虚线矩形（新行默认复制首行此刻的配置；
                手风琴：旧配置框全部自动折叠，新框展开待配置） */}
            {rows.length < 12 ? (
              <button
                type="button"
                onClick={() =>
                  setRows((prev) => [
                    ...prev.map((r) => ({ ...r, expanded: false })),
                    { name: '', hint: '', cfg: JSON.parse(JSON.stringify(prev[0]!.cfg)) as CasterSettings, expanded: true },
                  ])
                }
                className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-god/40 bg-god/5 px-4 py-2.5 text-[13px] text-god transition-colors hover:bg-god/10"
              >
                <Wand2 className="h-3.5 w-3.5" aria-hidden />
                批量生成更多人格
              </button>
            ) : null}
            {busy && progress ? (
              <p className="text-xs text-god">
                {progress.label}
                {progress.detail ? ` · ${progress.detail}` : ''}
              </p>
            ) : null}
            <div className="flex items-center justify-between border-t border-border pt-3">
              <p className="text-xs text-muted-foreground">
                {!searchOk || !understandOk || !synthOk
                  ? '有行的 AI 配置不完整（模型 + API Key）——核对页会标出，不完整行不会混入铸造'
                  : rows.filter((r) => r.name.trim()).length > 1
                    ? `配置就绪，开始检索（${rows.filter((r) => r.name.trim()).length} 人逐人消歧，齐全后统一核对）`
                    : '配置就绪，开始检索消歧'}
              </p>
              <Button
                onClick={() => void handleResearchAll()}
                disabled={busy || rows.every((r) => !r.name.trim())}
              >
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <Search className="h-4 w-4" aria-hidden />
                )}
                开始检索
              </Button>
            </div>
          </div>
        ) : null}

        {/* 第二步：候选确认（重名消歧） */}
        {step === 'candidates' ? (
          <div className="space-y-3">
            <p className="text-sm leading-6 text-muted-foreground">
              检索到 {candidates.length} 个候选对象。请确认要铸造的人物（附录其基本信息）：
            </p>
            <ul className="space-y-2.5">
              {candidates.map((c, i) => (
                <li key={i} className="rounded-lg border border-border p-4">
                  <div className="mb-1.5 flex items-center gap-2">
                    <span className="text-[15px] font-semibold text-foreground">{c.name}</span>
                    <Badge variant="outline">{c.source || '出处未知'}</Badge>
                    <span className="text-xs text-muted-foreground">{c.identity}</span>
                  </div>
                  <p className="mb-3 text-[13px] leading-6 text-muted-foreground">{c.summary}</p>
                  <Button size="sm" onClick={() => void handleCast(c)} disabled={busy}>
                    <Wand2 className="h-3.5 w-3.5" aria-hidden />
                    确认铸造此对象
                  </Button>
                </li>
              ))}
            </ul>
            <div className="flex justify-between border-t border-border pt-3">
              <Button variant="ghost" onClick={reset}>
                都不是，返回重检
              </Button>
            </div>
          </div>
        ) : null}

        {/* 批量身份核对（与单轮同一套候选卡片语言：每人一格、默认首候选、可改选） */}
        {step === 'batchCands' && batchCands ? (
          <div className="space-y-4">
            <p className="text-sm leading-6 text-muted-foreground">
              逐人确认要铸造的对象（默认选定首候选；检索失败的行自动跳过）：
            </p>
            <div className="space-y-4">
              {batchCands.map((row, ri) => (
                <div key={ri} className="rounded-lg border border-border p-4">
                  <p className="mb-2.5 flex items-center gap-2 text-sm font-semibold text-foreground">
                    {row.name}
                    {row.hint ? (
                      <span className="text-xs font-normal text-muted-foreground">（{row.hint}）</span>
                    ) : null}
                    {row.cands.length === 0 ? (
                      <Badge variant="outline" className="border-wolf/50 text-wolf">
                        {row.error ? `检索失败：${row.error}` : '查无此人，将跳过'}
                      </Badge>
                    ) : (
                      <Badge variant="outline">{row.cands.length} 个候选</Badge>
                    )}
                  </p>
                  {row.cands.length > 0 ? (
                    <div className="space-y-2">
                      {row.cands.map((c, ci) => (
                        <button
                          key={ci}
                          type="button"
                          onClick={() =>
                            setBatchCands((prev) =>
                              prev && prev.map((r, j) => (j === ri ? { ...r, selected: ci } : r)),
                            )
                          }
                          className={`w-full rounded-lg border p-3 text-left transition-colors ${
                            row.selected === ci
                              ? 'border-god bg-god/10'
                              : 'border-border hover:border-god/40 hover:bg-god/5'
                          }`}
                        >
                          <span className="mb-0.5 flex items-center gap-2">
                            <span
                              className={`flex h-3.5 w-3.5 items-center justify-center rounded-full border ${
                                row.selected === ci ? 'border-god bg-god' : 'border-muted-foreground'
                              }`}
                              aria-hidden
                            >
                              {row.selected === ci ? (
                                <span className="h-1.5 w-1.5 rounded-full bg-white" />
                              ) : null}
                            </span>
                            <span className="text-[13px] font-medium text-foreground">{c.name}</span>
                            <Badge variant="outline" className="px-1 text-[10px] font-normal">
                              {c.source || '出处未知'}
                            </Badge>
                            <span className="text-xs text-muted-foreground">{c.identity}</span>
                          </span>
                          <p className="pl-5.5 text-xs leading-5 text-muted-foreground">{c.summary}</p>
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between border-t border-border pt-3">
              <Button variant="ghost" onClick={() => { setBatchCands(null); setStep('input') }}>
                返回修改名单
              </Button>
              <Button onClick={handleBatchConfirm}>
                <Wand2 className="h-4 w-4" aria-hidden />
                确认铸造 {batchCands.filter((r) => r.cands.length > 0).length} 人格
              </Button>
            </div>
          </div>
        ) : null}

        {/* 第三步：铸造中（三节点进度条实时跟随后端阶段；未回传时轮播兜底） */}
        {step === 'casting' ? (
          <div className="flex flex-col items-center gap-6 py-10">
            <CastStageBar
              label={progress?.label}
              fallbackStage={[1, 2, 2, 3][castStage] ?? 1}
            />
            <div className="flex flex-col items-center gap-2">
              <p className="flex items-center gap-2 text-base text-foreground">
                <Loader2 className="h-4 w-4 animate-spin text-god" aria-hidden />
                {progress?.label ?? CAST_STAGES[castStage]}
              </p>
              {progress?.detail ? (
                <p className="max-w-lg text-center text-[13px] leading-6 text-god">{progress.detail}</p>
              ) : null}
            </div>
            <p className="text-[13px] leading-6 text-muted-foreground">
              三位 AI 接力铸造不设时限、质量优先（流式生成，进度实时回传），请稍候，不要关闭窗口
            </p>
          </div>
        ) : null}

        {/* 第四步：草稿预览 → 送入编辑器 */}
        {step === 'draft' && castResult ? (
          <div className="space-y-5">
            <div className="flex gap-4 rounded-lg border border-good/40 bg-good/5 p-4">
              {/* 肖像（铸魂师联网搜取；无图用首字占位） */}
              {castResult.draft.imageData ? (
                <img
                  src={castResult.draft.imageData}
                  alt={castResult.draft.name}
                  className="h-24 w-20 shrink-0 rounded-md border border-border object-cover"
                />
              ) : (
                <span className="flex h-24 w-20 shrink-0 items-center justify-center rounded-md border border-border bg-secondary text-3xl font-semibold text-muted-foreground">
                  {castResult.draft.name.slice(0, 1)}
                </span>
              )}
              <div className="min-w-0">
                <p className="mb-1.5 flex flex-wrap items-center gap-2 text-base font-medium text-foreground">
                  「{castResult.draft.name}」人格参数卡草稿已铸成
                  {castResult.draft.params.inferred.length > 0 ? (
                    <Badge variant="outline" className="border-amber-500/50 text-amber-600">
                      推断项 {castResult.draft.params.inferred.length}
                    </Badge>
                  ) : null}
                </p>
                <p className="line-clamp-3 text-[13px] leading-6 text-muted-foreground">
                  {castResult.draft.profile.summary || '（概要为空）'}
                </p>
                {COGNITION_NOTE_ENABLED && castResult.draft.profile.essence ? (
                  <p className="mt-2 line-clamp-3 text-[13px] leading-6 text-god">
                    自我认知笔记：{castResult.draft.profile.essence}
                  </p>
                ) : null}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-x-8 gap-y-2.5 sm:grid-cols-2">
              {(
                [
                  ['开放性', castResult.draft.params.bigFive.openness],
                  ['尽责性', castResult.draft.params.bigFive.conscientiousness],
                  ['外向性', castResult.draft.params.bigFive.extraversion],
                  ['宜人性', castResult.draft.params.bigFive.agreeableness],
                  ['神经质', castResult.draft.params.bigFive.neuroticism],
                ] as const
              ).map(([label, v]) => (
                <div key={label} className="flex items-center gap-2.5">
                  <span className="w-16 text-[13px] text-muted-foreground">{label}</span>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-secondary">
                    <div className="h-full rounded-full bg-god/70" style={{ width: `${v}%` }} />
                  </div>
                  <span className="w-8 text-right font-mono text-[13px]">{v}</span>
                </div>
              ))}
            </div>
            <p className="text-[13px] leading-6 text-muted-foreground">
              语录 {castResult.draft.profile.quotes.length} 条 · 偏差 {castResult.draft.params.cognitiveBiases.length} 项 ·
              防御机制 {castResult.draft.params.defenseMechanisms.length} 项；
              送入编辑器后可逐项核对微调，保存后才正式入库（来源标记为「AI 铸造」）。
            </p>
            <div className="flex justify-between border-t border-border pt-3">
              <Button variant="outline" onClick={() => { reset() }}>
                <RefreshCw className="h-4 w-4" aria-hidden />
                重新铸造别人
              </Button>
              <Button
                onClick={() => {
                  try {
                    // 不核销：草稿在草稿箱保留到「编辑器保存成功」为止（用户规则：
                    // 只有主动删除才能删草稿；送入编辑器≠删除，编辑器没保存就回来草稿还在）
                    onDraftReady(castResult.draft, castId)
                  } catch (err) {
                    setError(
                      `打开编辑器失败：${err instanceof Error ? err.message : String(err)}——草稿仍在草稿箱，可重试`,
                    )
                  }
                }}
              >
                送入编辑器核对
              </Button>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
