// ============================================================
// 人际网租户守卫（2026-10-22 审计修复 P0-1）
//
// 背景：network 路由此前只做 authedProcedure（登录即通过），
// graph/canon/RSQ/job 全部只按整数 id 查询 → 任意登录用户可跨账户读、改、删。
//
// 本模块是 network 域唯一的归属校验入口：
// - 人格归属：personas.user_id + deleted_at IS NULL
// - 记忆归属：persona_canon_log 的 persona/about 双方都属于当前用户
// - 任务归属：relation_completion_jobs.user_id
// ============================================================
import { TRPCError } from "@trpc/server";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { personas, personaCanonLog, relationCompletionJobs } from "../../db/schema";

/** 当前用户拥有的（未软删）人格 id 集合；传 ids 时只返回交集 */
export async function ownedPersonaIds(userId: string, ids?: number[]): Promise<number[]> {
  const db = getDb();
  if (ids && ids.length === 0) return [];
  const conds = [eq(personas.userId, userId), isNull(personas.deletedAt)];
  if (ids && ids.length > 0) conds.push(inArray(personas.id, ids));
  const rows: any[] = await db.select({ id: personas.id }).from(personas).where(and(...conds));
  return rows.map((r: { id: number }) => r.id);
}

/** 校验单个 persona 属于当前用户，否则 FORBIDDEN */
export async function assertOwnedPersona(userId: string, personaId: number): Promise<void> {
  const rows = await ownedPersonaIds(userId, [personaId]);
  if (rows.length === 0) {
    throw new TRPCError({ code: "FORBIDDEN", message: `无权访问人格 ${personaId}` });
  }
}

/** 校验一组 persona 全部属于当前用户 */
export async function assertOwnedPersonas(userId: string, personaIds: number[]): Promise<void> {
  const unique = [...new Set(personaIds.filter((x) => Number.isFinite(x) && x > 0))];
  if (unique.length === 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "缺少人格 id" });
  }
  const owned = new Set(await ownedPersonaIds(userId, unique));
  const missing = unique.filter((id) => !owned.has(id));
  if (missing.length > 0) {
    throw new TRPCError({ code: "FORBIDDEN", message: `无权访问人格 ${missing.join(",")}` });
  }
}

/** 校验一条现实层记忆属于当前用户（persona 与 about 双方） */
export async function assertOwnedCanonEvent(userId: string, eventId: number): Promise<{ personaId: number; aboutPersonaId: number }> {
  const db = getDb();
  const rows: any[] = await db
    .select({ personaId: personaCanonLog.personaId, aboutPersonaId: personaCanonLog.aboutPersonaId })
    .from(personaCanonLog)
    .where(eq(personaCanonLog.id, eventId))
    .limit(1);
  const row = rows[0];
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "现实记忆不存在" });
  await assertOwnedPersonas(userId, [row.personaId, row.aboutPersonaId]);
  return row;
}

/** 校验补完任务属于当前用户（复用 relation_completion_jobs.user_id） */
export async function assertOwnedCompletionJob(userId: string, jobId: number): Promise<void> {
  const db = getDb();
  const rows: any[] = await db
    .select({ userId: relationCompletionJobs.userId })
    .from(relationCompletionJobs)
    .where(eq(relationCompletionJobs.id, jobId))
    .limit(1);
  const row = rows[0];
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "任务不存在" });
  if (String(row.userId ?? "") !== String(userId)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "无权访问该任务" });
  }
}

/** 取当前用户全部人格 id（图/覆盖率等聚合查询用） */
export async function allOwnedPersonaIds(userId: string): Promise<number[]> {
  return ownedPersonaIds(userId);
}
