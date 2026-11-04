// ============================================================
// L3 服务层：**唯一写入入口**（§27.4 Write Funnel）
//
// 2026-10-22 审计修复：
// - 唯一键改为「仅 active 行唯一」；悬空边 to_name 参与匹配（不再吞掉第二个库外对象）
// - 每次写入逐字段 diff 落 relation_deltas（I6 不变量），不再一条 "kind" 空台账糊弄
// - 数值写入统一 clamp 到合法范围；非有限值拒绝
// - 校正（correctRelation）改为「旧行 supersede → 插入新 active 行」，修复自指/消失问题
// - 新增 applyRelationDelta（对局内增量写入口，接 §13 delta 校验）
// - 所有返回 id 的插入走 api/queries/dialect（兼容 MySQL 无 returning）
// ============================================================
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { insertReturningId } from "../queries/dialect";
import { personaRelations, relationDeltas } from "../../db/schema";
import {
  MECHANISM_VERSION,
  checkRelationDelta,
  type RelationLayer,
  type RelationParamPath,
} from "../../contracts/interpersonal";

export interface RelationChangeInput {
  dyad: { fromPersonaId: number; toPersonaId: number; toName?: string | null };
  layer: RelationLayer;
  /** 关系类别（当前行 kind；kind/form 变更请用 correctRelation / changeRelationKind） */
  kind: string;
  form?: string;
  param: RelationParamPath;
  before: number | string | null;
  after: number | string;
  reason: {
    kind: "event" | "canon_retrieval" | "correction" | "manual" | "migration";
    eventIds?: number[];
    gameId?: string | null;
    evidence?: string[];
    salience?: number;
  };
  actor: string;
  originModule?: string;
}

const NUMERIC_PARAMS = new Set<string>([
  "positivity", "negativity", "trust", "closeness", "dependence",
  "reciprocity", "power_balance", "formality", "commitment",
]);

const COLUMN_OF: Partial<Record<RelationParamPath, string>> = {
  positivity: "positivity",
  negativity: "negativity",
  trust: "trust",
  closeness: "closeness",
  dependence: "dependence",
  reciprocity: "reciprocity",
  power_balance: "powerBalance",
  formality: "formality",
  commitment: "commitment",
  kind: "kind",
  form: "form",
};

/** 合法关系列白名单（RSQ 同步/手动修订用；防止任意列注入） */
const ALLOWED_RELATION_COLUMNS = new Set<string>([
  ...NUMERIC_PARAMS, "kind", "form", "toName", "toPersonaId", "basis", "sourceRef",
  "awareness", "disclosable", "violationCount", "trustStage", "scriptText",
  "addressTerm", "addressKind", "hierarchyRank",
  "rsqResponseId", "rsqAffection", "rsqAntagonism", "rsqFaith", "rsqCommitment",
  "rsqForgiveness", "rsqCloseness", "rsqAmbivalence", "rsqEquityBalance",
  "rsqVerdict", "rsqSelfSummary", "rsqUpdatedAt",
]);

const RELATION_100_COLUMNS = new Set<string>([
  "positivity", "negativity", "trust", "closeness", "dependence", "reciprocity",
  "formality", "commitment", "violationCount",
  "rsqAffection", "rsqAntagonism", "rsqFaith", "rsqCommitment", "rsqForgiveness",
  "rsqCloseness", "rsqAmbivalence", "rsqEquityBalance",
]);

/** 0..100（power_balance 为 -100..100）夹取；非有限值返回 null（拒绝写入） */
export function clampRelationValue(column: string, value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  if (column === "powerBalance" || column === "power_balance") {
    return Math.max(-100, Math.min(100, Math.round(n)));
  }
  if (RELATION_100_COLUMNS.has(column)) {
    return Math.max(0, Math.min(100, Math.round(n)));
  }
  return n;
}

export interface WriteResult {
  ok: boolean;
  relationId?: number;
  deltaId?: number;
  created?: boolean;
  changed?: number;
  reason?: string;
}

