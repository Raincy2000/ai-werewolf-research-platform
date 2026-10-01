// providers 传输层与参数兼容测试（kimi-k3 事故回归）：
// - Kimi 思考系请求体免传 temperature（官方固定 1.0，传入他值必 400 空跑一轮）
// - Moonshot 8K 版仍显式带 max_tokens=8192（网关要求）
// - deadlineAt 决策预算在重试循环内逐次生效：预算耗尽即收手（历史：120s 预算实际烧 274s）
// - 传输层走 longFetch（npm undici，无隐藏 300s headersTimeout）
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SeatAiConfig } from "../../../contracts/game";

const h = {
  calls: [] as { url: string; body: Record<string, unknown> }[],
  failWith500: 0, // 接下来的 N 次调用返回 500
  failWith400: 0, // 接下来的 N 次调用返回 400（不含 max_tokens/temperature 字样的普通参数错误）
};

vi.mock("../../lib/longFetch", () => ({
  longFetch: async (url: string, init: { body: string }) => {
    h.calls.push({ url, body: JSON.parse(init.body) });
    if (h.failWith400 > 0) {
      h.failWith400--;
      return new Response(JSON.stringify({ error: { message: "bad request" } }), {
        status: 400,
      });
    }
    if (h.failWith500 > 0) {
      h.failWith500--;
      return new Response(JSON.stringify({ error: { message: "engine overloaded" } }), {
        status: 500,
      });
    }
    return new Response(
      JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }),
      { status: 200 },
    );
  },
  netErrorMessage: (e: Error) => `网络失败（${e.message}）`,
}));

// 延迟加载被测模块（等 mock 注册完毕）
const { callAi } = await import("./providers");

function cfg(model: string, provider: SeatAiConfig["provider"] = "kimi"): SeatAiConfig {
  return { seat: 1, provider, baseUrl: "http://mock.local/v1", model, apiKey: "sk-mock" };
}

beforeEach(() => {
  h.calls.length = 0;
  h.failWith500 = 0;
  h.failWith400 = 0;
});

describe("providers：请求体参数兼容", () => {
  it("Kimi 思考系（kimi-k3/k3-256k/k2.x）免传 temperature", async () => {
    for (const model of ["kimi-k3", "k3-256k", "kimi-k2.6", "kimi-k2.7-code"]) {
      const res = await callAi(cfg(model), "s", "u");
      expect(res.ok).toBe(true);
      const body = h.calls.at(-1)!.body;
      expect("temperature" in body).toBe(false);
      expect(body.model).toBe(model);
      expect(body.response_format).toEqual({ type: "json_object" });
    }
  });

  it("常规模型照常带 temperature=0.7；Moonshot 8K 版仍显式 max_tokens=8192", async () => {
    await callAi(cfg("moonshot-v1-8k"), "s", "u");
    let body = h.calls.at(-1)!.body;
    expect(body.temperature).toBe(0.7);
    expect(body.max_tokens).toBe(8192);

    await callAi(cfg("kimi-k2"), "s", "u"); // K2 基础款：采样参数可自定义
    body = h.calls.at(-1)!.body;
    expect(body.temperature).toBe(0.7);
    expect("max_tokens" in body).toBe(false);

    await callAi(cfg("deepseek-chat", "deepseek"), "s", "u");
    expect(h.calls.at(-1)!.body.temperature).toBe(0.7);
  });
});

describe("providers：deadlineAt 决策预算约束", () => {
  it("预算耗尽即停止重试（不再空烧整轮超时）", async () => {
    h.failWith500 = 10; // 持续 500（可重试错误）
    const t0 = Date.now();
    const res = await callAi(cfg("kimi-k3"), "s", "u", {
      timeoutMs: 100,
      maxRetries: 5,
      deadlineAt: Date.now() + 250,
    });
    const elapsed = Date.now() - t0;
    expect(res.ok).toBe(false);
    // 预算 250ms：首发 100ms 失败后退避 400ms 即越线 → 至多 1-2 次真实请求；
    // 无预算约束的旧行为会打满 6 次（600ms+ 退避）
    expect(h.calls.length).toBeLessThanOrEqual(2);
    expect(elapsed).toBeLessThan(2_000);
  });

  it("无 deadlineAt 时按 maxRetries 打满重试（行为不回退）", async () => {
    h.failWith500 = 10;
    const res = await callAi(cfg("kimi-k3"), "s", "u", { timeoutMs: 30, maxRetries: 2 });
    expect(res.ok).toBe(false);
    expect(h.calls.length).toBe(3); // 首发 + 2 次重试
    expect(res.error).toContain("HTTP 500");
  });

  it("HTTP 4xx（非 429）放弃重试，不空烧等待", async () => {
    h.failWith400 = 5;
    const res = await callAi(cfg("kimi-k3"), "s", "u", { timeoutMs: 30, maxRetries: 2 });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("HTTP 400");
    // 首轮 400 → 触发一次 response_format 兼容回退（仍为 400）→ 4xx 判客户端错误即放弃；
    // 若无 4xx 快速放弃，maxRetries=2 会再空跑 2 轮
    expect(h.calls.length).toBe(2);
    expect("response_format" in h.calls[1]!.body).toBe(false); // 回退已去掉该参数
  });
});
