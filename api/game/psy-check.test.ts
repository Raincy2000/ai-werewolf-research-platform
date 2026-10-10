// 心理检查「手动开启 + 可续跑」专项测试（对局 20261009001 事故回归 + 新语义锁定）：
// 旧语义：终局自动触发（triggerPersonaEpilogue），依赖 rt.analystAi——未配置分析师或
// 服务重启（恢复后 analystAi 失存）即静默跳过，中断后无法补齐（该局心理检查从未发生）。
// 新语义：终局不自动跑；分出胜负后 startPsyCheck 手动开启，中断/重启后再点只补未完成座位。
// 断言：
// 1) 配置了分析师（autoGenerate）的对局终局后仍无报告（自动触发已摘除）
// 2) startPsyCheck → 记事簿回写 + 报告 + 事件齐出；poll 透出逐座位 done
// 3) 中断续跑：删掉一份报告 + 清内存（强制重放重建）→ 再开只补缺失座位（写回不重跑）
// 4) 未分出胜负拒绝开启
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AdvancedOptions, SeatAiConfig } from "../../contracts/game";
import type { PersonaCard } from "../../contracts/persona";
import { defaultPersonaParams, emptyPersonaProfile } from "../../contracts/persona";
import { registry, guideCache } from "./service";

// ---------- 共享 mock 状态 ----------
const h = vi.hoisted(() => ({
  games: new Map<string, Record<string, unknown>>(),
  events: [] as Record<string, unknown>[],
  decisions: [] as Record<string, unknown>[],
  reports: [] as Record<string, unknown>[], // persona_reports 内存表
  cards: new Map<number, PersonaCard>(),
  notebookCalls: 0,
  anatomistCalls: 0,
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
  getLatestPhaseEvent: async (gameId: string) =>
    [...h.events]
      .filter((e) => e.gameId === gameId && e.type === "phase")
      .sort((a, b) => (b.seq as number) - (a.seq as number))[0] ?? null,
  hasPostGameEvents: async (gameId: string) =>
    h.events.some((e) => e.gameId === gameId && (e.phase as string).startsWith("postgame")),
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

vi.mock("../queries/winrates", () => ({
  insertWinRate: async () => {},
  getWinRatesAfter: async () => [],
  getLatestWinRate: async () => null,
}));

vi.mock("../queries/library", () => ({
  getAllLibraryContents: async () => [],
  upsertStudyNote: async () => {},
  getStudyNotes: async () => [],
}));

// 人格研究库查询层：内存卡库 + 内存报告表
vi.mock("../queries/personas", () => ({
  getPersona: async (id: number) => h.cards.get(id) ?? null,
  getPersonaCardsInternal: async (ids: number[]) =>
    ids.map((id) => h.cards.get(id)).filter((c) => c != null),
  getPersonaReportsForGame: async (gameId: string) =>
    h.reports.filter((r) => r.gameId === gameId),
  upsertPersonaReport: async (row: Record<string, unknown>) => {
    const i = h.reports.findIndex(
      (r) => r.gameId === row.gameId && r.personaId === row.personaId,
    );
    if (i >= 0) h.reports[i] = { ...row };
    else h.reports.push({ id: h.reports.length + 1, ...row });
  },
  incrementPersonaGameCount: async () => {},
  listRelationshipsAmong: async () => [],
  loadMemoryContext: async () => "",
}));

// 心理检查师与记事簿回写： mock 为即时成功（只验证编排与续跑语义，不验 AI 内容）
vi.mock("../persona/notebook", () => ({
  runNotebookWriteback: async () => {
    h.notebookCalls += 1;
    return {
      text: "回写摘要",
      memoriesAdded: 1,
      memoriesReinforced: 0,
      relationshipsTouched: 0,
      driftApplied: [],
    };
  },
}));
vi.mock("../persona/anatomist", () => ({
  runPsyCheck: async () => {
    h.anatomistCalls += 1;
    return "# 心理检查报告\n（mock）";
  },
}));

vi.mock("./ai/providers", () => ({
  callAi: async () => ({ ok: false, text: null, latencyMs: 1, error: "测试：AI 不可用 → 启发式兜底" }),
}));

// ---------- 工具 ----------
const OPTS: AdvancedOptions = {
  stepDelayMs: 0,
  phaseBreakMs: 0,
  sheriffEnabled: false,
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

function makeCard(id: number, name: string): PersonaCard {
  return {
    id,
    name,
    source: "manual",
    originName: null,
    originSource: null,
    profile: emptyPersonaProfile(),
    params: defaultPersonaParams(),
    notes: "",
    imageData: null,
    gameCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

async function waitFor(cond: () => boolean, label: string, timeoutMs = 25_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时：${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const eventsOf = (gameId: string) => h.events.filter((e) => e.gameId === gameId);
const reportsOf = (gameId: string) => h.reports.filter((r) => r.gameId === gameId);

beforeEach(() => {
  h.games.clear();
  h.events.length = 0;
  h.decisions.length = 0;
  h.reports.length = 0;
  h.notebookCalls = 0;
  h.anatomistCalls = 0;
  h.cards.clear();
  registry.clear();
  guideCache.clear();
  h.cards.set(101, makeCard(101, "曹操"));
  h.cards.set(102, makeCard(102, "刘备"));
});

describe("心理检查（手动开启 + 可续跑）", () => {
  it("全链路：终局不自动跑 → 手动开启生成 → poll 透出 → 重建续跑只补缺失座位", async () => {
    const { gameService } = await import("./service");
    const { gameId } = await gameService.createGame({
      boardId: "standard9",
      seats: makeSeats(9),
      options: OPTS,
      // 配了分析师且 autoGenerate——旧语义下终局会自动跑收尾；新语义必须不跑
      analystAi: { provider: "kimi", baseUrl: "http://test.local/v1", model: "analyst-model", apiKey: "k", autoGenerate: true },
      seatPersonas: [
        { seat: 1, personaId: 101 },
        { seat: 2, personaId: 102 },
      ],
    });
    await gameService.control(gameId, "start");
    await waitFor(() => registry.get(gameId)?.status === "finished", "对局结束", 90_000);

    // ① 终局后无报告无回写事件（自动触发已摘除——旧语义此处会自动生成）
    await new Promise((r) => setTimeout(r, 300));
    expect(reportsOf(gameId)).toHaveLength(0);
    expect(eventsOf(gameId).some((e) => e.title === "心理检查报告已生成")).toBe(false);
    expect(h.anatomistCalls).toBe(0);

    // ② 手动开启（不带配置：回落座位配置兜底）：回写 + 报告 + 事件齐出
    const r1 = await gameService.startPsyCheck(gameId, null);
    expect(r1.started).toBe(true);
    await waitFor(() => reportsOf(gameId).length === 2, "两份报告落库", 30_000);
    expect(h.anatomistCalls).toBe(2);
    expect(h.notebookCalls).toBe(2);
    const evs = eventsOf(gameId);
    expect(evs.filter((e) => e.title === "记事簿回写")).toHaveLength(2);
    expect(evs.filter((e) => e.title === "心理检查报告已生成")).toHaveLength(2);

    // ③ poll 透出逐座位状态：全部 done
    const poll = await gameService.poll(gameId, 0);
    expect(poll.psyCheck?.seats).toEqual([
      { seat: 1, status: "done" },
      { seat: 2, status: "done" },
    ]);

    // ④ 中断续跑：一份报告丢失（模拟中断残留半成品）+ 清内存（强制重放重建）
    const lost = h.reports.findIndex((r) => r.gameId === gameId && r.seat === 2);
    h.reports.splice(lost, 1);
    registry.delete(gameId);
    const r2 = await gameService.startPsyCheck(gameId, null);
    expect(r2.started).toBe(true);
    await waitFor(() => reportsOf(gameId).length === 2, "补回缺失报告", 30_000);
    // 只补 2 号座位：检查师多调 1 次；其记事簿回写不重复入账（回写事件已存在）
    expect(h.anatomistCalls).toBe(3);
    expect(h.notebookCalls).toBe(2);
    // 1 号座位的既有报告内容不被覆盖
    expect(reportsOf(gameId).find((r) => r.seat === 1)).toBeTruthy();

    // 幂等：全部完成后再开 → 拒绝并说明
    const r3 = await gameService.startPsyCheck(gameId, null);
    expect(r3.started).toBe(false);
    expect(r3.reason).toContain("已完成");
  }, 120_000);

  it("未分出胜负拒绝开启（对局进行中）", async () => {
    const { gameService } = await import("./service");
    const { gameId } = await gameService.createGame({
      boardId: "standard9",
      seats: makeSeats(9),
      options: OPTS,
      seatPersonas: [{ seat: 1, personaId: 101 }],
    });
    // created 状态（尚未开赛）
    const r = await gameService.startPsyCheck(gameId, null);
    expect(r.started).toBe(false);
    expect(r.reason).toContain("尚未分出胜负");
  });
});
