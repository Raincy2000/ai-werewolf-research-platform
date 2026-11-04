// ============================================================
// 旧关系表 → 单一事实源迁移（2026-10-22 审计修复 P0-4）
//
// 背景：notebook 历史上只写 persona_relationships（旧汇总表），而关系图/摘要/羁绊
// 已改读 persona_relations；若不迁移，老用户切新视图后关系"消失"。
//
// 本迁移幂等、只读旧表、不删除旧数据（旧表继续作为关系沿革 UI 的过渡投影）：
//   persona_relationships(affinity -100..100, trust, relation, note)
//   → persona_relations.vale（positivity/negativity 双维 + trust + basis，kind=unspecified）
//
// 对已存在的同键 active 行跳过（不覆盖新图里更准确的数据）。
// ============================================================
import { and, eq } from "drizzle-orm";
import { getDb } from "./connection";
import { personaRelationships, personaRelations } from "../../db/schema";
import { writeRelationRow } from "../network/writeModel";

export async function migrateLegacyRelations(): Promise<{ migrated: number; skipped: number }> {
  const db = getDb();
  let oldRows: any[] = [];
  try {
    oldRows = await db.select().from(personaRelationships);
  } catch {
    return { migrated: 0, skipped: 0 };
  }
  if (oldRows.length === 0) return { migrated: 0, skipped: 0 };

  let migrated = 0;
  let skipped = 0;
  for (const row of oldRows) {
    const toId = row.targetPersonaId ?? 0;
    const toName = row.targetName ?? "";
    if (!toName && toId === 0) continue;
    // 已存在同键 active 行（新图已有更准数据）→ 跳过
    const existing: any[] = await db
      .select({ id: personaRelations.id })
      .from(personaRelations)
      .where(
        and(
          eq(personaRelations.fromPersonaId, row.personaId),
          eq(personaRelations.toPersonaId, toId),
          eq(personaRelations.layer, "vale"),
          eq(personaRelations.status, "active"),
        ),
      )
      .limit(1);
    if (existing.length > 0) {
      skipped++;
      continue;
    }
    const affinity = Number(row.affinity ?? 0);
    const trust = Number(row.trust ?? 50);
    const res = await writeRelationRow({
      fromPersonaId: row.personaId,
      toPersonaId: toId,
      toName: toName || null,
      layer: "vale",
      kind: "unspecified",
      form: "EM",
      positivity: affinity > 0 ? affinity : 0,
      negativity: affinity < 0 ? -affinity : 0,
      trust,
      basis: row.note ? String(row.note).slice(0, 300) : "旧关系表迁移",
      sourceRef: "legacy-migration",
      actor: "migrateLegacyRelations",
      originModule: "migration",
      reasonKind: "migration",
      overwrite: false,
    });
    if (res.ok) migrated++;
    else skipped++;
  }
  return { migrated, skipped };
}
