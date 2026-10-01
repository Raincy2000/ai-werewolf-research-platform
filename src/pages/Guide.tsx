/**
 * 经验指南 /guide。
 *
 * 指南按作用域（scope）分类展示：
 * - 共通指南（scope="common"）：通用于所有版型的经验；
 * - 版型特定指南（scope=版型 id）：仅适用于对应版型的经验。
 * 顶部 Tab 切换作用域（game.guide 返回 GuideOverview），每个作用域内展示
 * 当前版本 + 历史版本（game.guideVersions / game.guideVersion 按 scope 查询，
 * 点击展开该 scope 的某版全文，懒加载缓存）。
 * 指南正文为 markdown 风格纯文本，按需求直接用 <pre> 渲染，不引入 markdown 依赖。
 */

import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import {
  BookOpen,
  ChevronDown,
  CircleAlert,
  FileText,
  History,
  Loader2,
  Pencil,
  Save,
  X,
} from 'lucide-react'
import type { GuideInfo, GuideOverview, GuideVersionSummary } from '@/lib/gameApi'
import { useGameApi } from '@/lib/gameApi'
import type { GuideVersionDetail } from '@/lib/gameApi'
import { MarkdownBoard } from '@/components/MarkdownBoard'
import { useAuth } from '@/providers/auth'
import { LoginRequiredCard } from '@/components/AuthDialog'
import { cn, isUnauthorizedError } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'

/** 共通指南的 scope 保留值（契约 GuideScope："common" = 通用于所有版型） */
const COMMON_SCOPE = 'common'

