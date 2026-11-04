// SQLite 方言镜像（桌面客户端用）：与 schema.mysql.ts 表名/列名逐一对应。
// 类型映射：varchar/text → TEXT；serial → INTEGER PRIMARY KEY AUTOINCREMENT；
// timestamp → INTEGER（epoch 毫秒，drizzle 映射 Date）；json → TEXT（drizzle mode json 自动序列化）。
// onUpdateNow 无 SQLite 等价物：updatedAt 由查询层显式写入（对 MySQL 亦无害）。
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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
// 人格研究站（数字人类心理学实验场）
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
    // 赛后自动书写认知笔记的设置（null=关闭；{enabled,includeReports,includeDrift}）
    autoCognition: text("auto_cognition", { mode: "json" }),
    paramsBaseline: text("params_baseline", { mode: "json" }),
    paramsResidual: text("params_residual", { mode: "json" }),
    relationsStatus: text("relations_status").notNull().default("pending"),
    relationsSourceHash: text("relations_source_hash"),
    baselineEstimated: integer("baseline_estimated").notNull().default(0),
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
    valence: integer("valence").notNull().default(0), // -100..100 效价（Russell 1980 情绪二维）
    formulaVersion: text("formula_version").notNull().default("v2_legacy"),
    situationSignature: text("situation_signature"),
    signatureEstimated: integer("signature_estimated").notNull().default(0),
    lifecycle: text("lifecycle").notNull().default("active"), // active | archived
    origin: text("origin").notNull().default("game"), // game | self_narrative | manual
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
// 铸造草稿持久化（铸魂师产物在入库前的安身之处：内存登记处 30 分钟清扫/进程重启
// 都会丢草稿——20261013 实锤：同学生成完人格隔段时间再点「核对草稿」，现场已消失。
// done 且有 result 的条目落此表，重启后重新水合进登记处）
// 自我认知笔记沿革（人格以第一人称写下的自我认知；最新篇同步进 profile.essence 供对局注入，
// 本表存全部版本——自我叙事的演变轨迹是纵向研究数据）
// 铸造过程检查点（草稿箱的地基：①搜集档案/②深读成稿/肖像候选/铸造参数逐阶段落盘——
// 进程死掉、断电、误关都不丢进度，重启后从断点续铸；空心草稿在机制上不可能再出现）
export const personaCastCheckpoints = sqliteTable(
  "persona_cast_checkpoints",
  {
    castId: text("cast_id").notNull(),
    stage: text("stage").notNull(), // params | pool | dossier | reading | portraits
    data: text("data", { mode: "json" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [primaryKey({ columns: [t.castId, t.stage] })],
);

export const personaCognitionNotes = sqliteTable(
  "persona_cognition_notes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    personaId: integer("persona_id").notNull(),
    content: text("content").notNull(),
    model: text("model").notNull().default(""), // 书写所用模型
    opts: text("opts", { mode: "json" }).notNull().default({}), // 可见性开关快照
    gameCount: integer("game_count").notNull().default(0), // 书写时的参战局数
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("idx_pcog_persona").on(t.personaId)],
);

export const personaCastDrafts = sqliteTable(
  "persona_cast_drafts",
  {
    castId: text("cast_id").primaryKey(),
    userId: text("user_id"),
    name: text("name").notNull().default(""),
    result: text("result", { mode: "json" }).notNull(),
    // 生成进程状态镜像（queued/running/paused/interrupted/failed/done/saved）——
    // 2026-10-14 实锤：此二列曾在 DDL 层加了却漏登记 schema，drizzle 读写静默丢弃，
    // 核销 saved 永远落不下去、水合读不出 done 状态 → 草稿「核对入库后消失」事故的根因
    status: text("status").notNull().default("done"),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
);

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
    backfill: integer("backfill").notNull().default(0), // 1=追溯回填（历史对局事后蒸馏，区别于赛后实时回写）
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
    era: text("era").notNull().default("v3"), // pre_v3 | v3
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

// ============================================================
// v3 场次统一层与新表（设计文档 §4.1 / §11.4）
// ⚠️ 不可命名为 sessions——该名已被登录会话表占用
// ============================================================
export const scenarios = sqliteTable(
  "scenarios",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(), // game | solitude | symposium | tournament
    titleNo: text("title_no"),
    status: text("status").notNull().default("created"),
    gameId: text("game_id"),
    constraintLevel: integer("constraint_level").notNull().default(2),
    stakesJson: text("stakes_json", { mode: "json" }),
    participantIds: text("participant_ids", { mode: "json" }),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    endedAt: integer("ended_at", { mode: "timestamp_ms" }),
    configJson: text("config_json", { mode: "json" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [index("idx_scen_kind").on(t.kind)],
);

export const scenarioEvents = sqliteTable(
  "scenario_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    scenarioId: text("scenario_id").notNull(),
    seq: integer("seq").notNull(),
    type: text("type").notNull(),
    actor: integer("actor"),
    actorLabel: text("actor_label"),
    title: text("title"),
    content: text("content"),
    thought: text("thought"),
    meta: text("meta", { mode: "json" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [index("idx_sev_scen").on(t.scenarioId, t.seq)],
);

export const situationClasses = sqliteTable("situation_classes", {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  scenarioKind: text("scenario_kind").notNull(),
  constraint: integer("constraint").notNull().default(2),
  activated: text("activated", { mode: "json" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

export const roleEnrollments = sqliteTable(
  "role_enrollments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    personaId: integer("persona_id").notNull(),
    roleKind: text("role_kind").notNull(),
    roleRef: text("role_ref").notNull(),
    commitment: integer("commitment").notNull().default(50),
    scenarioIdEnter: text("scenario_id_enter").notNull(),
    scenarioIdExit: text("scenario_id_exit"),
    enteredAt: integer("entered_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
    exitedAt: integer("exited_at", { mode: "timestamp_ms" }),
  },
  (t) => [index("idx_role_persona").on(t.personaId)],
);

export const roleEvents = sqliteTable("role_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  enrollmentId: integer("enrollment_id").notNull(),
  scenarioId: text("scenario_id").notNull(),
  commitment: integer("commitment").notNull(),
  note: text("note"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

export const personaStateObservations = sqliteTable(
  "persona_state_observations",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    personaId: integer("persona_id").notNull(),
    scenarioId: text("scenario_id").notNull(),
    scenarioKind: text("scenario_kind").notNull(),
    scenarioIndex: integer("scenario_index").notNull(),
    cumulativeSalience: integer("cumulative_salience").notNull().default(0),
    traitPath: text("trait_path").notNull(),
    stateValue: integer("state_value").notNull(),
    direction: text("direction"), // up | down（φ 统计用）
    situationClassId: text("situation_class_id").notNull(),
    situationSignature: text("situation_signature").notNull(),
    salience: integer("salience").notNull().default(50),
    exposureInClass: integer("exposure_in_class").notNull().default(1),
    indicatorKind: text("indicator_kind").notNull().default("behavior"),
    raterId: integer("rater_id"),
    sourceParam: text("source_param").notNull(),
    evidenceQuote: text("evidence_quote"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [
    index("idx_pso_model").on(t.personaId, t.traitPath, t.scenarioIndex),
    index("idx_pso_class").on(t.situationClassId),
  ],
);

export const personaBaselines = sqliteTable("persona_baselines", {
  personaId: integer("persona_id").primaryKey(),
  paramsJson: text("params_json", { mode: "json" }).notNull(),
  profileJson: text("profile_json", { mode: "json" }),
  castId: text("cast_id"),
  castModel: text("cast_model"),
  fidelityJson: text("fidelity_json", { mode: "json" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

export const personaPlasticity = sqliteTable(
  "persona_plasticity",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    personaId: integer("persona_id").notNull(),
    scenarioIndex: integer("scenario_index").notNull(),
    kappa: real("kappa").notNull(),
    determinants: text("determinants", { mode: "json" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [index("idx_plast_persona").on(t.personaId, t.scenarioIndex)],
);

export const personaTraitUpdates = sqliteTable(
  "persona_trait_updates",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    personaId: integer("persona_id").notNull(),
    scenarioId: text("scenario_id").notNull(),
    traitPath: text("trait_path").notNull(),
    valueFrom: integer("value_from").notNull(),
    valueTo: integer("value_to").notNull(),
    alphaEff: real("alpha_eff").notNull(),
    factorsJson: text("factors_json", { mode: "json" }).notNull(),
    observationIds: text("observation_ids", { mode: "json" }).notNull(),
    mechanismVersion: text("mechanism_version").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [index("idx_ptu_persona").on(t.personaId, t.traitPath)],
);

export const traitDecomposition = sqliteTable("trait_decomposition", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  personaId: integer("persona_id").notNull(),
  traitPath: text("trait_path").notNull(),
  windowFrom: integer("window_from").notNull(),
  windowTo: integer("window_to").notNull(),
  estNormative: real("est_normative"),
  estCorresponsive: real("est_corresponsive"),
  estEvent: real("est_event"),
  estNoise: real("est_noise"),
  identified: integer("identified").notNull().default(0),
  method: text("method").notNull(),
  diagnostics: text("diagnostics", { mode: "json" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

export const personaFidelity = sqliteTable("persona_fidelity", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  personaId: integer("persona_id").notNull(),
  sourceKind: text("source_kind").notNull(),
  referenceJson: text("reference_json", { mode: "json" }),
  profileCorrelation: real("profile_correlation"),
  icc: real("icc"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

export const personaModulationLog = sqliteTable(
  "persona_modulation_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    personaId: integer("persona_id").notNull(),
    scenarioId: text("scenario_id").notNull(),
    turn: integer("turn").notNull(),
    paramsVersion: text("params_version").notNull(),
    mechanismVersion: text("mechanism_version").notNull(),
    attentionWeights: text("attention_weights", { mode: "json" }),
    appraisal: text("appraisal", { mode: "json" }),
    recalledIds: text("recalled_ids", { mode: "json" }),
    utilityShift: text("utility_shift", { mode: "json" }),
    suppressionRatio: real("suppression_ratio"),
    defenseApplied: text("defense_applied", { mode: "json" }),
    subjectiveState: text("subjective_state"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex("idx_pml_turn").on(t.scenarioId, t.personaId, t.turn)],
);

// ============================================================
// 人际网（Interpersonal Graph）—— docs/interpersonal-graph-design.md
// 学术校准：双维情感 / 增量校正 / 转折点 / 信任留疤
// ============================================================
export const personaAliases = sqliteTable(
  "persona_aliases",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    personaId: integer("persona_id").notNull(),
    alias: text("alias").notNull(),
    aliasKind: text("alias_kind").notNull().default("canon"),
    source: text("source").notNull().default("cast"),
    confidence: real("confidence").notNull().default(1),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex("idx_alias_persona_name").on(t.personaId, t.alias), index("idx_alias_persona").on(t.personaId)],
);

export const personaRelations = sqliteTable(
  "persona_relations",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    fromPersonaId: integer("from_persona_id").notNull(),
    toPersonaId: integer("to_persona_id").notNull(), // 0 = 悬空（对方未入库）
    toName: text("to_name"),
    layer: text("layer").notNull(), // canon | vale
    kind: text("kind").notNull(),
    kindSource: text("kind_source"), // 旧字段（已废弃，改用 form）
    form: text("form").notNull().default("CS"),
    prototypicality: real("prototypicality").default(1),
    positivity: integer("positivity").default(0), // 正面情感存量（§12.2）
    negativity: integer("negativity").default(0), // 负面情感存量
    trust: integer("trust").default(50),
    trustStage: text("trust_stage"),
    commitment: integer("commitment").default(0),
    closeness: integer("closeness").default(0),
    dependence: integer("dependence").default(0),
    reciprocity: integer("reciprocity").default(0),
    powerBalance: integer("power_balance").default(0),
    formality: integer("formality").default(0),
    violationCount: integer("violation_count").notNull().default(0), // 只增不减
    scriptText: text("script_text"),
    addressTerm: text("address_term"), // 我称呼 TA 用什么
    addressKind: text("address_kind"), // neutral|intimate|honorific|derogatory
    hierarchyRank: integer("hierarchy_rank"),
    basis: text("basis"),
    sourceRef: text("source_ref"),
    evidenceIds: text("evidence_ids", { mode: "json" }),
    awareness: text("awareness").notNull().default("full"), // full|distorted|denied
    disclosable: integer("disclosable").notNull().default(1),
    originModule: text("origin_module").notNull().default("migration"),
    originVersion: text("origin_version").notNull().default("interp-relations-1.0"),
    status: text("status").notNull().default("active"), // active|superseded
    supersededBy: integer("superseded_by"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
    // ---- RSQ 关系自陈问卷（§43）：指向最新一次填写 + 核心维度冗余 ----
    rsqResponseId: integer("rsq_response_id"),
    rsqAffection: integer("rsq_affection"),
    rsqAntagonism: integer("rsq_antagonism"),
    rsqFaith: integer("rsq_faith"),
    rsqCommitment: integer("rsq_commitment"),
    rsqForgiveness: integer("rsq_forgiveness"),
    rsqCloseness: integer("rsq_closeness"),
    rsqAmbivalence: integer("rsq_ambivalence"),
    rsqEquityBalance: integer("rsq_equity_balance"),
    rsqVerdict: text("rsq_verdict"),
    rsqSelfSummary: text("rsq_self_summary"),
    rsqUpdatedAt: integer("rsq_updated_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    // 2026-10-22：唯一约束改为「仅 active 行唯一」，且悬空边把 to_name 纳入键
    // 实际 DDL 见 db/sqlite-ddl.ts 的 idx_rel_active（partial unique index）；
    // 此处的 drizzle 声明仅用于 generate 参考，运行期以 DDL 为准。
    index("idx_rel_active").on(t.fromPersonaId, t.toPersonaId, t.toName, t.layer, t.kind),
    index("idx_rel_from").on(t.fromPersonaId, t.layer, t.status),
    index("idx_rel_to").on(t.toPersonaId, t.layer, t.status),
  ],
);

export const relationDeltas = sqliteTable(
  "relation_deltas",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    relationId: integer("relation_id").notNull(),
    fromPersonaId: integer("from_persona_id").notNull(),
    toPersonaId: integer("to_persona_id").notNull(),
    layer: text("layer").notNull(),
    param: text("param").notNull(),
    beforeValue: integer("before_value"),
    afterValue: integer("after_value"),
    delta: integer("delta"),
    kindBefore: text("kind_before"),
    kindAfter: text("kind_after"),
    reasonKind: text("reason_kind").notNull(),
    salience: real("salience"),
    eventIds: text("event_ids", { mode: "json" }),
    gameId: text("game_id"),
    evidence: text("evidence", { mode: "json" }),
    verdict: text("verdict"),
    correctedFrom: integer("corrected_from"),
    actor: text("actor"),
    mechanismVersion: text("mechanism_version").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [
    index("idx_rd_rel").on(t.relationId, t.createdAt),
    index("idx_rd_pair").on(t.fromPersonaId, t.toPersonaId, t.layer),
    index("idx_rd_verdict").on(t.verdict),
  ],
);

export const relationCompletionJobs = sqliteTable("relation_completion_jobs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id"),
  scope: text("scope").notNull(),
  status: text("status").notNull().default("pending"),
  progress: text("progress"),
  stats: text("stats"),
  costEstimate: text("cost_estimate"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
});

export const relationCompletionItems = sqliteTable(
  "relation_completion_items",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    jobId: integer("job_id").notNull(),
    fromPersonaId: integer("from_persona_id").notNull(),
    toPersonaId: integer("to_persona_id").notNull(),
    layer: text("layer").notNull(),
    param: text("param").notNull(),
    action: text("action").notNull(), // keep|correct|fill
    beforeJson: text("before_json"),
    afterJson: text("after_json"),
    sourceTier: text("source_tier"),
    evidence: text("evidence"),
    confidence: real("confidence"),
    userDecision: text("user_decision").default("pending"),
    appliedAt: integer("applied_at", { mode: "timestamp_ms" }),
  },
  (t) => [index("idx_rci_job").on(t.jobId, t.action)],
);

// ============================================================
// 二阶关系认知（§24，Krackhardt CSS 1987）
// ============================================================
export const perceivedDyadRelations = sqliteTable(
  "perceived_dyad_relations",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    observerId: integer("observer_id").notNull(),
    aboutFromId: integer("about_from_id").notNull(),
    aboutToId: integer("about_to_id").notNull(),
    granularity: text("granularity").notNull(), // L0|L1|L2|L3|L4
    dimensionsJson: text("dimensions_json", { mode: "json" }),
    confidence: real("confidence").default(0),
    source: text("source").notNull(), // canon|observed|rumor|inferred
    biasKind: text("bias_kind"), // transitivity|balance|homophily|spotlight
    accuracy: real("accuracy"),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex("idx_pdr").on(t.observerId, t.aboutFromId, t.aboutToId),
    index("idx_pdr_observer").on(t.observerId, t.updatedAt),
  ],
);

// 昵称文本索引（§17.9）：只索引 awareness=all 的
export const personaNicknameIndex = sqliteTable(
  "persona_nickname_index",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    personaId: integer("persona_id").notNull(),
    text: text("text").notNull(),
    layer: text("layer").notNull(),
  },
  (t) => [uniqueIndex("idx_nni_persona_text").on(t.personaId, t.text), index("idx_nni_persona").on(t.personaId)],
);

// 调用台账（§30.10）
export const invocationLog = sqliteTable(
  "invocation_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    gameId: text("game_id"),
    turn: integer("turn"),
    personaId: integer("persona_id").notNull(),
    situationKind: text("situation_kind").notNull(),
    invokedSources: text("invoked_sources", { mode: "json" }),
    truncated: text("truncated", { mode: "json" }),
    conflictsResolved: text("conflicts_resolved", { mode: "json" }),
    contextHash: text("context_hash").notNull(),
    outputEventId: integer("output_event_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [
    index("idx_il_game").on(t.gameId, t.turn),
    index("idx_il_persona").on(t.personaId, t.createdAt),
  ],
);

// ============================================================
// RSQ 关系自陈问卷响应（§43）
// 一次填写 = 一条记录，保留完整历史（时间轴素材）
// 39 个维度 + 7 派生 + 效度 + 原始答案，用 JSON 承载；核心维度另设冗余列便于查询
// ============================================================
export const rsqResponses = sqliteTable(
  "rsq_responses",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    fromPersonaId: integer("from_persona_id").notNull(),
    toPersonaId: integer("to_persona_id").notNull(),
    gameId: text("game_id"),
    batteryLevel: text("battery_level").notNull().default("L"), // L|M|S
    // 冗余列（便于查询与喂 AI）
    affection: integer("affection"),
    antagonism: integer("antagonism"),
    faith: integer("faith"),
    commitment: integer("commitment"),
    forgiveness: integer("forgiveness"),
    closeness: integer("closeness"),
    ambivalence: integer("ambivalence"),
    equityBalance: integer("equity_balance"),
    // 完整数据
    dimensionsJson: text("dimensions_json").notNull(),
    derivedJson: text("derived_json").notNull(),
    validityJson: text("validity_json").notNull(),
    rawJson: text("raw_json").notNull(),
    feedbackJson: text("feedback_json"),
    /** 第 120 题：角色对这段关系的一句话自评（<=36 字）*/
    selfSummary: text("self_summary"),
    // 元信息
    model: text("model"),
    itemsVersion: text("items_version").notNull(),
    answeredAt: integer("answered_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [
    index("idx_rsq_pair").on(t.fromPersonaId, t.toPersonaId, t.answeredAt),
    index("idx_rsq_game").on(t.gameId),
  ],
);

// ============================================================
// 现实层（L1）：单视角关系记忆
// 每个人格独立记录「他视角里和某人发生过什么」，不与对方配对、不对齐
// 一条记录 = 一件事 + 一段复合感受（同一事件的多种感觉写在同一段里）
// ============================================================
export const personaCanonLog = sqliteTable(
  "persona_canon_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    personaId: integer("persona_id").notNull(),
    aboutPersonaId: integer("about_persona_id").notNull(),
    seq: integer("seq").notNull(),
    /** 手动排序位（拖动排序后写入；null=按时间线时代排序）(2026-10-22) */
    sortOrder: integer("sort_order"),
    /** 他记忆里的时间点（如「845年」）*/
    era: text("era").notNull(),
    /** 当时年龄 */
    age: integer("age"),
    /** 发生地点（如「希干希纳区」）*/
    place: text("place"),
    /** 时间依据：原作明载 or 按设定推定的推理链 */
    eraBasis: text("era_basis"),
    /** 他以为发生了什么（不是中立描述）*/
    eventText: text("event_text").notNull(),
    /** 复合感受：当时的判断 / 中途的动摇 / 现在的看法，写在同一段 */
    feeling: text("feeling").notNull(),
    /** 对关系的影响（一句话）*/
    impact: text("impact"),
    /** stated | implied | inferred | vague */
    certainty: text("certainty").notNull().default("inferred"),
    sourceRef: text("source_ref"),
    /** 独立佐证来源数 */
    sourceCount: integer("source_count").notNull().default(0),
    /** 来源明细 JSON：[{title,url,tier,reason}] */
    sourcesJson: text("sources_json"),
    /** confirmed | cross-checked | single-source | unverified | contradicted | manual */
    verification: text("verification").notNull().default("unverified"),
    /** ai | manual（用户手动编辑补充）*/
    origin: text("origin").notNull().default("ai"),
    superseded: integer("superseded").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [
    index("idx_pcl_pair").on(t.personaId, t.aboutPersonaId, t.seq),
    index("idx_pcl_persona").on(t.personaId, t.createdAt),
  ],
);

/** 补完任务台账（幂等：每对最多一行）*/
export const canonBackfillJobs = sqliteTable(
  "canon_backfill_jobs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    personaId: integer("persona_id").notNull(),
    aboutPersonaId: integer("about_persona_id").notNull(),
    /** pending | running | done | failed | busy */
    status: text("status").notNull().default("pending"),
    itemCount: integer("item_count").notNull().default(0),
    model: text("model"),
    promptVersion: text("prompt_version"),
    error: text("error"),
    /** 2026-10-22：补完统计（generated/verified/rejected/written/kept/removed/pendingRemovals） */
    stats: text("stats"),
    /** 本次是否真正联网检索（0/1，后台收尾写回） */
    webSearched: integer("web_searched").notNull().default(0),
    /** 未联网等降级警告（UI 展示） */
    warning: text("warning"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  },
  (t) => [uniqueIndex("idx_cbj_pair").on(t.personaId, t.aboutPersonaId)],
);

/** 记事簿回写运行台账（2026-10-22）：(persona,game,seat) 幂等守卫 + 失败可重试 */
export const personaWritebackRuns = sqliteTable(
  "persona_writeback_runs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    personaId: integer("persona_id").notNull(),
    gameId: text("game_id").notNull(),
    seat: integer("seat").notNull(),
    /** processing | done | failed */
    status: text("status").notNull().default("processing"),
    error: text("error"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex("idx_pwr_key").on(t.personaId, t.gameId, t.seat)],
);
