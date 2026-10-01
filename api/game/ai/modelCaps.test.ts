// 模型能力画像测试（kimi-k3 事故回归：思考型判定/参数兼容/超时分流的单一事实源）
// 背景（2026-09-30 对局 20260930001 实锤）：kimi-k3 永远思考（reasoning_effort 默认 max），
// 但思考型保护只认 deepseek —— 90s 单次上限拦断思考链（超时 ×8）、120s 决策预算无 260s 下限、
// 批量托管 38 次。此后思考型判定/超时一律走 modelCaps，禁止再写 provider==="deepseek" 专属分支。
import { describe, it, expect, afterEach } from "vitest";
import { isThinkingModel, omitSamplingParams, defaultCallTimeoutMs } from "./modelCaps";

afterEach(() => {
  delete process.env.AI_TIMEOUT_MS;
});

describe("模型能力画像：思考型判定", () => {
  it("kimi-k3 / k3-256k / kimi-k2.x / deepseek / thinking 命名均为思考型", () => {
    expect(isThinkingModel({ provider: "kimi", model: "kimi-k3" })).toBe(true);
    expect(isThinkingModel({ provider: "kimi", model: "k3-256k" })).toBe(true);
    expect(isThinkingModel({ provider: "kimi", model: "kimi-k2.6" })).toBe(true);
    expect(isThinkingModel({ provider: "kimi", model: "kimi-k2.7-code" })).toBe(true);
    expect(isThinkingModel({ provider: "kimi", model: "kimi-thinking" })).toBe(true);
    expect(isThinkingModel({ provider: "deepseek", model: "deepseek-chat" })).toBe(true);
    expect(isThinkingModel({ provider: "custom", model: "my-thinking-pro" })).toBe(true);
  });

  it("常规模型不误判：moonshot 旧款 / kimi-k2 基础款 / gpt / claude", () => {
    expect(isThinkingModel({ provider: "kimi", model: "moonshot-v1-8k" })).toBe(false);
    expect(isThinkingModel({ provider: "kimi", model: "kimi-k2" })).toBe(false);
    expect(isThinkingModel({ provider: "openai", model: "gpt-4o-mini" })).toBe(false);
    expect(isThinkingModel({ provider: "anthropic", model: "claude-sonnet-4-5" })).toBe(false);
  });
});

describe("模型能力画像：Kimi 思考系免传采样参数", () => {
  it("k3/k2.x 免传（官方固定 temperature=1.0，传入他值必 400 空跑一轮）；其余照常", () => {
    expect(omitSamplingParams({ provider: "kimi", model: "kimi-k3" })).toBe(true);
    expect(omitSamplingParams({ provider: "custom", model: "k3-256k" })).toBe(true);
    expect(omitSamplingParams({ provider: "kimi", model: "kimi-k2.6" })).toBe(true);
    expect(omitSamplingParams({ provider: "kimi", model: "moonshot-v1-8k" })).toBe(false);
    expect(omitSamplingParams({ provider: "kimi", model: "kimi-k2" })).toBe(false);
    expect(omitSamplingParams({ provider: "deepseek", model: "deepseek-chat" })).toBe(false);
  });
});

describe("模型能力画像：单次调用默认超时", () => {
  it("思考型 150s / 常规 90s / AI_TIMEOUT_MS 环境变量全覆盖", () => {
    expect(defaultCallTimeoutMs({ provider: "kimi", model: "kimi-k3" })).toBe(150_000);
    expect(defaultCallTimeoutMs({ provider: "deepseek", model: "deepseek-chat" })).toBe(150_000);
    expect(defaultCallTimeoutMs({ provider: "kimi", model: "moonshot-v1-8k" })).toBe(90_000);
    expect(defaultCallTimeoutMs({ provider: "openai", model: "gpt-4o" })).toBe(90_000);
    process.env.AI_TIMEOUT_MS = "45000";
    expect(defaultCallTimeoutMs({ provider: "kimi", model: "kimi-k3" })).toBe(45_000);
  });
});
