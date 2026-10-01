// ============================================================
// 回归测试：engine.decide() 校验抛错不得暂停对局
// - AI 输出非法 → 重试一次 AI（提示附错误原因）→ 仍非法则启发式兜底
//   （thought "[AI输出非法，系统托管]"），对局继续
// - 仅引擎内部异常（连合法兜底都被拒）才置 paused
// 另覆盖 parse.ts 的互斥字段语义清洗（witchAction / selfDestruct+duel）
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DecisionInput, PendingDecision } from "../engine/api";

// ---------- 共享 mock 状态（vi.hoisted 保证在 mock factory 前初始化） ----------
const h = vi.hoisted(() => ({
  games: new Map<string, Record<string, unknown>>(),
  events: [] as Record<string, unknown>[],
  decisions: [] as Record<string, unknown>[],
  aiQueue: [] as string[],
  aiCalls: [] as { system: string; user: string }[],
  aiHang: false, // true = AI 永不返回（模拟长推理，用于暂停即时收敛测试）
  aiSlow: false, // true = AI 吃满单次调用超时后失败（模拟提供方故障，用于决策总预算测试）
  engine: null as ReturnType<typeof makeFakeEngine> | null,
}));

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

// 决策日志内存化（与 winrate/recovery 等测试同一模式）：
// 真实 appendDecision 直连 TiDB，本地无 VPC 网络时会挂起至超时、拖垮对局循环
vi.mock("../../queries/decisions", () => ({
  appendDecision: async (row: Record<string, unknown>) => {
    h.decisions.push({ ...row });
  },
  getDecisions: async (gameId: string) =>
    h.decisions
      .filter((d) => d.gameId === gameId)
      .sort((a, b) => (a.idx as number) - (b.idx as number)),
}));

vi.mock("./providers", () => ({
  callAi: async (
    _cfg: unknown,
    system: string,
    user: string,
    opts?: { timeoutMs?: number; maxRetries?: number },
  ) => {
    h.aiCalls.push({ system, user });
    if (h.aiHang) {
      // 永不 settle：模拟真实模型长推理；暂停的 Promise.race 应立即接管
      return new Promise(() => {});
    }
    if (h.aiSlow) {
      // 模拟提供方故障：吃满单次调用超时（真实 callAi 的 AbortController 行为）后失败
      await new Promise((r) => setTimeout(r, Math.min(opts?.timeoutMs ?? 90_000, 5_000)));
      return { ok: false, text: null, latencyMs: 1, error: "timeout" };
    }
    const next = h.aiQueue.shift();
    if (next == null) return { ok: false, text: null, latencyMs: 1, error: "queue empty" };
    return { ok: true, text: next, latencyMs: 1, error: null };
  },
}));

vi.mock("../engine/index", () => ({
  createEngine: () => h.engine,
}));

// ---------- 假引擎：validate 返回非空字符串即视为校验失败抛错 ----------
// finishAfterDecide=false 时 decide 后不终局（用于暂停后观察停链而非 finished 收敛）
function makeFakeEngine(validate: (d: DecisionInput) => string | null, finishAfterDecide = true) {
  const state = { finished: false, decided: [] as DecisionInput[] };
  return {
    state,
    getSnapshot: () => ({
      day: 1,
      phase: "night.witch",
      phaseLabel: "夜晚 · 女巫行动",
      winner: null as "wolf" | "good" | null,
      finished: state.finished,
      pendingSeat: 3,
      players: [],
    }),
    advance: () => ({
      events: [
        {
          day: 1,
          phase: "night.witch",
          type: "phase" as const,
          actor: null,
          title: "女巫行动",
          content: "女巫请睁眼",
          thought: null,
          meta: null,
        },
      ],
      pending: state.finished ? null : witchPending,
    }),
    decide: (input: DecisionInput) => {
      const err = validate(input);
      if (err) throw new Error(err);
      state.decided.push(input);
      if (finishAfterDecide) state.finished = true;
      return [
        {
          day: 1,
          phase: "night.witch",
          type: "action" as const,
          actor: 3,
          title: "夜间行动",
          content: "女巫行动完毕",
          thought: input.thought ?? null,
          meta: null,
        },
      ];
    },
    isFinished: () => state.finished,
  };
}

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
    private: { witchPotions: { save: true, poison: true }, witchVictimTonight: 2 },
  },
};

// 延迟加载被测模块（等 mock 注册完毕）
const { gameService } = await import("../service");
const { parseDecision } = await import("./parse");

async function startGame(): Promise<string> {
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
  return gameId;
}

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
  h.aiQueue.length = 0;
  h.aiCalls.length = 0;
  h.aiHang = false;
  h.aiSlow = false;
  h.engine = null;
});

