import {
  primaryKey,
  mysqlTable,
  serial,
  varchar,
  text,
  longtext,
  timestamp,
  int,
  json,
  index,
  double,
  uniqueIndex,
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
// 人格研究站（数字人类心理学实验场）
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
    // 赛后自动书写认知笔记设置（同 SQLite）
    autoCognition: json("auto_cognition"),
    paramsBaseline: json("params_baseline"),
    paramsResidual: json("params_residual"),
    relationsStatus: varchar("relations_status", { length: 16 }).notNull().default("pending"),
    relationsSourceHash: varchar("relations_source_hash", { length: 64 }),
    baselineEstimated: int("baseline_estimated").notNull().default(0),
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
    valence: int("valence").notNull().default(0), // -100..100 效价（Russell 1980 情绪二维）
    formulaVersion: varchar("formula_version", { length: 16 }).notNull().default("v2_legacy"),
    situationSignature: varchar("situation_signature", { length: 128 }),
    signatureEstimated: int("signature_estimated").notNull().default(0),
    lifecycle: varchar("lifecycle", { length: 16 }).notNull().default("active"),
    origin: varchar("origin", { length: 16 }).notNull().default("game"),
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

// 铸造过程检查点（同 SQLite 侧 personaCastCheckpoints）
export const personaCastCheckpoints = mysqlTable(
  "persona_cast_checkpoints",
  {
    castId: varchar("cast_id", { length: 40 }).notNull(),
    stage: varchar("stage", { length: 32 }).notNull(),
    data: json("data").notNull(),
    updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
  },
  (t) => [primaryKey({ columns: [t.castId, t.stage] })],
);

// 自我认知笔记沿革（同 SQLite 侧 personaCognitionNotes）
export const personaCognitionNotes = mysqlTable(
  "persona_cognition_notes",
  {
    id: serial("id").primaryKey(),
    personaId: int("persona_id").notNull(),
    content: text("content").notNull(),
    model: varchar("model", { length: 64 }).notNull().default(""),
    opts: json("opts").notNull(),
    gameCount: int("game_count").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("idx_pcog_persona").on(t.personaId)],
);

// 铸造草稿持久化（同 SQLite 侧 personaCastDrafts）
export const personaCastDrafts = mysqlTable("persona_cast_drafts", {
  castId: varchar("cast_id", { length: 40 }).primaryKey(),
  userId: varchar("user_id", { length: 40 }),
  name: varchar("name", { length: 128 }).notNull().default(""),
  result: json("result").notNull(),
  // 生成进程状态（同 SQLite：queued/running/paused/interrupted/failed/done）
  status: varchar("status", { length: 16 }).notNull().default("done"),
  updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

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
    backfill: int("backfill").notNull().default(0), // 1=追溯回填（历史对局事后蒸馏）
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
    era: varchar("era", { length: 16 }).notNull().default("v3"), // pre_v3 | v3
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

// ============================================================
// v3 场次统一层与新表（与 schema.sqlite.ts 逐列对应）
// ⚠️ 不可命名为 sessions——该名已被登录会话表占用
// ============================================================
export const scenarios = mysqlTable(
  "scenarios",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    kind: varchar("kind", { length: 24 }).notNull(),
    titleNo: varchar("title_no", { length: 32 }),
    status: varchar("status", { length: 16 }).notNull().default("created"),
    gameId: varchar("game_id", { length: 36 }),
    constraintLevel: int("constraint_level").notNull().default(2),
    stakesJson: json("stakes_json"),
    participantIds: json("participant_ids"),
    startedAt: timestamp("started_at"),
    endedAt: timestamp("ended_at"),
    configJson: json("config_json"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("idx_scen_kind").on(t.kind)],
);

export const scenarioEvents = mysqlTable(
  "scenario_events",
  {
    id: serial("id").primaryKey(),
    scenarioId: varchar("scenario_id", { length: 36 }).notNull(),
    seq: int("seq").notNull(),
    type: varchar("type", { length: 32 }).notNull(),
    actor: int("actor"),
    actorLabel: varchar("actor_label", { length: 64 }),
    title: varchar("title", { length: 255 }),
    content: longtext("content"),
    thought: longtext("thought"),
    meta: json("meta"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("idx_sev_scen").on(t.scenarioId, t.seq)],
);

export const situationClasses = mysqlTable("situation_classes", {
  id: varchar("id", { length: 64 }).primaryKey(),
  label: varchar("label", { length: 128 }).notNull(),
  scenarioKind: varchar("scenario_kind", { length: 24 }).notNull(),
  constraint: int("constraint").notNull().default(2),
  activated: json("activated").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const roleEnrollments = mysqlTable(
  "role_enrollments",
  {
    id: serial("id").primaryKey(),
    personaId: int("persona_id").notNull(),
    roleKind: varchar("role_kind", { length: 32 }).notNull(),
    roleRef: varchar("role_ref", { length: 64 }).notNull(),
    commitment: int("commitment").notNull().default(50),
    scenarioIdEnter: varchar("scenario_id_enter", { length: 36 }).notNull(),
    scenarioIdExit: varchar("scenario_id_exit", { length: 36 }),
    enteredAt: timestamp("entered_at").notNull().defaultNow(),
    exitedAt: timestamp("exited_at"),
  },
  (t) => [index("idx_role_persona").on(t.personaId)],
);

export const roleEvents = mysqlTable("role_events", {
  id: serial("id").primaryKey(),
  enrollmentId: int("enrollment_id").notNull(),
  scenarioId: varchar("scenario_id", { length: 36 }).notNull(),
  commitment: int("commitment").notNull(),
  note: text("note"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const personaStateObservations = mysqlTable(
  "persona_state_observations",
  {
    id: serial("id").primaryKey(),
    personaId: int("persona_id").notNull(),
    scenarioId: varchar("scenario_id", { length: 36 }).notNull(),
    scenarioKind: varchar("scenario_kind", { length: 24 }).notNull(),
    scenarioIndex: int("scenario_index").notNull(),
    cumulativeSalience: int("cumulative_salience").notNull().default(0),
    traitPath: varchar("trait_path", { length: 64 }).notNull(),
    stateValue: int("state_value").notNull(),
    direction: varchar("direction", { length: 8 }),
    situationClassId: varchar("situation_class_id", { length: 64 }).notNull(),
    situationSignature: varchar("situation_signature", { length: 128 }).notNull(),
    salience: int("salience").notNull().default(50),
    exposureInClass: int("exposure_in_class").notNull().default(1),
    indicatorKind: varchar("indicator_kind", { length: 16 }).notNull().default("behavior"),
    raterId: int("rater_id"),
    sourceParam: varchar("source_param", { length: 64 }).notNull(),
    evidenceQuote: text("evidence_quote"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("idx_pso_model").on(t.personaId, t.traitPath, t.scenarioIndex),
    index("idx_pso_class").on(t.situationClassId),
  ],
);

export const personaBaselines = mysqlTable("persona_baselines", {
  personaId: int("persona_id").primaryKey(),
  paramsJson: json("params_json").notNull(),
  profileJson: json("profile_json"),
  castId: varchar("cast_id", { length: 36 }),
  castModel: varchar("cast_model", { length: 64 }),
  fidelityJson: json("fidelity_json"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const personaPlasticity = mysqlTable(
  "persona_plasticity",
  {
    id: serial("id").primaryKey(),
    personaId: int("persona_id").notNull(),
    scenarioIndex: int("scenario_index").notNull(),
    kappa: double("kappa").notNull(),
    determinants: json("determinants").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("idx_plast_persona").on(t.personaId, t.scenarioIndex)],
);

export const personaTraitUpdates = mysqlTable(
  "persona_trait_updates",
  {
    id: serial("id").primaryKey(),
    personaId: int("persona_id").notNull(),
    scenarioId: varchar("scenario_id", { length: 36 }).notNull(),
    traitPath: varchar("trait_path", { length: 64 }).notNull(),
    valueFrom: int("value_from").notNull(),
    valueTo: int("value_to").notNull(),
    alphaEff: double("alpha_eff").notNull(),
    factorsJson: json("factors_json").notNull(),
    observationIds: json("observation_ids").notNull(),
    mechanismVersion: varchar("mechanism_version", { length: 32 }).notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("idx_ptu_persona").on(t.personaId, t.traitPath)],
);

export const traitDecomposition = mysqlTable("trait_decomposition", {
  id: serial("id").primaryKey(),
  personaId: int("persona_id").notNull(),
  traitPath: varchar("trait_path", { length: 64 }).notNull(),
  windowFrom: int("window_from").notNull(),
  windowTo: int("window_to").notNull(),
  estNormative: double("est_normative"),
  estCorresponsive: double("est_corresponsive"),
  estEvent: double("est_event"),
  estNoise: double("est_noise"),
  identified: int("identified").notNull().default(0),
  method: varchar("method", { length: 16 }).notNull(),
  diagnostics: json("diagnostics"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const personaFidelity = mysqlTable("persona_fidelity", {
  id: serial("id").primaryKey(),
  personaId: int("persona_id").notNull(),
  sourceKind: varchar("source_kind", { length: 32 }).notNull(),
  referenceJson: json("reference_json"),
  profileCorrelation: double("profile_correlation"),
  icc: double("icc"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const personaModulationLog = mysqlTable(
  "persona_modulation_log",
  {
    id: serial("id").primaryKey(),
    personaId: int("persona_id").notNull(),
    scenarioId: varchar("scenario_id", { length: 36 }).notNull(),
    turn: int("turn").notNull(),
    paramsVersion: varchar("params_version", { length: 32 }).notNull(),
    mechanismVersion: varchar("mechanism_version", { length: 32 }).notNull(),
    attentionWeights: json("attention_weights"),
    appraisal: json("appraisal"),
    recalledIds: json("recalled_ids"),
    utilityShift: json("utility_shift"),
    suppressionRatio: double("suppression_ratio"),
    defenseApplied: json("defense_applied"),
    subjectiveState: text("subjective_state"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("idx_pml_turn").on(t.scenarioId, t.personaId, t.turn)],
);

// 人际网（与 schema.sqlite.ts 逐列对应）
export const personaAliases = mysqlTable(
  "persona_aliases",
  {
    id: serial("id").primaryKey(),
    personaId: int("persona_id").notNull(),
    alias: varchar("alias", { length: 128 }).notNull(),
    aliasKind: varchar("alias_kind", { length: 24 }).notNull().default("canon"),
    source: varchar("source", { length: 16 }).notNull().default("cast"),
    confidence: double("confidence").notNull().default(1),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("idx_alias_persona_name").on(t.personaId, t.alias), index("idx_alias_persona").on(t.personaId)],
);

export const personaRelations = mysqlTable(
  "persona_relations",
  {
    id: serial("id").primaryKey(),
    fromPersonaId: int("from_persona_id").notNull(),
    toPersonaId: int("to_persona_id").notNull(), // 0 = 悬空
    toName: varchar("to_name", { length: 64 }),
    layer: varchar("layer", { length: 8 }).notNull(),
    kind: varchar("kind", { length: 32 }).notNull(),
    kindSource: varchar("kind_source", { length: 8 }), // 废弃
    form: varchar("form", { length: 4 }).notNull().default("CS"),
    prototypicality: double("prototypicality").default(1),
    positivity: int("positivity").default(0),
    negativity: int("negativity").default(0),
    trust: int("trust").default(50),
    trustStage: varchar("trust_stage", { length: 24 }),
    commitment: int("commitment").default(0),
    closeness: int("closeness").default(0),
    dependence: int("dependence").default(0),
    reciprocity: int("reciprocity").default(0),
    powerBalance: int("power_balance").default(0),
    formality: int("formality").default(0),
    violationCount: int("violation_count").notNull().default(0),
    scriptText: text("script_text"),
    addressTerm: varchar("address_term", { length: 64 }),
    addressKind: varchar("address_kind", { length: 16 }),
    hierarchyRank: int("hierarchy_rank"),
    basis: text("basis"),
    sourceRef: varchar("source_ref", { length: 64 }),
    evidenceIds: json("evidence_ids"),
    awareness: varchar("awareness", { length: 16 }).notNull().default("full"),
    disclosable: int("disclosable").notNull().default(1),
    originModule: varchar("origin_module", { length: 32 }).notNull().default("migration"),
    originVersion: varchar("origin_version", { length: 32 }).notNull().default("interp-relations-1.0"),
    status: varchar("status", { length: 16 }).notNull().default("active"),
    supersededBy: int("superseded_by"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    // ---- RSQ 关系自陈问卷（§43）----
    rsqResponseId: int("rsq_response_id"),
    rsqAffection: int("rsq_affection"),
    rsqAntagonism: int("rsq_antagonism"),
    rsqFaith: int("rsq_faith"),
    rsqCommitment: int("rsq_commitment"),
    rsqForgiveness: int("rsq_forgiveness"),
    rsqCloseness: int("rsq_closeness"),
    rsqAmbivalence: int("rsq_ambivalence"),
    rsqEquityBalance: int("rsq_equity_balance"),
    rsqVerdict: varchar("rsq_verdict", { length: 24 }),
    rsqSelfSummary: text("rsq_self_summary"),
    rsqUpdatedAt: timestamp("rsq_updated_at"),
  },
  (t) => [
    // 2026-10-22：唯一约束改为「仅 active 行唯一」且悬空边把 to_name 纳入键；
    // MySQL 由 db/mysql-ddl.ts 用生成列 active_marker + 唯一索引实现（schema 仅作查询/参考）。
    index("idx_rel_active").on(t.fromPersonaId, t.toPersonaId, t.toName, t.layer, t.kind),
    index("idx_rel_from").on(t.fromPersonaId, t.layer, t.status),
    index("idx_rel_to").on(t.toPersonaId, t.layer, t.status),
  ],
);

export const relationDeltas = mysqlTable(
  "relation_deltas",
  {
    id: serial("id").primaryKey(),
    relationId: int("relation_id").notNull(),
    fromPersonaId: int("from_persona_id").notNull(),
    toPersonaId: int("to_persona_id").notNull(),
    layer: varchar("layer", { length: 8 }).notNull(),
    param: varchar("param", { length: 32 }).notNull(),
    beforeValue: int("before_value"),
    afterValue: int("after_value"),
    delta: int("delta"),
    kindBefore: text("kind_before"),
    kindAfter: text("kind_after"),
    reasonKind: varchar("reason_kind", { length: 24 }).notNull(),
    salience: double("salience"),
    eventIds: json("event_ids"),
    gameId: varchar("game_id", { length: 36 }),
    evidence: json("evidence"),
    verdict: varchar("verdict", { length: 24 }),
    correctedFrom: int("corrected_from"),
    actor: varchar("actor", { length: 32 }),
    mechanismVersion: varchar("mechanism_version", { length: 32 }).notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("idx_rd_rel").on(t.relationId, t.createdAt),
    index("idx_rd_pair").on(t.fromPersonaId, t.toPersonaId, t.layer),
    index("idx_rd_verdict").on(t.verdict),
  ],
);

export const relationCompletionJobs = mysqlTable("relation_completion_jobs", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id", { length: 36 }),
  scope: text("scope").notNull(),
  status: varchar("status", { length: 16 }).notNull().default("pending"),
  progress: text("progress"),
  stats: text("stats"),
  costEstimate: text("cost_estimate"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  finishedAt: timestamp("finished_at"),
});

export const relationCompletionItems = mysqlTable(
  "relation_completion_items",
  {
    id: serial("id").primaryKey(),
    jobId: int("job_id").notNull(),
    fromPersonaId: int("from_persona_id").notNull(),
    toPersonaId: int("to_persona_id").notNull(),
    layer: varchar("layer", { length: 8 }).notNull(),
    param: varchar("param", { length: 32 }).notNull(),
    action: varchar("action", { length: 16 }).notNull(),
    beforeJson: json("before_json"),
    afterJson: json("after_json"),
    sourceTier: varchar("source_tier", { length: 16 }),
    evidence: text("evidence"),
    confidence: double("confidence"),
    userDecision: varchar("user_decision", { length: 16 }).default("pending"),
    appliedAt: timestamp("applied_at"),
  },
  (t) => [index("idx_rci_job").on(t.jobId, t.action)],
);

// 二阶关系认知 / 昵称索引 / 调用台账
export const perceivedDyadRelations = mysqlTable(
  "perceived_dyad_relations",
  {
    id: serial("id").primaryKey(),
    observerId: int("observer_id").notNull(),
    aboutFromId: int("about_from_id").notNull(),
    aboutToId: int("about_to_id").notNull(),
    granularity: varchar("granularity", { length: 4 }).notNull(),
    dimensionsJson: json("dimensions_json"),
    confidence: double("confidence").default(0),
    source: varchar("source", { length: 16 }).notNull(),
    biasKind: varchar("bias_kind", { length: 16 }),
    accuracy: double("accuracy"),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("idx_pdr").on(t.observerId, t.aboutFromId, t.aboutToId),
    index("idx_pdr_observer").on(t.observerId, t.updatedAt),
  ],
);
export const personaNicknameIndex = mysqlTable(
  "persona_nickname_index",
  {
    id: serial("id").primaryKey(),
    personaId: int("persona_id").notNull(),
    text: varchar("text", { length: 128 }).notNull(),
    layer: varchar("layer", { length: 16 }).notNull(),
  },
  (t) => [uniqueIndex("idx_nni_persona_text").on(t.personaId, t.text), index("idx_nni_persona").on(t.personaId)],
);
export const invocationLog = mysqlTable(
  "invocation_log",
  {
    id: serial("id").primaryKey(),
    gameId: varchar("game_id", { length: 36 }),
    turn: int("turn"),
    personaId: int("persona_id").notNull(),
    situationKind: varchar("situation_kind", { length: 24 }).notNull(),
    invokedSources: json("invoked_sources"),
    truncated: json("truncated"),
    conflictsResolved: json("conflicts_resolved"),
    contextHash: varchar("context_hash", { length: 64 }).notNull(),
    outputEventId: int("output_event_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("idx_il_game").on(t.gameId, t.turn),
    index("idx_il_persona").on(t.personaId, t.createdAt),
  ],
);

// ============================================================
// RSQ 关系自陈问卷响应（§43）
// ============================================================
export const rsqResponses = mysqlTable(
  "rsq_responses",
  {
    id: serial("id").primaryKey(),
    fromPersonaId: int("from_persona_id").notNull(),
    toPersonaId: int("to_persona_id").notNull(),
    gameId: varchar("game_id", { length: 64 }),
    batteryLevel: varchar("battery_level", { length: 2 }).notNull().default("L"),
    affection: int("affection"),
    antagonism: int("antagonism"),
    faith: int("faith"),
    commitment: int("commitment"),
    forgiveness: int("forgiveness"),
    closeness: int("closeness"),
    ambivalence: int("ambivalence"),
    equityBalance: int("equity_balance"),
    dimensionsJson: text("dimensions_json").notNull(),
    derivedJson: text("derived_json").notNull(),
    validityJson: text("validity_json").notNull(),
    rawJson: text("raw_json").notNull(),
    feedbackJson: text("feedback_json"),
    /** 第 120 题：角色自评（<=36 字）*/
    selfSummary: text("self_summary"),
    model: varchar("model", { length: 64 }),
    itemsVersion: varchar("items_version", { length: 32 }).notNull(),
    answeredAt: timestamp("answered_at").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("idx_rsq_pair").on(t.fromPersonaId, t.toPersonaId, t.answeredAt),
    index("idx_rsq_game").on(t.gameId),
  ],
);

// ============================================================
// 现实层（L1）：单视角关系记忆
// ============================================================
export const personaCanonLog = mysqlTable(
  "persona_canon_log",
  {
    id: serial("id").primaryKey(),
    personaId: int("persona_id").notNull(),
    aboutPersonaId: int("about_persona_id").notNull(),
    seq: int("seq").notNull(),
    /** 手动排序位（拖动排序后写入；null=按时间线时代排序）(2026-10-22) */
    sortOrder: int("sort_order"),
    era: varchar("era", { length: 64 }).notNull(),
    age: int("age"),
    place: varchar("place", { length: 128 }),
    eraBasis: text("era_basis"),
    eventText: text("event_text").notNull(),
    feeling: text("feeling").notNull(),
    impact: text("impact"),
    certainty: varchar("certainty", { length: 16 }).notNull().default("inferred"),
    sourceRef: text("source_ref"),
    sourceCount: int("source_count").notNull().default(0),
    sourcesJson: text("sources_json"),
    verification: varchar("verification", { length: 24 }).notNull().default("unverified"),
    origin: varchar("origin", { length: 16 }).notNull().default("ai"),
    superseded: int("superseded").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("idx_pcl_pair").on(t.personaId, t.aboutPersonaId, t.seq),
    index("idx_pcl_persona").on(t.personaId, t.createdAt),
  ],
);

export const canonBackfillJobs = mysqlTable(
  "canon_backfill_jobs",
  {
    id: serial("id").primaryKey(),
    personaId: int("persona_id").notNull(),
    aboutPersonaId: int("about_persona_id").notNull(),
    status: varchar("status", { length: 16 }).notNull().default("pending"),
    itemCount: int("item_count").notNull().default(0),
    model: varchar("model", { length: 64 }),
    promptVersion: varchar("prompt_version", { length: 32 }),
    error: text("error"),
    /** 2026-10-22：补完统计 JSON / 是否联网 / 降级警告 */
    stats: text("stats"),
    webSearched: int("web_searched").notNull().default(0),
    warning: text("warning"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    finishedAt: timestamp("finished_at"),
  },
  (t) => [uniqueIndex("idx_cbj_pair").on(t.personaId, t.aboutPersonaId)],
);

/** 记事簿回写运行台账（2026-10-22）：(persona,game,seat) 幂等守卫 + 失败可重试 */
export const personaWritebackRuns = mysqlTable(
  "persona_writeback_runs",
  {
    id: serial("id").primaryKey(),
    personaId: int("persona_id").notNull(),
    gameId: varchar("game_id", { length: 64 }).notNull(),
    seat: int("seat").notNull(),
    status: varchar("status", { length: 16 }).notNull().default("processing"),
    error: text("error"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("idx_pwr_key").on(t.personaId, t.gameId, t.seat)],
);
