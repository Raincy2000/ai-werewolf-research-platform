// ============================================================
// 额度耗尽立即暂停的回归测试（对局 20261011001 实锤）：
// DeepSeek 额度/token 耗尽后，旧行为是逐座托管（「我这边没什么头绪」批量垃圾发言），
// 对局质量崩塌还照跑到尾。新行为：识别余额类错误 → 立即暂停 + 专属事件 + pauseReason 透出
//（「继续」按钮旁提示用户充值/换配置）+ 不消费兜底决策（恢复后重新思考）。
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DecisionInput, PendingDecision } from "./engine/api";

const h = vi.hoisted(() => ({
  games: new Map<string, Record<string, unknown>>(),
  events: [] as Record<string, unknown>[],
  decisions: [] as Record<string, unknown>[],
  aiError: "queue empty" as string,
  aiPlan: [] as ("ok" | "fail")[], // 预设成败序列；用尽后按 defaultFail 决定
  defaultFail: false, // 序列用尽后的默认行为：true=持续失败（熔断测试），false=持续成功
  engine: null as ReturnType<typeof makeEngine> | null,
}));

vi.mock("../queries/games", () => ({
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

vi.mock("../queries/decisions", () => ({
  appendDecision: async (row: Record<string, unknown>) => {
    h.decisions.push({ ...row });
  },
  getDecisions: async (gameId: string) =>
    h.decisions
      .filter((d) => d.gameId === gameId)
      .sort((a, b) => (a.idx as number) - (b.idx as number)),
}));

vi.mock("./ai/providers", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./ai/providers")>();
  return {
    ...orig,
    callAi: async () => {
      const step = h.aiPlan.shift() ?? (h.defaultFail ? "fail" : "ok");
      if (step === "ok")
        return { ok: true, text: '{"thought":"t","targets":[1]}', latencyMs: 1, error: null };
      return { ok: false, text: null, latencyMs: 1, error: h.aiError, quota: true };
    },
  };
});

vi.mock("./engine/index", () => ({
  createEngine: () => h.engine,
  MEETING_WOLVES: new Set(["werewolf"]),
}));

const witchPending: PendingDecision = {
  seat: 3,
  role: "witch",
  kind: "witchAction",
  options: [1, 2, 5],
  allowSkip: true,
  hint: "今夜被刀的是 2号，是否用药？",
  view: {
    seat: 3,
    role: "witch",
    roleName: "女巫",
    camp: "god",
    day: 1,
    phase: "night.witch",
    aliveSeats: [1, 2, 3, 4, 5, 6, 7, 8, 9],
    deadSeats: [],
    revealedRoles: {},
    sheriffSeat: null,
    selfAlive: true,
    publicLog: [],
    private: {},
  },
};

function makeEngine() {
  const state = { decided: [] as DecisionInput[] };
  return {
    state,
    getSnapshot: () => ({
      day: 1,
      phase: "night.witch",
      phaseLabel: "夜晚 · 女巫行动",
      winner: null,
      finished: false,
      pendingSeat: 3,
      pendingActs: [],
      players: [],
    }),
    advance: () => ({ events: [], pending: witchPending }),
    decide: (input: DecisionInput) => {
      state.decided.push(input);
      return [];
    },
    isFinished: () => false,
  };
}

const { gameService, AiQuotaExhaustedError } = await import("./service");
const { isQuotaErrorText } = await import("./ai/quota");

async function waitStatus(gameId: string, want: string, timeoutMs = 3000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (h.games.get(gameId)?.status === want) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`超时：对局状态未变为 ${want}（当前 ${h.games.get(gameId)?.status}）`);
}

beforeEach(() => {
  h.games.clear();
  h.events.length = 0;
  h.decisions.length = 0;
  h.aiError = "queue empty";
  h.aiPlan = [];
  h.defaultFail = false;
  h.engine = null;
});

describe("额度耗尽识别", () => {
  it("余额类错误文案命中；普通超时/网络错误不误伤", () => {
    expect(isQuotaErrorText("HTTP 402: Insufficient Balance")).toBe(true);
    expect(isQuotaErrorText("HTTP 401 鉴权失败 quota exceeded")).toBe(true);
    expect(isQuotaErrorText("余额不足，请充值")).toBe(true);
    expect(isQuotaErrorText("请求超时（90s）")).toBe(false);
    expect(isQuotaErrorText("fetch failed: ECONNRESET")).toBe(false);
    expect(isQuotaErrorText(null)).toBe(false);
  });
});

describe("额度耗尽 → 立即暂停（不托管、不垃圾发言）", () => {
  it("DeepSeek 402：对局立即暂停、专属事件落盘、pauseReason 透出、决策未被兜底消费", async () => {
    h.aiError = "HTTP 402: {\"error\":{\"message\":\"Insufficient Balance\"}}";
    h.defaultFail = true; // 持续失败（否则计划用尽后默认成功，对局永不停）
    h.engine = makeEngine();

    const seats = Array.from({ length: 9 }, (_, i) => ({
      seat: i + 1,
      provider: "deepseek" as const,
      baseUrl: "http://mock.local/v1",
      model: "deepseek-chat",
      apiKey: "sk-mock",
    }));
    const { gameId } = await gameService.createGame({
      boardId: "standard9",
      seats,
      options: { stepDelayMs: 5, sheriffEnabled: false, allowSelfDestruct: true, speechRoundsLimit: 2 },
    });
    await gameService.control(gameId, "start");
    await waitStatus(gameId, "paused");

    // 专属事件（非泛泛的「系统错误」）
    const ev = h.events.find((e) => e.title === "AI 额度耗尽");
    expect(ev).toBeDefined();
    expect(String(ev!.content)).toContain("请先给该账户充值");
    // 暂停原因透出（「继续」按钮旁的提示文本）
    const { registry } = await import("./service");
    expect(registry.get(gameId)!.pauseReason).toContain("AI 额度不足");
    expect(registry.get(gameId)!.pauseReason).toContain("deepseek-chat");
    // 关键：没有托管兜底消费决策（旧行为会写入「AI连续无响应，系统托管」继续跑）
    expect(h.engine!.state.decided.length).toBe(0);
    expect(h.decisions.length).toBe(0);
  });

  it("AiQuotaExhaustedError 可从 service 导出（错误类型契约）", () => {
    expect(new AiQuotaExhaustedError("x").name).toBe("AiQuotaExhaustedError");
  });
});

describe("AI 连续失效熔断（断电/休眠后连接假死的防线，20261011003 实锤）", () => {
  async function startTestGame(): Promise<string> {
    h.engine = makeEngine();
    const seats = Array.from({ length: 9 }, (_, i) => ({
      seat: i + 1,
      provider: "deepseek" as const,
      baseUrl: "http://mock.local/v1",
      model: "deepseek-chat",
      apiKey: "sk-mock",
    }));
    const { gameId } = await gameService.createGame({
      boardId: "standard9",
      seats,
      options: { stepDelayMs: 5, sheriffEnabled: false, allowSelfDestruct: true, speechRoundsLimit: 2 },
    });
    await gameService.control(gameId, "start");
    return gameId;
  }

  it("连续 3 次调用层故障 → 暂停并透出「AI 服务中断」；额度错误仍立即暂停", async () => {
    h.aiError = "请求超时（150s）"; // 调用层故障（非额度）
    h.defaultFail = true;
    const gameId = await startTestGame();
    await waitStatus(gameId, "paused");
    const { registry } = await import("./service");
    const rt = registry.get(gameId)!;
    expect(rt.pauseReason).toContain("AI 服务连续无响应");
    expect(rt.aiOutageStreak).toBeGreaterThanOrEqual(3);
    expect(h.events.some((e) => e.title === "AI 服务中断")).toBe(true);
    // 熔断前的 2 次故障按托管容忍（设计如此），第 3 次触发暂停、此后停摆
    expect(h.decisions.filter((d) => d.gameId === gameId).length).toBe(2);
    await gameService.control(gameId, "terminate");
  });

  it("偶发两次故障 + 一次成功 → 计数清零不熔断", async () => {
    // 失败、失败、成功、失败、失败（不足连续 3）——循环期间不暂停
    h.aiError = "请求超时（150s）";
    h.aiPlan = ["fail", "fail", "ok", "fail", "fail", "ok"]; // 之后默认成功（defaultFail=false）
    const gameId = await startTestGame();
    await new Promise((r) => setTimeout(r, 600));
    expect(h.games.get(gameId)!.status).toBe("running"); // 未暂停
    const { registry } = await import("./service");
    expect(registry.get(gameId)!.aiOutageStreak ?? 0).toBeLessThan(3);
    await gameService.control(gameId, "terminate");
  });

  it("输出非法（模型行为）不计入熔断", async () => {
    h.aiError = "涌现输出无法解析"; // 解析失败不匹配调用层故障特征
    h.defaultFail = true;
    const gameId = await startTestGame();
    await new Promise((r) => setTimeout(r, 600));
    expect(h.games.get(gameId)!.status).toBe("running"); // 不熔断（启发式兜底继续）
    await gameService.control(gameId, "terminate");
  });
});