/** 当前 active 行的匹配条件（含悬空边 to_name） */
function activeRowWhere(input: {
  fromPersonaId: number;
  toPersonaId: number;
  toName?: string | null;
  layer: RelationLayer;
  kind?: string;
}) {
  return and(
    eq(personaRelations.fromPersonaId, input.fromPersonaId),
    eq(personaRelations.toPersonaId, input.toPersonaId),
    input.toName == null ? isNull(personaRelations.toName) : eq(personaRelations.toName, input.toName),
    eq(personaRelations.layer, input.layer),
    input.kind != null ? eq(personaRelations.kind, input.kind) : undefined,
    eq(personaRelations.status, "active"),
  );
}

async function findActiveRow(input: {
  fromPersonaId: number;
  toPersonaId: number;
  toName?: string | null;
  layer: RelationLayer;
  kind?: string;
}): Promise<any | null> {
  const db = getDb();
  const rows: any[] = await db
    .select()
    .from(personaRelations)
    .where(activeRowWhere(input))
    .limit(1);
  return rows[0] ?? null;
}

function deltaRowOf(args: {
  relationId: number;
  fromPersonaId: number;
  toPersonaId: number;
  layer: string;
  param: string;
  before?: number | string | null;
  after?: number | string | null;
  reasonKind: string;
  salience?: number | null;
  eventIds?: number[];
  gameId?: string | null;
  evidence?: string[];
  actor: string;
  correctedFrom?: number | null;
  verdict?: string | null;
}): typeof relationDeltas.$inferInsert {
  const isNumericPair = typeof args.before === "number" || typeof args.after === "number";
  const beforeNum = isNumericPair && typeof args.before === "number" ? args.before : null;
  const afterNum = isNumericPair && typeof args.after === "number" ? args.after : null;
  return {
    relationId: args.relationId,
    fromPersonaId: args.fromPersonaId,
    toPersonaId: args.toPersonaId,
    layer: args.layer,
    param: args.param,
    beforeValue: beforeNum,
    afterValue: afterNum,
    delta: beforeNum != null && afterNum != null ? afterNum - beforeNum : null,
    kindBefore: args.param === "kind" && args.before != null ? String(args.before) : null,
    kindAfter: args.param === "kind" && args.after != null ? String(args.after) : null,
    reasonKind: args.reasonKind,
    salience: args.salience ?? null,
    eventIds: (args.eventIds ?? []) as never,
    gameId: args.gameId ?? null,
    evidence: (args.evidence ?? []).map((e) => ({ text: e })) as never,
    verdict: args.verdict ?? null,
    correctedFrom: args.correctedFrom ?? null,
    actor: args.actor,
    mechanismVersion: MECHANISM_VERSION.delta ?? MECHANISM_VERSION.relations,
  } as never;
}

async function insertDeltaRows(rows: (typeof relationDeltas.$inferInsert)[]): Promise<void> {
  if (rows.length === 0) return;
  const db = getDb();
  await db.insert(relationDeltas).values(rows as never);
}

