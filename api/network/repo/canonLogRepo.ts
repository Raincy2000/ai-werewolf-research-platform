// ============================================================
// 现实层仓储：单视角关系记忆的读写 + 用户手动编辑
// ============================================================
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { getDb } from "../../queries/connection";
import { insertReturningId } from "../../queries/dialect";
import { personaCanonLog, canonBackfillJobs, personaRelationshipHistory, personas } from "../../../db/schema";

export interface CanonLogItem {
  id: number;
  personaId: number;
  aboutPersonaId: number;
  seq: number;
  /** 手动排序位（null=按时代时间线排序；拖动排序后写入） */
  sortOrder: number | null;
  era: string;
  /** 当时年龄 */
  age: number | null;
  /** 发生地点 */
  place: string | null;
  /** 时间依据 */
  eraBasis: string | null;
  eventText: string;
  feeling: string;
  impact: string | null;
  certainty: string;
  sourceRef: string | null;
  sourceCount: number;
  sources: Array<{ title: string; url: string; tier: string; reason: string; quote?: string }>;
  verification: string;
  origin: string;
  createdAt: Date;
}

type Row = typeof personaCanonLog.$inferSelect;

export function toCanonItem(r: Row): CanonLogItem {
  let sources: CanonLogItem["sources"] = [];
  if (r.sourcesJson) {
    try { sources = JSON.parse(r.sourcesJson) as CanonLogItem["sources"]; } catch { sources = []; }
  }
  return {
    id: r.id,
    personaId: r.personaId,
    aboutPersonaId: r.aboutPersonaId,
    seq: r.seq,
    sortOrder: r.sortOrder ?? null,
    era: r.era,
    age: r.age ?? null,
    place: r.place ?? null,
    eraBasis: r.eraBasis ?? null,
    eventText: r.eventText,
    feeling: r.feeling,
    impact: r.impact ?? null,
    certainty: r.certainty,
    sourceRef: r.sourceRef ?? null,
    sourceCount: r.sourceCount,
    sources,
    verification: r.verification,
    origin: r.origin,
    createdAt: r.createdAt,
  };
}

/** 某人看某人的全部现实层记忆（默认按 seq 升序 = 时间顺序）*/
export async function listCanonLog(
  personaId: number,
  aboutPersonaId: number,
  opts: { order?: "asc" | "desc"; includeSuperseded?: boolean } = {},
): Promise<CanonLogItem[]> {
  const db = getDb();
  const conds = [eq(personaCanonLog.personaId, personaId), eq(personaCanonLog.aboutPersonaId, aboutPersonaId)];
  if (!opts.includeSuperseded) conds.push(eq(personaCanonLog.superseded, 0));
  const rows = await db
    .select()
    .from(personaCanonLog)
    .where(and(...conds))
    .orderBy(opts.order === "desc" ? desc(personaCanonLog.seq) : asc(personaCanonLog.seq));
  return rows.map(toCanonItem);
}

/** 某人全部现实层记忆（按对象分组前的平铺）*/
export async function listCanonLogFor(personaId: number): Promise<CanonLogItem[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(personaCanonLog)
    .where(and(eq(personaCanonLog.personaId, personaId), eq(personaCanonLog.superseded, 0)))
    .orderBy(asc(personaCanonLog.aboutPersonaId), asc(personaCanonLog.seq));
  return rows.map(toCanonItem);
}

/** 单条现实层记忆（归属校验用） */
export async function getCanonEvent(id: number): Promise<CanonLogItem | null> {
  const db = getDb();
  const rows: any[] = await db.select().from(personaCanonLog).where(eq(personaCanonLog.id, id)).limit(1);
  return rows[0] ? toCanonItem(rows[0]) : null;
}

/** 当前用户名下的人格 id 列表（内部聚合用；避免与 guards 循环依赖） */
async function ownerPersonaIds(userId: string): Promise<number[]> {
  const db = getDb();
  const rows: any[] = await db
    .select({ id: personas.id })
    .from(personas)
    .where(and(eq(personas.userId, userId), isNull(personas.deletedAt)));
  return rows.map((r: { id: number }) => r.id);
}

