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
	\`era\` text DEFAULT 'v3' NOT NULL,
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
	\`era\` text DEFAULT 'v3' NOT NULL,
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
	\`valence\` integer DEFAULT 0 NOT NULL,
	\`formula_version\` text DEFAULT 'v2_legacy' NOT NULL,
	\`situation_signature\` text,
	\`signature_estimated\` integer DEFAULT 0 NOT NULL,
	\`lifecycle\` text DEFAULT 'active' NOT NULL,
	\`origin\` text DEFAULT 'game' NOT NULL,
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
	\`auto_cognition\` text,
	\`params_baseline\` text,
	\`baseline_estimated\` integer DEFAULT 0 NOT NULL,
	\`params_residual\` text,
	\`relations_status\` text DEFAULT 'pending' NOT NULL,
	\`relations_source_hash\` text,
	\`created_at\` integer NOT NULL,
	\`updated_at\` integer NOT NULL
);

CREATE INDEX \`idx_personas_user\` ON \`personas\` (\`user_id\`);

CREATE TABLE \`persona_cast_checkpoints\` (
	\`cast_id\` text NOT NULL,
	\`stage\` text NOT NULL,
	\`data\` text NOT NULL,
	\`updated_at\` integer NOT NULL,
	PRIMARY KEY (\`cast_id\`, \`stage\`)
);

CREATE TABLE \`persona_cognition_notes\` (
	\`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	\`persona_id\` integer NOT NULL,
	\`content\` text NOT NULL,
	\`model\` text DEFAULT '' NOT NULL,
	\`opts\` text DEFAULT '{}' NOT NULL,
	\`game_count\` integer DEFAULT 0 NOT NULL,
	\`created_at\` integer NOT NULL
);
CREATE INDEX \`idx_pcog_persona\` ON \`persona_cognition_notes\` (\`persona_id\`);

CREATE TABLE \`persona_cast_drafts\` (
	\`cast_id\` text PRIMARY KEY NOT NULL,
	\`user_id\` text,
	\`name\` text DEFAULT '' NOT NULL,
	\`result\` text NOT NULL,
	\`status\` text DEFAULT 'done' NOT NULL,
	\`updated_at\` integer DEFAULT 0 NOT NULL,
	\`created_at\` integer NOT NULL
);

CREATE TABLE \`persona_relationship_history\` (
	\`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	\`persona_id\` integer NOT NULL,
	\`target_persona_id\` integer,
	\`target_name\` text NOT NULL,
	\`game_id\` text,
	\`title_no\` text DEFAULT '' NOT NULL,
	\`relation\` text DEFAULT '' NOT NULL,
	\`affinity_delta\` integer DEFAULT 0 NOT NULL,
	\`trust_delta\` integer DEFAULT 0 NOT NULL,
	\`affinity\` integer DEFAULT 0 NOT NULL,
	\`trust\` integer DEFAULT 50 NOT NULL,
	\`note\` text DEFAULT '' NOT NULL,
	\`backfill\` integer DEFAULT 0 NOT NULL,
	\`created_at\` integer NOT NULL
);
CREATE INDEX \`idx_prelh_persona\` ON \`persona_relationship_history\` (\`persona_id\`);
CREATE INDEX \`idx_prelh_target\` ON \`persona_relationship_history\` (\`target_persona_id\`);


CREATE TABLE \`scenarios\` (
  \`id\` text PRIMARY KEY NOT NULL,
  \`kind\` text NOT NULL,
  \`title_no\` text,
  \`status\` text DEFAULT 'created' NOT NULL,
  \`game_id\` text,
  \`constraint_level\` integer DEFAULT 2 NOT NULL,
  \`stakes_json\` text,
  \`participant_ids\` text,
  \`started_at\` integer,
  \`ended_at\` integer,
  \`config_json\` text,
  \`created_at\` integer NOT NULL
);
CREATE INDEX \`idx_scen_kind\` ON \`scenarios\` (\`kind\`);

CREATE TABLE \`scenario_events\` (
  \`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  \`scenario_id\` text NOT NULL,
  \`seq\` integer NOT NULL,
  \`type\` text NOT NULL,
  \`actor\` integer,
  \`actor_label\` text,
  \`title\` text,
  \`content\` text,
  \`thought\` text,
  \`meta\` text,
  \`created_at\` integer NOT NULL
);
CREATE INDEX \`idx_sev_scen\` ON \`scenario_events\` (\`scenario_id\`, \`seq\`);

CREATE TABLE \`situation_classes\` (
  \`id\` text PRIMARY KEY NOT NULL,
  \`label\` text NOT NULL,
  \`scenario_kind\` text NOT NULL,
  \`constraint\` integer DEFAULT 2 NOT NULL,
  \`activated\` text NOT NULL,
  \`created_at\` integer NOT NULL
);

CREATE TABLE \`role_enrollments\` (
  \`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  \`persona_id\` integer NOT NULL,
  \`role_kind\` text NOT NULL,
  \`role_ref\` text NOT NULL,
  \`commitment\` integer DEFAULT 50 NOT NULL,
  \`scenario_id_enter\` text NOT NULL,
  \`scenario_id_exit\` text,
  \`entered_at\` integer NOT NULL,
  \`exited_at\` integer
);
CREATE INDEX \`idx_role_persona\` ON \`role_enrollments\` (\`persona_id\`);

CREATE TABLE \`role_events\` (
  \`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  \`enrollment_id\` integer NOT NULL,
  \`scenario_id\` text NOT NULL,
  \`commitment\` integer NOT NULL,
  \`note\` text,
  \`created_at\` integer NOT NULL
);

CREATE TABLE \`persona_state_observations\` (
  \`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  \`persona_id\` integer NOT NULL,
  \`scenario_id\` text NOT NULL,
  \`scenario_kind\` text NOT NULL,
  \`scenario_index\` integer NOT NULL,
  \`cumulative_salience\` integer DEFAULT 0 NOT NULL,
  \`trait_path\` text NOT NULL,
  \`state_value\` integer NOT NULL,
  \`direction\` text,
  \`situation_class_id\` text NOT NULL,
  \`situation_signature\` text NOT NULL,
  \`salience\` integer DEFAULT 50 NOT NULL,
  \`exposure_in_class\` integer DEFAULT 1 NOT NULL,
  \`indicator_kind\` text DEFAULT 'behavior' NOT NULL,
  \`rater_id\` integer,
  \`source_param\` text NOT NULL,
  \`evidence_quote\` text,
  \`created_at\` integer NOT NULL
);
CREATE INDEX \`idx_pso_model\` ON \`persona_state_observations\` (\`persona_id\`, \`trait_path\`, \`scenario_index\`);
CREATE INDEX \`idx_pso_class\` ON \`persona_state_observations\` (\`situation_class_id\`);
CREATE UNIQUE INDEX \`idx_pso_dedup\` ON \`persona_state_observations\` (\`persona_id\`, \`scenario_id\`, \`trait_path\`, \`direction\`);

CREATE TABLE \`persona_baselines\` (
  \`persona_id\` integer PRIMARY KEY NOT NULL,
  \`params_json\` text NOT NULL,
  \`profile_json\` text,
  \`cast_id\` text,
  \`cast_model\` text,
  \`fidelity_json\` text,
  \`created_at\` integer NOT NULL
);

CREATE TABLE \`persona_plasticity\` (
  \`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  \`persona_id\` integer NOT NULL,
  \`scenario_index\` integer NOT NULL,
  \`kappa\` real NOT NULL,
  \`determinants\` text NOT NULL,
  \`created_at\` integer NOT NULL
);
CREATE INDEX \`idx_plast_persona\` ON \`persona_plasticity\` (\`persona_id\`, \`scenario_index\`);

CREATE TABLE \`persona_trait_updates\` (
  \`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  \`persona_id\` integer NOT NULL,
  \`scenario_id\` text NOT NULL,
  \`trait_path\` text NOT NULL,
  \`value_from\` integer NOT NULL,
  \`value_to\` integer NOT NULL,
  \`alpha_eff\` real NOT NULL,
  \`factors_json\` text NOT NULL,
  \`observation_ids\` text NOT NULL,
  \`mechanism_version\` text NOT NULL,
  \`created_at\` integer NOT NULL
);
CREATE INDEX \`idx_ptu_persona\` ON \`persona_trait_updates\` (\`persona_id\`, \`trait_path\`);

CREATE TABLE \`trait_decomposition\` (
  \`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  \`persona_id\` integer NOT NULL,
  \`trait_path\` text NOT NULL,
  \`window_from\` integer NOT NULL,
  \`window_to\` integer NOT NULL,
  \`est_normative\` real,
  \`est_corresponsive\` real,
  \`est_event\` real,
  \`est_noise\` real,
  \`identified\` integer DEFAULT 0 NOT NULL,
  \`method\` text NOT NULL,
  \`diagnostics\` text,
  \`created_at\` integer NOT NULL
);

CREATE TABLE \`persona_fidelity\` (
  \`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  \`persona_id\` integer NOT NULL,
  \`source_kind\` text NOT NULL,
  \`reference_json\` text,
  \`profile_correlation\` real,
  \`icc\` real,
  \`created_at\` integer NOT NULL
);

CREATE TABLE \`persona_modulation_log\` (
  \`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  \`persona_id\` integer NOT NULL,
  \`scenario_id\` text NOT NULL,
  \`turn\` integer NOT NULL,
  \`params_version\` text NOT NULL,
  \`mechanism_version\` text NOT NULL,
  \`attention_weights\` text,
  \`appraisal\` text,
  \`recalled_ids\` text,
  \`utility_shift\` text,
  \`suppression_ratio\` real,
  \`defense_applied\` text,
  \`subjective_state\` text,
  \`created_at\` integer NOT NULL
);
CREATE UNIQUE INDEX \`idx_pml_turn\` ON \`persona_modulation_log\` (\`scenario_id\`, \`persona_id\`, \`turn\`);
-- 二阶关系认知（§24，Krackhardt CSS 1987）
CREATE TABLE \`perceived_dyad_relations\` (
  \`id\` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  \`observer_id\` INTEGER NOT NULL,
  \`about_from_id\` INTEGER NOT NULL,
  \`about_to_id\` INTEGER NOT NULL,
  \`granularity\` TEXT NOT NULL,
  \`dimensions_json\` TEXT,
  \`confidence\` REAL DEFAULT 0,
  \`source\` TEXT NOT NULL,
  \`bias_kind\` TEXT,
  \`accuracy\` REAL,
  \`updated_at\` INTEGER NOT NULL
);
CREATE UNIQUE INDEX \`idx_pdr\` ON \`perceived_dyad_relations\` (\`observer_id\`, \`about_from_id\`, \`about_to_id\`);
CREATE INDEX \`idx_pdr_observer\` ON \`perceived_dyad_relations\` (\`observer_id\`, \`updated_at\`);

-- 昵称文本索引（§17.9）：只索引 awareness=all 的
CREATE TABLE \`persona_nickname_index\` (
  \`id\` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  \`persona_id\` INTEGER NOT NULL,
  \`text\` TEXT NOT NULL,
  \`layer\` TEXT NOT NULL
);
CREATE UNIQUE INDEX \`idx_nni_persona_text\` ON \`persona_nickname_index\` (\`persona_id\`, \`text\`);
CREATE INDEX \`idx_nni_persona\` ON \`persona_nickname_index\` (\`persona_id\`);

-- 调用台账（§30.10）
CREATE TABLE \`invocation_log\` (
  \`id\` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  \`game_id\` TEXT,
  \`turn\` INTEGER,
  \`persona_id\` INTEGER NOT NULL,
  \`situation_kind\` TEXT NOT NULL,
  \`invoked_sources\` TEXT,
  \`truncated\` TEXT,
  \`conflicts_resolved\` TEXT,
  \`context_hash\` TEXT NOT NULL,
  \`output_event_id\` INTEGER,
  \`created_at\` INTEGER NOT NULL
);
CREATE INDEX \`idx_il_game\` ON \`invocation_log\` (\`game_id\`, \`turn\`);
CREATE INDEX \`idx_il_persona\` ON \`invocation_log\` (\`persona_id\`, \`created_at\`);

-- ============================================================
-- 人际网（Interpersonal Graph）—— docs/interpersonal-graph-design.md
-- 学术校准：双维情感(§12.2) / 增量校正(§12.4) / 转折点(§12.3) / 信任留疤(§12.6)
-- ============================================================

CREATE TABLE \`persona_aliases\` (
  \`id\` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  \`persona_id\` INTEGER NOT NULL,
  \`alias\` TEXT NOT NULL,
  \`alias_kind\` TEXT NOT NULL DEFAULT 'canon',
  \`source\` TEXT NOT NULL DEFAULT 'cast',
  \`confidence\` REAL NOT NULL DEFAULT 1.0,
  \`created_at\` INTEGER NOT NULL
);
CREATE UNIQUE INDEX \`idx_alias_persona_name\` ON \`persona_aliases\` (\`persona_id\`, \`alias\`);
CREATE INDEX \`idx_alias_persona\` ON \`persona_aliases\` (\`persona_id\`);

CREATE TABLE \`persona_relations\` (
  \`id\` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  \`from_persona_id\` INTEGER NOT NULL,
  \`to_persona_id\` INTEGER NOT NULL,
  \`to_name\` text,             -- 悬空边时对方的名字（对方未入库）
  \`layer\` TEXT NOT NULL,
  \`kind\` TEXT NOT NULL,
  \`kind_source\` TEXT,
  \`form\` TEXT NOT NULL DEFAULT 'CS',
  \`prototypicality\` REAL DEFAULT 1.0,
  \`positivity\` INTEGER DEFAULT 0,
  \`negativity\` INTEGER DEFAULT 0,
  \`trust\` INTEGER DEFAULT 50,
  \`trust_stage\` TEXT,
  \`commitment\` INTEGER DEFAULT 0,
  \`closeness\` INTEGER DEFAULT 0,
  \`dependence\` INTEGER DEFAULT 0,
  \`reciprocity\` INTEGER DEFAULT 0,
  \`power_balance\` INTEGER DEFAULT 0,
  \`formality\` INTEGER DEFAULT 0,
  \`violation_count\` INTEGER DEFAULT 0 NOT NULL,
  \`script_text\` TEXT,
  \`address_term\` text,        -- 我称呼 TA 用什么词（如「杰」「三笠」「L」）
  \`address_kind\` text,        -- neutral | intimate | honorific | derogatory
  \`hierarchy_rank\` INTEGER,
  \`basis\` TEXT,
  \`source_ref\` TEXT,
  \`evidence_ids\` TEXT,
  \`awareness\` TEXT NOT NULL DEFAULT 'full',
  \`disclosable\` INTEGER NOT NULL DEFAULT 1,
  \`origin_module\` TEXT NOT NULL DEFAULT 'migration',
  \`origin_version\` TEXT NOT NULL DEFAULT 'interp-relations-1.0',
  \`status\` TEXT NOT NULL DEFAULT 'active',
  \`superseded_by\` INTEGER,
  \`created_at\` INTEGER NOT NULL,
  \`updated_at\` INTEGER NOT NULL
);
-- 2026-10-22：仅 active 行唯一（superseded 历史行可保留同键），悬空边 to_name 纳入键
CREATE UNIQUE INDEX \`idx_rel_active\` ON \`persona_relations\` (\`from_persona_id\`, \`to_persona_id\`, IFNULL(\`to_name\`, ''), \`layer\`, \`kind\`) WHERE \`status\` = 'active';
CREATE INDEX \`idx_rel_from\` ON \`persona_relations\` (\`from_persona_id\`, \`layer\`, \`status\`);
CREATE INDEX \`idx_rel_to\` ON \`persona_relations\` (\`to_persona_id\`, \`layer\`, \`status\`);

CREATE TABLE \`relation_deltas\` (
  \`id\` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  \`relation_id\` INTEGER NOT NULL,
  \`from_persona_id\` INTEGER NOT NULL,
  \`to_persona_id\` INTEGER NOT NULL,
  \`layer\` TEXT NOT NULL,
  \`param\` TEXT NOT NULL,
  \`before_value\` INTEGER,
  \`after_value\` INTEGER,
  \`delta\` INTEGER,
  \`kind_before\` TEXT,
  \`kind_after\` TEXT,
  \`reason_kind\` TEXT NOT NULL,
  \`salience\` REAL,
  \`event_ids\` TEXT,
  \`game_id\` TEXT,
  \`evidence\` TEXT,
  \`verdict\` TEXT,
  \`corrected_from\` INTEGER,
  \`actor\` TEXT,
  \`mechanism_version\` TEXT NOT NULL,
  \`created_at\` INTEGER NOT NULL
);
CREATE INDEX \`idx_rd_rel\` ON \`relation_deltas\` (\`relation_id\`, \`created_at\`);
CREATE INDEX \`idx_rd_pair\` ON \`relation_deltas\` (\`from_persona_id\`, \`to_persona_id\`, \`layer\`);
CREATE INDEX \`idx_rd_verdict\` ON \`relation_deltas\` (\`verdict\`);

CREATE TABLE \`relation_completion_jobs\` (
  \`id\` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  \`user_id\` TEXT,
  \`scope\` TEXT NOT NULL,
  \`status\` TEXT NOT NULL DEFAULT 'pending',
  \`progress\` TEXT,
  \`stats\` TEXT,
  \`cost_estimate\` TEXT,
  \`created_at\` INTEGER NOT NULL,
  \`finished_at\` INTEGER
);

CREATE TABLE \`relation_completion_items\` (
  \`id\` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  \`job_id\` INTEGER NOT NULL,
  \`from_persona_id\` INTEGER NOT NULL,
  \`to_persona_id\` INTEGER NOT NULL,
  \`layer\` TEXT NOT NULL,
  \`param\` TEXT NOT NULL,
  \`action\` TEXT NOT NULL,
  \`before_json\` TEXT,
  \`after_json\` TEXT,
  \`source_tier\` TEXT,
  \`evidence\` TEXT,
  \`confidence\` REAL,
  \`user_decision\` TEXT DEFAULT 'pending',
  \`applied_at\` INTEGER
);
CREATE INDEX \`idx_rci_job\` ON \`relation_completion_items\` (\`job_id\`, \`action\`);

`;

