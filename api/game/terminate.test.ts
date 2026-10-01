// ============================================================
// 「终止对局」专项测试：随时结束对局（不可逆），用于随时收掉测试局开新局
// 1) 运行中终止：tick 链立即停稳、status=finished、终止事件落库、不可再启动、决策数不再增长
// 2) 暂停挂起状态终止：在飞等待者被唤醒、不可逆
// 3) 幂等：重复终止返回 ok 且不重复落终止事件
// 4) created 未启动即可终止
// mock 风格与 recovery.test.ts 一致（真引擎 + 全 mock 查询层/AI）
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AdvancedOptions, SeatAiConfig } from "../../contracts/game";
import { registry } from "./service";

const h = vi.hoisted(() => ({
  games: new Map<string, Record<string, unknown>>(),
  events: [] as Record<string, unknown>[],
  decisions: [] as Record<string, unknown>[],
}));

vi.mock("../queries/games", () => ({
  countGamesOnDate: async () => 0,
  insertGame: async (row: Record<string, unknown>) => {
    h.games.set(row.id as string, { createdAt: new Date(), ...row });
  },
  updateGame: async (id: string, patch: Record<string, unknown>) => {
    const g = h.games.get(id);
    if (g) Object.assign(g, patch);
  },
  getGame: async (id: string) => h.games.get(id) ?? null,
  listGames: async () => [...h.games.values()],
  appendEvents: async (rows: Record<string, unknown>[]) => {
    h.events.push(...rows);
  },
  getEventsAfter: async (gameId: string, afterSeq: number) =>
    h.events.filter((e) => e.gameId === gameId && (e.seq as number) > afterSeq),
  getAllEvents: async (gameId: string) => h.events.filter((e) => e.gameId === gameId),
  getLatestEvents: async (gameId: string, limit: number) =>
    h.events.filter((e) => e.gameId === gameId).slice(-(limit as number)),
  getMaxEventSeq: async (gameId: string) =>
    h.events.filter((e) => e.gameId === gameId).reduce((m, e) => Math.max(m, e.seq as number), 0),
}));

vi.mock("../queries/decisions", () => ({
  appendDecision: async (row: Record<string, unknown>) => {
    h.decisions.push({ ...row });
  },
  getDecisions: async (gameId: string) =>
    h.decisions
      .filter((d) => d.gameId === gameId)
      .sort((a, b) => (a.idx as number) - (b.idx as number)),
}));

vi.mock("../queries/guide", () => ({
  countGuides: async () => 0,
  getAnalysis: async () => null,
  getGuideVersion: async () => null,
  getLatestGuide: async () => null,
  insertGuideVersion: async () => {},
  listGuideScopes: async () => [],
  listGuideVersions: async () => [],
  upsertAnalysis: async () => {},
}));

vi.mock("./ai/providers", () => ({
  callAi: async () => ({ ok: false, text: null, latencyMs: 1, error: "测试：AI 不可用 → 启发式兜底" }),
}));

const OPTS: AdvancedOptions = {
  stepDelayMs: 0,
  phaseBreakMs: 0,
  sheriffEnabled: true,
  allowSelfDestruct: true,
  speechRoundsLimit: 1,
};

function makeSeats(n: number): SeatAiConfig[] {
  return Array.from({ length: n }, (_, i) => ({
    seat: i + 1,
    provider: "kimi" as const,
    baseUrl: "http://test.local/v1",
    model: "test-model",
    apiKey: "test-key",
  }));
}

