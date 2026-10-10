// 桌面客户端 SQLite 建库 DDL（由 drizzle-kit generate --config drizzle.config.sqlite.ts 生成，
// 经脚本去 statement-breakpoint 并转义后内嵌；schema 变更时重新生成并同步本文件）。
export const SQLITE_DDL = `
CREATE TABLE \`api_presets\` (
	\`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	\`name\` text NOT NULL,
	\`provider\` text NOT NULL,
	\`base_url\` text DEFAULT '' NOT NULL,
	\`model\` text DEFAULT '' NOT NULL,
	\`api_key\` text DEFAULT '' NOT NULL,
	\`user_id\` text,
	\`created_at\` integer NOT NULL,
	\`updated_at\` integer NOT NULL
);

CREATE TABLE \`game_analyses\` (
	\`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	\`game_id\` text NOT NULL,
	\`report\` text NOT NULL,
	\`model\` text NOT NULL,
	\`created_at\` integer NOT NULL
);

CREATE TABLE \`game_decisions\` (
	\`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	\`game_id\` text NOT NULL,
	\`idx\` integer NOT NULL,
	\`kind\` text NOT NULL,
	\`seat\` integer NOT NULL,
	\`decision\` text NOT NULL,
	\`created_at\` integer NOT NULL
);

CREATE INDEX \`idx_decisions_game_idx\` ON \`game_decisions\` (\`game_id\`,\`idx\`);

CREATE TABLE \`game_events\` (
	\`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	\`game_id\` text NOT NULL,
	\`seq\` integer NOT NULL,
	\`day\` integer NOT NULL,
	\`phase\` text NOT NULL,
	\`type\` text NOT NULL,
	\`actor\` integer,
	\`actor_label\` text,
	\`title\` text NOT NULL,
	\`content\` text NOT NULL,
	\`thought\` text,
	\`meta\` text,
	\`created_at\` integer NOT NULL
);

CREATE INDEX \`idx_game_seq\` ON \`game_events\` (\`game_id\`,\`seq\`);

CREATE TABLE \`game_winrates\` (
	\`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	\`game_id\` text NOT NULL,
	\`day\` integer NOT NULL,
	\`phase\` text NOT NULL,
	\`good_pct\` integer NOT NULL,
	\`wolf_pct\` integer NOT NULL,
	\`reasons\` text NOT NULL,
	\`trigger_label\` text,
	\`created_at\` integer NOT NULL
);

CREATE INDEX \`idx_winrates_game_id\` ON \`game_winrates\` (\`game_id\`,\`id\`);

CREATE TABLE \`games\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`board_id\` text NOT NULL,
	\`board_name\` text NOT NULL,
	\`title_no\` text DEFAULT '' NOT NULL,
	\`status\` text DEFAULT 'created' NOT NULL,
	\`winner\` text,
	\`day_count\` integer DEFAULT 1 NOT NULL,
	\`player_count\` integer NOT NULL,
	\`setup\` text NOT NULL,
	\`user_id\` text,
	\`created_at\` integer NOT NULL,
	\`updated_at\` integer NOT NULL
);

CREATE TABLE \`guide_versions\` (
	\`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	\`scope\` text DEFAULT 'common' NOT NULL,
	\`version\` integer NOT NULL,
	\`content\` text NOT NULL,
	\`game_id\` text,
	\`note\` text DEFAULT '' NOT NULL,
	\`user_id\` text,
	\`created_at\` integer NOT NULL
);

CREATE TABLE \`sessions\` (
	\`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	\`token_hash\` text NOT NULL,
	\`user_id\` text NOT NULL,
	\`remember\` integer DEFAULT 0 NOT NULL,
	\`expires_at\` integer NOT NULL,
	\`created_at\` integer NOT NULL
);

CREATE UNIQUE INDEX \`sessions_token_hash_unique\` ON \`sessions\` (\`token_hash\`);

CREATE INDEX \`idx_sessions_user\` ON \`sessions\` (\`user_id\`);

CREATE TABLE \`users\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`email\` text NOT NULL,
	\`username\` text NOT NULL,
	\`avatar\` text NOT NULL,
	\`password_hash\` text NOT NULL,
	\`settings\` text,
	\`created_at\` integer NOT NULL
);

CREATE UNIQUE INDEX \`users_email_unique\` ON \`users\` (\`email\`);

CREATE TABLE \`game_studies\` (
	\`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	\`game_id\` text NOT NULL,
	\`seat\` integer NOT NULL,
	\`notes\` text NOT NULL,
	\`created_at\` integer NOT NULL
);

CREATE INDEX \`idx_studies_game\` ON \`game_studies\` (\`game_id\`,\`seat\`);

CREATE TABLE \`library_docs\` (
	\`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	\`user_id\` text NOT NULL,
	\`name\` text NOT NULL,
	\`format\` text NOT NULL,
	\`content\` text NOT NULL,
	\`size_bytes\` integer DEFAULT 0 NOT NULL,
	\`created_at\` integer NOT NULL
);

CREATE TABLE \`persona_drift_log\` (
	\`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	\`persona_id\` integer NOT NULL,
	\`game_id\` text,
	\`changes\` text NOT NULL,
	\`note\` text DEFAULT '' NOT NULL,
	\`created_at\` integer NOT NULL
);

CREATE INDEX \`idx_pdrift_persona\` ON \`persona_drift_log\` (\`persona_id\`);

CREATE TABLE \`persona_memories\` (
	\`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	\`persona_id\` integer NOT NULL,
	\`game_id\` text,
	\`type\` text DEFAULT 'general' NOT NULL,
	\`content\` text NOT NULL,
	\`emotional_weight\` integer DEFAULT 50 NOT NULL,
	\`strength\` integer DEFAULT 50 NOT NULL,
	\`created_at\` integer NOT NULL,
	\`updated_at\` integer NOT NULL
);

CREATE INDEX \`idx_pmem_persona\` ON \`persona_memories\` (\`persona_id\`);

CREATE TABLE \`persona_relationships\` (
	\`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	\`persona_id\` integer NOT NULL,
	\`target_persona_id\` integer,
	\`target_name\` text NOT NULL,
	\`relation\` text DEFAULT '' NOT NULL,
	\`affinity\` integer DEFAULT 0 NOT NULL,
	\`trust\` integer DEFAULT 50 NOT NULL,
	\`note\` text DEFAULT '' NOT NULL,
	\`game_id\` text,
	\`updated_at\` integer NOT NULL
);

CREATE INDEX \`idx_prel_persona\` ON \`persona_relationships\` (\`persona_id\`);

CREATE TABLE \`persona_reports\` (
	\`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	\`game_id\` text NOT NULL,
	\`persona_id\` integer NOT NULL,
	\`seat\` integer NOT NULL,
	\`report\` text NOT NULL,
	\`model\` text NOT NULL,
	\`created_at\` integer NOT NULL
);

CREATE INDEX \`idx_preport_game\` ON \`persona_reports\` (\`game_id\`,\`persona_id\`);

CREATE TABLE \`personas\` (
	\`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	\`user_id\` text NOT NULL,
	\`name\` text NOT NULL,
	\`source\` text DEFAULT 'manual' NOT NULL,
	\`origin_name\` text,
	\`origin_source\` text,
	\`profile\` text NOT NULL,
	\`params\` text NOT NULL,
	\`notes\` text DEFAULT '' NOT NULL,
	\`image_data\` text,
	\`game_count\` integer DEFAULT 0 NOT NULL,
	\`deleted_at\` integer,
	\`created_at\` integer NOT NULL,
	\`updated_at\` integer NOT NULL
);

CREATE INDEX \`idx_personas_user\` ON \`personas\` (\`user_id\`);
`;

