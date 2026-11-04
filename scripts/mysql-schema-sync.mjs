#!/usr/bin/env node
// ============================================================
// MySQL/TiDB schema 同步 CLI（P0-10）：把 db/schema.mysql.ts 的可复现 DDL 应用到目标库
// ------------------------------------------------------------
// 用法（便携 Node 22.12；脚本会自动带 --experimental-strip-types 重新拉起自己）：
//   node scripts/mysql-schema-sync.mjs --database werewolf_schema_check --create-database --twice --log tmp/mysql-ddl-verify.log
//   node scripts/mysql-schema-sync.mjs --check --database werewolf            # 只检查漂移，不写库
//   node scripts/mysql-schema-sync.mjs --print > tmp/mysql-schema.sql         # 离线导出（空库引导 SQL + 迁移计划）
//
// 设计（审计 P0-10）：
//  - 逐表 / 逐列 / 逐索引 information_schema 预检；只补缺失，不删未知列（不毁数据）；
//  - 人工约束层（见 db/mysql-ddl.ts）：persona_relations「仅 active 唯一」生成列 + 唯一索引、
//    persona_aliases / persona_nickname_index 按人格唯一、旧索引 idx_rel_dyad/idx_alias_uniq/idx_nni_text 清理；
//  - 校验：关键表/列/索引断言 + 结构指纹；--twice 自证第二次执行计划为空（幂等）。
// ============================================================
import { appendFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Node 22.12 的 TS 类型剥离：脚本是 .mjs，但复用 db/mysql-ddl.ts（单一事实源）
const neededFlag = "--experimental-strip-types";
if (!process.execArgv.includes(neededFlag) && !process.env.WW_MYSQL_SYNC_TS) {
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync(process.execPath, [neededFlag, "--no-warnings", ...process.argv.slice(1)], {
    stdio: "inherit",
    env: { ...process.env, WW_MYSQL_SYNC_TS: "1" },
  });
  process.exit(r.status ?? 1);
}

const mysql = (await import("mysql2/promise")).default;
const ddl = await import(
  pathToFileURL(resolve(process.cwd(), "db/mysql-ddl.ts")).href
);

// ------------------------------------------------------------
// 参数
// ------------------------------------------------------------
const DEFAULTS = {
  host: "127.0.0.1",
  port: 3307,
  user: "root",
  // 密码只从环境变量或显式参数读取，不在公开源码中提供默认口令。
  password: process.env.DB_PASSWORD ?? "",
  database: "werewolf",
};

function parseArgs(argv) {
  const opts = { ...DEFAULTS, createDatabase: false, dryRun: false, check: false, print: false, twice: false, quiet: false, log: null, help: false, createIfMissingData: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const [flag, inline] = arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    const take = () => (inline !== undefined ? inline : argv[++i]);
    switch (flag) {
      case "--database": case "-d": opts.database = take(); break;
      case "--host": opts.host = take(); break;
      case "--port": opts.port = Number(take()); break;
      case "--user": opts.user = take(); break;
      case "--password": case "-p": opts.password = take(); break;
      case "--url": opts.url = take(); break;
      case "--create-database": opts.createDatabase = true; break;
      case "--no-create-database": opts.createDatabase = false; break;
      case "--dry-run": opts.dryRun = true; break;
      case "--check": opts.check = true; break;
      case "--print": opts.print = true; break;
      case "--twice": opts.twice = true; break;
      case "--quiet": opts.quiet = true; break;
      case "--log": opts.log = take(); break;
      case "--help": case "-h": opts.help = true; break;
      default:
        console.error(`[mysql-schema-sync] unknown argument: ${arg}`);
        process.exit(2);
    }
  }
  if (opts.url) {
    try {
      const u = new URL(opts.url);
      if (u.protocol !== "mysql:") throw new Error("url protocol must be mysql:");
      opts.host = u.hostname || opts.host;
      opts.port = u.port ? Number(u.port) : opts.port;
      opts.user = decodeURIComponent(u.username || opts.user);
      opts.password = decodeURIComponent(u.password || opts.password);
      if (u.pathname && u.pathname !== "/") opts.database = decodeURIComponent(u.pathname.slice(1));
    } catch (e) {
      console.error(`[mysql-schema-sync] bad --url: ${e.message}`);
      process.exit(2);
    }
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));

if (opts.help) {
  console.log(
    [
      "mysql-schema-sync — 把 db/schema.mysql.ts 的可复现 DDL 同步到 MySQL/TiDB",
      "",
      "  node scripts/mysql-schema-sync.mjs [options]",
      "",
      "options:",
      "  --database <name>      目标库（默认 werewolf）",
      "  --host/--port/--user/--password/--url  连接参数（默认 127.0.0.1:3307 root；密码由 DB_PASSWORD 或参数提供）",
      "  --create-database      目标库不存在时创建",
      "  --check                只检查漂移（不写库）；有漂移/关键项缺失则退出码 1",
      "  --dry-run              打印执行计划但不写库",
      "  --print                离线输出空库引导 SQL + 迁移计划（不连数据库）",
      "  --twice                应用后再次计算计划并断言为空（幂等自证）",
      "  --log <path>           追加写入日志文件（ASCII）",
      "  --quiet                只输出错误与最终结论",
    ].join("\n"),
  );
  process.exit(0);
}

// ------------------------------------------------------------
// 日志
// ------------------------------------------------------------
const logLines = [];
function out(line = "") {
  logLines.push(line);
  if (!opts.quiet) console.log(line);
}
function log(line) {
  logLines.push(line);
}
function flushLog() {
  if (!opts.log) return;
  try {
    const file = resolve(process.cwd(), opts.log);
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, logLines.join("\n") + "\n", "utf8");
  } catch (e) {
    console.error(`[mysql-schema-sync] cannot write log: ${e.message}`);
  }
}

