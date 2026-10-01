// ============================================================
// 回放事件时刻表 — 纯函数单测
// ============================================================

import { describe, expect, it } from "vitest";
import { buildReplaySchedule, REPLAY_MAX_GAP_MS } from "./replaySchedule";

const mk = (isoMs: number) => new Date(isoMs).toISOString();

describe("buildReplaySchedule（回放事件时刻表）", () => {
  it("相邻间隔按倍速缩放；长间隔截断到上限；首个事件立即", () => {
    const events = [mk(0), mk(1_000), mk(11_000), mk(13_000)].map((createdAt, i) => ({
      seq: i + 1,
      createdAt,
    }));
    const s1 = buildReplaySchedule(events, 1);
    expect(s1[0]!.delayMs).toBe(0);
    expect(s1[1]!.delayMs).toBe(1_000);
    expect(s1[2]!.delayMs).toBe(REPLAY_MAX_GAP_MS); // 10s 长思考被截断到上限 5s
    expect(s1[3]!.delayMs).toBe(2_000);

    const s3 = buildReplaySchedule(events, 3);
    expect(s3[1]!.delayMs).toBeCloseTo(333, 0);
    expect(s3[2]!.delayMs).toBeCloseTo(REPLAY_MAX_GAP_MS / 3, 0);
  });

  it("乱序/相同 createdAt 防御（间隔不为负）", () => {
    const events = [
      { seq: 1, createdAt: mk(5_000) },
      { seq: 2, createdAt: mk(5_000) },
      { seq: 3, createdAt: mk(4_000) },
    ];
    const s = buildReplaySchedule(events, 1);
    expect(s[1]!.delayMs).toBe(0);
    expect(s[2]!.delayMs).toBe(0);
  });

  it("0.5 倍速间隔翻倍", () => {
    const events = [mk(0), mk(2_000)].map((createdAt, i) => ({ seq: i + 1, createdAt }));
    expect(buildReplaySchedule(events, 0.5)[1]!.delayMs).toBe(4_000);
  });
});
