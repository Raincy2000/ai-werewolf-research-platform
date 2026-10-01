/**
 * 会话令牌的 localStorage 轨道（Cookie 轨道的兜底）。
 *
 * 背景（2026-08-02 线上事故）：预览页面运行在平台页面的 iframe 中，属第三方上下文，
 * Chrome/Safari 默认拦截第三方 Cookie——登录响应的 Set-Cookie 被丢弃，
 * 用户"登录成功但刷新后变回未登录"。因此登录/注册响应同时返回 sessionToken，
 * 前端存 localStorage，tRPC 客户端随请求发 Authorization: Bearer 头（见 providers/trpc.tsx）。
 *
 * 仅发往本站同源 /api/trpc，不会外泄；logout 时清除。
 */

const TOKEN_KEY = 'aiwerewolf.session.v1'

export function getSessionToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export function setSessionToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token)
  } catch {
    // 隐私模式等写入失败场景忽略（退化为仅 Cookie 轨道）
  }
}

export function clearSessionToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY)
  } catch {
    // 忽略
  }
}
