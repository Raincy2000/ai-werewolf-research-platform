// 用户与会话查询层
import { eq, lt } from "drizzle-orm";
import { getDb } from "./connection";
import { sessions, users } from "../../db/schema";
import { hashSessionToken } from "../lib/authCrypto";

// 会话有效期：勾选「保留登录状态」30 天，否则 12 小时
export const REMEMBER_SESSION_MS = 30 * 24 * 3600 * 1000;
export const SHORT_SESSION_MS = 12 * 3600 * 1000;

export type SafeUser = {
  id: string;
  email: string;
  username: string;
  avatar: string;
  createdAt: string;
};

function toSafeUser(row: typeof users.$inferSelect): SafeUser {
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    avatar: row.avatar,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function findUserByEmail(email: string) {
  const rows = await getDb().select().from(users).where(eq(users.email, email)).limit(1);
  return rows[0] ?? null;
}

export async function findUserById(id: string) {
  const rows = await getDb().select().from(users).where(eq(users.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function insertUser(row: typeof users.$inferInsert): Promise<SafeUser> {
  await getDb().insert(users).values(row);
  const created = await findUserById(row.id as string);
  return toSafeUser(created!);
}

export async function updateUserProfile(
  id: string,
  patch: { username?: string; avatar?: string },
): Promise<SafeUser | null> {
  await getDb()
    .update(users)
    .set({
      ...(patch.username !== undefined ? { username: patch.username } : {}),
      ...(patch.avatar !== undefined ? { avatar: patch.avatar } : {}),
    })
    .where(eq(users.id, id));
  const row = await findUserById(id);
  return row ? toSafeUser(row) : null;
}

export async function getUserSettings(id: string): Promise<unknown> {
  const row = await findUserById(id);
  return row?.settings ?? null;
}

export async function saveUserSettings(id: string, settings: unknown): Promise<void> {
  await getDb().update(users).set({ settings: settings as never }).where(eq(users.id, id));
}

// ---------- 会话 ----------
export async function createSession(userId: string, remember: boolean): Promise<{ token: string; expiresAt: Date }> {
  const { generateSessionToken } = await import("../lib/authCrypto");
  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + (remember ? REMEMBER_SESSION_MS : SHORT_SESSION_MS));
  await getDb().insert(sessions).values({
    tokenHash: hashSessionToken(token),
    userId,
    remember: remember ? 1 : 0,
    expiresAt,
  });
  return { token, expiresAt };
}

/** 凭 cookie token 解析会话：有效则返回用户；过期即删并按未登录处理 */
export async function resolveSession(token: string | undefined): Promise<SafeUser | null> {
  if (!token) return null;
  const tokenHash = hashSessionToken(token);
  const rows = await getDb().select().from(sessions).where(eq(sessions.tokenHash, tokenHash)).limit(1);
  const sess = rows[0];
  if (!sess) return null;
  if (sess.expiresAt.getTime() <= Date.now()) {
    await getDb().delete(sessions).where(eq(sessions.id, sess.id));
    return null;
  }
  const user = await findUserById(sess.userId);
  return user ? toSafeUser(user) : null;
}

export async function destroySession(token: string | undefined): Promise<void> {
  if (!token) return;
  await getDb().delete(sessions).where(eq(sessions.tokenHash, hashSessionToken(token)));
}

// 供未来清理任务使用：删除全部过期会话
export async function pruneExpiredSessions(): Promise<void> {
  await getDb().delete(sessions).where(lt(sessions.expiresAt, new Date()));
}

export { toSafeUser };
