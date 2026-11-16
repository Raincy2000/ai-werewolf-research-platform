import { describe, expect, it } from "vitest";
import type { GameEvent } from "../../contracts/game";
import {
  buildPrivateEvidenceIndex,
  buildPublicEvidenceIndex,
  formatEvidenceRefs,
} from "./evidence";

function event(seq: number, patch: Partial<GameEvent>): GameEvent {
  return {
    seq,
    day: 1,
    phase: "day.speech",
    type: "speech",
    actor: null,
    actorLabel: null,
    title: "公开发言",
    content: "公开事实",
    thought: null,
    meta: null,
    createdAt: new Date().toISOString(),
    ...patch,
  };
}

const events: GameEvent[] = [
  event(179, { actor: 9, actorLabel: "9号玩家", content: "我第一夜的查验：1号，狼人。" }),
  event(401, { actor: 8, actorLabel: "8号玩家", title: "遗言", content: "交个底：女巫。两瓶药，一滴不剩。" }),
  event(40, { type: "system", title: "警长定序", content: "警长1号选择升序发言。" }),
  event(10, { type: "action", actor: 4, title: "狼人频道", content: "刀5号", meta: { channel: "wolf" } }),
  event(20, { type: "system", actor: 4, title: "警长定序", content: "警长4号选择升序发言。", meta: { channel: "skillThink" } }),
  event(30, { type: "action", actor: 8, title: "女巫用药", content: "女巫使用毒药毒杀3号玩家。", phase: "night.witch" }),
  event(500, { actor: 2, content: "完整长发言".repeat(2_000) }),
];

describe("完整事实索引", () => {
  it("公开查杀与遗言全文保留，超过9000字也不降级、不省略", () => {
    const refs = buildPublicEvidenceIndex("g", events);
    expect(refs.some((r) => r.seq === 179 && r.text === "我第一夜的查验：1号，狼人。")).toBe(true);
    expect(refs.some((r) => r.seq === 401 && r.text.includes("交个底：女巫"))).toBe(true);
    expect(refs.map((r) => r.seq)).toEqual([179, 401, 40, 500]);
    expect(refs.every((r) => r.visibility === "public")).toBe(true);
    const text = formatEvidenceRefs(refs, "完整事实");
    expect(text.length).toBeGreaterThan(9_000);
    expect(text).not.toContain("已省略");
    expect(text).toContain("完整长发言");
  });

  it("公共索引不泄露狼队频道、权衡心理或夜间私密行动", () => {
    const refs = buildPublicEvidenceIndex("g", events);
    expect(refs.some((r) => r.seq === 10)).toBe(false);
    expect(refs.some((r) => r.seq === 20)).toBe(false);
    expect(refs.some((r) => r.seq === 30)).toBe(false);
    expect(refs.every((r) => r.contentHash.length === 64)).toBe(true);
    expect(buildPublicEvidenceIndex("g", events).map((r) => r.contentHash)).toEqual(refs.map((r) => r.contentHash));
  });

  it("私域只含本人事件，狼队频道只在本人属于见面狼时可见", () => {
    const seer = buildPrivateEvidenceIndex("g", 9, events, { wolfTeam: false });
    expect(seer.map((r) => r.seq)).toEqual([179]);
    expect(seer.every((r) => r.ownerSeat === 9)).toBe(true);

    const witch = buildPrivateEvidenceIndex("g", 8, events, { wolfTeam: false });
    expect(witch.map((r) => r.seq)).toEqual([401, 30]);
    expect(witch.some((r) => r.seq === 10)).toBe(false);

    const wolf = buildPrivateEvidenceIndex("g", 4, events, { wolfTeam: true });
    expect(wolf.map((r) => r.seq)).toEqual([10, 20]);
    expect(wolf.every((r) => r.ownerSeat === 4)).toBe(true);
    expect(wolf.some((r) => r.seq === 30)).toBe(false);
  });
});