// 增量 DDL（0001：图书馆文档表 + 赛前学习笔记表）——老库升级用（users 已存在但缺新表时执行）
export const SQLITE_DDL_0001 = `
CREATE TABLE \`game_studies\` (
	\`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	\`game_id\` text NOT NULL,
	\`seat\` integer NOT NULL,
	\`notes\` text NOT NULL,
	\`backfill\` integer DEFAULT 0 NOT NULL,
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

// 增量 DDL（0002：人格研究站五表——人格参数卡/自传体记忆/关系图谱/人格漂移/心理检查报告）
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



// 增量 DDL（0006：关系历史表 persona_relationship_history——人格锚点关系的逐局变迁，
// 汇总行 upsert 不动；老库升级用：缺该表时执行）
export const SQLITE_DDL_0006 = `
CREATE TABLE \`persona_relationship_history\` (
	\`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	\`persona_id\` integer NOT NULL,
	\`target_persona_id\` integer,
	\`target_name\` text NOT NULL,
	\`game_id\` text,
	\`title_no\` text DEFAULT '' NOT NULL,
	\`relation\` text DEFAULT '' NOT NULL,
	\`affinity_delta\` integer DEFAULT 0 NOT NULL,
	\`trust_delta\` integer DEFAULT 0 NOT NULL,
	\`affinity\` integer DEFAULT 0 NOT NULL,
	\`trust\` integer DEFAULT 50 NOT NULL,
	\`note\` text DEFAULT '' NOT NULL,
	\`backfill\` integer DEFAULT 0 NOT NULL,
	\`created_at\` integer NOT NULL
);
CREATE INDEX \`idx_prelh_persona\` ON \`persona_relationship_history\` (\`persona_id\`);
CREATE INDEX \`idx_prelh_target\` ON \`persona_relationship_history\` (\`target_persona_id\`);
`;


