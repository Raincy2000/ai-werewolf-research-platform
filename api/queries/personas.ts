// 人格研究站查询层：personas / persona_memories / persona_relationships / persona_drift_log / persona_reports
// 账户体系：人格卡按 userId 隔离（与 api_presets 同规）；profile/params 为 JSON 列（结构见 contracts/persona）
import { and, desc, eq, inArray, isNotNull, isNull, lt, ne, or } from "drizzle-orm";
import { getDb } from "./connection";
import { insertIgnore, insertReturningId } from "./dialect";
import { applyRelationColumns, writeRelationRow } from "../network/writeModel";
import {
  personas,
  personaMemories,
  personaRelationships,
  personaRelationshipHistory,
  personaCastDrafts,
  personaCognitionNotes,
  personaCastCheckpoints,
  personaDriftLog,
  personaAliases,
  personaRelations,
  relationDeltas,
  personaStateObservations,
  personaTraitUpdates,
  personaReports,
  personaCanonLog,
  canonBackfillJobs,
  rsqResponses,
  perceivedDyadRelations,
  personaNicknameIndex,
  personaWritebackRuns,
  invocationLog,
} from "../../db/schema";
import { RELATION_KINDS, RELATION_KIND_TO_FORM } from "../../contracts/interpersonal";
import { composeRemembered, recallMemories, type MemoryItem } from "../persona/memory";
import {
  clampParam,
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
  type PersonaRelationshipHistory,
  type PersonaCognitionNote,
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
    autoCognition: (row.autoCognition ?? null) as PersonaCard["autoCognition"],
    paramsResidual: (row.paramsResidual ?? null) as PersonaCard["paramsResidual"],
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

/** 设置赛后自动书写认知笔记（认知笔记页签的开关；null=关闭） */
export async function setPersonaAutoCognition(
  personaId: number,
  userId: string,
  value: PersonaCard["autoCognition"],
): Promise<void> {
  const owner = await getPersona(personaId, userId);
  if (!owner) return;
  const db = getDb();
  await db
    .update(personas)
    .set({ autoCognition: value as never, updatedAt: new Date() })
    .where(eq(personas.id, personaId));
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
    valence: row.valence ?? 0,
    strength: row.strength,
    createdAt: toIso(row.createdAt),
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

// 主键回取的方言分叉：统一走 api/queries/dialect（MySQL insertId / SQLite returning）
async function insertPersona(values: Record<string, unknown>): Promise<number> {
  return insertReturningId(personas, values);
}

/** 新关系表 kind → 中文标签（人格详情「关系」页展示用；与 UI 侧词表一致） */
const RELATION_KIND_LABEL: Record<string, string> = {
  kin: "血缘/家人",
  beloved: "挚爱",
  sworn_friend: "生死之交",
  comrade: "并肩同伴",
  peer: "同侪",
  mentor: "师长",
  sovereign: "上级/统领",
  rival: "对手",
  nemesis: "宿敌",
  creditor: "亏欠",
  kin_slayer: "亲手了结",
  unspecified: "未分类",
  team: "队友（对局）",
  cooperate: "常协作（对局）",
  oppose: "常对立（对局）",
  trading: "攻防互现（对局）",
  suppress: "单向压制（对局）",
  acquainted: "偶有交集（对局）",
  none: "无直接互动",
};

function relationKindLabel(kind: string): string {
  return RELATION_KIND_LABEL[kind] ?? kind;
}

/** 新关系行 → 旧的 PersonaRelationship 视图（详情页过渡期兼容） */
function relationToPersonaRelationship(r: {
  id: number;
  fromPersonaId: number;
  toPersonaId: number;
  toName: string | null;
  kind: string;
  positivity: number | null;
  negativity: number | null;
  trust: number | null;
  basis: string | null;
  updatedAt: Date | number | string;
}): PersonaRelationship {
  return {
    id: r.id,
    personaId: r.fromPersonaId,
    targetPersonaId: r.toPersonaId === 0 ? null : r.toPersonaId,
    targetName: r.toName ?? "",
    relation: relationKindLabel(r.kind),
    affinity: (r.positivity ?? 0) - (r.negativity ?? 0),
    trust: r.trust ?? 50,
    note: r.basis ?? "",
    gameId: null,
    updatedAt: toIso(r.updatedAt as Date),
  };
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

// ============================================================
// 人际网：铸造入库时的 canon 关系写入 + 悬空边接合（设计文档 §19）
// 核心：**边先建，人后到** —— 对方未入库时 to_persona_id = 0，靠 to_name 等待接合
// ============================================================

/** 悬空占位：to_persona_id = 0 表示「对方尚未入库」 */
export const DANGLING_PERSONA_ID = 0;

/** 名字分段：三笠·阿克曼 → [三笠·阿克曼, 三笠, 阿克曼] */
function nameVariants(name: string): string[] {
  const full = String(name || "").trim();
  if (!full) return [];
  const parts = full.split(/[·・.\s]/).filter((x) => x.length >= 2);
  return [...new Set([full, ...parts])];
}

/** 按名字/别名解析出库里的人格（先精确名，再别名库；**限定当前用户且未软删**） */
export async function resolvePersonaByName(
  name: string,
  aliases?: string[],
  userId?: string,
): Promise<number | null> {
  const db = getDb();
  const cands = [...new Set([...(aliases ?? []).map((a) => String(a).trim()), ...nameVariants(name)])].filter(Boolean);
  if (cands.length === 0) return null;
  if (!userId) return null; // 2026-10-22：禁止无 owner 的全局解析（跨账户串号）
  const ownerConds = [eq(personas.userId, userId), isNull(personas.deletedAt)];
  // 1) 精确卡名
  const byName: any[] = await db
    .select({ id: personas.id })
    .from(personas)
    .where(and(inArray(personas.name, cands), ...ownerConds));
  if (byName.length === 1) return byName[0].id;
  if (byName.length > 1) return null; // 同名多卡：不猜测，交由悬空边/人工处理
  // 2) 别名库（限定 owner）
  const aliasHits: any[] = await db
    .select({ personaId: personaAliases.personaId })
    .from(personaAliases)
    .where(inArray(personaAliases.alias, cands))
    .limit(50);
  const ids = [...new Set(aliasHits.map((h: { personaId: number }) => h.personaId))];
  if (ids.length === 0) return null;
  const owned: any[] = await db
    .select({ id: personas.id })
    .from(personas)
    .where(and(inArray(personas.id, ids), ...ownerConds));
  return owned.length === 1 ? owned[0].id : null;
}

/** 写入自我别名（卡名分段 + 铸造产出的 selfAliases）；唯一键 (persona_id, alias) */
export async function writeSelfAliases(
  personaId: number,
  cardName: string,
  selfAliases?: string[] | null,
): Promise<number> {
  const all = [...new Set([...nameVariants(cardName), ...(selfAliases ?? []).map((a) => String(a).trim())])].filter(Boolean);
  let n = 0;
  for (const alias of all) {
    try {
      await insertIgnore(personaAliases, {
        personaId,
        alias,
        aliasKind: alias === cardName ? "canon" : "nickname",
        source: "cast",
        confidence: alias === cardName ? 1 : 0.9,
      });
      n++;
    } catch {
      /* 单条冲突不阻塞建卡（同人格内别名幂等） */
    }
  }
  return n;
}

/**
 * 从铸造产出的 profile 写入 canon 层关系（**支持悬空边**）。
 * @returns written=写入条数，dangling=其中悬空条数
 */
export async function writeCanonRelationsFromProfile(
  personaId: number,
  profile: { canonRelations?: unknown } & Record<string, unknown>,
  userId: string,
): Promise<{ written: number; dangling: number }> {
  const rows = Array.isArray(profile.canonRelations) ? (profile.canonRelations as Record<string, unknown>[]) : [];
  let written = 0;
  let dangling = 0;
  const clamp = (v: unknown, d: number) =>
    typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : d;
  for (const r of rows) {
    const name = String(r.name ?? "").trim();
    if (!name) continue;
    const targetId = await resolvePersonaByName(
      name,
      Array.isArray(r.aliases) ? (r.aliases as string[]) : undefined,
      userId,
    );
    const toId = targetId ?? DANGLING_PERSONA_ID;
    if (!targetId) dangling++;
    const rawKind = String(r.kind ?? "unspecified").slice(0, 32);
    const kind = (RELATION_KINDS as readonly string[]).includes(rawKind) ? rawKind : "unspecified";
    const rawForm = r.kindSource != null ? String(r.kindSource).slice(0, 4) : "";
    const form = ["CS", "AR", "EM", "MP"].includes(rawForm)
      ? rawForm
      : (RELATION_KIND_TO_FORM as Record<string, string>)[kind] ?? "CS";
    try {
      const res = await writeRelationRow({
        fromPersonaId: personaId,
        toPersonaId: toId,
        toName: name,
        layer: "canon",
        kind,
        form,
        positivity: clamp(r.positivity, 0),
        negativity: clamp(r.negativity, 0),
        trust: clamp(r.trust, 50),
        closeness: clamp(r.closeness, 0),
        dependence: clamp(r.dependence, 0),
        reciprocity: clamp(r.reciprocity, 0),
        powerBalance: clamp(r.powerBalance, 0),
        formality: clamp(r.formality, 0),
        commitment: clamp(r.commitment, 0),
        addressTerm: r.addressTerm != null ? String(r.addressTerm).slice(0, 64) : null,
        addressKind: r.addressKind != null ? String(r.addressKind).slice(0, 16) : null,
        basis: r.basis ? String(r.basis).slice(0, 300) : null,
        sourceRef: "cast",
        actor: "cast.writeCanonRelations",
        originModule: "cast",
        reasonKind: "migration",
        overwrite: false,
      });
      if (res.ok) written++;
    } catch {
      /* 单条失败不阻塞入库 */
    }
  }
  return { written, dangling };
}

/** 接合悬空边：某人入库/别名新增后，把 to_name 能匹配到他的悬空边补上 id（按账户隔离） */
export async function resolveDanglingRelations(personaId: number, userId: string): Promise<number> {
  const db = getDb();
  const meRows: PersonaRow[] = await db
    .select()
    .from(personas)
    .where(and(eq(personas.id, personaId), eq(personas.userId, userId), isNull(personas.deletedAt)));
  if (!meRows.length) return 0;
  const name = meRows[0]!.name;
  const aliasRows = await db
    .select({ alias: personaAliases.alias })
    .from(personaAliases)
    .where(eq(personaAliases.personaId, personaId));
  const cands = [...new Set([...nameVariants(name), ...aliasRows.map((a: { alias: string }) => a.alias)])];
  if (cands.length === 0) return 0;
  // 只接合「本账户人格」发出的悬空边，且跳过自己指向自己的边
  const ownPersonaRows: any[] = await db
    .select({ id: personas.id })
    .from(personas)
    .where(and(eq(personas.userId, userId), isNull(personas.deletedAt)));
  const ownIds = ownPersonaRows.map((r: { id: number }) => r.id);
  if (ownIds.length === 0) return 0;
  const dangling: any[] = await db
    .select()
    .from(personaRelations)
    .where(
      and(
        eq(personaRelations.toPersonaId, DANGLING_PERSONA_ID),
        eq(personaRelations.status, "active"),
        inArray(personaRelations.toName, cands),
        inArray(personaRelations.fromPersonaId, ownIds),
        ne(personaRelations.fromPersonaId, personaId),
      ),
    );
  let n = 0;
  for (const d of dangling) {
    const res = await applyRelationColumns({
      relationId: d.id,
      patch: { toPersonaId: personaId, toName: null },
      reasonKind: "manual",
      actor: "cast.resolveDanglingRelations",
      originModule: "cast",
      evidence: ["悬空边接合：" + cands.join("/")],
    });
    if (res.ok) n++;
  }
  return n;
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
  // 认知笔记机制已下线（2026-10）：铸造不再生成 essence，也不再落「铸魂初稿」笔记。
  // 原「铸魂初稿存根」已移除——把初稿写成认知笔记，会让**自我总结以「记忆沿革」的形态长期留存**，
  // 且该内容并不进对局、界面也不展示（三重无用）。待自省情景（制度 A）开发时按新定位重建。

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

/** 删除人格卡并级联清理其记忆/关系/漂移（心理检查报告保留——它属于对局研究档案） */
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
 * 心理检查报告保留（研究档案语义：对局产物不随人格消失）。
 * 2026-10-22：补全人际网 8 张表级联（persona_relations/deltas/canon/backfill/jobs/RSQ/perception/昵称/别名/台账）。 */
async function destroyById(id: number, userId: string): Promise<void> {
  const db = getDb();
  await db.delete(personaMemories).where(eq(personaMemories.personaId, id));
  await db.delete(personaRelationships).where(eq(personaRelationships.personaId, id));
  await db.delete(personaDriftLog).where(eq(personaDriftLog.personaId, id));
  // 新关系网：双端删除（from / to 任一为该人格）
  await db
    .delete(personaRelations)
    .where(or(eq(personaRelations.fromPersonaId, id), eq(personaRelations.toPersonaId, id)));
  await db
    .delete(relationDeltas)
    .where(or(eq(relationDeltas.fromPersonaId, id), eq(relationDeltas.toPersonaId, id)));
  await db
    .delete(personaCanonLog)
    .where(or(eq(personaCanonLog.personaId, id), eq(personaCanonLog.aboutPersonaId, id)));
  await db
    .delete(canonBackfillJobs)
    .where(or(eq(canonBackfillJobs.personaId, id), eq(canonBackfillJobs.aboutPersonaId, id)));
  await db
    .delete(rsqResponses)
    .where(or(eq(rsqResponses.fromPersonaId, id), eq(rsqResponses.toPersonaId, id)));
  await db
    .delete(perceivedDyadRelations)
    .where(
      or(
        eq(perceivedDyadRelations.observerId, id),
        eq(perceivedDyadRelations.aboutFromId, id),
        eq(perceivedDyadRelations.aboutToId, id),
      ),
    );
  await db.delete(personaNicknameIndex).where(eq(personaNicknameIndex.personaId, id));
  await db.delete(personaAliases).where(eq(personaAliases.personaId, id));
  await db.delete(invocationLog).where(eq(invocationLog.personaId, id));
  await db.delete(personaWritebackRuns).where(eq(personaWritebackRuns.personaId, id));
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
    .where(
      and(
        eq(personaMemories.personaId, personaId),
        // 只展示「真实经历」：归档行不进列表；自我叙述（origin=self_narrative）不是经历，永不混入
        eq(personaMemories.lifecycle, "active"),
        ne(personaMemories.origin, "self_narrative"),
      ),
    )
    .orderBy(desc(personaMemories.strength), desc(personaMemories.updatedAt));
  return rows.map(toMemory);
}

// ---------- 记事簿回写幂等台账（2026-10-22） ----------
/**
 * 开始一次回写：返回 true 表示本次应执行。
 * - 无记录 → 插入 processing（insertIgnore 防并发）
 * - done → false（幂等跳过）
 * - processing/failed → 置 processing 后重试
 */
export async function beginPersonaWriteback(personaId: number, gameId: string, seat: number): Promise<boolean> {
  const db = getDb();
  const rows: any[] = await db
    .select()
    .from(personaWritebackRuns)
    .where(
      and(
        eq(personaWritebackRuns.personaId, personaId),
        eq(personaWritebackRuns.gameId, gameId),
        eq(personaWritebackRuns.seat, seat),
      ),
    )
    .limit(1);
  const existing = rows[0];
  if (!existing) {
    try {
      await insertIgnore(personaWritebackRuns, {
        personaId,
        gameId,
        seat,
        status: "processing",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      return true;
    } catch {
      return false;
    }
  }
  if (existing.status === "done") return false;
  await db
    .update(personaWritebackRuns)
    .set({ status: "processing", error: null, updatedAt: new Date() } as never)
    .where(eq(personaWritebackRuns.id, existing.id));
  return true;
}

/** 回写结束：done / failed（失败保留 error 供重试） */
export async function finishPersonaWriteback(
  personaId: number,
  gameId: string,
  seat: number,
  status: "done" | "failed",
  error?: string | null,
): Promise<void> {
  const db = getDb();
  await db
    .update(personaWritebackRuns)
    .set({ status, error: (error ?? null) as never, updatedAt: new Date() } as never)
    .where(
      and(
        eq(personaWritebackRuns.personaId, personaId),
        eq(personaWritebackRuns.gameId, gameId),
        eq(personaWritebackRuns.seat, seat),
      ),
    );
}

/** 某局回写失败/未完成的座位（心理检查续跑用） */
export async function listPersonaWritebackFailedSeats(gameId: string): Promise<number[]> {
  const db = getDb();
  const rows: any[] = await db
    .select({ seat: personaWritebackRuns.seat, status: personaWritebackRuns.status })
    .from(personaWritebackRuns)
    .where(eq(personaWritebackRuns.gameId, gameId));
  return rows.filter((r: { status: string }) => r.status !== "done").map((r: { seat: number }) => r.seat);
}

export async function listPersonaRelationships(
  personaId: number,
  userId: string,
): Promise<PersonaRelationship[] | null> {
  const owner = await getPersona(personaId, userId);
  if (!owner) return null;
  const db = getDb();
  // 2026-10-22：改为读取单一事实源 persona_relations（旧表仅作为历史沿革的过渡投影）
  const rows: any[] = await db
    .select()
    .from(personaRelations)
    .where(and(eq(personaRelations.fromPersonaId, personaId), eq(personaRelations.status, "active")))
    .orderBy(desc(personaRelations.updatedAt));
  // to_name 可能为空（手录/补完未填名字）：从人格表补目标名，详情页不显示空白
  const targetIds = [...new Set(rows.map((r: { toPersonaId: number }) => r.toPersonaId).filter((id: number) => id > 0))];
  const targetNameRows = targetIds.length
    ? await db
        .select({ id: personas.id, name: personas.name })
        .from(personas)
        .where(inArray(personas.id, targetIds))
    : [];
  const targetNames = new Map<number, string>(targetNameRows.map((n: { id: number; name: string }) => [n.id, n.name]));
  return rows.map((r: any) => ({
    ...relationToPersonaRelationship(r),
    targetName: r.toName || targetNames.get(r.toPersonaId) || "",
  }));
}

/** 反向关系汇总（TA 对我：读取 persona_relations 的入边，来源人格名一并解析） */
export async function listIncomingPersonaRelationships(
  personaId: number,
  userId: string,
): Promise<(PersonaRelationship & { sourceName: string })[] | null> {
  const owner = await getPersona(personaId, userId);
  if (!owner) return null;
  const db = getDb();
  const rows: any[] = await db
    .select()
    .from(personaRelations)
    .where(and(eq(personaRelations.toPersonaId, personaId), eq(personaRelations.status, "active")))
    .orderBy(desc(personaRelations.updatedAt));
  const ids = [...new Set(rows.map((r: { fromPersonaId: number }) => r.fromPersonaId))];
  const nameRows = ids.length
    ? await db
        .select({ id: personas.id, name: personas.name })
        .from(personas)
        .where(inArray(personas.id, ids))
    : [];
  const names = new Map<number, string>(nameRows.map((n: { id: number; name: string }) => [n.id, n.name]));
  return rows.map((r: any) => ({
    ...relationToPersonaRelationship(r),
    sourceName: names.get(r.fromPersonaId) ?? "未知人格",
  }));
}

/** 查一组人格卡两两之间的在场关系（对局圈层羁绊注入用：观察者与被观察者都在集合内）。
 *  服务层内部调用（已按对局绑定过滤，无需 userId 维度）。 */
export async function listRelationshipsAmong(personaIds: number[]): Promise<RelationshipRow[]> {
  if (personaIds.length < 2) return [];
  const db = getDb();
  return db
    .select()
    .from(personaRelationships)
    .where(
      and(
        inArray(personaRelationships.personaId, personaIds),
        inArray(personaRelationships.targetPersonaId, personaIds),
      ),
    )
    .orderBy(desc(personaRelationships.updatedAt));
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

/** 记忆类型中文标签：**仅供 UI / 研究展示**，禁止进入 prompt（§4.10.2 命名硬规则） */
export const MEMORY_TYPE_LABEL: Record<string, string> = {
  trauma: "创伤",
  triumph: "高光",
  relationship: "关系",
  general: "经历",
};

/** 「记性」记忆池：**结构化缓存**，供每回合按情境现算注入文本（设计文档 §4.10.4）。
 *  开局加载一次，避免每回合查库；渲染是纯函数。 */
export interface MemoryPool {
  items: MemoryItem[];
  relationships: {
    targetName: string;
    relation: string;
    affinity: number;
    trust: number;
    note: string;
  }[];
}

export async function loadMemoryPool(personaId: number): Promise<MemoryPool> {
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

  return {
    items: mems
      // 自我叙述（认知笔记）不是经历，永不参与检索（见 §4.10.6.1 生产端下线）
      .filter((m) => (m.origin ?? "game") !== "self_narrative")
      .map((m) => ({
        id: m.id,
        type: m.type,
        content: m.content,
        strength: m.strength,
        valence: m.valence ?? 0,
        emotionalWeight: m.emotionalWeight,
        situationSignature: m.situationSignature ?? null,
        lifecycle: m.lifecycle ?? "active",
      })),
    relationships: rels.slice(0, 6).map((r) => ({
      targetName: r.targetName,
      relation: r.relation || "关系未名",
      affinity: r.affinity,
      trust: r.trust,
      note: r.note ?? "",
    })),
  };
}

/** 由记忆池按**当前情境**现算注入文本（纯函数，可每回合调用）。
 *  ⚠️ 命名硬规则（§4.10.2）：**机制名一律不得进入 prompt**——只给内容。
 *  旧标签「自传体记忆：」「关系图谱：」已移除（前者会直接诱发扮演自传）。 */
export function renderMemoryText(
  pool: MemoryPool | null | undefined,
  opts: { signature?: string | null; k?: number; charCap?: number } = {},
): string {
  if (!pool) return "";
  const picked = recallMemories(pool.items, {
    signature: opts.signature ?? null,
    k: opts.k ?? 6,
  });
  const remembered = composeRemembered(picked, { charCap: opts.charCap ?? 0 });
  const relLines = pool.relationships.map(
    (r) => `· 「${r.targetName}」${r.relation}（亲疏${r.affinity}，信任${r.trust}）${r.note ? `——${r.note}` : ""}`,
  );
  const parts = [remembered, relLines.length ? `（你与他们之间）\n${relLines.join("\n")}` : ""].filter(Boolean);
  const text = parts.join("\n");
  return opts.charCap && opts.charCap > 0 ? text.slice(0, opts.charCap) : text;
}

/** 兼容入口：加载池 + 渲染（旧的一次性路径；对局内请改用 loadMemoryPool + renderMemoryText） */
export async function loadMemoryContext(
  personaId: number,
  opts: { signature?: string | null; k?: number; charCap?: number } = {},
): Promise<string> {
  return renderMemoryText(await loadMemoryPool(personaId), opts);
}

// ---------- 记忆写入（记事簿回写管线） ----------
export interface NewPersonaMemory {
  personaId: number;
  gameId: string;
  type: "trauma" | "triumph" | "relationship" | "general";
  content: string;
  emotionalWeight: number;
  valence: number; // -100..100 效价（Russell 1980 情绪二维）
  strength: number;
  /** 情境签名（编码特异性检索键，§4.10.4）：game:<阵营> —— 写入时记录本局处境 */
  situationSignature?: string | null;
}

export async function insertPersonaMemories(rows: NewPersonaMemory[]): Promise<number[]> {
  if (rows.length === 0) return [];
  const ids: number[] = [];
  for (const r of rows) {
    const values = {
      personaId: r.personaId,
      gameId: r.gameId,
      type: r.type,
      content: r.content,
      emotionalWeight: r.emotionalWeight,
      valence: r.valence,
      strength: r.strength,
      situationSignature: r.situationSignature ?? null,
      updatedAt: new Date(),
    };
    const id = await insertReturningId(personaMemories, values);
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
}): Promise<{ affinity: number; trust: number }> {
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
    const next = {
      affinity: clamp(cur.affinity + input.affinityDelta, -100, 100),
      trust: clamp(cur.trust + input.trustDelta, 0, 100),
    };
    await db
      .update(personaRelationships)
      .set({
        targetPersonaId: input.targetPersonaId ?? cur.targetPersonaId,
        relation: input.relation || cur.relation,
        affinity: next.affinity,
        trust: next.trust,
        note: input.note || cur.note,
        gameId: input.gameId,
        updatedAt: new Date(),
      })
      .where(eq(personaRelationships.id, cur.id));
    return next;
  }
  const init = {
    affinity: clamp(input.affinityDelta, -100, 100),
    trust: clamp(50 + input.trustDelta, 0, 100), // 新关系信任基线 50 起调
  };
  await db.insert(personaRelationships).values({
    personaId: input.personaId,
    targetPersonaId: input.targetPersonaId,
    targetName: input.targetName,
    relation: input.relation,
    affinity: init.affinity,
    trust: init.trust,
    note: input.note,
    gameId: input.gameId,
    updatedAt: new Date(),
  });
  return init;
}

// ---------- 关系历史（人格锚点关系的逐局变迁；追加写，不改不删） ----------

/** 追加一条关系历史（记事簿回写时与汇总 upsert 同步调用） */
export async function insertPersonaRelationshipHistory(input: {
  personaId: number;
  targetPersonaId: number | null;
  targetName: string;
  gameId: string;
  titleNo: string;
  relation: string;
  affinityDelta: number;
  trustDelta: number;
  affinity: number; // 当局结算后累计值（汇总行 upsert 后的读数）
  trust: number;
  note: string;
  backfill?: boolean; // 追溯回填标记（默认 false=赛后实时回写）
}): Promise<void> {
  const db = getDb();
  await db.insert(personaRelationshipHistory).values({
    personaId: input.personaId,
    targetPersonaId: input.targetPersonaId,
    targetName: input.targetName,
    gameId: input.gameId,
    titleNo: input.titleNo,
    relation: input.relation,
    affinityDelta: input.affinityDelta,
    trustDelta: input.trustDelta,
    affinity: input.affinity,
    trust: input.trust,
    note: input.note,
    backfill: input.backfill === true ? 1 : 0,
  });
}

/** 沿革行存在性（回写幂等守卫：同 persona+target+game 已有沿革则不再追加——
 *  追溯回填补过的局，赛后实时回写不得双写） */
export async function hasPersonaRelationshipHistory(
  personaId: number,
  targetPersonaId: number,
  gameId: string,
): Promise<boolean> {
  const db = getDb();
  const rows = await db
    .select({ id: personaRelationshipHistory.id })
    .from(personaRelationshipHistory)
    .where(
      and(
        eq(personaRelationshipHistory.personaId, personaId),
        eq(personaRelationshipHistory.targetPersonaId, targetPersonaId),
        eq(personaRelationshipHistory.gameId, gameId),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** 人格的关系历史（详情页折叠栏用；双向：我→TA 与 TA→我 都取——沿革的本质是双方视角的时间线） */
export async function listPersonaRelationshipHistory(
  personaId: number,
  userId: string,
): Promise<PersonaRelationshipHistory[] | null> {
  const owner = await getPersona(personaId, userId);
  if (!owner) return null;
  const db = getDb();
  const rows = await db
    .select()
    .from(personaRelationshipHistory)
    .where(
      or(
        eq(personaRelationshipHistory.personaId, personaId),
        eq(personaRelationshipHistory.targetPersonaId, personaId),
      ),
    )
    // 沿革按对局时间线（标题号即日期+序号），同局内按写入次序；与写入先后解耦（追溯回填友好）
    .orderBy(personaRelationshipHistory.titleNo, personaRelationshipHistory.createdAt);
  return rows.map((r: typeof personaRelationshipHistory.$inferSelect) => ({
    id: r.id,
    personaId: r.personaId,
    targetPersonaId: r.targetPersonaId,
    targetName: r.targetName,
    gameId: r.gameId,
    titleNo: r.titleNo,
    relation: r.relation,
    affinityDelta: r.affinityDelta,
    trustDelta: r.trustDelta,
    affinity: r.affinity,
    trust: r.trust,
    note: r.note,
    backfill: Number(r.backfill) === 1,
    createdAt: (r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt)).toISOString(),
  }));
}

// ---------- 铸造过程检查点（逐阶段落盘；中断续铸的原料） ----------

/** 写检查点（同 castId+stage 覆盖） */
export async function upsertCastCheckpoint(castId: string, stage: string, data: unknown): Promise<void> {
  // 方言纪律：delete+insert（同上）
  const db = getDb();
  await db
    .delete(personaCastCheckpoints)
    .where(and(eq(personaCastCheckpoints.castId, castId), eq(personaCastCheckpoints.stage, stage)));
  await db
    .insert(personaCastCheckpoints)
    .values({ castId, stage, data: data as never, updatedAt: new Date() });
}

/** 读某铸造的全部检查点（stage → data） */
export async function listCastCheckpoints(castId: string): Promise<Record<string, unknown>> {
  const db = getDb();
  const rows = await db
    .select()
    .from(personaCastCheckpoints)
    .where(eq(personaCastCheckpoints.castId, castId));
  const out: Record<string, unknown> = {};
  for (const r of rows) out[r.stage] = r.data;
  return out;
}

/** 清除某铸造的全部检查点（完成/终止/取走草稿时） */
export async function deleteCastCheckpoints(castId: string): Promise<void> {
  const db = getDb();
  await db.delete(personaCastCheckpoints).where(eq(personaCastCheckpoints.castId, castId));
}

/** 全部带 params 检查点的铸造（水合中断条目用：返回 castId → params） */
export async function listAllCastCheckpointParams(): Promise<Map<string, unknown>> {
  const db = getDb();
  const rows = await db
    .select()
    .from(personaCastCheckpoints)
    .where(eq(personaCastCheckpoints.stage, "params"));
  const out = new Map<string, unknown>();
  for (const r of rows) out.set(r.castId, r.data);
  return out;
}

// ---------- 自我认知笔记（沿革版本化；最新篇由写管线同步进 profile.essence） ----------

export type CognitionNoteRow = PersonaCognitionNote;

/** 追加一篇认知笔记 */
export async function insertPersonaCognitionNote(input: {
  personaId: number;
  content: string;
  model: string;
  opts: { includeReports?: boolean; includeDrift?: boolean };
  gameCount: number;
  createdAt?: Date; // 补录初稿时锚定铸造时刻（沿革按产生先后排序的真实性）
}): Promise<void> {
  const db = getDb();
  await db.insert(personaCognitionNotes).values({
    personaId: input.personaId,
    content: input.content,
    model: input.model,
    opts: input.opts,
    gameCount: input.gameCount,
    ...(input.createdAt ? { createdAt: input.createdAt } : {}),
  });
}

/** 认知笔记沿革（新的在前） */
export async function listPersonaCognitionNotes(
  personaId: number,
  userId: string,
): Promise<CognitionNoteRow[] | null> {
  const owner = await getPersona(personaId, userId);
  if (!owner) return null;
  const db = getDb();
  const rows = await db
    .select()
    .from(personaCognitionNotes)
    .where(eq(personaCognitionNotes.personaId, personaId))
    .orderBy(desc(personaCognitionNotes.createdAt));
  return rows.map((r: typeof personaCognitionNotes.$inferSelect) => ({
    id: r.id,
    personaId: r.personaId,
    content: r.content,
    model: r.model,
    opts: (r.opts ?? {}) as PersonaCognitionNote["opts"],
    gameCount: r.gameCount,
    createdAt: (r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt)).toISOString(),
  }));
}

/** 保存人格演化小数累积器（EWMA 微小位移的落账缓冲；铁律7 可追溯） */
export async function saveParamsResidual(
  personaId: number,
  residual: Record<string, number>,
): Promise<void> {
  const db = getDb();
  await db
    .update(personas)
    .set({ paramsResidual: residual as never, updatedAt: new Date() })
    .where(eq(personas.id, personaId));
}

/** 同步现役自我认知（最新笔记进 profile.essence——对局注入的唯一事实源） */
export async function updatePersonaEssence(personaId: number, content: string): Promise<void> {
  const db = getDb();
  const rows = await db.select().from(personas).where(eq(personas.id, personaId)).limit(1);
  const row = rows[0];
  if (!row) return;
  const profile = { ...(row.profile as Record<string, unknown>), essence: content };
  await db
    .update(personas)
    .set({ profile: profile as never, updatedAt: new Date() })
    .where(eq(personas.id, personaId));
}

/** 编辑认知笔记（若编辑的是最新篇，essence 同步更新——现役认知始终=最新篇） */
export async function updatePersonaCognitionNote(
  noteId: number,
  personaId: number,
  userId: string,
  content: string,
): Promise<void> {
  const owner = await getPersona(personaId, userId);
  if (!owner) return;
  const db = getDb();
  await db
    .update(personaCognitionNotes)
    .set({ content })
    .where(and(eq(personaCognitionNotes.id, noteId), eq(personaCognitionNotes.personaId, personaId)));
  const latest = await db
    .select()
    .from(personaCognitionNotes)
    .where(eq(personaCognitionNotes.personaId, personaId))
    .orderBy(desc(personaCognitionNotes.createdAt))
    .limit(1);
  if (latest[0] && latest[0].id === noteId) await updatePersonaEssence(personaId, content);
}

/** 删除认知笔记（若删的是最新篇：essence 回退到新的最新篇；一篇不剩则保留 essence 现状） */
export async function deletePersonaCognitionNote(
  noteId: number,
  personaId: number,
  userId: string,
): Promise<void> {
  const owner = await getPersona(personaId, userId);
  if (!owner) return;
  const db = getDb();
  await db
    .delete(personaCognitionNotes)
    .where(and(eq(personaCognitionNotes.id, noteId), eq(personaCognitionNotes.personaId, personaId)));
  const latest = await db
    .select()
    .from(personaCognitionNotes)
    .where(eq(personaCognitionNotes.personaId, personaId))
    .orderBy(desc(personaCognitionNotes.createdAt))
    .limit(1);
  if (latest[0]) await updatePersonaEssence(personaId, latest[0].content as string);
}

// ---------- 铸造草稿持久化（铸魂师产物入库前的安身之处） ----------

/** 草稿落库（完成即写；幂等覆盖同 castId）。草稿箱=生成进程的全程镜像：
 * 从入队起每个状态都写穿（queued/running/paused/interrupted/failed/done），
 * 清库权限只有两个：用户主动删除 / 草稿核对入库成功核销——除此之外绝不清库 */
export async function upsertPersonaCastDraft(input: {
  castId: string;
  userId: string | null;
  name: string;
  result: unknown;
  status?: string;
}): Promise<void> {
  // 方言纪律（实锤）：onConflictDoUpdate 只有 SQLite 驱动有——MySQL 驱动会
  // TypeError 静默炸在 catch 里。upsert 一律 delete+insert（upsertPersonaReport 同款先例）
  const db = getDb();
  const status = input.status ?? "done";
  await db.delete(personaCastDrafts).where(eq(personaCastDrafts.castId, input.castId));
  await db.insert(personaCastDrafts).values({
    castId: input.castId,
    userId: input.userId,
    name: input.name,
    result: input.result as never,
    status,
    updatedAt: new Date(),
  });
}

/** 仅推进状态（进程镜像写穿；result 不动） */
export async function setCastDraftStatus(castId: string, status: string): Promise<void> {
  const db = getDb();
  await db
    .update(personaCastDrafts)
    .set({ status, updatedAt: new Date() })
    .where(eq(personaCastDrafts.castId, castId));
}

/** 未取走的草稿（重启水合用） */
export async function listPersonaCastDrafts(): Promise<
  { castId: string; userId: string | null; name: string; result: unknown; status: string; createdAt: Date }[]
> {
  const db = getDb();
  const rows = await db.select().from(personaCastDrafts).orderBy(desc(personaCastDrafts.createdAt));
  return rows.map((r: typeof personaCastDrafts.$inferSelect) => ({
    castId: r.castId,
    userId: r.userId,
    name: r.name,
    result: r.result,
    status: r.status,
    createdAt: r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt),
  }));
}

/** 取走/放弃草稿（ack 后删除） */
export async function deletePersonaCastDraft(castId: string): Promise<void> {
  const db = getDb();
  await db.delete(personaCastDrafts).where(eq(personaCastDrafts.castId, castId));
}

// ============================================================
// M2 审计链：状态观测 + 演化台账（铁律7：任何改写必须留痕、可追溯）
// ============================================================

export interface NewStateObservation {
  personaId: number;
  scenarioId: string;
  scenarioKind: string;
  scenarioIndex: number;
  cumulativeSalience: number;
  traitPath: string;
  stateValue: number;
  /** 本局状态相对自身特质的方向（φ「同情境同向重复」的统计键） */
  direction: "up" | "down";
  situationClassId: string;
  situationSignature: string;
  salience: number;
  sourceParam: string;
}

/** 写状态观测（**幂等**：同一 scenario × path × direction 只落一条，重复回写不虚增重复次数） */
export async function insertStateObservations(rows: NewStateObservation[]): Promise<number[]> {
  if (rows.length === 0) return [];
  const db = getDb();
  const ids: number[] = [];
  for (const r of rows) {
    await insertIgnore(personaStateObservations, r as never);
    // 取回该唯一键对应的 id（重复回写时返回既有行 id，供台账关联）
    const got = await db
      .select({ id: personaStateObservations.id })
      .from(personaStateObservations)
      .where(
        and(
          eq(personaStateObservations.personaId, r.personaId),
          eq(personaStateObservations.scenarioId, r.scenarioId),
          eq(personaStateObservations.traitPath, r.traitPath),
          eq(personaStateObservations.direction, r.direction),
        ),
      );
    ids.push(got[0]?.id ?? 0);
  }
  return ids;
}

/** φ 的输入：该人格在**同情境类**下、对**同一参数**、**同向**的历史观测次数 */
export async function countSameDirectionObservations(
  personaId: number,
  situationClassId: string,
  traitPath: string,
  direction: "up" | "down",
): Promise<number> {
  const db = getDb();
  const rows = await db
    .select({ id: personaStateObservations.id })
    .from(personaStateObservations)
    .where(
      and(
        eq(personaStateObservations.personaId, personaId),
        eq(personaStateObservations.situationClassId, situationClassId),
        eq(personaStateObservations.traitPath, traitPath),
        eq(personaStateObservations.direction, direction),
      ),
    );
  return rows.length;
}

export interface NewTraitUpdate {
  personaId: number;
  scenarioId: string;
  traitPath: string;
  valueFrom: number;
  valueTo: number;
  alphaEff: number;
  factorsJson: unknown;
  observationIds: number[];
  mechanismVersion: string;
}

/** 写演化台账（每次**实际发生**的特质更新一条；α_eff 与四因子全量落库） */
export async function insertTraitUpdates(rows: NewTraitUpdate[]): Promise<void> {
  if (rows.length === 0) return;
  const db = getDb();
  for (const r of rows) {
    await db.insert(personaTraitUpdates).values(r as never);
  }
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
    // 落库兜底钳位（铁律1）：即便上游漏钳，也绝不写入越界值
    params = setParamValue(params, c.path, clampParam(c.to));
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

// ---------- 心理检查报告 ----------
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
