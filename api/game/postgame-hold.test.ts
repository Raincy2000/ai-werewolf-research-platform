// ============================================================
// 赛后讨论挂起专项测试（聊天室机制：赛后讨论按座位顺序逐个单问，非批次）
// 对局分出胜负、引擎产出首个 postgameSpeak 待决时，服务层自动挂起（paused）——
// 赛后讨论不再背靠背自动生成完，而是等用户进入对局记录（前端自动 control("start")）后
// 才开始生成。断言：
// 1) 分出胜负后 status==="paused"、存在「赛后讨论待开始」系统事件、无任何赛后发言事件
// 2) control("start") 后直接由挂起的 pending 决策续跑（AI 恒失败→启发式兜底=全员 skip；
//    第一个座位弃权后其余座位仍被逐个询问（单 pending 逐个来），整轮静默即结束）
//    → 最终 status==="finished"、存在「赛后讨论结束」事件
// 引擎用真实实现（不 mock）；callAi 玩家决策恒失败走启发式兜底（mock 体系照抄 winrate.test.ts）
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AdvancedOptions, SeatAiConfig } from "../../contracts/game";
import { registry, guideCache } from "./service";

// ---------- 共享 mock 状态（vi.hoisted 保证在 mock factory 前初始化） ----------
const h = vi.hoisted(() => ({
  games: new Map<string, Record<string, unknown>>(),
  events: [] as Record<string, unknown>[],
  decisions: [] as Record<string, unknown>[],
  aiCalls: 0,
  holdAi: false, // true = AI 悬挂不返回（让赛后生成停在 running，供 stopPostGame 测试）
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
  getAllLibraryContents: async () => [{ name: "狼人杀通则.md", content: "金水包括平民；警徽流要续给确认好人。" }],
  upsertStudyNote: async () => {},
  getStudyNotes: async () => [],
}));

vi.mock("./ai/providers", () => ({
  // 玩家决策恒失败 → 启发式兜底（postgameSpeak 兜底=全员 skip，一轮静默即结束）；
  // holdAi=true 时悬挂不返回（赛后生成停在 running，供 stopPostGame 测试）
  callAi: async (_cfg: unknown, system: string) => {
    h.aiCalls += 1;
    if (h.holdAi) return new Promise(() => {});
    // 赛前学习调用：返回学习心得（学习提示词含「图书馆」字样）
    if (typeof system === "string" && system.includes("图书馆")) {
      return { ok: true, text: "我学到了：金水包括平民，警徽要续给可信信息位。", latencyMs: 1, error: null };
    }
    return { ok: false, text: null, latencyMs: 1, error: "测试：AI 不可用 → 启发式兜底" };
  },
}));

