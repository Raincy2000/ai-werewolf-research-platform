// 会话 Cookie 工具（独立模块，避免 context ↔ auth 路由的循环依赖）
import type { TrpcContext } from "../context";
import { REMEMBER_SESSION_MS } from "../queries/users";

export const SESSION_COOKIE = "ww_session";

/**
 * 从请求解析会话 token（双轨）：
 * 1. Cookie（同源常规场景）
 * 2. Authorization: Bearer（iframe 预览等第三方上下文——现代浏览器默认拦截第三方 Cookie，
 *    曾导致"登录成功但刷新后变回未登录"；前端会把登录响应中的令牌存 localStorage 并随
 *    /api/trpc 请求头发送，保证任何上下文都能保持登录）
 */
export function sessionTokenOf(req: Request): string | undefined {
  const header = req.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === SESSION_COOKIE) return decodeURIComponent(v.join("="));
  }
  const auth = req.headers.get("authorization") ?? "";
  if (auth.toLowerCase().startsWith("bearer ")) {
    const token = auth.slice(7).trim();
    if (token) return token;
  }
  return undefined;
}

export function setSessionCookie(ctx: TrpcContext, token: string, remember: boolean) {
  const secure = new URL(ctx.req.url).protocol === "https:" ? "; Secure" : "";
  const maxAge = remember ? `; Max-Age=${Math.floor(REMEMBER_SESSION_MS / 1000)}` : "";
  ctx.resHeaders.append(
    "Set-Cookie",
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax${maxAge}${secure}`,
  );
}

export function clearSessionCookie(ctx: TrpcContext) {
  ctx.resHeaders.append("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}
