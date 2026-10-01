// 批量决策托管原因透出测试（2026-09-30 对局 20260930001 排查实锤回归）：
// 批量路径（daySkill 权衡/暗票/狼队思考等）子决策兜底时只留「系统托管」标记，
// 真实失败原因被吞——一局 38 次托管 25 次无从定位。
// 修复后：failReasons 按座位汇总挂到本批全部事件的 meta.fallbackReason（前端「托管原因」行可见）。
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DecisionInput, PendingDecision } from "../engine/api";

// ---------- 内存态存储 ----------
const h = {
  games: new Map<string, Record<string, unknown>>(),
  events: [] as Record<string, unknown>[],
  decisions: [] as Record<string, unknown>[],
  engine: null as ReturnType<typeof makeFakeBatchEngine> | null,
};

vi.mock("../../queries/games", () => ({
  countGamesOnDate: async () => 0,
  insertGame: async (row: Record<string, unknown>) => {
    h.games.set(row.id as string, { ...row });
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
}));

vi.mock("../../queries/decisions", () => ({
  appendDecision: async (row: Record<string, unknown>) => {
    h.decisions.push({ ...row });
  },
  getDecisions: async (gameId: string) =>
    h.decisions
      .filter((d) => d.gameId === gameId)
      .sort((a, b) => (a.idx as number) - (b.idx as number)),
}));

// AI 永远失败（队列空 → ok:false），错误原因固定可断言
vi.mock("./providers", () => ({
  callAi: async () => ({ ok: false, text: null, latencyMs: 1, error: "请求超时（150s）" }),
}));

vi.mock("../engine/index", () => ({
  createEngine: () => h.engine,
  MEETING_WOLVES: new Set(["werewolf", "wolfKing", "whiteWolfKing", "nightmare", "bloodMoon", "mechWolf"]),
}));

// ---------- 假引擎：产出双人 daySkill 批量待决 ----------
function makeSub(seat: number): PendingDecision {
  return {
    seat,
    role: "werewolf",
    kind: "daySkill",
    options: [],
    allowSkip: true,
    hint: "技能权衡",
    view: {
      seat,
      role: "werewolf",
      roleName: "狼人",
      camp: "wolf",
      day: 1,
      phase: "day.skill",
      aliveSeats: [1, 2, 3, 4, 5, 6, 7, 8, 9],
      deadSeats: [],
      revealedRoles: {},
      sheriffSeat: null,
      selfAlive: true,
      rules: { witchSelfSave: "never" },
      publicLog: [],
      private: {},
    } as unknown as PendingDecision["view"],
  };
}

function makeFakeBatchEngine() {
  const state = { finished: false, decided: [] as DecisionInput[] };
  const batchPending = {
    batch: [makeSub(2), makeSub(5)],
  } as unknown as PendingDecision;
  return {
    state,
    getSnapshot: () => ({
      day: 1,
      phase: "day.skill",
      phaseLabel: "白天 · 技能权衡",
      winner: null as "wolf" | "good" | null,
      finished: state.finished,
      pendingSeat: 2,
      players: [],
    }),
    advance: () => ({
      events: [
        {
          day: 1,
          phase: "day.skill",
          type: "phase" as const,
          actor: null,
          title: "技能权衡",
          content: "主动技能权衡窗口",
          thought: null,
          meta: null,
        },
      ],
      pending: state.finished ? null : batchPending,
    }),
    decide: (input: DecisionInput) => {
      state.decided.push(input);
      state.finished = true;
      return (input.batchInputs ?? []).map((sub, i) => ({
        day: 1,
        phase: "day.skill",
        type: "action" as const,
        actor: batchPending.batch![i]!.seat,
        title: "技能权衡",
        content: "按兵不动",
        thought: sub.thought ?? null,
        meta: null,
      }));
    },
    isFinished: () => state.finished,
  };
}

const { gameService } = await import("../service");

beforeEach(() => {
  h.games.clear();
  h.events.length = 0;
  h.decisions.length = 0;
  h.engine = makeFakeBatchEngine();
});

describe("批量决策托管原因透出", () => {
  it("子决策连续失败 → 兜底按兵不动，真实原因按座位挂到本批全部事件 meta", async () => {
    const seats = Array.from({ length: 9 }, (_, i) => ({
      seat: i + 1,
      provider: "kimi" as const,
      baseUrl: "http://mock.local/v1",
      model: "mock-model",
      apiKey: "sk-mock",
    }));
    const { gameId } = await gameService.createGame({
      boardId: "standard9",
      seats,
      options: { stepDelayMs: 5, sheriffEnabled: false, allowSelfDestruct: true, speechRoundsLimit: 2 },
    });
    await gameService.control(gameId, "start");

    const t0 = Date.now();
    while (Date.now() - t0 < 3_000) {
      if (h.games.get(gameId)?.status === "finished") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(h.games.get(gameId)?.status).toBe("finished");

    // 两个子决策均托管按兵不动（skip），标记保留
    const decided = h.engine!.state.decided.at(-1)!;
    expect(decided.batchInputs).toHaveLength(2);
    for (const sub of decided.batchInputs!) {
      expect(sub.thought).toBe("[AI连续无响应，系统托管]");
      expect(sub.skip).toBe(true);
    }

    // 本批全部产出事件带 meta.fallbackReason，含两个座位号与真实原因
    const decidedEvents = h.events.filter((e) => e.type === "action" && e.title === "技能权衡");
    expect(decidedEvents.length).toBe(2);
    for (const e of decidedEvents) {
      const m = typeof e.meta === "string" ? e.meta : JSON.stringify(e.meta ?? {});
      expect(m).toContain("fallbackReason");
      expect(m).toContain("2号");
      expect(m).toContain("5号");
      expect(m).toContain("请求超时（150s）");
    }
  });
});
