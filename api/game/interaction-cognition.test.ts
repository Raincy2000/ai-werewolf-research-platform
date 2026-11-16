import { describe, expect, it } from "vitest";
import type { GameEvent } from "../../contracts/game";
import type { PendingDecision } from "./engine/api";
import { buildCurrentInteraction, buildLiveCognition, formatCurrentInteraction } from "./evidence";
import { buildPrompt } from "./ai/prompts";

function event(seq: number, patch: Partial<GameEvent>): GameEvent {
  return {
    seq, day: 1, phase: "postgame.discuss", type: "speech", actor: null, actorLabel: null,
    title: "赛后讨论", content: "", thought: null, meta: null,
    createdAt: new Date().toISOString(), ...patch,
  };
}

describe("本轮互动事实包", () => {
  it("保留最新发言原文、明确指代、新增事件与合法选择，不添加语义判断", () => {
    const events = [
      event(400, { actor: 1, actorLabel: "1号玩家", content: "我只是想问清楚这一点。", meta: { round: 1, addressTo: 3 } }),
    ];
    const current = buildCurrentInteraction("g", 3, events, { targetSeats: [0, 1, 2, 4] });
    expect(current).toMatchObject({
      latestSeq: 400,
      latestSpeakerSeat: 1,
      latestText: "我只是想问清楚这一点。",
      explicitlyAddressedSeats: [3],
      newEventSeqsSinceOwnDecision: [400],
      round: 1,
    });
    const text = formatCurrentInteraction(current);
    expect(text).toContain("我只是想问清楚这一点");
    expect(text).toContain("3号");
    expect(text).toContain("所有人");
    expect(text).not.toContain("0号");
    expect(text).not.toContain("挑衅");
    expect(text).not.toContain("应当回应");
    expect(text).not.toContain("必须回答");
  });

  it("新增事件从本人上一次赛后决策之后计算，首轮空对话不伪造发言", () => {
    const events = [
      event(400, { actor: 3, content: "我的上一轮发言", meta: { round: 1 } }),
      event(401, { actor: 4, content: "我回应你刚才那句。", meta: { round: 2 } }),
      event(402, { type: "phase", content: "下一轮", meta: null }),
    ];
    const current = buildCurrentInteraction("g", 3, events, { targetSeats: [] });
    expect(current.newEventSeqsSinceOwnDecision).toEqual([401, 402]);
    expect(current.latestSpeakerSeat).toBe(4);
    expect(current.round).toBe(2);
    const empty = buildCurrentInteraction("g", 3, [], { targetSeats: [] });
    expect(empty.latestSeq).toBeNull();
    expect(empty.latestText).toBeNull();
    expect(empty.newEventSeqsSinceOwnDecision).toEqual([]);
    expect(formatCurrentInteraction(empty)).not.toContain("undefined");
  });

  it("当前互动随完整认知包进入基础提示，且不覆盖完整历史", () => {
    const events = [event(400, { actor: 1, content: "这是刚刚发生的话。", meta: { round: 1, addressTo: 3 } })];
    const cognition = buildLiveCognition("g", 3, events, { wolfTeam: false, postgame: true, targetSeats: [1, 2] });
    expect(cognition.currentInteraction).toContain("这是刚刚发生的话");
    const pending: PendingDecision = {
      seat: 3, role: "seer", kind: "postgameSpeak", options: [0, 1, 2], allowSkip: true, hint: "赛后讨论",
      view: {
        seat: 3, role: "seer", roleName: "预言家", camp: "god", day: 1, phase: "postgame.discuss",
        aliveSeats: [1, 2, 3], deadSeats: [], revealedRoles: {}, sheriffSeat: null, selfAlive: true,
        publicLog: [], private: {}, rules: { witchSelfSave: "never", postGameDiscuss: true },
      },
    };
    const { user } = buildPrompt(pending, { cognition });
    expect(user).toContain("【本轮互动事实】");
    expect(user).toContain("这是刚刚发生的话");
    expect(user).toContain("【赛后完整公共事实");
    expect(user.indexOf("【本轮互动事实】")).toBeLessThan(user.indexOf("【赛后完整公共事实"));
  });
});
