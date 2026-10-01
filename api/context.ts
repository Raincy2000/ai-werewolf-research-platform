import type { FetchCreateContextFnOptions } from "@trpc/server/adapters/fetch";
import type { SafeUser } from "../contracts/auth";
import { sessionTokenOf } from "./auth/cookie";
import { resolveSession } from "./queries/users";

export type TrpcContext = {
  req: Request;
  resHeaders: Headers;
  /** 当前登录用户（未登录/会话过期为 null） */
  user: SafeUser | null;
};

export async function createContext(
  opts: FetchCreateContextFnOptions,
): Promise<TrpcContext> {
  // 会话解析失败（如 DB 短暂不可用）不阻断请求——按未登录处理，由各过程自行决定是否放行
  let user: SafeUser | null = null;
  try {
    user = await resolveSession(sessionTokenOf(opts.req));
  } catch (err) {
    console.warn("[context] 会话解析失败（按未登录处理）:", err);
  }
  return { req: opts.req, resHeaders: opts.resHeaders, user };
}
