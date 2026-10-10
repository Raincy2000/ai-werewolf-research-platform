import {
  mysqlTable,
  serial,
  varchar,
  text,
  longtext,
  timestamp,
  int,
  json,
  index,
} from "drizzle-orm/mysql-core";

// 对局主表（AI key 不落盘，仅存运行内存）
export const games = mysqlTable("games", {
  id: varchar("id", { length: 36 }).primaryKey(), // uuid
  boardId: varchar("board_id", { length: 64 }).notNull(),
  boardName: varchar("board_name", { length: 128 }).notNull(),
  titleNo: varchar("title_no", { length: 16 }).notNull().default(""), // 对局标题号：YYYYMMDD+当日序号(3位)，如 20260811001
  status: varchar("status", { length: 16 }).notNull().default("created"), // created|running|paused|finished
  winner: varchar("winner", { length: 8 }), // wolf|good|null
  dayCount: int("day_count").notNull().default(1),
  playerCount: int("player_count").notNull(),
  // 座位角色分配与模型配置（apiKey 以 AES-GCM 密文形式存于 seatAIsEnc）
  setup: json("setup").notNull(), // { seatRoles: RoleId[], seatModels: string[], options: AdvancedOptions }
  userId: varchar("user_id", { length: 36 }), // 创建者（账户系统前的存量为 NULL，迁移后归属用户01）
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
});

// 决策日志表（append-only）：每次成功的 engine.decide 落盘一条，
// 用于服务重启/崩溃后的确定性重放恢复（引擎无随机源，按序重放决策即可精确重建任意断点）
export const gameDecisions = mysqlTable(
  "game_decisions",
  {
    id: serial("id").primaryKey(),
    gameId: varchar("game_id", { length: 36 }).notNull(),
    idx: int("idx").notNull(), // 0-based 决策序号（重放顺序）
    kind: varchar("kind", { length: 32 }).notNull(), // 决策类型（重放一致性校验）
    seat: int("seat").notNull(),
    decision: json("decision").notNull(), // 完整 DecisionInput {thought, speech, targets, skip, witchSave, duel, selfDestruct}
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("idx_decisions_game_idx").on(t.gameId, t.idx)],
);