function formatTime(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export default function Guide() {
  const api = useGameApi()
  const { user } = useAuth()
  // 登录态 id：登录成功后自动重拉指南（未登录守卫解除）
  const userId = user?.id ?? null

  const [overview, setOverview] = useState<GuideOverview | null>(null)
  const [activeScope, setActiveScope] = useState<string>(COMMON_SCOPE)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  // 未登录守卫：指南接口要求登录，UNAUTHORIZED 时展示登录提示卡
  const [unauthorized, setUnauthorized] = useState(false)

  // 各 scope 的版本历史缓存（切到某 Tab 时才懒加载该 scope）
  const [versionsByScope, setVersionsByScope] = useState<Record<string, GuideVersionSummary[]>>({})
  const [versionsLoading, setVersionsLoading] = useState(false)
  const [versionsError, setVersionsError] = useState<string | null>(null)

  // 版本历史展开状态：当前展开的版本号 + 已拉取的全文缓存（按 "scope#version" 键缓存）
  const [expandedVersion, setExpandedVersion] = useState<number | null>(null)
  const [detailCache, setDetailCache] = useState<Record<string, GuideVersionDetail | null>>({})
  const [detailLoading, setDetailLoading] = useState(false)

  // 手动编辑态：draft 为编辑中草稿（未保存切 Tab 即丢弃，不落草稿）
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    setUnauthorized(false)
    api.getGuide()
      .then((g) => {
        if (!cancelled) setOverview(g)
      })
      .catch((err) => {
        if (cancelled) return
        if (isUnauthorizedError(err)) setUnauthorized(true)
        else setLoadError(err instanceof Error ? err.message : '加载失败')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [api, userId])

  // 当前 Tab 的版本历史：懒加载 + 按 scope 缓存
  useEffect(() => {
    if (loading || loadError) return
    if (activeScope in versionsByScope) return
    let cancelled = false
    setVersionsLoading(true)
    setVersionsError(null)
    api.getGuideVersions(activeScope)
      .then((vs) => {
        if (!cancelled) setVersionsByScope((prev) => ({ ...prev, [activeScope]: vs }))
      })
      .catch((err) => {
        if (!cancelled) setVersionsError(err instanceof Error ? err.message : '加载失败')
      })
      .finally(() => {
        if (!cancelled) setVersionsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [api, activeScope, loading, loadError, versionsByScope])

  function resetEdit() {
    setEditing(false)
    setDraft('')
    setSaving(false)
    setSaveError(null)
  }

  function handleScopeChange(scope: string) {
    // 编辑中切 Tab：草稿不落盘，简单 confirm 提示后直接丢弃
    if (editing && !window.confirm('当前指南有未保存的编辑，切换后将丢弃，确定切换吗？')) {
      return
    }
    resetEdit()
    setActiveScope(scope)
    setExpandedVersion(null)
    setVersionsError(null)
  }

  function startEdit() {
    if (!activeGuide) return
    setDraft(activeGuide.content)
    setSaveError(null)
    setEditing(true)
  }

  /** 保存编辑：生成新版本；成功后刷新当前指南与版本历史；失败保留草稿并展示错误 */
  async function saveEdit() {
    const content = draft.trim()
    if (!content || saving) return
    setSaving(true)
    setSaveError(null)
    try {
      const updated = await api.updateGuide(activeScope, draft)
      // 刷新当前指南（overview 内对应 scope 的 GuideInfo）
      setOverview((prev) => {
        if (!prev) return prev
        if (activeScope === COMMON_SCOPE) return { ...prev, common: updated }
        return {
          ...prev,
          boards: prev.boards.map((b) => (b.boardId === activeScope ? { ...b, guide: updated } : b)),
        }
      })
      // 刷新该 scope 的版本历史（新版本应出现在列表顶部，note 为「用户手动编辑」）
      try {
        const vs = await api.getGuideVersions(activeScope)
        setVersionsByScope((prev) => ({ ...prev, [activeScope]: vs }))
      } catch {
        // 历史刷新失败不影响保存结果，移除缓存让下次进入时重新拉取
        setVersionsByScope((prev) => {
          const next = { ...prev }
          delete next[activeScope]
          return next
        })
      }
      resetEdit()
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : '保存失败，请稍后重试')
    } finally {
      setSaving(false)
    }
  }

  async function toggleVersion(version: number) {
    if (expandedVersion === version) {
      setExpandedVersion(null)
      return
    }
    setExpandedVersion(version)
    const cacheKey = `${activeScope}#${version}`
    if (cacheKey in detailCache) return
    setDetailLoading(true)
    try {
      const detail = await api.getGuideVersion(activeScope, version)
      setDetailCache((prev) => ({ ...prev, [cacheKey]: detail }))
    } catch {
      setDetailCache((prev) => ({ ...prev, [cacheKey]: null }))
    } finally {
      setDetailLoading(false)
    }
  }

  const boards = overview?.boards ?? []
  const activeBoard = activeScope === COMMON_SCOPE ? null : (boards.find((b) => b.boardId === activeScope) ?? null)
  const activeGuide: GuideInfo | null =
    activeScope === COMMON_SCOPE ? (overview?.common ?? null) : (activeBoard?.guide ?? null)
  const hasGuide = Boolean(activeGuide && activeGuide.version > 0 && activeGuide.content.trim())
  const versions = versionsByScope[activeScope]
  const scopeLabel = activeScope === COMMON_SCOPE ? '共通指南' : `「${activeBoard?.boardName ?? activeScope}」`

  // 未登录：友好登录提示（内嵌登录入口），登录成功后上方 effect 自动重拉
  if (unauthorized) {
    return (
      <LoginRequiredCard
        title="经验指南需要登录后查看"
        description="指南由你的历代 AI 对局沉淀而成，登录后即可查阅与编辑。"
      />
    )
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      {/* 1. 顶部标题栏 */}
      <section className="mb-8">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight text-foreground">
          <BookOpen className="h-6 w-6 text-god" aria-hidden />
          经验指南
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          历代 AI 对局沉淀的经验教程，分为共通内容与各版型特定内容 · 玩家对局中会自动查阅共通指南 +
          本版型指南
        </p>
      </section>

      {loadError ? (
        <Card className="mb-6">
          <CardContent className="flex items-center gap-2 py-6 text-sm text-wolf">
            <CircleAlert className="h-4 w-4" aria-hidden />
            经验指南加载失败：{loadError}
          </CardContent>
        </Card>
      ) : null}

      {/* 2. 分类 Tab：共通指南 + 各版型特定指南（仅列出已有特定内容的版型） */}
      <Tabs value={activeScope} onValueChange={handleScopeChange} className="mb-6">
        <TabsList className="mb-4 h-auto flex-wrap justify-start">
          <TabsTrigger value={COMMON_SCOPE}>共通指南</TabsTrigger>
          {boards.map((b) => (
            <TabsTrigger key={b.boardId} value={b.boardId}>
              {b.boardName}
            </TabsTrigger>
          ))}
        </TabsList>

        {/* 2.1 当前指南（当前 Tab 对应的 scope） */}
        <Card className="mb-6">
          <CardHeader>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <CardTitle className="text-lg">当前指南</CardTitle>
              {hasGuide ? (
                <>
                  <Badge>第{activeGuide!.version}版</Badge>
                  <span className="text-xs text-muted-foreground">
                    更新于 {formatTime(activeGuide!.updatedAt)} · 已收录 {activeGuide!.entryCount}{' '}
                    篇对局分析
                  </span>
                </>
              ) : null}
              {hasGuide ? (
                <div className="ml-auto flex items-center gap-2">
                  {editing ? (
                    <>
                      <Button
                        size="sm"
                        onClick={() => void saveEdit()}
                        disabled={saving || !draft.trim()}
                      >
                        {saving ? (
                          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                        ) : (
                          <Save className="h-4 w-4" aria-hidden />
                        )}
                        {saving ? '保存中…' : '保存'}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={resetEdit}
                        disabled={saving}
                      >
                        <X className="h-4 w-4" aria-hidden />
                        取消
                      </Button>
                    </>
                  ) : (
                    <Button size="sm" variant="outline" onClick={startEdit}>
                      <Pencil className="h-4 w-4" aria-hidden />
                      编辑
                    </Button>
                  )}
                </div>
              ) : null}
            </div>
            <CardDescription>
              {activeScope === COMMON_SCOPE
                ? '通用于所有版型的经验，由分析师在每次对局复盘后蒸馏更新，注入后续所有 AI 玩家的上下文'
                : `仅适用于${scopeLabel}版型的经验，该版型的对局中会自动注入 AI 玩家的上下文`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? (
              <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                指南加载中…
              </p>
            ) : hasGuide ? (
              editing ? (
                <div className="space-y-3">
                  {saveError ? (
                    <p className="flex items-center gap-2 rounded-md border border-wolf/30 bg-wolf/5 px-3 py-2 text-sm text-wolf">
                      <CircleAlert className="h-4 w-4 shrink-0" aria-hidden />
                      保存失败：{saveError}（已编辑内容保留，可重试）
                    </p>
                  ) : null}
                  <Textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    disabled={saving}
                    aria-label="编辑指南内容"
                    className="min-h-[400px] font-mono text-sm leading-6"
                  />
                  <p className="text-xs text-muted-foreground">
                    保存后将生成新版本（历史版本保留），内容为空时不可保存。
                  </p>
                </div>
              ) : (
                <MarkdownBoard content={activeGuide!.content} />
              )
            ) : activeScope === COMMON_SCOPE ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                暂无共通经验指南 — 完成对局并生成分析后，经验将沉淀于此
              </p>
            ) : (
              <p className="py-6 text-center text-sm text-muted-foreground">
                暂无版型特定经验，完成对局分析后自动生成
              </p>
            )}
          </CardContent>
        </Card>

        {/* 2.2 版本历史（当前 Tab 对应的 scope） */}
        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <History className="h-5 w-5 text-muted-foreground" aria-hidden />
              版本历史
            </CardTitle>
            <CardDescription>
              {scopeLabel}每次蒸馏生成一个新版本，点击可展开该版本全文
            </CardDescription>
          </CardHeader>
          <CardContent>
            {loading || (versionsLoading && versions === undefined) ? (
              <p className="py-4 text-sm text-muted-foreground">版本历史加载中…</p>
            ) : versionsError ? (
              <p className="flex items-center gap-2 py-4 text-sm text-wolf">
                <CircleAlert className="h-4 w-4" aria-hidden />
                版本历史加载失败：{versionsError}
              </p>
            ) : !versions || versions.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">暂无历史版本</p>
            ) : (
              <div className="divide-y divide-border rounded-md border border-border">
                {versions.map((v) => {
                  const expanded = expandedVersion === v.version
                  const detail = detailCache[`${activeScope}#${v.version}`]
                  return (
                    <div key={v.version}>
                      <button
                        type="button"
                        onClick={() => void toggleVersion(v.version)}
                        aria-expanded={expanded}
                        className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-left transition-colors hover:bg-secondary/60"
                      >
                        <Badge variant={expanded ? 'default' : 'secondary'}>第{v.version}版</Badge>
                        <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                          {v.note || '—'}
                        </span>
                        <span className="font-mono text-xs text-muted-foreground">
                          {formatTime(v.createdAt)}
                        </span>
                        <ChevronDown
                          className={cn(
                            'h-4 w-4 text-muted-foreground transition-transform',
                            expanded && 'rotate-180',
                          )}
                          aria-hidden
                        />
                      </button>
                      {expanded ? (
                        <div className="border-t border-border bg-secondary/30 px-4 py-3">
                          {detail === undefined && detailLoading ? (
                            <p className="flex items-center gap-2 text-sm text-muted-foreground">
                              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                              版本全文加载中…
                            </p>
                          ) : detail ? (
                            <MarkdownBoard content={detail.content} />
                          ) : (
                            <p className="text-sm text-muted-foreground">该版本全文不可用</p>
                          )}
                        </div>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </Tabs>

      {/* 3. 分析报告入口提示 */}
      <Card>
        <CardContent className="flex flex-wrap items-center gap-x-3 gap-y-2 py-4">
          <FileText className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
          {/* 移动端独占一行（basis-full），避免被按钮挤成窄条；sm 起恢复同行弹性布局 */}
          <p className="min-w-0 flex-1 basis-full text-sm text-muted-foreground sm:basis-0">
            每一局的完整分析报告（心理学 + 博弈论复盘）保存在对应对局中。
          </p>
          <Button asChild variant="outline" size="sm" className="shrink-0">
            <Link to="/">去历史对局查看各局报告</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
