// ============================================================
// MySQL/TiDB DDL 生成器（P0-10）：单一事实源 = db/schema.mysql.ts（2026-10-22 冻结）
// ------------------------------------------------------------
// 目标：把 drizzle 的 MySQL schema 变成**可复现、幂等、可验证**的 DDL：
//   1. 逐表生成 CREATE TABLE IF NOT EXISTS（空库直接可用）；
//   2. 对已有旧库（db/migrations 时代 16 张表）逐列/逐索引补差（information_schema 预检）；
//   3. 叠加 MySQL 方言无法用 drizzle 表达的**人工约束层**（见 TABLE_OVERRIDES）：
//      - persona_relations：「仅 active 唯一」用 STORED 生成列 + 唯一索引（partial unique 的 MySQL 等价）；
//      - persona_aliases：旧全局唯一 idx_alias_uniq → 按人格唯一 (persona_id, alias)；
//      - persona_nickname_index：旧全局唯一 idx_nni_text → 按人格唯一 (persona_id, text)；
//      - 旧索引 idx_rel_dyad / idx_alias_uniq / idx_nni_text 若存在则 drop。
//
// 纯函数、零 I/O：数据库连接与执行在 scripts/mysql-schema-sync.mjs。
// schema 冻结规则：本文件不手写任何表的列清单；除 TABLE_OVERRIDES 外一律从 schema.mysql.ts 推导。
// ============================================================
import { createHash } from "node:crypto";
import { getTableConfig, type MySqlColumn, type MySqlTable } from "drizzle-orm/mysql-core";
import * as schema from "./schema.mysql.ts";

// ------------------------------------------------------------
// 类型
// ------------------------------------------------------------

/** 列定义（从 drizzle 列推导；generated 列来自人工约束层） */
export interface MysqlColumnDef {
  name: string;
  /** 已渲染的 MySQL 类型，如 varchar(36) / int / timestamp / json */
  sqlType: string;
  notNull: boolean;
  primary: boolean;
  autoIncrement: boolean;
  /** 已渲染的 DEFAULT 子句内容（null = 无默认值） */
  defaultSql: string | null;
  /** ON UPDATE 子句内容（timestamp 专用，null = 无） */
  onUpdateSql: string | null;
  /** STORED/VIRTUAL 生成列表达式（null = 普通列） */
  generatedAs: string | null;
  generatedStored: boolean;
}

export interface MysqlIndexDef {
  name: string;
  unique: boolean;
  /** 索引列（普通列名；表达式索引渲染为 SQL 片段） */
  columns: string[];
}

export interface MysqlTableDef {
  name: string;
  columns: MysqlColumnDef[];
  primaryKey: string[];
  indexes: MysqlIndexDef[];
  /** 旧索引名：若库中存在则删除（只列"需要删"的历史索引，不删未知索引） */
  dropLegacyIndexes: string[];
  /** 建索引前的幂等数据整理语句（如 active 去重） */
  preIndexStatements: string[];
}

export interface MysqlSchemaManifest {
  tables: MysqlTableDef[];
  /** 结构指纹（表/列/索引名称与唯一性；用于发布前置的 schema 版本核对） */
  fingerprint: string;
  stats: { tables: number; columns: number; indexes: number; generatedColumns: number };
}

/** 数据库现状快照（由 scripts/mysql-schema-sync.mjs 从 information_schema 读取） */
export interface ExistingTableSnapshot {
  columns: string[];
  indexes: Array<{ name: string; unique: boolean; columns: string[] }>;
  /** 主键列（information_schema.STATISTICS 的 PRIMARY 索引） */
  primaryKey?: string[];
}
export interface ExistingSchemaSnapshot {
  tables: Record<string, ExistingTableSnapshot>;
}

