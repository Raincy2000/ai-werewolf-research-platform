import { describe, expect, it } from "vitest";
import { elapsedAt, finishTiming, initialGameTiming, pauseTiming, restoreTiming, startTiming } from "./timing";

describe("对局累计计时", () => {
  it("开始、暂停、继续、终止均按区间累计且终止后冻结", () => {
    let t = initialGameTiming();
    t = startTiming(t, 1_000);
    expect(elapsedAt(t, 5_000)).toBe(4_000);
    t = pauseTiming(t, 5_000);
    expect(elapsedAt(t, 9_000)).toBe(4_000);
    t = startTiming(t, 9_000);
    expect(elapsedAt(t, 11_000)).toBe(6_000);
    t = finishTiming(t, 11_000);
    expect(elapsedAt(t, 20_000)).toBe(6_000);
    expect(t.endedAt).toBe(11_000);
  });

  it("恢复时只结算到最后保存点，运行对局从恢复时刻重新起算", () => {
    const restored = restoreTiming({
      accumulatedMs: 2_000,
      startedAt: 1_000,
      runningSince: 5_000,
      endedAt: null,
      savedAt: 7_000,
    }, "running", 10_000);
    expect(elapsedAt(restored, 10_000)).toBe(4_000);
    expect(elapsedAt(restored, 12_000)).toBe(6_000);
    const paused = restoreTiming({
      accumulatedMs: 2_000,
      startedAt: 1_000,
      runningSince: 5_000,
      endedAt: null,
      savedAt: 7_000,
    }, "paused", 10_000);
    expect(elapsedAt(paused, 15_000)).toBe(4_000);
    expect(paused.runningSince).toBeNull();
  });
});
