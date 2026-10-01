// ============================================================
// P0 回归测试：tick 循环健壮性（对局 8-9 轮后卡死）
// 1) 断链自愈：running 但 >15s 无 tick 且无在飞 tick → poll 立即补链复活
// 2) 不惊群：running 且近期有 tick → poll 绝不重新排程
// 3) DB 超时：tick 内 DB 调用挂起 → withTimeout 15s 抛错 → 可见暂停（非假死）
// 4) 无进展看门狗：连续 >30 个空转 tick → 判定引擎停滞 → 暂停 + 错误事件
// mock 风格与 ai/decide-retry.test.ts 一致（vi.hoisted 共享状态 + 假引擎）
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { DecisionInput, EngineEvent, PendingDecision } from "./engine/api";

// ---------- 共享 mock 状态（vi.hoisted 保证在 mock factory 前初始化） ----------
const h = vi.hoisted(() => ({
  games: new Map<string, Record<string, unknown>>(),
  events: [] as Record<string, unknown>[],
  aiCalls: 0,
  // >0 时接下来 N 次 appendEvents 模拟连接挂起 30s（验证 withTimeout 15s 起爆）
  appendHangBudget: 0,
  engine: null as FakeEngine | null,
}));

interface FakeEngine {
  state: { ticks: number };
  getSnapshot: () => {
    day: number;
    phase: string;
    phaseLabel: string;
    winner: "wolf" | "good" | null;
    finished: boolean;
    pendingSeat: number | null;
    players: never[];
  };
  advance: () => { events: EngineEvent[]; pending: PendingDecision | null };
  decide: (d: DecisionInput) => EngineEvent[];
  isFinished: () => boolean;
}

vi.mock("../queries/games", () => ({
  countGamesOnDate: async () => 0,
  insertGame: async (row: Record<string, unknown>) => {
    // 真实库会默认 createdAt；mock 补上，poll 组装快照时 toIso 才不炸
    h.games.set(row.id as string, { createdAt: new Date(), ...row });
  },
  updateGame: async (id: string, patch: Record<string, unknown>) => {
    const g = h.games.get(id);
    if (g) Object.assign(g, patch);
  },
  getGame: async (id: string) => h.games.get(id) ?? null,
  listGames: async () => [...h.games.values()],
  appendEvents: async (rows: Record<string, unknown>[]) => {
    if (h.appendHangBudget > 0) {
      h.appendHangBudget -= 1;
      await new Promise((r) => setTimeout(r, 30_000)); // 模拟 mysql2 连接挂起 30s
    }
    h.events.push(...rows);
  },
  getEventsAfter: async (gameId: string, afterSeq: number) =>
    h.events.filter((e) => e.gameId === gameId && (e.seq as number) > afterSeq),
  getAllEvents: async (gameId: string) => h.events.filter((e) => e.gameId === gameId),
  getLatestEvents: async (gameId: string, limit: number) =>
    h.events.filter((e) => e.gameId === gameId).slice(-(limit as number)),
}));

vi.mock("./ai/providers", () => ({
  callAi: async () => {
    h.aiCalls += 1;
    return { ok: false, text: null, latencyMs: 1, error: "not needed in watchdog tests" };
  },
}));

vi.mock("./engine/index", () => ({
  createEngine: () => h.engine,
}));

// ---------- 假引擎A：每 tick 产一个心跳事件，永不结束、永无待决 ----------
// 用于断链复活/不惊群测试：循环正常运转但事件单调递增，便于观察 tick 是否推进
function makeIdleEngine(): FakeEngine {
  const state = { ticks: 0 };
  return {
    state,
    getSnapshot: () => ({
      day: 1,
      phase: "day.speech",
      phaseLabel: "白天发言",
      winner: null,
      finished: false,
      pendingSeat: null,
      players: [],
    }),
    advance: () => {
      state.ticks += 1;
      return {
        events: [
          {
            day: 1,
            phase: "day.speech",
            type: "phase" as const,
            actor: null,
            title: "阶段推进",
            content: `心跳 tick ${state.ticks}`,
            thought: null,
            meta: null,
          },
        ],
        pending: null,
      };
    },
    decide: () => [],
    isFinished: () => false,
  };
}

// ---------- 假引擎B：恒无进展（无事件、无待决、未结束） → 触发停滞看门狗 ----------
function makeStallEngine(): FakeEngine {
  const state = { ticks: 0 };
  return {
    state,
    getSnapshot: () => ({
      day: 8,
      phase: "day.vote",
      phaseLabel: "放逐投票",
      winner: null,
      finished: false,
      pendingSeat: null,
      players: [],
    }),
    advance: () => {
      state.ticks += 1;
      return { events: [], pending: null };
    },
    decide: () => [],
    isFinished: () => false,
  };
}

// 延迟加载被测模块（等 mock 注册完毕）
const { gameService, registry } = await import("./service");

async function startGame(stepDelayMs: number): Promise<string> {
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
    options: { stepDelayMs, phaseBreakMs: 0, sheriffEnabled: false, allowSelfDestruct: true, speechRoundsLimit: 2 },
  });
  await gameService.control(gameId, "start");
  return gameId;
}

async function waitFor(cond: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`超时：${what}`);
}

async function waitStatus(gameId: string, want: string, timeoutMs = 3000): Promise<void> {
  await waitFor(
    () => h.games.get(gameId)?.status === want,
    `对局状态未变为 ${want}（当前 ${String(h.games.get(gameId)?.status)}）`,
    timeoutMs,
  );
}

