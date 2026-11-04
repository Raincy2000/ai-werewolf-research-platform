// ============================================================
// 决策预算分流锁定（2026-10-14 实锤：20261014001 第5天双程管线涌现重试只剩 43s 必败托管）
// 人格双程管线（心镜+涌现=两次思考调用）预算必须翻倍；单程/非人格座位不翻倍
// ============================================================

import { describe, expect, it } from "vitest";
import { decisionDeadlineMs } from "./service";
import type { GameRuntime } from "./service";

const deepseek = { provider: "deepseek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", apiKey: "x" } as never;
const kimi8k = { provider: "kimi", baseUrl: "https://api.moonshot.cn/v1", model: "moonshot-v1-8k", apiKey: "x" } as never;

function fakeRt(aiTimeLimitSec: number, personaSeats: number[] = []): GameRuntime {
  return {
    options: { aiTimeLimitSec },
    personaCards: new Map(personaSeats.map((s) => [s, {}])),
  } as never;
}

describe("决策预算分流（人格双程管线翻倍）", () => {
  it("人格座位+思考型模型+双程上下文：预算下限 520s（两次思考+重试余量）", () => {
    const rt = fakeRt(120, [1]);
    expect(decisionDeadlineMs(rt, deepseek, 1)).toBe(520_000);
  });

  it("非人格座位+思考型模型：维持 260s 单程下限", () => {
    const rt = fakeRt(120, []);
    expect(decisionDeadlineMs(rt, deepseek, 1)).toBe(260_000);
  });

  it("人格座位但小上下文（单程合并）：不翻倍", () => {
    const rt = fakeRt(120, [1]);
    expect(decisionDeadlineMs(rt, kimi8k, 1)).toBe(120_000); // 非思考+单程：用户限时 120s 原样生效
  });

  it("人格座位+非思考型+双程上下文：240s（两次 90s 常规调用+余量）", () => {
    // gpt-4o：128K 上下文走双程、非思考型
    const gpt = { provider: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-4o", apiKey: "x" } as never;
    const rt = fakeRt(120, [1]);
    expect(decisionDeadlineMs(rt, gpt, 1)).toBe(240_000);
  });

  it("不限时（aiTimeLimitSec=0）：无穷大不受影响", () => {
    const rt = fakeRt(0, [1]);
    expect(decisionDeadlineMs(rt, deepseek, 1)).toBe(Number.POSITIVE_INFINITY);
  });
});
