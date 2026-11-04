// 数据库连接：双方言单例
// - mysql（默认）：TiDB/本地 MySQL，drizzle mysql2（mode planetscale）
// - sqlite（DB_DIALECT=sqlite，桌面客户端）：node:sqlite（Node 内置，零原生依赖）
//   经 drizzle sqlite-proxy 驱动；首次连接自动执行建库 DDL（幂等）
// 返回类型统一为 any：两方言数据库类型不同，查询层 API 面一致（见 schema.ts 调度层注释）。
import { drizzle } from "drizzle-orm/mysql2";
import { drizzle as drizzleSqlite } from "drizzle-orm/sqlite-proxy";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { env } from "../lib/env";
import * as mysqlSchema from "@db/schema.mysql";
import * as sqliteSchema from "@db/schema.sqlite";
import { SQLITE_DDL, SQLITE_DDL_0001, SQLITE_DDL_0002, SQLITE_DDL_0003, SQLITE_DDL_0004, SQLITE_DDL_0005, SQLITE_DDL_0006, SQLITE_DDL_0007, SQLITE_DDL_0008, SQLITE_DDL_0009, SQLITE_DDL_0010, SQLITE_DDL_0011, SQLITE_DDL_0012, SQLITE_DDL_0013, SQLITE_DDL_0014, SQLITE_DDL_0015, SQLITE_DDL_0016, SQLITE_DDL_0017, SQLITE_DDL_0018, SQLITE_DDL_0019, SQLITE_DDL_0020, SQLITE_DDL_0021, SQLITE_DDL_0022, SQLITE_DDL_0100, SQLITE_DDL_0101, SQLITE_DDL_0102, SQLITE_DDL_0103, SQLITE_DDL_0104, SQLITE_DDL_0105, SQLITE_DDL_0106, SQLITE_DDL_0107, SQLITE_DDL_0108, SQLITE_DDL_0109, SQLITE_DDL_0110 } from "@db/sqlite-ddl";

let instance: unknown;
/** 底层 SQLite 连接（仅测试/诊断用；MySQL 方言下为 null） */
let rawSqliteInstance: any = null;

function createMysqlDb() {
  const fullSchema = { ...mysqlSchema };
  return drizzle(env.databaseUrl, {
    mode: "planetscale",
    schema: fullSchema,
  });
}

