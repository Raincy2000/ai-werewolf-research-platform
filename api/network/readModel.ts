// ============================================================
// L3 服务层：**唯一读取入口**（§27.5 Read Model）
// 融合 / 派生量 / 排序只在此一处实现；可见度裁剪由调用台按 viewer 执行。
//
// 2026-10-22 审计修复：
// - readDyad 只返回 a↔b 双边关系（旧实现返回 a/b 对所有人的边）
// - outgoingOnly=false 真正读入边（旧实现反而丢弃 vale 层）
// - 统一使用 repo 的 row→契约映射，避免两套 toRow 漂移
// ============================================================
import { and, eq, inArray, or } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { personaRelations } from "../../db/schema";
import {
  deriveMetrics, mergeLayers, rankHierarchy,
  type RelationRow, type RelationMetrics, type RelationLayer,
} from "../../contracts/interpersonal";
import { listRelations, toRelationRow } from "./repo/relationRepo";

export interface PresentedRelation extends RelationRow {
  /** 双维派生量（不落库，随时可重算） */
  metrics: RelationMetrics;
  /** 依恋层级序号（1 = 最重要，按 from 分组） */
  rank: number;
  /** 方向：outgoing=我→对方；incoming=对方→我（仅在 outgoingOnly=false 时） */
  direction?: "outgoing" | "incoming";
  /** 合并来源层（canon/vale），用于渲染时区分词表与信任语义 */
  sourceLayers?: RelationLayer[];
}

export interface ReadRelationsOptions {
  /** 观察者人格 id（决定可见度与排序） */
  personaId: number;
  /** 只取与这些人的关系（缺省 = 全部） */
  targetPersonaIds?: number[];
  /** 是否只取发出的（默认 true：我看别人）；false 时并发读取入边 */
  outgoingOnly?: boolean;
}

/**
 * 唯一读取入口：融合两层 → 派生量 → 排序。
 * ⚠️ 不在此处做可见度裁剪（调用台按 personaVisibility 过滤）；此处给出**客观呈现层**。
 */
export async function readRelations(opts: ReadRelationsOptions): Promise<PresentedRelation[]> {
  const { personaId, targetPersonaIds, outgoingOnly = true } = opts;
  const canonOut = await listRelations({ fromPersonaId: personaId, layer: "canon", includeDangling: true });
  const valeOut = await listRelations({ fromPersonaId: personaId, layer: "vale", includeDangling: true });
  const outgoing = mergeLayers(canonOut, valeOut).map((r) => ({
    ...r,
    direction: "outgoing" as const,
  }));
  let merged: Array<RelationRow & { direction: "outgoing" | "incoming"; sourceLayers?: RelationLayer[] }> = outgoing;

  if (!outgoingOnly) {
    const canonIn = await listRelations({ toPersonaId: personaId, layer: "canon", includeDangling: false });
    const valeIn = await listRelations({ toPersonaId: personaId, layer: "vale", includeDangling: false });
    const incoming = mergeLayers(canonIn, valeIn).map((r) => ({
      ...r,
      direction: "incoming" as const,
    }));
    merged = [...outgoing, ...incoming];
  }

  if (targetPersonaIds && targetPersonaIds.length > 0) {
    const set = new Set(targetPersonaIds);
    merged = merged.filter((r) => {
      if (r.direction === "incoming") return set.has(r.fromPersonaId);
      return set.has(r.toPersonaId) || (r.toPersonaId === 0 && !!r.toName);
    });
  }

  // 按 from 分组排序（rankHierarchy 内部若未分组，这里显式分一次，保证 rank 语义）
  const byFrom = new Map<number, RelationRow[]>();
  for (const r of merged) {
    const list = byFrom.get(r.fromPersonaId) ?? [];
    list.push(r);
    byFrom.set(r.fromPersonaId, list);
  }
  const ranked: PresentedRelation[] = [];
  for (const list of byFrom.values()) {
    const rankedRows = rankHierarchy(list);
    for (const r of rankedRows) {
      const origin = merged.find((m) => m.id === r.id && m.direction === (r as { direction?: string }).direction);
      ranked.push({
        ...r,
        metrics: deriveMetrics(r),
        rank: r.rank,
        direction: (r as { direction?: "outgoing" | "incoming" }).direction ?? origin?.direction ?? "outgoing",
      });
    }
  }
  return ranked;
}

/** 读取一对 dyad 的呈现层（仅 a↔b 双边，双向各一条） */
export async function readDyad(a: number, b: number): Promise<PresentedRelation[]> {
  const db = getDb();
  const rows: any[] = await db
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
  const active = rows.map(toRelationRow);
  const canon = active.filter((r) => r.layer === "canon");
  const vale = active.filter((r) => r.layer === "vale");
  const merged = mergeLayers(canon, vale);
  const ranked = rankHierarchy(merged);
  return ranked.map((r) => ({
    ...r,
    metrics: deriveMetrics(r),
    rank: r.rank,
    direction: r.fromPersonaId === a ? "outgoing" : "incoming",
  }));
}

/**
 * 按 viewer 可见性过滤后的读取（P0-14 修复）：只在需要给「角色」看的路径使用。
 * visiblePersonaIds 由 personaVisibility 计算；不可见目标的关系整条丢弃，
 * 悬空边只有 toName 且不在可见名单时也丢弃。
 */
export async function readVisibleRelations(opts: ReadRelationsOptions & {
  visiblePersonaIds: Set<number>;
}): Promise<PresentedRelation[]> {
  const rows = await readRelations(opts);
  return rows.filter((r) => {
    const other = r.direction === "incoming" ? r.fromPersonaId : r.toPersonaId;
    if (other === 0) return false; // 悬空边指向库外角色，按默认不参与「在场关系」
    return opts.visiblePersonaIds.has(other);
  });
}

/** 取某人格 outgoing 关系（供摘要/调用台；保留便捷函数） */
export async function listOutgoingRelations(personaId: number): Promise<PresentedRelation[]> {
  return readRelations({ personaId });
}

/**
 * 全局关系图数据（管理员/研究者路径，**必须由调用方按 userId 过滤**）。
 * 这里只负责状态过滤与 row→契约映射，不做租户判断。
 */
export async function listGraphRows(layer?: RelationLayer): Promise<RelationRow[]> {
  const db = getDb();
  const conds = [eq(personaRelations.status, "active")];
  if (layer) conds.push(eq(personaRelations.layer, layer));
  const rows: any[] = await db.select().from(personaRelations).where(and(...conds));
  return rows.map(toRelationRow);
}

/** 从给定 id 集合中取关系（graph 租户过滤用） */
export async function listGraphRowsForPersonaIds(personaIds: number[], layer?: RelationLayer): Promise<RelationRow[]> {
  if (personaIds.length === 0) return [];
  const db = getDb();
  const conds = [eq(personaRelations.status, "active"), inArray(personaRelations.fromPersonaId, personaIds)];
  if (layer) conds.push(eq(personaRelations.layer, layer));
  const rows: any[] = await db.select().from(personaRelations).where(and(...conds));
  return rows.map(toRelationRow);
}
