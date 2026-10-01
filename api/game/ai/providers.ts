// ============================================================
// AI 提供商适配层
// - OpenAI 兼容（kimi/openai/deepseek/custom 共用）：POST {baseUrl}/chat/completions
//   header Authorization: Bearer {apiKey}，body 带 temperature:0.7 与
//   response_format:{type:"json_object"}（若 400 报错则去掉该参数重试一次）；
//   Kimi 思考系（k3/k2.x）temperature/top_p 官方固定，免传（传入他值必 400 空跑一轮）
// - Anthropic：POST {baseUrl}/v1/messages，headers x-api-key + anthropic-version
// 单次调用超时按模型能力画像分流（modelCaps：思考型 150s / 常规 90s，AI_TIMEOUT_MS 可覆盖），
// 失败重试 2 次（指数退避）；调用方可用 opts.timeoutMs / opts.maxRetries / opts.deadlineAt 覆盖
// （如分析师长调用：180s + 仅重试 1 次；决策点预算截止线在重试循环内逐次生效）。
// 传输层用 longFetch（npm undici + 关闭隐藏 300s headersTimeout）——应用层
// AbortController 是唯一超时闸门；网络错误经 netErrorMessage 透传底层 cause。
// ============================================================

import type { SeatAiConfig } from "../../../contracts/game";
import { longFetch, netErrorMessage } from "../../lib/longFetch";
import { defaultCallTimeoutMs, omitSamplingParams } from "./modelCaps";

export interface AiChatResult {
  ok: boolean;
  text: string | null;
  latencyMs: number;
  error: string | null;
}

export interface CallAiOptions {
  jsonMode?: boolean; // 默认 true（OpenAI 兼容端点带 response_format）；false = 纯文本输出
  timeoutMs?: number; // 单次请求超时，默认按模型能力画像（modelCaps.defaultCallTimeoutMs）
  maxRetries?: number; // 失败重试次数（不含首发），默认 2
  /** 决策点总预算截止线（epoch ms）：每次尝试前把单次超时截到剩余预算，
   *  剩余不足一次最短调用即停止重试——预算在重试循环内同样生效
   *  （此前只在调用方入口检查一次，内部 3×90s 重试会把 120s 预算实际烧成 274s） */
  deadlineAt?: number;
}

// 思考型模型单步推理可达 150s+（kimi-k3 永远思考、reasoning_effort 默认 max）；
// 默认超时由 modelCaps.defaultCallTimeoutMs 按模型分流，可用 AI_TIMEOUT_MS 覆盖
const DEFAULT_MAX_RETRIES = 2; // 首发 1 次 + 重试 2 次

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errSnippet(data: unknown): string {
  try {
    if (typeof data === "string") return data.slice(0, 200);
    if (data && typeof data === "object") {
      const msg = (data as { error?: { message?: unknown } }).error?.message;
      if (typeof msg === "string") return msg.slice(0, 200);
      return JSON.stringify(data).slice(0, 200);
    }
  } catch {
    /* 忽略序列化异常 */
  }
  return "";
}

