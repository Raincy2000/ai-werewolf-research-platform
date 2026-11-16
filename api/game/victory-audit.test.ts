import { describe, expect, it } from "vitest";
import { deterministicVictoryAudit, type VictoryAuditPlayer } from "./victory-audit";

const wolf = (seat: number): VictoryAuditPlayer => ({ role: "werewolf", camp: "wolf", alive: true, stock: [] });
const villager = (seat: number): VictoryAuditPlayer => ({ role: "villager", camp: "villager", alive: true, stock: [] });
const emptyWitch = (seat: number): VictoryAuditPlayer => ({ role: "witch", camp: "god", alive: true, stock: ["解药已用", "毒药已用"] });

describe("白日拍刀：按屠边发展而非只数非狼人数", () => {
  it("20261111001：两狼一神一民，女巫双药耗尽，刀任一边均达屠边，应放行", () => {
    expect(deterministicVictoryAudit([wolf(7), wolf(8), villager(4), emptyWitch(6)])).toBe("pass");
  });

  it("两狼以上且神民各剩一人时，骑士决斗仍可用则保守驳回", () => {
    const knight: VictoryAuditPlayer = { role: "knight", camp: "god", alive: true, stock: ["决斗可用"] };
    expect(deterministicVictoryAudit([wolf(7), wolf(8), villager(4), knight])).toBe("reject");
  });

  it("神民各剩一人但女巫仍有解药时，不用双屠边捷径误判放行", () => {
    const witch: VictoryAuditPlayer = { ...emptyWitch(6), stock: ["解药可用", "毒药已用"] };
    expect(deterministicVictoryAudit([wolf(7), wolf(8), villager(4), witch])).toBe("reject");
  });

  it("非狼超过两人时仍按原保守规则驳回，不扩大适用", () => {
    expect(deterministicVictoryAudit([wolf(7), wolf(8), villager(4), villager(9), emptyWitch(6)])).toBe("reject");
  });

  it("单一非狼的既有反制审核保持不变", () => {
    const guard: VictoryAuditPlayer = { role: "guard", camp: "god", alive: true, stock: [] };
    expect(deterministicVictoryAudit([wolf(7), wolf(8), guard])).toBe("reject");
    expect(deterministicVictoryAudit([wolf(7), wolf(8), emptyWitch(6)])).toBe("pass");
  });
});