describe("parse 互斥字段语义清洗", () => {
  it("witchSave=true 时强制清空 targets（同晚只能用一瓶药）", () => {
    const d = parseDecision('{"thought":"救人","witchSave":true,"targets":[5]}', witchPending);
    expect(d).not.toBeNull();
    expect(d!.witchSave).toBe(true);
    expect(d!.targets).toBeUndefined();
  });

  it("targets 非空时强制 witchSave=false", () => {
    // 毒杀目标存在时，witchSave 不得为真（显式 false 或缺省均为合法）
    const d = parseDecision('{"thought":"毒5号","targets":[5]}', witchPending);
    expect(d!.targets).toEqual([5]);
    expect(d!.witchSave).toBeFalsy();
  });

  it("skip=true 时清除用药字段", () => {
    const d = parseDecision('{"thought":"都不管","skip":true,"witchSave":true,"targets":[5]}', witchPending);
    expect(d!.skip).toBe(true);
    expect(d!.witchSave).toBeUndefined();
    expect(d!.targets).toBeUndefined();
  });

  it("selfDestruct 与 duel 同时给出时优先自爆并清 duel", () => {
    const speechPending: PendingDecision = { ...witchPending, kind: "daySpeech", options: [] };
    const d = parseDecision(
      '{"thought":"自爆","speech":"我是狼我认了","selfDestruct":true,"duel":5}',
      speechPending,
    );
    expect(d!.selfDestruct).toBe(true);
    expect(d!.duel).toBeUndefined();
  });
});

describe("tick 循环：decide 校验抛错处理", () => {
  it("AI 输出非法 → 带错误原因重试一次，第二次合法则对局正常结束", async () => {
    // 引擎规则：不允许毒 5号（模拟 parse 无法预知的校验）
    h.engine = makeFakeEngine((d) => (d.targets?.includes(5) ? "该目标不合法" : null));
    h.aiQueue.push('{"thought":"毒5号","targets":[5]}', '{"thought":"改毒1号","targets":[1]}');

    const gameId = await startGame();
    await waitStatus(gameId, "finished");

    expect(h.aiCalls.length).toBe(2);
    expect(h.aiCalls[1].user).toContain("上一次输出非法");
    expect(h.aiCalls[1].user).toContain("该目标不合法");
    expect(h.engine!.state.decided.at(-1)!.targets).toEqual([1]);
    expect(h.games.get(gameId)!.status).toBe("finished");
  });

  it("重试仍非法 → 启发式兜底（thought=[AI输出非法，系统托管]），对局不暂停", async () => {
    h.engine = makeFakeEngine((d) => (d.targets?.includes(5) ? "该目标不合法" : null));
    h.aiQueue.push('{"thought":"毒5号","targets":[5]}', '{"thought":"还毒5号","targets":[5]}');

    const gameId = await startGame();
    await waitStatus(gameId, "finished");

    expect(h.aiCalls.length).toBe(2);
    const last = h.engine!.state.decided.at(-1)!;
    expect(last.skip).toBe(true); // witchAction 托管 = 保守放弃用药
    expect(last.thought).toBe("[AI输出非法，系统托管]");
    expect(h.games.get(gameId)!.status).toBe("finished");
    expect(h.events.some((e) => e.thought === "[AI输出非法，系统托管]")).toBe(true);
  });

  it("解药耗尽仍 witchSave → 意图保留式修正（不托管、不重试、thought 保留、meta.repaired 标注）", async () => {
    // 事故回归（2026-08-02 线上实锤）：解药首夜已用，后续夜晚模型仍 witchSave=true，
    // 引擎拒"解药已用完"→重试仍犯→整轮降级托管。修复后：repairDecision 直接修成合法等价。
    h.engine = makeFakeEngine((d) => (d.witchSave ? "解药已用完" : null));
    // 待决视图里药水状态为"解药无"（引擎校验与服务层修正共用同一事实源）
    witchPending.view.private.witchPotions = { save: false, poison: true };
    h.aiQueue.push('{"thought":"想救2号","witchSave":true}');

    const gameId = await startGame();
    await waitStatus(gameId, "finished");

    expect(h.aiCalls.length).toBe(1); // 不触发重试
    const last = h.engine!.state.decided.at(-1)!;
    expect(last.witchSave).toBeUndefined(); // 解药被剔除
    expect(last.skip).toBe(true); // 按不用药处理
    expect(last.thought).toBe("想救2号"); // 思考量保留（此前会被托管标签覆盖丢失）
    expect(last.thought).not.toContain("系统托管");
    expect(
      h.events.some((e) => {
        const m = typeof e.meta === "string" ? e.meta : JSON.stringify(e.meta ?? {});
        return m.includes("AI输出修正");
      }),
    ).toBe(true);
    // 恢复夹具，避免污染同文件其他用例
    witchPending.view.private.witchPotions = { save: true, poison: true };
  });

  it("AI 连续无响应 → 启发式兜底（thought=[AI连续无响应，系统托管]）", async () => {
    h.engine = makeFakeEngine(() => null);
    // aiQueue 留空 → callAi 返回 ok:false

    const gameId = await startGame();
    await waitStatus(gameId, "finished");

    const last = h.engine!.state.decided.at(-1)!;
    expect(last.thought).toBe("[AI连续无响应，系统托管]");
    expect(h.games.get(gameId)!.status).toBe("finished");
  });

  it("AI 提供方悬挂超预算 → 决策点总预算耗尽立即托管，对局不被卡死", async () => {
    // 总预算 400ms：旧行为下单决策点最坏静默 ~9 分钟（2 次尝试 × 3 次重试 × 90s）；
    // 预算制下耗尽即启发式托管（线上事故：提供方故障时对局假死 8.5 分钟被手动终止）
    process.env.AI_DECISION_DEADLINE_MS = "400";
    try {
      h.engine = makeFakeEngine(() => null);
      h.aiSlow = true; // 每次调用吃满单次超时后失败
      const t0 = Date.now();
      const gameId = await startGame();
      await waitStatus(gameId, "finished", 15_000);
      const elapsed = Date.now() - t0;

      const last = h.engine!.state.decided.at(-1)!;
      expect(last.thought).toBe("[AI连续无响应，系统托管]");
      expect(h.games.get(gameId)!.status).toBe("finished");
      // 秒级内兜底（单次调用下限 3s + 预算守卫短路第二次尝试），绝不出现分钟级静默
      expect(elapsed).toBeLessThan(10_000);
    } finally {
      delete process.env.AI_DECISION_DEADLINE_MS;
    }
  }, 20_000);

  it("连合法兜底都被引擎拒绝 → 判定引擎内部异常，置 paused 并记录错误事件", async () => {
    h.engine = makeFakeEngine(() => "engine exploded"); // 任何输入都抛错
    h.aiQueue.push('{"thought":"毒1号","targets":[1]}');

    const gameId = await startGame();
    await waitStatus(gameId, "paused");

    expect(h.games.get(gameId)!.status).toBe("paused");
    const errEvent = h.events.find((e) => e.title === "系统错误");
    expect(errEvent).toBeDefined();
    expect(String(errEvent!.content)).toContain("引擎内部异常");
  });
});

