// ============================================================
// L2 持久层：一阶关系仓储（纯数据访问，**零业务逻辑**）
// 入参/出参使用契约层类型（contracts/interpersonal）；此处只做 row ↔ 契约映射
// 业务规则（台账/不变量/收口）在 L3 服务层，不在此处
// ============================================================
import { and, eq, inArray, ne, or } from "drizzle-orm";
import { getDb } from "../../queries/connection";
import { insertIgnore } from "../../queries/dialect";
import { personaRelations } from "../../../db/schema";
import type { RelationRow, RelationLayer, RelationForm } from "../../../contracts/interpersonal";

type Row = typeof personaRelations.$inferSelect;
type NewRow = typeof personaRelations.$inferInsert;

/** DB row → 契约 RelationRow */
export function toRelationRow(r: Row): RelationRow {
  return {
    id: r.id,
    fromPersonaId: r.fromPersonaId,
    toPersonaId: r.toPersonaId,
    toName: r.toName ?? null,
    layer: r.layer as RelationLayer,
    form: (r.form ?? "CS") as RelationForm,
    kind: r.kind,
    prototypicality: r.prototypicality ?? 1,
    positivity: r.positivity ?? 0,
    negativity: r.negativity ?? 0,
    trust: r.trust ?? 50,
    closeness: r.closeness ?? 0,
    dependence: r.dependence ?? 0,
    reciprocity: r.reciprocity ?? 0,
    powerBalance: r.powerBalance ?? 0,
    formality: r.formality ?? 0,
    commitment: r.commitment ?? 0,
    violationCount: r.violationCount ?? 0,
    awareness: (r.awareness ?? "full") as RelationRow["awareness"],
    disclosable: r.disclosable ?? 1,
    status: (r.status ?? "active") as RelationRow["status"],
    supersededBy: r.supersededBy ?? null,
    originModule: r.originModule,
    originVersion: r.originVersion,
  };
}

export interface RelationFilter {
  fromPersonaId?: number;
  toPersonaId?: number;
  layer?: RelationLayer;
  status?: "active" | "superseded";
  /** 是否包含悬空边（to=0） */
  includeDangling?: boolean;
}

/** 按条件列出关系（默认只取 active） */
export async function listRelations(filter: RelationFilter = {}): Promise<RelationRow[]> {
  const db = getDb();
  const conds = [eq(personaRelations.status, filter.status ?? "active")];
  if (filter.fromPersonaId != null) conds.push(eq(personaRelations.fromPersonaId, filter.fromPersonaId));
  if (filter.toPersonaId != null) conds.push(eq(personaRelations.toPersonaId, filter.toPersonaId));
  if (filter.layer) conds.push(eq(personaRelations.layer, filter.layer));
  if (!filter.includeDangling) conds.push(ne(personaRelations.toPersonaId, 0));
  const rows = await db.select().from(personaRelations).where(and(...conds));
  return rows.map(toRelationRow);
}

/** 某人格发出的全部关系（含悬空边） */
export async function listOutgoing(personaId: number, layer?: RelationLayer): Promise<RelationRow[]> {
  return listRelations({ fromPersonaId: personaId, layer, includeDangling: true });
}

/** 某人格收到的全部关系 */
export async function listIncoming(personaId: number, layer?: RelationLayer): Promise<RelationRow[]> {
  return listRelations({ toPersonaId: personaId, layer });
}

/** 一对 dyad 的全部关系（双向，两层） */
export async function listDyad(a: number, b: number): Promise<RelationRow[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(personaRelations)
    .where(
      and(
        eq(personaRelations.status, "active"),
        or(
          and(eq(personaRelations.fromPersonaId, a), eq(personaRelations.toPersonaId, b)),
          and(eq(personaRelations.fromPersonaId, b), eq(personaRelations.toPersonaId, a)),
        ),
      ),
    );
  return rows.map(toRelationRow);
}

/** 插入一条关系（冲突则忽略；跨方言走 insertIgnore） */
export async function insertRelation(row: NewRow): Promise<void> {
  await insertIgnore(personaRelations, row);
}

/** 更新一条关系（按 id） */
export async function updateRelation(id: number, patch: Partial<NewRow>): Promise<void> {
  const db = getDb();
  await db
    .update(personaRelations)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(personaRelations.id, id));
}

/** 标记 superseded（不删除史实，§13.5） */
export async function markSuperseded(id: number, byId: number | null): Promise<void> {
  await updateRelation(id, { status: "superseded", supersededBy: byId });
}

/** 取全部悬空边（to_persona_id = 0，指向库外角色，§19） */
export async function listDangling(): Promise<RelationRow[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(personaRelations)
    .where(and(eq(personaRelations.toPersonaId, 0), eq(personaRelations.status, "active")));
  return rows.map(toRelationRow);
}

/** 按名字接合悬空边（编织用）：找到 to_name 匹配的悬空边 */
export async function listDanglingByNames(names: string[]): Promise<RelationRow[]> {
  if (names.length === 0) return [];
  const db = getDb();
  const rows = await db
    .select()
    .from(personaRelations)
    .where(
      and(
        eq(personaRelations.toPersonaId, 0),
        eq(personaRelations.status, "active"),
        inArray(personaRelations.toName, names),
      ),
    );
  return rows.map(toRelationRow);
}

/** 统计（用于验收指标 G1/G2） */
export async function relationCounts(): Promise<{ layer: string; status: string; count: number }[]> {
  const db = getDb();
  const rows = await db.select().from(personaRelations);
  const map = new Map<string, number>();
  for (const r of rows) {
    const k = `${r.layer}/${r.status}`;
    map.set(k, (map.get(k) ?? 0) + 1);
  }
  return [...map.entries()].map(([k, count]) => {
    const [layer, status] = k.split("/");
    return { layer: layer ?? "", status: status ?? "", count };
  });
}
