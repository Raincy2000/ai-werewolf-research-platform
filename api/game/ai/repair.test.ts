// repairDecision 意图保留式修正的单元测试
// 事故回归（2026-08-02）：女巫解药耗尽仍 witchSave=true、白狼王带人输出 selfDestruct，
// 整轮被降级"[AI输出非法，系统托管]"。修正层必须把这些输出修成合法等价并保住 thought。
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

describe("repairDecision - 女巫用药", () => {
  it("解药已用完仍 witchSave=true → 剔除解药按不用药处理，保住 thought", () => {
    const p = pendingOf({
      view: viewOf({}, { witchPotions: { save: false, poison: true }, witchVictimTonight: 5 }),
    });
    const inp: DecisionInput = { thought: "想救5号", witchSave: true };
    const { input, notes } = repairDecision(p, inp);
    expect(input.witchSave).toBeUndefined();
    expect(input.skip).toBe(true);
    expect(input.thought).toBe("想救5号");
    expect(notes.join()).toContain("解药已用完");
  });

  it("解药有毒药也在 → witchSave 剔除后保留合法毒药意图", () => {
    const p = pendingOf({
      view: viewOf({}, { witchPotions: { save: false, poison: true }, witchVictimTonight: 5 }),
    });
    const inp: DecisionInput = { thought: "救不了就毒9号", witchSave: true, targets: [9] };
    const { input } = repairDecision(p, inp);
    expect(input.witchSave).toBeUndefined();
    expect(input.targets).toEqual([9]); // 毒药意图保留
    expect(input.skip).toBeUndefined();
  });

  it("今夜无人被刀 → 解药剔除", () => {
    const p = pendingOf({
      view: viewOf({}, { witchPotions: { save: true, poison: true }, witchVictimTonight: null }),
    });
    const { input, notes } = repairDecision(p, { thought: "t", witchSave: true });
    expect(input.witchSave).toBeUndefined();
    expect(input.skip).toBe(true);
    expect(notes.join()).toContain("无人被刀");
  });

  it("不能自救的版型自救 → 剔除；首夜可自救版型首夜自救 → 保留", () => {
    const base = { witchPotions: { save: true, poison: true }, witchVictimTonight: 7 };
    const p1 = pendingOf({ view: viewOf({}, base) }); // rules.never
    const r1 = repairDecision(p1, { thought: "自救", witchSave: true });
    expect(r1.input.witchSave).toBeUndefined();

    const p2 = pendingOf({
      view: viewOf({ day: 1, rules: { witchSelfSave: "firstNight" } }, base),
    });
    const r2 = repairDecision(p2, { thought: "自救", witchSave: true });
    expect(r2.input.witchSave).toBe(true);
  });

  it("毒药已用完仍给 targets → 剔除毒药按不用药", () => {
    const p = pendingOf({
      view: viewOf({}, { witchPotions: { save: true, poison: false }, witchVictimTonight: 5 }),
    });
    const { input, notes } = repairDecision(p, { thought: "毒9", targets: [9] });
    expect(input.targets).toBeUndefined();
    expect(input.skip).toBe(true);
    expect(notes.join()).toContain("毒药已用完");
  });

  it("同晚双药互斥 → 保留解药弃毒药", () => {
    const p = pendingOf({
      view: viewOf({}, { witchPotions: { save: true, poison: true }, witchVictimTonight: 5 }),
    });
    const { input, notes } = repairDecision(p, { thought: "救人又毒人", witchSave: true, targets: [9] });
    expect(input.witchSave).toBe(true);
    expect(input.targets).toBeUndefined();
    expect(notes.join()).toContain("只能用一瓶药");
  });

  it("完全合法输出原样通过（无修正说明）", () => {
    const p = pendingOf({
      view: viewOf({}, { witchPotions: { save: true, poison: true }, witchVictimTonight: 5 }),
    });
    const { input, notes } = repairDecision(p, { thought: "救5号", witchSave: true });
    expect(input.witchSave).toBe(true);
    expect(notes).toEqual([]);
  });
});

describe("repairDecision - 带人/开枪类", () => {
  const takePending = (over: Partial<PendingDecision> = {}): PendingDecision =>
    pendingOf({
      kind: "whiteWolfTake",
      role: "whiteWolfKing",
      allowSkip: false,
      view: viewOf({ role: "whiteWolfKing" as never }),
      ...over,
    });

  it("白狼王带人输出 selfDestruct → 剥离，合法 targets 保留", () => {
    const { input, notes } = repairDecision(takePending(), {
      thought: "带走9号",
      selfDestruct: true,
      targets: [9],
    });
    expect(input.selfDestruct).toBeUndefined();
    expect(input.targets).toEqual([9]);
    expect(notes.join()).toContain("selfDestruct");
  });

  it("不允许跳过时 skip 被忽略", () => {
    const { input } = repairDecision(takePending(), { thought: "t", skip: true, targets: [9] });
    expect(input.skip).toBeUndefined();
  });

  it("猎人开枪允许 skip → 保留", () => {
    const p = takePending({ kind: "hunterShoot", allowSkip: true });
    const { input } = repairDecision(p, { thought: "不开枪", skip: true });
    expect(input.skip).toBe(true);
  });
});

describe("repairDecision - 通用目标过滤", () => {
  it("剔除不在 options 的目标；全非法则置空", () => {
    const p = pendingOf({ kind: "seerCheck", allowSkip: false });
    const r1 = repairDecision(p, { thought: "验人", targets: [9, 99] });
    expect(r1.input.targets).toEqual([9]);
    const r2 = repairDecision(p, { thought: "验人", targets: [99] });
    expect(r2.input.targets).toBeUndefined();
  });

  it("options 为空（任意存活者）不过滤", () => {
    const p = pendingOf({ kind: "wolfKill", options: [], allowSkip: false });
    const { input } = repairDecision(p, { thought: "刀4", targets: [4] });
    expect(input.targets).toEqual([4]);
  });
});
