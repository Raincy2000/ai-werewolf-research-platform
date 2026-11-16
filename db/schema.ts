// 方言调度层：按 DB_DIALECT 在 MySQL（云端/本地开发库）与 SQLite（桌面客户端）之间
// 选择同一套表对象（表名/列名两方言严格一致，见 schema.sqlite.ts 头部注释）。
// 类型出口固定取 MySQL 侧（两方言行结构相同），运行时值按方言切换。
// 注意：依赖 DB_DIALECT 的读取发生在模块加载期，调用方须先完成 env 加载（api/lib/env）。
import * as mysqlSchema from "./schema.mysql";
import * as sqliteSchema from "./schema.sqlite";

const picked = process.env.DB_DIALECT === "sqlite" ? sqliteSchema : mysqlSchema;

export const games = picked.games as typeof mysqlSchema.games;
export const gameDecisions = picked.gameDecisions as typeof mysqlSchema.gameDecisions;
export const gameEvents = picked.gameEvents as typeof mysqlSchema.gameEvents;
export const gameWinrates = picked.gameWinrates as typeof mysqlSchema.gameWinrates;
export const guideVersions = picked.guideVersions as typeof mysqlSchema.guideVersions;
export const gameAnalyses = picked.gameAnalyses as typeof mysqlSchema.gameAnalyses;
export const apiPresets = picked.apiPresets as typeof mysqlSchema.apiPresets;
export const users = picked.users as typeof mysqlSchema.users;
export const sessions = picked.sessions as typeof mysqlSchema.sessions;
export const libraryDocs = picked.libraryDocs as typeof mysqlSchema.libraryDocs;
export const gameStudies = picked.gameStudies as typeof mysqlSchema.gameStudies;
export const personas = picked.personas as typeof mysqlSchema.personas;
export const personaMemories = picked.personaMemories as typeof mysqlSchema.personaMemories;
export const personaRelationships =
  picked.personaRelationships as typeof mysqlSchema.personaRelationships;
export const personaCastCheckpoints =
  picked.personaCastCheckpoints as typeof mysqlSchema.personaCastCheckpoints;
export const personaCognitionNotes =
  picked.personaCognitionNotes as typeof mysqlSchema.personaCognitionNotes;
export const personaCastDrafts =
  picked.personaCastDrafts as typeof mysqlSchema.personaCastDrafts;
export const personaRelationshipHistory =
  picked.personaRelationshipHistory as typeof mysqlSchema.personaRelationshipHistory;
export const personaDriftLog = picked.personaDriftLog as typeof mysqlSchema.personaDriftLog;
export const personaMemoryEvidence = picked.personaMemoryEvidence as typeof mysqlSchema.personaMemoryEvidence;
export const personaReports = picked.personaReports as typeof mysqlSchema.personaReports;

export type { GameRow, GameEventRow, UserRow, SessionRow } from "./schema.mysql";

// ===== v3 新表（场次 / 情境 / 角色 / 观测 / 台账 / 调制日志）=====
export const scenarios = picked.scenarios as typeof mysqlSchema.scenarios;
export const scenarioEvents = picked.scenarioEvents as typeof mysqlSchema.scenarioEvents;
export const situationClasses = picked.situationClasses as typeof mysqlSchema.situationClasses;
export const roleEnrollments = picked.roleEnrollments as typeof mysqlSchema.roleEnrollments;
export const roleEvents = picked.roleEvents as typeof mysqlSchema.roleEvents;
export const personaStateObservations =
  picked.personaStateObservations as typeof mysqlSchema.personaStateObservations;
export const personaBaselines = picked.personaBaselines as typeof mysqlSchema.personaBaselines;
export const personaPlasticity = picked.personaPlasticity as typeof mysqlSchema.personaPlasticity;
export const personaTraitUpdates =
  picked.personaTraitUpdates as typeof mysqlSchema.personaTraitUpdates;
export const traitDecomposition = picked.traitDecomposition as typeof mysqlSchema.traitDecomposition;
export const personaFidelity = picked.personaFidelity as typeof mysqlSchema.personaFidelity;
export const personaModulationLog =
  picked.personaModulationLog as typeof mysqlSchema.personaModulationLog;

// ===== 人际网（Interpersonal Graph）=====
export const personaAliases = picked.personaAliases as typeof mysqlSchema.personaAliases;
export const personaRelations = picked.personaRelations as typeof mysqlSchema.personaRelations;
export const rsqResponses = picked.rsqResponses as typeof mysqlSchema.rsqResponses;
export const personaCanonLog = picked.personaCanonLog as typeof mysqlSchema.personaCanonLog;
export const canonBackfillJobs = picked.canonBackfillJobs as typeof mysqlSchema.canonBackfillJobs;
export const personaWritebackRuns = picked.personaWritebackRuns as typeof mysqlSchema.personaWritebackRuns;
export const relationDeltas = picked.relationDeltas as typeof mysqlSchema.relationDeltas;
export const relationCompletionJobs =
  picked.relationCompletionJobs as typeof mysqlSchema.relationCompletionJobs;
export const relationCompletionItems =
  picked.relationCompletionItems as typeof mysqlSchema.relationCompletionItems;

export const perceivedDyadRelations =
  picked.perceivedDyadRelations as typeof mysqlSchema.perceivedDyadRelations;
export const personaNicknameIndex =
  picked.personaNicknameIndex as typeof mysqlSchema.personaNicknameIndex;
export const invocationLog = picked.invocationLog as typeof mysqlSchema.invocationLog;
