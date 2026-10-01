/**
 * 账户状态 Provider：基于 trpc.auth.me 维护当前登录用户。
 *
 * 约定：
 * - 未登录时 me 返回 null（正常态，不算错误），user = null
 * - login/register/logout/updateProfile 封装对应 mutation，
 *   成功后直接回写 me 缓存（setData）并 invalidate，保证全站账户态即时一致
 */
import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react'
import type { SafeUser } from '@contracts/auth'
import { trpc } from '@/providers/trpc'
import { clearSessionToken, setSessionToken } from '@/lib/sessionToken'

/** 登录入参（remember=true 保留登录状态 30 天） */
export interface LoginInput {
  email: string
  password: string
  remember?: boolean
}

/** 注册入参（用户名缺省时后端自动「用户-随机数字」） */
export interface RegisterInput {
  email: string
  password: string
  username?: string
  avatar?: string
}

/** 资料更新入参（按需局部更新） */
export interface UpdateProfileInput {
  username?: string
  avatar?: string
}

export interface AuthContextValue {
  /** 当前登录用户；未登录为 null */
  user: SafeUser | null
  /** 首次查询会话状态中（me 请求未返回） */
  isLoading: boolean
  login: (input: LoginInput) => Promise<SafeUser>
  register: (input: RegisterInput) => Promise<SafeUser>
  logout: () => Promise<void>
  updateProfile: (input: UpdateProfileInput) => Promise<SafeUser>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const utils = trpc.useUtils()
  // 未登录返回 null 是正常态：不重试、不视为错误
  const meQuery = trpc.auth.me.useQuery(undefined, {
    retry: false,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  })

  const loginMutation = trpc.auth.login.useMutation()
  const registerMutation = trpc.auth.register.useMutation()
  const logoutMutation = trpc.auth.logout.useMutation()
  const updateProfileMutation = trpc.auth.updateProfile.useMutation()

  /** 会话变更后统一回写 me 缓存并触发失效刷新 */
  const applyUser = useCallback(
    async (user: SafeUser | null) => {
      utils.auth.me.setData(undefined, user)
      await utils.auth.me.invalidate()
    },
    [utils],
  )

  const login = useCallback(
    async (input: LoginInput) => {
      const res = await loginMutation.mutateAsync(input)
      // 双轨会话：Cookie 之外把令牌存入 localStorage（Cookie 被拦截的上下文也能保持登录）
      setSessionToken(res.sessionToken)
      await applyUser(res.user)
      return res.user
    },
    [loginMutation, applyUser],
  )

  const register = useCallback(
    async (input: RegisterInput) => {
      const res = await registerMutation.mutateAsync(input)
      setSessionToken(res.sessionToken)
      await applyUser(res.user)
      return res.user
    },
    [registerMutation, applyUser],
  )

  const logout = useCallback(async () => {
    await logoutMutation.mutateAsync()
    clearSessionToken()
    await applyUser(null)
  }, [logoutMutation, applyUser])

  const updateProfile = useCallback(
    async (input: UpdateProfileInput) => {
      const user = await updateProfileMutation.mutateAsync(input)
      await applyUser(user)
      return user
    },
    [updateProfileMutation, applyUser],
  )

  const value = useMemo<AuthContextValue>(
    () => ({
      user: meQuery.data ?? null,
      isLoading: meQuery.isLoading,
      login,
      register,
      logout,
      updateProfile,
    }),
    [meQuery.data, meQuery.isLoading, login, register, logout, updateProfile],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

/** 获取账户状态；必须在 <AuthProvider> 内使用 */
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth 必须在 <AuthProvider> 内使用')
  return ctx
}
