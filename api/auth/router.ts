// 账户路由：注册 / 登录（可选保留登录状态）/ 登出 / 当前用户 / 资料更新 / 设置云同步
// Cookie：ww_session，HttpOnly + SameSite=Lax；勾选保留登录 → Max-Age 30 天，否则会话级 Cookie
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery, authedProcedure } from "../middleware";
import { hashPassword, verifyPassword } from "../lib/authCrypto";
import {
  createSession,
  destroySession,
  findUserByEmail,
  getUserSettings,
  insertUser,
  saveUserSettings,
  updateUserProfile,
} from "../queries/users";
import { DEFAULT_AVATAR, defaultUsername } from "../../contracts/auth";
import { sessionTokenOf, setSessionCookie, clearSessionCookie } from "./cookie";

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email("邮箱格式不正确")
  .max(255);

const passwordSchema = z
  .string()
  .min(8, "密码至少 8 位")
  .max(72, "密码最长 72 位");

export const authRouter = createRouter({
  /** 注册：邮箱+密码必填；用户名缺省「用户-随机数字」，头像缺省灰色抽象半身像；成功即自动登录 */
  register: publicQuery
    .input(
      z.object({
        email: emailSchema,
        password: passwordSchema,
        username: z.string().trim().min(1).max(64).optional(),
        avatar: z.string().max(400_000).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const existing = await findUserByEmail(input.email);
      if (existing) {
        throw new TRPCError({ code: "CONFLICT", message: "该邮箱已注册，请直接登录" });
      }
      const id = crypto.randomUUID();
      const user = await insertUser({
        id,
        email: input.email,
        username: input.username || defaultUsername(),
        avatar: input.avatar || DEFAULT_AVATAR,
        passwordHash: hashPassword(input.password),
      });
      const { token } = await createSession(user.id, false);
      setSessionCookie(ctx, token, false);
      // sessionToken 随响应返回：Cookie 被浏览器拦截的上下文（iframe 预览等）走 Authorization 头轨道
      return { user, sessionToken: token };
    }),

  /** 登录：remember=true 保留登录状态（30 天），否则 12 小时会话级 */
  login: publicQuery
    .input(
      z.object({
        email: emailSchema,
        password: z.string().min(1, "请输入密码").max(72),
        remember: z.boolean().default(false),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const row = await findUserByEmail(input.email);
      // 统一报错文案，避免暴露邮箱是否已注册
      if (!row || !verifyPassword(input.password, row.passwordHash)) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "邮箱或密码不正确" });
      }
      const { token } = await createSession(row.id, input.remember);
      setSessionCookie(ctx, token, input.remember);
      const { toSafeUser } = await import("../queries/users");
      // sessionToken 随响应返回：Cookie 被拦截的上下文（iframe 预览等）走 Authorization 头轨道
      return { user: toSafeUser(row), sessionToken: token };
    }),

  logout: publicQuery.mutation(async ({ ctx }) => {
    await destroySession(sessionTokenOf(ctx.req));
    clearSessionCookie(ctx);
    return { ok: true };
  }),

  /** 当前登录用户（未登录返回 null，不报错——前端据此决定显示登录入口还是账户菜单） */
  me: publicQuery.query(({ ctx }) => ctx.user ?? null),

  updateProfile: authedProcedure
    .input(
      z.object({
        username: z.string().trim().min(1, "用户名不能为空").max(64).optional(),
        avatar: z.string().max(400_000).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const user = await updateUserProfile(ctx.user!.id, input);
      if (!user) throw new TRPCError({ code: "NOT_FOUND", message: "用户不存在" });
      return user;
    }),

  /** 设置云同步：大厅工作配置 + 分析师配置（结构由前端定义，服务端透传透存） */
  getSettings: authedProcedure.query(async ({ ctx }) => {
    return (await getUserSettings(ctx.user!.id)) ?? null;
  }),

  saveSettings: authedProcedure
    .input(z.object({ settings: z.unknown() }))
    .mutation(async ({ input, ctx }) => {
      // 防御性体积限制（异常膨胀的本地数据不入库）
      const serialized = JSON.stringify(input.settings ?? null);
      if (serialized.length > 200_000) {
        throw new TRPCError({ code: "PAYLOAD_TOO_LARGE", message: "设置数据过大" });
      }
      await saveUserSettings(ctx.user!.id, input.settings ?? null);
      return { ok: true };
    }),
});
