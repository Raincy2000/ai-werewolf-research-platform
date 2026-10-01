import { and, eq, desc, gt, asc, like, sql, gte, lt, isNull } from "drizzle-orm";
import { getDb } from "./connection";
import { games, gameEvents } from "../../db/schema";
import type { GameEvent } from "../../contracts/game";

export async function insertGame(row: typeof games.$inferInsert) {
  await getDb().insert(games).values(row);
}

export async function updateGame(id: string, patch: Partial<typeof games.$inferInsert>) {
  // SQLite 无 onUpdateNow：显式刷新 updated_at（MySQL 下等价无害）
  await getDb()
    .update(games)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(games.id, id));
}

export async function getGame(id: string) {
  const rows = await getDb().select().from(games).where(eq(games.id, id)).limit(1);
  return rows[0] ?? null;
}

/** 历史对局列表（按创建时间倒序）；本地桌面端不限保存数量，默认全量返回 */
export async function listGames(
  userId: string,
  limit?: number,
): Promise<(typeof games.$inferSelect)[]> {
  const q = getDb()
    .select()
    .from(games)
    .where(eq(games.userId, userId))
    .orderBy(desc(games.createdAt));
  return typeof limit === "number" ? q.limit(limit) : q;
}

/** 指定用户在本地日期区间 [dayStart, dayEnd) 内创建的对局数（对局标题号的当日序号依据） */
export async function countGamesOnDate(
  userId: string | null,
  dayStart: Date,
  dayEnd: Date,
): Promise<number> {
  const cond = userId === null ? isNull(games.userId) : eq(games.userId, userId);
  const rows = await getDb()
    .select({ count: sql<number>`count(*)` })
    .from(games)
    .where(and(cond, gte(games.createdAt, dayStart), lt(games.createdAt, dayEnd)));
  return Number(rows[0]?.count ?? 0);
}

export async function appendEvents(rows: (typeof gameEvents.$inferInsert)[]) {
  if (rows.length === 0) return;
  await getDb().insert(gameEvents).values(rows);
}

export async function getEventsAfter(gameId: string, afterSeq: number): Promise<GameEvent[]> {
  const rows = await getDb()
    .select()
    .from(gameEvents)
    .where(and(eq(gameEvents.gameId, gameId), gt(gameEvents.seq, afterSeq)))
    .orderBy(asc(gameEvents.seq))
    .limit(2000);
  return rows
    .map((r: typeof gameEvents.$inferSelect) => ({
      seq: r.seq,
      day: r.day,
      phase: r.phase,
      type: r.type as GameEvent["type"],
      actor: r.actor,
      actorLabel: r.actorLabel,
      title: r.title,
      content: r.content,
      thought: r.thought,
      meta: (r.meta as Record<string, unknown> | null) ?? null,
      createdAt: r.createdAt.toISOString(),
    }));
}

export async function getAllEvents(gameId: string): Promise<GameEvent[]> {
  const rows = await getDb()
    .select()
    .from(gameEvents)
    .where(eq(gameEvents.gameId, gameId))
    .orderBy(asc(gameEvents.seq))
    .limit(20000);
  return rows.map((r: typeof gameEvents.$inferSelect) => ({
    seq: r.seq,
    day: r.day,
    phase: r.phase,
    type: r.type as GameEvent["type"],
    actor: r.actor,
    actorLabel: r.actorLabel,
    title: r.title,
    content: r.content,
    thought: r.thought,
    meta: (r.meta as Record<string, unknown> | null) ?? null,
    createdAt: r.createdAt.toISOString(),
  }));
}

/** 最近 limit 条事件（按 seq 升序返回；断点恢复时比对「最后一条决策的事件批」已落盘前缀用） */
export async function getLatestEvents(gameId: string, limit: number): Promise<GameEvent[]> {
  const rows = await getDb()
    .select()
    .from(gameEvents)
    .where(eq(gameEvents.gameId, gameId))
    .orderBy(desc(gameEvents.seq))
    .limit(limit);
  return rows.reverse().map((r: typeof gameEvents.$inferSelect) => ({
    seq: r.seq,
    day: r.day,
    phase: r.phase,
    type: r.type as GameEvent["type"],
    actor: r.actor,
    actorLabel: r.actorLabel,
    title: r.title,
    content: r.content,
    thought: r.thought,
    meta: (r.meta as Record<string, unknown> | null) ?? null,
    createdAt: r.createdAt.toISOString(),
  }));
}

/** 某对局当前最大事件 seq（恢复时初始化事件游标；无事件返回 0） */
/** 最近一条阶段提醒事件（断点恢复时初始化 displayPhase 用） */
export async function getLatestPhaseEvent(gameId: string): Promise<GameEvent | null> {
  const rows = await getDb()
    .select()
    .from(gameEvents)
    .where(and(eq(gameEvents.gameId, gameId), eq(gameEvents.type, "phase")))
    .orderBy(desc(gameEvents.seq))
    .limit(1);
  const r = rows[0];
  return r
    ? {
        seq: r.seq,
        day: r.day,
        phase: r.phase,
        type: r.type as GameEvent["type"],
        actor: r.actor,
        actorLabel: r.actorLabel,
        title: r.title,
        content: r.content,
        thought: r.thought,
        meta: (r.meta as GameEvent["meta"]) ?? null,
        createdAt: r.createdAt.toISOString(),
      }
    : null;
}

/** 是否已有赛后讨论事件（phase=postgame.*）：已结束对局补开赛后讨论的幂等判定与资格透出用 */
export async function hasPostGameEvents(gameId: string): Promise<boolean> {
  const rows = await getDb()
    .select({ seq: gameEvents.seq })
    .from(gameEvents)
    .where(and(eq(gameEvents.gameId, gameId), like(gameEvents.phase, "postgame%")))
    .limit(1);
  return rows.length > 0;
}

export async function getMaxEventSeq(gameId: string): Promise<number> {
  const rows = await getDb()
    .select({ max: sql<number | null>`max(seq)` })
    .from(gameEvents)
    .where(eq(gameEvents.gameId, gameId));
  return Number(rows[0]?.max ?? 0);
}