/** 覆盖统计：多少对已补、多少条记忆（按用户隔离） */
export async function canonCoverage(
  userId: string,
  personaId?: number,
): Promise<{ pairs: number; items: number }> {
  const ownIds = await ownerPersonaIds(userId);
  if (ownIds.length === 0) return { pairs: 0, items: 0 };
  const scopedFrom = personaId != null && ownIds.includes(personaId) ? [personaId] : ownIds;
  const db = getDb();
  const rows: any[] = await db
    .select({ p: personaCanonLog.personaId, a: personaCanonLog.aboutPersonaId })
    .from(personaCanonLog)
    .where(and(eq(personaCanonLog.superseded, 0), inArray(personaCanonLog.personaId, scopedFrom)));
  const filtered = personaId != null ? rows.filter((r: { p: number }) => r.p === personaId) : rows;
  const pairs = new Set(filtered.map((r: { p: number; a: number }) => r.p + "->" + r.a));
  return { pairs: pairs.size, items: filtered.length };
}

// ============================================================
// 用户手动编辑（origin = manual，无需事实核查）
// ============================================================

export async function addManualCanonEvent(input: {
  personaId: number;
  aboutPersonaId: number;
  era: string;
  eventText: string;
  feeling: string;
  impact?: string | null;
  age?: number | null;
  place?: string | null;
}): Promise<number> {
  const db = getDb();
  // seq 取当前最大 + 1
  const last = await db
    .select({ seq: personaCanonLog.seq })
    .from(personaCanonLog)
    .where(and(eq(personaCanonLog.personaId, input.personaId), eq(personaCanonLog.aboutPersonaId, input.aboutPersonaId)))
    .orderBy(desc(personaCanonLog.seq))
    .limit(1);
  const seq = (last[0]?.seq ?? 0) + 1;
  // 手动排序模式（已有 sort_order）下，新事件追加到末尾；否则保持 null 让时间线按时代排序
  let sortOrder: number | null = null;
  try {
    const sortRows: any[] = await db
      .select({ sortOrder: personaCanonLog.sortOrder })
      .from(personaCanonLog)
      .where(and(
        eq(personaCanonLog.personaId, input.personaId),
        eq(personaCanonLog.aboutPersonaId, input.aboutPersonaId),
        eq(personaCanonLog.superseded, 0),
      ));
    const maxSort = sortRows.reduce(
      (m: number, r: { sortOrder: number | null }) => Math.max(m, r.sortOrder ?? 0),
      0,
    );
    if (sortRows.some((r: { sortOrder: number | null }) => r.sortOrder != null)) sortOrder = maxSort + 1;
  } catch { /* 排序位读取失败不影响新增 */ }
  return insertReturningId(personaCanonLog, {
    personaId: input.personaId,
    aboutPersonaId: input.aboutPersonaId,
    seq,
    sortOrder,
    era: input.era,
    age: input.age ?? null,
    place: input.place ?? null,
    eventText: input.eventText,
    feeling: input.feeling,
    impact: input.impact ?? null,
    certainty: "stated",
    verification: "manual",
    origin: "manual",
  });
}

/** 编辑一条（AI 或手动都可改，改后 origin 转为 manual）*/
export async function updateCanonEvent(
  id: number,
  patch: Partial<{
    era: string;
    eventText: string;
    feeling: string;
    impact: string | null;
    age: number | null;
    place: string | null;
  }>,
): Promise<void> {
  const db = getDb();
  await db.update(personaCanonLog).set({
    ...patch,
    origin: "manual",
    verification: "manual",
  }).where(eq(personaCanonLog.id, id));
}

/** 软删除一条 */
export async function deleteCanonEvent(id: number): Promise<void> {
  const db = getDb();
  await db.update(personaCanonLog).set({ superseded: 1 }).where(eq(personaCanonLog.id, id));
}

/**
 * 拖动排序：把该 pair 的全部 active 事件按 orderedIds 的顺序写入 sort_order（1..N）。
 * 要求 orderedIds 恰为该 pair 当前 active 事件的集合（防越权改到别的事件/漏项）。
 */
