// ============================================================
// 人际网 / 人格研究站 · 全部类型定义（单一事实源，§27.3）
// ============================================================

// ---------- 昵称层（§17 / §20 / §21） ----------
/** 披露深度四层：公开 → 亲密 → 私人 → 隐秘（Altman & Taylor 1973） */
export type NicknameLayer = "public" | "intimate" | "private" | "secret";
export type NicknameAwareness = "all" | "private" | "self";
export type NicknameUsage = "all" | "threshold" | "specific" | "self";
export type NicknamePower = "equal" | "upward" | "downward";
export type NicknameTone = "intimate" | "honorific" | "derogatory" | "neutral";

export interface Nickname {
  text: string;
  layer: NicknameLayer;
  awareness: NicknameAwareness;
  usage: NicknameUsage;
  threshold?: number;
  allowedIds?: number[];
  power?: NicknamePower;
  tone?: NicknameTone;
  /** 是否可在公开场合使用（面子工作，Brown & Levinson 1987） */
  publicUse?: boolean;
  /** 已知共有人（Petronio 2002 CPM） */
  coOwners?: number[];
}

/** 观察者视角的关系强度（§17.3） */
export interface RelationStrength {
  closeness?: number;
  positivity?: number;
  trust?: number;
}

// ---------- 称呼语用（§21） ----------
export type AddressSetting = "private" | "public" | "formal" | "crisis";
export type AddressIntent = "affiliate" | "neutral" | "distance" | "warn";
export type FaceNeed = "protectOther" | "protectSelf" | "none";

export interface AddressContext {
  eligible: Nickname[];
  setting: AddressSetting;
  emotion?: { valence: number; arousal: number };
  intent?: AddressIntent;
  faceNeed?: FaceNeed;
}

// ---------- 一阶关系（§25 三层表征 / §26.4） ----------
export type RelationLayer = "canon" | "vale";
export type RelationStatus = "active" | "superseded";
export type RelationAwareness = "full" | "distorted" | "denied";

/** 规则层：Fiske RMT 四型（1991/2004） */
export type RelationForm = "CS" | "AR" | "EM" | "MP";

/**
 * 山谷层专用：**对局关系**（不是人际情感）。
 * 狼人杀里的守卫/验人/互投是**博弈策略**，不能等同于"生死之交"或"宿敌"。
 * 因此山谷层用中性行为描述，与原世界的情感词表严格分离。
 */
export type ValePattern =
  | "team"        // 队友（同狼队/同阵营协作，且无互攻）
  | "cooperate"   // 常协作（多局同阵营、少互投）
  | "oppose"      // 常对立（多局对阵营、互投多）
  | "trading"     // 攻防互现（既有协作也有对立）
  | "suppress"    // 单向压制（一方多次攻击，对方未反击）
  | "acquainted"  // 偶有交集（同场少或互动少）
  | "none";       // 无直接互动

/** 类别层：受控词表（Haslam 1994 原型范畴） */
export type RelationKind =
  | "kin" | "beloved" | "sworn_friend" | "comrade"
  | "mentor" | "sovereign" | "peer" | "rival" | "nemesis"
  | "creditor" | "kin_slayer" | "unspecified";

/** 可被校正的参数路径（§12.4 只校正增量） */
export type RelationParamPath =
  | "positivity" | "negativity" | "trust"
  | "closeness" | "dependence" | "reciprocity"
  | "power_balance" | "formality" | "commitment"
  | "kind" | "form";

export interface RelationRow {
  id?: number;
  fromPersonaId: number;
  /** 0 = 悬空（对方是库外角色，§19） */
  toPersonaId: number;
  toName?: string | null;
  layer: RelationLayer;
  /**
   * 融合来源（仅 `mergeLayers` 返回行填充，不落库）：
   * 单层行只含自身层；两层融合行为 `["canon", "vale"]`（layer 仍为 "canon"，向后兼容调用方）。
   */
  sources?: RelationLayer[];
  form: RelationForm;
  kind: RelationKind | string;
  prototypicality?: number;
  positivity?: number;
  negativity?: number;
  trust?: number;
  closeness?: number;
  dependence?: number;
  reciprocity?: number;
  powerBalance?: number;
  formality?: number;
  commitment?: number;
  violationCount?: number;
  awareness?: RelationAwareness;
  disclosable?: number;
  status?: RelationStatus;
  supersededBy?: number | null;
  originModule?: string;
  originVersion?: string;
}

