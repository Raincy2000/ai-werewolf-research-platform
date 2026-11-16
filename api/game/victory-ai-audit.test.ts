import { describe, expect, it } from "vitest";
import type { GameRuntime } from "./service";
import { runVictoryAiAudit } from "./victory-ai-audit";

function rtWith(players: unknown[]): GameRuntime {
  return {
    boardId: "whiteWolfKnight12",
    userId: "u",
    options: { sheriffEnabled: true, allowSelfDestruct: true, allowSurrender: true },
    seatAIs: [{ seat: 1, provider: "deepseek", baseUrl: "http://test", model: "deepseek-v4-flash", apiKey: "x" }],
    analystAi: null,
    engine: { getSnapshot: () => ({ day: 6, phase: "day.speech", phaseLabel: "第6天 · 白天发言", finished: false, winner: null, players }) },
  } as unknown as GameRuntime;
}

const players = [
  { seat: 4, role: "villager", roleName: "平民", camp: "villager", alive: true, stock: [], checks: [] },
  { seat: 6, role: "witch", roleName: "女巫", camp: "god", alive: true, stock: ["解药已用", "毒药已用"], checks: [] },
  { seat: 7, role: "werewolf", roleName: "狼人", camp: "wolf", alive: true, stock: [], checks: [] },
  { seat: 8, role: "werewolf", roleName: "狼人", camp: "wolf", alive: true, stock: [], checks: [] },
];

describe("分析师AI拍刀轮次裁决", () => {
  it("把版型规则、完整进程和技能存量交给分析师，采纳其必胜推演", async () => {
    const rt = rtWith(players);
    const calls: { system: string; user: string }[] = [];
    const result = await runVictoryAiAudit({
      gameId: "g",
      rt,
      events: [{ seq: 380, day: 6, phase: "day.speech", type: "system", actor: null, actorLabel: null, title: "拍刀", content: "8号宣布胜利", thought: null, meta: null, createdAt: new Date().toISOString() }],
      callAiFn: async (_cfg, system, user) => {
        calls.push({ system, user });
        return { ok: true, latencyMs: 1, error: null, text: '{"verdict":"wolf_win","reason":"神民各剩一格，白天任何结果后入夜刀另一边均屠边"}' };
      },
    });
    expect(result.outcome).toBe("pass");
    expect(result.reason).toContain("屠边");
    expect(calls[0].user).toContain("解药已用");
    expect(calls[0].user).toContain("8号宣布胜利");
    expect(calls[0].user).toContain("官方规则");
    expect(calls[0].system).toContain("所有合法后续");
  });

  it("分析师给出合法反制路径时驳回，不再由非狼人数直接决定", async () => {
    const result = await runVictoryAiAudit({
      gameId: "g",
      rt: rtWith(players),
      events: [],
      callAiFn: async () => ({ ok: true, latencyMs: 1, error: null, text: '{"verdict":"not_guaranteed","reason":"骑士仍可决斗改变狼队人数"}' }),
    });
    expect(result.outcome).toBe("reject");
    expect(result.reason).toContain("骑士");
  });

  it("调用失败或输出损坏返回unavailable，不把技术故障判成狼队失败", async () => {
    const failed = await runVictoryAiAudit({ gameId: "g", rt: rtWith(players), events: [], callAiFn: async () => ({ ok: false, text: null, latencyMs: 1, error: "timeout" }) });
    expect(failed.outcome).toBe("unavailable");
    const malformed = await runVictoryAiAudit({ gameId: "g", rt: rtWith(players), events: [], callAiFn: async () => ({ ok: true, latencyMs: 1, error: null, text: "无法解析" }) });
    expect(malformed.outcome).toBe("unavailable");
  });
});