/** 同步计划（纯数据，可 dry-run / --check） */
export interface MysqlSyncPlan {
  createTables: MysqlTableDef[];
  addColumns: Array<{ table: string; column: MysqlColumnDef }>;
  addIndexes: Array<{ table: string; index: MysqlIndexDef; existsWithOtherDefinition: boolean }>;
  dropIndexes: Array<{ table: string; name: string }>;
  preStatements: Array<{ table: string; sql: string; forIndex: string }>;
  /** 现有表里存在、但 manifest 不认识的列/索引：只报告，不删除（不毁数据） */
  warnings: string[];
}

// ------------------------------------------------------------
// 人工约束层（MySQL 方言无法用 drizzle 表达的迁移）
// ------------------------------------------------------------

interface TableOverride {
  /** 额外列（生成列等） */
  extraColumns?: MysqlColumnDef[];
  /** 不按 schema 自动生成的索引名（由 extraIndexes / 迁移逻辑接管） */
  skipAutoIndexes?: string[];
  /** 追加索引（与 skipAutoIndexes 配合） */
  extraIndexes?: MysqlIndexDef[];
  /** 历史索引：存在则 drop */
  dropLegacyIndexes?: string[];
  /** 建索引前的幂等数据整理 */
  preIndexStatements?: string[];
}

/** persona_relations：MySQL 无 partial unique index，用 STORED 生成列模拟「仅 active 唯一」。
 *  - active_marker = 1 (active) / NULL (其它)：配合唯一索引，superseded 行可同键多行；
 *  - to_name_key  = IFNULL(to_name,'')：MySQL 唯一索引中的 NULL 互不相等，
 *    若直接用 to_name，正常（非悬空）关系的 to_name=NULL 会让唯一约束失效，故用规范化生成列参与索引。 */
const PERSONA_RELATIONS_DEDUPE_SQL = `UPDATE \`persona_relations\`
SET \`status\` = 'superseded', \`superseded_by\` = NULL
WHERE \`status\` = 'active'
  AND \`id\` NOT IN (
    SELECT \`keep_id\` FROM (
      SELECT MIN(\`id\`) AS \`keep_id\` FROM \`persona_relations\`
      WHERE \`status\` = 'active'
      GROUP BY \`from_persona_id\`, \`to_persona_id\`, IFNULL(\`to_name\`, ''), \`layer\`, \`kind\`
    ) AS \`keep_rows\`
  )`;

const TABLE_OVERRIDES: Readonly<Record<string, TableOverride>> = {
  persona_relations: {
    extraColumns: [
      {
        name: "active_marker",
        sqlType: "tinyint",
        notNull: false,
        primary: false,
        autoIncrement: false,
        defaultSql: null,
        onUpdateSql: null,
        generatedAs: "CASE WHEN `status` = 'active' THEN 1 ELSE NULL END",
        generatedStored: true,
      },
      {
        name: "to_name_key",
        sqlType: "varchar(64)",
        notNull: false,
        primary: false,
        autoIncrement: false,
        defaultSql: null,
        onUpdateSql: null,
        generatedAs: "IFNULL(`to_name`, '')",
        generatedStored: true,
      },
    ],
    // 旧的非唯一 idx_rel_active（schema 里仍是普通索引）由本迁移改为唯一索引
    skipAutoIndexes: ["idx_rel_active"],
    extraIndexes: [
      {
        name: "idx_rel_active",
        unique: true,
        columns: [
          "from_persona_id", "to_persona_id", "to_name_key",
          "layer", "kind", "active_marker",
        ],
      },
    ],
    dropLegacyIndexes: ["idx_rel_dyad"],
    preIndexStatements: [PERSONA_RELATIONS_DEDUPE_SQL],
  },
  persona_aliases: {
    // schema 已声明唯一 (persona_id, alias)；这里只清理旧全局唯一索引
    dropLegacyIndexes: ["idx_alias_uniq"],
  },
  persona_nickname_index: {
    // 2026-10-22 冻结后 schema 已声明 idx_nni_persona_text unique(persona_id, text)；
    // 这里只负责旧库清理：旧唯一键 idx_nni_text(text) 是"全局昵称唯一"，会跨人格冲突
    dropLegacyIndexes: ["idx_nni_text"],
  },
};