// 增量 DDL（0007：关系历史表加追溯回填标记列 persona_relationship_history.backfill）
export const SQLITE_DDL_0007 = `
ALTER TABLE \`persona_relationship_history\` ADD COLUMN \`backfill\` integer DEFAULT 0 NOT NULL;
`;


// 增量 DDL（0008：铸造草稿持久化表 persona_cast_drafts——铸魂师产物入库前的安身之处；
// 内存登记处 30 分钟清扫/进程重启都会丢草稿，done+result 条目落此表、重启后重新水合）
export const SQLITE_DDL_0008 = `
CREATE TABLE \`persona_cast_drafts\` (
	\`cast_id\` text PRIMARY KEY NOT NULL,
	\`user_id\` text,
	\`name\` text DEFAULT '' NOT NULL,
	\`result\` text NOT NULL,
	\`created_at\` integer NOT NULL
);
`;


// 增量 DDL（0009：自我认知笔记沿革表 persona_cognition_notes）
export const SQLITE_DDL_0009 = `
CREATE TABLE \`persona_cognition_notes\` (
	\`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	\`persona_id\` integer NOT NULL,
	\`content\` text NOT NULL,
	\`model\` text DEFAULT '' NOT NULL,
	\`opts\` text DEFAULT '{}' NOT NULL,
	\`game_count\` integer DEFAULT 0 NOT NULL,
	\`created_at\` integer NOT NULL
);
CREATE INDEX \`idx_pcog_persona\` ON \`persona_cognition_notes\` (\`persona_id\`);
`;


