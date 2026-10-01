import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { postChat } from "./caster";

/** postChat 流式集成测试：本地 HTTP 服务器扮演 chat/completions 端点 */
describe("postChat 流式化（本地端点集成）", () => {
  let server: http.Server;
  let baseUrl = "";
  const seenBodies: Record<string, unknown>[] = [];
  // 模式：sse=正常流式；noStream=带 stream 就 400（模拟不支持流式的端点）
  let mode: "sse" | "noStream" = "sse";

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        seenBodies.push(parsed);
        if (mode === "noStream" && parsed.stream === true) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "stream is not supported" } }));
          return;
        }
        if (parsed.stream === true) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end(
            'data: {"choices":[{"delta":{"content":"你"}}]}\n\n' +
              'data: {"choices":[{"delta":{"content":"好"},"finish_reason":"stop"}]}\n\n' +
              "data: [DONE]\n\n",
          );
        } else {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "非流式回答" } }] }));
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });

  afterAll(async () => {
    await new Promise((r) => server.close(r));
  });

  const cfg = { provider: "custom" as const, baseUrl: "", model: "test-model", apiKey: "sk-test" };

  it("端点支持流式：SSE 累加合成非流式同形对象", async () => {
    mode = "sse";
    seenBodies.length = 0;
    const data = (await postChat({ ...cfg, baseUrl }, { model: "test-model", messages: [] })) as {
      choices: { finish_reason: string; message: { content: string } }[];
    };
    expect(data.choices[0].message.content).toBe("你好");
    expect(data.choices[0].finish_reason).toBe("stop");
    expect(seenBodies).toHaveLength(1);
    expect(seenBodies[0].stream).toBe(true); // 默认走流式
  });

  it("端点不支持流式：400 自动去掉 stream 回退非流式", async () => {
    mode = "noStream";
    seenBodies.length = 0;
    const data = (await postChat({ ...cfg, baseUrl }, { model: "test-model", messages: [] })) as {
      choices: { message: { content: string } }[];
    };
    expect(data.choices[0].message.content).toBe("非流式回答");
    expect(seenBodies).toHaveLength(2); // 第一次 stream 被 400，第二次非流式成功
    expect(seenBodies[0].stream).toBe(true);
    expect(seenBodies[1].stream).toBeUndefined();
  });
});