// ------------------------------------------------------------
// drizzle 列 → 列定义
// ------------------------------------------------------------

/** 渲染 SQL 表达式片段（drizzle SQL 对象）：用于 DEFAULT 与表达式索引 */
function renderSqlExpression(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const chunks = (value as { queryChunks?: unknown[] }).queryChunks;
  if (!Array.isArray(chunks)) return null;
  const parts: string[] = [];
  for (const chunk of chunks) {
    if (chunk === null || chunk === undefined) continue;
    if (typeof chunk === "string") { parts.push(chunk); continue; }
    if (typeof chunk === "object") {
      const c = chunk as Record<string, unknown>;
      if (typeof c.value === "string") { parts.push(c.value); continue; }
      const v = c.value as { value?: unknown } | undefined;
      if (v && typeof v === "object" && "value" in v) {
        const inner = v.value;
        parts.push(typeof inner === "string" ? `'${inner.replace(/'/g, "''")}'` : String(inner));
        continue;
      }
      parts.push(String(c.value ?? ""));
      continue;
    }
    parts.push(String(chunk));
  }
  return parts.join("").trim();
}

/** SQL 默认值渲染：CURRENT_TIMESTAMP 归一为可移植写法 */
function renderDefaultSql(raw: string | null, sqlType: string): string | null {
  if (raw === null) return null;
  const compact = raw.replace(/\s+/g, "").toLowerCase();
  if (/^\(?now\(\)\)?$/.test(compact) || compact === "current_timestamp" || compact === "current_timestamp()") {
    return "CURRENT_TIMESTAMP";
  }
  // json/blob/text 在 MySQL 里不允许字面量默认值（生成列另有处理）
  if (/^(json|blob|text|longtext|mediumtext|tinytext)$/i.test(sqlType)) return null;
  // 表达式默认（带括号或函数调用）原样保留
  if (/[()]/.test(raw) || /^(current_timestamp|now)/i.test(raw)) return raw;
  return raw;
}

/** 字面量默认值 → SQL 字面量 */
function renderLiteralDefault(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return String(value);
  }
  if (typeof value === "string") return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
  if (typeof value === "bigint") return String(value);
  if (typeof value === "object") {
    // SQL 对象 → 表达式（如 drizzle 的 (now())）
    const expr = renderSqlExpression(value);
    return expr === null ? null : renderDefaultSql(expr, "varchar");
  }
  return null;
}

function isSerialColumn(column: MySqlColumn): boolean {
  return column.columnType === "MySqlSerial" || column.getSQLType() === "serial";
}

function columnDefFromDrizzle(column: MySqlColumn): MysqlColumnDef {
  const sqlType = isSerialColumn(column) ? "bigint unsigned" : column.getSQLType();
  const isTimestamp = /^(timestamp|datetime)/i.test(sqlType);
  let defaultSql: string | null = null;
  if (column.hasDefault) {
    const rendered = renderLiteralDefault(column.default);
    defaultSql = rendered === null ? null : renderDefaultSql(rendered, sqlType);
  }
  // drizzle MySQL timestamp 的 ON UPDATE 标记在 hasOnUpdateNow（onUpdateFn 运行时为 undefined）
  const hasOnUpdate = (column as unknown as { hasOnUpdateNow?: boolean }).hasOnUpdateNow === true;
  const onUpdateSql = isTimestamp && hasOnUpdate ? "CURRENT_TIMESTAMP" : null;
  return {
    name: column.name,
    sqlType,
    notNull: !!column.notNull,
    primary: !!column.primary,
    autoIncrement: (column as unknown as { autoIncrement?: boolean }).autoIncrement === true,
    defaultSql,
    onUpdateSql,
    generatedAs: null,
    generatedStored: false,
  };
}