// 增量 DDL（0010：人格赛后自动书写认知笔记开关 personas.auto_cognition）
export const SQLITE_DDL_0010 = `
ALTER TABLE \`personas\` ADD COLUMN \`auto_cognition\` text;
`;


// 增量 DDL（0011：铸造过程检查点表 persona_cast_checkpoints）
export const SQLITE_DDL_0011 = `
CREATE TABLE \`persona_cast_checkpoints\` (
	\`cast_id\` text NOT NULL,
	\`stage\` text NOT NULL,
	\`data\` text NOT NULL,
	\`updated_at\` integer NOT NULL,
	PRIMARY KEY (\`cast_id\`, \`stage\`)
);
`;


// 增量 DDL（0012：草稿箱升级为生成进程全程镜像——status 状态列 + updated_at 排序键）
export const SQLITE_DDL_0012 = `
ALTER TABLE \`persona_cast_drafts\` ADD COLUMN \`status\` text DEFAULT 'done' NOT NULL;
ALTER TABLE \`persona_cast_drafts\` ADD COLUMN \`updated_at\` integer DEFAULT 0 NOT NULL;
`;


// 增量 DDL（0013：记忆效价 valence——情绪二维模型，Russell 1980）
export const SQLITE_DDL_0013 = `
ALTER TABLE \`persona_memories\` ADD COLUMN \`valence\` integer DEFAULT 0 NOT NULL;
`;


// 增量 DDL（0014：persona_memories 扩展（情境签名 / 来源 / 生命周期））
export const SQLITE_DDL_0014 = `
ALTER TABLE \`persona_memories\` ADD COLUMN \`formula_version\` text DEFAULT 'v2_legacy' NOT NULL;
ALTER TABLE \`persona_memories\` ADD COLUMN \`situation_signature\` text;
ALTER TABLE \`persona_memories\` ADD COLUMN \`signature_estimated\` integer DEFAULT 0 NOT NULL;
ALTER TABLE \`persona_memories\` ADD COLUMN \`lifecycle\` text DEFAULT 'active' NOT NULL;
ALTER TABLE \`persona_memories\` ADD COLUMN \`origin\` text DEFAULT 'game' NOT NULL;
CREATE INDEX IF NOT EXISTS \`idx_pmem_sig\` ON \`persona_memories\` (\`situation_signature\`, \`lifecycle\`);
`;


// 增量 DDL（0015：personas 扩展（铸造基线快照））
export const SQLITE_DDL_0015 = `
ALTER TABLE \`personas\` ADD COLUMN \`params_baseline\` text;
ALTER TABLE \`personas\` ADD COLUMN \`baseline_estimated\` integer DEFAULT 0 NOT NULL;
`;


// 增量 DDL（0016：persona_drift_log 扩展（年代标记））
export const SQLITE_DDL_0016 = `
ALTER TABLE \`persona_drift_log\` ADD COLUMN \`era\` text DEFAULT 'v3' NOT NULL;
`;