async function waitFor(cond: () => boolean, label: string, timeoutMs = 15_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时：${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const decisionsOf = (gameId: string) => h.decisions.filter((d) => d.gameId === gameId);
const eventsOf = (gameId: string) => h.events.filter((e) => e.gameId === gameId);
const terminateEventsOf = (gameId: string) => eventsOf(gameId).filter((e) => e.title === "对局终止");

beforeEach(() => {
  h.games.clear();
  h.events.length = 0;
  h.decisions.length = 0;
  registry.clear();
});

describe("终止对局", () => {
  it("运行中终止：立即停链、标记事件落库、不可逆、决策不再增长", async () => {
    const { gameService } = await import("./service");
    const { gameId } = await gameService.createGame({
      boardId: "standard12",
      seats: makeSeats(12),
      options: OPTS,
    });
    await gameService.control(gameId, "start");
    await waitFor(() => decisionsOf(gameId).length >= 4, "至少 4 个决策落盘");

    const res = await gameService.control(gameId, "terminate");
    expect(res.ok).toBe(true);

    const rt = registry.get(gameId)!;
    await waitFor(() => !rt.ticking, "tick 链停稳");

    // 内存与 DB 均收敛为 finished
    expect(rt.status).toBe("finished");
    expect(rt.timer).toBeNull();
    expect(rt.pending).toBeNull();
    const row = h.games.get(gameId)!;
    expect(row.status).toBe("finished");
    expect(row.winner ?? null).toBeNull(); // 未分胜负
    expect(row.dayCount).toBeGreaterThanOrEqual(1);

    // 终止标记事件落库（一条）
    expect(terminateEventsOf(gameId).length).toBe(1);
    expect(terminateEventsOf(gameId)[0].content).toContain("手动终止");

    // 不可逆：start/pause 均不再生效
    expect((await gameService.control(gameId, "start")).ok).toBe(false);
    const n = decisionsOf(gameId).length;
    await new Promise((r) => setTimeout(r, 200));
    expect(decisionsOf(gameId).length).toBe(n); // 决策数不再增长

    // 终止后 poll 正常：快照 finished，事件流含终止标记
    const pollRes = await gameService.poll(gameId, 0);
    expect(pollRes.snapshot!.status).toBe("finished");
    expect(pollRes.events.some((e) => (e as { title?: string }).title === "对局终止")).toBe(true);
  }, 30_000);

  it("暂停挂起状态终止：在飞等待者被唤醒、tick 链停稳、不可逆", async () => {
    const { gameService } = await import("./service");
    const { gameId } = await gameService.createGame({
      boardId: "standard12",
      seats: makeSeats(12),
      options: OPTS,
    });
    await gameService.control(gameId, "start");
    await waitFor(() => decisionsOf(gameId).length >= 3, "至少 3 个决策落盘");
    await gameService.control(gameId, "pause");
    const rt = registry.get(gameId)!;
    await waitFor(() => !rt.ticking, "tick 链停稳");

    const res = await gameService.control(gameId, "terminate");
    expect(res.ok).toBe(true);
    expect(rt.status).toBe("finished");
    expect(rt.pending).toBeNull(); // 挂起的待决被清掉，不再重想
    expect(rt.suspendDraft).toBeNull();
    expect(h.games.get(gameId)!.status).toBe("finished");
    expect((await gameService.control(gameId, "start")).ok).toBe(false);
    expect(terminateEventsOf(gameId).length).toBe(1);
  }, 30_000);

  it("幂等：重复终止返回 ok，不重复落终止事件", async () => {
    const { gameService } = await import("./service");
    const { gameId } = await gameService.createGame({
      boardId: "standard12",
      seats: makeSeats(12),
      options: OPTS,
    });
    await gameService.control(gameId, "start");
    await waitFor(() => decisionsOf(gameId).length >= 2, "至少 2 个决策落盘");

    expect((await gameService.control(gameId, "terminate")).ok).toBe(true);
    expect((await gameService.control(gameId, "terminate")).ok).toBe(true);
    expect((await gameService.control(gameId, "terminate")).ok).toBe(true);
    expect(terminateEventsOf(gameId).length).toBe(1); // 只落一次
    expect(h.games.get(gameId)!.status).toBe("finished");
  }, 30_000);

  it("created 未启动即可终止", async () => {
    const { gameService } = await import("./service");
    const { gameId } = await gameService.createGame({
      boardId: "standard12",
      seats: makeSeats(12),
      options: OPTS,
    });
    const res = await gameService.control(gameId, "terminate");
    expect(res.ok).toBe(true);
    expect(registry.get(gameId)!.status).toBe("finished");
    expect(h.games.get(gameId)!.status).toBe("finished");
    expect((await gameService.control(gameId, "start")).ok).toBe(false);
  }, 30_000);
});
