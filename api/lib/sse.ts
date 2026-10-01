// ============================================================
// SSE（Server-Sent Events）流式底座：铸魂师「长生成改流式」的解析层
// 为什么改流式：非流式请求要等整段生成完才返回——响应头迟迟不到会撞传输层
// 隐藏超时（undici headersTimeout 300s，已由 longFetch 取消），且途中任何网关
// 空闲断连都前功尽弃；流式则响应头先行到达、内容持续吐字（顺带产出真实生成进度）。
// 本文件含两种协议的流式累加器：
//   - OpenAI 兼容 chat/completions（Kimi/DeepSeek/OpenAI/自定义）：choices[0].delta 增量
//   - Anthropic /v1/messages：content_block_delta(text_delta) 增量
// DeepSeek/OpenAI Responses API 的累加器在 api/persona/responses.ts（协议差异大，就近实现）。
// ============================================================

/** 逐条产出 SSE 事件的 data 载荷：多行 data 合并、跳过注释心跳行、"[DONE]" 原样产出由消费方收尾 */
export async function* iterSseData(res: Response): AsyncGenerator<string> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const parseBlock = (block: string): string | null => {
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) continue; // 心跳/注释行
      if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    return dataLines.length > 0 ? dataLines.join("\n") : null;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // 追加后整块规范化换行（跨块的 \r|\n 边界会在下一块追加后被再次规范）
      buf = (buf + decoder.decode(value, { stream: true })).replace(/\r\n/g, "\n");
      let sep: number;
      while ((sep = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const data = parseBlock(block);
        if (data !== null) yield data;
      }
    }
    buf += decoder.decode();
    const tail = parseBlock(buf);
    if (tail !== null) yield tail;
  } finally {
    reader.releaseLock();
  }
}

// ---------- OpenAI 兼容 chat/completions 流式累加 ----------

export interface ChatToolCallAcc {
  id: string;
  type: string;
  function: { name: string; arguments: string };
}

export interface ChatStreamResult {
  content: string; // 正文（拼接全部 delta.content）
  reasoning: string; // 思考内容（delta.reasoning_content，DeepSeek 等）
  toolCalls: ChatToolCallAcc[]; // 按 index 组装的工具调用
  finishReason: string | null;
}

/** 累加 chat/completions 的 SSE 流（content/reasoning_content/tool_calls 增量组装） */
export async function accumulateChatStream(
  res: Response,
  onText?: (accumulated: string) => void,
): Promise<ChatStreamResult> {
  let content = "";
  let reasoning = "";
  const calls = new Map<number, ChatToolCallAcc>();
  let finishReason: string | null = null;
  for await (const data of iterSseData(res)) {
    if (data === "[DONE]") break;
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue; // 非 JSON 片段（部分网关的探活行）跳过
    }
    const choices = json?.choices;
    const choice = Array.isArray(choices) ? (choices[0] as Record<string, unknown> | undefined) : undefined;
    if (!choice) continue; // usage 等无 choices 的收尾块
    if (typeof choice.finish_reason === "string" && choice.finish_reason) {
      finishReason = choice.finish_reason;
    }
    const delta = choice.delta as Record<string, unknown> | undefined;
    if (!delta || typeof delta !== "object") continue;
    if (typeof delta.content === "string" && delta.content) {
      content += delta.content;
      onText?.(content);
    }
    if (typeof delta.reasoning_content === "string") reasoning += delta.reasoning_content;
    if (Array.isArray(delta.tool_calls)) {
      for (const raw of delta.tool_calls) {
        const tc = raw as Record<string, unknown> | null;
        if (!tc || typeof tc !== "object") continue;
        const idx = typeof tc.index === "number" ? tc.index : 0;
        const cur = calls.get(idx) ?? { id: "", type: "function", function: { name: "", arguments: "" } };
        if (typeof tc.id === "string" && tc.id) cur.id = tc.id;
        if (typeof tc.type === "string" && tc.type) cur.type = tc.type;
        const fn = tc.function as Record<string, unknown> | undefined;
        if (fn && typeof fn === "object") {
          if (typeof fn.name === "string" && fn.name) cur.function.name += fn.name;
          if (typeof fn.arguments === "string") cur.function.arguments += fn.arguments;
        }
        calls.set(idx, cur);
      }
    }
  }
  return {
    content,
    reasoning,
    finishReason,
    toolCalls: [...calls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, c]) => c),
  };
}

/** 把流式累加结果合成为非流式 chat.completion 同形对象（调用方零改动） */
export function synthesizeChatResponse(acc: ChatStreamResult): unknown {
  return {
    choices: [
      {
        finish_reason: acc.finishReason ?? (acc.toolCalls.length > 0 ? "tool_calls" : "stop"),
        message: {
          role: "assistant",
          content: acc.content || (acc.toolCalls.length > 0 ? "" : null),
          ...(acc.reasoning ? { reasoning_content: acc.reasoning } : {}),
          ...(acc.toolCalls.length > 0 ? { tool_calls: acc.toolCalls } : {}),
        },
      },
    ],
  };
}

// ---------- Anthropic /v1/messages 流式累加 ----------

export interface AnthropicStreamResult {
  text: string; // 全部 text_delta 拼接（server_tool_use/thinking 等块忽略）
  stopReason: string | null;
}

/** 累加 Anthropic 流式响应：只取文本增量；error 事件抛错 */
export async function accumulateAnthropicStream(
  res: Response,
  onText?: (accumulated: string) => void,
): Promise<AnthropicStreamResult> {
  let text = "";
  let stopReason: string | null = null;
  let errMsg: string | null = null;
  for await (const data of iterSseData(res)) {
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = json?.type;
    if (type === "content_block_delta") {
      const d = json.delta as Record<string, unknown> | undefined;
      if (d?.type === "text_delta" && typeof d.text === "string" && d.text) {
        text += d.text;
        onText?.(text);
      }
      // input_json_delta（工具入参）/thinking_delta 等非文本增量忽略
    } else if (type === "message_delta") {
      const d = json.delta as Record<string, unknown> | undefined;
      if (typeof d?.stop_reason === "string" && d.stop_reason) stopReason = d.stop_reason;
    } else if (type === "error") {
      const e = json.error as Record<string, unknown> | undefined;
      errMsg = String(e?.message ?? "Anthropic 流式错误");
    }
  }
  if (errMsg) throw new Error(errMsg);
  return { text, stopReason };
}
