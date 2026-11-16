import { describe, expect, it } from "vitest";
import type { GameEvent } from "../../contracts/game";
import { buildEpisodeViews, filterVisibleBasisEventSeqs, formatSelfActionLedger } from "./evidence";
import { buildIntentTrail, type IntentDecisionRow } from "./intent";
import { parseDecision } from "./ai/parse";
import type { PendingDecision } from "./engine/api";

function event(seq: number, patch: Partial<GameEvent> = {}): GameEvent {
  return {
    seq,
    day: 1,
    phase: "day.speech",
    type: "action",
    actor: 1,
    actorLabel: "1号玩家",
    title: "自爆",
    content: "1号玩家自爆出局。",
    thought: null,
    meta: null,
    createdAt: new Date(0).toISOString(),
    ...patch,
  };
}

const events = [
  event(9, { actor: 9, actorLabel: "9号玩家", content: "9号玩家自爆出局。" }),
  event(10, { actor: 9, actorLabel: "9号玩家", title: "白狼王带走", content: "2号玩家被白狼王带走。" }),
  event(11, { actor: 1, actorLabel: "1号玩家", content: "1号玩家自爆出局。" }),
  event(12, { actor: 4, actorLabel: "4号玩家", title: "狼人频道", content: "我投7号", meta: { channel: "wolf" } }),
];

describe("R1 来源绑定与显式意图", () => {
  it("本人行动、公共事件和狼队事件分源，原文字段不被个人摘要覆盖", () => {
    const views = buildEpisodeViews("g", 1, events, { wolfTeam: true, postgame: false });
    expect(views.find((row) => row.seq === 9)?.accessChannel).toBe("public");
    expect(views.find((row) => row.seq === 11)?.accessChannel).toBe("selfAction");
    expect(views.find((row) => row.seq === 12)?.accessChannel).toBe("wolfTeam");
    expect(views.every((row) => row.originalText === row.text)).toBe(true);
    const ledger = formatSelfActionLedger(views, 1);
    expect(ledger).toContain("#11");
    expect(ledger).not.toContain("#9]");
    expect(ledger).not.toContain("#12]");
  });

  it("依据引用只过滤不可见编号，不校验主体结论是否正确", () => {
    const views = buildEpisodeViews("g", 1, events, { wolfTeam: false, postgame: false });
    expect(filterVisibleBasisEventSeqs(views, [9, 11, 12, 999, 11])).toEqual([9, 11]);
  });

  it("显式意图无需从台词正则猜测，依据指针进入轨迹但不要求改口解释", () => {
    const rows: IntentDecisionRow[] = [
      { idx: 0, kind: "wolfThink", seat: 1, decision: { thought: "没有写出目标编号", intent: { targetSeats: [7], basisEventSeqs: [9] } } },
      { idx: 1, kind: "wolfKill", seat: 1, decision: { thought: "", targets: [7], intent: { targetSeats: [7], basisEventSeqs: [9, 11] } } },
    ];
    const trail = buildIntentTrail("g", 1, rows, events, { wolfTeam: true });
    expect(trail[0]?.next.targetSeats).toEqual([7]);
    expect(trail[0]?.basisEventRefs).toEqual([{ gameId: "g", seq: 9 }]);
    expect(trail[1]?.basisEventRefs).toEqual([{ gameId: "g", seq: 9 }, { gameId: "g", seq: 11 }]);
    expect(trail[1]?.revisionNarrative).toBeNull();
  });

  it("解析层保存显式意图但不把它变成额外动作或事实裁判", () => {
    const pending: PendingDecision = {
      seat: 1, role: "werewolf", kind: "daySpeech", options: [2, 3], allowSkip: false, hint: "发言",
      view: {
        seat: 1, role: "werewolf", roleName: "狼人", camp: "wolf", day: 1, phase: "day.speech",
        aliveSeats: [1, 2, 3], deadSeats: [], revealedRoles: {}, sheriffSeat: null, selfAlive: true,
        publicLog: [], private: {}, rules: { witchSelfSave: "never" },
      },
    };
    const decision = parseDecision(JSON.stringify({
      thought: "我仍然这样想",
      speech: "这是我的发言。",
      targets: [],
      intent: { targetSeats: [7, -2, 3.5], rationale: "我自己的理由", basisEventSeqs: [9, 999, 9] },
    }), pending)!;
    expect(decision.speech).toBe("这是我的发言。");
    expect(decision.targets).toBeUndefined();
    expect(decision.intent).toEqual({ targetSeats: [7], rationale: "我自己的理由", basisEventSeqs: [9, 999] });
  });
});
