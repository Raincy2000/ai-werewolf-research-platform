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
export const personaDriftLog = picked.personaDriftLog as typeof mysqlSchema.personaDriftLog;
export const personaReports = picked.personaReports as typeof mysqlSchema.personaReports;

export type { GameRow, GameEventRow, UserRow, SessionRow } from "./schema.mysql";
