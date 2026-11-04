// ============================================================
// 关系网模块（人际域，平级于人格卡，§28）
// L2 仓储（只读）+ L3 双收口 + 租户守卫
//
// 2026-10-22 审计修复：不再 `export * from "./repo/relationRepo"` / writeModel——
// 裸写函数不得对外暴露，所有写入必须经 api/network/writeModel.ts 的收口函数。
// ============================================================
export * from "./readModel";
export * from "./guards";
export {
  writeRelationChange,
  writeRelationBatch,
  writeRelationRow,
  writeRelationRows,
  correctRelation,
  applyRelationDelta,
  applyRelationColumns,
  clampRelationValue,
} from "./writeModel";
export type { RelationChangeInput, RelationRowInput, WriteResult } from "./writeModel";
export {
  listRelations,
  listOutgoing,
  listIncoming,
  listDyad,
  listDangling,
  listDanglingByNames,
  relationCounts,
  toRelationRow,
} from "./repo/relationRepo";
export * from "./repo/perceptionRepo";
export * from "./repo/invocationRepo";
