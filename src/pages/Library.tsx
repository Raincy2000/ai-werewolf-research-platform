/**
 * 图书馆 /library —— AI 对局的前置知识库。
 * 用户上传规则书/攻略/复盘等资料（txt/md/docx 等，服务端提取纯文本入库），
 * 对局开启「图书馆赛前学习」后，各座位 AI 开赛前先自主学习这些资料形成心得，学完才开赛。
 */

import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import {
  BookOpen,
  CircleAlert,
  FileText,
  FileUp,
  Loader2,
  Trash2,
} from 'lucide-react'
import type { LibraryDocDetail, LibraryDocMeta } from '@/lib/gameApi'
import { useGameApi } from '@/lib/gameApi'
import { useAuth } from '@/providers/auth'
import { LoginRequiredCard } from '@/components/AuthDialog'
import { isUnauthorizedError } from '@/lib/utils'
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

const ACCEPT = '.txt,.md,.markdown,.log,.json,.csv,.docx'
// 不设容量上限（AI 选择性查阅机制下大书可整本入库）

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => {
      const result = String(fr.result ?? '')
      resolve(result.slice(result.indexOf(',') + 1))
    }
    fr.onerror = () => reject(new Error('文件读取失败'))
    fr.readAsDataURL(file)
  })
}

export default function Library() {
  const api = useGameApi()
  const { user } = useAuth()
  const userId = user?.id ?? null

  const [docs, setDocs] = useState<LibraryDocMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [previewDoc, setPreviewDoc] = useState<LibraryDocDetail | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<LibraryDocMeta | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!userId) {
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    api
      .listLibraryDocs()
      .then((rows) => {
        if (!cancelled) setDocs(rows)
      })
      .catch((err) => {
        if (!cancelled && !isUnauthorizedError(err)) setError('加载失败，请重试')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId])

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return
    setError(null)
    setUploading(true)
    try {
      for (const file of Array.from(files)) {
        const base64 = await readAsBase64(file)
        await api.uploadLibraryDoc({ name: file.name, contentBase64: base64 })
      }
      setDocs(await api.listLibraryDocs())
    } catch (err) {
      setError(err instanceof Error ? err.message : '上传失败，请重试')
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  async function handlePreview(doc: LibraryDocMeta) {
    setPreviewLoading(true)
    try {
      const full = await api.readLibraryDoc(doc.id)
      setPreviewDoc(full)
    } catch {
      setError('读取文档失败')
    } finally {
      setPreviewLoading(false)
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return
    try {
      await api.removeLibraryDoc(deleteTarget.id)
      setDocs((prev) => prev.filter((d) => d.id !== deleteTarget.id))
    } catch {
      setError('删除失败，请重试')
    } finally {
      setDeleteTarget(null)
    }
  }

  if (!userId) {
    return (
      <div className="mx-auto max-w-[1600px] px-4 py-10 sm:px-8">
        <LoginRequiredCard />
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-[1600px] px-4 py-6 sm:px-8">
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <BookOpen className="h-6 w-6 text-foreground" aria-hidden />
        <div>
          <h1 className="text-xl font-semibold text-foreground">图书馆</h1>
          <p className="text-sm text-muted-foreground">
            AI 对局的前置知识库：上传规则书/攻略/复盘资料，开启「图书馆赛前学习」的对局中，
            各座位 AI 会在开赛前先自主学习这些资料并形成心得
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept={ACCEPT}
            multiple
            className="hidden"
            onChange={(e) => void handleFiles(e.target.files)}
          />
          <Button onClick={() => fileRef.current?.click()} disabled={uploading}>
            {uploading ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <FileUp className="h-4 w-4" aria-hidden />
            )}
            上传资料
          </Button>
        </div>
      </div>

      {error ? (
        <p className="mb-4 flex items-center gap-1.5 text-sm text-wolf">
          <CircleAlert className="h-4 w-4" aria-hidden />
          {error}
        </p>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">馆藏资料</CardTitle>
          <CardDescription>
            支持 txt / md / markdown / log / json / csv / docx，不限容量；PDF 请另存为文本后上传
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              正在加载…
            </p>
          ) : docs.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              还没有资料。点击「上传资料」导入狼人杀规则书、进阶攻略或往届复盘，
              AI 赛前学习后能明显提升对局认知。
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {docs.map((doc) => (
                <li key={doc.id} className="flex flex-wrap items-center gap-3 py-3">
                  <FileText className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                    {doc.name}
                  </span>
                  <Badge variant="outline" className="font-normal">
                    {doc.format}
                  </Badge>
                  <span className="text-xs text-muted-foreground">{formatSize(doc.sizeBytes)}</span>
                  <span className="text-xs text-muted-foreground">{formatTime(doc.createdAt)}</span>
                  <Button size="sm" variant="outline" onClick={() => void handlePreview(doc)} disabled={previewLoading}>
                    预览
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-wolf hover:bg-wolf/10 hover:text-wolf"
                    onClick={() => setDeleteTarget(doc)}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <p className="mt-4 text-xs text-muted-foreground">
        使用方式：大厅 → 高级设置 → 开启「图书馆赛前学习」（可设最长学习时间）。对局启动时各座位
        AI 会先通读全部馆藏并写下学习心得，全部完成后自动开赛。经验指南在
        <Link to="/guide" className="mx-1 underline underline-offset-2">经验指南</Link>
        页查看。
      </p>

      {/* 预览弹窗 */}
      <Dialog open={previewDoc !== null} onOpenChange={(open) => !open && setPreviewDoc(null)}>
        <DialogContent className="max-h-[85dvh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{previewDoc?.name}</DialogTitle>
            <DialogDescription>
              {previewDoc ? `${previewDoc.format} · ${formatSize(previewDoc.sizeBytes)} · 服务端提取的纯文本` : ''}
            </DialogDescription>
          </DialogHeader>
          <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-6 text-foreground">
            {previewDoc?.content}
          </pre>
        </DialogContent>
      </Dialog>

      {/* 删除确认 */}
      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除「{deleteTarget?.name}」？</AlertDialogTitle>
            <AlertDialogDescription>
              删除后新对局的赛前学习将不再包含该资料（已在学的对局不受影响）。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction className="bg-wolf text-white hover:bg-wolf/90" onClick={() => void handleDelete()}>
              确认删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