/** 对一行做 patch：逐字段对比 → 更新 → 落台账。返回变更字段数。 */
async function applyPatchWithLedger(
  row: any,
  patch: Record<string, unknown>,
  meta: {
    reasonKind: string;
    actor: string;
    originModule?: string;
    eventIds?: number[];
    gameId?: string | null;
    evidence?: string[];
    correctedFrom?: number | null;
  },
): Promise<{ changed: number; deltaRows: (typeof relationDeltas.$inferInsert)[] }> {
  const db = getDb();
  const changedCols: string[] = [];
  const setPatch: Record<string, unknown> = {};
  const deltas: (typeof relationDeltas.$inferInsert)[] = [];

  for (const [col, rawValue] of Object.entries(patch)) {
    if (!ALLOWED_RELATION_COLUMNS.has(col)) continue;
    const isNumeric = NUMERIC_PARAMS.has(col) || (RELATION_100_COLUMNS.has(col) && col.startsWith("rsq"));
    let next: unknown;
    if (col === "toPersonaId") {
      const n = Number(rawValue);
      if (!Number.isFinite(n)) continue;
      next = n;
    } else {
      next = isNumeric ? clampRelationValue(col, rawValue) : rawValue;
    }
    if (isNumeric && next == null) continue; // 非法数值拒绝
    const prev = row[col];
    const prevCmp = prev == null ? null : prev;
    if (prevCmp === next) continue;
    changedCols.push(col);
    setPatch[col] = next;
    deltas.push(
      deltaRowOf({
        relationId: row.id,
        fromPersonaId: row.fromPersonaId,
        toPersonaId: row.toPersonaId,
        layer: row.layer,
        param: col,
        before: typeof prev === "number" ? prev : prev == null ? null : String(prev),
        after: typeof next === "number" ? next : next == null ? null : String(next),
        reasonKind: meta.reasonKind,
        eventIds: meta.eventIds,
        gameId: meta.gameId,
        evidence: meta.evidence,
        actor: meta.actor,
        correctedFrom: meta.correctedFrom,
      }),
    );
  }

  if (changedCols.length === 0) return { changed: 0, deltaRows: [] };
  const patchWithMeta: Record<string, unknown> = {
    ...setPatch,
    updatedAt: new Date(),
  };
  if (meta.originModule) patchWithMeta.originModule = meta.originModule;
  await db.update(personaRelations).set(patchWithMeta as never).where(eq(personaRelations.id, row.id));
  await insertDeltaRows(deltas);
  return { changed: changedCols.length, deltaRows: deltas };
}

/**
 * 唯一写入入口：写关系行 + 落台账 + 填溯源。
 * 幂等：同 (from,to,toName,layer,kind) 的 active 行存在则按 change 更新，否则新建。
 */
export async function writeRelationChange(input: RelationChangeInput): Promise<WriteResult> {
  const { dyad, layer, kind, param, after, reason, actor } = input;
  const col = COLUMN_OF[param];
  if (!col) return { ok: false, reason: `未知参数 ${param}` };
  if (NUMERIC_PARAMS.has(param) && (typeof after !== "number" || !Number.isFinite(after))) {
    return { ok: false, reason: `参数 ${param} 必须为有限数字` };
  }
  const toId = dyad.toPersonaId ?? 0;
  const toName = dyad.toName ?? null;

  const existing = await findActiveRow({
    fromPersonaId: dyad.fromPersonaId,
    toPersonaId: toId,
    toName,
    layer,
    kind,
  });
  if (!existing) {
    const created = await writeRelationRow({
      fromPersonaId: dyad.fromPersonaId,
      toPersonaId: toId,
      toName,
      layer,
      kind,
      form: input.form,
      ...(NUMERIC_PARAMS.has(param) ? { [param]: after } as never : {}),
      actor,
      originModule: input.originModule,
      reasonKind: reason.kind,
    } as never);
    if (!created.ok) return created;
    return { ok: true, relationId: created.relationId, created: true, changed: 1 };
  }

  const patch: Record<string, unknown> = { [col]: after };
  if (param === "kind" || param === "form") {
    // kind/form 变更：走校正路径（旧行 superseded + 新 active 行）
    return changeRelationKindForm(existing, param, String(after), {
      actor,
      reasonKind: reason.kind,
      originModule: input.originModule,
      evidence: reason.evidence,
      eventIds: reason.eventIds,
      gameId: reason.gameId,
    });
  }
  const res = await applyPatchWithLedger(existing, patch, {
    reasonKind: reason.kind,
    actor,
    originModule: input.originModule ?? "weave",
    eventIds: reason.eventIds,
    gameId: reason.gameId,
    evidence: reason.evidence,
  });
  return { ok: true, relationId: existing.id, created: false, changed: res.changed };
}

interface KindFormMeta {
  actor: string;
  reasonKind: string;
  originModule?: string;
  eventIds?: number[];
  gameId?: string | null;
  evidence?: string[];
}

