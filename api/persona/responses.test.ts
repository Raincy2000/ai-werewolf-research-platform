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
    const out = await accumulateResponsesStream(res, (t) => seen.push(t));
    expect(out.text).toBe("你好");
    expect(out.searched).toBe(false);
    expect(seen).toEqual(["你", "你好"]);
  });

  it("response.completed 的完整对象优先于 delta 拼接", async () => {
    const res = sseResponse([
      'data: {"type":"response.output_text.delta","delta":"部分"}\n\n',
      'data: {"type":"response.completed","response":{"output":[{"type":"message","content":[{"type":"output_text","text":"完整文本"}]}]}}\n\n',
      "data: [DONE]\n\n",
    ]);
    expect((await accumulateResponsesStream(res)).text).toBe("完整文本");
  });

  it("response.failed / error 事件抛错", async () => {
    const failed = sseResponse([
      'data: {"type":"response.failed","response":{"error":{"message":"模型超载"}}}\n\n',
    ]);
    await expect(accumulateResponsesStream(failed)).rejects.toThrow("模型超载");
    const err = sseResponse(['data: {"type":"error","message":"流中断"}\n\n']);
    await expect(accumulateResponsesStream(err)).rejects.toThrow("流中断");
  });

  it("联网检索中的 web_search_call 事件被实证捕获（不再假装搜过）", async () => {
    const res = sseResponse([
      'data: {"type":"response.output_item.added","item":{"type":"web_search_call"}}\n\n',
      'data: {"type":"response.web_search_call.searching"}\n\n',
      'data: {"type":"response.web_search_call.completed"}\n\n',
      'data: {"type":"response.output_text.delta","delta":"答"}\n\n',
      "data: [DONE]\n\n",
    ]);
    const out = await accumulateResponsesStream(res);
    expect(out.text).toBe("答");
    // ★ 关键：searched 必须为 true——这正是之前被漏掉的判据
    expect(out.searched).toBe(true);
    expect(out.searchCount).toBeGreaterThanOrEqual(1);
  });

  it("未发生 search 的流：searched 必须为 false", async () => {
    const res = sseResponse([
      'data: {"type":"response.output_text.delta","delta":"没搜也能答"}\n\n',
      "data: [DONE]\n\n",
    ]);
    const out = await accumulateResponsesStream(res);
    expect(out.text).toBe("没搜也能答");
    expect(out.searched).toBe(false);
    expect(out.searchCount).toBe(0);
  });
});
