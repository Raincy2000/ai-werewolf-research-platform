import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdvancedOptions, SeatAiConfig } from "../../contracts/game";
import { gameService, guideCache, registry } from "./service";

const HISTORY_ID = "abcdef12-history-game";
const h = vi.hoisted(() => ({
  games: new Map<string, Record<string, unknown>>(),
  events: [] as Record<string, unknown>[],
  decisions: [] as Record<string, unknown>[],
  notes: new Map<string, string>(),
  docs: [] as { name: string; content: string }[],
  historyEnabled: false,
  guideText: "通用指南要点\n版型指南要点",
  libraryCalls: 0,
  historyCalls: 0,
  studyUsers: [] as string[],
}));

vi.mock("../queries/games", () => ({
  countGamesOnDate: async () => 0,
  insertGame: async (row: Record<string, unknown>) => {
    h.games.set(row.id as string, { createdAt: new Date(), ...row });
  },
  updateGame: async (id: string, patch: Record<string, unknown>) => {
    const row = h.games.get(id);
    if (row) Object.assign(row, patch);
  },
  getGame: async (id: string) => h.games.get(id) ?? null,
  listGames: async () => {
    h.historyCalls += 1;
    return h.historyEnabled
      ? [{
          id: HISTORY_ID,
          boardId: "standard9",
          boardName: "9人标准局（暗牌）",
          titleNo: "20261025001",
          status: "finished",
          winner: "good",
          dayCount: 3,
          createdAt: new Date("2026-10-25T00:00:00Z"),
          playerCount: 9,
          userId: null,
          setup: {
            seatRoles: ["seer", "witch", "hunter", "villager", "villager", "villager", "werewolf", "werewolf", "werewolf"],
            options: { stepDelayMs: 5, sheriffEnabled: false, allowSelfDestruct: true, speechRoundsLimit: 1 },
          },
        }]
      : [];
  },
  appendEvents: async (rows: Record<string, unknown>[]) => { h.events.push(...rows); },
  getEventsAfter: async (gameId: string, afterSeq: number) =>
    h.events.filter((e) => e.gameId === gameId && (e.seq as number) > afterSeq),
  getAllEvents: async (gameId: string) => gameId === HISTORY_ID
    ? [{
        gameId: HISTORY_ID,
        seq: 1,
        day: 3,
        phase: "game.over",
        type: "result",
        actor: null,
        actorLabel: null,
        title: "游戏结果",
        content: "好人阵营胜利！",
        thought: null,
        meta: null,
        createdAt: new Date("2026-10-25T00:00:00Z"),
      }]
    : h.events.filter((e) => e.gameId === gameId),
  getLatestEvents: async (gameId: string, limit: number) =>
    h.events.filter((e) => e.gameId === gameId).slice(-(limit as number)),
  getMaxEventSeq: async (gameId: string) =>
    h.events.filter((e) => e.gameId === gameId).reduce((m, e) => Math.max(m, e.seq as number), 0),
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
  getLatestGuide: async () => ({ content: h.guideText }),
  insertGuideVersion: async () => {},
  listGuideScopes: async () => [],
  listGuideVersions: async () => [],
  upsertAnalysis: async () => {},
}));

vi.mock("../queries/library", () => ({
  getAllLibraryContents: async () => {
    h.libraryCalls += 1;
    return h.docs;
  },
  upsertStudyNote: async (gameId: string, seat: number, notes: string) => {
    h.notes.set(`${gameId}:${seat}`, notes);
  },
  getStudyNotes: async () => [],
}));

vi.mock("../queries/winrates", () => ({
  insertWinRate: async () => {},
  getWinRatesAfter: async () => [],
  getLatestWinRate: async () => null,
}));

vi.mock("./logDigest", () => ({ buildLogDigest: () => "历史摘要" }));

function autoAnswer(user: string): string {
  if (user.includes("升序发言")) return '{"thought":"t","targets":[1]}';
  const taskLine = user.slice(user.indexOf("【你的任务】"));
  if (/发表白天发言|发表遗言|队内讨论/.test(taskLine)) return '{"thought":"t","speech":"测试发言"}';
  if (user.includes("必须行动")) return '{"thought":"t","targets":[1]}';
  return '{"thought":"t","skip":true}';
}

vi.mock("./ai/providers", () => ({
  callAi: async (_cfg: unknown, system: string, user: string) => {
    if (user.includes("【历史对局档案】")) {
      h.studyUsers.push(user);
      return { ok: true, text: `{"games":["abcdef12"]}`, latencyMs: 1, error: null };
    }
    if (system.includes("复盘一局历史对局")) {
      h.studyUsers.push(user);
      return { ok: true, text: "历史借鉴", latencyMs: 1, error: null };
    }
    if (system.includes("图书馆")) {
      h.studyUsers.push(user);
      return { ok: true, text: user.includes("指南要点") ? "指南心得" : "图书心得", latencyMs: 1, error: null };
    }
    return { ok: true, text: autoAnswer(user), latencyMs: 1, error: null };
  },
}));

