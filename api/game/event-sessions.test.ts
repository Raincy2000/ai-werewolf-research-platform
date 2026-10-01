// 事件流时段分组（开局/第N夜/第N日）纯函数测试：
// 昼夜归类、game.over 跟随当前组、跨天顺序、中文序数、空输入与边界
import { describe, it, expect } from "vitest";
import type { GameEvent } from "../../contracts/game";
import { groupEventsIntoSessions } from "../../src/lib/eventSessions";

let seq = 0;
function ev(phase: string, day: number): GameEvent {
  return {
    seq: ++seq,
    gameId: "g",
    day,
    phase,
    type: "phase",
    actor: null,
    actorLabel: null,
    title: phase,
    content: "",
    thought: null,
    meta: null,
  } as unknown as GameEvent;
}

describe("事件流时段分组", () => {
  it("按时间顺序分组：开局 → 第一夜 → 第一日 → 第二夜 → 第二日", () => {
    const sessions = groupEventsIntoSessions([
      ev("game.init", 0), ev("game.start", 0),
      ev("night.start", 1), ev("night.wolf", 1), ev("night.witch", 1), ev("night.settle", 1),
      ev("day.start", 1), ev("day.speech", 1), ev("day.vote", 1),
      ev("night.start", 2), ev("night.wolf", 2),
      ev("day.start", 2), ev("day.vote", 2),
    ]);
    expect(sessions.map((s) => s.label)).toEqual(["开局", "第一夜", "第一日", "第二夜", "第二日"]);
    expect(sessions.map((s) => s.events.length)).toEqual([2, 4, 3, 2, 2]);
    expect(sessions.map((s) => s.key)).toEqual(["init", "d1-night", "d1-day", "d2-night", "d2-day"]);
  });

  it("game.over 跟随当前组，不单独成组", () => {
    const sessions = groupEventsIntoSessions([
      ev("night.wolf", 1), ev("game.over", 1),
    ]);
    expect(sessions.length).toBe(1);
    expect(sessions[0].label).toBe("第一夜");
    expect(sessions[0].events.length).toBe(2);
    // 白天结束同理：终局归入当日组
    const s2 = groupEventsIntoSessions([ev("day.vote", 3), ev("game.over", 3)]);
    expect(s2.length).toBe(1);
    expect(s2[0].label).toBe("第三日");
  });

  it("中文序数：十以内与十一以上", () => {
    const sessions = groupEventsIntoSessions([
      ev("night.wolf", 3), ev("day.vote", 11),
    ]);
    expect(sessions[0].label).toBe("第三夜");
    expect(sessions[1].label).toBe("第十一日");
  });

  it("空输入返回空数组；无法判定阶段且无当前组时归入开局", () => {
    expect(groupEventsIntoSessions([])).toEqual([]);
    const sessions = groupEventsIntoSessions([ev("game.over", 1)]);
    expect(sessions.length).toBe(1);
    expect(sessions[0].label).toBe("开局");
  });

  it("赛后发言独立成组：postgame.* 事件归入「赛后发言」时间标签", () => {
    const sessions = groupEventsIntoSessions([
      ev("day.vote", 2), ev("game.over", 2),
      ev("postgame.discuss", 2), ev("postgame.discuss", 2), ev("postgame.discuss", 2),
    ]);
    expect(sessions.map((s) => s.key)).toEqual(["d2-day", "postgame"]);
    expect(sessions[1].label).toBe("赛后发言");
    expect(sessions[1].events.length).toBe(3);
  });

  it("withCurrentSession：当前处于 postgame 阶段时补出「赛后发言」空标签", async () => {
    const { withCurrentSession } = await import("../../src/lib/eventSessions");
    const sessions = withCurrentSession(
      groupEventsIntoSessions([ev("day.vote", 2)]),
      2,
      "postgame.discuss",
    );
    expect(sessions.length).toBe(2);
    expect(sessions[1].key).toBe("postgame");
    expect(sessions[1].label).toBe("赛后发言");
    expect(sessions[1].events.length).toBe(0);
  });
});
