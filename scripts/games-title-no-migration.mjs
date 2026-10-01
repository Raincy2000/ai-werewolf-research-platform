// 对局标题号（games.title_no）— MySQL/TiDB 手动迁移脚本（幂等：information_schema 预检）
// 用法：set -a && . ./.env.local && set +a && node scripts/games-title-no-migration.mjs
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

const [cols] = await conn.query(
  "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'games' AND COLUMN_NAME = 'title_no'",
  [dbName],
);
if (cols.length > 0) {
  console.log("跳过（title_no 已存在）");
} else {
  await conn.query("ALTER TABLE games ADD COLUMN title_no varchar(16) NOT NULL DEFAULT ''");
  console.log("已加列：games.title_no");
}

// 存量回填：同一用户同一天内按创建时间编号（窗口函数，MySQL 8 / TiDB 均支持）
const [res] = await conn.query(`
  UPDATE games g JOIN (
    SELECT id, DATE_FORMAT(created_at, '%Y%m%d') AS d,
      ROW_NUMBER() OVER (PARTITION BY user_id, DATE(created_at) ORDER BY created_at, id) AS rn
    FROM games
  ) r ON g.id = r.id
  SET g.title_no = CONCAT(r.d, LPAD(r.rn, 3, '0'))
  WHERE g.title_no = ''
`);
console.log(`回填完成：${res.affectedRows} 行`);
await conn.end();