// 增量 DDL（0001：图书馆文档表 + 赛前学习笔记表）——老库升级用（users 已存在但缺新表时执行）
export const SQLITE_DDL_0001 = `
CREATE TABLE \`game_studies\` (
	\`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	\`game_id\` text NOT NULL,
	\`seat\` integer NOT NULL,
	\`notes\` text NOT NULL,
	\`created_at\` integer NOT NULL
);

CREATE INDEX \`idx_studies_game\` ON \`game_studies\` (\`game_id\`,\`seat\`);

CREATE TABLE \`library_docs\` (
	\`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	\`user_id\` text NOT NULL,
	\`name\` text NOT NULL,
	\`format\` text NOT NULL,
	\`content\` text NOT NULL,
	\`size_bytes\` integer DEFAULT 0 NOT NULL,
	\`created_at\` integer NOT NULL
);
`;

// 增量 DDL（0002：人格研究库五表——人格参数卡/自传体记忆/关系图谱/人格漂移/心理检查报告）
// 老库升级用（users/library_docs 已存在但缺 personas 表时执行；与 SQLITE_DDL 尾部保持同构）
export const SQLITE_DDL_0002 = `
CREATE TABLE \`persona_drift_log\` (
	\`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	\`persona_id\` integer NOT NULL,
	\`game_id\` text,
	\`changes\` text NOT NULL,
	\`note\` text DEFAULT '' NOT NULL,
	\`created_at\` integer NOT NULL
);

CREATE INDEX \`idx_pdrift_persona\` ON \`persona_drift_log\` (\`persona_id\`);

CREATE TABLE \`persona_memories\` (
	\`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	\`persona_id\` integer NOT NULL,
	\`game_id\` text,
	\`type\` text DEFAULT 'general' NOT NULL,
	\`content\` text NOT NULL,
	\`emotional_weight\` integer DEFAULT 50 NOT NULL,
	\`strength\` integer DEFAULT 50 NOT NULL,
	\`created_at\` integer NOT NULL,
	\`updated_at\` integer NOT NULL
);

CREATE INDEX \`idx_pmem_persona\` ON \`persona_memories\` (\`persona_id\`);

CREATE TABLE \`persona_relationships\` (
	\`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	\`persona_id\` integer NOT NULL,
	\`target_persona_id\` integer,
	\`target_name\` text NOT NULL,
	\`relation\` text DEFAULT '' NOT NULL,
	\`affinity\` integer DEFAULT 0 NOT NULL,
	\`trust\` integer DEFAULT 50 NOT NULL,
	\`note\` text DEFAULT '' NOT NULL,
	\`game_id\` text,
	\`updated_at\` integer NOT NULL
);

CREATE INDEX \`idx_prel_persona\` ON \`persona_relationships\` (\`persona_id\`);

CREATE TABLE \`persona_reports\` (
	\`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	\`game_id\` text NOT NULL,
	\`persona_id\` integer NOT NULL,
	\`seat\` integer NOT NULL,
	\`report\` text NOT NULL,
	\`model\` text NOT NULL,
	\`created_at\` integer NOT NULL
);

CREATE INDEX \`idx_preport_game\` ON \`persona_reports\` (\`game_id\`,\`persona_id\`);

CREATE TABLE \`personas\` (
	\`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	\`user_id\` text NOT NULL,
	\`name\` text NOT NULL,
	\`source\` text DEFAULT 'manual' NOT NULL,
	\`origin_name\` text,
	\`origin_source\` text,
	\`profile\` text NOT NULL,
	\`params\` text NOT NULL,
	\`notes\` text DEFAULT '' NOT NULL,
	\`game_count\` integer DEFAULT 0 NOT NULL,
	\`deleted_at\` integer,
	\`created_at\` integer NOT NULL,
	\`updated_at\` integer NOT NULL
);

CREATE INDEX \`idx_personas_user\` ON \`personas\` (\`user_id\`);
`;


