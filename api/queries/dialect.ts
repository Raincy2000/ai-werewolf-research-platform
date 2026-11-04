// ============================================================
// 数据库方言适配层（2026-10-22 关系网修复批次1）
//
// 背景：drizzle 的 mysql2/planetscale builder **没有** `.returning()` 与
// `.onConflictDoNothing()`（SQLite 有）；此前 network/persona/canon 模块直接使用，
// 导致云端 MySQL/TiDB 下铸造、RSQ、补完、canon 补完全部 500 或静默空写。
//
// 约定：所有需要「插入拿自增 id」或「插入忽略冲突」的代码统一走本模块，
// 不要在业务代码里直接调用 .returning()/onConflictDoNothing()。
// ============================================================
import { and, eq, ne, sql } from "drizzle-orm";
import { env } from "../lib/env";
import { getDb } from "./connection";

export const isSqlite = env.dbDialect === "sqlite";

/**
 * 插入一行并返回自增主键 id。
 * - SQLite：insert ... returning(id)
 * - MySQL：insert 结果取 insertId（drizzle mysql2 返回 [ResultSetHeader, ...]）
 */
export async function insertReturningId(table: any, values: any): Promise<number> {
  const db = getDb();
  if (isSqlite) {
    const rows = await db.insert(table).values(values).returning({ id: table.id });
    return Number(rows[0]?.id ?? 0);
  }
  const res: any = await db.insert(table).values(values);
  const header = Array.isArray(res) ? res[0] : res;
  return Number(header?.insertId ?? 0);
}

/** 插入一行并忽略唯一键冲突（跨方言）。 */
export async function insertIgnore(table: any, values: any): Promise<void> {
  const db = getDb();
  if (isSqlite) {
    await db.insert(table).values(values).onConflictDoNothing();
    return;
  }
  // MySQL：on duplicate key update 自身主键 = 无副作用
  await db.insert(table).values(values).onDuplicateKeyUpdate({ set: { id: sql`id` } });
}

/**
 * 条件更新（CAS 语义），不覆盖 cancelled 终态。
 * 返回更新后的行状态（用于调用方判断是否被取消）。
 *
 * 注意：SQLite sqlite-proxy 驱动不返回 affectedRows，所以这里更新后再读一次状态；
 * 单进程模型下足够可靠（真正的并发只发生在同一 job 的后台协程之间）。
 */
export async function updateJobTerminalState(
  table: any,
  id: number,
  status: string,
  fields: Record<string, unknown> = {},
): Promise<string | null> {
  const db = getDb();
  await db
    .update(table)
    .set({ status, ...fields } as never)
    .where(and(eq(table.id, id), ne(table.status, "cancelled")));
  const rows: any[] = await db.select({ status: table.status }).from(table).where(eq(table.id, id)).limit(1);
  return rows[0]?.status ?? null;
}
