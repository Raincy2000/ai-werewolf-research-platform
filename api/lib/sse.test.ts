import { describe, expect, it } from "vitest";
import {
  accumulateAnthropicStream,
  accumulateChatStream,
  iterSseData,
  synthesizeChatResponse,
} from "./sse";

/** 把字符串块拼成 SSE Response（模拟真实分块到达） */
function sseResponse(chunks: string[]): Response {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(c) {
        for (const ch of chunks) c.enqueue(enc.encode(ch));
        c.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

async function collect(gen: AsyncGenerator<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const x of gen) out.push(x);
  return out;
}

describe("iterSseData", () => {
  it("解析多个事件：跨块拼接、跳过心跳注释、[DONE] 原样产出", async () => {
    const res = sseResponse([
      ': heartbeat\n\n',
      'data: {"a":1}\n\n',
      'data: {"b":', // 事件被切成两块
      '2}\n\ndata: [DONE]\n\n',
    ]);
    const events = await collect(iterSseData(res));
    expect(events).toEqual(['{"a":1}', '{"b":2}', "[DONE]"]);
  });

  it("多行 data 合并；\\r\\n 换行兼容；流尾残余块兜底", async () => {
    const res = sseResponse(['data: line1\r\ndata: line2\r\n\r\ndata: tail-no-ending']);
    const events = await collect(iterSseData(res));
    expect(events).toEqual(["line1\nline2", "tail-no-ending"]);
  });

  it("无 data 的纯注释块被跳过", async () => {
    const res = sseResponse([": ping\n\n: pong\n\n"]);
    expect(await collect(iterSseData(res))).toEqual([]);
  });
});

describe("accumulateChatStream（OpenAI 兼容流）", () => {
  it("拼接 content 增量并捕获 finish_reason；[DONE] 收尾", async () => {
    const res = sseResponse([
      'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"你"}}]}\n\ndata: {"choices":[{"delta":{"content":"好"},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
      'data: {"choices":[{"delta":{"content":"不应出现"}}]}\n\n', // [DONE] 之后的内容忽略
    ]);
    const seen: string[] = [];
    const acc = await accumulateChatStream(res, (t) => seen.push(t));
    expect(acc.content).toBe("你好");
    expect(acc.finishReason).toBe("stop");
    expect(acc.toolCalls).toEqual([]);
    expect(seen).toEqual(["你", "你好"]); // onText 逐次收到累加值
  });

  it("tool_calls 按 index 分块组装（id/name/arguments 跨块）", async () => {
    const res = sseResponse([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"web_"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"q\\""}},{"index":1,"id":"call_2","function":{"name":"search","arguments":"{}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"search","arguments":":\\"狼人杀\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    const acc = await accumulateChatStream(res);
    expect(acc.finishReason).toBe("tool_calls");
    expect(acc.toolCalls).toEqual([
      { id: "call_1", type: "function", function: { name: "web_search", arguments: '{"q":"狼人杀"}' } },
      { id: "call_2", type: "function", function: { name: "search", arguments: "{}" } },
    ]);
    expect(acc.content).toBe("");
  });

  it("reasoning_content 累加；无 choices 的 usage 收尾块被跳过", async () => {
    const res = sseResponse([
      'data: {"choices":[{"delta":{"reasoning_content":"想想"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"答"}}]}\n\n',
      'data: {"usage":{"total_tokens":42}}\n\n',
      "data: [DONE]\n\n",
    ]);
    const acc = await accumulateChatStream(res);
    expect(acc.reasoning).toBe("想想");
    expect(acc.content).toBe("答");
  });
});

describe("synthesizeChatResponse（合成非流式同形对象）", () => {
  it("纯文本：finish_reason 缺省补 stop", () => {
    const data = synthesizeChatResponse({
      content: "正文",
      reasoning: "",
      toolCalls: [],
      finishReason: null,
    }) as { choices: { finish_reason: string; message: { content: string } }[] };
    expect(data.choices[0].finish_reason).toBe("stop");
    expect(data.choices[0].message.content).toBe("正文");
  });

  it("带工具调用：content 置空串、finish_reason 缺省补 tool_calls、挂 tool_calls", () => {
    const data = synthesizeChatResponse({
      content: "",
      reasoning: "思考",
      toolCalls: [{ id: "c1", type: "function", function: { name: "web_search", arguments: "{}" } }],
      finishReason: null,
    }) as {
      choices: {
        finish_reason: string;
        message: { content: string; reasoning_content: string; tool_calls: unknown[] };
      }[];
    };
    expect(data.choices[0].finish_reason).toBe("tool_calls");
    expect(data.choices[0].message.content).toBe("");
    expect(data.choices[0].message.reasoning_content).toBe("思考");
    expect(data.choices[0].message.tool_calls).toHaveLength(1);
  });
});

describe("accumulateAnthropicStream（/v1/messages 流）", () => {
  it("只拼接 text_delta；忽略 ping/thinking/input_json_delta；捕获 stop_reason", async () => {
    const res = sseResponse([
      'data: {"type":"message_start"}\n\n',
      'data: {"type":"ping"}\n\n',
      'data: {"type":"content_block_start","content_block":{"type":"thinking"}}\n\n',
      'data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"想想"}}\n\n',
      'data: {"type":"content_block_start","content_block":{"type":"server_tool_use"}}\n\n',
      'data: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{}"}}\n\n',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"你"}}\n\n',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"好"}}\n\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
      'data: {"type":"message_stop"}\n\n',
    ]);
    const seen: string[] = [];
    const acc = await accumulateAnthropicStream(res, (t) => seen.push(t));
    expect(acc.text).toBe("你好");
    expect(acc.stopReason).toBe("end_turn");
    expect(seen).toEqual(["你", "你好"]);
  });

  it("error 事件抛错（如 overloaded）", async () => {
    const res = sseResponse([
      'data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
    ]);
    await expect(accumulateAnthropicStream(res)).rejects.toThrow("Overloaded");
  });
});
