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
  aiResponse: null as string | null, // 非空时 callAi 返回该文本（注入非法输出场景）
  aiResponses: [] as string[], // 非空时按调用顺序返回（重试链路回归）
  aiUsers: [] as string[],
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

// AI 响应模式可控：aiResponse=null → 永远失败（队列空 → ok:false）；非空 → 返回该文本（可注入非法输出）
vi.mock("./providers", () => ({
  callAi: async (_cfg: unknown, _system: string, user: string) => {
    h.aiUsers.push(user);
    const queued = h.aiResponses.shift();
    if (queued != null) return { ok: true, text: queued, latencyMs: 1, error: null };
    return h.aiResponse != null
      ? { ok: true, text: h.aiResponse, latencyMs: 1, error: null }
      : { ok: false, text: null, latencyMs: 1, error: "请求超时（150s）" };
  },
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

function makeFakeBatchEngine(subs?: PendingDecision[]) {
  const state = { finished: false, decided: [] as DecisionInput[] };
  const batchPending = {
    batch: subs ?? [makeSub(2), makeSub(5)],
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
  h.aiResponse = null;
  h.aiResponses.length = 0;
  h.aiUsers.length = 0;
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
    // 托管抹消（2026-10-15 用户裁定）：子决策连续失败 → 立即暂停，不再兜底按兵不动
    const t1 = Date.now();
    while (Date.now() - t1 < 5_000) {
      if (h.games.get(gameId)?.status === "paused") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(h.games.get(gameId)?.status).toBe("paused");
    // 决策零消费（本批没有任何兜底输入进引擎）
    expect(h.engine!.state.decided.length).toBe(0);
    // 暂停原因透出真实根因（座位号+调用层故障）
    const { registry } = await import("../service");
    expect(registry.get(gameId)!.pauseReason).toContain("请求超时（150s）");
    expect(h.events.some((e) => e.title === "AI 服务中断")).toBe(true);
    await gameService.control(gameId, "terminate");
  });
});

describe("批量「输出非法」托管的原因透出与原始输出留痕（对局 20261009001 回归）", () => {
  it("AI 返回非法目标 → 兜底标记 + 事件 meta 透出原因与原始输出截断", async () => {
    // 狼队独立思考批次：AI 返回空思考（wolfThink 子项以 thought 为有效动作）→
    // sanitize 判非法兜底托管（与对局 20260930002/20261009001 的「输出非法」托管同路径）
    const runSub = (seat: number): PendingDecision => ({
      seat,
      role: "werewolf",
      kind: "wolfThink",
      options: [],
      allowSkip: false,
      hint: "狼队独立思考",
      view: {
        seat,
        role: "villager",
        roleName: "狼人",
        camp: "wolf",
        day: 1,
        phase: "day.sheriff.run",
        aliveSeats: [1, 2, 3, 4, 5, 6, 7, 8, 9],
        deadSeats: [],
        revealedRoles: {},
        sheriffSeat: null,
        selfAlive: true,
        rules: { witchSelfSave: "never" },
        publicLog: [],
        private: {},
      } as unknown as PendingDecision["view"],
    });
    h.engine = makeFakeBatchEngine([runSub(3), runSub(7)]);
    h.aiResponse = '{"thought":""}'; // 空思考——wolfThink 子项以 thought 为有效动作，空即非法

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

    // 托管抹消：批量输出非法 → 立即暂停，透出座位与原始输出截断；决策零消费
    const t0 = Date.now();
    while (Date.now() - t0 < 5_000) {
      if (h.games.get(gameId)?.status === "paused") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(h.games.get(gameId)?.status).toBe("paused");
    expect(h.engine!.state.decided.length).toBe(0);
    const { registry } = await import("../service");
    expect(registry.get(gameId)!.pauseReason).toContain("连续输出非法");
    expect(registry.get(gameId)!.pauseReason).toContain("原始输出");
    expect(h.events.some((e) => e.title === "AI 服务中断")).toBe(true);
    await gameService.control(gameId, "terminate");
  });
});

describe("批量必选动作的损坏输出重试（20261025002 · 2号警长报名回归）", () => {
  it("首次只捞出 thought 时重新提问，合法后同批结算且不跳过", async () => {
    const sheriffSub = (seat: number): PendingDecision => ({
      ...makeSub(seat),
      kind: "sheriffRun",
      options: [1, 0],
      allowSkip: false,
    });
    h.engine = makeFakeBatchEngine([sheriffSub(2), sheriffSub(5)]);
    h.aiResponses.push(
      '{"thought":"只有心理，没有报名动作" garbage}',
      '{"thought":"5号留在警下","targets":[0]}',
      '{"thought":"2号参与竞选","targets":[1]}',
    );
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
      options: { stepDelayMs: 5, sheriffEnabled: true, allowSelfDestruct: true, speechRoundsLimit: 2 },
    });
    await gameService.control(gameId, "start");
    const t0 = Date.now();
    while (Date.now() - t0 < 5_000 && h.games.get(gameId)?.status !== "finished" && h.games.get(gameId)?.status !== "paused") {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(h.games.get(gameId)?.status).toBe("finished");
    expect(h.aiUsers).toHaveLength(3);
    expect(h.engine!.state.decided).toHaveLength(1);
    expect(h.engine!.state.decided[0]!.batchInputs?.[0]?.targets).toEqual([1]);
    expect(h.engine!.state.decided[0]!.batchInputs?.[1]?.targets).toEqual([0]);
    expect(h.decisions.filter((d) => d.gameId === gameId)).toHaveLength(1);
  });
});