// 增量 DDL（0003：对局标题号 games.title_no——YYYYMMDD+当日序号3位，人格引用对局的统一编号）
// 老库升级用：games 缺 title_no 列时执行；ALTER 加列后按创建时间回填存量（同一用户同一天内按时间排序编号）
export const SQLITE_DDL_0003 = `
ALTER TABLE \`games\` ADD COLUMN \`title_no\` text DEFAULT '' NOT NULL;

WITH ranked AS (
  SELECT id,
    strftime('%Y%m%d', created_at/1000, 'unixepoch', 'localtime') ||
    printf('%03d', ROW_NUMBER() OVER (
      PARTITION BY user_id, date(created_at/1000, 'unixepoch', 'localtime')
      ORDER BY created_at, id
    )) AS tno
  FROM games
)
UPDATE games SET title_no = (SELECT tno FROM ranked WHERE ranked.id = games.id)
WHERE title_no = '';
`;


// 增量 DDL（0004：人格卡肖像配图 personas.image_data——身份证式卡片配图，data URL 存储）
// 老库升级用：personas 缺 image_data 列时执行
export const SQLITE_DDL_0004 = `
ALTER TABLE \`personas\` ADD COLUMN \`image_data\` text;
`;

// 增量 DDL（0005：人格回收站 personas.deleted_at——软删除标记；非 null=已移入回收站，
// 30 天保留期后惰性彻底删除。老库升级用：personas 缺 deleted_at 列时执行）
export const SQLITE_DDL_0005 = `
ALTER TABLE \`personas\` ADD COLUMN \`deleted_at\` integer;
`;