/** 双维情感派生量（§12.2） */
export interface RelationMetrics {
  involvement: number;
  ambivalence: number;
  netAffect: number;
}

// ---------- 校正执行（§13.5） ----------
/**
 * `applyCorrection` 的纯数据结果：原行标 superseded、新行 active。
 * `nextId` 为修正后新行的 id —— 纯函数阶段未知时为 null，
 * 由写收口在插入新行后用 `linkCorrection` 回填（避免 superseded_by 自指，P1-8）。
 */
export interface CorrectionResult {
  superseded: RelationRow;
  next: RelationRow;
  nextId: number | null;
}

// ---------- 二阶关系认知（§24） ----------
/** 认知粒度 L0 存在 → L4 细节 */
export type PerceivedGranularity = "L0" | "L1" | "L2" | "L3" | "L4";
/** 信息来源层级 */
export type PerceivedSource = "canon" | "observed" | "rumor" | "inferred";
/** 系统性偏差类型（Heider 1958 等） */
export type PerceptionBias = "transitivity" | "balance" | "homophily" | "spotlight";

export interface PerceivedDyadRelation {
  id?: number;
  observerId: number;
  aboutFromId: number;
  aboutToId: number;
  granularity: PerceivedGranularity;
  dimensions?: Record<string, unknown>;
  confidence: number;
  source: PerceivedSource;
  biasKind?: PerceptionBias | null;
  accuracy?: number | null;
}

/** 二阶认知的决定因素（五因子，§24.5） */
export interface PerceptionInputs {
  source: PerceivedSource;
  distanceToActor: number;
  faculty: number;
  structuralPosition: number;
  targetKnowledge: number;
}

// ---------- 增量校验（§13.3） ----------
export interface RelationEvent {
  kind:
    | "vote_for" | "vote_against" | "killed_by" | "killed"
    | "same_camp" | "opposed_camp" | "skill_targeted"
    | "joint_win" | "joint_loss" | "betrayal";
  eventId: number;
  gameId?: string;
  weight: number;
}

export interface DeltaCheckInput {
  param: RelationParamPath;
  layer: RelationLayer;
  /** 变更前值（§13.3：用于 trust 留疤特判与 suggestedDelta 换算；kind/form 忽略） */
  before?: number;
  /** 变更后值；缺省时按 before + actualDelta 推导（§13.3 第 7 步需要 after） */
  after?: number;
  actualDelta: number;
  events: RelationEvent[];
  salience: number;
  /** 被背叛次数（§12.6；trust 专用） */
  violationCount?: number;
}

export interface DeltaCheckResult {
  verdict: "consistent" | "anomalous" | "undeterminable";
  suggestedDelta: number | null;
  reason: string;
  evidence: string[];
}

// ---------- 山谷事件统计（§17.4） ----------
export type DyadEventKind = RelationEvent["kind"];
export interface DyadEvent {
  kind: DyadEventKind;
  eventId: number;
  gameId?: string;
}
export interface DyadStats {
  sameCamp: number;
  opposedCamp: number;
  votesFor: number;
  votesAgainst: number;
  /** 被对方亲手终结的次数（P0-11：布尔化会丢频次，改为计数） */
  killedBy: number;
  /** 亲手终结对方的次数（P0-11） */
  killedThem: number;
  skillTargeted: number;
  jointWins: number;
  jointLosses: number;
  betrayal: number;
}

// ---------- 补完 diff（§14） ----------
export type DiffAction = "keep" | "correct" | "fill";
export interface DiffItem {
  param: RelationParamPath;
  action: DiffAction;
  before?: number | string | null;
  after: number | string;
}

// ---------- 调用台（§30） ----------
export type SituationKind =
  | "dawn" | "day_speech" | "day_vote" | "night_wolf"
  | "night_seer" | "private" | "endgame";

export interface InvokedItem {
  source: string;
  id: number;
  purpose: string;
  score: number;
}

export interface ResolvedConflict {
  between: [string, string];
  resolvedTo: string;
  rule: string;
}

export interface Affordance {
  action: string;
  supportedBy: string[];
  blocked?: string;
}

export interface InvokedContext {
  situation: { kind: SituationKind; actors: number[]; recentEvents: number[] };
  situationModel: { timeline: string; causalChain: string; myGoal: string };
  invoked: InvokedItem[];
  truncated: InvokedItem[];
  affordances: Affordance[];
  conflicts: ResolvedConflict[];
}