export async function reorderCanonEvents(input: {
  personaId: number;
  aboutPersonaId: number;
  orderedIds: number[];
}): Promise<{ updated: number }> {
  const db = getDb();
  const rows: any[] = await db
    .select({ id: personaCanonLog.id })
    .from(personaCanonLog)
    .where(
      and(
        eq(personaCanonLog.personaId, input.personaId),
        eq(personaCanonLog.aboutPersonaId, input.aboutPersonaId),
        eq(personaCanonLog.superseded, 0),
      ),
    );
  const activeIds = rows.map((r: { id: number }) => Number(r.id));
  const wanted = [...new Set(input.orderedIds.map(Number).filter((n) => Number.isFinite(n)))];
  if (wanted.length !== activeIds.length || !wanted.every((id) => activeIds.includes(id))) {
    throw new Error("排序列表必须恰好包含该关系当前全部事件（可能有事件已被删除/移动，请刷新后重试）");
  }
  for (let i = 0; i < wanted.length; i++) {
    await db
      .update(personaCanonLog)
      .set({ sortOrder: i + 1 } as never)
      .where(eq(personaCanonLog.id, wanted[i]!));
  }
  return { updated: wanted.length };
}

// ============================================================
// 山谷层的关系变动时间线（现实层的兜底数据源）
//
// 原世界的 canon_log 还没补完时，先用对局中产生的「关系变动记录」摆出来——
// 这些是 persona_relationship_history 里每局一条的：关系定性 + Δ好感/Δ信任 + note。
// ============================================================

export interface ValleyHistoryItem {
  id: number;
  /** 局号（如 20260811001），前 8 位是日期 */
  titleNo: string;
  /** 时间（从 titleNo 推导，失败则用 created_at）*/
  era: string;
  /** 关系定性（如「同盟生隙」）*/
  relation: string;
  affinityDelta: number;
  trustDelta: number;
  affinity: number;
  trust: number;
  /** 局的备注（心理描写）*/
  note: string | null;
  gameId: string | null;
}

/** 从局号推导日期：20260811001 → 2026-08-11 */
function eraFromTitleNo(titleNo: string, fallback: number): string {
  const m = String(titleNo || "").match(/^(\d{4})(\d{2})(\d{2})/);
  if (m) return m[1] + "-" + m[2] + "-" + m[3];
  const d = new Date(fallback);
  if (Number.isNaN(d.getTime())) return "（时间不明）";
  const pad = (n: number) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}

/** 取某人对某对象在山谷中的全部关系变动（时间升序）*/
export async function listValleyHistory(
  personaId: number,
  aboutPersonaId: number,
): Promise<ValleyHistoryItem[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(personaRelationshipHistory)
    .where(
      and(
        eq(personaRelationshipHistory.personaId, personaId),
        eq(personaRelationshipHistory.targetPersonaId, aboutPersonaId),
      ),
    );
  type HRow = typeof personaRelationshipHistory.$inferSelect;
  return rows
    .map((x: HRow) => ({
      id: x.id,
      titleNo: x.titleNo ?? "",
      era: eraFromTitleNo(x.titleNo ?? "", x.createdAt instanceof Date ? x.createdAt.getTime() : Number(x.createdAt)),
      relation: x.relation ?? "",
      affinityDelta: x.affinityDelta ?? 0,
      trustDelta: x.trustDelta ?? 0,
      affinity: x.affinity ?? 0,
      trust: x.trust ?? 0,
      note: x.note ?? null,
      gameId: x.gameId ?? null,
    }))
    .sort((a: ValleyHistoryItem, b: ValleyHistoryItem) => a.era.localeCompare(b.era));
}

/** 读取补完任务状态（按用户隔离） */
export async function listBackfillJobs(userId: string, personaId?: number) {
  const ownIds = await ownerPersonaIds(userId);
  if (ownIds.length === 0) return [];
  const db = getDb();
  const conds = [inArray(canonBackfillJobs.personaId, ownIds)];
  if (personaId != null) conds.push(eq(canonBackfillJobs.personaId, personaId));
  const rows: any[] = await db.select().from(canonBackfillJobs).where(and(...conds));
  return rows;
}
