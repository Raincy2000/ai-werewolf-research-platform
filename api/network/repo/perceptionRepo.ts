// ============================================================
// L2 持久层：二阶关系认知仓储（§24）
// ============================================================
import { and, eq } from "drizzle-orm";
import { getDb } from "../../queries/connection";
import { perceivedDyadRelations } from "../../../db/schema";
import type { PerceivedDyadRelation, PerceivedGranularity, PerceivedSource } from "../../../contracts/interpersonal";

type Row = typeof perceivedDyadRelations.$inferSelect;

export function toPerceived(r: Row): PerceivedDyadRelation {
  return {
    id: r.id,
    observerId: r.observerId,
    aboutFromId: r.aboutFromId,
    aboutToId: r.aboutToId,
    granularity: r.granularity as PerceivedGranularity,
    dimensions: (r.dimensionsJson ?? {}) as Record<string, unknown>,
    confidence: r.confidence ?? 0,
    source: r.source as PerceivedSource,
    biasKind: (r.biasKind ?? null) as PerceivedDyadRelation["biasKind"],
    accuracy: r.accuracy ?? null,
  };
}

/** 某观察者的全部二阶认知 */
export async function listPerceptions(observerId: number): Promise<PerceivedDyadRelation[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(perceivedDyadRelations)
    .where(eq(perceivedDyadRelations.observerId, observerId));
  return rows.map(toPerceived);
}

/** 某观察者对特定 dyad 的认知 */
export async function getPerception(
  observerId: number,
  aboutFromId: number,
  aboutToId: number,
): Promise<PerceivedDyadRelation | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(perceivedDyadRelations)
    .where(
      and(
        eq(perceivedDyadRelations.observerId, observerId),
        eq(perceivedDyadRelations.aboutFromId, aboutFromId),
        eq(perceivedDyadRelations.aboutToId, aboutToId),
      ),
    )
    .limit(1);
  return rows.length ? toPerceived(rows[0]!) : null;
}

/** 写入/更新（按唯一索引 upsert；跨方言手写实现，兼容 MySQL 无 onConflictDoUpdate） */
export async function upsertPerception(p: PerceivedDyadRelation): Promise<void> {
  const db = getDb();
  const values = {
    observerId: p.observerId,
    aboutFromId: p.aboutFromId,
    aboutToId: p.aboutToId,
    granularity: p.granularity,
    dimensionsJson: (p.dimensions ?? {}) as never,
    confidence: p.confidence,
    source: p.source,
    biasKind: p.biasKind ?? null,
    accuracy: p.accuracy ?? null,
    updatedAt: new Date(),
  };
  const existing: any[] = await db
    .select({ id: perceivedDyadRelations.id })
    .from(perceivedDyadRelations)
    .where(
      and(
        eq(perceivedDyadRelations.observerId, p.observerId),
        eq(perceivedDyadRelations.aboutFromId, p.aboutFromId),
        eq(perceivedDyadRelations.aboutToId, p.aboutToId),
      ),
    )
    .limit(1);
  if (existing[0]) {
    await db.update(perceivedDyadRelations).set(values as never).where(eq(perceivedDyadRelations.id, existing[0].id));
  } else {
    try {
      await db.insert(perceivedDyadRelations).values(values as never);
    } catch {
      // 并发唯一冲突：转为更新
      await db
        .update(perceivedDyadRelations)
        .set(values as never)
        .where(
          and(
            eq(perceivedDyadRelations.observerId, p.observerId),
            eq(perceivedDyadRelations.aboutFromId, p.aboutFromId),
            eq(perceivedDyadRelations.aboutToId, p.aboutToId),
          ),
        );
    }
  }
}
