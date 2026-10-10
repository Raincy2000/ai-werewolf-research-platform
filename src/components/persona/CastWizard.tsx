/**
 * 铸魂师 AI 铸造向导：输入人物名 → 联网消歧检索 → 用户确认对象 → 双 AI 铸造 → 草稿送入编辑器。
 * 双 AI 协作（用户决策）：检索 AI（默认 Kimi，联网）负责信息采集；整合 AI 负责量化成卡。
 * 配置持久化在 localStorage（aiwerewolf.caster.v1），可从 API 存档库一键导入四要素。
 */

import { useEffect, useState } from 'react'
import { CircleAlert, Loader2, RefreshCw, Search, Sparkles, Wand2 } from 'lucide-react'
import type {
  AiProvider,
  ApiPreset,
  CastProgressState,
  CasterCandidate,
  PersonaCardInput,
  PersonaCastResult,
} from '@/lib/gameApi'
import { getProviderPreset, useGameApi } from '@/lib/gameApi'
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
import { Textarea } from '@/components/ui/textarea'
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

type Step = 'input' | 'candidates' | 'casting' | 'draft'

export function CastWizard({
  open,
  onOpenChange,
  presets,
  onDraftReady,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  presets: ApiPreset[]
  onDraftReady: (draft: PersonaCardInput) => void
}) {
  const api = useGameApi()
  const [step, setStep] = useState<Step>('input')
  const [name, setName] = useState('')
  const [hint, setHint] = useState('')
  const [settings, setSettings] = useState<CasterSettings>(() => loadCasterSettings())
  const [candidates, setCandidates] = useState<CasterCandidate[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [castResult, setCastResult] = useState<PersonaCastResult | null>(null)
  const [castStage, setCastStage] = useState(0)
  // 真实铸造进度（后端 persona.castProgress 轮询；castId 每次任务新生成）
  const [castId, setCastId] = useState<string | null>(null)
  const [progress, setProgress] = useState<CastProgressState | null>(null)
  // 批量铸造模式（一行一个人名并发铸造；共享三 AI 配置与流程开关）
  const [batchMode, setBatchMode] = useState(false)
  const [batchText, setBatchText] = useState('')

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

  // 向导打开时找回最近铸造：进行中→恢复铸造界面与轮询；已完成未取走→直接进草稿步
  // （根治「铸造途中界面消失后，重新点开不知道进程到哪了」）
  useEffect(() => {
    if (!open) return
    let cancelled = false
    void (async () => {
      try {
        const active = await api.getCastActive()
        if (cancelled || !active) return
        if (active.done) {
          if (active.result && step === 'input') {
            setCastId(active.castId)
            setCastResult(active.result)
            setNotice(active.result.notice ?? null)
            setStep('draft')
          }
          return
        }
        if (step === 'input' && !busy) {
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
  }, [open])

  function updateSettings(patch: Partial<CasterSettings>) {
    setSettings((prev) => {
      const next = { ...prev, ...patch }
      saveCasterSettings(next)
      return next
    })
  }

  function reset() {
    setStep('input')
    setCandidates([])
    setCastResult(null)
    setError(null)
    setNotice(null)
    setCastId(null)
    setProgress(null)
    setBatchMode(false)
    setBatchText('')
  }

  /** 批量铸造：一行一人（可选「| 提示」），并发闸门 2 排队进行 */
  async function handleBatchCast() {
    if (busy) return
    const seen = new Set<string>()
    const items: { name: string; hint?: string }[] = []
    for (const line of batchText.split('\n')) {
      const t = line.trim()
      if (!t) continue
      const [n, h] = t.split('|').map((s) => s.trim())
      if (!n || seen.has(n)) continue
      seen.add(n)
      items.push({ name: n, hint: h || undefined })
      if (items.length >= 12) break
    }
    if (items.length === 0) {
      setError('请先输入要批量铸造的人物（一行一个）')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await api.castPersonaBatch({
        items,
        searchAi: settings.search,
        understandAi: settings.understand,
        synthAi: settings.synth,
        web: { stage1: settings.web.s1, stage2: settings.web.s2, stage3: settings.web.s3 },
        deepRead: { segmented: settings.deep.segmented, selfCritique: settings.deep.critique },
      })
      setNotice(
        `已启动 ${items.length} 项批量铸造（并发 2 个、排队进行）：各人格的生成进度见人格研究库卡列表顶部的「生成中」卡片，可随时暂停/终止；重名者已自动选定首候选。`,
      )
      setBatchText('')
      setBatchMode(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : '批量铸造启动失败，请重试')
    } finally {
      setBusy(false)
    }
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
        searchAi: settings.search,
        webSearch: settings.web.s1,
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
        searchAi: settings.search,
        understandAi: settings.understand,
        synthAi: settings.synth,
        web: { stage1: settings.web.s1, stage2: settings.web.s2, stage3: settings.web.s3 },
        deepRead: { segmented: settings.deep.segmented, selfCritique: settings.deep.critique },
        castId: id,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : '铸造启动失败，可重试')
      setStep('candidates')
      setBusy(false)
    }
  }

  const searchOk = quadComplete(settings.search)
  const understandOk = quadComplete(settings.understand)
  const synthOk = quadComplete(settings.synth)

  const CAST_STAGES = [
    '① 搜集 AI 正在全网搜集人物资料（生平/人设/经历/关系/语录，真实可靠第一）…',
    '② 深读 AI 正在透过表象把握人物核心（分段深挖：人格结构/冲突防御/依恋关系/压力与语言）…',
    '② 深读 AI 正在自我批判复读（揪出无据推测、恢复被调和的冲突）…',
    '③ 整合 AI 正在生成完整档案并量化七组参数（含人格精粹与肖像挑选）…',
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
        {step === 'input' ? (
          <div className="space-y-4">
            {!batchMode ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>人物名 *</Label>
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="如：曹操 / 福尔摩斯 / 马斯克"
                    onKeyDown={(e) => e.key === 'Enter' && void handleResearch()}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>消歧提示（可空）</Label>
                  <Input
                    value={hint}
                    onChange={(e) => setHint(e.target.value)}
                    placeholder="如：《三国演义》里的，不是其他人"
                  />
                </div>
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label>批量人物名单 *（每行一个；可加「| 提示」辅助消歧，最多 12 人）</Label>
                <Textarea
                  rows={5}
                  value={batchText}
                  onChange={(e) => setBatchText(e.target.value)}
                  placeholder={'曹操\n福尔摩斯\n马斯克 | 现实人物\n五条悟'}
                />
              </div>
            )}
            <label className="flex cursor-pointer items-center gap-2 text-[13px] text-muted-foreground">
              <Switch
                checked={batchMode}
                onCheckedChange={(v) => {
                  setBatchMode(v)
                  setError(null)
                }}
              />
              批量铸造（一行一个人名，同时铸造多个；共享下方 AI 配置与流程开关）
            </label>
            <QuadEditor
              title="① 搜集 AI"
              desc="全网搜集人物资料，真实可靠第一（默认 Kimi，内置 $web_search；换其他家则退化为内部知识）"
              quad={settings.search}
              presets={presets}
              onChange={(q) => updateSettings({ search: q })}
            />
            <QuadEditor
              title="② 深读 AI"
              desc="透过表象把握人物核心（核心人格结构/内在冲突/创伤防御/动机系统；建议推理强模型）"
              quad={settings.understand}
              presets={presets}
              onChange={(q) => updateSettings({ understand: q })}
            />
            <QuadEditor
              title="③ 整合 AI"
              desc="整合①②成果 → 完整人物档案 + 七组量化参数（建议长上下文模型）"
              quad={settings.synth}
              presets={presets}
              onChange={(q) => updateSettings({ synth: q })}
            />
            {/* 分阶段联网开关 + 深读深度 */}
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
                    checked={settings.web[k]}
                    onCheckedChange={(v) => updateSettings({ web: { ...settings.web, [k]: v } })}
                  />
                </div>
              ))}
              <div className="flex items-center justify-between gap-3 border-t border-border/60 pt-2.5">
                <Label className="cursor-pointer text-xs font-normal leading-5 text-muted-foreground">
                  ②深度深读（四段分段深挖 + 自我批判复读；更慢更透，关掉即快速模式）
                </Label>
                <Switch
                  className="shrink-0"
                  checked={settings.deep.segmented && settings.deep.critique}
                  onCheckedChange={(v) =>
                    updateSettings({ deep: { segmented: v, critique: v } })
                  }
                />
              </div>
            </div>
            {busy && progress ? (
              <p className="text-xs text-god">
                {progress.label}
                {progress.detail ? ` · ${progress.detail}` : ''}
              </p>
            ) : null}
            <div className="flex items-center justify-between border-t border-border pt-3">
              <p className="text-xs text-muted-foreground">
                {!searchOk || !understandOk || !synthOk
                  ? '请先补全三位 AI 的配置（模型 + API Key）'
                  : batchMode
                    ? '配置就绪，开始批量铸造（消歧自动选定首候选）'
                    : '配置就绪，开始检索消歧'}
              </p>
              <Button
                onClick={() => void (batchMode ? handleBatchCast() : handleResearch())}
                disabled={
                  busy ||
                  (batchMode ? !batchText.trim() : !name.trim()) ||
                  !searchOk ||
                  !understandOk ||
                  !synthOk
                }
              >
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : batchMode ? (
                  <Wand2 className="h-4 w-4" aria-hidden />
                ) : (
                  <Search className="h-4 w-4" aria-hidden />
                )}
                {batchMode ? '开始批量铸造' : '开始检索'}
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
                {castResult.draft.profile.essence ? (
                  <p className="mt-2 line-clamp-3 text-[13px] leading-6 text-god">
                    人格精粹：{castResult.draft.profile.essence}
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
              <Button variant="outline" onClick={() => { if (castId) void api.ackCast(castId); reset() }}>
                <RefreshCw className="h-4 w-4" aria-hidden />
                重新铸造别人
              </Button>
              <Button onClick={() => { if (castId) void api.ackCast(castId); onDraftReady(castResult.draft) }}>
                送入编辑器核对
              </Button>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