// 停止所有遗留 runtime 的 tick 循环（模块级 registry 跨用例存活，必须清理防串扰）
function stopAllRuntimes(): void {
  for (const rt of registry.values()) {
    rt.status = "finished";
    if (rt.timer) clearTimeout(rt.timer);
    rt.timer = null;
  }
  registry.clear();
}

beforeEach(() => {
  vi.useRealTimers();
  stopAllRuntimes();
  h.games.clear();
  h.events.length = 0;
  h.aiCalls = 0;
  h.appendHangBudget = 0;
  h.engine = null;
});

afterEach(() => {
  stopAllRuntimes();
  vi.useRealTimers();
});

describe("断链自愈：poll 充当 tick 循环看门狗", () => {
  it("running 但 60s 无 tick 且 timer 丢失、无在飞 tick → poll 立即复活循环（并节流）", async () => {
    h.engine = makeIdleEngine();
    const gameId = await startGame(200); // 步长 200ms：首 tick 后有确定性空闲窗口
    await waitFor(() => h.events.length >= 1, "首个 tick 未产出事件");

    const rt = registry.get(gameId)!;
    expect(rt.status).toBe("running");
    expect(rt.ticking).toBe(false);

    // 人为制造断链：timer 丢失（宿主挂起/回收）+ 心跳拨到 60s 前
    if (rt.timer) clearTimeout(rt.timer);
    rt.timer = null;
    rt.lastTickAt = Date.now() - 60_000;
    const ticksBefore = h.engine.state.ticks;
    const eventsBefore = h.events.length;

    await gameService.poll(gameId, 0);

    // poll 同步补链：立即重排 0 延迟 tick，心跳前移
    expect(rt.timer).not.toBeNull();
    expect(Date.now() - rt.lastTickAt).toBeLessThan(15_000);

    // 节流：15s 内再次 poll 不得重复排程（避免并发轮询惊群）
    const reviveTimer = rt.timer;
    await gameService.poll(gameId, 0);
    expect(rt.timer).toBe(reviveTimer);

    // tick 循环恢复运转：引擎继续推进、事件继续落库
    await waitFor(() => h.engine!.state.ticks > ticksBefore, "复活后 tick 未恢复推进");
    expect(h.events.length).toBeGreaterThan(eventsBefore);
    expect(rt.status).toBe("running");
  });

  it("running 且 5s 内有 tick → poll 不复活（不改心跳、不重排程），循环按原节奏推进", async () => {
    h.engine = makeIdleEngine();
    const gameId = await startGame(1_000); // 步长 1s：poll 期间不会有新 tick 干扰断言
    await waitFor(() => h.events.length >= 1, "首个 tick 未产出事件");

    const rt = registry.get(gameId)!;
    const lastTickAt = rt.lastTickAt;
    const timer = rt.timer;
    expect(rt.status).toBe("running");
    expect(timer).not.toBeNull();
    expect(Date.now() - lastTickAt).toBeLessThan(15_000);

    await gameService.poll(gameId, 0);

    expect(rt.lastTickAt).toBe(lastTickAt); // poll 未触碰心跳
    expect(rt.timer).toBe(timer); // poll 未重新排程

    // 既有 setTimeout 链仍正常推进（自愈逻辑不干扰健康对局）
    await waitFor(() => h.events.length >= 2, "健康对局的 tick 链未继续推进");
  });
});

describe("DB 超时保护：挂起的连接不得永久卡住 tick 循环", () => {
  it("appendEvents 挂起 30s → withTimeout 15s 抛错 → 置 paused + 事件流记录「系统错误」+ tick 锁释放", async () => {
    vi.useFakeTimers();
    try {
      h.engine = makeIdleEngine();
      h.appendHangBudget = 1; // 第 1 次 appendEvents 挂起 30s；其后恢复（错误事件可落库）
      const gameId = await startGame(5);
      const rt = registry.get(gameId)!;

      // 触发首个 tick：advance 产事件 → persistEvents 卡在挂起的 appendEvents 上
      await vi.advanceTimersByTimeAsync(1);
      expect(rt.ticking).toBe(true); // 复现诊断点3：tick 卡在 DB 调用上
      expect(rt.status).toBe("running");

      // 推进 15.1s：withTimeout 起爆 → runTick 捕获 → handleTickError
      await vi.advanceTimersByTimeAsync(15_100);

      expect(rt.status).toBe("paused");
      expect(rt.ticking).toBe(false); // tick 锁已释放，不再永久 true
      expect(h.games.get(gameId)!.status).toBe("paused");
      const errEvent = h.events.find((e) => e.title === "系统错误");
      expect(errEvent).toBeDefined();
      expect(String(errEvent!.content)).toContain("DB操作超时");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("无进展看门狗：引擎停滞必须可见暂停而非空转", () => {
  it("连续 >30 个 tick 无事件/无待决/未结束 → 置 paused + 错误事件写明「引擎无进展停滞」+ 循环停止", async () => {
    h.engine = makeStallEngine();
    const gameId = await startGame(1); // 1ms 步长空转

    await waitStatus(gameId, "paused");

    const rt = registry.get(gameId)!;
    expect(rt.status).toBe("paused");
    expect(h.engine!.state.ticks).toBeGreaterThanOrEqual(31); // 第 31 个连续空转 tick 触发
    const errEvent = h.events.find((e) => e.title === "系统错误");
    expect(errEvent).toBeDefined();
    expect(String(errEvent!.content)).toContain("引擎无进展停滞");

    // 看门狗触发后循环彻底停止，不再空转
    const ticksAtPause = h.engine!.state.ticks;
    await new Promise((r) => setTimeout(r, 30));
    expect(h.engine!.state.ticks).toBe(ticksAtPause);
  });
});
