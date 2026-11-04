// 各模块机制版本号（§27.8）—— 单一事实源
// 变更规则：阈值调整不算升级；算法改变算升级且不回溯旧数据
export const MECHANISM_VERSION = {
  /** 一阶关系机制 */
  relations: "interp-relations-1.0",
  /** 昵称库机制 */
  nicknames: "interp-nicknames-1.0",
  /** 二阶认知机制 */
  perception: "interp-perception-1.0",
  /** 增量校验机制 */
  delta: "interp-delta-1.0",
  /** 铸造 */
  cast: "cast-1.0",
  /** 编织 */
  weave: "weave-1.0",
  /** 调用台 */
  invocation: "invoke-1.0",
} as const;

export type MechanismKey = keyof typeof MECHANISM_VERSION;