/** 索引列渲染：普通列取 name；表达式（SQL）渲染为原始 SQL（MySQL 8 函数索引） */
function renderIndexColumn(column: unknown): string {
  if (column && typeof column === "object") {
    const asColumn = column as { name?: unknown };
    if (typeof asColumn.name === "string" && asColumn.name.length > 0) return asColumn.name;
    const expr = renderSqlExpression(column);
    if (expr !== null) return expr;
  }
  return String(column);
}

// ------------------------------------------------------------
// manifest 构建（schema.mysql.ts → 表/列/索引）
// ------------------------------------------------------------

/** 构建 MySQL DDL manifest（纯函数；schema.mysql.ts 改动会自动反映） */
export function buildMysqlManifest(): MysqlSchemaManifest {
  const tables: MysqlTableDef[] = [];
  const seen = new Set<string>();

  for (const exported of Object.values(schema)) {
    if (!exported || typeof exported !== "object") continue;
    // 只接受 drizzle mysqlTable（其它 export 或非表对象 getTableConfig 会抛错，跳过）
    let cfg: ReturnType<typeof getTableConfig>;
    try {
      cfg = getTableConfig(exported as MySqlTable);
    } catch {
      continue;
    }
    if (!cfg || typeof cfg.name !== "string" || seen.has(cfg.name)) continue;
    seen.add(cfg.name);

    const override = TABLE_OVERRIDES[cfg.name] ?? {};
    const columns: MysqlColumnDef[] = cfg.columns.map(columnDefFromDrizzle);
    for (const extra of override.extraColumns ?? []) columns.push({ ...extra });

    // 主键：drizzle 的 primaryKey() 组合键优先；否则取列上的 primary 标记
    const primaryKey: string[] = [];
    for (const pk of cfg.primaryKeys ?? []) {
      for (const c of pk.columns) if (c?.name && !primaryKey.includes(c.name)) primaryKey.push(c.name);
    }
    if (primaryKey.length === 0) {
      for (const c of cfg.columns) if (c.primary) primaryKey.push(c.name);
    }

    const skip = new Set(override.skipAutoIndexes ?? []);
    const indexes: MysqlIndexDef[] = [];
    for (const idx of cfg.indexes ?? []) {
      const name = idx.config.name;
      if (typeof name !== "string" || skip.has(name)) continue;
      indexes.push({
        name,
        unique: !!idx.config.unique,
        columns: (idx.config.columns ?? []).map(renderIndexColumn),
      });
    }
    for (const extra of override.extraIndexes ?? []) {
      if (!indexes.some((i) => i.name === extra.name)) indexes.push({ ...extra });
    }

    // 生成列统一排在普通列之后（MySQL 生成列可引用之前定义的列；这里 status/to_name 均为普通列）
    columns.sort((a, b) => Number(a.generatedAs !== null) - Number(b.generatedAs !== null));

    tables.push({
      name: cfg.name,
      columns,
      primaryKey,
      indexes,
      dropLegacyIndexes: [...(override.dropLegacyIndexes ?? [])],
      preIndexStatements: [...(override.preIndexStatements ?? [])],
    });
  }

  tables.sort((a, b) => a.name.localeCompare(b.name));
  const stats = {
    tables: tables.length,
    columns: tables.reduce((n, t) => n + t.columns.length, 0),
    indexes: tables.reduce((n, t) => n + t.indexes.length, 0),
    generatedColumns: tables.reduce((n, t) => n + t.columns.filter((c) => c.generatedAs !== null).length, 0),
  };
  const manifest: MysqlSchemaManifest = { tables, fingerprint: "", stats };
  manifest.fingerprint = structuralFingerprint(tables);
  return manifest;
}

/** 结构指纹：只取"表名 + 列名 + 索引名/唯一性/列"，避免 MySQL 类型字符串方言差异 */
export function structuralFingerprint(tables: MysqlTableDef[]): string {
  const normalized = tables.map((t) => ({
    t: t.name,
    c: t.columns.map((c) => c.name).sort(),
    k: t.primaryKey,
    i: t.indexes
      .map((i) => ({ n: i.name, u: i.unique, c: i.columns }))
      .sort((a, b) => a.n.localeCompare(b.n)),
  }));
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex").slice(0, 16);
}

