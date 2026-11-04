import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdvancedOptions, RoleId, SeatAiConfig } from "../../contracts/game";
import { BOARDS } from "../../contracts/game";
import { gameService, guideCache, registry } from "./service";

const h = vi.hoisted(() => ({
  games: new Map<string, Record<string, unknown>>(),
  events: [] as Record<string, unknown>[],
  decisions: [] as Record<string, unknown>[],
}));

vi.mock("../queries/games", () => ({
  countGamesOnDate: async () => 0,
  insertGame: async (row: Record<string, unknown>) => { h.games.set(row.id as string, { createdAt: new Date(), ...row }); },
  updateGame: async (id: string, patch: Record<string, unknown>) => {
    const row = h.games.get(id);
    if (row) Object.assign(row, patch);
  },
  getGame: async (id: string) => h.games.get(id) ?? null,
  listGames: async () => [...h.games.values()],
  appendEvents: async (rows: Record<string, unknown>[]) => { h.events.push(...rows); },
  getEventsAfter: async (gameId: string, afterSeq: number) =>
    h.events.filter((e) => e.gameId === gameId && (e.seq as number) > afterSeq),
  getAllEvents: async (gameId: string) => h.events.filter((e) => e.gameId === gameId),
  getLatestEvents: async () => [],
  getMaxEventSeq: async () => 0,
  getLatestPhaseEvent: async () => null,
  hasPostGameEvents: async () => false,
  getDeadSeats: async () => new Set<number>(),
  deathSeatsFromEvents: () => new Set<number>(),
}));

vi.mock("../queries/decisions", () => ({
  appendDecision: async (row: Record<string, unknown>) => { h.decisions.push({ ...row }); },
  getDecisions: async (gameId: string) =>
    h.decisions.filter((d) => d.gameId === gameId).sort((a, b) => (a.idx as number) - (b.idx as number)),
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

vi.mock("../queries/library", () => ({
  getAllLibraryContents: async () => [],
  upsertStudyNote: async () => {},
  getStudyNotes: async () => [],
}));

vi.mock("../queries/winrates", () => ({
  insertWinRate: async () => {},
  getWinRatesAfter: async () => [],
  getLatestWinRate: async () => null,
}));

vi.mock("./ai/providers", () => ({
  callAi: async (_cfg: unknown, _system: string, user: string) => {
    if (user.includes("必须行动")) return { ok: true, text: '{"thought":"t","targets":[1]}', latencyMs: 1, error: null };
    if (user.includes("speech 必填")) return { ok: true, text: '{"thought":"t","speech":"测试发言"}', latencyMs: 1, error: null };
    return { ok: true, text: '{"thought":"t","skip":true}', latencyMs: 1, error: null };
  },
}));

const OPTS: AdvancedOptions = {
  stepDelayMs: 200,
  phaseBreakMs: 0,
  sheriffEnabled: false,
  allowSelfDestruct: true,
  speechRoundsLimit: 1,
};

function seats(count: number): SeatAiConfig[] {
  return Array.from({ length: count }, (_, i) => ({
    seat: i + 1,
    provider: "custom" as const,
    baseUrl: "http://mock.local/v1",
    model: "mock-model",
    apiKey: "sk-mock",
  }));
}

beforeEach(() => {
  h.games.clear();
  h.events.length = 0;
  h.decisions.length = 0;
  registry.clear();
  guideCache.clear();
});

describe("手动角色分配启动", () => {
  it("开始时引擎与 setup 使用同一份 seatRoles", async () => {
    const board = BOARDS.find((b) => b.id === "standard9")!;
    const assigned = [...board.roles].reverse() as RoleId[];
    const { gameId } = await gameService.createGame({
      boardId: board.id,
      seats: seats(board.playerCount),
      options: { ...OPTS, manualRoleAssignEnabled: true },
      winRateEnabled: false,
    }, "test-user");
    await gameService.control(gameId, "start", "test-user", assigned);
    const rt = registry.get(gameId)!;
    expect(rt.engine.getSnapshot().players.map((p) => p.role)).toEqual(assigned);
    expect((h.games.get(gameId)!.setup as { seatRoles: RoleId[] }).seatRoles).toEqual(assigned);
    await gameService.control(gameId, "terminate", "test-user");
  });

  it("角色数量不合法时拒绝启动且不写 setup", async () => {
    const board = BOARDS.find((b) => b.id === "standard9")!;
    const { gameId } = await gameService.createGame({
      boardId: board.id,
      seats: seats(board.playerCount),
      options: { ...OPTS, manualRoleAssignEnabled: true },
      winRateEnabled: false,
    }, "test-user");
    const before = (h.games.get(gameId)!.setup as { seatRoles: RoleId[] }).seatRoles;
    await expect(gameService.control(gameId, "start", "test-user", board.roles.slice(1)))
      .rejects.toThrow("座位数");
    expect(registry.get(gameId)!.status).toBe("created");
    expect((h.games.get(gameId)!.setup as { seatRoles: RoleId[] }).seatRoles).toEqual(before);
  });

  it("已提交角色后暂停续跑可复用原分配，不要求重复提交", async () => {
    const board = BOARDS.find((b) => b.id === "standard9")!;
    const assigned = [...board.roles].reverse() as RoleId[];
    const { gameId } = await gameService.createGame({
      boardId: board.id,
      seats: seats(board.playerCount),
      options: { ...OPTS, manualRoleAssignEnabled: true },
      winRateEnabled: false,
    }, "test-user");
    await gameService.control(gameId, "start", "test-user", assigned);
    await gameService.control(gameId, "pause", "test-user");
    await expect(gameService.control(gameId, "start", "test-user")).resolves.toEqual({ ok: true });
    expect(registry.get(gameId)!.engine.getSnapshot().players.map((p) => p.role)).toEqual(assigned);
    await gameService.control(gameId, "terminate", "test-user");
  });

  it("未开启手动分配时仍按原随机路径启动", async () => {
    const board = BOARDS.find((b) => b.id === "standard9")!;
    const { gameId } = await gameService.createGame({
      boardId: board.id,
      seats: seats(board.playerCount),
      options: OPTS,
      winRateEnabled: false,
    }, "test-user");
    const before = registry.get(gameId)!.engine.getSnapshot().players.map((p) => p.role);
    await gameService.control(gameId, "start", "test-user");
    expect(registry.get(gameId)!.engine.getSnapshot().players.map((p) => p.role)).toEqual(before);
    await gameService.control(gameId, "terminate", "test-user");
  });
});
