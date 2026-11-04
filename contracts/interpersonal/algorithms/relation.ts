// 一阶关系算法（纯函数，零 I/O）
// 审计修复（P0-11 / P1-8）：
//   - mergeLayers 只对双维情感取 max，其余维度保留 canon 值，并输出 sources
//   - rankHierarchy 按观察者（fromPersonaId）分组排名
//   - applyCorrection 增加 patch 白名单 + 数值值域 clamp + nextId 回填
import type {
  RelationRow, RelationMetrics, RelationParamPath, DiffItem,
  RelationLayer, RelationForm, CorrectionResult,
} from "../types";
import { RELATION_FORMS } from "../vocab";

/** 0..100 百分比域 clamp（非有限值归 0，与 deriveMetrics 一致） */
export function clamp100(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, Math.round(v)));
}

/** 任意 [min, max] 域 clamp；非有限值取 min（调用方保证不把坏值当有效值） */
export function clampRange(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, Math.round(v)));
}

/** 0..1 比例 clamp；非有限值归 0 */
export function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

/** 双维情感派生量（§12.2）：正负独立，可同时高 */
export function deriveMetrics(row: RelationRow): RelationMetrics {
  const p = clamp100(row.positivity ?? 0);
  const n = clamp100(row.negativity ?? 0);
  return { involvement: Math.max(p, n), ambivalence: Math.min(p, n), netAffect: p - n };
}

/**
 * 两层融合（§5.2 双维合成 / §12.2）。
 * ⚠️ **只有双维情感采用 max**：爱不会被一局敌对抹掉，恨也不会被旧情抹掉。
 * ⚠️ trust / closeness / dependence / reciprocity / commitment **不做 max**（P0-11）：
 *    信任、亲密、依赖等是时间累积量，取 max 会凭空抬高研究数据；保留 canon 行的值。
 * ⚠️ canon 的 kind 永不被删除（merge 键仍含 kind，vale 独有 kind 只增）。
 * 融合行 `layer` 仍为 "canon"（向后兼容读模型/前端按层着色），来源由新增可选字段 `sources` 表达。
 */
export function mergeLayers(canon: RelationRow[], vale: RelationRow[]): RelationRow[] {
  const key = (r: RelationRow) => `${r.fromPersonaId}->${r.toPersonaId}:${r.kind}`;
  const map = new Map<string, RelationRow>();
  for (const r of canon) map.set(key(r), { ...r, sources: ["canon"] });
  for (const v of vale) {
    const k = key(v);
    const c = map.get(k);
    if (!c) { map.set(k, { ...v, sources: ["vale"] }); continue; }
    map.set(k, {
      ...c,
      // 仅双维情感取 max（§5.2：爱恨可并存、互不抹除）
      positivity: Math.max(c.positivity ?? 0, v.positivity ?? 0),
      negativity: Math.max(c.negativity ?? 0, v.negativity ?? 0),
      // 以下维度不使用 max：保留 canon 值（canon 缺省时才退回 vale，避免丢数）
      trust: c.trust ?? v.trust,
      closeness: c.closeness ?? v.closeness,
      dependence: c.dependence ?? v.dependence,
      reciprocity: c.reciprocity ?? v.reciprocity,
      commitment: c.commitment ?? v.commitment,
      // 背叛次数是史实，只增不减（§12.7）→ 取 max
      violationCount: Math.max(c.violationCount ?? 0, v.violationCount ?? 0),
      layer: "canon" as RelationLayer,
      sources: ["canon", "vale"],
    });
  }
  return [...map.values()];
}

/**
 * 依恋层级排序（C7）：**按观察者（fromPersonaId）分组**后各自排名。
 * 关系层级是"某个人心里的排序"，把多个观察者的边混在一起排名没有意义（P0-11）。
 * @param observerId 可选：只排某个观察者的边（等价于先按 fromPersonaId 过滤）
 */
export function rankHierarchy(rows: RelationRow[], observerId?: number): Array<RelationRow & { rank: number }> {
  const groups = new Map<number, RelationRow[]>();
  for (const r of rows) {
    if (observerId !== undefined && r.fromPersonaId !== observerId) continue;
    const g = groups.get(r.fromPersonaId);
    if (g) g.push(r);
    else groups.set(r.fromPersonaId, [r]);
  }
  const out: Array<RelationRow & { rank: number }> = [];
  // 组间按 fromPersonaId 稳定排序；组内按卷入度降序、同分按 id 稳定
  for (const gid of [...groups.keys()].sort((a, b) => a - b)) {
    const sorted = groups.get(gid)!.sort((a, b) => {
      const d = deriveMetrics(b).involvement - deriveMetrics(a).involvement;
      if (d !== 0) return d;
      return (a.id ?? 0) - (b.id ?? 0);
    });
    sorted.forEach((r, i) => out.push({ ...r, rank: i + 1 }));
  }
  return out;
}