// ------------------------------------------------------------
// SQL 渲染
// ------------------------------------------------------------

export function quoteId(name: string): string {
  return `\`${name.replace(/`/g, "``")}\``;
}

function renderColumnDef(column: MysqlColumnDef): string {
  const parts: string[] = [quoteId(column.name), column.sqlType];
  if (column.generatedAs !== null) {
    parts.push(`GENERATED ALWAYS AS (${column.generatedAs}) ${column.generatedStored ? "STORED" : "VIRTUAL"}`);
    return parts.join(" ");
  }
  if (column.notNull) parts.push("NOT NULL");
  if (column.defaultSql !== null) parts.push(`DEFAULT ${column.defaultSql}`);
  if (column.autoIncrement) parts.push("AUTO_INCREMENT");
  if (column.onUpdateSql !== null) parts.push(`ON UPDATE ${column.onUpdateSql}`);
  return parts.join(" ");
}

/** CREATE TABLE IF NOT EXISTS（空库引导用；含人工约束层索引） */
export function renderCreateTable(table: MysqlTableDef): string {
  const lines: string[] = table.columns.map((c) => `  ${renderColumnDef(c)}`);
  if (table.primaryKey.length > 0) {
    lines.push(`  PRIMARY KEY (${table.primaryKey.map(quoteId).join(", ")})`);
  }
  for (const idx of table.indexes) {
    const keyword = idx.unique ? "UNIQUE INDEX" : "INDEX";
    lines.push(`  ${keyword} ${quoteId(idx.name)} (${idx.columns.map((c) => (needsExprWrap(c) ? `(${c})` : quoteId(c))).join(", ")})`);
  }
  return `CREATE TABLE IF NOT EXISTS ${quoteId(table.name)} (\n${lines.join(",\n")}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;
}

/** 表达式索引列（含反引号或括号）需要额外括号包一层（MySQL 8 函数索引语法） */
function needsExprWrap(column: string): boolean {
  return /[(`]/.test(column);
}

export function renderAddColumn(table: string, column: MysqlColumnDef): string {
  return `ALTER TABLE ${quoteId(table)} ADD COLUMN ${renderColumnDef(column)}`;
}

export function renderAddIndex(table: string, index: MysqlIndexDef): string {
  const keyword = index.unique ? "UNIQUE INDEX" : "INDEX";
  const cols = index.columns.map((c) => (needsExprWrap(c) ? `(${c})` : quoteId(c))).join(", ");
  return `ALTER TABLE ${quoteId(table)} ADD ${keyword} ${quoteId(index.name)} (${cols})`;
}

export function renderDropIndex(table: string, indexName: string): string {
  return `ALTER TABLE ${quoteId(table)} DROP INDEX ${quoteId(indexName)}`;
}

/** 空库引导 SQL（CREATE TABLE 全集；重复执行因 IF NOT EXISTS 幂等） */
export function renderBootstrapSql(manifest: MysqlSchemaManifest): string {
  const header = [
    "-- ============================================================",
    "-- 狼人杀研究平台 MySQL/TiDB schema（由 db/mysql-ddl.ts 从 db/schema.mysql.ts 生成）",
    `-- tables: ${manifest.stats.tables}  columns: ${manifest.stats.columns}  indexes: ${manifest.stats.indexes}`,
    `-- fingerprint: ${manifest.fingerprint}`,
    "-- ⚠️ 已有旧库请用 scripts/mysql-schema-sync.mjs 做逐列/逐索引迁移（本文件只做空库引导）",
    "-- ============================================================",
    "",
  ];
  return [...header, ...manifest.tables.map((t) => `${renderCreateTable(t)};`), ""].join("\n");
}

// ------------------------------------------------------------
// 同步计划（现状 → 目标；纯函数）
// ------------------------------------------------------------

