import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * 判断 tRPC 错误是否为「未登录 / 会话失效」（UNAUTHORIZED / HTTP 401）。
 * 用于各页面的未登录守卫：给出登录入口而不是白屏或无限加载。
 */
export function isUnauthorizedError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const data = (err as { data?: { code?: string; httpStatus?: number } }).data
  if (data?.code === 'UNAUTHORIZED' || data?.httpStatus === 401) return true
  // TRPCClientError 的 message 形如 `{"code":-32001,...}` 之外也可能直接是后端文案，
  // 这里再兜底匹配 data.path 缺失时的 shape.code（-32001 = UNAUTHORIZED 的 JSON-RPC code）
  const shape = (err as { shape?: { code?: number } }).shape
  return shape?.code === -32001
}