/** 关系 diff（补完）：keep / correct / fill */
export function diffRelations(
  current: Partial<Record<RelationParamPath, number | string>>,
  proposed: Partial<Record<RelationParamPath, number | string>>,
): DiffItem[] {
  const out: DiffItem[] = [];
  for (const [k, v] of Object.entries(proposed) as Array<[RelationParamPath, number | string]>) {
    const cur = current[k];
    if (cur === undefined || cur === null) out.push({ param: k, action: "fill", before: null, after: v });
    else if (cur !== v) out.push({ param: k, action: "correct", before: cur, after: v });
    else out.push({ param: k, action: "keep", before: cur, after: v });
  }
  return out;
}

// ============================================================
// 校正执行（§13.5 / §12.7）
// ============================================================

/** 数值校正字段白名单与值域（只有这些键会被 applyCorrection 采纳） */
const CORRECTABLE_NUMERIC: Readonly<Record<string, readonly [number, number]>> = {
  positivity: [0, 100],
  negativity: [0, 100],
  trust: [0, 100],
  closeness: [0, 100],
  dependence: [0, 100],
  reciprocity: [0, 100],
  powerBalance: [-100, 100], // 双极：-100 居下 .. +100 居上（§25.6）
  formality: [0, 100],
  commitment: [0, 100],
  prototypicality: [0, 1],
  disclosable: [0, 1],
};

/**
 * patch 白名单 + 值域清洗（P0-11 / P1-8）。
 * - 非白名单字段（id / fromPersonaId / toPersonaId / layer / status / supersededBy ...）一律忽略，
 *   防止调用方误传整行把史实字段改坏（如 superseded_by 自指、id 被覆盖）；
 * - 数值字段 clamp 到值域；NaN/Infinity 视为坏值直接忽略（不落库）；
 * - kind 接受非空字符串（kind 可多值组合，词表收敛由写收口负责）；form 必须是 Fiske 四型之一。
 */
export function sanitizeCorrectionPatch(patch: Partial<RelationRow>): Partial<RelationRow> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (key === "kind") {
      if (typeof value === "string" && value.trim().length > 0) out.kind = value;
      continue;
    }
    if (key === "form") {
      if (typeof value === "string" && (RELATION_FORMS as readonly string[]).includes(value)) {
        out.form = value as RelationForm;
      }
      continue;
    }
    const bounds = CORRECTABLE_NUMERIC[key];
    if (!bounds) continue; // 白名单外：静默忽略
    if (typeof value !== "number" || !Number.isFinite(value)) continue; // 坏值不落库
    out[key] = clampRange(value, bounds[0], bounds[1]);
  }
  return out as Partial<RelationRow>;
}

/**
 * 校正执行（§13.5）：原行标 superseded（不删除），生成修正后的新行。
 * `nextId`：新行 id。纯函数阶段可传 null（未知）；写收口插入新行后回填，
 * 这样 superseded_by 指向新行而不是自己（P1-8 的根因）。
 */
export function applyCorrection(
  row: RelationRow,
  patch: Partial<RelationRow>,
  nextId: number | null = null,
): CorrectionResult {
  const clean = sanitizeCorrectionPatch(patch);
  const id = typeof nextId === "number" && Number.isFinite(nextId) && nextId > 0 ? Math.floor(nextId) : null;
  const superseded: RelationRow = { ...row, status: "superseded", supersededBy: id };
  const next: RelationRow = {
    ...row,
    ...clean,
    id: id ?? undefined,
    status: "active",
    supersededBy: null,
  };
  return { superseded, next, nextId: id };
}

/** 写收口插入新行后回填 id：让 superseded_by / next.id 都指向新行（不产生自指） */
export function linkCorrection(result: CorrectionResult, nextId: number): CorrectionResult {
  const id = typeof nextId === "number" && Number.isFinite(nextId) && nextId > 0 ? Math.floor(nextId) : null;
  return {
    superseded: { ...result.superseded, supersededBy: id },
    next: { ...result.next, id: id ?? undefined },
    nextId: id,
  };
}
