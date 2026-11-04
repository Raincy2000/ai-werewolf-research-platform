// ============================================================
// RSQ 关系自陈问卷仓储（纯数据访问，零业务逻辑）
//
// 两张表协作：
//   rsq_responses      —— 一次填写一条，保留完整历史（时间轴素材）
//   persona_relations  —— 冗余存最新 RSQ 的核心维度（供喂 AI 快速读取）
//
// 写入顺序必须为：先 insert rsq_responses，拿到 id 后再更新 persona_relations。
// ============================================================
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { getDb } from "../../queries/connection";
import { insertReturningId } from "../../queries/dialect";
import { personaRelations, rsqResponses, personas } from "../../../db/schema";
import { applyRelationColumns } from "../writeModel";
import type {
  RSQDimensions,
  RSQDerived,
  RSQValidity,
  RSQFeedback,
  RSQResult,
} from "../../persona/rsq";

type RsqRow = typeof rsqResponses.$inferSelect;
type NewRsqRow = typeof rsqResponses.$inferInsert;

/** DB row → 契约 RSQResult */
export function toRSQResult(r: RsqRow): RSQResult {
  return {
    dims: JSON.parse(r.dimensionsJson) as RSQDimensions,
    derived: JSON.parse(r.derivedJson) as RSQDerived,
    validity: JSON.parse(r.validityJson) as RSQValidity,
    feedback: r.feedbackJson ? (JSON.parse(r.feedbackJson) as RSQFeedback) : null,
    selfSummary: r.selfSummary ?? null,
    raw: JSON.parse(r.rawJson) as Record<number, number>,
    itemsVersion: r.itemsVersion,
  };
}

/** 带 id / 时间 / 局号的完整历史记录（时间轴用） */
export interface RSQRecord extends RSQResult {
  id: number;
  fromPersonaId: number;
  toPersonaId: number;
  gameId: string | null;
  batteryLevel: string;
  model: string | null;
  answeredAt: Date;
  createdAt: Date;
}

function toRecord(r: RsqRow): RSQRecord {
  return {
    id: r.id,
    fromPersonaId: r.fromPersonaId,
    toPersonaId: r.toPersonaId,
    gameId: r.gameId ?? null,
    batteryLevel: r.batteryLevel,
    model: r.model ?? null,
    answeredAt: r.answeredAt,
    createdAt: r.createdAt,
    ...toRSQResult(r),
  };
}

export interface SaveRSQInput {
  fromPersonaId: number;
  toPersonaId: number;
  gameId?: string | null;
  batteryLevel?: "L" | "M" | "S";
  result: RSQResult;
  model?: string | null;
  answeredAt?: Date;
  /** 是否把核心维度冗余写回 persona_relations（默认 true） */
  syncToRelation?: boolean;
}

/**
 * 保存一次 RSQ 填写。
 * 返回新记录 id；若同步了 persona_relations，同时把该关系行的 rsq_* 列更新。
 */
export async function saveRSQResponse(input: SaveRSQInput): Promise<number> {
  const r = input.result;
  const answeredAt = input.answeredAt ?? new Date();

  const row: NewRsqRow = {
    fromPersonaId: input.fromPersonaId,
    toPersonaId: input.toPersonaId,
    gameId: input.gameId ?? null,
    batteryLevel: input.batteryLevel ?? "L",
    // 冗余核心列
    affection: r.dims.affection,
    antagonism: r.dims.antagonism,
    faith: r.dims.faith,
    commitment: r.dims.commitment,
    forgiveness: r.dims.forgiveness,
    closeness: r.dims.closeness,
    ambivalence: r.derived.ambivalence,
    equityBalance: r.dims.equityBalance,
    // 完整数据
    dimensionsJson: JSON.stringify(r.dims),
    derivedJson: JSON.stringify(r.derived),
    validityJson: JSON.stringify(r.validity),
    rawJson: JSON.stringify(r.raw),
    feedbackJson: r.feedback ? JSON.stringify(r.feedback) : null,
    selfSummary: r.selfSummary ?? null,
    // 元信息
    model: input.model ?? null,
    itemsVersion: r.itemsVersion,
    answeredAt,
  };

  const id = await insertReturningId(rsqResponses, row);
  if (id == null || id === 0) throw new Error("rsq_responses 插入失败：未返回 id");

  if (input.syncToRelation !== false) {
    await syncCoreToRelation(input.fromPersonaId, input.toPersonaId, id, r, answeredAt);
  }
  return id;
}

/**
 * 把 RSQ 核心维度冗余写入 persona_relations。
 * 注意：只更新**已存在**的关系行（canon / vale 均可）；不新建关系。
 */