// ------------------------------------------------------------
// manifest（离线模式直接可用）
// ------------------------------------------------------------
const manifest = ddl.buildMysqlManifest();
out(`[manifest] tables=${manifest.stats.tables} columns=${manifest.stats.columns} indexes=${manifest.stats.indexes} generated_columns=${manifest.stats.generatedColumns}`);
out(`[manifest] fingerprint=${manifest.fingerprint}`);

if (opts.print) {
  out("");
  out("-- ============ 空库引导（CREATE TABLE IF NOT EXISTS） ============");
  out(ddl.renderBootstrapSql(manifest));
  // 迁移计划需要现状快照；离线 print 时给出"空库视角"的补充说明
  out("-- ============ 已有旧库迁移 ============");
  out("-- 已有库请运行：node scripts/mysql-schema-sync.mjs --database <db> [--log <path>]");
  out("-- 迁移按 information_schema 逐表/列/索引预检，只补缺失（见 db/mysql-ddl.ts::planMysqlSync）。");
  flushLog();
  process.exit(0);
}

// ------------------------------------------------------------
// 数据库连接
// ------------------------------------------------------------
async function connect() {
  const base = {
    host: opts.host,
    port: opts.port,
    user: opts.user,
    password: opts.password,
    multipleStatements: false,
    charset: "utf8mb4",
  };
  let conn;
  try {
    conn = await mysql.createConnection({ ...base, database: opts.database });
    out(`[connect] ${opts.user}@${opts.host}:${opts.port}/${opts.database}`);
    return conn;
  } catch (e) {
    if (e.code !== "ER_BAD_DB_ERROR") throw e;
    if (!opts.createDatabase) {
      throw new Error(`数据库 ${opts.database} 不存在；加 --create-database 或先创建`);
    }
    const boot = await mysql.createConnection(base);
    try {
      await boot.query(`CREATE DATABASE IF NOT EXISTS \`${opts.database.replace(/`/g, "``")}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
      out(`[create] database ${opts.database} (utf8mb4)`);
    } finally {
      await boot.end();
    }
    conn = await mysql.createConnection({ ...base, database: opts.database });
    out(`[connect] ${opts.user}@${opts.host}:${opts.port}/${opts.database}`);
    return conn;
  }
}

// ------------------------------------------------------------
// information_schema 快照
// ------------------------------------------------------------
async function readSnapshot(conn) {
  const db = opts.database;
  const [tableRows] = await conn.query(
    "SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'",
    [db],
  );
  const [columnRows] = await conn.query(
    "SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION",
    [db],
  );
  const [indexRows] = await conn.query(
    "SELECT TABLE_NAME AS t, INDEX_NAME AS i, NON_UNIQUE AS nu, SEQ_IN_INDEX AS seq, COLUMN_NAME AS c, EXPRESSION AS expr FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX",
    [db],
  );
  const tables = {};
  for (const row of tableRows) tables[row.t] = { columns: [], indexes: [], primaryKey: [] };
  for (const row of columnRows) {
    if (tables[row.t]) tables[row.t].columns.push(row.c);
  }
  const indexMap = new Map();
  for (const row of indexRows) {
    if (!tables[row.t]) continue;
    if (row.i === "PRIMARY") {
      tables[row.t].primaryKey.push(row.c ?? row.expr ?? "");
      continue;
    }
    const key = `${row.t}.${row.i}`;
    if (!indexMap.has(key)) {
      indexMap.set(key, { t: row.t, name: row.i, unique: row.nu === 0, columns: [] });
    }
    const idx = indexMap.get(key);
    idx.columns.push(row.c ?? row.expr ?? "");
  }
  for (const idx of indexMap.values()) tables[idx.t]?.indexes.push({ name: idx.name, unique: idx.unique, columns: idx.columns });
  return { tables };
}

/** 与 manifest.fingerprint 同构的结构指纹（表名 + 列名 + 主键 + 索引名/唯一性/列；不含类型方言） */
function structuralFingerprintOf(snapshot) {
  const normalized = Object.entries(snapshot.tables)
    .map(([name, t]) => ({
      t: name,
      c: [...t.columns].sort(),
      k: t.primaryKey ?? [],
      i: [...t.indexes].map((i) => ({ n: i.name, u: i.unique, c: i.columns })).sort((a, b) => a.n.localeCompare(b.n)),
    }))
    .sort((a, b) => a.t.localeCompare(b.t));
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex").slice(0, 16);
}

