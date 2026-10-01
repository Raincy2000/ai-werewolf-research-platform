import { eq, asc, sql } from "drizzle-orm";
import { getDb } from "./connection";
import { gameDecisions } from "../../db/schema";
import type { DecisionInput, DecisionKind } from "../game/engine/api";

export interface DecisionLogRow {
  idx: number;
  kind: DecisionKind;
  seat: number;
  decision: DecisionInput;
}

/** 追加一条决策日志（idx 由服务层 per-game 递增计数保证） */
export async function appendDecision(row: {
  gameId: string;
  idx: number;
  kind: string;
  seat: number;
  decision: DecisionInput;
}): Promise<void> {
  await getDb().insert(gameDecisions).values({
    gameId: row.gameId,
    idx: row.idx,
    kind: row.kind,
    seat: row.seat,
    decision: row.decision,
  });
}

/** 按重放顺序读取某对局的全部决策日志 */
export async function getDecisions(gameId: string): Promise<DecisionLogRow[]> {
  const rows = await getDb()
    .select()
    .from(gameDecisions)
    .where(eq(gameDecisions.gameId, gameId))
    .orderBy(asc(gameDecisions.idx))
    .limit(20000);
  return rows.map((r: typeof gameDecisions.$inferSelect) => ({
    idx: r.idx,
    kind: r.kind as DecisionKind,
    seat: r.seat,
    decision: r.decision as DecisionInput,
  }));
}

/** 某对局已落盘的决策数（恢复时初始化内存计数器） */
export async function countDecisions(gameId: string): Promise<number> {
  const rows = await getDb()
    .select({ n: sql<number>`count(*)` })
    .from(gameDecisions)
    .where(eq(gameDecisions.gameId, gameId));
  return Number(rows[0]?.n ?? 0);
}