const OPTS: AdvancedOptions = {
  stepDelayMs: 5,
  phaseBreakMs: 0,
  sheriffEnabled: false,
  allowSelfDestruct: true,
  speechRoundsLimit: 1,
};

function seats(): SeatAiConfig[] {
  return Array.from({ length: 9 }, (_, i) => ({
    seat: i + 1,
    provider: "custom" as const,
    baseUrl: "http://mock.local/v1",
    model: "mock-model",
    apiKey: "sk-mock",
  }));
}

async function waitFor(cond: () => boolean, label: string, timeoutMs = 4000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`等待超时：${label}`);
}

async function startStudy(options: Partial<AdvancedOptions>): Promise<string> {
  const { gameId } = await gameService.createGame({
    boardId: "standard9",
    seats: seats(),
    options: { ...OPTS, ...options },
    winRateEnabled: false,
  }, "test-user");
  await gameService.control(gameId, "start", "test-user");
  await waitFor(() => registry.get(gameId)?.studyDone === true, "赛前学习完成");
  return gameId;
}

beforeEach(() => {
  h.games.clear();
  h.events.length = 0;
  h.decisions.length = 0;
  h.notes.clear();
  h.docs = [];
  h.historyEnabled = false;
  h.guideText = "通用指南要点\n版型指南要点";
  h.libraryCalls = 0;
  h.historyCalls = 0;
  h.studyUsers = [];
  registry.clear();
  guideCache.clear();
});

describe("可组合赛前学习来源", () => {
  it("仅经验指南：无图书馆文档也生成指南心得", async () => {
    const gameId = await startStudy({
      libraryEnabled: true,
      studyGuideEnabled: true,
      studyLibraryEnabled: false,
      studyHistoryEnabled: false,
    });
    const note = registry.get(gameId)!.studyNotes!.get(1)!;
    expect(note).toContain("指南心得");
    expect(h.libraryCalls).toBe(0);
    expect(h.studyUsers.some((u) => u.includes("指南要点"))).toBe(true);
    await gameService.control(gameId, "terminate", "test-user");
  });

  it("仅历史对局：无需图书馆心得也保存历史参考", async () => {
    h.historyEnabled = true;
    const gameId = await startStudy({
      libraryEnabled: true,
      studyHistoryEnabled: true,
      studyLibraryEnabled: false,
      studyGuideEnabled: false,
    });
    const note = registry.get(gameId)!.studyNotes!.get(1)!;
    expect(note).toContain("历史对局参考");
    expect(note).toContain("历史借鉴");
    expect(h.libraryCalls).toBe(0);
    expect(h.notes.get(`${gameId}:1`)).toBe(note);
    await gameService.control(gameId, "terminate", "test-user");
  });

  it("历史与指南同时进入最终笔记", async () => {
    h.historyEnabled = true;
    const gameId = await startStudy({
      libraryEnabled: true,
      studyHistoryEnabled: true,
      studyGuideEnabled: true,
      studyLibraryEnabled: false,
    });
    const note = registry.get(gameId)!.studyNotes!.get(1)!;
    expect(note).toContain("指南心得");
    expect(note).toContain("历史对局参考");
    expect(note).toContain("历史借鉴");
    await gameService.control(gameId, "terminate", "test-user");
  });

  it("旧配置仅图书馆：保持原路径且不读取历史", async () => {
    h.docs = [{ name: "狼人杀通则.md", content: "金水包括平民。" }];
    const gameId = await startStudy({ libraryEnabled: true });
    const note = registry.get(gameId)!.studyNotes!.get(1)!;
    expect(note).toContain("图书心得");
    expect(h.historyCalls).toBe(0);
    expect(h.studyUsers.some((u) => u.includes("指南要点"))).toBe(false);
    await gameService.control(gameId, "terminate", "test-user");
  });

  it("三项全选：研读心得与历史参考可合并", async () => {
    h.docs = [{ name: "狼人杀通则.md", content: "金水包括平民。" }];
    h.historyEnabled = true;
    const gameId = await startStudy({
      libraryEnabled: true,
      studyLibraryEnabled: true,
      studyHistoryEnabled: true,
      studyGuideEnabled: true,
    });
    const note = registry.get(gameId)!.studyNotes!.get(1)!;
    expect(note).toContain("指南心得");
    expect(note).toContain("历史对局参考");
    expect(h.libraryCalls).toBeGreaterThan(0);
    expect(h.historyCalls).toBeGreaterThan(0);
    await gameService.control(gameId, "terminate", "test-user");
  });

  it("所有选中来源均为空：直接完成且不发起学习调用", async () => {
    h.guideText = "";
    const gameId = await startStudy({
      libraryEnabled: true,
      studyLibraryEnabled: true,
      studyHistoryEnabled: true,
      studyGuideEnabled: true,
    });
    expect(registry.get(gameId)!.studyNotes!.size).toBe(0);
    expect(h.studyUsers).toHaveLength(0);
    await gameService.control(gameId, "terminate", "test-user");
  });
});
