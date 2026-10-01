// ============================================================
// Responses API 适配器（DeepSeek / OpenAI 的原生服务端 web_search）
// 背景：这两家的联网检索只挂在 Responses API（/responses），chat/completions 不支持——
// 铸魂师「三流程全联网」由此获得这两家的原生检索能力。
// 协议要点：instructions=系统提示、input=用户输入、tools:[{type:"web_search"}] 服务端执行；
// 响应 output[] 里 type=message 项的 content[] 中取 output_text 文本。
// 失败一律抛错由调用方降级（服务端证据池注入是永续兜底）。
// 流式（SSE）优先：响应头先行到达、内容持续吐字——长生成不再考验任何空闲超时
// （非流式长生成曾撞 undici 300s headersTimeout 隐藏上限）；端点不支持流式（400）
// 时去掉 stream 自动回退非流式。应用层无 AbortController：铸魂师不设客户端时限（质量优先）。
// ============================================================

import type { AiTestInput } from "../../contracts/game";
import { longFetch, netErrorMessage } from "../lib/longFetch";
import { iterSseData } from "../lib/sse";
import { castCheckpoint, makeCharsReporter } from "./progress";

/** 网络层重试（与 caster.fetchWithRetry 同语义）：网络瞬断 1s→2s→4s；
 * HTTP 429（限流/引擎过载）与 5xx 按 Retry-After 或 3s→6s→12s 递增退避重试；
 * 底层走 longFetch 取消 undici 300s 隐藏超时；重试耗尽后 netErrorMessage 翻译为人话 */
async function fetchWithRetryPersona(url: string, init: RequestInit): Promise<Response> {
  const MAX_ATTEMPTS = 4;
  let lastErr: unknown = null;
  let lastWasNetErr = false;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0 && lastWasNetErr) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
    }
    try {
      const res = await longFetch(url, init);
      lastWasNetErr = false;
      if ((res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS - 1) {
        const ra = Number(res.headers.get("retry-after"));
        await new Promise((r) =>
          setTimeout(r, Number.isFinite(ra) && ra > 0 ? ra * 1000 : 3000 * 2 ** attempt),
        );
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      lastWasNetErr = true;
    }
  }
  if (lastErr instanceof Error) {
    throw new Error(netErrorMessage(lastErr));
  }
  throw lastErr;
}

/** 从 Responses API 响应中提取正文文本（output[].content[] 里 type=output_text 的块） */
export function extractResponsesText(data: unknown): string {
  const output = (data as { output?: unknown[] })?.output;
  if (!Array.isArray(output)) return "";
  const texts: string[] = [];
  for (const item of output) {
    const it = item as { type?: unknown; content?: unknown[] };
    if (it?.type !== "message" || !Array.isArray(it.content)) continue;
    for (const c of it.content) {
      const block = c as { type?: unknown; text?: unknown };
      if (block?.type === "output_text" && typeof block.text === "string") texts.push(block.text);
    }
  }
  return texts.join("\n").trim();
}

/** 累加 Responses API 的 SSE 流：response.output_text.delta 拼接正文；
 * response.completed 的完整对象优先（含全部 output）；response.failed/error 事件抛错 */
export async function accumulateResponsesStream(
  res: Response,
  onText?: (accumulated: string) => void,
): Promise<string> {
  let text = "";
  let finalObj: unknown = null;
  let errMsg: string | null = null;
  for await (const data of iterSseData(res)) {
    if (data === "[DONE]") break;
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = json?.type;
    if (type === "response.output_text.delta" && typeof json.delta === "string" && json.delta) {
      text += json.delta;
      onText?.(text);
    } else if (type === "response.completed" && json.response) {
      finalObj = json.response;
    } else if (type === "response.failed") {
      const r = json.response as Record<string, unknown> | undefined;
      const e = r?.error as Record<string, unknown> | undefined;
      errMsg = String(e?.message ?? "Responses 流式生成失败");
    } else if (type === "error") {
      const e = json.error as Record<string, unknown> | undefined;
      errMsg = String(json.message ?? e?.message ?? "Responses 流式错误");
    }
  }
  if (errMsg) throw new Error(errMsg);
  if (finalObj) {
    const full = extractResponsesText(finalObj);
    if (full) return full;
  }
  return text.trim();
}

/** 调用 Responses API（可选挂 web_search 服务端工具） */
export async function callResponsesApi(
  cfg: AiTestInput,
  system: string,
  user: string,
  opts?: { webSearch?: boolean },
): Promise<string> {
  await castCheckpoint(); // 暂停/终止控制点
  const url = `${cfg.baseUrl.replace(/\/+$/, "")}/responses`;
  const body: Record<string, unknown> = {
    model: cfg.model,
    instructions: system,
    input: user,
    max_output_tokens: 4096,
    stream: true,
    // 不传 temperature：部分 Responses 模型（gpt-5 系/思考态）拒绝该参数
    ...(opts?.webSearch
      ? { tools: [{ type: "web_search" }], tool_choice: "auto" }
      : {}),
  };
  const chars = makeCharsReporter();
  const post = async (): Promise<{
    status: number;
    data: unknown;
    raw: string;
    streamText: string | null;
  }> => {
    const res = await fetchWithRetryPersona(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(body),
    });
    const ct = res.headers.get("content-type") ?? "";
    if (res.status >= 200 && res.status < 300 && body.stream === true && ct.includes("text/event-stream")) {
      return { status: res.status, data: null, raw: "", streamText: await accumulateResponsesStream(res, chars) };
    }
    const raw = await res.text();
    let data: unknown = raw;
    try {
      data = JSON.parse(raw);
    } catch {
      /* 保留原文 */
    }
    return { status: res.status, data, raw, streamText: null };
  };
  let { status, data, raw, streamText } = await post();
  // 端点不支持 SSE 流式：400 时去掉 stream 重试
  if (status === 400 && body.stream === true) {
    delete body.stream;
    ({ status, data, raw, streamText } = await post());
  }
  if (status < 200 || status >= 300) {
    const msg =
      data && typeof data === "object"
        ? ((data as { error?: { message?: unknown } }).error?.message ?? raw.slice(0, 200))
        : raw.slice(0, 200);
    throw new Error(
      status === 429
        ? "HTTP 429：服务方繁忙（引擎过载/限流），已自动重试多次仍繁忙——请稍后重试（DeepSeek/OpenAI 高峰常见）"
        : `HTTP ${status}: ${String(msg).slice(0, 200)}`,
    );
  }
  const text = streamText ?? extractResponsesText(data);
  if (!text) throw new Error("Responses API 返回内容为空");
  return text;
}
