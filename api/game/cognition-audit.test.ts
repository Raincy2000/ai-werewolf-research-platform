import { describe, expect, it } from "vitest";
import type { GameEvent } from "../../contracts/game";
import type { DecisionInput } from "./engine/api";
import { buildCognitionAudit, compareCognitionAudits } from "./cognition-audit";

function event(seq: number, patch: Partial<GameEvent> = {}): GameEvent {
  return {
    seq,
    day: 1,
    phase: "postgame.discuss",
    type: "speech",
    actor: 1,
    actorLabel: "1号玩家",
    title: "赛后讨论",
    content: "各自署名，我先把话说完。",
    thought: null,
    meta: { addressTo: 2 },
    createdAt: new Date(0).toISOString(),
    ...patch,
  };
}

describe("R0 认知只读审计", () => {
  it("分别统计来源、显式意图、互动和跨座位共享语言，不产生行为评分", () => {
    const events = [
      event(1),
      event(2, { actor: 2, actorLabel: "2号玩家", content: "各自署名，我不回答。", meta: { addressTo: 1 } }),
      event(3, { actor: 3, actorLabel: "3号玩家", content: "各自署名，到此为止。", meta: { addressTo: null } }),
      event(4, { type: "action", actor: 3, content: "（本轮选择沉默，暂不发言）", meta: null }),
    ];
    const decisions = [
      { idx: 0, kind: "postgameSpeak", seat: 1, decision: { thought: "我想回应", intent: { targetSeats: [2], basisEventSeqs: [2] } } as DecisionInput },
      { idx: 1, kind: "postgameSpeak", seat: 2, decision: { thought: "我不回答" } as DecisionInput },
    ];
    const audit = buildCognitionAudit(events, decisions);
    expect(audit.source.eventCount).toBe(4);
    expect(audit.source.actorEventCount).toBe(4);
    expect(audit.intent.decisionCount).toBe(2);
    expect(audit.intent.explicitIntentCount).toBe(1);
    expect(audit.intent.basisReferenceCount).toBe(1);
    expect(audit.interaction.speechCount).toBe(3);
    expect(audit.interaction.directedSpeechCount).toBe(2);
    expect(audit.interaction.silenceCount).toBe(1);
    expect(audit.language.speakerCount).toBe(3);
    expect(audit.language.sharedPhrases[0]).toMatchObject({ text: "各自署名", speakerCount: 3 });
    expect(audit).not.toHaveProperty("score");
  });

  it("版本比较只返回各项计数差值，不把差异换算成拟真奖惩", () => {
    const before = buildCognitionAudit([event(1)], []);
    const after = buildCognitionAudit([event(1), event(2, { actor: 2, content: "短答。" })], []);
    const diff = compareCognitionAudits(before, after);
    expect(diff.source.eventCount).toBe(1);
    expect(diff.interaction.speechCount).toBe(1);
    expect(diff.language.speakerCount).toBe(1);
    expect(diff).not.toHaveProperty("score");
  });
});
