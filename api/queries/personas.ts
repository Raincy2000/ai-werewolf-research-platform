// 人格研究库查询层：personas / persona_memories / persona_relationships / persona_drift_log / persona_reports
// 账户体系：人格卡按 userId 隔离（与 api_presets 同规）；profile/params 为 JSON 列（结构见 contracts/persona）
import { and, desc, eq, inArray, isNotNull, isNull, lt } from "drizzle-orm";
import { getDb } from "./connection";
import { env } from "../lib/env";
import {
  personas,
  personaMemories,
  personaRelationships,
  personaDriftLog,
  personaReports,
} from "../../db/schema";
import {
  setParamValue,
  type PersonaCard,
  type PersonaCardInput,
  type PersonaCardSummary,
  type PersonaDriftChange,
  type PersonaDriftEntry,
  type PersonaMemory,
  type PersonaParams,
  type PersonaProfile,
  type PersonaRelationship,
  type PersonaReport,
  type PersonaSource,
  type PersonaTrashEntry,
  PERSONA_TRASH_TTL_DAYS,
} from "../../contracts/persona";

type PersonaRow = typeof personas.$inferSelect;
type MemoryRow = typeof personaMemories.$inferSelect;
type RelationshipRow = typeof personaRelationships.$inferSelect;
type DriftRow = typeof personaDriftLog.$inferSelect;

function toIso(d: Date | string): string {
  return d instanceof Date ? d.toISOString() : new Date(d).toISOString();
}

