// ============================================================
// 后台任务控制（2026-10-22 审计 P0-7）
//
// 解决三个历史事故：
//  1. `withTimeout` 只 reject 外层，底层 AI 调用继续跑 → 任务超时后仍写数据；
//     现在每个任务注册一个 AbortController，超时/取消/暂停都通过 signal 真正中止调用链。
//  2. 任务收尾无条件 `status:'applied'` → 已被 cancel/failed 的任务被稍后覆盖；
//     统一走 finishJob：UPDATE ... WHERE status NOT IN ('cancelled')（CAS，不覆盖已取消）。
//  3. 前端「终止/暂停」只改 DB，后台协程不知情；cancelJobRecord 同步 abort 内存控制器。
//
// 内存注册表是单进程模型：应用重启后注册表为空，僵尸任务由 DB 侧
// （weave.getCompletionStatus / canonBackfill 启动自愈）收尾。
// ============================================================
import { and, eq, ne, notInArray } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { relationCompletionJobs, canonBackfillJobs } from "../../db/schema";

/** 内存 AbortController 注册表：jobId → controller */
const controllers = new Map<number, AbortController>();

/** 可收尾的任务表（weave 补完 / canon 现实层补完共用一套收尾语义） */
export type JobTableName = "completion" | "backfill";

function tableOf(name: JobTableName) {
  return name === "backfill" ? canonBackfillJobs : relationCompletionJobs;
}

/**
 * 注册任务控制器。
 * - 首次注册返回 true；
 * - 同一 jobId 已有未中止的控制器 → 返回 false（调用方应放弃启动，避免重复计费/重复写入）。
 */
export function registerJob(jobId: number, controller: AbortController): boolean {
  if (!Number.isFinite(jobId) || jobId <= 0) return false;
  const existing = controllers.get(jobId);
  if (existing && !existing.signal.aborted) return false;
  controllers.set(jobId, controller);
  return true;
}

/** 中止任务调用链（不发 DB 更新；DB 状态由 cancelJobRecord/finishJob 负责） */
export function abortJob(jobId: number, reason?: string): void {
  const c = controllers.get(jobId);
  if (!c || c.signal.aborted) return;
  const err = reason ? new Error(reason) : new Error("任务已终止");
  err.name = "AbortError";
  c.abort(err);
}

/** 任务是否已被中止（不在注册表 → false；注册表被重启清空时由 DB 状态兜底） */
export function isJobAborted(jobId: number): boolean {
  const c = controllers.get(jobId);
  return Boolean(c && c.signal.aborted);
}

/** 任务当前是否在本进程运行（有未中止的控制器） */
export function isJobActive(jobId: number): boolean {
  const c = controllers.get(jobId);
  return Boolean(c && !c.signal.aborted);
}

/** 清理注册表（任务收尾 finally 调用；不影响 DB） */
export function clearJob(jobId: number): void {
  controllers.delete(jobId);
}

/** 仅供测试/诊断：当前活跃任务 id */
export function listJobIds(): number[] {
  return [...controllers.keys()];
}

export interface FinishJobFields {
  /** JSON 字符串（progress 列，completion 表才有） */
  progress?: string | null;
  /** JSON 字符串（stats 列） */
  stats?: string | null;
  /** 任务项数（completion: 处理卡数；canon: active 记忆总数） */
  itemCount?: number;
  /** 失败原因（canon 表 error 列） */
  error?: string | null;
  /** 降级警告（canon 表 warning 列） */
  warning?: string | null;
  /** 是否联网（canon 表 web_searched 列） */
  webSearched?: number;
  finishedAt?: Date | null;
}

/**
 * 写任务终态（CAS，终态不可互相覆盖）：
 *  - 任何 finishJob 都不会覆盖 cancelled（用户已终止的任务不能被后台协程翻案）；
 *  - applied（成功终态）不会被 failed 覆盖；failed 也不会被 applied 覆盖
 *    （修复 P0-7：先失败的任务稍后又被无条件写成 applied）；
 *  - failed→failed / applied→applied 允许（幂等补写 stats/finishedAt）。
 *
 * 返回 DB 中的最终 status（可能仍是 cancelled / 已有终态），调用方据此判断是否被取消。
 * 说明：SQLite sqlite-proxy 不返回 affectedRows，所以更新后再读一次状态判定。
 */
export async function finishJob(
  jobId: number,
  status: string,
  fields: FinishJobFields = {},
  tableName: JobTableName = "completion",
): Promise<string | null> {
  if (!Number.isFinite(jobId) || jobId <= 0) return null;
  const db = getDb();
  const table = tableOf(tableName);
  const patch: Record<string, unknown> = { status };
  // 只写目标表真实存在的列，避免把 progress 写进 canon 表之类
  if (tableName === "completion") {
    if (fields.progress !== undefined) patch.progress = fields.progress;
  } else {
    if (fields.error !== undefined) patch.error = fields.error;
    if (fields.warning !== undefined) patch.warning = fields.warning;
    if (fields.webSearched !== undefined) patch.webSearched = fields.webSearched;
  }
  if (fields.stats !== undefined) patch.stats = fields.stats;
  if (fields.itemCount !== undefined) patch.itemCount = fields.itemCount;
  if (fields.finishedAt !== undefined) patch.finishedAt = fields.finishedAt;
  try {
    // 终态保护：cancelled 永不被覆盖；applied/failed 互不覆盖
    const conds =
      status === "applied"
        ? [eq(table.id, jobId), notInArray(table.status, ["cancelled", "failed"])]
        : status === "failed"
          ? [eq(table.id, jobId), notInArray(table.status, ["cancelled", "applied"])]
          : [eq(table.id, jobId), ne(table.status, "cancelled")];
    await db
      .update(table)
      .set(patch as never)
      .where(and(...conds));
  } catch {
    return null;
  }
  const rows: any[] = await db.select({ status: table.status }).from(table).where(eq(table.id, jobId)).limit(1);
  return rows[0]?.status ?? null;
}

/**
 * 终止任务：DB 置 cancelled（已 applied 的不回退）+ abort 内存控制器。
 * 返回 DB 最终是否为 cancelled。
 */
export async function cancelJobRecord(jobId: number): Promise<boolean> {
  if (!Number.isFinite(jobId) || jobId <= 0) return false;
  const db = getDb();
  try {
    await db
      .update(relationCompletionJobs)
      .set({ status: "cancelled", finishedAt: new Date() })
      .where(and(eq(relationCompletionJobs.id, jobId), ne(relationCompletionJobs.status, "applied")));
  } catch {
    return false;
  }
  abortJob(jobId);
  const rows: any[] = await db
    .select({ status: relationCompletionJobs.status })
    .from(relationCompletionJobs)
    .where(eq(relationCompletionJobs.id, jobId))
    .limit(1);
  return rows[0]?.status === "cancelled";
}