describe("暂停挂起与恢复重想", () => {
  it("AI 在飞时暂停 → 决策挂起不结算、tick 即时停稳；恢复后 AI 重新思考（prompt 含恢复参考），系统不接管", async () => {
    // decide 后不终局（finishAfterDecide=false）：观察暂停停链而非 finished 收敛
    h.engine = makeFakeEngine(() => null, false);
    h.aiHang = true; // AI 永不返回：若暂停仍等 AI，本测试将超时失败

    const gameId = await startGame();
    // 等待决策在飞（第一次 AI 调用已发出）
    const t0 = Date.now();
    while (h.aiCalls.length === 0 && Date.now() - t0 < 2000) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(h.aiCalls.length).toBe(1);

    // 暂停：HTTP 立即返回 ok；决策挂起（不结算），tick 链即时停稳
    const pauseStart = Date.now();
    const res = await gameService.control(gameId, "pause");
    expect(res.ok).toBe(true);
    expect(Date.now() - pauseStart).toBeLessThan(1000);
    await new Promise((r) => setTimeout(r, 100));

    const { registry } = await import("../service");
    const rt = registry.get(gameId)!;
    // 关键断言①：当前决策未结算（没有托管兜底接管），pending 保留待恢复
    expect(h.engine!.state.decided.length).toBe(0);
    expect(rt.pending).not.toBeNull();
    expect(rt.status).toBe("paused");
    expect(rt.timer).toBeNull();
    expect(rt.pauseWaiters.length).toBe(0); // 竞速等待者已注销，无泄漏
    expect(h.games.get(gameId)!.status).toBe("paused");

    // 恢复：AI 恢复响应，重新思考该决策点（不再是系统托管）
    h.aiHang = false;
    h.aiQueue.push('{"thought":"恢复后重新思考的结论","targets":[1]}');
    const res2 = await gameService.control(gameId, "start");
    expect(res2.ok).toBe(true);
    await waitStatus(gameId, "running");

    // 等待恢复后的第一个决策落槌（假引擎不终局，tick 会继续走，先停链防干扰）
    const t1 = Date.now();
    while (h.engine!.state.decided.length === 0 && Date.now() - t1 < 2000) {
      await new Promise((r) => setTimeout(r, 10));
    }
    await gameService.control(gameId, "pause");

    // 关键断言②：恢复后 AI 被重新询问，且注入的 prompt 含「暂停恢复参考」
    expect(h.aiCalls.length).toBeGreaterThanOrEqual(2);
    expect(h.aiCalls[1].user).toContain("暂停恢复参考");
    // 关键断言③：恢复后的首个决策由 AI 重新作出（非托管兜底）
    const resumed = h.engine!.state.decided[0]!;
    expect(resumed.thought).toBe("恢复后重新思考的结论");
    expect(resumed.targets).toEqual([1]);
    // 恢复参考只注入一次，注入后即清空
    expect(rt.suspendDraft).toBeNull();
  });
});
