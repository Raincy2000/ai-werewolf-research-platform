import { describe, expect, it } from "vitest";
import { buildPrompt } from "./ai/prompts";
import { buildEmergencePrompt, emptyMirrorReport } from "../persona/pipeline";
import { makeCard, makePending } from "../persona/pipeline.test";
import { sanitizeBatchInput } from "./service";

describe("R1 显式意图进入真实决策路径", () => {
  it("普通与人格输出契约都允许主体当场提交意图和依据事件", () => {
    const pending = makePending("daySpeech");
    const base = buildPrompt(pending, {});
    expect(base.user).toContain('"intent"');
    expect(base.user).toContain('"basisEventSeqs"');
    const persona = buildEmergencePrompt(makeCard(), emptyMirrorReport(), null, base, null, pending, 0);
    expect(persona.user).toContain('"intent"');
    expect(persona.user).toContain('"basisEventSeqs"');
  });

  it("并行批次清洗保留合法动作之外的认知字段", () => {
    const pending = makePending("wolfThink");
    const decision = sanitizeBatchInput(pending, {
      thought: "我自己的思考",
      intent: { targetSeats: [7], rationale: "我自己的理由", basisEventSeqs: [9] },
    });
    expect(decision.intent).toEqual({ targetSeats: [7], rationale: "我自己的理由", basisEventSeqs: [9] });
  });
});
