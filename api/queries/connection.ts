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
import { SQLITE_DDL, SQLITE_DDL_0001, SQLITE_DDL_0002, SQLITE_DDL_0003, SQLITE_DDL_0004, SQLITE_DDL_0005 } from "@db/sqlite-ddl";

let instance: unknown;

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
  raw.exec("PRAGMA journal_mode = WAL;");
  raw.exec("PRAGMA busy_timeout = 5000;");
  // 首次建库 + 增量升级（幂等）：users 缺失 → 全量 DDL；
  // 老库逐级补齐：library_docs 缺失 → 0001；personas 缺失 → 0002（级联执行，不互斥）
  const hasUsers = raw
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'")
    .get();
  if (!hasUsers) {
    raw.exec(SQLITE_DDL);
  } else {
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

// 仅供测试/诊断：重置单例（换库路径时）
export function __resetDbForTest() {
  instance = undefined;
}