/**
 * 计算幂等同步计划：
 *  - 缺表 → CREATE TABLE；
 *  - 缺列 → ALTER TABLE ADD COLUMN（含人工生成列）；
 *  - 缺索引/索引定义不符 → 先跑 preIndexStatements（如 active 去重）再 DROP + ADD；
 *  - 人工旧索引 → DROP（仅 manifest 显式列出的历史索引）；
 *  - 现状多出的列/索引 → 只 warning，不删除（避免毁数据）。
 */
export function planMysqlSync(manifest: MysqlSchemaManifest, existing: ExistingSchemaSnapshot): MysqlSyncPlan {
  const plan: MysqlSyncPlan = {
    createTables: [], addColumns: [], addIndexes: [], dropIndexes: [], preStatements: [], warnings: [],
  };
  for (const table of manifest.tables) {
    const current = existing.tables[table.name];
    if (!current) {
      plan.createTables.push(table);
      continue;
    }
    const existingColumns = new Set(current.columns);
    for (const column of table.columns) {
      if (!existingColumns.has(column.name)) plan.addColumns.push({ table: table.name, column });
    }
    // 表存在 → 历史索引清理
    for (const legacy of table.dropLegacyIndexes) {
      if (current.indexes.some((i) => i.name === legacy)) {
        plan.dropIndexes.push({ table: table.name, name: legacy });
      }
    }
    // 索引补齐 / 定义修正
    for (const index of table.indexes) {
      const found = current.indexes.find((i) => i.name === index.name);
      if (!found) {
        for (const sql of table.preIndexStatements) plan.preStatements.push({ table: table.name, sql, forIndex: index.name });
        plan.addIndexes.push({ table: table.name, index, existsWithOtherDefinition: false });
        continue;
      }
      const same = found.unique === index.unique
        && found.columns.length === index.columns.length
        && found.columns.every((c, i) => normalizeIndexColumn(c) === normalizeIndexColumn(index.columns[i]!));
      if (same) continue;
      for (const sql of table.preIndexStatements) plan.preStatements.push({ table: table.name, sql, forIndex: index.name });
      plan.dropIndexes.push({ table: table.name, name: index.name });
      plan.addIndexes.push({ table: table.name, index, existsWithOtherDefinition: true });
    }
    // 现状多余对象：只报告
    const expectedColumns = new Set(table.columns.map((c) => c.name));
    for (const c of current.columns) if (!expectedColumns.has(c)) plan.warnings.push(`${table.name}: 库中存在 schema 外列 ${c}（保留）`);
    const expectedIndexes = new Set(table.indexes.map((i) => i.name));
    for (const i of current.indexes) {
      if (i.name === "PRIMARY") continue;
      if (!expectedIndexes.has(i.name) && !table.dropLegacyIndexes.includes(i.name)) {
        plan.warnings.push(`${table.name}: 库中存在 schema 外索引 ${i.name}（保留）`);
      }
    }
  }
  // 执行顺序：先 drop（避免同名冲突）→ 数据整理 → add column → add index；create 表独立
  plan.preStatements = dedupeStatements(plan.preStatements);
  return plan;
}