// 增量 DDL（0017：v3 新表（场次 / 情境 / 角色 / 状态观测 / 台账 / 调制日志））
// 增量 DDL（0100：人格研究站 L0 重置 —— 关系网独立编号段，§26 最终模型）
export const SQLITE_DDL_0100 = `
ALTER TABLE \`persona_relations\` ADD COLUMN \`form\` TEXT NOT NULL DEFAULT 'CS';
ALTER TABLE \`persona_relations\` ADD COLUMN \`prototypicality\` REAL DEFAULT 1.0;
ALTER TABLE \`persona_relations\` ADD COLUMN \`power_balance\` INTEGER DEFAULT 0;
ALTER TABLE \`persona_relations\` ADD COLUMN \`formality\` INTEGER DEFAULT 0;
ALTER TABLE \`persona_relations\` ADD COLUMN \`commitment\` INTEGER DEFAULT 0;
ALTER TABLE \`persona_relations\` ADD COLUMN \`origin_module\` TEXT NOT NULL DEFAULT 'migration';
ALTER TABLE \`persona_relations\` ADD COLUMN \`origin_version\` TEXT NOT NULL DEFAULT 'interp-relations-1.0';
CREATE TABLE IF NOT EXISTS \`perceived_dyad_relations\` (
  \`id\` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  \`observer_id\` INTEGER NOT NULL,
  \`about_from_id\` INTEGER NOT NULL,
  \`about_to_id\` INTEGER NOT NULL,
  \`granularity\` TEXT NOT NULL,
  \`dimensions_json\` TEXT,
  \`confidence\` REAL DEFAULT 0,
  \`source\` TEXT NOT NULL,
  \`bias_kind\` TEXT,
  \`accuracy\` REAL,
  \`updated_at\` INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS \`persona_nickname_index\` (
  \`id\` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  \`persona_id\` INTEGER NOT NULL,
  \`text\` TEXT NOT NULL,
  \`layer\` TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS \`invocation_log\` (
  \`id\` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  \`game_id\` TEXT,
  \`turn\` INTEGER,
  \`persona_id\` INTEGER NOT NULL,
  \`situation_kind\` TEXT NOT NULL,
  \`invoked_sources\` TEXT,
  \`truncated\` TEXT,
  \`conflicts_resolved\` TEXT,
  \`context_hash\` TEXT NOT NULL,
  \`output_event_id\` INTEGER,
  \`created_at\` INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS \`idx_pdr\` ON \`perceived_dyad_relations\` (\`observer_id\`, \`about_from_id\`, \`about_to_id\`);
CREATE INDEX IF NOT EXISTS \`idx_pdr_observer\` ON \`perceived_dyad_relations\` (\`observer_id\`, \`updated_at\`);
CREATE UNIQUE INDEX IF NOT EXISTS \`idx_nni_text\` ON \`persona_nickname_index\` (\`text\`);
CREATE INDEX IF NOT EXISTS \`idx_nni_persona\` ON \`persona_nickname_index\` (\`persona_id\`);
CREATE INDEX IF NOT EXISTS \`idx_il_game\` ON \`invocation_log\` (\`game_id\`, \`turn\`);
CREATE INDEX IF NOT EXISTS \`idx_il_persona\` ON \`invocation_log\` (\`persona_id\`, \`created_at\`);
`;

// 增量 DDL（0022：悬空边 —— 对方未入库时先建边，靠 to_name 等待接合）
export const SQLITE_DDL_0022 = `
ALTER TABLE \`persona_relations\` ADD COLUMN \`to_name\` text;
DROP INDEX IF EXISTS \`idx_rel_dyad\`;
CREATE UNIQUE INDEX IF NOT EXISTS \`idx_rel_dyad\` ON \`persona_relations\` (\`from_persona_id\`, \`to_persona_id\`, IFNULL(\`to_name\`, ''), \`layer\`, \`kind\`);
`;

// 增量 DDL（0021：人格间称呼（昵称库）—— 让语言互动自然、让人格稳定互认）
export const SQLITE_DDL_0021 = `
ALTER TABLE \`persona_relations\` ADD COLUMN \`address_term\` text;
ALTER TABLE \`persona_relations\` ADD COLUMN \`address_kind\` text;
`;

// 增量 DDL（0020：人际网 5 表 + personas 2 列）
export const SQLITE_DDL_0020 = `
ALTER TABLE \`personas\` ADD COLUMN \`relations_status\` text NOT NULL DEFAULT 'pending';
ALTER TABLE \`personas\` ADD COLUMN \`relations_source_hash\` text;
CREATE TABLE IF NOT EXISTS \`persona_aliases\` (
  \`id\` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  \`persona_id\` INTEGER NOT NULL,
  \`alias\` TEXT NOT NULL,
  \`alias_kind\` TEXT NOT NULL DEFAULT 'canon',
  \`source\` TEXT NOT NULL DEFAULT 'cast',
  \`confidence\` REAL NOT NULL DEFAULT 1.0,
  \`created_at\` INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS \`persona_relations\` (
  \`id\` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  \`from_persona_id\` INTEGER NOT NULL,
  \`to_persona_id\` INTEGER NOT NULL,
  \`layer\` TEXT NOT NULL,
  \`kind\` TEXT NOT NULL,
  \`kind_source\` TEXT,
  \`positivity\` INTEGER DEFAULT 0,
  \`negativity\` INTEGER DEFAULT 0,
  \`trust\` INTEGER DEFAULT 50,
  \`trust_stage\` TEXT,
  \`closeness\` INTEGER DEFAULT 0,
  \`dependence\` INTEGER DEFAULT 0,
  \`reciprocity\` INTEGER DEFAULT 0,
  \`violation_count\` INTEGER DEFAULT 0 NOT NULL,
  \`script_text\` TEXT,
  \`hierarchy_rank\` INTEGER,
  \`basis\` TEXT,
  \`source_ref\` TEXT,
  \`evidence_ids\` TEXT,
  \`awareness\` TEXT NOT NULL DEFAULT 'full',
  \`disclosable\` INTEGER NOT NULL DEFAULT 1,
  \`status\` TEXT NOT NULL DEFAULT 'active',
  \`superseded_by\` INTEGER,
  \`created_at\` INTEGER NOT NULL,
  \`updated_at\` INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS \`relation_deltas\` (
  \`id\` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  \`relation_id\` INTEGER NOT NULL,
  \`from_persona_id\` INTEGER NOT NULL,
  \`to_persona_id\` INTEGER NOT NULL,
  \`layer\` TEXT NOT NULL,
  \`param\` TEXT NOT NULL,
  \`before_value\` INTEGER,
  \`after_value\` INTEGER,
  \`delta\` INTEGER,
  \`kind_before\` TEXT,
  \`kind_after\` TEXT,
  \`reason_kind\` TEXT NOT NULL,
  \`salience\` REAL,
  \`event_ids\` TEXT,
  \`game_id\` TEXT,
  \`evidence\` TEXT,
  \`verdict\` TEXT,
  \`corrected_from\` INTEGER,
  \`actor\` TEXT,
  \`mechanism_version\` TEXT NOT NULL,
  \`created_at\` INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS \`relation_completion_jobs\` (
  \`id\` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  \`user_id\` TEXT,
  \`scope\` TEXT NOT NULL,
  \`status\` TEXT NOT NULL DEFAULT 'pending',
  \`progress\` TEXT,
  \`stats\` TEXT,
  \`cost_estimate\` TEXT,
  \`created_at\` INTEGER NOT NULL,
  \`finished_at\` INTEGER
);
CREATE TABLE IF NOT EXISTS \`relation_completion_items\` (
  \`id\` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  \`job_id\` INTEGER NOT NULL,
  \`from_persona_id\` INTEGER NOT NULL,
  \`to_persona_id\` INTEGER NOT NULL,
  \`layer\` TEXT NOT NULL,
  \`param\` TEXT NOT NULL,
  \`action\` TEXT NOT NULL,
  \`before_json\` TEXT,
  \`after_json\` TEXT,
  \`source_tier\` TEXT,
  \`evidence\` TEXT,
  \`confidence\` REAL,
  \`user_decision\` TEXT DEFAULT 'pending',
  \`applied_at\` INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS \`idx_alias_uniq\` ON \`persona_aliases\` (\`alias\`);
CREATE INDEX IF NOT EXISTS \`idx_alias_persona\` ON \`persona_aliases\` (\`persona_id\`);
CREATE UNIQUE INDEX IF NOT EXISTS \`idx_rel_dyad\` ON \`persona_relations\` (\`from_persona_id\`, \`to_persona_id\`, \`layer\`, \`kind\`);
CREATE INDEX IF NOT EXISTS \`idx_rel_from\` ON \`persona_relations\` (\`from_persona_id\`, \`layer\`, \`status\`);
CREATE INDEX IF NOT EXISTS \`idx_rel_to\` ON \`persona_relations\` (\`to_persona_id\`, \`layer\`, \`status\`);
CREATE INDEX IF NOT EXISTS \`idx_rd_rel\` ON \`relation_deltas\` (\`relation_id\`, \`created_at\`);
CREATE INDEX IF NOT EXISTS \`idx_rd_pair\` ON \`relation_deltas\` (\`from_persona_id\`, \`to_persona_id\`, \`layer\`);
CREATE INDEX IF NOT EXISTS \`idx_rd_verdict\` ON \`relation_deltas\` (\`verdict\`);
CREATE INDEX IF NOT EXISTS \`idx_rci_job\` ON \`relation_completion_items\` (\`job_id\`, \`action\`);
`;