// 事件流水表（append-only；seq 全局唯一递增游标由服务层保证 per-game）
export const gameEvents = mysqlTable(
  "game_events",
  {
    id: serial("id").primaryKey(),
    gameId: varchar("game_id", { length: 36 }).notNull(),
    seq: int("seq").notNull(),
    day: int("day").notNull(),
    phase: varchar("phase", { length: 64 }).notNull(),
    type: varchar("type", { length: 16 }).notNull(),
    actor: int("actor"),
    actorLabel: varchar("actor_label", { length: 32 }),
    title: varchar("title", { length: 128 }).notNull(),
    content: text("content").notNull(),
    thought: text("thought"),
    meta: json("meta"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("idx_game_seq").on(t.gameId, t.seq)],
);

// 胜率推测记录表（append-only）：分析师「胜率推测」开启的对局，每次评估落盘一条；
// id 自增即前端增量轮询游标（id > afterWinRateId 为新记录）
export const gameWinrates = mysqlTable(
  "game_winrates",
  {
    id: serial("id").primaryKey(),
    gameId: varchar("game_id", { length: 64 }).notNull(),
    day: int("day").notNull(),
    phase: varchar("phase", { length: 64 }).notNull(),
    goodPct: int("good_pct").notNull(), // 神民阵营胜率（0-100）
    wolfPct: int("wolf_pct").notNull(), // 狼人阵营胜率（0-100）
    reasons: json("reasons").notNull(), // 胜率变动理由（string[]，≤6 条、每条 ≤120 字）
    triggerLabel: varchar("trigger_label", { length: 255 }), // 触发事件锚点（如「4号狼人独立思考」；增量列，旧数据 NULL）
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("idx_winrates_game_id").on(t.gameId, t.id)],
);

export type GameRow = typeof games.$inferSelect;
export type GameEventRow = typeof gameEvents.$inferSelect;

// 经验指南版本表（每蒸馏一次追加一个版本，current = 该 scope 内最大 version）
// scope: "common" = 共通内容（所有版型通用）；其余为版型 id（该版型特定内容），各自独立版本序列
export const guideVersions = mysqlTable("guide_versions", {
  id: serial("id").primaryKey(),
  scope: varchar("scope", { length: 32 }).notNull().default("common"),
  version: int("version").notNull(),
  content: text("content").notNull(),
  gameId: varchar("game_id", { length: 36 }),
  note: varchar("note", { length: 255 }).notNull().default(""),
  userId: varchar("user_id", { length: 36 }), // 归属用户（存量 NULL 迁移至用户01）
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// 对局分析报告表（一局一份，重复生成则覆盖）
export const gameAnalyses = mysqlTable("game_analyses", {
  id: serial("id").primaryKey(),
  gameId: varchar("game_id", { length: 36 }).notNull(),
  report: text("report").notNull(),
  model: varchar("model", { length: 128 }).notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// API 存档表（用户保存的多套 AI 接入配置，一键取用到座位）
// apiKey 以 AES-256-GCM 密文存储（v1:iv:tag:cipher），仅服务端内存解密使用
export const apiPresets = mysqlTable("api_presets", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 64 }).notNull(),
  provider: varchar("provider", { length: 32 }).notNull(),
  baseUrl: varchar("base_url", { length: 256 }).notNull().default(""),
  model: varchar("model", { length: 128 }).notNull().default(""),
  apiKey: varchar("api_key", { length: 512 }).notNull().default(""),
  userId: varchar("user_id", { length: 36 }), // 归属用户（存量 NULL 迁移至用户01）
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
});

// ---------------------------------------------------------------------------
// 账户系统
// ---------------------------------------------------------------------------

// 用户表：邮箱唯一登录标识；用户可自定义用户名与头像（默认「用户-随机数字」+ 灰色抽象半身像）
// settings 为大厅工作配置与分析师配置的云端同步快照（登录后跨设备拉取/推送）
export const users = mysqlTable("users", {
  id: varchar("id", { length: 36 }).primaryKey(), // uuid
  email: varchar("email", { length: 255 }).notNull().unique(),
  username: varchar("username", { length: 64 }).notNull(),
  avatar: text("avatar").notNull(), // data URL（SVG 内置默认或用户上传的缩小图）
  passwordHash: varchar("password_hash", { length: 255 }).notNull(), // scrypt:N:r:p:salt:hash
  settings: json("settings"), // { lobby: PersistedLobby, analyst: AnalystSettings } | null
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// 会话表：库中只存 token 的 sha256（泄库不可还原会话）；remember 决定有效期
export const sessions = mysqlTable(
  "sessions",
  {
    id: serial("id").primaryKey(),
    tokenHash: varchar("token_hash", { length: 64 }).notNull().unique(),
    userId: varchar("user_id", { length: 36 }).notNull(),
    remember: int("remember").notNull().default(0), // 1=保留登录状态（30天） 0=会话级（12小时）
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("idx_sessions_user").on(t.userId)],
);

export type UserRow = typeof users.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;

// 图书馆文档表（用户上传的赛前学习资料；内容服务端提取为纯文本）
export const libraryDocs = mysqlTable("library_docs", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id", { length: 36 }).notNull(),
  name: varchar("name", { length: 128 }).notNull(),
  format: varchar("format", { length: 16 }).notNull(), // txt/md/pdf/docx…
  content: longtext("content").notNull(), // 提取后的纯文本（上传限 200KB）
  sizeBytes: int("size_bytes").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// 赛前学习笔记表（每对局每座位一份：AI 赛前自主学习图书馆资料形成的理解）
export const gameStudies = mysqlTable(
  "game_studies",
  {
    id: serial("id").primaryKey(),
    gameId: varchar("game_id", { length: 36 }).notNull(),
    seat: int("seat").notNull(),
    notes: text("notes").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("idx_studies_game").on(t.gameId, t.seat)],
);

// ---------------------------------------------------------------------------
// 人格研究库（数字人类心理学实验场）
// ---------------------------------------------------------------------------

// 人格参数卡主表：profile（人物档案）与 params（人格参数体）为 JSON，结构见 contracts/persona.ts
export const personas = mysqlTable(
  "personas",
  {
    id: serial("id").primaryKey(),
    userId: varchar("user_id", { length: 36 }).notNull(),
    name: varchar("name", { length: 64 }).notNull(),
    source: varchar("source", { length: 16 }).notNull().default("manual"), // manual|ai-cast
    originName: varchar("origin_name", { length: 128 }), // 原型人物名
    originSource: varchar("origin_source", { length: 128 }), // 出处（作品/现实）
    profile: json("profile").notNull(), // PersonaProfile
    params: json("params").notNull(), // PersonaParams（含 inferred 推断项路径）
    notes: text("notes").notNull().default(""),
    imageData: longtext("image_data"), // 肖像配图 data URL（base64；铸魂师联网搜取或用户上传）
    gameCount: int("game_count").notNull().default(0), // 已参与对局数
    // 回收站：非 null 即已软删（移入回收站），30 天保留期后惰性彻底删除；null=正常
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
  },
  (t) => [index("idx_personas_user").on(t.userId)],
);

// 自传体记忆表（记事簿）：跨对局保留；strength 支持衰减/强化
export const personaMemories = mysqlTable(
  "persona_memories",
  {
    id: serial("id").primaryKey(),
    personaId: int("persona_id").notNull(),
    gameId: varchar("game_id", { length: 36 }), // 出处对局（null=背景/手动记忆）
    type: varchar("type", { length: 16 }).notNull().default("general"), // trauma|relationship|general
    content: text("content").notNull(),
    emotionalWeight: int("emotional_weight").notNull().default(50), // 0-100
    strength: int("strength").notNull().default(50), // 0-100
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(), // 最近强化/衰减触碰
  },
  (t) => [index("idx_pmem_persona").on(t.personaId)],
);

// 关系图谱表（记事簿）：跨对局关系传递；affinity 负值=敌意
export const personaRelationships = mysqlTable(
  "persona_relationships",
  {
    id: serial("id").primaryKey(),
    personaId: int("persona_id").notNull(),
    targetPersonaId: int("target_persona_id"), // 对方亦为人格卡时链接
    targetName: varchar("target_name", { length: 128 }).notNull(),
    relation: varchar("relation", { length: 64 }).notNull().default(""), // 关系标签
    affinity: int("affinity").notNull().default(0), // -100..100 亲疏
    trust: int("trust").notNull().default(50), // 0..100 信任
    note: varchar("note", { length: 255 }).notNull().default(""),
    gameId: varchar("game_id", { length: 36 }), // 最近塑造该关系的对局
    updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
  },
  (t) => [index("idx_prel_persona").on(t.personaId)],
);

// 关系历史（人格锚点关系的逐局变迁：每次回写追加一行，亲疏/信任增量 + 当时快照；
// 汇总行仍走 persona_relationships upsert——列表看现状，折叠栏看沿革，科研价值在沿革）
export const personaRelationshipHistory = mysqlTable(
  "persona_relationship_history",
  {
    id: serial("id").primaryKey(),
    personaId: int("persona_id").notNull(),
    targetPersonaId: int("target_persona_id"), // 人格锚点目标（非人格锚点的逐局锚点已是天然历史，不入此表）
    targetName: varchar("target_name", { length: 128 }).notNull(),
    gameId: varchar("game_id", { length: 36 }),
    titleNo: varchar("title_no", { length: 16 }).notNull().default(""), // 对局标题号（展示用统一编号）
    relation: varchar("relation", { length: 64 }).notNull().default(""), // 当局关系标签
    affinityDelta: int("affinity_delta").notNull().default(0), // 当局亲疏增量
    trustDelta: int("trust_delta").notNull().default(0), // 当局信任增量
    affinity: int("affinity").notNull().default(0), // 当局结算后累计亲疏
    trust: int("trust").notNull().default(50), // 当局结算后累计信任
    note: varchar("note", { length: 255 }).notNull().default(""), // 当局关键事件
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("idx_prelh_persona").on(t.personaId), index("idx_prelh_target").on(t.targetPersonaId)],
);

// 人格漂移日志（附录留痕：长期参数跨对局逐次调整，from→to + 事由）
export const personaDriftLog = mysqlTable(
  "persona_drift_log",
  {
    id: serial("id").primaryKey(),
    personaId: int("persona_id").notNull(),
    gameId: varchar("game_id", { length: 36 }),
    changes: json("changes").notNull(), // PersonaDriftChange[]
    note: varchar("note", { length: 255 }).notNull().default(""),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("idx_pdrift_persona").on(t.personaId)],
);

// 心理检查报告表（心理检查师产出：一局一人格一份，重复生成则覆盖）
export const personaReports = mysqlTable(
  "persona_reports",
  {
    id: serial("id").primaryKey(),
    gameId: varchar("game_id", { length: 36 }).notNull(),
    personaId: int("persona_id").notNull(),
    seat: int("seat").notNull(),
    report: text("report").notNull(),
    model: varchar("model", { length: 128 }).notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("idx_preport_game").on(t.gameId, t.personaId)],
);