interface RawResponse {
  status: number;
  data: unknown;
}

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
): Promise<RawResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // longFetch：npm undici + 关闭隐藏 300s headersTimeout/bodyTimeout（思考型模型长生成
    // 不吐响应头会被底层掐断且应用层管不到）；应用层 AbortController 是唯一超时闸门
    const res = await longFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const raw = await res.text();
    let data: unknown = raw;
    try {
      data = JSON.parse(raw);
    } catch {
      /* 非 JSON 响应，保留原文 */
    }
    return { status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

function ensureHttpOk(status: number, data: unknown): void {
  if (status < 200 || status >= 300) {
    const snippet = errSnippet(data);
    throw new Error(`HTTP ${status}${snippet ? `: ${snippet}` : ""}`);
  }
}

// ---------- OpenAI 兼容端点（kimi/openai/deepseek/custom） ----------
async function callOpenAiCompatibleOnce(
  cfg: SeatAiConfig,
  system: string,
  user: string,
  jsonMode: boolean,
  timeoutMs: number,
): Promise<string> {
  const url = `${cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const headers = { authorization: `Bearer ${cfg.apiKey}` };
  const messages = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages,
    // Kimi 思考系（k3/k2.x）：temperature/top_p 官方固定（1.0/0.95），显式传入他值必 400——
    // 免传省掉「撞 400 → 去掉重试」的每轮空跑；其余提供方维持 temperature:0.7
    // （DeepSeek 官方端点默认开启 thinking：思考链显著提升狼人杀这类高欺骗性博弈的决策质量）
    ...(omitSamplingParams(cfg) ? {} : { temperature: 0.7 }),
    // 输出上限（max_tokens）仅给 Moonshot 8K 版显式设置（其网关要求）；其余提供方一律不传，
    // 用端点默认值——思考型模型的端点默认额度足够容纳思考链+正式输出，避免人为截断
    ...(cfg.provider === "kimi" && /8k/i.test(cfg.model) ? { max_tokens: 8_192 } : {}),
  };
  if (jsonMode) body.response_format = { type: "json_object" };
  let r = await postJson(url, headers, body, timeoutMs);
  // 个别端点/网关限制 max_tokens 上限：去掉该参数重试（仅 Moonshot 8K 会带此参数）
  while (r.status === 400 && /max_tokens/i.test(errSnippet(r.data)) && "max_tokens" in body) {
    delete body.max_tokens;
    r = await postJson(url, headers, body, timeoutMs);
  }
  if (r.status === 400 && /temperature/i.test(errSnippet(r.data))) {
    // 部分模型（如 kimi-k2.5）只允许 temperature=1，去掉该参数重试
    delete body.temperature;
    r = await postJson(url, headers, body, timeoutMs);
  }
  if (r.status === 400) {
    // 部分 OpenAI 兼容端点不支持 response_format，去掉该参数重试一次
    delete body.response_format;
    r = await postJson(url, headers, body, timeoutMs);
  }
  ensureHttpOk(r.status, r.data);
  const msg = (r.data as { choices?: { message?: { content?: unknown; reasoning_content?: unknown } }[] })
    ?.choices?.[0]?.message;
  // content 两种形态：字符串 或 分段数组（[{type:"text",text:...}]，部分网关/新协议形态）
  const rawContent = msg?.content;
  const text =
    typeof rawContent === "string"
      ? rawContent
      : Array.isArray(rawContent)
        ? rawContent
            .filter((b) => b && typeof b === "object" && (b as { type?: unknown }).type === "text")
            .map((b) => String((b as { text?: unknown }).text ?? ""))
            .join("\n")
        : "";
  if (typeof text !== "string" || text.trim().length === 0) {
    // 思考型模型额度耗尽时 content 为空、仅 reasoning_content 有值——报错文案指明根因
    const hasReasoning =
      typeof msg?.reasoning_content === "string" && msg.reasoning_content.trim().length > 0;
    throw new Error(
      hasReasoning
        ? "模型返回内容为空（仅返回了思考过程：输出额度不足或被截断）"
        : "模型返回内容为空",
    );
  }
  return text;
}

// ---------- Anthropic 端点 ----------
async function callAnthropicOnce(
  cfg: SeatAiConfig,
  system: string,
  user: string,
  timeoutMs: number,
): Promise<string> {
  const url = `${cfg.baseUrl.replace(/\/+$/, "")}/v1/messages`;
  const body = {
    model: cfg.model,
    max_tokens: 1500,
    // Anthropic 无 response_format 参数，在 system 里强制 JSON 输出契约
    system: `${system}\n\n【输出要求】只输出一个 JSON 对象，禁止输出任何其他文字或 markdown 代码块。`,
    messages: [{ role: "user", content: user }],
  };
  const r = await postJson(
    url,
    { "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01" },
    body,
    timeoutMs,
  );
  ensureHttpOk(r.status, r.data);
  const blocks = (r.data as { content?: { type?: unknown; text?: unknown }[] })?.content;
  const text = Array.isArray(blocks)
    ? blocks
        .filter((b) => b?.type === "text" && typeof b?.text === "string")
        .map((b) => b.text as string)
        .join("\n")
    : "";
  if (!text.trim()) throw new Error("模型返回内容为空");
  return text;
}

// ---------- 统一入口（含重试与计时） ----------
export async function callAi(
  cfg: SeatAiConfig,
  system: string,
  user: string,
  opts?: CallAiOptions,
): Promise<AiChatResult> {
  const jsonMode = opts?.jsonMode !== false;
  const timeoutMs = opts?.timeoutMs ?? defaultCallTimeoutMs(cfg);
  const maxAttempts = 1 + Math.max(0, opts?.maxRetries ?? DEFAULT_MAX_RETRIES);
  const startedAt = Date.now();
  let lastError = "未知错误";
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      await sleep(400 * 2 ** (attempt - 1)); // 400ms → 800ms 指数退避
    }
    // 决策点总预算在重试循环内逐次生效：剩余不足一次最短调用即收手转兜底，
    // 单次超时截到剩余预算——预算不再只是入口一次性检查（历史：120s 预算实际烧 274s）
    let attemptTimeoutMs = timeoutMs;
    if (opts?.deadlineAt != null) {
      const remaining = opts.deadlineAt - Date.now();
      if (remaining <= 3_000) {
        lastError = "AI响应总预算耗尽";
        break;
      }
      attemptTimeoutMs = Math.max(3_000, Math.min(timeoutMs, remaining - 500));
    }
    try {
      const text =
        cfg.provider === "anthropic"
          ? await callAnthropicOnce(cfg, system, user, attemptTimeoutMs)
          : await callOpenAiCompatibleOnce(cfg, system, user, jsonMode, attemptTimeoutMs);
      return { ok: true, text, latencyMs: Date.now() - startedAt, error: null };
    } catch (err) {
      const e = err as Error | null;
      lastError =
        e?.name === "AbortError"
          ? `请求超时（${Math.round(attemptTimeoutMs / 1000)}s）`
          : e instanceof TypeError || /fetch failed/i.test(e?.message ?? "")
            ? netErrorMessage(e ?? new Error("fetch failed")) // 网络层：透传底层 cause（ECONNRESET 等）
            : (e?.message ?? String(err));
      // HTTP 4xx（除 429 限流）属客户端错误（如上下文超限/鉴权失败/参数非法），
      // 重试必然再败，立即放弃——省 2×90s 无意义等待，加快兜底收敛
      if (/^HTTP 4\d\d/.test(lastError) && !lastError.startsWith("HTTP 429")) break;
    }
  }
  return {
    ok: false,
    text: null,
    latencyMs: Date.now() - startedAt,
    error: lastError.slice(0, 300),
  };
}