// 增量 DDL（0019：观测方向 + 去重索引 —— φ「同情境同向重复」的统计基础）
export const SQLITE_DDL_0019 = `
ALTER TABLE \`persona_state_observations\` ADD COLUMN \`direction\` text;
CREATE UNIQUE INDEX IF NOT EXISTS \`idx_pso_dedup\` ON \`persona_state_observations\` (\`persona_id\`, \`scenario_id\`, \`trait_path\`, \`direction\`);
`;

// 增量 DDL（0018：人格演化小数累积器 —— EWMA 单局位移常 <0.5 分，直接取整会归零）
export const SQLITE_DDL_0018 = `
ALTER TABLE \`personas\` ADD COLUMN \`params_residual\` text;
`;

export const SQLITE_DDL_0017 = `
CREATE TABLE IF NOT EXISTS \`scenarios\` (
  \`id\` text PRIMARY KEY NOT NULL,
  \`kind\` text NOT NULL,
  \`title_no\` text,
  \`status\` text DEFAULT 'created' NOT NULL,
  \`game_id\` text,
  \`constraint_level\` integer DEFAULT 2 NOT NULL,
  \`stakes_json\` text,
  \`participant_ids\` text,
  \`started_at\` integer,
  \`ended_at\` integer,
  \`config_json\` text,
  \`created_at\` integer NOT NULL
);
CREATE TABLE IF NOT EXISTS \`scenario_events\` (
  \`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  \`scenario_id\` text NOT NULL,
  \`seq\` integer NOT NULL,
  \`type\` text NOT NULL,
  \`actor\` integer,
  \`actor_label\` text,
  \`title\` text,
  \`content\` text,
  \`thought\` text,
  \`meta\` text,
  \`created_at\` integer NOT NULL
);
CREATE TABLE IF NOT EXISTS \`situation_classes\` (
  \`id\` text PRIMARY KEY NOT NULL,
  \`label\` text NOT NULL,
  \`scenario_kind\` text NOT NULL,
  \`constraint\` integer DEFAULT 2 NOT NULL,
  \`activated\` text NOT NULL,
  \`created_at\` integer NOT NULL
);
CREATE TABLE IF NOT EXISTS \`role_enrollments\` (
  \`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  \`persona_id\` integer NOT NULL,
  \`role_kind\` text NOT NULL,
  \`role_ref\` text NOT NULL,
  \`commitment\` integer DEFAULT 50 NOT NULL,
  \`scenario_id_enter\` text NOT NULL,
  \`scenario_id_exit\` text,
  \`entered_at\` integer NOT NULL,
  \`exited_at\` integer
);
CREATE TABLE IF NOT EXISTS \`role_events\` (
  \`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  \`enrollment_id\` integer NOT NULL,
  \`scenario_id\` text NOT NULL,
  \`commitment\` integer NOT NULL,
  \`note\` text,
  \`created_at\` integer NOT NULL
);
CREATE TABLE IF NOT EXISTS \`persona_state_observations\` (
  \`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  \`persona_id\` integer NOT NULL,
  \`scenario_id\` text NOT NULL,
  \`scenario_kind\` text NOT NULL,
  \`scenario_index\` integer NOT NULL,
  \`cumulative_salience\` integer DEFAULT 0 NOT NULL,
  \`trait_path\` text NOT NULL,
  \`state_value\` integer NOT NULL,
  \`situation_class_id\` text NOT NULL,
  \`situation_signature\` text NOT NULL,
  \`salience\` integer DEFAULT 50 NOT NULL,
  \`exposure_in_class\` integer DEFAULT 1 NOT NULL,
  \`indicator_kind\` text DEFAULT 'behavior' NOT NULL,
  \`rater_id\` integer,
  \`source_param\` text NOT NULL,
  \`evidence_quote\` text,
  \`created_at\` integer NOT NULL
);
CREATE TABLE IF NOT EXISTS \`persona_baselines\` (
  \`persona_id\` integer PRIMARY KEY NOT NULL,
  \`params_json\` text NOT NULL,
  \`profile_json\` text,
  \`cast_id\` text,
  \`cast_model\` text,
  \`fidelity_json\` text,
  \`created_at\` integer NOT NULL
);
CREATE TABLE IF NOT EXISTS \`persona_plasticity\` (
  \`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  \`persona_id\` integer NOT NULL,
  \`scenario_index\` integer NOT NULL,
  \`kappa\` real NOT NULL,
  \`determinants\` text NOT NULL,
  \`created_at\` integer NOT NULL
);
CREATE TABLE IF NOT EXISTS \`persona_trait_updates\` (
  \`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  \`persona_id\` integer NOT NULL,
  \`scenario_id\` text NOT NULL,
  \`trait_path\` text NOT NULL,
  \`value_from\` integer NOT NULL,
  \`value_to\` integer NOT NULL,
  \`alpha_eff\` real NOT NULL,
  \`factors_json\` text NOT NULL,
  \`observation_ids\` text NOT NULL,
  \`mechanism_version\` text NOT NULL,
  \`created_at\` integer NOT NULL
);
CREATE TABLE IF NOT EXISTS \`trait_decomposition\` (
  \`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  \`persona_id\` integer NOT NULL,
  \`trait_path\` text NOT NULL,
  \`window_from\` integer NOT NULL,
  \`window_to\` integer NOT NULL,
  \`est_normative\` real,
  \`est_corresponsive\` real,
  \`est_event\` real,
  \`est_noise\` real,
  \`identified\` integer DEFAULT 0 NOT NULL,
  \`method\` text NOT NULL,
  \`diagnostics\` text,
  \`created_at\` integer NOT NULL
);
CREATE TABLE IF NOT EXISTS \`persona_fidelity\` (
  \`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  \`persona_id\` integer NOT NULL,
  \`source_kind\` text NOT NULL,
  \`reference_json\` text,
  \`profile_correlation\` real,
  \`icc\` real,
  \`created_at\` integer NOT NULL
);
CREATE TABLE IF NOT EXISTS \`persona_modulation_log\` (
  \`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  \`persona_id\` integer NOT NULL,
  \`scenario_id\` text NOT NULL,
  \`turn\` integer NOT NULL,
  \`params_version\` text NOT NULL,
  \`mechanism_version\` text NOT NULL,
  \`attention_weights\` text,
  \`appraisal\` text,
  \`recalled_ids\` text,
  \`utility_shift\` text,
  \`suppression_ratio\` real,
  \`defense_applied\` text,
  \`subjective_state\` text,
  \`created_at\` integer NOT NULL
);
CREATE INDEX IF NOT EXISTS \`idx_scen_kind\` ON \`scenarios\` (\`kind\`);
CREATE INDEX IF NOT EXISTS \`idx_sev_scen\` ON \`scenario_events\` (\`scenario_id\`, \`seq\`);
CREATE INDEX IF NOT EXISTS \`idx_role_persona\` ON \`role_enrollments\` (\`persona_id\`);
CREATE INDEX IF NOT EXISTS \`idx_pso_model\` ON \`persona_state_observations\` (\`persona_id\`, \`trait_path\`, \`scenario_index\`);
CREATE INDEX IF NOT EXISTS \`idx_pso_class\` ON \`persona_state_observations\` (\`situation_class_id\`);
CREATE INDEX IF NOT EXISTS \`idx_plast_persona\` ON \`persona_plasticity\` (\`persona_id\`, \`scenario_index\`);
CREATE INDEX IF NOT EXISTS \`idx_ptu_persona\` ON \`persona_trait_updates\` (\`persona_id\`, \`trait_path\`);
CREATE UNIQUE INDEX IF NOT EXISTS \`idx_pml_turn\` ON \`persona_modulation_log\` (\`scenario_id\`, \`persona_id\`, \`turn\`);
`;