function createSqliteDb(dbPath: string) {
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const raw = new DatabaseSync(dbPath);
  rawSqliteInstance = raw;
  raw.exec("PRAGMA journal_mode = WAL;");
  raw.exec("PRAGMA busy_timeout = 5000;");
  // 首次建库 + 增量升级（幂等）：users 缺失 → 全量 DDL；
  // 老库逐级补齐：library_docs 缺失 → 0001；personas 缺失 → 0002（级联执行，不互斥）
  const hasUsers = raw
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'")
    .get();
  if (!hasUsers) {
    raw.exec(SQLITE_DDL);
  }
  // ★ 增量迁移无条件执行：每个块都有自己的幂等检查（pragma_table_info / sqlite_master），
  //   对新建库而言基础 DDL 已含旧表 → 旧增量自动跳过；只有晚于 SQLITE_DDL 的增量会真正执行。
  //   历史事故：曾把增量放在 else 分支里，导致内存库（测试）永远拿不到新列。
  {
    const hasLibrary = raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='library_docs'")
      .get();
    if (!hasLibrary) {
      raw.exec(SQLITE_DDL_0001);
    }
    const hasPersonas = raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='personas'")
      .get();
    if (!hasPersonas) {
      raw.exec(SQLITE_DDL_0002);
    }
    const hasTitleNo = raw
      .prepare("SELECT 1 FROM pragma_table_info('games') WHERE name='title_no'")
      .get();
    if (!hasTitleNo) {
      raw.exec(SQLITE_DDL_0003);
    }
    const hasPersonaImage = raw
      .prepare("SELECT 1 FROM pragma_table_info('personas') WHERE name='image_data'")
      .get();
    if (!hasPersonaImage) {
      raw.exec(SQLITE_DDL_0004);
    }
    const hasPersonaDeletedAt = raw
      .prepare("SELECT 1 FROM pragma_table_info('personas') WHERE name='deleted_at'")
      .get();
    if (!hasPersonaDeletedAt) {
      raw.exec(SQLITE_DDL_0005);
    }
    const hasRelHistory = raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='persona_relationship_history'")
      .get();
    if (!hasRelHistory) {
      raw.exec(SQLITE_DDL_0006);
    }
    const hasRelBackfill = raw
      .prepare("SELECT 1 FROM pragma_table_info('persona_relationship_history') WHERE name='backfill'")
      .get();
    if (!hasRelBackfill) {
      raw.exec(SQLITE_DDL_0007);
    }
    const hasCastDrafts = raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='persona_cast_drafts'")
      .get();
    if (!hasCastDrafts) {
      raw.exec(SQLITE_DDL_0008);
    }
    const hasCogNotes = raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='persona_cognition_notes'")
      .get();
    if (!hasCogNotes) {
      raw.exec(SQLITE_DDL_0009);
    }
    const hasAutoCog = raw
      .prepare("SELECT 1 FROM pragma_table_info('personas') WHERE name='auto_cognition'")
      .get();
    if (!hasAutoCog) {
      raw.exec(SQLITE_DDL_0010);
    }
    const hasCastCkpt = raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='persona_cast_checkpoints'")
      .get();
    if (!hasCastCkpt) {
      raw.exec(SQLITE_DDL_0011);
    }
    const hasDraftStatus = raw
      .prepare("SELECT 1 FROM pragma_table_info('persona_cast_drafts') WHERE name='status'")
      .get();
    if (!hasDraftStatus) {
      raw.exec(SQLITE_DDL_0012);
    }
    const hasMemoryValence = raw
      .prepare("SELECT 1 FROM pragma_table_info('persona_memories') WHERE name='valence'")
      .get();
    if (!hasMemoryValence) {
      raw.exec(SQLITE_DDL_0013);
    }
    // ---- v3：记忆库扩展（情境签名 / 来源 / 生命周期） ----
    const hasMemExt = raw
      .prepare("SELECT 1 FROM pragma_table_info('persona_memories') WHERE name='formula_version'")
      .get();
    if (!hasMemExt) {
      raw.exec(SQLITE_DDL_0014);
    }
    // ---- v3：铸造基线快照 ----
    const hasBaseline = raw
      .prepare("SELECT 1 FROM pragma_table_info('personas') WHERE name='params_baseline'")
      .get();
    if (!hasBaseline) {
      raw.exec(SQLITE_DDL_0015);
    }
    // ---- v3：漂移年代标记 ----
    const hasEra = raw
      .prepare("SELECT 1 FROM pragma_table_info('persona_drift_log') WHERE name='era'")
      .get();
    if (!hasEra) {
      raw.exec(SQLITE_DDL_0016);
    }
    // ---- v3：场次统一层与新表（注意：绝不建 sessions，该名已被登录表占用） ----
    // ---- v3：人格演化小数累积器（EWMA 微小位移的落账缓冲） ----
    const hasResidual = raw
      .prepare("SELECT 1 FROM pragma_table_info('personas') WHERE name='params_residual'")
      .get();
    if (!hasResidual) {
      raw.exec(SQLITE_DDL_0018);
    }
    // ---- v3：观测方向 + 去重索引（φ 统计基础） ----
    const hasObsDir = raw
      .prepare("SELECT 1 FROM pragma_table_info('persona_state_observations') WHERE name='direction'")
      .get();
    if (!hasObsDir) {
      raw.exec(SQLITE_DDL_0019);
    }
    // ---- 人际网（Interpersonal Graph）：5 表 + personas 2 列 ----
    const hasRelGraph = raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='persona_relations'")
      .get();
    if (!hasRelGraph) {
      raw.exec(SQLITE_DDL_0020);
    }
    const hasAddressTerm = raw
      .prepare("SELECT 1 FROM pragma_table_info('persona_relations') WHERE name='address_term'")
      .get();
    if (!hasAddressTerm) {
      raw.exec(SQLITE_DDL_0021);
    }
    const hasToName = raw
      .prepare("SELECT 1 FROM pragma_table_info('persona_relations') WHERE name='to_name'")
      .get();
    if (!hasToName) {
      raw.exec(SQLITE_DDL_0022);
    }
    // ---- 人格研究站 L0 重置（§26）：一阶关系 7 列 + 二阶认知/昵称索引/调用台账 ----
    const hasL0Reset = raw
      .prepare("SELECT 1 FROM pragma_table_info('persona_relations') WHERE name='form'")
      .get();
    if (!hasL0Reset) {
      raw.exec(SQLITE_DDL_0100);
    }
    // ---- 关系自陈问卷 RSQ（§43）：responses 表 + persona_relations 11 列 ----
    const hasRsq = raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='rsq_responses'")
      .get();
    if (!hasRsq) {
      raw.exec(SQLITE_DDL_0101);
    }
    const hasSelfSummary = raw
      .prepare("SELECT 1 FROM pragma_table_info('rsq_responses') WHERE name='self_summary'")
      .get();
    if (!hasSelfSummary) {
      raw.exec(SQLITE_DDL_0102);
    }
    // ---- 现实层（L1）：单视角关系记忆 + 补完台账 ----
    const hasCanonLog = raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='persona_canon_log'")
      .get();
    if (!hasCanonLog) {
      raw.exec(SQLITE_DDL_0103);
    }
    const hasCanonVerify = raw
      .prepare("SELECT 1 FROM pragma_table_info('persona_canon_log') WHERE name='verification'")
      .get();
    if (!hasCanonVerify) {
      raw.exec(SQLITE_DDL_0104);
    }
    // 现实层：阶段概念彻底删除，时间轴改为 时间 + 年龄 + 地点
    const hasCanonAge = raw
      .prepare("SELECT 1 FROM pragma_table_info('persona_canon_log') WHERE name='age'")
      .get();
    if (!hasCanonAge) {
      raw.exec(SQLITE_DDL_0105);
    }
    const hasEraBasis = raw
      .prepare("SELECT 1 FROM pragma_table_info('persona_canon_log') WHERE name='era_basis'")
      .get();
    if (!hasEraBasis) {
      raw.exec(SQLITE_DDL_0106);
    }
    // ---- 2026-10-22：canon 补完任务统计列（表由 0103 保证存在）----
    const cbjExists = raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='canon_backfill_jobs'")
      .get();
    const hasCbjStats = cbjExists
      ? raw.prepare("SELECT 1 FROM pragma_table_info('canon_backfill_jobs') WHERE name='stats'").get()
      : null;
    if (cbjExists && !hasCbjStats) {
      raw.exec(SQLITE_DDL_0107);
    }
    // ---- 2026-10-22：记事簿回写幂等台账 ----
    const hasWritebackRuns = raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='persona_writeback_runs'")
      .get();
    if (!hasWritebackRuns) {
      raw.exec(SQLITE_DDL_0108);
    }
    // ---- 2026-10-22：关系唯一键修正（partial unique）+ 别名/昵称按人格唯一 ----
    const hasRelActiveIdx = raw
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_rel_active'")
      .get();
    if (!hasRelActiveIdx) {
      raw.exec(SQLITE_DDL_0109);
    }
    // ---- 2026-10-22：现实层事件手动排序位（详情页拖动排序）----
    const hasCanonSort = raw
      .prepare("SELECT 1 FROM pragma_table_info('persona_canon_log') WHERE name='sort_order'")
      .get();
    if (!hasCanonSort) {
      raw.exec(SQLITE_DDL_0110);
    }
    const hasScenarios = raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='scenarios'")
      .get();
    if (!hasScenarios) {
      raw.exec(SQLITE_DDL_0017);
    }
  }
  const executor = async (
    sql: string,
    params: unknown[],
    method: "run" | "all" | "values" | "get",
  ): Promise<{ rows: unknown[] }> => {
    // node:sqlite 绑定参数不接受 undefined/boolean：归一为 null/1|0
    const bound = params.map((p) =>
      p === undefined ? null : typeof p === "boolean" ? (p ? 1 : 0) : (p as never),
    );
    const stmt = raw.prepare(sql);
    if (method === "run") {
      stmt.run(...bound);
      return { rows: [] };
    }
    // sqlite-proxy 的 all/get/values 均按「位置数组」映射行（非对象），
    // 查询均为单表显式列（无重名列），Object.values 顺序即 SELECT 列序
    if (method === "get") {
      const row = stmt.get(...bound) as Record<string, unknown> | undefined;
      return { rows: row ? [Object.values(row)] : [] };
    }
    const rows = (stmt.all(...bound) as Record<string, unknown>[]).map((r) => Object.values(r));
    return { rows };
  };
  return drizzleSqlite(executor, { schema: sqliteSchema as never });
}

export function getDb(): any {
  if (!instance) {
    instance = env.dbDialect === "sqlite" ? createSqliteDb(env.sqlitePath) : createMysqlDb();
  }
  return instance;
}

/** 测试/诊断用：取底层 node:sqlite 连接（仅 sqlite 方言；生产代码勿用） */
export function __rawSqliteForTest(): any {
  if (env.dbDialect !== "sqlite") throw new Error("__rawSqliteForTest 仅支持 sqlite 方言");
  getDb();
  return rawSqliteInstance;
}

// 仅供测试/诊断：重置单例（换库路径时）
export function __resetDbForTest() {
  instance = undefined;
}
