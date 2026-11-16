import { describe, expect, it } from "vitest";
import type { GameEvent } from "../../contracts/game";
import { buildCurrentInteraction, formatCurrentInteraction } from "./evidence";
import { KIND_GUIDE } from "./ai/prompts";

function event(seq: number, actor: number, content: string, addressTo: number | null = null): GameEvent {
  return {
    seq, day: 1, phase: "postgame.discuss", type: "speech", actor, actorLabel: `${actor}号玩家`,
    title: "赛后讨论", content, thought: null, meta: { round: 2, addressTo }, createdAt: new Date(0).toISOString(),
  };
}

describe("R3 赛后真实回应", () => {
  it("当前互动直接列出本人上次决策后的新增发言原文和明确指代", () => {
    const own = event(10, 3, "我的上一轮话。", 1);
    own.meta = { round: 1, addressTo: 1 };
    const events = [own, event(11, 1, "我回应你上一轮的票。", 3), event(12, 2, "我也补一句。")];
    const current = buildCurrentInteraction("g", 3, events, { targetSeats: [0, 1, 2] });
    expect(current.newSpeeches).toEqual([
      { seq: 11, actorSeat: 1, actorLabel: "1号玩家", text: "我回应你上一轮的票。", addressTo: 3 },
      { seq: 12, actorSeat: 2, actorLabel: "2号玩家", text: "我也补一句。", addressTo: null },
    ]);
    const text = formatCurrentInteraction(current);
    expect(text).toContain("我回应你上一轮的票。");
    expect(text).toContain("我也补一句。");
    expect(text).toContain("可回应其中任何一条，也可沉默或结束话题；无需总结全局");
    expect(text).not.toContain("必须回答");
  });

  it("赛后规则只提供选择，不要求逐轮完整复盘", () => {
    expect(KIND_GUIDE.postgameSpeak).toContain("可短答、沉默或结束话题");
    expect(KIND_GUIDE.postgameSpeak).toContain("无需每轮总结全局");
    expect(KIND_GUIDE.postgameSpeak).not.toContain("必须回答");
  });
});