// 增量 DDL（0101：RSQ 关系自陈问卷 —— 一次填写 = 一条记录，保留完整历史）
export const SQLITE_DDL_0101 = `
CREATE TABLE IF NOT EXISTS \`rsq_responses\` (
  \`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  \`from_persona_id\` integer NOT NULL,
  \`to_persona_id\` integer NOT NULL,
  \`game_id\` text,
  \`battery_level\` text NOT NULL DEFAULT 'L',
  \`affection\` integer,
  \`antagonism\` integer,
  \`faith\` integer,
  \`commitment\` integer,
  \`forgiveness\` integer,
  \`closeness\` integer,
  \`ambivalence\` integer,
  \`equity_balance\` integer,
  \`dimensions_json\` text NOT NULL,
  \`derived_json\` text NOT NULL,
  \`validity_json\` text NOT NULL,
  \`raw_json\` text NOT NULL,
  \`feedback_json\` text,
  \`model\` text,
  \`items_version\` text NOT NULL,
  \`answered_at\` integer NOT NULL,
  \`created_at\` integer NOT NULL
);
CREATE INDEX IF NOT EXISTS \`idx_rsq_pair\` ON \`rsq_responses\` (\`from_persona_id\`, \`to_persona_id\`, \`answered_at\` DESC);
CREATE INDEX IF NOT EXISTS \`idx_rsq_game\` ON \`rsq_responses\` (\`game_id\`);
ALTER TABLE \`persona_relations\` ADD COLUMN \`rsq_response_id\` integer;
ALTER TABLE \`persona_relations\` ADD COLUMN \`rsq_affection\` integer;
ALTER TABLE \`persona_relations\` ADD COLUMN \`rsq_antagonism\` integer;
ALTER TABLE \`persona_relations\` ADD COLUMN \`rsq_faith\` integer;
ALTER TABLE \`persona_relations\` ADD COLUMN \`rsq_commitment\` integer;
ALTER TABLE \`persona_relations\` ADD COLUMN \`rsq_forgiveness\` integer;
ALTER TABLE \`persona_relations\` ADD COLUMN \`rsq_closeness\` integer;
ALTER TABLE \`persona_relations\` ADD COLUMN \`rsq_ambivalence\` integer;
ALTER TABLE \`persona_relations\` ADD COLUMN \`rsq_equity_balance\` integer;
ALTER TABLE \`persona_relations\` ADD COLUMN \`rsq_verdict\` text;
ALTER TABLE \`persona_relations\` ADD COLUMN \`rsq_updated_at\` integer;
`;

// 增量 DDL（0102：RSQ 第 120 题「一句话自评」）
export const SQLITE_DDL_0102 = `
ALTER TABLE \`rsq_responses\` ADD COLUMN \`self_summary\` text;
ALTER TABLE \`persona_relations\` ADD COLUMN \`rsq_self_summary\` text;
`;

