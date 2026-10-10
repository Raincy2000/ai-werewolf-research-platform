// ============================================================
// 分析师「胜率推测」专项测试
// 1) 开局 winRateEnabled=true → 对局推进后胜率记录入库（goodPct/wolfPct/day/phase/reasons）
// 2) 非阻塞：AI 分析延迟 200ms 期间对局事件持续推进，不等分析
// 3) inFlight 去重：一次分析挂起期间多次触发只调用一次
// 4) 终局保底：对局跑到 finished 后必有最后一次终局阶段分析
// 5) poll 返回 winRate 字段，afterWinRateId 游标增量拉取（第二次只回新记录；无记录 50/50）
// 6) createGame 传 winRateEnabled 后 setup 落库包含该标记（重启恢复依据）
// 引擎用真实实现（不 mock）；决策 AI 恒失败走启发式兜底，胜率分析走 mock 文本
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AdvancedOptions, SeatAiConfig } from "../../contracts/game";
import { registry, guideCache } from "./service";

// ---------- 共享 mock 状态（vi.hoisted 保证在 mock factory 前初始化） ----------
const h = vi.hoisted(() => ({
  games: new Map<string, Record<string, unknown>>(),
  events: [] as Record<string, unknown>[],
  decisions: [] as Record<string, unknown>[],
  winrates: [] as Record<string, unknown>[], // 胜率记录（内存表，id 自增）
  aiCalls: 0,
  winRateCalls: 0,
  // 最近一次胜率分析的 prompt（验证经验指南注入/理由细则等 prompt 组装）
  lastWinRatePrompt: null as null | { system: string; user: string },
  // 首次胜率分析的 prompt（开局时刻的技能存量等断言用；后续评估会覆盖 lastWinRatePrompt）
  firstWinRatePrompt: null as null | { system: string; user: string },
  winRateText: '{"good":62,"reasons":["狼人减员，神民占优"]}',
  // 测试定制胜率调用行为（延迟/挂起）；null 则立即返回 winRateText
  winRateHook: null as null | (() => Promise<{ ok: boolean; text: string | null; latencyMs: number; error: string | null }>),
  winRateVary: true, // true 且无 hook 时每次评估返回不同胜率（胜率不变不入库机制下仍持续产生记录）
  // 玩家决策钩子：返回非 null 文本时作为该座位 AI 决策输出（白日交刀审核等剧本用）
  playerHook: null as null | ((system: string, user: string) => string | null),
}));

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
  // 返回可识别标记：验证经验指南注入胜率 prompt（共通层/版型层各有 MARKER）
  getLatestGuide: async (_userId: string, scope: string) => ({
    content: scope === "common" ? "通用指南MARKER" : "版型指南MARKER",
  }),
  insertGuideVersion: async () => {},
  listGuideScopes: async () => [],
  listGuideVersions: async () => [],
  upsertAnalysis: async () => {},
}));

vi.mock("../queries/winrates", () => ({
  insertWinRate: async (row: Record<string, unknown>) => {
    h.winrates.push({ id: h.winrates.length + 1, createdAt: new Date(), ...row });
  },
  getWinRatesAfter: async (gameId: string, afterId: number, limit = 200) =>
    h.winrates
      .filter((r) => r.gameId === gameId && (r.id as number) > afterId)
      .slice(0, limit),
  getLatestWinRate: async (gameId: string) =>
    h.winrates.filter((r) => r.gameId === gameId).slice(-1)[0] ?? null,
}));

