/**
 * 登录 / 注册对话框 + 未登录提示卡（全站共用的账户入口）。
 *
 * - AuthDialog：邮箱 + 密码；登录模式带「保留登录状态」（默认勾选）；
 *   注册模式可选填用户名（缺省后端自动「用户-随机数字」）；两种模式可互相切换
 * - LoginRequiredCard：页面级未登录守卫提示卡，内嵌登录入口与「返回大厅」
 */
import { useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { CircleAlert, Loader2, LogIn } from 'lucide-react'
import { useAuth } from '@/providers/auth'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

type AuthMode = 'login' | 'register'

/** 从未知错误中提取面向用户的中文提示（tRPC 后端错误文案已是中文） */
function errorMessageOf(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback
}

export function AuthDialog({
  open,
  onOpenChange,
  onSuccess,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 登录/注册成功后回调（父组件可借此重新拉取受限数据） */
  onSuccess?: () => void
}) {
  const { login, register } = useAuth()
  const [mode, setMode] = useState<AuthMode>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [username, setUsername] = useState('')
  // 保留登录状态（30 天）：默认勾选；不勾选则为 12 小时会话级 Cookie
  const [remember, setRemember] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  /** 切换登录/注册模式：清空错误，保留邮箱便于继续 */
  function switchMode(next: AuthMode) {
    setMode(next)
    setError(null)
  }

  function handleOpenChange(next: boolean) {
    if (busy) return // 提交中不允许误关，避免状态歧义
    if (!next) setError(null)
    onOpenChange(next)
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    const trimmedEmail = email.trim()
    if (!trimmedEmail) {
      setError('请输入邮箱')
      return
    }
    if (mode === 'register' && password.length < 8) {
      setError('密码至少 8 位')
      return
    }
    if (!password) {
      setError('请输入密码')
      return
    }
    setBusy(true)
    setError(null)
    try {
      if (mode === 'login') {
        await login({ email: trimmedEmail, password, remember })
      } else {
        await register({
          email: trimmedEmail,
          password,
          username: username.trim() || undefined,
        })
      }
      // 成功：清空敏感字段并关闭
      setPassword('')
      setError(null)
      onOpenChange(false)
      onSuccess?.()
    } catch (err) {
      setError(errorMessageOf(err, mode === 'login' ? '登录失败，请重试' : '注册失败，请重试'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{mode === 'login' ? '登录' : '注册'}</DialogTitle>
          <DialogDescription>
            {mode === 'login'
              ? '登录后同步大厅配置与 API 存档库，跨设备继续研究。'
              : '注册即自动登录；邮箱用于找回会话，不会公开展示。'}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="auth-email">邮箱</Label>
            <Input
              id="auth-email"
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="auth-password">密码</Label>
            <Input
              id="auth-password"
              type="password"
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              placeholder={mode === 'login' ? '请输入密码' : '至少 8 位'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          {mode === 'register' ? (
            <div className="space-y-1.5">
              <Label htmlFor="auth-username">用户名（可选）</Label>
              <Input
                id="auth-username"
                autoComplete="nickname"
                placeholder="不填则默认为「用户-随机数字」"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                maxLength={64}
              />
            </div>
          ) : (
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <Checkbox
                checked={remember}
                onCheckedChange={(checked) => setRemember(checked === true)}
                aria-label="保留登录状态"
              />
              保留登录状态（30 天内免登录）
            </label>
          )}
          {error ? (
            <p className="flex items-center gap-1.5 text-sm text-wolf">
              <CircleAlert className="h-4 w-4 shrink-0" aria-hidden />
              {error}
            </p>
          ) : null}
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            {mode === 'login' ? '登录' : '注册并登录'}
          </Button>
          <p className="text-center text-sm text-muted-foreground">
            {mode === 'login' ? (
              <>
                还没有账户？{' '}
                <button
                  type="button"
                  className="font-medium text-foreground underline underline-offset-4"
                  onClick={() => switchMode('register')}
                >
                  立即注册
                </button>
              </>
            ) : (
              <>
                已有账户？{' '}
                <button
                  type="button"
                  className="font-medium text-foreground underline underline-offset-4"
                  onClick={() => switchMode('login')}
                >
                  直接登录
                </button>
              </>
            )}
          </p>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/**
 * 未登录守卫提示卡：tRPC 返回 UNAUTHORIZED 时展示，
 * 内嵌登录入口（登录成功后由父组件重新拉取数据），并提供返回大厅的出口。
 */
export function LoginRequiredCard({
  title = '该内容需要登录后查看',
  description = '登录后即可继续；也可以先返回大厅，使用本地配置体验。',
  onSuccess,
}: {
  title?: string
  description?: string
  onSuccess?: () => void
}) {
  const [authOpen, setAuthOpen] = useState(false)
  return (
    <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6">
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
          <LogIn className="h-8 w-8 text-muted-foreground" aria-hidden />
          <p className="text-base font-medium text-foreground">{title}</p>
          <p className="break-words text-sm text-muted-foreground">{description}</p>
          <div className="mt-2 flex items-center gap-2">
            <Button onClick={() => setAuthOpen(true)}>登录 / 注册</Button>
            <Button asChild variant="outline">
              <Link to="/">返回大厅</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
      <AuthDialog open={authOpen} onOpenChange={setAuthOpen} onSuccess={onSuccess} />
    </div>
  )
}
