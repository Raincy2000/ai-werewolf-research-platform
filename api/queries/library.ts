// 图书馆文档 + 赛前学习笔记 查询层（双方言可移植：仅用 drizzle 构建器）
import { and, asc, desc, eq } from "drizzle-orm";
import { getDb } from "./connection";
import { libraryDocs, gameStudies } from "../../db/schema";

export interface LibraryDocRow {
  id: number;
  userId: string;
  name: string;
  format: string;
  content: string;
  sizeBytes: number;
  createdAt: Date;
}

export async function insertLibraryDoc(row: {
  userId: string;
  name: string;
  format: string;
  content: string;
  sizeBytes: number;
}): Promise<number> {
  const db = getDb();
  const res = await db.insert(libraryDocs).values(row);
  // 主键回取：sqlite-proxy 无 insertId，退回按最新行查询（同 presets 方言分叉语义）
  const id = (res as unknown as [{ insertId?: number }])[0]?.insertId;
  if (id != null) return Number(id);
  const back = await db
    .select({ id: libraryDocs.id })
    .from(libraryDocs)
    .where(eq(libraryDocs.userId, row.userId))
    .orderBy(desc(libraryDocs.id))
    .limit(1);
  return Number(back[0]!.id);
}

export async function listLibraryDocs(userId: string) {
  const db = getDb();
  const rows = await db
    .select({
      id: libraryDocs.id,
      name: libraryDocs.name,
      format: libraryDocs.format,
      sizeBytes: libraryDocs.sizeBytes,
      createdAt: libraryDocs.createdAt,
    })
    .from(libraryDocs)
    .where(eq(libraryDocs.userId, userId))
    .orderBy(desc(libraryDocs.id));
  return rows.map((r: { createdAt: Date; [k: string]: unknown }) => ({
    ...r,
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function getLibraryDoc(id: number, userId: string): Promise<LibraryDocRow | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(libraryDocs)
    .where(and(eq(libraryDocs.id, id), eq(libraryDocs.userId, userId)))
    .limit(1);
  return (rows[0] as LibraryDocRow | undefined) ?? null;
}

export async function getAllLibraryContents(userId: string): Promise<{ name: string; content: string }[]> {
  const db = getDb();
  const rows = await db
    .select({ name: libraryDocs.name, content: libraryDocs.content })
    .from(libraryDocs)
    .where(eq(libraryDocs.userId, userId))
    .orderBy(asc(libraryDocs.id));
  return rows;
}

export async function deleteLibraryDoc(id: number, userId: string): Promise<boolean> {
  const db = getDb();
  // 先查后删（sqlite-proxy 无 affectedRows，与 presets 同款可移植写法）
  const existing = await db
    .select({ id: libraryDocs.id })
    .from(libraryDocs)
    .where(and(eq(libraryDocs.id, id), eq(libraryDocs.userId, userId)))
    .limit(1);
  if (existing.length === 0) return false;
  await db.delete(libraryDocs).where(and(eq(libraryDocs.id, id), eq(libraryDocs.userId, userId)));
  return true;
}

// ---------- 赛前学习笔记 ----------
export async function upsertStudyNote(gameId: string, seat: number, notes: string): Promise<void> {
  const db = getDb();
  const existing = await db
    .select({ id: gameStudies.id })
    .from(gameStudies)
    .where(and(eq(gameStudies.gameId, gameId), eq(gameStudies.seat, seat)))
    .limit(1);
  if (existing.length > 0) {
    await db
      .update(gameStudies)
      .set({ notes })
      .where(and(eq(gameStudies.gameId, gameId), eq(gameStudies.seat, seat)));
  } else {
    await db.insert(gameStudies).values({ gameId, seat, notes });
  }
}

export async function getStudyNotes(gameId: string): Promise<{ seat: number; notes: string }[]> {
  const db = getDb();
  const rows = await db
    .select({ seat: gameStudies.seat, notes: gameStudies.notes })
    .from(gameStudies)
    .where(eq(gameStudies.gameId, gameId))
    .orderBy(asc(gameStudies.seat));
  return rows;
}