vi.mock("./ai/providers", () => ({
  // 胜率分析调用（system 含「实时评估」标识）返回可控文本；其余（玩家决策）恒失败 → 启发式兜底
  callAi: async (_cfg: unknown, system: string, user: string) => {
    if (typeof system === "string" && system.includes("实时评估「神民阵营」的胜率")) {
      h.winRateCalls += 1;
      h.lastWinRatePrompt = { system, user };
      if (!h.firstWinRatePrompt) h.firstWinRatePrompt = { system, user };
      if (h.winRateHook) return h.winRateHook();
      if (h.winRateVary) {
        // 默认每次评估给出不同胜率（55-84 循环）：胜率不变不入库的机制下仍能持续产生记录
        const good = 55 + (h.winRateCalls % 30);
        return { ok: true, text: `{"good":${good},"reasons":["局势推进，胜率微调至${good}"]}`, latencyMs: 1, error: null };
      }
      return { ok: true, text: h.winRateText, latencyMs: 1, error: null };
    }
    h.aiCalls += 1;
    const scripted = h.playerHook?.(system, user);
    if (scripted != null) return { ok: true, text: scripted, latencyMs: 1, error: null };
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const decisionsOf = (gameId: string) => h.decisions.filter((d) => d.gameId === gameId);
const winratesOf = (gameId: string) => h.winrates.filter((r) => r.gameId === gameId);

/** 停链清理：暂停 + 等 tick 停稳 + 等在飞胜率分析落地（归属对局需传 userId 通过归属校验） */
async function stopGame(gameId: string, userId?: string) {
  const { gameService } = await import("./service");
  await gameService.control(gameId, "pause", userId);
  const rt = registry.get(gameId);
  if (rt) await waitFor(() => !rt.ticking, "tick 链停稳");
}

beforeEach(() => {
  h.games.clear();
  h.events.length = 0;
  h.decisions.length = 0;
  h.winrates.length = 0;
  h.aiCalls = 0;
  h.winRateCalls = 0;
  h.lastWinRatePrompt = null;
  h.firstWinRatePrompt = null;
  h.winRateText = '{"good":62,"reasons":["狼人减员，神民占优"]}';
  h.winRateVary = true;
  h.winRateHook = null;
  h.playerHook = null;
  registry.clear();
  guideCache.clear(); // 模块级 60s 缓存跨测试存活：清零保证每个测试的指南注入都落到 mock
});

describe("分析师胜率推测", () => {
  it("开启后胜率记录入库：goodPct=62 / wolfPct=38 / day / phase / reasons 正确", async () => {
    h.winRateVary = false; // 固定 62 文本：断言首条记录字段
    const { gameService } = await import("./service");
    const { gameId } = await gameService.createGame({
      boardId: "standard12",
      seats: makeSeats(12),
      options: OPTS,
      winRateEnabled: true,
    });
    await gameService.control(gameId, "start");

    await waitFor(() => winratesOf(gameId).length >= 1, "胜率记录入库");
    await stopGame(gameId);

    const rec = winratesOf(gameId)[0];
    expect(rec.goodPct).toBe(62);
    expect(rec.wolfPct).toBe(38);
    expect(rec.day as number).toBeGreaterThanOrEqual(1);
    expect(typeof rec.phase).toBe("string");
    expect((rec.phase as string).length).toBeGreaterThan(0);
    expect(rec.reasons).toEqual(["狼人减员，神民占优"]);
  }, 60_000);

  it("胜率与上次相同 → 该次评估不落库（理由列表只呈现胜率实际变化的记录）", async () => {
    h.winRateVary = false; // 固定 62：每次评估结果相同
    const { gameService } = await import("./service");
    const { gameId } = await gameService.createGame({
      boardId: "standard12",
      seats: makeSeats(12),
      options: OPTS,
      winRateEnabled: true,
    });
    await gameService.control(gameId, "start");

    await waitFor(() => winratesOf(gameId).length >= 1, "首条胜率记录入库");
    // 分析多次触发（对局持续推进），但胜率判断不变 → 记录数恒为 1
    await waitFor(() => h.winRateCalls >= 3, "胜率分析多次触发", 30_000);
    await stopGame(gameId);
    expect(winratesOf(gameId).length).toBe(1);
  }, 60_000);

  it("未开启的对局不产生胜率记录", async () => {
    const { gameService } = await import("./service");
    const { gameId } = await gameService.createGame({
      boardId: "standard12",
      seats: makeSeats(12),
      options: OPTS,
      // winRateEnabled 缺省 = 关闭
    });
    await gameService.control(gameId, "start");
    await waitFor(() => decisionsOf(gameId).length >= 3, "对局推进");
    await stopGame(gameId);
    expect(winratesOf(gameId).length).toBe(0);
    expect(h.winRateCalls).toBe(0);
  }, 60_000);

  it("非阻塞：胜率分析延迟 200ms 期间对局持续推进不等分析", async () => {
    const { gameService } = await import("./service");
    // 胜率分析固定延迟 200ms 才返回
    h.winRateHook = async () => {
      await sleep(200);
      return { ok: true, text: h.winRateText, latencyMs: 200, error: null };
    };
    const { gameId } = await gameService.createGame({
      boardId: "standard12",
      seats: makeSeats(12),
      options: OPTS,
      winRateEnabled: true,
    });
    await gameService.control(gameId, "start");
    const rt = registry.get(gameId)!;

    // 等到一次胜率分析在飞（200ms 窗口内）
    await waitFor(() => rt.winRateInFlight, "胜率分析在飞");
    const d0 = decisionsOf(gameId).length;
    // 分析未完成期间，对局决策仍在持续推进（不阻塞）
    await waitFor(() => decisionsOf(gameId).length > d0, "分析在飞期间决策继续推进", 190);
    expect(rt.winRateInFlight).toBe(true); // 此刻分析仍未完成

    await waitFor(() => winratesOf(gameId).length >= 1, "延迟分析最终落库");
    await stopGame(gameId);
  }, 60_000);

  it("inFlight 去重：分析挂起期间多次触发只调用一次", async () => {
    const { gameService } = await import("./service");
    // 胜率分析挂起，直到测试手动放行
    let release!: () => void;
    h.winRateHook = () =>
      new Promise((resolve) => {
        release = () => resolve({ ok: true, text: h.winRateText, latencyMs: 1, error: null });
      });
    const { gameId } = await gameService.createGame({
      boardId: "standard12",
      seats: makeSeats(12),
      options: OPTS,
      winRateEnabled: true,
    });
    await gameService.control(gameId, "start");

    await waitFor(() => h.winRateCalls === 1, "首次胜率分析发起");
    // 挂起期间对局持续推进（每批事件落盘都是一次触发），但分析调用绝不叠加
    await waitFor(() => decisionsOf(gameId).length >= 5, "挂起期间对局推进多批事件");
    expect(h.winRateCalls).toBe(1);

    // 放行后后续触发才再次调用
    release();
    await waitFor(() => h.winRateCalls >= 2, "放行后再次触发分析");
    await stopGame(gameId);
  }, 60_000);

  it("终局保底：跑到 finished 后必有最后一次终局阶段分析", async () => {
    const { gameService } = await import("./service");
    const { gameId } = await gameService.createGame({
      boardId: "standard12",
      seats: makeSeats(12),
      options: OPTS,
      winRateEnabled: true,
    });
    await gameService.control(gameId, "start");
    await waitFor(() => registry.get(gameId)?.status === "finished", "对局终局", 90_000);

    const rt = registry.get(gameId)!;
    const finalSnap = rt.engine.getSnapshot();
    // 等终局那次分析落地：在飞结束 + 出现一条终局阶段（day+phase 与终局快照一致）的记录
    await waitFor(
      () =>
        !rt.winRateInFlight &&
        winratesOf(gameId).some((r) => r.day === finalSnap.day && r.phase === finalSnap.phase),
      "终局胜率记录落库",
      30_000,
    );

    const records = winratesOf(gameId);
    expect(records.length).toBeGreaterThanOrEqual(1);
    // 最后一条记录即终局阶段的保底分析（终局后引擎状态不再变化）
    const last = records[records.length - 1];
    expect(last.phase).toBe(finalSnap.phase);
    expect(last.day).toBe(finalSnap.day);
    await stopGame(gameId);
  }, 120_000);

  it("poll 返回 winRate：无记录 50/50；afterWinRateId 游标只回增量", async () => {
    const { gameService } = await import("./service");
    const { gameId } = await gameService.createGame({
      boardId: "standard12",
      seats: makeSeats(12),
      options: OPTS,
      winRateEnabled: true,
    });

    // 未启动（无任何评估记录）：初始 50/50 空列表面板
    const p0 = await gameService.poll(gameId, 0, undefined, undefined, 0);
    expect(p0.winRate).toBeDefined();
    expect(p0.winRate!.goodPct).toBe(50);
    expect(p0.winRate!.wolfPct).toBe(50);
    expect(p0.winRate!.entries).toEqual([]);

    await gameService.control(gameId, "start");
    await waitFor(() => winratesOf(gameId).length >= 1, "胜率记录入库");

    // 第一次轮询：全量记录 + 最新胜率（与库中最后一条记录一致）
    const p1 = await gameService.poll(gameId, 0, undefined, undefined, 0);
    expect(p1.winRate).toBeDefined();
    expect(p1.winRate!.entries.length).toBeGreaterThan(0);
    const lastRec = winratesOf(gameId).at(-1)!;
    expect(p1.winRate!.goodPct).toBe(lastRec.goodPct as number);
    expect(p1.winRate!.wolfPct).toBe(lastRec.wolfPct as number);
    const maxId = Math.max(...p1.winRate!.entries.map((e) => e.id));

    // 等新记录入库后第二次轮询：只回 id > maxId 的增量
    await waitFor(
      () => Math.max(...winratesOf(gameId).map((r) => r.id as number)) > maxId,
      "新胜率记录入库",
    );
    const p2 = await gameService.poll(gameId, p1.snapshot!.seq, undefined, undefined, maxId);
    expect(p2.winRate).toBeDefined();
    expect(p2.winRate!.entries.length).toBeGreaterThan(0);
    expect(p2.winRate!.entries.every((e) => e.id > maxId)).toBe(true);
    expect(p2.winRate!.entries.length).toBeLessThan(winratesOf(gameId).length);

    await stopGame(gameId);
  }, 60_000);

  it("createGame 传 winRateEnabled 后 setup 落库包含该标记（恢复依据）", async () => {
    const { gameService } = await import("./service");
    const { gameId: onId } = await gameService.createGame({
      boardId: "standard12",
      seats: makeSeats(12),
      options: OPTS,
      winRateEnabled: true,
    });
    const { gameId: offId } = await gameService.createGame({
      boardId: "standard12",
      seats: makeSeats(12),
      options: OPTS,
    });

    const onSetup = h.games.get(onId)!.setup as { winRateEnabled?: boolean };
    const offSetup = h.games.get(offId)!.setup as { winRateEnabled?: boolean };
    expect(onSetup.winRateEnabled).toBe(true);
    expect(offSetup.winRateEnabled).toBe(false);
    // 内存运行时同步初始化
    expect(registry.get(onId)!.winRateEnabled).toBe(true);
    expect(registry.get(offId)!.winRateEnabled).toBe(false);
  }, 30_000);

  it("胜率 prompt 注入经验指南（共通+本版型），system 要求理由细化到行为主体", async () => {
    const { gameService } = await import("./service");
    const { gameId } = await gameService.createGame(
      {
        boardId: "standard12",
        seats: makeSeats(12),
        options: OPTS,
        winRateEnabled: true,
      },
      "guide-user", // 指南按 userId+boardId 隔离注入：归属用户才会触发指南查询
    );
    await gameService.control(gameId, "start", "guide-user");

    await waitFor(() => h.lastWinRatePrompt != null, "胜率分析 prompt 已记录");
    await stopGame(gameId, "guide-user");

    // user prompt 末尾的经验指南小节：通用指南 + 本版型指南（mock 的双层 MARKER）
    expect(h.lastWinRatePrompt!.user).toContain("通用指南MARKER");
    expect(h.lastWinRatePrompt!.user).toContain("版型指南MARKER");
    expect(h.lastWinRatePrompt!.user).toContain("经验指南（通用指南 + 本版型指南");
    // system prompt 的理由细则：必须细化到具体行为主体与动作
    expect(h.lastWinRatePrompt!.system).toContain("细化到具体的行为主体");
  }, 60_000);

  it("胜率条目锚定触发事件：triggerLabel 形如「N号角色+事件标题」，并随轮询透出", async () => {
    const { gameService } = await import("./service");
    const { gameId } = await gameService.createGame({
      boardId: "standard12",
      seats: makeSeats(12),
      options: OPTS,
      winRateEnabled: true,
    });
    await gameService.control(gameId, "start");

    // 等一条锚定到「有行为主体事件」的胜率记录（首夜事件落盘触发的评估，最近事件必有 actor）
    await waitFor(
      () =>
        winratesOf(gameId).some(
          (r) => typeof r.triggerLabel === "string" && /^\d+号/.test(r.triggerLabel as string),
        ),
      "triggerLabel 落库（N号…）",
    );
    await stopGame(gameId);

    const rec = winratesOf(gameId).find(
      (r) => typeof r.triggerLabel === "string" && /^\d+号/.test(r.triggerLabel as string),
    )!;
    // 形如「4号狼人独立思考」：座位号 + 角色名 + 事件标题（角色名与标题间无空格）
    expect(rec.triggerLabel as string).toMatch(/^\d+号\S+$/);

    // 轮询透出：entries 携带 triggerLabel
    const p = await gameService.poll(gameId, 0, undefined, undefined, 0);
    const entry = p.winRate!.entries.find((e) => e.id === rec.id);
    expect(entry).toBeDefined();
    expect(entry!.triggerLabel).toBe(rec.triggerLabel);
  }, 60_000);

  it("标签=胜率变化的直接缘由：AI 输出 causeLabel 时优先落库为 triggerLabel", async () => {
    const { gameService } = await import("./service");
    h.winRateVary = false; // 固定文本：断言标签优先采用分析师定位的缘由
    h.winRateText =
      '{"good":62,"causeLabel":"第1夜 · 3号女巫 · 毒杀5号狼人","reasons":["狼人减员，神民占优"]}';
    const { gameId } = await gameService.createGame({
      boardId: "standard12",
      seats: makeSeats(12),
      options: OPTS,
      winRateEnabled: true,
    });
    await gameService.control(gameId, "start");

    await waitFor(() => winratesOf(gameId).length >= 1, "胜率记录落库");
    await stopGame(gameId);
    // 标签采用分析师定位的「直接缘由」（时间-人物-具体事件），而非系统锚定的触发事件
    expect(winratesOf(gameId)[0]!.triggerLabel).toBe("第1夜 · 3号女巫 · 毒杀5号狼人");
  }, 60_000);

  it("parseWinRateOutput：causeLabel 解析与回退（缺失/过短/非法 → null）", async () => {
    const { parseWinRateOutput } = await import("./service");
    expect(parseWinRateOutput('{"good":62,"reasons":[]}')!.causeLabel).toBeNull();
    expect(parseWinRateOutput('{"good":62,"causeLabel":"ab"}')!.causeLabel).toBeNull();
    expect(parseWinRateOutput('{"good":62,"causeLabel":123}')!.causeLabel).toBeNull();
    expect(
      parseWinRateOutput('{"good":62,"causeLabel":"第1夜 · 3号女巫 · 毒杀5号狼人","reasons":["a"]}')!
        .causeLabel,
    ).toBe("第1夜 · 3号女巫 · 毒杀5号狼人");
  });

  it("提速适配：评估在飞期间对局又推进 → 照常锚定落库（不再判 stale 丢弃），随后 dirty 立即重评", async () => {
    const { gameService } = await import("./service");
    h.winRateVary = false;
    h.winRateText = '{"good":62,"reasons":["首评"]}';
    const { gameId } = await gameService.createGame({
      boardId: "standard12",
      seats: makeSeats(12),
      options: OPTS,
      winRateEnabled: true,
    });
    await gameService.control(gameId, "start");
    await waitFor(() => winratesOf(gameId).length >= 1, "首条胜率记录(62)");
    expect(winratesOf(gameId)[0]!.goodPct).toBe(62);

    // 挂起下一次评估（在飞期间对局持续推进产生新事件 → 该评估必然"过期"）
    let release!: () => void;
    h.winRateHook = () =>
      new Promise((resolve) => {
        release = () => resolve({ ok: true, text: '{"good":70,"reasons":["过期仍应落库"]}', latencyMs: 1, error: null });
      });
    const d0 = decisionsOf(gameId).length;
    await waitFor(() => rt_inflight(), "第二次评估在飞");
    await waitFor(() => decisionsOf(gameId).length > d0, "在飞期间对局继续推进");

    // 放行：过期评估照常落库（goodPct=70 出现在记录中——旧策略会丢弃这条）
    release();
    await waitFor(
      () => winratesOf(gameId).some((r) => r.goodPct === 70),
      "过期评估锚定落库",
      30_000,
    );
    await stopGame(gameId);

    function rt_inflight() {
      return h.winRateCalls >= 2 && registry.get(gameId)?.winRateInFlight === true;
    }
  }, 60_000);

  it("技能存量进 prompt：开局评估含女巫「解药可用、毒药可用」", async () => {
    const { gameService } = await import("./service");
    const { gameId } = await gameService.createGame({
      boardId: "standard12",
      seats: makeSeats(12),
      options: OPTS,
      winRateEnabled: true,
    });
    await gameService.control(gameId, "start");

    await waitFor(() => h.firstWinRatePrompt != null, "首次胜率分析 prompt 已记录");
    await stopGame(gameId);

    // 开局快照：女巫双药在手（引擎权威事实直接进入 playerLines）
    expect(h.firstWinRatePrompt!.user).toContain("技能存量：解药可用、毒药可用");
  }, 60_000);
});

describe("白日交刀宣布胜利审核", () => {
  const AUDIT_OPTS: AdvancedOptions = {
    stepDelayMs: 0,
    phaseBreakMs: 0,
    sheriffEnabled: true,
    allowSelfDestruct: true,
    allowSurrender: true,
    speechRoundsLimit: 1,
  };
  // 剧本：狼刀固定刀 5/6/7 号平民（不杀狼）；任意存活狼在白日主动技能批次宣布提前胜利
  const declareScript = (system: string, user: string) => {
    if (user.includes("投票落刀")) {
      const m = /第(\d+)夜/.exec(user);
      const day = m ? Number(m[1]) : 1;
      return `{"thought":"","targets":[${4 + day}]}`; // 第1夜刀5号、第2夜刀6号…
    }
    if (/座位号(9|10|11|12)号/.test(system) && user.includes("主动技能")) {
      return '{"thought":"我们赢了，直接宣布","declareVictory":true}';
    }
    return null;
  };

  // 角色洗牌固定化（flaky 根治：Math.random 洗牌时剧本的座位假设——5/6/7 为平民、9-12 有狼——
  // 约 35% 概率落空，测试间歇性失败）。stub 仅罩住 createGame 的同步洗牌段（service 内
  // shuffle 在首个 await 前执行），r=0.05 时 standard12 落位 =
  // 1女巫 2猎人 3白痴 4-7平民 8-11狼 12预言家，恰好满足剧本。
  async function createAuditedGame(input: {
    boardId: string;
    seats: SeatAiConfig[];
    options: AdvancedOptions;
    winRateEnabled?: boolean;
  }) {
    const { gameService } = await import("./service");
    const spy = vi.spyOn(Math, "random").mockReturnValue(0.05);
    try {
      return await gameService.createGame(input);
    } finally {
      spy.mockRestore();
    }
  }

  it("胜率未达 100% → 宣布无效，神民阵营取胜", async () => {
    const { gameService } = await import("./service");
    h.winRateVary = false;
    h.winRateText = '{"good":62,"reasons":["神民占优"]}'; // 狼人胜率 38%
    h.playerHook = declareScript;
    const { gameId } = await createAuditedGame({
      boardId: "standard12",
      seats: makeSeats(12),
      options: AUDIT_OPTS,
      winRateEnabled: true,
    });
    await gameService.control(gameId, "start");

    await waitFor(() => registry.get(gameId)?.status === "finished", "审核终局", 90_000);
    expect(h.games.get(gameId)?.winner).toBe("good"); // 神民阵营取胜
    expect(h.events.some((e) => e.gameId === gameId && e.title === "宣布胜利未通过审核")).toBe(true);
    await stopGame(gameId);
  }, 120_000);

  it("胜率达 100% → 审核通过，狼人阵营取胜", async () => {
    const { gameService } = await import("./service");
    h.winRateVary = false;
    h.winRateText = '{"good":0,"reasons":["狼人必胜"]}'; // 狼人胜率 100%
    h.playerHook = declareScript;
    const { gameId } = await createAuditedGame({
      boardId: "standard12",
      seats: makeSeats(12),
      options: AUDIT_OPTS,
      winRateEnabled: true,
    });
    await gameService.control(gameId, "start");

    await waitFor(() => registry.get(gameId)?.status === "finished", "狼人胜利", 90_000);
    expect(h.games.get(gameId)?.winner).toBe("wolf");
    expect(h.events.some((e) => e.gameId === gameId && e.title === "宣布胜利未通过审核")).toBe(false);
    await stopGame(gameId);
  }, 120_000);

  it("审核驳回根治回归：引擎快照落定胜者 + auditSettle 重放一致 + 补开赛后照常跑完", async () => {
    // 事故（对局 20261009001）：审核驳回走服务层旁路——引擎不知情，快照 winner 永为 null
    //（横幅「对局已手动终止」），赛后讨论/心理检查/分析报告全部不触发，决策日志形态错误
    const { gameService } = await import("./service");
    h.winRateVary = false;
    h.winRateText = '{"good":62,"reasons":["神民占优"]}';
    h.playerHook = declareScript;
    const { gameId } = await createAuditedGame({
      boardId: "standard12",
      seats: makeSeats(12),
      options: AUDIT_OPTS,
      winRateEnabled: true,
    });
    await gameService.control(gameId, "start");
    await waitFor(() => registry.get(gameId)?.status === "finished", "审核终局", 90_000);

    // ① 直播引擎快照落定胜者（此前为 null → 前端横幅「对局已手动终止」）
    expect(registry.get(gameId)!.engine.getSnapshot().winner).toBe("good");
    // ② 决策日志含 auditSettle 条目（重放原料；此前记的是 batch 待决配单条 skip）
    expect(
      h.decisions.filter((d) => d.gameId === gameId).map((d) => d.kind),
    ).toContain("auditSettle");

    // ③ 重放重建一致性：清内存补开赛后讨论（强制 postGameDiscuss 重放，覆盖 settleExternal
    // 重放分支与赛后协程续接）——赛前一页【赛后讨论】事件出现且对局正常收敛终局
    registry.delete(gameId);
    const r = await gameService.startPostGame(gameId);
    expect(r.started).toBe(true);
    await waitFor(
      () =>
        h.events.some(
          (e) => e.gameId === gameId && typeof e.phase === "string" && e.phase.startsWith("postgame"),
        ),
      "赛后讨论开始生成",
      60_000,
    );
    await waitFor(() => registry.get(gameId)?.status === "finished", "赛后跑完收敛", 90_000);
    // 重建后快照 winner 仍为 good（经 auditSettle 精确重放）
    expect(registry.get(gameId)!.engine.getSnapshot().winner).toBe("good");
    await stopGame(gameId);
  }, 150_000);

});

describe("胜率缘由去重", () => {
  it("同一缘由标签与上条相同 → 按未变化处理（不重复落库）", async () => {
    const { gameService } = await import("./service");
    h.winRateVary = false;
    h.winRateText =
      '{"good":62,"causeLabel":"第1夜 · 3号女巫 · 毒杀5号狼人","reasons":["狼人减员"]}';
    const { gameId } = await gameService.createGame({
      boardId: "standard12",
      seats: makeSeats(12),
      options: OPTS,
      winRateEnabled: true,
    });
    await gameService.control(gameId, "start");
    await waitFor(() => winratesOf(gameId).length >= 1, "首条记录落库");
    expect(winratesOf(gameId)[0]!.triggerLabel).toBe("第1夜 · 3号女巫 · 毒杀5号狼人");

    // 下一次评估：胜率不同（70）但缘由标签相同 → 去重不落库
    const calls0 = h.winRateCalls;
    h.winRateText =
      '{"good":70,"causeLabel":"第1夜 · 3号女巫 · 毒杀5号狼人","reasons":["重复缘由不应落库"]}';
    await waitFor(() => h.winRateCalls >= calls0 + 1, "第二次评估完成");
    await sleep(300);
    expect(winratesOf(gameId).length).toBe(1);
    await stopGame(gameId);
  }, 60_000);
});

describe("白日交刀审核：即时性铁律（auditDeclareVictory 直测）", () => {
  // 用户裁定：拍刀时刻的局面必须即时重评，不得把滞后记录安在当前局面（否则误判）
  // 锚点单调守门要求事件游标前进：给每个用例的对局铺一条 seq=100 的事件
  const seedEvent = (gid: string) => {
    h.events.push({
      gameId: gid, seq: 100, day: 4, phase: "day.skill", type: "action",
      actor: 2, title: "技能权衡", content: "2号权衡", thought: null, meta: null,
    });
  };
  const fakeRt = () => ({
    userId: "u1",
    boardId: "standard12",
    options: {
      stepDelayMs: 0,
      phaseBreakMs: 0,
      sheriffEnabled: true,
      allowSelfDestruct: true,
      speechRoundsLimit: 2,
    },
    seatAIs: [
      { seat: 1, provider: "kimi" as const, baseUrl: "http://test.local/v1", model: "m", apiKey: "k" },
    ],
    analystAi: null,
    winRateEnabled: true,
    winRateLastStoredSeq: 0,
    winRateDirty: false,
    engine: {
      getSnapshot: () => ({
        day: 4,
        phase: "day.skill",
        phaseLabel: "第4天 · 技能权衡",
        winner: null,
        finished: false,
        pendingSeat: null,
        pendingKind: null,
        players: [],
      }),
    },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

  it("滞后记录狼优 100% + 即时重评 62% → 驳回（不沿用滞后记录）", async () => {
    const { auditDeclareVictory } = await import("./service");
    h.winRateVary = false;
    h.winRateText = '{"good":62,"reasons":["神民已翻盘"]}'; // 即时重评的读数
    seedEvent("g-audit");
    h.winrates.push({
      id: 1, gameId: "g-audit", day: 3, phase: "day.vote",
      goodPct: 0, wolfPct: 100, reasons: ["旧读数"], triggerLabel: "滞后记录", createdAt: new Date(),
    });
    expect(await auditDeclareVictory("g-audit", fakeRt())).toBe("reject");
    // 即时评估的新读数落库（替代滞后读数）
    const last = h.winrates.filter((r) => r.gameId === "g-audit").at(-1)!;
    expect(last.goodPct).toBe(62);
  });

  it("滞后记录仅 38% 狼优 + 即时重评 100% → 放行（不被早期偏低记录拖累）", async () => {
    const { auditDeclareVictory } = await import("./service");
    h.winRateVary = false;
    h.winRateText = '{"good":0,"reasons":["狼队已必胜"]}';
    seedEvent("g-audit2");
    h.winrates.push({
      id: 1, gameId: "g-audit2", day: 3, phase: "day.vote",
      goodPct: 62, wolfPct: 38, reasons: ["旧读数"], triggerLabel: "滞后记录", createdAt: new Date(),
    });
    expect(await auditDeclareVictory("g-audit2", fakeRt())).toBe("pass");
  });

  it("即时评估不可用（解析失败）→ 回落最近记录兜底；无任何记录 → 审核不可用放行", async () => {
    const { auditDeclareVictory } = await import("./service");
    h.winRateVary = false;
    h.winRateText = "这不是 JSON"; // 解析失败 → 即时评估 skip
    seedEvent("g-audit3");
    seedEvent("g-none");
    h.winrates.push({
      id: 1, gameId: "g-audit3", day: 3, phase: "day.vote",
      goodPct: 0, wolfPct: 100, reasons: [], triggerLabel: null, createdAt: new Date(),
    });
    expect(await auditDeclareVictory("g-audit3", fakeRt())).toBe("pass"); // 兜底读旧记录 100% → 放行
    expect(await auditDeclareVictory("g-none", fakeRt())).toBe("pass"); // 无记录：审核不可用放行
  });
});
