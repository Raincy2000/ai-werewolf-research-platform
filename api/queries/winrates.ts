// ============================================================
// 胜率推测记录查询（game_winrates 表，append-only）
// id 自增即增量游标：前端按 afterWinRateId 轮询拉取新评估记录
// ============================================================

import { and, asc, desc, eq, gt } from "drizzle-orm";
import { getDb } from "./connection";
import { gameWinrates } from "../../db/schema";
import type { WinRateEntry } from "../../contracts/game";

export async function insertWinRate(row: typeof gameWinrates.$inferInsert) {
  await getDb().insert(gameWinrates).values(row);
}

function toEntry(r: typeof gameWinrates.$inferSelect): WinRateEntry {
  return {
    id: Number(r.id),
    day: r.day,
    phase: r.phase,
    goodPct: r.goodPct,
    wolfPct: r.wolfPct,
    reasons: Array.isArray(r.reasons) ? (r.reasons as unknown[]).map(String) : [],
    triggerLabel: r.triggerLabel ?? null,
    createdAt: r.createdAt.toISOString(),
  };
}

/** id > afterId 的增量评估记录（id 升序，前端逐条追加） */
export async function getWinRatesAfter(
  gameId: string,
  afterId: number,
  limit = 200,
): Promise<WinRateEntry[]> {
  const rows = await getDb()
    .select()
    .from(gameWinrates)
    .where(and(eq(gameWinrates.gameId, gameId), gt(gameWinrates.id, afterId)))
    .orderBy(asc(gameWinrates.id))
    .limit(limit);
  return rows.map(toEntry);
}

/** 最新一条评估记录（胜率条展示用；无记录返回 null，调用方按 50/50 初始面板处理） */
export async function getLatestWinRate(gameId: string): Promise<WinRateEntry | null> {
  const rows = await getDb()
    .select()
    .from(gameWinrates)
    .where(eq(gameWinrates.gameId, gameId))
    .orderBy(desc(gameWinrates.id))
    .limit(1);
  return rows[0] ? toEntry(rows[0]) : null;
}
