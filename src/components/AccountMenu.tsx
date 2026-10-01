/**
 * 导航栏右侧账户区：
 * - 未登录：「登录 / 注册」按钮（打开 AuthDialog）
 * - 已登录：头像 + 用户名下拉菜单（资料设置 / 退出登录）
 * 资料设置对话框支持修改用户名与上传头像（canvas 居中裁剪压缩至 96x96 PNG data URL）。
 */
import { useRef, useState } from 'react'
import { CircleAlert, Loader2, LogOut, Settings, UserRound } from 'lucide-react'
import { DEFAULT_AVATAR } from '@contracts/auth'
import { useAuth } from '@/providers/auth'
import { AuthDialog } from '@/components/AuthDialog'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

/** 头像输出边长（正方形 PNG） */
const AVATAR_SIZE = 96

/**
 * 上传图片压缩为 96x96 PNG data URL：居中裁剪为正方形后缩放，
 * 控制入库体积（后端头像上限 400KB，96x96 PNG 远低于此）。
 */
async function compressAvatar(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file)
  try {
    const side = Math.min(bitmap.width, bitmap.height)
    const sx = (bitmap.width - side) / 2
    const sy = (bitmap.height - side) / 2
    const canvas = document.createElement('canvas')
    canvas.width = AVATAR_SIZE
    canvas.height = AVATAR_SIZE
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('当前浏览器不支持图片处理')
    ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE)
    return canvas.toDataURL('image/png')
  } finally {
    bitmap.close()
  }
}

/** 资料设置对话框：改用户名 + 上传/恢复默认头像 */
function ProfileDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { user, updateProfile } = useAuth()
  const [username, setUsername] = useState('')
  const [avatar, setAvatar] = useState<string>(DEFAULT_AVATAR)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // 记录本次打开是否已初始化（避免输入过程中被 user 刷新覆盖）
  const initializedRef = useRef(false)

  // 打开时以当前资料初始化表单
  if (open && user && !initializedRef.current) {
    initializedRef.current = true
    setUsername(user.username)
    setAvatar(user.avatar || DEFAULT_AVATAR)
    setError(null)
  }
  if (!open && initializedRef.current) {
    initializedRef.current = false
  }

  async function handleFileChange(file: File | undefined) {
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setError('请选择图片文件')
      return
    }
    setError(null)
    try {
      setAvatar(await compressAvatar(file))
    } catch {
      setError('图片读取失败，请换一张试试')
    }
  }

  async function handleSave() {
    if (busy || !user) return
    const name = username.trim()
    if (!name) {
      setError('用户名不能为空')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await updateProfile({
        username: name,
        avatar: avatar || DEFAULT_AVATAR,
      })
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : '保存失败，请重试')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>资料设置</DialogTitle>
          <DialogDescription>修改用户名与头像，保存后全站生效并跨设备同步。</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="flex items-center gap-4">
            <Avatar className="h-16 w-16">
              <AvatarImage src={avatar} alt="头像预览" />
              <AvatarFallback>
                <UserRound className="h-6 w-6" aria-hidden />
              </AvatarFallback>
            </Avatar>
            <div className="flex flex-col gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
              >
                上传头像
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setAvatar(DEFAULT_AVATAR)}
              >
                恢复默认头像
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  void handleFileChange(e.target.files?.[0])
                  e.target.value = '' // 允许重复选择同一文件
                }}
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            图片将居中裁剪并压缩为 96×96 PNG；未上传时使用默认灰色头像。
          </p>
          <div className="space-y-1.5">
            <Label htmlFor="profile-username">用户名</Label>
            <Input
              id="profile-username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              maxLength={64}
              placeholder="请输入用户名"
            />
          </div>
          {error ? (
            <p className="flex items-center gap-1.5 text-sm text-wolf">
              <CircleAlert className="h-4 w-4 shrink-0" aria-hidden />
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              取消
            </Button>
            <Button type="button" onClick={() => void handleSave()} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
              保存
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export default function AccountMenu() {
  const { user, isLoading, logout } = useAuth()
  const [authOpen, setAuthOpen] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  const [logoutError, setLogoutError] = useState<string | null>(null)

  // 会话状态查询中：渲染等宽占位，避免导航栏右侧跳动
  if (isLoading) {
    return <div className="h-8 w-20 rounded-md bg-secondary" aria-hidden />
  }

  if (!user) {
    return (
      <>
        <Button variant="outline" size="sm" onClick={() => setAuthOpen(true)}>
          登录 / 注册
        </Button>
        <AuthDialog open={authOpen} onOpenChange={setAuthOpen} />
      </>
    )
  }

  async function handleLogout() {
    setLogoutError(null)
    try {
      await logout()
    } catch {
      // 即使请求失败也已在后端清 Cookie 路径上尽力而为；提示用户重试
      setLogoutError('退出失败，请重试')
    }
  }

  return (
    <>
      {/* modal={false}：默认模态会锁定 body 滚动（撤掉滚动条），打开菜单瞬间整页横向位移晃动 */}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-secondary"
            aria-label="账户菜单"
          >
            <Avatar className="h-7 w-7">
              <AvatarImage src={user.avatar || DEFAULT_AVATAR} alt={`${user.username} 的头像`} />
              <AvatarFallback>
                <UserRound className="h-4 w-4" aria-hidden />
              </AvatarFallback>
            </Avatar>
            <span className="max-w-20 truncate font-medium text-foreground sm:max-w-32">{user.username}</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel className="flex flex-col gap-0.5">
            <span className="truncate text-sm font-medium">{user.username}</span>
            <span className="truncate text-xs font-normal text-muted-foreground">{user.email}</span>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setProfileOpen(true)}>
            <Settings className="h-4 w-4" aria-hidden />
            资料设置
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void handleLogout()}>
            <LogOut className="h-4 w-4" aria-hidden />
            退出登录
          </DropdownMenuItem>
          {logoutError ? (
            <p className="px-2 py-1.5 text-xs text-wolf">{logoutError}</p>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <ProfileDialog open={profileOpen} onOpenChange={setProfileOpen} />
    </>
  )
}
