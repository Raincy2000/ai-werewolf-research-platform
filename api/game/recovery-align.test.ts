// ============================================================
// 恢复重放的批量决策规则演进容差专项（2026-10-15 实锤驱动）
// 背景：骑士决斗 0.3.53 起仅限放逐发言阶段 → 旧日志的权衡批含骑士席位（存 5 新引擎问 4）；
//       退水环节旧版逐个询问、新版批量 → 日志为连续单座条目。
// 容差只在「多余项全部按兵不动（不改变世界线）」时生效；带动作漂移=真分叉，绝不对齐。
// ============================================================

import { describe, it, expect } from "vitest";
import { alignBatchDecision, expandSequentialBatch } from "./recovery";
import type { DecisionInput, PendingDecision } from "./engine/api";

type Role = "werewolf" | "knight" | "seer" | "villager";
const member = (seat: number, kind = "daySkill", role: Role = "werewolf"): PendingDecision => ({
  seat,
  role,
  kind: kind as PendingDecision["kind"],
  options: [],
  allowSkip: true,
  view: {} as PendingDecision["view"],
  hint: "",
});
const skipInp = (thought = ""): DecisionInput => ({ thought, skip: true });

describe("alignBatchDecision：批量收缩对齐", () => {
  it("精确路径：多余骑士席位（按兵）从批次中段剔除，其余输入位次不动", () => {
    const batch = [member(3), member(4), member(8), member(9)];
    const inputs = [skipInp("w3"), skipInp("w4"), skipInp("骑士按兵"), skipInp("w8"), skipInp("w9")];
    const aligned = alignBatchDecision(
      { ...member(3), batch } as PendingDecision,
      { thought: "", batchInputs: inputs },
      [6],
    );
    expect(aligned).not.toBeNull();
    expect(aligned!.batchInputs!.map((i) => i.thought)).toEqual(["w3", "w4", "w8", "w9"]);
  });

  it("发言尾缀模型：发言成员追加在尾部——剔除骑士后发言输入仍对齐末位发言席位", () => {
    // 新批次：4 狼权衡 + 2号警上发言（sheriffSpeech 属发言类，居尾部）
    const batch = [member(2), member(3), member(4), member(5), member(2, "sheriffSpeech", "seer")];
    const inputs = [
      skipInp("w2"),
      skipInp("w3"),
      skipInp("w4"),
      skipInp("w5"),
      skipInp("骑士按兵"),
      { thought: "发言", speech: "我是预言家" },
    ];
    const aligned = alignBatchDecision(
      { ...batch[0]!, batch } as PendingDecision,
      { thought: "", batchInputs: inputs },
      [6],
    );
    expect(aligned).not.toBeNull();
    const kept = aligned!.batchInputs!;
    expect(kept.length).toBe(5);
    expect(kept[4]!.speech).toBe("我是预言家"); // 发言输入保在末位
    expect(kept.slice(0, 4).map((i) => i.thought)).toEqual(["w2", "w3", "w4", "w5"]);
  });

  it("带动作的多余项（骑士真的决斗了）→ 真分叉，绝不对齐", () => {
    const batch = [member(3), member(12)];
    const inputs = [skipInp("w3"), { thought: "戳7", duel: 7 }, skipInp("w12")];
    const aligned = alignBatchDecision(
      { ...member(3), batch } as PendingDecision,
      { thought: "", batchInputs: inputs },
      [5],
    );
    expect(aligned).toBeNull();
  });

  it("存储少于期望（数量倒挂）→ null（无法凭空捏造决策）", () => {
    const batch = [member(3), member(4), member(8), member(9)];
    const aligned = alignBatchDecision(
      { ...member(3), batch } as PendingDecision,
      { thought: "", batchInputs: [skipInp(), skipInp(), skipInp()] },
      [6],
    );
    expect(aligned).toBeNull();
  });

  it("单席退化：旧批次 2 员、新规则仅剩 1 员单独询问——按席位取回裸输入", () => {
    // 新待决：seat7 单独 daySkill（无 batch 字段）；旧日志批次 [5骑士,7狼] 两条按兵
    const pending = member(7);
    const aligned = alignBatchDecision(
      pending,
      { thought: "", batchInputs: [skipInp("骑士按兵"), skipInp("w7按兵")] },
      [5],
    );
    expect(aligned).not.toBeNull();
    expect(aligned!.batchInputs).toBeUndefined(); // 裸输入（非包裹）
    expect(aligned!.thought).toBe("w7按兵");
  });

  it("无席位提示回退试探：剔除按兵位使带动作输入与狼队成员相容", () => {
    const batch = [member(3), member(9)];
    const inputs = [skipInp(), skipInp(), { thought: "自爆", selfDestruct: true }];
    const aligned = alignBatchDecision(
      { ...member(3), batch } as PendingDecision,
      { thought: "", batchInputs: inputs },
      [], // 无提示
    );
    expect(aligned).not.toBeNull();
    expect(aligned!.batchInputs!.length).toBe(2);
    expect(aligned!.batchInputs![1]!.selfDestruct).toBe(true); // 动作输入对齐狼队成员
  });

  it("回退试探：带动作输入无法合法落位（决斗 vs 纯狼批）→ null", () => {
    const batch = [member(3), member(9)];
    const inputs = [{ thought: "戳", duel: 5 }, skipInp(), skipInp()];
    const aligned = alignBatchDecision(
      { ...member(3), batch } as PendingDecision,
      { thought: "", batchInputs: inputs },
      [],
    );
    expect(aligned).toBeNull(); // 决斗只能落骑士席位，狼批无合法位 → 真分叉
  });
});

describe("expandSequentialBatch：顺序条目合并为批量", () => {
  const withdrawRec = (seat: number, stay: boolean) => ({
    kind: "sheriffWithdraw",
    seat,
    decision: { thought: `t${seat}`, targets: [stay ? 0 : 1] } satisfies DecisionInput,
  });

  it("连续单座条目按序喂满批量成员 → 合并为一份批量载荷", () => {
    const batch = [member(1, "sheriffWithdraw", "seer"), member(3, "sheriffWithdraw"), member(5, "sheriffWithdraw")];
    const pending = { ...batch[0]!, batch } as PendingDecision;
    const decisions = [withdrawRec(1, true), withdrawRec(3, false), withdrawRec(5, false), withdrawRec(7, false)];
    const merged = expandSequentialBatch(pending, decisions as never, 0);
    expect(merged).not.toBeNull();
    expect(merged!.consumed).toBe(3); // 只消费 3 条，第 4 条留给后续
    expect(merged!.decision.batchInputs!.map((i) => i.thought)).toEqual(["t1", "t3", "t5"]);
  });

  it("席位/类型不吻合 → null（不强行合并）", () => {
    const batch = [member(1, "sheriffWithdraw", "seer"), member(3, "sheriffWithdraw")];
    const pending = { ...batch[0]!, batch } as PendingDecision;
    const decisions = [withdrawRec(1, true), { kind: "sheriffVote", seat: 3, decision: { thought: "" } }];
    expect(expandSequentialBatch(pending, decisions as never, 0)).toBeNull();
  });

  it("条目本身是批量载荷 → null（非顺序形态）", () => {
    const batch = [member(1, "sheriffWithdraw", "seer"), member(3, "sheriffWithdraw")];
    const pending = { ...batch[0]!, batch } as PendingDecision;
    const decisions = [
      withdrawRec(1, true),
      { kind: "sheriffWithdraw", seat: 3, decision: { thought: "", batchInputs: [] } },
    ];
    expect(expandSequentialBatch(pending, decisions as never, 0)).toBeNull();
  });
});