function toPersonaCard(row: PersonaRow): PersonaCard {
  return {
    id: row.id,
    name: row.name,
    source: row.source as PersonaSource,
    originName: row.originName,
    originSource: row.originSource,
    profile: row.profile as PersonaProfile,
    params: row.params as PersonaParams,
    notes: row.notes,
    imageData: row.imageData ?? null,
    gameCount: row.gameCount,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

function toSummary(row: PersonaRow): PersonaCardSummary {
  const params = row.params as PersonaParams;
  return {
    id: row.id,
    name: row.name,
    source: row.source as PersonaSource,
    originName: row.originName,
    originSource: row.originSource,
    bigFive: params.bigFive,
    inferredCount: Array.isArray(params.inferred) ? params.inferred.length : 0,
    imageData: row.imageData ?? null,
    gameCount: row.gameCount,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

function toMemory(row: MemoryRow): PersonaMemory {
  return {
    id: row.id,
    personaId: row.personaId,
    gameId: row.gameId,
    type: row.type as PersonaMemory["type"],
    content: row.content,
    emotionalWeight: row.emotionalWeight,
    strength: row.strength,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

function toRelationship(row: RelationshipRow): PersonaRelationship {
  return {
    id: row.id,
    personaId: row.personaId,
    targetPersonaId: row.targetPersonaId,
    targetName: row.targetName,
    relation: row.relation,
    affinity: row.affinity,
    trust: row.trust,
    note: row.note,
    gameId: row.gameId,
    updatedAt: toIso(row.updatedAt),
  };
}

function toDrift(row: DriftRow): PersonaDriftEntry {
  return {
    id: row.id,
    personaId: row.personaId,
    gameId: row.gameId,
    changes: row.changes as PersonaDriftEntry["changes"],
    note: row.note,
    createdAt: toIso(row.createdAt),
  };
}

// 主键回取的方言分叉：MySQL 用 insertId；SQLite 用 RETURNING（与 presets.ts 同规）
async function insertPersona(values: Record<string, unknown>): Promise<number> {
  const db = getDb();
  return env.dbDialect === "sqlite"
    ? Number((await db.insert(personas).values(values).returning({ id: personas.id }))[0].id)
    : Number((await db.insert(personas).values(values))[0].insertId);
}

export async function listPersonas(userId: string): Promise<PersonaCardSummary[]> {
  const db = getDb();
  const rows: PersonaRow[] = await db
    .select()
    .from(personas)
    // 回收站：软删（deletedAt 非空）的人格不进正常列表
    .where(and(eq(personas.userId, userId), isNull(personas.deletedAt)))
    .orderBy(desc(personas.updatedAt));
  return rows.map(toSummary);
}

export async function getPersona(id: number, userId: string): Promise<PersonaCard | null> {
  const db = getDb();
  const rows: PersonaRow[] = await db
    .select()
    .from(personas)
    // 回收站语义：软删人格对外不可见（回收站操作经 restore/destroy 直查，不走此口）
    .where(and(eq(personas.id, id), eq(personas.userId, userId), isNull(personas.deletedAt)));
  return rows.length ? toPersonaCard(rows[0]) : null;
}

export async function createPersona(
  userId: string,
  input: PersonaCardInput,
  source: PersonaSource = "manual",
): Promise<PersonaCard> {
  const db = getDb();
  const id = await insertPersona({
    userId,
    name: input.name,
    source,
    originName: input.originName ?? null,
    originSource: input.originSource ?? null,
    profile: input.profile,
    params: input.params,
    notes: input.notes ?? "",
    imageData: input.imageData ?? null,
  });
  const rows: PersonaRow[] = await db.select().from(personas).where(eq(personas.id, id));
  return toPersonaCard(rows[0]);
}

export async function updatePersona(
  id: number,
  userId: string,
  patch: Partial<PersonaCardInput>,
): Promise<PersonaCard | null> {
  const db = getDb();
  await db
    .update(personas)
    .set({
      updatedAt: new Date(), // SQLite 无 onUpdateNow：显式刷新（MySQL 下等价无害）
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.originName !== undefined ? { originName: patch.originName } : {}),
      ...(patch.originSource !== undefined ? { originSource: patch.originSource } : {}),
      ...(patch.profile !== undefined ? { profile: patch.profile } : {}),
      ...(patch.params !== undefined ? { params: patch.params } : {}),
      ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
      ...(patch.imageData !== undefined ? { imageData: patch.imageData } : {}),
    })
    .where(and(eq(personas.id, id), eq(personas.userId, userId)));
  return getPersona(id, userId);
}

/** 删除人格卡并级联清理其记忆/关系/漂移（尸检报告保留——它属于对局研究档案） */
// ---------- 回收站（软删除 → 30 天保留期 → 惰性彻底删除） ----------

/** 删除 = 移入回收站（软删）：人格本体标记 deleted_at，记忆/关系/漂移/报告全部保留——
 * 还原时原样回来。不再硬删（历史教训：误删后只能靠字节雕刻法医恢复） */
export async function deletePersona(id: number, userId: string): Promise<boolean> {
  const db = getDb();
  // 先查后改：sqlite-proxy 拿不到 affectedRows（与 presets.ts 同规）
  const existing: { id: number }[] = await db
    .select({ id: personas.id })
    .from(personas)
    .where(and(eq(personas.id, id), eq(personas.userId, userId), isNull(personas.deletedAt)))
    .limit(1);
  if (existing.length === 0) return false;
  await db
    .update(personas)
    .set({ deletedAt: new Date() })
    .where(and(eq(personas.id, id), eq(personas.userId, userId)));
  return true;
}

function toTrashEntry(row: PersonaRow): PersonaTrashEntry {
  const deleted = row.deletedAt!;
  const expires = new Date(toIso(deleted));
  expires.setDate(expires.getDate() + PERSONA_TRASH_TTL_DAYS);
  return {
    id: row.id,
    name: row.name,
    originName: row.originName,
    originSource: row.originSource,
    imageData: row.imageData ?? null,
    gameCount: row.gameCount,
    deletedAt: toIso(deleted),
    expiresAt: expires.toISOString(),
  };
}

/** 彻底删除（回收站内二次确认）：人格本体 + 记忆/关系/漂移级联清除；
 * 尸检报告保留（研究档案语义：对局产物不随人格消失） */
async function destroyById(id: number, userId: string): Promise<void> {
  const db = getDb();
  await db.delete(personaMemories).where(eq(personaMemories.personaId, id));
  await db.delete(personaRelationships).where(eq(personaRelationships.personaId, id));
  await db.delete(personaDriftLog).where(eq(personaDriftLog.personaId, id));
  await db.delete(personas).where(and(eq(personas.id, id), eq(personas.userId, userId)));
}

/** 回收站列表（先惰性清理过期项再返回；按删除时间倒序） */
export async function listPersonaTrash(userId: string): Promise<PersonaTrashEntry[]> {
  const db = getDb();
  // 惰性过期清理：deleted_at 超过保留期 → 彻底删除（免定时任务，打开回收站即触发）
  const expired: { id: number }[] = await db
    .select({ id: personas.id })
    .from(personas)
    .where(
      and(
        eq(personas.userId, userId),
        isNotNull(personas.deletedAt),
        lt(personas.deletedAt, new Date(Date.now() - PERSONA_TRASH_TTL_DAYS * 24 * 3600 * 1000)),
      ),
    );
  for (const row of expired) {
    await destroyById(row.id, userId);
  }
  const rows: PersonaRow[] = await db
    .select()
    .from(personas)
    .where(and(eq(personas.userId, userId), isNotNull(personas.deletedAt)))
    .orderBy(desc(personas.deletedAt));
  return rows.map(toTrashEntry);
}

/** 还原（清软删标记；记忆/关系/漂移/报告本就在，原样回来） */
export async function restorePersona(id: number, userId: string): Promise<boolean> {
  const db = getDb();
  const existing: { id: number }[] = await db
    .select({ id: personas.id })
    .from(personas)
    .where(and(eq(personas.id, id), eq(personas.userId, userId), isNotNull(personas.deletedAt)))
    .limit(1);
  if (existing.length === 0) return false;
  await db
    .update(personas)
    .set({ deletedAt: null, updatedAt: new Date() })
    .where(and(eq(personas.id, id), eq(personas.userId, userId)));
  return true;
}

/** 彻底删除（回收站内操作；仅允许删已在回收站里的） */
export async function destroyPersona(id: number, userId: string): Promise<boolean> {
  const db = getDb();
  const existing: { id: number }[] = await db
    .select({ id: personas.id })
    .from(personas)
    .where(and(eq(personas.id, id), eq(personas.userId, userId), isNotNull(personas.deletedAt)))
    .limit(1);
  if (existing.length === 0) return false;
  await destroyById(id, userId);
  return true;
}

// ---------- 记事簿读取（详情页；写入在 P4 记忆回写管线） ----------
export async function listPersonaMemories(
  personaId: number,
  userId: string,
): Promise<PersonaMemory[] | null> {
  // 归属校验：记忆只能随本人格卡读出
  const owner = await getPersona(personaId, userId);
  if (!owner) return null;
  const db = getDb();
  const rows: MemoryRow[] = await db
    .select()
    .from(personaMemories)
    .where(eq(personaMemories.personaId, personaId))
    .orderBy(desc(personaMemories.strength), desc(personaMemories.updatedAt));
  return rows.map(toMemory);
}

export async function listPersonaRelationships(
  personaId: number,
  userId: string,
): Promise<PersonaRelationship[] | null> {
  const owner = await getPersona(personaId, userId);
  if (!owner) return null;
  const db = getDb();
  const rows: RelationshipRow[] = await db
    .select()
    .from(personaRelationships)
    .where(eq(personaRelationships.personaId, personaId))
    .orderBy(desc(personaRelationships.updatedAt));
  return rows.map(toRelationship);
}

export async function listPersonaDrift(
  personaId: number,
  userId: string,
): Promise<PersonaDriftEntry[] | null> {
  const owner = await getPersona(personaId, userId);
  if (!owner) return null;
  const db = getDb();
  const rows: DriftRow[] = await db
    .select()
    .from(personaDriftLog)
    .where(eq(personaDriftLog.personaId, personaId))
    .orderBy(desc(personaDriftLog.createdAt));
  return rows.map(toDrift);
}

// ============================================================
// 对局运行时与记事簿回写（内部接口：由对局服务层以卡主人身份调用，不再逐次校验归属——
// 归属在 createGame 绑卡时已校验）
// ============================================================

/** 运行时加载人格卡（断点恢复用；不做用户校验——对局本身已完成归属校验） */
export async function getPersonaCardsInternal(ids: number[]): Promise<PersonaCard[]> {
  if (ids.length === 0) return [];
  const db = getDb();
  const rows: PersonaRow[] = await db.select().from(personas).where(inArray(personas.id, ids));
  return rows.map(toPersonaCard);
}

const MEMORY_TYPE_LABEL: Record<string, string> = {
  trauma: "创伤",
  relationship: "关系",
  general: "经历",
};

/** 记事簿注入文本：高强度记忆（top 8，strength≥20）+ 关系图谱（top 8），供心镜情境 */
export async function loadMemoryContext(personaId: number): Promise<string> {
  const db = getDb();
  const mems: MemoryRow[] = await db
    .select()
    .from(personaMemories)
    .where(eq(personaMemories.personaId, personaId))
    .orderBy(desc(personaMemories.strength), desc(personaMemories.updatedAt));
  const rels: RelationshipRow[] = await db
    .select()
    .from(personaRelationships)
    .where(eq(personaRelationships.personaId, personaId))
    .orderBy(desc(personaRelationships.updatedAt));
  const lines: string[] = [];
  const memLines = mems
    .filter((m) => m.strength >= 20)
    .slice(0, 8)
    .map((m) => `- [${MEMORY_TYPE_LABEL[m.type] ?? "经历"}·强度${m.strength}] ${m.content}`);
  if (memLines.length) lines.push("自传体记忆：", ...memLines);
  const relLines = rels
    .slice(0, 8)
    .map(
      (r) =>
        `- 对「${r.targetName}」：${r.relation || "关系未名"}（亲疏${r.affinity}，信任${r.trust}）${r.note ? `——${r.note}` : ""}`,
    );
  if (relLines.length) lines.push("关系图谱：", ...relLines);
  return lines.join("\n").slice(0, 1200);
}

// ---------- 记忆写入（记事簿回写管线） ----------
export interface NewPersonaMemory {
  personaId: number;
  gameId: string;
  type: "trauma" | "relationship" | "general";
  content: string;
  emotionalWeight: number;
  strength: number;
}

export async function insertPersonaMemories(rows: NewPersonaMemory[]): Promise<number[]> {
  if (rows.length === 0) return [];
  const db = getDb();
  const ids: number[] = [];
  for (const r of rows) {
    const values = {
      personaId: r.personaId,
      gameId: r.gameId,
      type: r.type,
      content: r.content,
      emotionalWeight: r.emotionalWeight,
      strength: r.strength,
      updatedAt: new Date(),
    };
    const id =
      env.dbDialect === "sqlite"
        ? Number(
            (await db.insert(personaMemories).values(values).returning({ id: personaMemories.id }))[0]
              .id,
          )
        : Number((await db.insert(personaMemories).values(values))[0].insertId);
    ids.push(id);
  }
  return ids;
}

/** 强化已有记忆（被再次唤起/复述）：strength += boost（封顶 100） */
export async function reinforcePersonaMemories(ids: number[], boost: number): Promise<void> {
  const db = getDb();
  for (const id of ids) {
    const rows: MemoryRow[] = await db.select().from(personaMemories).where(eq(personaMemories.id, id));
    if (!rows.length) continue;
    await db
      .update(personaMemories)
      .set({ strength: Math.min(100, rows[0].strength + boost), updatedAt: new Date() })
      .where(eq(personaMemories.id, id));
  }
}

/** 记忆衰减：未被本局触及的记忆强度 ×factor（下限 5，永不归零——创伤不会彻底消失） */
export async function decayPersonaMemories(
  personaId: number,
  exceptIds: number[],
  factor: number,
): Promise<void> {
  const db = getDb();
  const rows: MemoryRow[] = await db
    .select()
    .from(personaMemories)
    .where(eq(personaMemories.personaId, personaId));
  for (const m of rows) {
    if (exceptIds.includes(m.id)) continue;
    const next = Math.max(5, Math.round(m.strength * factor));
    if (next !== m.strength) {
      await db
        .update(personaMemories)
        .set({ strength: next, updatedAt: new Date() })
        .where(eq(personaMemories.id, m.id));
    }
  }
}

/** 关系 upsert（关系传递：按 personaId+targetName 归并，增量更新亲疏/信任） */
export async function upsertPersonaRelationship(input: {
  personaId: number;
  targetPersonaId: number | null;
  targetName: string;
  relation: string;
  affinityDelta: number;
  trustDelta: number;
  note: string;
  gameId: string;
}): Promise<void> {
  const db = getDb();
  const rows: RelationshipRow[] = await db
    .select()
    .from(personaRelationships)
    .where(
      and(
        eq(personaRelationships.personaId, input.personaId),
        eq(personaRelationships.targetName, input.targetName),
      ),
    )
    .limit(1);
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(v)));
  if (rows.length) {
    const cur = rows[0];
    await db
      .update(personaRelationships)
      .set({
        targetPersonaId: input.targetPersonaId ?? cur.targetPersonaId,
        relation: input.relation || cur.relation,
        affinity: clamp(cur.affinity + input.affinityDelta, -100, 100),
        trust: clamp(cur.trust + input.trustDelta, 0, 100),
        note: input.note || cur.note,
        gameId: input.gameId,
        updatedAt: new Date(),
      })
      .where(eq(personaRelationships.id, cur.id));
    return;
  }
  await db.insert(personaRelationships).values({
    personaId: input.personaId,
    targetPersonaId: input.targetPersonaId,
    targetName: input.targetName,
    relation: input.relation,
    affinity: clamp(input.affinityDelta, -100, 100),
    trust: clamp(50 + input.trustDelta, 0, 100), // 新关系信任基线 50 起调
    note: input.note,
    gameId: input.gameId,
    updatedAt: new Date(),
  });
}

/** 人格漂移应用：改写卡的长期参数（逐路径钳位、漂移字段摘除推断标记）+ 漂移日志留痕 */
export async function applyPersonaDrift(
  personaId: number,
  gameId: string,
  changes: PersonaDriftChange[],
  note: string,
): Promise<void> {
  if (changes.length === 0) return;
  const db = getDb();
  const rows: PersonaRow[] = await db.select().from(personas).where(eq(personas.id, personaId));
  if (!rows.length) return;
  const card = toPersonaCard(rows[0]);
  let params: PersonaParams = card.params;
  for (const c of changes) {
    params = setParamValue(params, c.path, c.to);
  }
  // 漂移即「经历过」：被改写的参数不再是推断项
  const driftedPaths = new Set(changes.map((c) => c.path));
  params = { ...params, inferred: params.inferred.filter((p) => !driftedPaths.has(p)) };
  await db
    .update(personas)
    .set({ params, updatedAt: new Date() })
    .where(eq(personas.id, personaId));
  await db.insert(personaDriftLog).values({ personaId, gameId, changes, note });
}

export async function incrementPersonaGameCount(personaId: number): Promise<void> {
  const db = getDb();
  const rows: { gameCount: number }[] = await db
    .select({ gameCount: personas.gameCount })
    .from(personas)
    .where(eq(personas.id, personaId));
  if (!rows.length) return;
  await db
    .update(personas)
    .set({ gameCount: rows[0].gameCount + 1, updatedAt: new Date() })
    .where(eq(personas.id, personaId));
}

// ---------- 心理尸检报告 ----------
export async function upsertPersonaReport(input: {
  gameId: string;
  personaId: number;
  seat: number;
  report: string;
  model: string;
}): Promise<void> {
  const db = getDb();
  const existing: { id: number }[] = await db
    .select({ id: personaReports.id })
    .from(personaReports)
    .where(
      and(eq(personaReports.gameId, input.gameId), eq(personaReports.personaId, input.personaId)),
    );
  for (const row of existing) {
    await db.delete(personaReports).where(eq(personaReports.id, row.id));
  }
  await db.insert(personaReports).values(input);
}

export async function listPersonaReports(
  personaId: number,
  userId: string,
): Promise<PersonaReport[] | null> {
  const owner = await getPersona(personaId, userId);
  if (!owner) return null;
  const db = getDb();
  const rows = await db
    .select()
    .from(personaReports)
    .where(eq(personaReports.personaId, personaId))
    .orderBy(desc(personaReports.createdAt));
  return rows.map(toReport);
}

export async function getPersonaReportsForGame(gameId: string): Promise<PersonaReport[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(personaReports)
    .where(eq(personaReports.gameId, gameId))
    .orderBy(personaReports.seat);
  return rows.map(toReport);
}

type ReportRow = typeof personaReports.$inferSelect;
function toReport(row: ReportRow): PersonaReport {
  return {
    id: row.id,
    gameId: row.gameId,
    personaId: row.personaId,
    seat: row.seat,
    report: row.report,
    model: row.model,
    createdAt: toIso(row.createdAt),
  };
}
