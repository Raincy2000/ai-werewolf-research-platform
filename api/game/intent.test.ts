import { describe, expect, it } from "vitest";
import type { GameEvent } from "../../contracts/game";
import type { DecisionInput } from "./engine/api";
import { buildIntentTrail, formatIntentTrail, type IntentDecisionRow } from "./intent";

function event(seq: number, patch: Partial<GameEvent>): GameEvent {
  return {
    seq,
    day: 4,
    phase: "night.wolfThink",
    type: "action",
    actor: null,
    actorLabel: null,
    title: "狼人频道",
    content: "（独立思考）",
    thought: null,
    meta: { channel: "wolf" },
    createdAt: new Date().toISOString(),
    ...patch,
  };
}

const longReason = "先收牌，再收嘴。".repeat(20);
const rows: IntentDecisionRow[] = [
  { idx: 82, kind: "wolfThink", seat: 4, decision: { thought: "", batchInputs: [{ thought: "4号理由", targets: [12] }, { thought: longReason, targets: [12] }] } },
  { idx: 84, kind: "wolfDiscuss", seat: 7, decision: { thought: "6号若活着，天亮第一句就会问我。", speech: "刀口我签在6号身上。", targets: [6] } },
  { idx: 86, kind: "wolfKill", seat: 7, decision: { thought: "12号，我改过来。不是跟着谁点头，是我自己量完了。", targets: [12] } },
];
const events: GameEvent[] = [
  event(201, { actor: 4, actorLabel: "4号玩家" }),
  event(202, { actor: 7, actorLabel: "7号玩家" }),
  event(205, { phase: "night.wolfDiscuss", actor: 7, actorLabel: "7号玩家", content: "刀口我签在6号身上。" }),
  event(209, { phase: "night.wolf", actor: 7, actorLabel: "7号玩家", title: "狼刀投票", content: "7号狼人选择袭击12号玩家。" }),
];

describe("主体意图轨迹", () => {
  it("狼队独立思考、队内讨论与最终刀口形成12→6→12，保留完整理由且未解释不代写", () => {
    const trail = buildIntentTrail("g", 7, rows, events, { wolfTeam: true });
    expect(trail.map((revision) => revision.next.targetSeats)).toEqual([[12], [6], [12]]);
    expect(trail.map((revision) => revision.decisionIdx)).toEqual([82, 84, 86]);
    expect(trail.map((revision) => revision.stage)).toEqual(["draft", "proposed", "voted"]);
    expect(trail[0].next.rationale).toBe(longReason);
    expect(trail[1].previous?.targetSeats).toEqual([12]);
    expect(trail[1].revisionNarrative).toBeNull();
    expect(trail[2].revisionNarrative).toContain("我改过来");
    expect(trail[1].counterEvidenceRefs).toEqual([]);
    const text = formatIntentTrail(trail);
    expect(text).toContain("未明确解释改口");
    expect(text).toContain("我改过来");
    expect(text).toContain(longReason);
  });

  it("批量投票只按真实事件座位顺序对齐，不把一个座位的意图写给另一个人", () => {
    const voteRows: IntentDecisionRow[] = [{
      idx: 89,
      kind: "dayVote",
      seat: 5,
      decision: {
        thought: "",
        batchInputs: [5, 6, 7, 8, 10, 11].map((seat) => ({ thought: `${seat}号自己的理由`, targets: [10] })) as DecisionInput[],
      },
    }];
    const voteEvents = [351, 352, 353, 354, 355, 356].map((seq, index) => event(seq, {
      day: 4,
      phase: "day.vote",
      type: "vote",
      actor: [5, 6, 7, 8, 10, 11][index]!,
      actorLabel: `${[5, 6, 7, 8, 10, 11][index]}号玩家`,
      title: "放逐投票",
      content: "投票",
      meta: null,
    }));
    const trail = buildIntentTrail("g", 11, voteRows, voteEvents, { wolfTeam: false });
    expect(trail).toHaveLength(1);
    expect(trail[0].seat).toBe(11);
    expect(trail[0].next.rationale).toBe("11号自己的理由");
    expect(trail[0].triggerEventRefs).toEqual([{ gameId: "g", seq: 356 }]);
  });

  it("独立思考的明确自然语言目标可提取，狼刀与上警布尔选项不跨域比较", () => {
    const mixedRows: IntentDecisionRow[] = [
      { idx: 0, kind: "wolfThink", seat: 1, decision: { thought: "就这么定：7号。" } },
      { idx: 13, kind: "sheriffRun", seat: 1, decision: { thought: "上警", targets: [1] } },
    ];
    const trail = buildIntentTrail("g", 1, mixedRows, events, { wolfTeam: true });
    expect(trail[0].next.targetSeats).toEqual([7]);
    expect(trail[1].next.targetSeats).toEqual([]);
    expect(formatIntentTrail(trail)).not.toContain("7号 → 1号");
    expect(formatIntentTrail(trail)).not.toContain("7号 → 无明确目标");
  });

  it("daySkill合并批次按发言原文和技能事件对齐座位", () => {
    const skillRows: IntentDecisionRow[] = [{
      idx: 32,
      kind: "daySkill",
      seat: 1,
      decision: { thought: "", batchInputs: [
        { thought: "11号自己的技能权衡", skip: true },
        { thought: "5号自己的发言理由", speech: "5号这段公开发言" },
      ] },
    }];
    const skillEvents: GameEvent[] = [
      event(130, { day: 1, phase: "day.speech", type: "action", actor: 11, actorLabel: "11号玩家", title: "技能权衡", content: "11号按兵不动", meta: { channel: "skillThink" } }),
      event(134, { day: 1, phase: "day.speech", type: "speech", actor: 5, actorLabel: "5号玩家", title: "公开发言", content: "5号这段公开发言", meta: null }),
    ];
    expect(buildIntentTrail("g", 11, skillRows, skillEvents, { wolfTeam: false })[0]?.next.rationale).toBe("11号自己的技能权衡");
    expect(buildIntentTrail("g", 5, skillRows, skillEvents, { wolfTeam: false })[0]?.next.rationale).toBe("5号自己的发言理由");
  });

  it("非狼的意图触发事件不包含狼频道或他人夜间私域", () => {
    const trail = buildIntentTrail("g", 7, rows.slice(1, 2), events, { wolfTeam: false });
    expect(trail).toHaveLength(0);
  });

  it("明确放弃前序目标记为abandoned，但不替玩家补理由", () => {
    const abandonRows: IntentDecisionRow[] = [
      { idx: 1, kind: "wolfThink", seat: 7, decision: { thought: "刀12", targets: [12] } },
      { idx: 2, kind: "wolfKill", seat: 7, decision: { thought: "先不刀", skip: true } },
    ];
    const trail = buildIntentTrail("g", 7, abandonRows, events, { wolfTeam: true });
    expect(trail[1].stage).toBe("abandoned");
    expect(trail[1].revisionNarrative).toBeNull();
  });
});
