// ============================================================
// 人格研究站 · 契约层统一入口（L3，单一事实源）
// 设计文档：docs/interpersonal-graph-design.md（§26/§27/§28/§29/§30）
// ============================================================

// 类型
export type * from "./types";

// 词表
export {
  NICKNAME_LAYERS,
  NICKNAME_LAYER_RANK,
  NICKNAME_LAYER_DEFAULTS,
  RELATION_KINDS,
  RELATION_KIND_LABEL,
  RELATION_KIND_TO_FORM,
  RELATION_FORMS,
  RELATION_FORM_LABEL,
  VALE_PATTERNS,
  VALE_PATTERN_LABEL,
  VALE_DEFAULT_FORM,
  GRANULARITY_LEVELS,
  GRANULARITY_RANK,
  GRANULARITY_LABEL,
} from "./vocab";

// 常量
export * from "./constants";

// 版本
export { MECHANISM_VERSION } from "./version";
export type { MechanismKey } from "./version";

// 算法：关系
export {
  clamp100, clampRange, clamp01, deriveMetrics, mergeLayers, rankHierarchy,
  diffRelations, sanitizeCorrectionPatch, applyCorrection, linkCorrection,
} from "./algorithms/relation";

// 算法：事件
export { EVENT_SALIENCE_WEIGHTS, eventStats, eventSalience } from "./algorithms/events";

// 算法：增量校验
export {
  clampParamValue, computeDeltaCaps, checkRelationDelta, trustCeiling, applyTrust,
} from "./algorithms/delta";

// 算法：昵称与称呼
export {
  familiarityScore, familiarEnough, familiarityThreshold, isNicknameAware, canUseNickname,
  eligibleNicknames, boundaryRecklessness, nicknameBreadth, addressAsymmetry,
  isAddressCandidateAllowed, chooseAddress, scoreAddressCandidate, stepDownLayer, isDisclosureUpgrade,
} from "./algorithms/nickname";

// 算法：二阶认知
export {
  SOURCE_WEIGHT, granularityScore, scoreToGranularity,
  visibilityOf, canAssertDimension, biasRisk, perceptionAccuracy,
} from "./algorithms/perception";
