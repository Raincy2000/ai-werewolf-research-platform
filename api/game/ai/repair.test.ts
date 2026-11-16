// repairDecision 动作主权回归测试
// 非法意图只能被诊断并退回，不得被系统静默改写成另一个合法动作。
import { describe, expect, it } from "vitest";
import type { DecisionInput, PendingDecision, PlayerView } from "../engine/api";
import { repairDecision } from "../service";

function viewOf(over: Partial<PlayerView> = {}, priv: PlayerView["private"] = {}): PlayerView {
  return {
    seat: 7,
    role: "witch",
    roleName: "女巫",
    camp: "good",
    day: 2,
    phase: "night.witch",
    aliveSeats: [1, 3, 5, 7, 9, 11],
    deadSeats: [2],
    revealedRoles: {},
    sheriffSeat: null,
    selfAlive: true,
    rules: { witchSelfSave: "never" },
    publicLog: [],
    private: priv,
    ...over,
  } as PlayerView;
}

function pendingOf(over: Partial<PendingDecision> = {}): PendingDecision {
  return {
    seat: 7,
    role: "witch",
    kind: "witchAction",
    options: [1, 3, 5, 9, 11],
    allowSkip: true,
    view: viewOf(),
    hint: "决定是否用药",
    ...over,
  } as PendingDecision;
}

describe("repairDecision - 动作主权", () => {
  it("同晚双药互斥：原样退回双药意图，不替玩家优先保留解药", () => {
    const p = pendingOf({
      view: viewOf({}, { witchPotions: { save: true, poison: true }, witchVictimTonight: 5 }),
    });
    const inp: DecisionInput = { thought: "救人又毒人", witchSave: true, targets: [9] };
    const { input, notes } = repairDecision(p, inp);
    expect(input).toEqual(inp);
    expect(input.witchSave).toBe(true);
    expect(input.targets).toEqual([9]);
    expect(notes).toEqual([]);
  });

  it("解药耗尽：不剔除解药、不自动生成 skip", () => {
    const p = pendingOf({
      view: viewOf({}, { witchPotions: { save: false, poison: true }, witchVictimTonight: 5 }),
    });
    const inp: DecisionInput = { thought: "想救5号", witchSave: true };
    const { input, notes } = repairDecision(p, inp);
    expect(input).toEqual(inp);
    expect(input.witchSave).toBe(true);
    expect(input.skip).toBeUndefined();
    expect(notes).toEqual([]);
  });

  it("毒药耗尽：不删除毒杀目标、不自动生成 skip", () => {
    const p = pendingOf({
      view: viewOf({}, { witchPotions: { save: true, poison: false }, witchVictimTonight: 5 }),
    });
    const inp: DecisionInput = { thought: "毒9", targets: [9] };
    const { input } = repairDecision(p, inp);
    expect(input).toEqual(inp);
    expect(input.targets).toEqual([9]);
    expect(input.skip).toBeUndefined();
  });

  it("合法用药：原样通过", () => {
    const p = pendingOf({
      view: viewOf({}, { witchPotions: { save: true, poison: true }, witchVictimTonight: 5 }),
    });
    const inp: DecisionInput = { thought: "救5号", witchSave: true };
    const { input, notes } = repairDecision(p, inp);
    expect(input).toEqual(inp);
    expect(notes).toEqual([]);
  });

  it("白狼王带人误给自爆字段：不替玩家剥离字段后继续结算", () => {
    const p = pendingOf({
      kind: "whiteWolfTake",
      role: "whiteWolfKing",
      allowSkip: false,
      view: viewOf({ role: "whiteWolfKing" as never }),
    });
    const inp: DecisionInput = { thought: "带走9号", selfDestruct: true, targets: [9] };
    const { input } = repairDecision(p, inp);
    expect(input).toEqual(inp);
  });

  it("通用目标越界：不把剩余合法目标拼成新决定", () => {
    const p = pendingOf({ kind: "seerCheck", allowSkip: false });
    const inp: DecisionInput = { thought: "验人", targets: [9, 99] };
    const { input } = repairDecision(p, inp);
    expect(input).toEqual(inp);
    expect(input.targets).toEqual([9, 99]);
  });
});
