// SQLite 方言镜像（桌面客户端用）：与 schema.mysql.ts 表名/列名逐一对应。
// 类型映射：varchar/text → TEXT；serial → INTEGER PRIMARY KEY AUTOINCREMENT；
// timestamp → INTEGER（epoch 毫秒，drizzle 映射 Date）；json → TEXT（drizzle mode json 自动序列化）。
// onUpdateNow 无 SQLite 等价物：updatedAt 由查询层显式写入（对 MySQL 亦无害）。
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const games = sqliteTable("games", {
  id: text("id").primaryKey(), // uuid
  boardId: text("board_id").notNull(),
  boardName: text("board_name").notNull(),
  titleNo: text("title_no").notNull().default(""), // 对局标题号：YYYYMMDD+当日序号(3位)
  status: text("status").notNull().default("created"), // created|running|paused|finished
  winner: text("winner"), // wolf|good|null
  dayCount: integer("day_count").notNull().default(1),
  playerCount: integer("player_count").notNull(),
  setup: text("setup", { mode: "json" }).notNull(),
  userId: text("user_id"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const gameDecisions = sqliteTable(
  "game_decisions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    gameId: text("game_id").notNull(),
    idx: integer("idx").notNull(), // 0-based 决策序号（重放顺序）
    kind: text("kind").notNull(),
    seat: integer("seat").notNull(),
    decision: text("decision", { mode: "json" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("idx_decisions_game_idx").on(t.gameId, t.idx)],
);

export const gameEvents = sqliteTable(
  "game_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    gameId: text("game_id").notNull(),
    seq: integer("seq").notNull(),
    day: integer("day").notNull(),
    phase: text("phase").notNull(),
    type: text("type").notNull(),
    actor: integer("actor"),
    actorLabel: text("actor_label"),
    title: text("title").notNull(),
    content: text("content").notNull(),
    thought: text("thought"),
    meta: text("meta", { mode: "json" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("idx_game_seq").on(t.gameId, t.seq)],
);

export const gameWinrates = sqliteTable(
  "game_winrates",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    gameId: text("game_id").notNull(),
    day: integer("day").notNull(),
    phase: text("phase").notNull(),
    goodPct: integer("good_pct").notNull(),
    wolfPct: integer("wolf_pct").notNull(),
    reasons: text("reasons", { mode: "json" }).notNull(),
    triggerLabel: text("trigger_label"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("idx_winrates_game_id").on(t.gameId, t.id)],
);

export const guideVersions = sqliteTable("guide_versions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  scope: text("scope").notNull().default("common"),
  version: integer("version").notNull(),
  content: text("content").notNull(),
  gameId: text("game_id"),
  note: text("note").notNull().default(""),
  userId: text("user_id"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const gameAnalyses = sqliteTable("game_analyses", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  gameId: text("game_id").notNull(),
  report: text("report").notNull(),
  model: text("model").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const apiPresets = sqliteTable("api_presets", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  provider: text("provider").notNull(),
  baseUrl: text("base_url").notNull().default(""),
  model: text("model").notNull().default(""),
  apiKey: text("api_key").notNull().default(""),
  userId: text("user_id"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// ---------------------------------------------------------------------------
// 账户系统
// ---------------------------------------------------------------------------

export const users = sqliteTable("users", {
  id: text("id").primaryKey(), // uuid
  email: text("email").notNull().unique(),
  username: text("username").notNull(),
  avatar: text("avatar").notNull(),
  passwordHash: text("password_hash").notNull(), // scrypt:N:r:p:salt:hash
  settings: text("settings", { mode: "json" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const sessions = sqliteTable(
  "sessions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    tokenHash: text("token_hash").notNull().unique(),
    userId: text("user_id").notNull(),
    remember: integer("remember").notNull().default(0),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("idx_sessions_user").on(t.userId)],
);

export const libraryDocs = sqliteTable("library_docs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  format: text("format").notNull(),
  content: text("content").notNull(),
  sizeBytes: integer("size_bytes").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const gameStudies = sqliteTable(
  "game_studies",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    gameId: text("game_id").notNull(),
    seat: integer("seat").notNull(),
    notes: text("notes").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("idx_studies_game").on(t.gameId, t.seat)],
);

// ---------------------------------------------------------------------------
// 人格研究库（数字人类心理学实验场）
// ---------------------------------------------------------------------------

export const personas = sqliteTable(
  "personas",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    source: text("source").notNull().default("manual"), // manual|ai-cast
    originName: text("origin_name"),
    originSource: text("origin_source"),
    profile: text("profile", { mode: "json" }).notNull(),
    params: text("params", { mode: "json" }).notNull(),
    notes: text("notes").notNull().default(""),
    imageData: text("image_data"), // 肖像配图 data URL
    gameCount: integer("game_count").notNull().default(0),
    // 回收站：非 null 即已软删（移入回收站），30 天保留期后惰性彻底删除；null=正常
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("idx_personas_user").on(t.userId)],
);

export const personaMemories = sqliteTable(
  "persona_memories",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    personaId: integer("persona_id").notNull(),
    gameId: text("game_id"),
    type: text("type").notNull().default("general"), // trauma|relationship|general
    content: text("content").notNull(),
    emotionalWeight: integer("emotional_weight").notNull().default(50),
    strength: integer("strength").notNull().default(50),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("idx_pmem_persona").on(t.personaId)],
);

export const personaRelationships = sqliteTable(
  "persona_relationships",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    personaId: integer("persona_id").notNull(),
    targetPersonaId: integer("target_persona_id"),
    targetName: text("target_name").notNull(),
    relation: text("relation").notNull().default(""),
    affinity: integer("affinity").notNull().default(0), // -100..100
    trust: integer("trust").notNull().default(50),
    note: text("note").notNull().default(""),
    gameId: text("game_id"),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("idx_prel_persona").on(t.personaId)],
);

// 关系历史（同 MySQL 侧 personaRelationshipHistory；逐局变迁追加，汇总行不动）
export const personaRelationshipHistory = sqliteTable(
  "persona_relationship_history",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    personaId: integer("persona_id").notNull(),
    targetPersonaId: integer("target_persona_id"),
    targetName: text("target_name").notNull(),
    gameId: text("game_id"),
    titleNo: text("title_no").notNull().default(""),
    relation: text("relation").notNull().default(""),
    affinityDelta: integer("affinity_delta").notNull().default(0),
    trustDelta: integer("trust_delta").notNull().default(0),
    affinity: integer("affinity").notNull().default(0),
    trust: integer("trust").notNull().default(50),
    note: text("note").notNull().default(""),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("idx_prelh_persona").on(t.personaId), index("idx_prelh_target").on(t.targetPersonaId)],
);

export const personaDriftLog = sqliteTable(
  "persona_drift_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    personaId: integer("persona_id").notNull(),
    gameId: text("game_id"),
    changes: text("changes", { mode: "json" }).notNull(),
    note: text("note").notNull().default(""),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("idx_pdrift_persona").on(t.personaId)],
);

export const personaReports = sqliteTable(
  "persona_reports",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    gameId: text("game_id").notNull(),
    personaId: integer("persona_id").notNull(),
    seat: integer("seat").notNull(),
    report: text("report").notNull(),
    model: text("model").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("idx_preport_game").on(t.gameId, t.personaId)],
);
