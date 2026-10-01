// 人格研究库五表 — MySQL/TiDB 手动迁移脚本（db:push 禁用，一律手动 SQL）
// 用法：set -a && . ./.env.local && set +a && node scripts/persona-mysql-migration.mjs
// （云端 TiDB 则用 .env；幂等：information_schema 预检，已存在的表跳过）
import mysql from "mysql2/promise";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("缺少 DATABASE_URL（请先 source .env.local 或 .env）");
  process.exit(1);
}

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
  game_count int NOT NULL DEFAULT 0,
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

const conn = await mysql.createConnection(url);
const [dbRows] = await conn.query("SELECT DATABASE() AS db");
const dbName = dbRows[0].db;
console.log(`目标库：${dbName}`);

for (const [name, ddl] of Object.entries(TABLES)) {
  const [rows] = await conn.query(
    "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
    [dbName, name],
  );
  if (rows.length > 0) {
    console.log(`跳过（已存在）：${name}`);
    continue;
  }
  await conn.query(ddl);
  console.log(`已创建：${name}`);
}

await conn.end();
console.log("迁移完成");
