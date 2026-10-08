// postChat 流式中断重试测试（实锤事故回归：长生成 SSE 中途被掐 → terminated → 铸造整体失败）
// 修复后：流中死亡整调用重发（最多 3 次），HTTP 语义错误仍立即抛出
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { postChat } from "./caster";

const FULL_ANSWER =
  'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n' +
  'data: {"choices":[{"delta":{"content":"完整答案"}}]}\n\n' +
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
  "data: [DONE]\n\n";

describe("postChat 流式中断重试", () => {
  let server: http.Server;
  let baseUrl = "";
  let hits = 0;
  let dropFirst = false;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        hits++;
        if (dropFirst && hits === 1) {
          // 流中途被掐：吐了半截内容后 socket 直接断开（网关/中间盒空闲断连的真实形态）
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write('data: {"choices":[{"delta":{"content":"半截"}}]}\n\n');
          setTimeout(() => res.socket?.destroy(), 30);
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(FULL_ANSWER);
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/v1`;
  });

  afterAll(() => server.close());

  it("SSE 流中途断连 → 整调用重发并成功（此前 terminated 一发就死）", async () => {
    hits = 0;
    dropFirst = true;
    const data = (await postChat(
      { provider: "kimi", baseUrl, model: "kimi-k3", apiKey: "sk-test" },
      { model: "kimi-k3", messages: [{ role: "user", content: "hi" }] },
    )) as { choices: { message: { content: string } }[] };
    expect(hits).toBe(2); // 第一次流中死亡，第二次完整成功
    expect(data.choices[0]!.message.content).toContain("完整答案");
  });

  it("HTTP 语义错误（400）不触发流式重试——立即抛，不空等", async () => {
    hits = 0;
    dropFirst = false;
    const s2 = server; // 复用服务器，但改返回 400
    void s2;
    const bad = http.createServer((req, res) => {
      hits++;
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "bad request" } }));
    });
    await new Promise<void>((r) => bad.listen(0, "127.0.0.1", r));
    const addr = bad.address();
    const url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/v1`;
    await expect(
      postChat(
        { provider: "kimi", baseUrl: url, model: "kimi-k3", apiKey: "sk-test" },
        { model: "kimi-k3", messages: [{ role: "user", content: "hi" }] },
      ),
    ).rejects.toThrow(/HTTP 400/);
    // 400 回退链会试「去 stream」一次（协议兼容），但不触发流式中断重试
    expect(hits).toBeLessThanOrEqual(2);
    bad.close();
  });
});