async function syncCoreToRelation(
  fromPersonaId: number,
  toPersonaId: number,
  responseId: number,
  r: RSQResult,
  at: Date,
): Promise<void> {
  const db = getDb();
  // 所有该 dyad 的 active 行（canon/vale、多 kind）同步核心维度，并逐列落台账（I6）
  const rows: any[] = await db
    .select({ id: personaRelations.id })
    .from(personaRelations)
    .where(
      and(
        eq(personaRelations.fromPersonaId, fromPersonaId),
        eq(personaRelations.toPersonaId, toPersonaId),
        eq(personaRelations.status, "active"),
      ),
    );
  const patch = {
    rsqResponseId: responseId,
    rsqAffection: r.dims.affection,
    rsqAntagonism: r.dims.antagonism,
    rsqFaith: r.dims.faith,
    rsqCommitment: r.dims.commitment,
    rsqForgiveness: r.dims.forgiveness,
    rsqCloseness: r.dims.closeness,
    rsqAmbivalence: r.derived.ambivalence,
    rsqEquityBalance: r.dims.equityBalance,
    rsqVerdict: r.validity.verdict,
    rsqSelfSummary: r.selfSummary ?? null,
    rsqUpdatedAt: at,
  };
  for (const row of rows) {
    await applyRelationColumns({
      relationId: row.id,
      patch,
      reasonKind: "manual",
      actor: "rsq.saveResponse",
      originModule: "rsq",
    });
  }
}

/** 取某对人格的最新一次 RSQ（不含历史） */
export async function getLatestRSQ(fromPersonaId: number, toPersonaId: number): Promise<RSQRecord | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(rsqResponses)
    .where(and(eq(rsqResponses.fromPersonaId, fromPersonaId), eq(rsqResponses.toPersonaId, toPersonaId)))
    .orderBy(desc(rsqResponses.answeredAt))
    .limit(1);
  const row = rows[0];
  return row ? toRecord(row) : null;
}

/** 某对人格的全部 RSQ 历史（时间轴；默认逆时序=最近在前） */
export async function listRSQHistory(
  fromPersonaId: number,
  toPersonaId: number,
  opts: { order?: "asc" | "desc"; limit?: number } = {},
): Promise<RSQRecord[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(rsqResponses)
    .where(and(eq(rsqResponses.fromPersonaId, fromPersonaId), eq(rsqResponses.toPersonaId, toPersonaId)))
    .orderBy(opts.order === "asc" ? rsqResponses.answeredAt : desc(rsqResponses.answeredAt))
    .limit(opts.limit ?? 200);
  return rows.map(toRecord);
}

/** 某局结束后产生的全部 RSQ（用于局后复盘） */
export async function listRSQByGame(gameId: string): Promise<RSQRecord[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(rsqResponses)
    .where(eq(rsqResponses.gameId, gameId))
    .orderBy(rsqResponses.fromPersonaId);
  return rows.map(toRecord);
}

/** 某人格发出的全部最新 RSQ（每个对象取最新一条） */
export async function listLatestRSQFor(fromPersonaId: number): Promise<RSQRecord[]> {
  const db = getDb();
  // 先按 to 分组取最新：SQLite 用 max(answered_at) 子查询
  const rows = await db
    .select()
    .from(rsqResponses)
    .where(eq(rsqResponses.fromPersonaId, fromPersonaId))
    .orderBy(desc(rsqResponses.answeredAt));

  const seen = new Set<number>();
  const out: RSQRecord[] = [];
  for (const row of rows) {
    if (seen.has(row.toPersonaId)) continue;
    seen.add(row.toPersonaId);
    out.push(toRecord(row));
  }
  return out;
}

/** 统计：当前用户名下有多少对关系已填过 RSQ（覆盖率按账户隔离） */
export async function rsqCoverage(userId?: string): Promise<{ pairs: number; total: number }> {
  const db = getDb();
  const conds: any[] = [];
  if (userId) {
    const own: any[] = await db
      .select({ id: personas.id })
      .from(personas)
      .where(and(eq(personas.userId, userId), isNull(personas.deletedAt)));
    const ids = own.map((r: { id: number }) => r.id);
    if (ids.length === 0) return { pairs: 0, total: 0 };
    conds.push(inArray(rsqResponses.fromPersonaId, ids));
  }
  const rows: any[] = await db
    .select({ from: rsqResponses.fromPersonaId, to: rsqResponses.toPersonaId })
    .from(rsqResponses)
    .where(conds.length ? and(...conds) : undefined);
  const pairs = new Set(rows.map((r: { from: number; to: number }) => r.from + "->" + r.to));
  return { pairs: pairs.size, total: rows.length };
}
