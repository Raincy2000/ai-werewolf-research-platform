// ============================================================
// 模型能力画像（单一事实源）：思考型判定 / 单次调用默认超时 / 采样参数兼容
// 独立于 providers.ts 单建模块：测试以 vi.mock("./providers") 整体替换调用层，
// 能力判定必须在 mock 之外保持真实，否则时限分流在测试与线上行为不一致。
// ============================================================

import type { SeatAiConfig } from "../../../contracts/game";

/** Kimi 思考系（参数固定档）：kimi-k3 / k3-256k / kimi-k2.6 / kimi-k2.7 / kimi-thinking 等。
 *  官方契约：temperature 固定 1.0、top_p 固定 0.95——显式传入其他值必 400 报错 */
const KIMI_THINKING_RE = /kimi-k3|k3-256k|kimi-k2\.\d|kimi-thinking/i;

/** 思考型模型判定（超时/预算/参数兼容全部据此分流）：
 *  - kimi-k3：官方「K3 始终开启思考模式」，reasoning_effort 默认 max，思考链最长
 *  - kimi-k2.6/k2.7 系：thinking 默认 enabled
 *  - DeepSeek 官方端点：默认开启 thinking（思考链显著提升狼人杀这类博弈的决策质量）
 *  - 其余模型名含 thinking 的显式思考变体（自定义端点同名单） */
export function isThinkingModel(cfg: Pick<SeatAiConfig, "provider" | "model">): boolean {
  if (cfg.provider === "deepseek") return true;
  if (KIMI_THINKING_RE.test(cfg.model)) return true;
  return /thinking/i.test(cfg.model);
}

/** Kimi 思考系免传 temperature/top_p（固定 1.0/0.95，传入他值必 400——
 *  省掉每次调用先撞 400 再回退重试的一轮空跑） */
export function omitSamplingParams(cfg: Pick<SeatAiConfig, "provider" | "model">): boolean {
  return KIMI_THINKING_RE.test(cfg.model);
}

/** 单次调用默认超时（可用 AI_TIMEOUT_MS 环境变量全覆盖）：
 *  思考型模型推理链真实耗时 60-150s+，90s 常规上限会拦断长推理
 *  （线上实锤：kimi-k3 对局 90s 超时 ×8、批量托管 38 次）——思考模型放宽到 150s */
export function defaultCallTimeoutMs(cfg: Pick<SeatAiConfig, "provider" | "model">): number {
  const env = Number(process.env.AI_TIMEOUT_MS);
  if (env) return env;
  return isThinkingModel(cfg) ? 150_000 : 90_000;
}
