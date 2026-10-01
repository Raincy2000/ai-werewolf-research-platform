// 人格研究库 MySQL/TiDB 幂等迁移（含回收站列）——db:push 禁用，一律手动 SQL
// 覆盖：人格五表缺失则创建（personas 含 image_data/deleted_at 最新列）；已存在则按列补齐
// 用法：set -a && . ./.env.local && set +a && node scripts/persona-trash-migration.mjs
// （云端 TiDB 则用 .env；幂等：information_schema 预检，已存在跳过）
import mysql from "mysql2/promise";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("缺少 DATABASE_URL（请先 source .env.local 或 .env）");
  process.exit(1);
}

const conn = await mysql.createConnection(url);
const [dbRows] = await conn.query("SELECT DATABASE() AS db");
const dbName = dbRows[0].db;
console.log(`目标库：${dbName}`);

const TABLES = {
  personas: `
CREATE TABLE personas (
  id bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id varchar(36) NOT NULL,
  name varchar(64) NOT NULL,
  source varchar(16) NOT NULL DEFAULT 'manual',
  origin_name varchar(128),
  origin_source varchar(128),
  profile json NOT NULL,
  params json NOT NULL,
  notes text NOT NULL,
  image_data longtext,
  game_count int NOT NULL DEFAULT 0,
  deleted_at timestamp NULL,
  created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_personas_user (user_id)
)`,
  persona_memories: `
CREATE TABLE persona_memories (
  id bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
  persona_id int NOT NULL,
  game_id varchar(36),
  type varchar(16) NOT NULL DEFAULT 'general',
  content text NOT NULL,
  emotional_weight int NOT NULL DEFAULT 50,
  strength int NOT NULL DEFAULT 50,
  created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_pmem_persona (persona_id)
)`,
  persona_relationships: `
CREATE TABLE persona_relationships (
  id bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
  persona_id int NOT NULL,
  target_persona_id int,
  target_name varchar(128) NOT NULL,
  relation varchar(64) NOT NULL DEFAULT '',
  affinity int NOT NULL DEFAULT 0,
  trust int NOT NULL DEFAULT 50,
  note varchar(255) NOT NULL DEFAULT '',
  game_id varchar(36),
  updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_prel_persona (persona_id)
)`,
  persona_drift_log: `
CREATE TABLE persona_drift_log (
  id bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
  persona_id int NOT NULL,
  game_id varchar(36),
  changes json NOT NULL,
  note varchar(255) NOT NULL DEFAULT '',
  created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_pdrift_persona (persona_id)
)`,
  persona_reports: `
CREATE TABLE persona_reports (
  id bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
  game_id varchar(36) NOT NULL,
  persona_id int NOT NULL,
  seat int NOT NULL,
  report text NOT NULL,
  model varchar(128) NOT NULL,
  created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_preport_game (game_id, persona_id)
)`,
};

// personas 表已存在时的按列补齐（老库升级）
const PERSONAS_PATCH_COLUMNS = {
  image_data: "ALTER TABLE personas ADD COLUMN image_data longtext NULL",
  deleted_at: "ALTER TABLE personas ADD COLUMN deleted_at timestamp NULL",
};

async function tableExists(name) {
  const [rows] = await conn.query(
    "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
    [dbName, name],
  );
  return rows.length > 0;
}

async function columnExists(table, column) {
  const [rows] = await conn.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?",
    [dbName, table, column],
  );
  return rows.length > 0;
}

for (const [name, ddl] of Object.entries(TABLES)) {
  if (await tableExists(name)) {
    console.log(`跳过（表已存在）：${name}`);
    continue;
  }
  await conn.query(ddl);
  console.log(`已创建：${name}`);
}

// 老 personas 表补列（新创建的本轮已含，预检跳过）
for (const [col, ddl] of Object.entries(PERSONAS_PATCH_COLUMNS)) {
  if (await columnExists("personas", col)) {
    console.log(`跳过（列已存在）：personas.${col}`);
    continue;
  }
  await conn.query(ddl);
  console.log(`已添加：personas.${col}`);
}

await conn.end();
console.log("迁移完成");