// ---------- 工具 ----------
const OPTS: AdvancedOptions = {
  stepDelayMs: 0,
  phaseBreakMs: 0,
  sheriffEnabled: true,
  allowSelfDestruct: true,
  speechRoundsLimit: 1,
  postGameDiscuss: true, // 本专项：开启赛后讨论
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

async function waitFor(cond: () => boolean, label: string, timeoutMs = 25_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时：${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const eventsOf = (gameId: string) => h.events.filter((e) => e.gameId === gameId);

beforeEach(() => {
  h.games.clear();
  h.events.length = 0;
  h.decisions.length = 0;
  h.aiCalls = 0;
  h.holdAi = false;
  registry.clear();
  guideCache.clear();
});

describe("赛后讨论挂起（进房才开始生成）", () => {
  it("分出胜负后自动暂停（挂起待开始）；start 后续跑赛后讨论至终局", async () => {
    const { gameService } = await import("./service");
    const { gameId } = await gameService.createGame({
      boardId: "standard12",
      seats: makeSeats(12),
      options: OPTS,
      winRateEnabled: false, // 不开胜率，避免干扰
    });
    await gameService.control(gameId, "start");

    // 对局分出胜负 → 首个 postgameSpeak 待决处挂起：status=paused + 挂起提示事件落库
    await waitFor(
      () =>
        registry.get(gameId)?.status === "paused" &&
        eventsOf(gameId).some((e) => e.title === "赛后讨论待开始"),
      "赛后讨论挂起暂停",
      90_000,
    );

    const rt = registry.get(gameId)!;
    expect(rt.status).toBe("paused");
    expect(rt.postgameAutoHeld).toBe(true);
    // 挂起保留待决（恢复后直接决策，不 advance）
    expect(rt.pending?.kind).toBe("postgameSpeak");
    // 胜负已先行落库（赛后讨论期间报告已可生成）
    expect(h.games.get(gameId)?.winner).not.toBeNull();
    // 尚无任何赛后发言（生成等用户进房）
    expect(
      eventsOf(gameId).filter(
        (e) => (e.phase as string).startsWith("postgame") && e.type === "speech",
      ).length,
    ).toBe(0);
    // 对局未结束（postgame 环节未跑）
    expect(eventsOf(gameId).some((e) => e.title === "赛后讨论结束")).toBe(false);

    // 模拟用户进房：start 续跑 → 挂起的 postgameSpeak 单待决直接决策
    //（AI 恒失败 → 兜底全员 skip：首个座位弃权后其余座位仍被逐个询问 → 整轮静默 → 环节结束 → 对局 finished）
    await gameService.control(gameId, "start");
    await waitFor(() => registry.get(gameId)?.status === "finished", "对局终局", 60_000);

    expect(eventsOf(gameId).some((e) => e.title === "赛后讨论结束")).toBe(true);
    expect(h.games.get(gameId)?.status).toBe("finished");
    // 顺序单问：12 个座位各一条独立 postgameSpeak 决策日志（非整批一条），全部弃权
    const pgDecisions = h.decisions.filter((d) => d.gameId === gameId && d.kind === "postgameSpeak");
    expect(pgDecisions.length).toBe(12);
    expect(new Set(pgDecisions.map((d) => d.seat)).size).toBe(12);
    expect(
      pgDecisions.every((d) => (d.decision as { skip?: boolean }).skip === true),
    ).toBe(true);
  }, 180_000);

  it("未开启 postGameDiscuss 的对局不挂起：径直跑到 finished", async () => {
    const { gameService } = await import("./service");
    const { gameId } = await gameService.createGame({
      boardId: "standard12",
      seats: makeSeats(12),
      options: { ...OPTS, postGameDiscuss: false },
      winRateEnabled: false,
    });
    await gameService.control(gameId, "start");

    await waitFor(() => registry.get(gameId)?.status === "finished", "对局终局", 90_000);
    expect(eventsOf(gameId).some((e) => e.title === "赛后讨论待开始")).toBe(false);
    expect(eventsOf(gameId).some((e) => (e.phase as string).startsWith("postgame"))).toBe(false);
  }, 120_000);

  it("开启 postGameAutoStart：分出胜负后不挂起，径直生成赛后讨论至终局", async () => {
    const { gameService } = await import("./service");
    const { gameId } = await gameService.createGame({
      boardId: "standard12",
      seats: makeSeats(12),
      options: { ...OPTS, postGameAutoStart: true },
      winRateEnabled: false,
    });
    await gameService.control(gameId, "start");

    // 全程不挂起（无「赛后讨论待开始」事件），径直跑到 finished 且赛后环节完整结束
    await waitFor(() => registry.get(gameId)?.status === "finished", "径直跑到终局", 90_000);
    expect(eventsOf(gameId).some((e) => e.title === "赛后讨论待开始")).toBe(false);
    expect(eventsOf(gameId).some((e) => e.title === "赛后讨论结束")).toBe(true);
    expect(h.games.get(gameId)?.status).toBe("finished");
  }, 120_000);

  it("startPostGame 专用通道：挂起待开始的对局直接恢复生成（不占 control('start')）", async () => {
    const { gameService } = await import("./service");
    const { gameId } = await gameService.createGame({
      boardId: "standard12",
      seats: makeSeats(12),
      options: OPTS,
      winRateEnabled: false,
    });
    await gameService.control(gameId, "start");
    await waitFor(
      () =>
        registry.get(gameId)?.status === "paused" &&
        eventsOf(gameId).some((e) => e.title === "赛后讨论待开始"),
      "赛后讨论挂起暂停",
      90_000,
    );

    // 专用通道恢复（与 control('start') 继续键职责分离）
    const r = await gameService.startPostGame(gameId);
    expect(r.started).toBe(true);
    await waitFor(() => registry.get(gameId)?.status === "finished", "续跑赛后讨论至终局", 60_000);
    expect(eventsOf(gameId).some((e) => e.title === "赛后讨论结束")).toBe(true);
    expect(h.games.get(gameId)?.status).toBe("finished");
  }, 180_000);

  it("stopPostGame：赛后生成中手动终止——收敛 finished、落终止标记、胜负不受影响", async () => {
    const { gameService } = await import("./service");
    const { gameId } = await gameService.createGame({
      boardId: "standard12",
      seats: makeSeats(12),
      options: OPTS,
      winRateEnabled: false,
    });
    await gameService.control(gameId, "start");
    await waitFor(
      () =>
        registry.get(gameId)?.status === "paused" &&
        eventsOf(gameId).some((e) => e.title === "赛后讨论待开始"),
      "赛后讨论挂起暂停",
      90_000,
    );

    // AI 悬挂：赛后生成停在 running（决策点在飞），随后手动终止
    h.holdAi = true;
    const r = await gameService.startPostGame(gameId);
    expect(r.started).toBe(true);
    await waitFor(() => registry.get(gameId)?.status === "running", "赛后讨论生成中");

    const stop = await gameService.control(gameId, "stopPostGame");
    expect(stop.ok).toBe(true);
    await waitFor(() => registry.get(gameId)?.status === "finished", "终止后收敛", 15_000);

    // 终止标记落库；胜负早已落库且不受影响；赛后不再推进（无「赛后讨论结束」事件）
    expect(eventsOf(gameId).some((e) => e.title === "赛后讨论终止")).toBe(true);
    expect(h.games.get(gameId)?.winner).not.toBeNull();
    expect(eventsOf(gameId).some((e) => e.title === "赛后讨论结束")).toBe(false);
    // 非赛后阶段调用 stopPostGame 应被拒绝（终局后幂等语义外的非法调用）
    const again = await gameService.control(gameId, "stopPostGame");
    expect(again.ok).toBe(false);
  }, 180_000);
});

describe("图书馆赛前学习", () => {
  it("开启后先学习（进度透出、祖母绿学习态）→ 全部学完自动开赛", async () => {
    const { gameService } = await import("./service");
    const { gameId } = await gameService.createGame({
      boardId: "standard12",
      seats: makeSeats(12),
      options: { ...OPTS, libraryEnabled: true },
      winRateEnabled: false,
    });
    await gameService.control(gameId, "start");
    // 学习期间 status 保持 created（白天态）；全部学完自动开赛进入黑夜
    await waitFor(() => registry.get(gameId)?.status === "running", "学完自动开赛", 90_000);
    expect(registry.get(gameId)?.studyDone).toBe(true);
    // 进度透出：12/12 完成
    const p = await gameService.poll(gameId, 0);
    expect(p.study).toBeDefined();
    expect(p.study!.done).toBe(12);
    expect(p.study!.studying).toBe(false);
    await gameService.control(gameId, "pause");
  }, 120_000);
});

describe("已结束对局补开赛后讨论（startPostGame）", () => {
  it("补开全流程：poll 透出资格 → startPostGame → 直播生成至终局 → 幂等拒绝", async () => {
    const { gameService } = await import("./service");
    const { gameId } = await gameService.createGame({
      boardId: "standard12",
      seats: makeSeats(12),
      options: { ...OPTS, postGameDiscuss: false }, // 功能上线前的旧对局：无赛后讨论
      winRateEnabled: false,
    });
    await gameService.control(gameId, "start");
    await waitFor(() => registry.get(gameId)?.status === "finished", "对局终局", 90_000);

    // 旧对局：无任何赛后事件，胜负已分
    expect(eventsOf(gameId).some((e) => (e.phase as string).startsWith("postgame"))).toBe(false);
    const winner = h.games.get(gameId)?.winner;
    expect(winner).not.toBeNull();

    // 模拟服务重启（内存运行时丢失）：poll 经断点重放恢复 finished 对局，透出补开资格
    registry.clear();
    const pollRes = await gameService.poll(gameId, 0);
    expect(pollRes.postGameEligible).toBe(true);

    // 补开：强制 postGameDiscuss 重放到断点 → 引擎停在首个 postgameSpeak 单待决上，
    // 赛后开场事件（恢复补漏的缺失后缀）落盘，状态变 running 开始直播生成
    const r = await gameService.startPostGame(gameId);
    expect(r.started).toBe(true);
    expect(registry.get(gameId)?.status).toBe("running");
    expect(h.games.get(gameId)?.status).toBe("running");
    expect(eventsOf(gameId).some((e) => e.title === "赛后讨论开始")).toBe(true);

    // tick 跑完（AI 恒失败 → 托管全员 skip：逐个座位询问、整轮静默结束）→ 终局，胜负不变
    await waitFor(() => registry.get(gameId)?.status === "finished", "补开后终局", 60_000);
    expect(eventsOf(gameId).some((e) => e.title === "赛后讨论结束")).toBe(true);
    expect(h.games.get(gameId)?.status).toBe("finished");
    expect(h.games.get(gameId)?.winner).toBe(winner);
    // 顺序单问：12 个座位各一条独立 postgameSpeak 决策日志
    const pgDecisions = h.decisions.filter((d) => d.gameId === gameId && d.kind === "postgameSpeak");
    expect(pgDecisions.length).toBe(12);

    // 幂等：已有赛后内容，再次补开拒绝
    const again = await gameService.startPostGame(gameId);
    expect(again.started).toBe(false);
    expect(again.reason).toBe("赛后讨论已生成");
  }, 180_000);

  it("进行中/未分胜负的对局拒绝补开", async () => {
    const { gameService } = await import("./service");
    // 未开始（created，winner=null）→ 拒绝
    const { gameId: g1 } = await gameService.createGame({
      boardId: "standard12",
      seats: makeSeats(12),
      options: { ...OPTS, postGameDiscuss: false },
      winRateEnabled: false,
    });
    const r1 = await gameService.startPostGame(g1);
    expect(r1.started).toBe(false);
    expect(r1.reason).toBe("对局未结束或未分胜负");

    // 进行中（running）→ 拒绝；随后终止（finished 但 winner=null）→ 仍拒绝
    const { gameId: g2 } = await gameService.createGame({
      boardId: "standard12",
      seats: makeSeats(12),
      options: { ...OPTS, postGameDiscuss: false },
      winRateEnabled: false,
    });
    await gameService.control(g2, "start");
    const r2 = await gameService.startPostGame(g2);
    expect(r2.started).toBe(false);
    expect(r2.reason).toBe("对局未结束或未分胜负");
    await gameService.control(g2, "terminate");
    expect(h.games.get(g2)?.status).toBe("finished");
    expect(h.games.get(g2)?.winner ?? null).toBeNull();
    const r3 = await gameService.startPostGame(g2);
    expect(r3.started).toBe(false);
    expect(r3.reason).toBe("对局未结束或未分胜负");
  }, 60_000);

  it("zod 回归：create 路由不再剥离 options.postGameDiscuss（setup 落库含开关）", async () => {
    const { gameRouter } = await import("./router");
    const caller = gameRouter.createCaller({
      req: new Request("http://test.local/"),
      resHeaders: new Headers(),
      user: { id: "u-zod", email: "z@t.local", username: "zod", avatar: "", createdAt: new Date().toISOString() },
    });
    const { gameId } = await caller.create({
      boardId: "standard12",
      seats: makeSeats(12),
      // 路由层输入校验要求 stepDelayMs≥200（本测试不跑 tick，仅验证 setup 落库）
      options: { ...OPTS, stepDelayMs: 200, postGameDiscuss: true },
      winRateEnabled: false,
    });
    const setup = h.games.get(gameId)?.setup as { options?: Record<string, unknown> } | undefined;
    expect(setup?.options?.postGameDiscuss).toBe(true);
  }, 30_000);

  it("zod 回归：新增选项全部显式声明（libraryEnabled/postGameAutoStart/aiTimeLimitSec 等不被剥离）", async () => {
    const { gameRouter } = await import("./router");
    const caller = gameRouter.createCaller({
      req: new Request("http://test.local/"),
      resHeaders: new Headers(),
      user: { id: "u-zod2", email: "z2@t.local", username: "zod2", avatar: "", createdAt: new Date().toISOString() },
    });
    const { gameId } = await caller.create({
      boardId: "standard12",
      seats: makeSeats(12),
      options: {
        ...OPTS,
        stepDelayMs: 200,
        postGameDiscuss: true,
        postGameAutoStart: true,
        postGameSpeechLimit: 3,
        aiTimeLimitSec: 45,
        libraryEnabled: true,
        libraryMaxSec: 60,
        personaVisibility: "partial",
        personaFogSeats: [3, 5],
      },
      winRateEnabled: false,
    });
    const setup = h.games.get(gameId)?.setup as { options?: Record<string, unknown> } | undefined;
    expect(setup?.options?.postGameAutoStart).toBe(true);
    expect(setup?.options?.postGameSpeechLimit).toBe(3);
    expect(setup?.options?.aiTimeLimitSec).toBe(45);
    expect(setup?.options?.libraryEnabled).toBe(true);
    expect(setup?.options?.libraryMaxSec).toBe(60);
    // 玩家人格可见度选项不被剥离（zod 默认剥离未知键的 m1 陷阱）
    expect(setup?.options?.personaVisibility).toBe("partial");
    expect(setup?.options?.personaFogSeats).toEqual([3, 5]);
  }, 30_000);
});