// ------------------------------------------------------------
// 执行
// ------------------------------------------------------------
async function executeStatements(conn, statements) {
  let ok = 0;
  const failures = [];
  for (const sql of statements) {
    try {
      await conn.query(sql);
      ok++;
    } catch (e) {
      failures.push({ sql, error: e.message, code: e.code });
      out(`[error] ${e.code ?? ""} ${e.message}`);
      out(`        SQL: ${sql.replace(/\s+/g, " ").slice(0, 220)}`);
    }
  }
  return { ok, failures };
}

function printPlanSummary(plan) {
  out(
    `[plan] create_tables=${plan.createTables.length} add_columns=${plan.addColumns.length} `
    + `add_indexes=${plan.addIndexes.length} drop_indexes=${plan.dropIndexes.length} pre_statements=${plan.preStatements.length}`,
  );
  for (const t of plan.createTables) out(`[plan] + table ${t.name}`);
  for (const c of plan.addColumns) out(`[plan] + column ${c.table}.${c.column.name} ${c.column.sqlType}${c.column.generatedAs ? " (generated)" : ""}`);
  for (const i of plan.addIndexes) out(`[plan] + ${i.index.unique ? "unique " : ""}index ${i.table}.${i.index.name} (${i.index.columns.join(",")})${i.existsWithOtherDefinition ? " [replace]" : ""}`);
  for (const d of plan.dropIndexes) out(`[plan] - index ${d.table}.${d.name}`);
  for (const w of plan.warnings) log(`[warn] ${w}`);
}

function verify(conn, snapshot) {
  const check = ddl.checkRequiredSchema(snapshot);
  for (const p of check.passed) log(`[verify] OK ${p}`);
  for (const f of check.failures) out(`[verify] FAIL ${f}`);
  const tableCount = Object.keys(snapshot.tables).length;
  const expected = manifest.stats.tables;
  const countOk = tableCount >= Math.min(43, expected);
  const dbFingerprint = structuralFingerprintOf(snapshot);
  const fingerprintMatch = dbFingerprint === manifest.fingerprint;
  out(`[verify] base_tables=${tableCount} expected=${expected} (>=43: ${tableCount >= 43 ? "OK" : "FAIL"})`);
  out(`[verify] required_checks=${check.passed.length}/${check.passed.length + check.failures.length} ${check.ok ? "OK" : "FAILED"}`);
  out(`[verify] schema_fingerprint db=${dbFingerprint} manifest=${manifest.fingerprint} match=${fingerprintMatch ? "YES" : "NO(旧库有存量差异属正常)"}`);
  return check.ok && countOk;
}

// ------------------------------------------------------------
// 主流程
// ------------------------------------------------------------
let conn;
try {
  conn = await connect();

  const before = await readSnapshot(conn);
  const plan = ddl.planMysqlSync(manifest, before);
  printPlanSummary(plan);

  if (opts.check) {
    const ok = verify(conn, before);
    const driftOk = ddl.isPlanEmpty(plan);
    out(`[check] drift=${driftOk ? "NONE" : "FOUND"} required=${ok ? "OK" : "FAILED"}`);
    await conn.end();
    flushLog();
    process.exit(driftOk && ok ? 0 : 1);
  }

  if (opts.dryRun) {
    out("[dry-run] statements that would run:");
    for (const sql of ddl.renderPlanSql(plan)) out(sql.replace(/\s+/g, " "));
    await conn.end();
    flushLog();
    out("[dry-run] no changes applied");
    process.exit(0);
  }

  const statements = ddl.renderPlanSql(plan);
  if (statements.length > 0) {
    out(`[apply] executing ${statements.length} statement(s) ...`);
    const { ok, failures } = await executeStatements(conn, statements);
    out(`[apply] ok=${ok} failed=${failures.length}`);
    if (failures.length > 0) {
      await conn.end();
      flushLog();
      process.exit(1);
    }
  } else {
    out("[apply] plan empty — schema already up to date");
  }

  const after = await readSnapshot(conn);
  const verifyOk = verify(conn, after);

  let idempotent = true;
  if (opts.twice) {
    const secondPlan = ddl.planMysqlSync(manifest, after);
    idempotent = ddl.isPlanEmpty(secondPlan);
    printPlanSummary(secondPlan);
    out(`[twice] second_run_plan_empty=${idempotent ? "YES (idempotent OK)" : "NO (NOT IDEMPOTENT)"}`);
  }

  await conn.end();
  flushLog();
  const success = verifyOk && idempotent;
  out(`[result] ${success ? "SUCCESS" : "FAILED"}`);
  process.exit(success ? 0 : 1);
} catch (e) {
  out(`[fatal] ${e.code ? e.code + " " : ""}${e.message}`);
  try {
    if (conn) await conn.end();
  } catch {
    /* ignore */
  }
  flushLog();
  process.exit(1);
}
