import { describe, expect, it } from "vitest";
import { accumulateResponsesStream } from "./responses";

/** 把字符串块拼成 SSE Response */
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

describe("accumulateResponsesStream（Responses API 流）", () => {
  it("output_text.delta 拼接正文；流尾无 completed 也能返回", async () => {
    const res = sseResponse([
      'data: {"type":"response.created"}\n\n',
      'data: {"type":"response.output_text.delta","delta":"你"}\n\n',
      'data: {"type":"response.output_text.delta","delta":"好"}\n\n',
      "data: [DONE]\n\n",
    ]);
    const seen: string[] = [];
    const text = await accumulateResponsesStream(res, (t) => seen.push(t));
    expect(text).toBe("你好");
    expect(seen).toEqual(["你", "你好"]);
  });

  it("response.completed 的完整对象优先于 delta 拼接", async () => {
    const res = sseResponse([
      'data: {"type":"response.output_text.delta","delta":"部分"}\n\n',
      'data: {"type":"response.completed","response":{"output":[{"type":"message","content":[{"type":"output_text","text":"完整文本"}]}]}}\n\n',
      "data: [DONE]\n\n",
    ]);
    expect(await accumulateResponsesStream(res)).toBe("完整文本");
  });

  it("response.failed / error 事件抛错", async () => {
    const failed = sseResponse([
      'data: {"type":"response.failed","response":{"error":{"message":"模型超载"}}}\n\n',
    ]);
    await expect(accumulateResponsesStream(failed)).rejects.toThrow("模型超载");
    const err = sseResponse(['data: {"type":"error","message":"流中断"}\n\n']);
    await expect(accumulateResponsesStream(err)).rejects.toThrow("流中断");
  });

  it("联网检索中的 web_search_call 等非文本事件被忽略", async () => {
    const res = sseResponse([
      'data: {"type":"response.output_item.added","item":{"type":"web_search_call"}}\n\n',
      'data: {"type":"response.web_search_call.searching"}\n\n',
      'data: {"type":"response.output_text.delta","delta":"答"}\n\n',
      "data: [DONE]\n\n",
    ]);
    expect(await accumulateResponsesStream(res)).toBe("答");
  });
});