/** kind/form 变更：旧 active 行 supersede，插入同键新 active 行（partial unique 允许） */
async function changeRelationKindForm(
  oldRow: any,
  param: "kind" | "form",
  after: string,
  meta: KindFormMeta,
): Promise<WriteResult> {
  const db = getDb();
  const col = param === "kind" ? "kind" : "form";
  const newValue = after;
  if (!newValue || newValue.length > 64) return { ok: false, reason: "kind/form 非法" };
  // 1) 先挂起旧行（释放 active 唯一键）
  await db
    .update(personaRelations)
    .set({ status: "superseded", updatedAt: new Date() } as never)
    .where(eq(personaRelations.id, oldRow.id));
  // 2) 插入新 active 行（继承旧行全部字段，仅变更目标字段）
  const values: Record<string, unknown> = {
    fromPersonaId: oldRow.fromPersonaId,
    toPersonaId: oldRow.toPersonaId,
    toName: oldRow.toName,
    layer: oldRow.layer,
    kind: oldRow.kind,
    form: oldRow.form,
    positivity: oldRow.positivity,
    negativity: oldRow.negativity,
    trust: oldRow.trust,
    closeness: oldRow.closeness,
    dependence: oldRow.dependence,
    reciprocity: oldRow.reciprocity,
    powerBalance: oldRow.powerBalance,
    formality: oldRow.formality,
    commitment: oldRow.commitment,
    violationCount: oldRow.violationCount,
    awareness: oldRow.awareness,
    disclosable: oldRow.disclosable,
    basis: oldRow.basis,
    sourceRef: oldRow.sourceRef,
    originModule: meta.originModule ?? oldRow.originModule,
    originVersion: oldRow.originVersion,
    status: "active",
    createdAt: new Date(),
    updatedAt: new Date(),
    [col]: newValue,
  };
  let newId = 0;
  try {
    newId = await insertReturningId(personaRelations, values);
  } catch (e) {
    // 插入失败则回滚旧行 active，避免关系彻底消失
    await db
      .update(personaRelations)
      .set({ status: "active", updatedAt: new Date() } as never)
      .where(eq(personaRelations.id, oldRow.id));
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
  await db
    .update(personaRelations)
    .set({ supersededBy: newId, updatedAt: new Date() } as never)
    .where(eq(personaRelations.id, oldRow.id));
  await insertDeltaRows([
    deltaRowOf({
      relationId: newId,
      fromPersonaId: oldRow.fromPersonaId,
      toPersonaId: oldRow.toPersonaId,
      layer: oldRow.layer,
      param,
      before: param === "kind" ? oldRow.kind : oldRow.form,
      after: newValue,
      reasonKind: meta.reasonKind,
      eventIds: meta.eventIds,
      gameId: meta.gameId,
      evidence: meta.evidence,
      actor: meta.actor,
      correctedFrom: oldRow.id,
    }),
  ]);
  return { ok: true, relationId: newId, created: true, changed: 1 };
}

/** 批量写（同一 actor/reason，逐条落台账） */
export async function writeRelationBatch(
  inputs: RelationChangeInput[],
): Promise<{ written: number; failed: number }> {
  let written = 0;
  let failed = 0;
  for (const i of inputs) {
    const r = await writeRelationChange(i);
    if (r.ok) written++;
    else failed++;
  }
  return { written, failed };
}

/**
 * 校正（§13.5）：旧行标 superseded，写新 active 行 + correction 台账。
 * 修复：旧实现先原地改旧行再 supersede 同一行 → 校正后数据直接从读取视图消失。
 */
export async function correctRelation(input: {
  relationId: number;
  patch: Record<string, number | string | null>;
  actor: string;
  evidence?: string[];
  reasonKind?: string;
}): Promise<WriteResult> {
  const db = getDb();
  const rows: any[] = await db
    .select()
    .from(personaRelations)
    .where(and(eq(personaRelations.id, input.relationId), eq(personaRelations.status, "active")))
    .limit(1);
  const oldRow = rows[0];
  if (!oldRow) return { ok: false, reason: "关系行不存在或不是 active" };

  // 先挂起旧行，再插入新行（partial unique 允许同键）
  await db
    .update(personaRelations)
    .set({ status: "superseded", updatedAt: new Date() } as never)
    .where(eq(personaRelations.id, oldRow.id));

  const accepted: Record<string, unknown> = {};
  for (const [col, v] of Object.entries(input.patch)) {
    if (!ALLOWED_RELATION_COLUMNS.has(col)) continue;
    let next: unknown;
    if (col === "toPersonaId") {
      const n = Number(v);
      if (!Number.isFinite(n)) continue;
      next = n;
    } else {
      next = NUMERIC_PARAMS.has(col) || RELATION_100_COLUMNS.has(col)
        ? clampRelationValue(col, v)
        : v;
      if (NUMERIC_PARAMS.has(col) && next == null) continue;
    }
    if (next === oldRow[col]) continue;
    accepted[col] = next;
  }

  const values: Record<string, unknown> = {
    fromPersonaId: oldRow.fromPersonaId,
    toPersonaId: oldRow.toPersonaId,
    toName: oldRow.toName,
    layer: oldRow.layer,
    kind: oldRow.kind,
    form: oldRow.form,
    positivity: oldRow.positivity,
    negativity: oldRow.negativity,
    trust: oldRow.trust,
    closeness: oldRow.closeness,
    dependence: oldRow.dependence,
    reciprocity: oldRow.reciprocity,
    powerBalance: oldRow.powerBalance,
    formality: oldRow.formality,
    commitment: oldRow.commitment,
    violationCount: oldRow.violationCount,
    awareness: oldRow.awareness,
    disclosable: oldRow.disclosable,
    basis: oldRow.basis,
    sourceRef: oldRow.sourceRef,
    originModule: "correction",
    originVersion: MECHANISM_VERSION.relations,
    status: "active",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...accepted,
  };
  let newId = 0;
  try {
    newId = await insertReturningId(personaRelations, values);
  } catch (e) {
    await db
      .update(personaRelations)
      .set({ status: "active", updatedAt: new Date() } as never)
      .where(eq(personaRelations.id, oldRow.id));
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
  await db
    .update(personaRelations)
    .set({ supersededBy: newId, updatedAt: new Date() } as never)
    .where(eq(personaRelations.id, oldRow.id));

  const deltaRows: (typeof relationDeltas.$inferInsert)[] = [];
  for (const [col, next] of Object.entries(accepted)) {
    deltaRows.push(
      deltaRowOf({
        relationId: newId,
        fromPersonaId: oldRow.fromPersonaId,
        toPersonaId: oldRow.toPersonaId,
        layer: oldRow.layer,
        param: col,
        before: typeof oldRow[col] === "number" ? oldRow[col] : oldRow[col] == null ? null : String(oldRow[col]),
        after: typeof next === "number" ? next : next == null ? null : String(next),
        reasonKind: input.reasonKind ?? "correction",
        evidence: input.evidence,
        actor: input.actor,
        correctedFrom: oldRow.id,
      }),
    );
  }
  await insertDeltaRows(deltaRows);
  return { ok: true, relationId: newId, created: true, changed: deltaRows.length };
}

/** 对局内增量写入口（§13/§34）：读旧值 → 调 checkRelationDelta → clamp → 写台账 */
export async function applyRelationDelta(input: {
  dyad: { fromPersonaId: number; toPersonaId: number; toName?: string | null };
  layer: RelationLayer;
  kind: string;
  param: RelationParamPath;
  delta: number;
  reason: RelationChangeInput["reason"];
  actor: string;
  originModule?: string;
}): Promise<WriteResult & { applied?: number; verdict?: string }> {
  if (!NUMERIC_PARAMS.has(input.param)) return { ok: false, reason: "仅数值维度支持增量" };
  if (!Number.isFinite(input.delta)) return { ok: false, reason: "增量必须为有限数值" };
  const col = COLUMN_OF[input.param]!;
  let row = await findActiveRow({
    fromPersonaId: input.dyad.fromPersonaId,
    toPersonaId: input.dyad.toPersonaId,
    toName: input.dyad.toName,
    layer: input.layer,
    kind: input.kind,
  });
  // 同 dyad 已存在其它 kind 的关系：沿用既有 kind，避免每局新增一条并行边
  let effectiveKind = input.kind;
  if (!row) {
    const anyRow = await findActiveRow({
      fromPersonaId: input.dyad.fromPersonaId,
      toPersonaId: input.dyad.toPersonaId,
      toName: input.dyad.toName,
      layer: input.layer,
    });
    if (anyRow) {
      row = anyRow;
      effectiveKind = anyRow.kind;
    }
  }
  const defaultBefore = input.param === "trust" ? 50 : 0;
  const before = row && typeof row[col] === "number" ? Number(row[col]) : defaultBefore;
  const check = checkRelationDelta({
    param: input.param,
    layer: input.layer,
    actualDelta: input.delta,
    events: (input.reason.eventIds ?? []).map((eventId) => ({
      kind: "skill_targeted" as const,
      eventId,
      weight: input.delta,
    })),
    salience: input.reason.salience ?? 1,
    before,
    after: before + input.delta,
  } as never);
  const applied = clampRelationValue(col, before + input.delta);
  if (applied == null) return { ok: false, reason: "数值非法" };
  const res = await writeRelationChange({
    dyad: input.dyad,
    layer: input.layer,
    kind: effectiveKind,
    form: input.layer === "vale" ? "EM" : undefined,
    param: input.param,
    before,
    after: applied,
    reason: input.reason,
    actor: input.actor,
    originModule: input.originModule,
  });
  return { ...res, applied: applied - before, verdict: check.verdict };
}

/**
 * 任意关系列 patch（RSQ 同步、manual 修订、接合清空 toName 等）。
 * 逐列 clamp + 落台账，保证 I6。
 */
export async function applyRelationColumns(input: {
  relationId: number;
  patch: Record<string, unknown>;
  reasonKind: string;
  actor: string;
  originModule?: string;
  eventIds?: number[];
  gameId?: string | null;
  evidence?: string[];
}): Promise<WriteResult> {
  const db = getDb();
  const rows: any[] = await db
    .select()
    .from(personaRelations)
    .where(eq(personaRelations.id, input.relationId))
    .limit(1);
  const row = rows[0];
  if (!row) return { ok: false, reason: "关系行不存在" };
  const res = await applyPatchWithLedger(row, input.patch, {
    reasonKind: input.reasonKind,
    actor: input.actor,
    originModule: input.originModule,
    eventIds: input.eventIds,
    gameId: input.gameId,
    evidence: input.evidence,
  });
  return { ok: true, relationId: row.id, changed: res.changed };
}

export interface RelationRowInput {
  fromPersonaId: number;
  toPersonaId: number;
  toName?: string | null;
  layer: RelationLayer;
  kind: string;
  form?: string;
  prototypicality?: number;
  positivity?: number;
  negativity?: number;
  trust?: number;
  closeness?: number;
  dependence?: number;
  reciprocity?: number;
  powerBalance?: number;
  formality?: number;
  commitment?: number;
  addressBasis?: string | null;
  addressTerm?: string | null;
  addressKind?: string | null;
  basis?: string | null;
  sourceRef?: string | null;
  actor: string;
  originModule?: string;
  /** 台账 reason_kind（默认 canon_retrieval；arena=event、manual=manual） */
  reasonKind?: string;
  /** 如果行已存在，是否覆盖（默认 false：只补缺） */
  overwrite?: boolean;
}

const DIM_FIELDS: Array<[keyof RelationRowInput, string]> = [
  ["positivity", "positivity"],
  ["negativity", "negativity"],
  ["trust", "trust"],
  ["closeness", "closeness"],
  ["dependence", "dependence"],
  ["reciprocity", "reciprocity"],
  ["powerBalance", "powerBalance"],
  ["formality", "formality"],
  ["commitment", "commitment"],
  ["prototypicality", "prototypicality"],
];

const DIM_DEFAULTS: Record<string, number> = {
  positivity: 0,
  negativity: 0,
  trust: 50,
  closeness: 0,
  dependence: 0,
  reciprocity: 0,
  powerBalance: 0,
  formality: 0,
  commitment: 0,
  prototypicality: 1,
};

/**
 * 整行写入（铸造/编织/竞技场用）。
 * 若 active 行已存在且 overwrite=false → 返回 created:false（不写）。
 * overwrite=true → 逐字段 diff + 台账；不会覆盖 superseded 行（会把其视为不存在并新建 active）。
 */
export async function writeRelationRow(input: RelationRowInput): Promise<WriteResult & { created: boolean }> {
  const toId = input.toPersonaId ?? 0;
  const toName = input.toName ?? null;
  // 数值维度必须先校验有限性（禁止 NaN/Infinity 以 default 值静默落库）
  for (const [key] of DIM_FIELDS) {
    const v = input[key];
    if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v))) {
      return { ok: false, created: false, reason: `${String(key)} 必须为有限数字` };
    }
  }
  const existing = await findActiveRow({
    fromPersonaId: input.fromPersonaId,
    toPersonaId: toId,
    toName,
    layer: input.layer,
    kind: input.kind,
  });
  if (existing && !input.overwrite) {
    return { ok: true, relationId: existing.id, created: false, changed: 0 };
  }

  if (existing) {
    const patch: Record<string, unknown> = {};
    for (const [key, col] of DIM_FIELDS) {
      const v = input[key];
      if (v !== undefined) patch[col] = v;
    }
    if (input.form !== undefined) patch.form = input.form;
    if (input.addressTerm !== undefined) patch.addressTerm = input.addressTerm;
    if (input.addressKind !== undefined) patch.addressKind = input.addressKind;
    if (input.basis !== undefined) patch.basis = input.basis;
    if (input.sourceRef !== undefined) patch.sourceRef = input.sourceRef;
    const res = await applyPatchWithLedger(existing, patch, {
      reasonKind: input.reasonKind ?? "canon_retrieval",
      actor: input.actor,
      originModule: input.originModule ?? "weave",
    });
    if (res.changed === 0) return { ok: true, relationId: existing.id, created: false, changed: 0 };
    return { ok: true, relationId: existing.id, created: false, changed: res.changed };
  }

  // 先统一 clamp，行值与台账值必须一致（否则台账写 999、行写 100，I6 失真）
  const dimValues: Record<string, number> = {};
  for (const [key, col] of DIM_FIELDS) {
    const provided = input[key] as number | undefined;
    const clamped = provided === undefined ? DIM_DEFAULTS[col]! : clampRelationValue(col, provided);
    dimValues[col] = clamped ?? DIM_DEFAULTS[col]!;
  }

  const values: Record<string, unknown> = {
    fromPersonaId: input.fromPersonaId,
    toPersonaId: toId,
    toName,
    layer: input.layer,
    kind: input.kind,
    form: input.form ?? "CS",
    ...dimValues,
    addressTerm: input.addressTerm ?? null,
    addressKind: input.addressKind ?? null,
    basis: input.basis ?? null,
    sourceRef: input.sourceRef ?? null,
    originModule: input.originModule ?? "weave",
    originVersion: MECHANISM_VERSION.relations,
    status: "active",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const relationId = await insertReturningId(personaRelations, values);

  // 建边台账：每个实际提供的维度一条（before=null），再补一条 kind
  const reasonKind = input.reasonKind ?? "canon_retrieval";
  const deltaRows: (typeof relationDeltas.$inferInsert)[] = [];
  for (const [key, col] of DIM_FIELDS) {
    if (input[key] === undefined) continue;
    deltaRows.push(
      deltaRowOf({
        relationId,
        fromPersonaId: input.fromPersonaId,
        toPersonaId: toId,
        layer: input.layer,
        param: col,
        before: null,
        after: dimValues[col]!,
        reasonKind,
        actor: input.actor,
      }),
    );
  }
  deltaRows.push(
    deltaRowOf({
      relationId,
      fromPersonaId: input.fromPersonaId,
      toPersonaId: toId,
      layer: input.layer,
      param: "kind",
      before: null,
      after: input.kind,
      reasonKind,
      actor: input.actor,
    }),
  );
  await insertDeltaRows(deltaRows);
  return { ok: true, relationId, created: true, changed: deltaRows.length };
}

/** 兼容旧调用：批量整行写 */
export async function writeRelationRows(
  inputs: RelationRowInput[],
): Promise<{ written: number; created: number; failed: number }> {
  let written = 0, created = 0, failed = 0;
  for (const i of inputs) {
    const r = await writeRelationRow(i);
    if (r.ok) { written++; if (r.created) created++; } else failed++;
  }
  return { written, created, failed };
}