function normalizeIndexColumn(column: string): string {
  return column.replace(/[`\s]/g, "").toLowerCase();
}

function dedupeStatements(items: Array<{ table: string; sql: string; forIndex: string }>) {
  const seen = new Set<string>();
  return items.filter((i) => {
    const key = `${i.table}:${i.sql}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 把计划转成可执行 SQL 语句列表（按正确顺序） */
export function renderPlanSql(plan: MysqlSyncPlan): string[] {
  const statements: string[] = [];
  for (const table of plan.createTables) statements.push(renderCreateTable(table));
  for (const drop of plan.dropIndexes) statements.push(renderDropIndex(drop.table, drop.name));
  for (const pre of plan.preStatements) statements.push(pre.sql);
  for (const add of plan.addColumns) statements.push(renderAddColumn(add.table, add.column));
  for (const add of plan.addIndexes) statements.push(renderAddIndex(add.table, add.index));
  return statements;
}

/** 计划是否为空（幂等：第二次执行应为空） */
export function isPlanEmpty(plan: MysqlSyncPlan): boolean {
  return plan.createTables.length === 0
    && plan.addColumns.length === 0
    && plan.addIndexes.length === 0
    && plan.dropIndexes.length === 0;
}

/** 关键验收项（发布前置检查用）：表数 + 核心索引/列是否齐 */
export const REQUIRED_SCHEMA_CHECKS: ReadonlyArray<{
  kind: "table" | "column" | "index";
  table: string;
  name?: string;
  unique?: boolean;
  columns?: string[];
  note: string;
}> = [
  { kind: "table", table: "persona_writeback_runs", note: "记事簿回写台账（P1-31）" },
  { kind: "column", table: "canon_backfill_jobs", name: "stats", note: "补完统计 JSON（P1-14）" },
  { kind: "column", table: "canon_backfill_jobs", name: "web_searched", note: "是否联网" },
  { kind: "column", table: "canon_backfill_jobs", name: "warning", note: "降级警告" },
  { kind: "column", table: "persona_relations", name: "active_marker", note: "仅 active 唯一（生成列）" },
  { kind: "column", table: "persona_relations", name: "to_name_key", note: "悬空边 to_name 参与唯一键（生成列）" },
  {
    kind: "index", table: "persona_relations", name: "idx_rel_active", unique: true,
    columns: ["from_persona_id", "to_persona_id", "to_name_key", "layer", "kind", "active_marker"],
    note: "仅 active 唯一（P1-8）",
  },
  {
    kind: "index", table: "persona_aliases", name: "idx_alias_persona_name", unique: true,
    columns: ["persona_id", "alias"], note: "别名按人格唯一（P0-5）",
  },
  {
    kind: "index", table: "persona_nickname_index", name: "idx_nni_persona_text", unique: true,
    columns: ["persona_id", "text"], note: "昵称按人格唯一（P0-5）",
  },
  {
    kind: "index", table: "persona_writeback_runs", name: "idx_pwr_key", unique: true,
    columns: ["persona_id", "game_id", "seat"], note: "回写幂等守卫（P1-31）",
  },
];

export interface SchemaCheckResult {
  ok: boolean;
  passed: string[];
  failures: string[];
}

/** 对现状快照跑关键验收项（information_schema 断言；纯函数） */
export function checkRequiredSchema(existing: ExistingSchemaSnapshot): SchemaCheckResult {
  const passed: string[] = [];
  const failures: string[] = [];
  for (const check of REQUIRED_SCHEMA_CHECKS) {
    const table = existing.tables[check.table];
    if (check.kind === "table") {
      (table ? passed : failures).push(`表 ${check.table}（${check.note}）`);
      continue;
    }
    if (!table) { failures.push(`表 ${check.table} 缺失（${check.note}）`); continue; }
    if (check.kind === "column") {
      (table.columns.includes(check.name!) ? passed : failures).push(`列 ${check.table}.${check.name}（${check.note}）`);
      continue;
    }
    const index = table.indexes.find((i) => i.name === check.name);
    if (!index) {
      failures.push(`索引 ${check.table}.${check.name} 缺失（${check.note}）`);
      continue;
    }
    const sameUnique = check.unique === undefined || index.unique === check.unique;
    const sameCols = !check.columns || (
      index.columns.length === check.columns.length
      && index.columns.every((c, i) => normalizeIndexColumn(c) === normalizeIndexColumn(check.columns![i]!))
    );
    if (sameUnique && sameCols) passed.push(`索引 ${check.table}.${check.name}（${check.note}）`);
    else failures.push(`索引 ${check.table}.${check.name} 定义不符（期望 unique=${check.unique} [${check.columns?.join(",")}]，实际 unique=${index.unique} [${index.columns.join(",")}]）`);
  }
  return { ok: failures.length === 0, passed, failures };
}
