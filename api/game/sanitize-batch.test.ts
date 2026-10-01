// 事故回归测试：上警报名/投票批次（暗选暗票制）中 AI 的合法选择被 sanitizeBatchInput
// 全部篡改为 skip —— 根因：该清洗函数原为 daySkill 权衡批次专用，其他批次类型走入
// 同一路径后，报名（不允许跳过）被引擎整批拒绝（"该决策不允许跳过"）、投票变成全员弃票。
// 本文件锁定新行为：合法选择原样保留，仅真正非法的输出才回退启发式兜底。
import { describe, it, expect } from "vitest";
import { sanitizeBatchInput } from "./service";
import type { PendingDecision, PlayerView } from "./engine/api";
import type { RoleId } from "../../contracts/game";

function fakeSub(kind: string, role: RoleId, options: number[], allowSkip: boolean): PendingDecision {
  return {
    seat: 3,
    role,
    kind: kind as PendingDecision["kind"],
    options,
    allowSkip,
    hint: "",
    view: { aliveSeats: [1, 2, 3, 4, 5] } as unknown as PlayerView,
  } as PendingDecision;
}

describe("批次子决策清洗（暗选暗票事故回归）", () => {
  it("daySkill：狼自爆/骑士决斗保留，普通思考降级按兵，非法决斗降级按兵", () => {
    const wolf = fakeSub("daySkill", "werewolf", [1, 2, 4, 5], true);
    expect(sanitizeBatchInput(wolf, { thought: "t", selfDestruct: true })).toEqual({
      thought: "t",
      selfDestruct: true,
    });
    const knight = fakeSub("daySkill", "knight", [1, 2, 4, 5], true);
    expect(sanitizeBatchInput(knight, { thought: "t", duel: 4 })).toEqual({ thought: "t", duel: 4 });
    expect(sanitizeBatchInput(knight, { thought: "t" })).toEqual({ thought: "t", skip: true });
    expect(sanitizeBatchInput(knight, { thought: "t", duel: 99 })).toEqual({ thought: "t", skip: true });
    expect(sanitizeBatchInput(wolf, { thought: "t", duel: 4 })).toEqual({ thought: "t", skip: true });
  });

  it("上警报名（不允许跳过）：合法 targets 原样保留，绝不被篡改为 skip", () => {
    const run = fakeSub("sheriffRun", "villager", [1, 0], false);
    expect(sanitizeBatchInput(run, { thought: "t", targets: [1] })).toEqual({ thought: "t", targets: [1] });
    expect(sanitizeBatchInput(run, { thought: "t", targets: [0] })).toEqual({ thought: "t", targets: [0] });
  });

  it("上警报名：AI 非法输出（skip/越界目标）→ 启发式兜底为合法选择（非 skip）", () => {
    const run = fakeSub("sheriffRun", "villager", [1, 0], false);
    const a = sanitizeBatchInput(run, { thought: "t", skip: true });
    expect(a.skip).not.toBe(true);
    expect(a.targets?.every((t) => run.options.includes(t))).toBe(true);
    const b = sanitizeBatchInput(run, { thought: "t", targets: [7] });
    expect(b.targets?.every((t) => run.options.includes(t))).toBe(true);
  });

  it("发言类子项（合并批次内嵌发言）：有效发言保留、绝不误判非法托管", () => {
    // 事故回归：此前校验只认 targets/skip，把每段有效发言都打成"[AI输出非法，系统托管]"
    const speech = fakeSub("daySpeech", "villager", [], false);
    expect(sanitizeBatchInput(speech, { thought: "t", speech: "我是好人，过。" })).toEqual({
      thought: "t",
      speech: "我是好人，过。",
    });
    // 狼人在自己发言中自爆：保留
    const wolfSpeech = fakeSub("daySpeech", "werewolf", [], false);
    expect(sanitizeBatchInput(wolfSpeech, { thought: "t", speech: "", selfDestruct: true })).toEqual({
      thought: "t",
      selfDestruct: true,
    });
    // 骑士在发言中决斗存活目标：保留；决斗自己/死者：丢弃该字段但保留发言
    const knightSpeech = fakeSub("daySpeech", "knight", [], false);
    expect(sanitizeBatchInput(knightSpeech, { thought: "t", speech: "看招！", duel: 4 })).toEqual({
      thought: "t",
      speech: "看招！",
      duel: 4,
    });
    expect(sanitizeBatchInput(knightSpeech, { thought: "t", speech: "看招！", duel: 3 })).toEqual({
      thought: "t",
      speech: "看招！",
    });
    // 无发言无技能动作 → 启发式兜底
    const empty = sanitizeBatchInput(speech, { thought: "t" });
    expect(empty.speech).toBeTruthy();
  });

  it("纯思考类子项（狼队独立思考并行批次）：thought 即有效动作，绝不误判非法托管", () => {
    // 事故回归：通用校验只认 targets/skip，把全队独立思考都打成"[AI输出非法，系统托管]"
    const think = fakeSub("wolfThink", "werewolf", [], false);
    expect(sanitizeBatchInput(think, { thought: "今晚优先刀神职，重点怀疑3号。" })).toEqual({
      thought: "今晚优先刀神职，重点怀疑3号。",
    });
    // 空思考才兜底
    const empty = sanitizeBatchInput(think, { thought: "" });
    expect(empty.thought).toBeTruthy();
  });

  it("赛后讨论子项（postgameSpeak）：speech 即有效动作，发言优先保留，绝不误判非法托管", () => {
    // 线上零发言事故回归：通用清洗只认 targets/skip，AI 的 {thought, speech} 无 targets 无 skip
    // → 曾被打成"[AI输出非法，系统托管]"全员托管弃权。专属分支：非空 speech 优先。
    const pg = fakeSub("postgameSpeak", "villager", [1, 2, 4, 5], true);
    // speech-only：原样保留（trim 后），不判非法
    expect(sanitizeBatchInput(pg, { thought: "t", speech: " 这把我失误了，抱歉队友们。 " })).toEqual({
      thought: "t",
      speech: "这把我失误了，抱歉队友们。",
    });
    // speech+skip 同出：发言优先保留、skip 丢弃（哪怕 AI 同时给了 skip 也不能吞掉发言）
    expect(sanitizeBatchInput(pg, { thought: "t", speech: "复盘一下", skip: true })).toEqual({
      thought: "t",
      speech: "复盘一下",
    });
    // speech+合法点名 targets：保留发言与点名（至多 1 人）
    expect(sanitizeBatchInput(pg, { thought: "t", speech: "回你", targets: [4, 5] })).toEqual({
      thought: "t",
      speech: "回你",
      targets: [4],
    });
    // speech+越界点名：丢点名、保留发言
    expect(sanitizeBatchInput(pg, { thought: "t", speech: "回你", targets: [99] })).toEqual({
      thought: "t",
      speech: "回你",
    });
    // skip-only：弃权保留（不消耗机会）
    expect(sanitizeBatchInput(pg, { thought: "t", skip: true })).toEqual({ thought: "t", skip: true });
    // 空输入（无 speech 无 skip）→ 启发式兜底（postgameSpeak 兜底=弃权）
    const empty = sanitizeBatchInput(pg, { thought: "" });
    expect(empty.skip).toBe(true);
  });

  it("警徽投票/放逐投票（允许跳过）：合法投票保留、合法弃票保留、越界目标兜底", () => {
    const vote = fakeSub("sheriffVote", "villager", [5, 6], true);
    expect(sanitizeBatchInput(vote, { thought: "t", targets: [5] })).toEqual({ thought: "t", targets: [5] });
    expect(sanitizeBatchInput(vote, { thought: "t", skip: true })).toEqual({ thought: "t", skip: true });
    const exile = fakeSub("dayVote", "villager", [2, 4, 5], true);
    expect(sanitizeBatchInput(exile, { thought: "t", targets: [4] })).toEqual({ thought: "t", targets: [4] });
    const bad = sanitizeBatchInput(exile, { thought: "t", targets: [99] });
    expect(bad.targets?.every((t) => exile.options.includes(t))).toBe(true);
  });
});