// 增量 DDL（0103：现实层 · 单视角关系记忆 + 补完任务台账）
export const SQLITE_DDL_0103 = `
CREATE TABLE IF NOT EXISTS \`persona_canon_log\` (
  \`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  \`persona_id\` integer NOT NULL,
  \`about_persona_id\` integer NOT NULL,
  \`seq\` integer NOT NULL,
  \`phase\` text,
  \`era\` text NOT NULL,
  \`event_text\` text NOT NULL,
  \`feeling\` text NOT NULL,
  \`impact\` text,
  \`certainty\` text NOT NULL DEFAULT 'inferred',
  \`source_ref\` text,
  \`superseded\` integer NOT NULL DEFAULT 0,
  \`created_at\` integer NOT NULL
);
CREATE INDEX IF NOT EXISTS \`idx_pcl_pair\` ON \`persona_canon_log\` (\`persona_id\`, \`about_persona_id\`, \`seq\`);
CREATE INDEX IF NOT EXISTS \`idx_pcl_persona\` ON \`persona_canon_log\` (\`persona_id\`, \`created_at\`);
CREATE TABLE IF NOT EXISTS \`canon_backfill_jobs\` (
  \`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  \`persona_id\` integer NOT NULL,
  \`about_persona_id\` integer NOT NULL,
  \`status\` text NOT NULL DEFAULT 'pending',
  \`item_count\` integer NOT NULL DEFAULT 0,
  \`model\` text,
  \`prompt_version\` text,
  \`error\` text,
  \`created_at\` integer NOT NULL,
  \`finished_at\` integer
);
CREATE UNIQUE INDEX IF NOT EXISTS \`idx_cbj_pair\` ON \`canon_backfill_jobs\` (\`persona_id\`, \`about_persona_id\`);
`;

// 增量 DDL（0104：现实层事件的来源核查字段 + 用户手动编辑支持）
export const SQLITE_DDL_0104 = `
ALTER TABLE \`persona_canon_log\` ADD COLUMN \`source_count\` integer NOT NULL DEFAULT 0;
ALTER TABLE \`persona_canon_log\` ADD COLUMN \`sources_json\` text;
ALTER TABLE \`persona_canon_log\` ADD COLUMN \`verification\` text NOT NULL DEFAULT 'unverified';
ALTER TABLE \`persona_canon_log\` ADD COLUMN \`origin\` text NOT NULL DEFAULT 'ai';
`;

// 增量 DDL（0105：现实层「阶段」概念彻底删除；时间轴改为 时间 + 年龄 + 地点）
// 用户定调：phase 不是「改成可选」也不是「融进正文」，而是**概念性删除**——
// 该字段、该概念、以及围绕它的一切表述全部移除。
export const SQLITE_DDL_0105 = `
ALTER TABLE \`persona_canon_log\` ADD COLUMN \`age\` integer;
ALTER TABLE \`persona_canon_log\` ADD COLUMN \`place\` text;
ALTER TABLE \`persona_canon_log\` DROP COLUMN \`phase\`;
`;

// 增量 DDL（0106：现实层时间考究——保留最详细时间表达 + 推定依据）
export const SQLITE_DDL_0106 = `
ALTER TABLE \`persona_canon_log\` ADD COLUMN \`era_basis\` text;
`;

// 增量 DDL（0107：canon 补完任务统计/联网/警告字段）
export const SQLITE_DDL_0107 = `
ALTER TABLE \`canon_backfill_jobs\` ADD COLUMN \`stats\` text;
ALTER TABLE \`canon_backfill_jobs\` ADD COLUMN \`web_searched\` integer NOT NULL DEFAULT 0;
ALTER TABLE \`canon_backfill_jobs\` ADD COLUMN \`warning\` text;
`;

// 增量 DDL（0108：记事簿回写运行台账——幂等/失败重试）
export const SQLITE_DDL_0108 = `
CREATE TABLE IF NOT EXISTS \`persona_writeback_runs\` (
  \`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  \`persona_id\` integer NOT NULL,
  \`game_id\` text NOT NULL,
  \`seat\` integer NOT NULL,
  \`status\` text NOT NULL DEFAULT 'processing',
  \`error\` text,
  \`created_at\` integer NOT NULL,
  \`updated_at\` integer NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS \`idx_pwr_key\` ON \`persona_writeback_runs\` (\`persona_id\`, \`game_id\`, \`seat\`);
`;

// 增量 DDL（0109：关系网唯一键修正 + 别名/昵称改「按人格唯一」）
// 旧库可能已有同键 active 重复行：先保留最小 id 的一条，其余置 superseded，再建 partial unique。
export const SQLITE_DDL_0109 = `
UPDATE \`persona_relations\`
SET \`status\` = 'superseded', \`superseded_by\` = NULL
WHERE \`status\` = 'active'
  AND \`id\` NOT IN (
    SELECT MIN(\`id\`) FROM \`persona_relations\`
    WHERE \`status\` = 'active'
    GROUP BY \`from_persona_id\`, \`to_persona_id\`, IFNULL(\`to_name\`, ''), \`layer\`, \`kind\`
  );
DROP INDEX IF EXISTS \`idx_rel_dyad\`;
CREATE UNIQUE INDEX IF NOT EXISTS \`idx_rel_active\` ON \`persona_relations\` (\`from_persona_id\`, \`to_persona_id\`, IFNULL(\`to_name\`, ''), \`layer\`, \`kind\`) WHERE \`status\` = 'active';
DROP INDEX IF EXISTS \`idx_alias_uniq\`;
CREATE UNIQUE INDEX IF NOT EXISTS \`idx_alias_persona_name\` ON \`persona_aliases\` (\`persona_id\`, \`alias\`);
CREATE INDEX IF NOT EXISTS \`idx_alias_persona\` ON \`persona_aliases\` (\`persona_id\`);
DROP INDEX IF EXISTS \`idx_nni_text\`;
CREATE UNIQUE INDEX IF NOT EXISTS \`idx_nni_persona_text\` ON \`persona_nickname_index\` (\`persona_id\`, \`text\`);
CREATE INDEX IF NOT EXISTS \`idx_nni_persona\` ON \`persona_nickname_index\` (\`persona_id\`);
`;

// 增量 DDL（0110：现实层事件手动排序位——详情页拖动调整事件顺序）
export const SQLITE_DDL_0110 = `
ALTER TABLE \`persona_canon_log\` ADD COLUMN \`sort_order\` integer;
`;


// 增量 DDL（0111：记忆事件溯源——个人叙述与原始事实分轨保存）
export const SQLITE_DDL_0111 = `
CREATE TABLE IF NOT EXISTS \`persona_memory_evidence\` (
  \`memory_id\` integer NOT NULL,
  \`game_id\` text NOT NULL,
  \`event_seq\` integer NOT NULL,
  \`source\` text NOT NULL DEFAULT 'self_narrative',
  \`learned_at\` text NOT NULL DEFAULT 'postgame',
  \`narrative_version\` integer NOT NULL DEFAULT 1,
  \`supersedes\` integer,
  PRIMARY KEY (\`memory_id\`, \`game_id\`, \`event_seq\`)
);
CREATE INDEX IF NOT EXISTS \`idx_pme_memory\` ON \`persona_memory_evidence\` (\`memory_id\`);
`;
