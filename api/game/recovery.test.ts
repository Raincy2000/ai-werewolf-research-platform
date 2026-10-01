// ============================================================
// 断点可恢复专项测试：决策日志落盘 + 确定性重放
// 场景A：对局跑到一半「服务崩溃」（registry 清空，仅 mock DB 留存）
//   → poll 触发断点重放恢复：决策日志逐条重放，对局精确重建到断点
//   → day/phase/存活/决策计数与崩溃前一致；恢复过程不产生新决策/新事件
//   → 启动后续跑至终局：事件 seq 全局唯一、决策 idx 连续无洞
// 场景B：running 状态崩溃 → 恢复后立即自动补链续跑（无需人工 start）
// 场景C：旧对局（setup 无 seatAIs）无恢复原料 → 保持旧行为（标记 paused，仅可查看事件）
// 引擎用真实实现（不 mock）：重放正确性必须由真实状态机背书
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AdvancedOptions, SeatAiConfig } from "../../contracts/game";
import type { RoleId } from "../../contracts/game";
import { registry } from "./service";

// ---------- 共享 mock 状态（vi.hoisted 保证在 mock factory 前初始化） ----------
const h = vi.hoisted(() => ({
  games: new Map<string, Record<string, unknown>>(),
  events: [] as Record<string, unknown>[],
  decisions: [] as Record<string, unknown>[], // 决策日志（全对局共享，按 gameId 过滤）
  aiCalls: 0,
  dropNextAppend: false, // 模拟「崩溃致事件批未落盘」：下一次 appendEvents 丢弃
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
    if (h.dropNextAppend) {
      h.dropNextAppend = false;
      return; // 进程「崩溃」：这一批事件永远丢失（决策日志已落盘）
    }
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
  getLatestGuide: async () => null, // 无指南：prompt 注入空文本，不影响确定性
  insertGuideVersion: async () => {},
  listGuideScopes: async () => [],
  listGuideVersions: async () => [],
  upsertAnalysis: async () => {},
}));

vi.mock("./ai/providers", () => ({
  // AI 恒失败 → 全程启发式兜底：决策确定性（不依赖外部模型），且顺带压测兜底全类型合法性
  callAi: async () => {
    h.aiCalls += 1;
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

const STD12: RoleId[] = [
  "werewolf", "werewolf", "werewolf", "werewolf",
  "seer", "witch", "hunter", "idiot",
  "villager", "villager", "villager", "villager",
];

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

const decisionsOf = (gameId: string) => h.decisions.filter((d) => d.gameId === gameId);
const eventsOf = (gameId: string) => h.events.filter((e) => e.gameId === gameId);

beforeEach(() => {
  h.games.clear();
  h.events.length = 0;
  h.decisions.length = 0;
  h.aiCalls = 0;
  h.dropNextAppend = false;
  registry.clear();
});

describe("对局断点可恢复", () => {
  it("崩溃后断点重放恢复：状态精确重建，续跑至终局，seq/idx 连续", async () => {
    const { gameService } = await import("./service");
    const { gameId } = await gameService.createGame({
      boardId: "standard12",
      seats: makeSeats(12),
      options: OPTS,
    });
    await gameService.control(gameId, "start");

    // 跑过至少 8 个已采纳决策（覆盖夜间多类决策），然后暂停等 tick 链停稳
    await waitFor(() => decisionsOf(gameId).length >= 8, "至少 8 个决策落盘");
    await gameService.control(gameId, "pause");
    const rtBefore = registry.get(gameId)!;
    expect(rtBefore).toBeDefined();
    await waitFor(() => !rtBefore.ticking, "tick 链停稳");

    // 崩溃前快照（断点状态）
    const snapBefore = rtBefore.engine.getSnapshot();
    const before = {
      day: snapBefore.day,
      phase: snapBefore.phase,
      alive: snapBefore.players.filter((p) => p.alive).map((p) => p.seat),
      decisionIdx: rtBefore.decisionIdx,
      decisionCount: decisionsOf(gameId).length,
      eventCount: eventsOf(gameId).length,
    };
    //  sanity：内存计数器与决策日志一致（每个已采纳决策都已落盘）
    expect(before.decisionIdx).toBe(before.decisionCount);

    // 模拟服务崩溃/重启：内存注册表丢失，仅 DB（mock）留存
    registry.delete(gameId);
    expect(registry.has(gameId)).toBe(false);

    // poll 触发恢复（DB 状态为 paused → 恢复后不自动跑，待用户启动）
    const pollRes = await gameService.poll(gameId, 0);
    const rtAfter = registry.get(gameId)!;
    expect(rtAfter).toBeDefined();
    expect(pollRes.snapshot!.status).toBe("paused");

    // 精确重建断言：断点状态逐项一致
    const snapAfter = rtAfter.engine.getSnapshot();
    expect(rtAfter.decisionIdx).toBe(before.decisionIdx);
    expect(snapAfter.day).toBe(before.day);
    expect(snapAfter.phase).toBe(before.phase);
    expect(snapAfter.players.filter((p) => p.alive).map((p) => p.seat)).toEqual(before.alive);
    // 恢复过程本身不产生新决策、不产生新事件（重放是只读的）
    expect(decisionsOf(gameId).length).toBe(before.decisionCount);
    expect(eventsOf(gameId).length).toBe(before.eventCount);

    // 恢复后续跑：一路跑到终局（验证「恢复 + 继续」全链路，含兜底决策全类型合法性）
    await gameService.control(gameId, "start");
    await waitFor(() => registry.get(gameId)?.status === "finished", "对局终局", 60_000);

    // 事件 seq 全局唯一（恢复后续跑的事件从 maxSeq 续排，无重复无回退）
    const seqs = eventsOf(gameId).map((e) => e.seq as number);
    expect(new Set(seqs).size).toBe(seqs.length);
    // 决策日志 idx 从 0 连续无洞（重放顺序的可靠性依据）
    const idxs = decisionsOf(gameId)
      .map((d) => d.idx as number)
      .sort((a, b) => a - b);
    expect(idxs.length).toBeGreaterThan(before.decisionCount); // 续跑产生了新决策
    idxs.forEach((v, i) => expect(v).toBe(i));
  }, 90_000);

  it("running 状态崩溃：恢复后立即自动补链续跑（无需人工 start）", async () => {
    const { gameService } = await import("./service");
    const { gameId } = await gameService.createGame({
      boardId: "standard12",
      seats: makeSeats(12),
      options: OPTS,
    });
    await gameService.control(gameId, "start");
    await waitFor(() => decisionsOf(gameId).length >= 5, "至少 5 个决策落盘");

    // 不暂停直接模拟崩溃：DB 状态仍是 running（旧 timer 因 registry 查无此局自然空转消亡）
    registry.delete(gameId);
    const n = decisionsOf(gameId).length;

    // poll 触发恢复：running → doRecoverGame 内 scheduleTick 自动补链
    await gameService.poll(gameId, 0);
    expect(registry.get(gameId)).toBeDefined();

    // 决策数继续增长（对局自己跑起来了）
    await waitFor(() => decisionsOf(gameId).length > n, "恢复后自动续跑");

    await gameService.control(gameId, "pause"); // 清理：停链
    const rt = registry.get(gameId)!;
    await waitFor(() => !rt.ticking, "tick 链停稳");
  }, 60_000);

  it("旧对局（setup 无 seatAIs）不可恢复：poll 标记 paused，事件仍可查看", async () => {
    const { gameService } = await import("./service");
    const id = "legacy-game-no-seat-ais";
    h.games.set(id, {
      id,
      boardId: "standard12",
      boardName: "标准 12 人场",
      status: "running",
      playerCount: 12,
      dayCount: 3,
      winner: null,
      setup: { seatRoles: STD12, seatModels: [], options: OPTS }, // 无 seatAIs：无恢复原料
      createdAt: new Date(),
    });
    h.events.push({
      gameId: id,
      seq: 1,
      day: 1,
      phase: "system",
      type: "system",
      actor: null,
      actorLabel: null,
      title: "历史事件",
      content: "崩溃前的事件流水",
      thought: null,
      meta: null,
    });

    const res = await gameService.poll(id, 0);

    // 不建 runtime、不自动跑；DB 状态收敛为 paused；历史事件完整可见
    expect(registry.has(id)).toBe(false);
    expect(h.games.get(id)!.status).toBe("paused");
    expect(res.snapshot!.status).toBe("paused");
    expect(res.snapshot!.phaseLabel).toContain("中断");
    expect(res.events.length).toBe(1);
  }, 30_000);

  it("崩溃窗口「决策已落盘、事件整批未落盘」：恢复补齐缺失事件且不重不漏", async () => {
    const { gameService } = await import("./service");
    const { createEngine } = await import("./engine");
    const { gameId } = await gameService.createGame({
      boardId: "standard12",
      seats: makeSeats(12),
      options: OPTS,
    });
    await gameService.control(gameId, "start");
    await waitFor(() => decisionsOf(gameId).length >= 5, "至少 5 个决策落盘");
    await gameService.control(gameId, "pause");
    const rtBefore = registry.get(gameId)!;
    await waitFor(() => !rtBefore.ticking, "tick 链停稳");

    // 用独立引擎实例重放，算出「最后一条决策的事件批」（与恢复流程同一确定性路径）。
    // 注意必须用对局落库的实际 seatRoles（createGame 可能洗过牌），不能用工位顺序的 STD12
    const actualSeatRoles = (h.games.get(gameId)!.setup as { seatRoles: RoleId[] }).seatRoles;
    const decs = decisionsOf(gameId);
    const eng = createEngine({ boardId: "standard12", seatRoles: actualSeatRoles, options: OPTS });
    let lastDrained: { day: number; phase: string; type: string; title: string; content: string }[] = [];
    for (const d of decs) {
      const adv = eng.advance();
      if (!adv.pending) break;
      lastDrained = eng.decide(d.decision as never) as typeof lastDrained;
    }
    expect(lastDrained.length).toBeGreaterThan(0);

    // sanity：事件流尾部正好是该批（暂停且 tick 停稳后，最后一批落盘事件 = 最后一条决策的事件）
    const tailBefore = eventsOf(gameId).slice(-lastDrained.length);
    expect(tailBefore.map((e) => [e.day, e.phase, e.type, e.title, e.content])).toEqual(
      lastDrained.map((e) => [e.day, e.phase, e.type, e.title, e.content]),
    );

    // 模拟崩溃：该批事件从未落盘（真实事故路径：appendDecision 后、persist 前进程死亡）
    const beforeAll = eventsOf(gameId).map((e) => [e.seq, e.day, e.phase, e.type, e.title, e.content]);
    h.events.splice(h.events.length - lastDrained.length, lastDrained.length);
    const droppedCount = lastDrained.length;
    const beforeDecisions = decisionsOf(gameId).length;
    registry.delete(gameId);

    // poll 触发恢复：断点事件补漏应把整批补齐
    await gameService.poll(gameId, 0);

    const afterAll = eventsOf(gameId);
    // 事件总数复原（缺失后缀整批补回，无重复）
    expect(afterAll.length).toBe(beforeAll.length);
    // 补回的事件内容与顺序与崩溃前完全一致（seq 从 maxSeq 续排，与崩溃前相同）
    expect(afterAll.map((e) => [e.seq, e.day, e.phase, e.type, e.title, e.content])).toEqual(beforeAll);
    // 恢复不产生新决策
    expect(decisionsOf(gameId).length).toBe(beforeDecisions);
    expect(droppedCount).toBeGreaterThan(0);

    await gameService.control(gameId, "pause"); // 清理（paused 恢复不会自动跑，幂等）
  }, 60_000);

  it("批后已追加系统事件（对局终止标记）：恢复不重复补落已完整落盘的批次", async () => {
    // 线上事故回源：aa4a1190 局终止标记紧跟在最后一条决策批后，旧版对齐只从尾部末端
    // 匹配 → 匹配失败 → 整批 8 条事件重复落盘（seq 71-78 与 62-69 完全相同）
    const { gameService } = await import("./service");
    const { gameId } = await gameService.createGame({
      boardId: "standard12",
      seats: makeSeats(12),
      options: OPTS,
    });
    await gameService.control(gameId, "start");
    await waitFor(() => decisionsOf(gameId).length >= 4, "至少 4 个决策落盘");
    await gameService.control(gameId, "pause");
    const rtBefore = registry.get(gameId)!;
    await waitFor(() => !rtBefore.ticking, "tick 链停稳");

    // 模拟「批次完整落盘 + 批后追加系统事件」（手动终止标记的真实形态）
    const maxSeq = Math.max(...eventsOf(gameId).map((e) => e.seq as number));
    const lastDay = (eventsOf(gameId).at(-1)!.day as number) ?? 1;
    h.events.push({
      gameId,
      seq: maxSeq + 1,
      day: lastDay,
      phase: "day.speech",
      type: "system",
      actor: null,
      actorLabel: null,
      title: "对局终止",
      content: "对局已被手动终止，未分胜负。",
      thought: null,
      meta: null,
    });
    const beforeAll = eventsOf(gameId).map((e) => [e.seq, e.day, e.phase, e.type, e.title, e.content]);
    registry.delete(gameId);

    await gameService.poll(gameId, 0);

    // 无任何补落、无任何重复（前缀匹配须在尾部任意位置命中完整批次）
    const afterAll = eventsOf(gameId);
    expect(afterAll.map((e) => [e.seq, e.day, e.phase, e.type, e.title, e.content])).toEqual(beforeAll);
    const seqs = afterAll.map((e) => e.seq as number);
    expect(new Set(seqs).size).toBe(seqs.length);
  }, 60_000);

  it("崩溃于日夜交界静歇窗口：恢复后交界停歇重新生效，新时段公告不丢失", async () => {
    const { gameService } = await import("./service");
    const BREAK_MS = 1500;
    const { gameId } = await gameService.createGame({
      boardId: "standard12",
      seats: makeSeats(12),
      options: { ...OPTS, phaseBreakMs: BREAK_MS },
    });
    await gameService.control(gameId, "start");

    // 等到第1夜「夜间结算」落盘：此时边界批前半已落盘，persistWithPhaseBreak 正在静歇睡眠中
    await waitFor(
      () => eventsOf(gameId).some((e) => e.day === 1 && e.phase === "night.settle"),
      "第1夜夜间结算落盘",
    );
    // 武装「下一次落盘丢弃」（静歇结束后新时段内容这批将丢失），随即模拟进程死亡
    h.dropNextAppend = true;
    registry.delete(gameId);
    // 留出孤儿 tick 走完的时间（静歇结束 → 落盘被丢弃 → 补链因 registry 查无此局消亡）
    await new Promise((r) => setTimeout(r, BREAK_MS + 400));
    // sanity：新时段内容确实没有落盘（事件丢失已发生）
    expect(eventsOf(gameId).some((e) => e.day === 1 && e.phase === "day.start")).toBe(false);

    // poll 触发恢复：补漏须经过 persistWithPhaseBreak —— 交界停歇重新生效（含睡眠）
    const t0 = Date.now();
    await gameService.poll(gameId, 0);
    const elapsed = Date.now() - t0;

    // ① 停歇恢复：恢复过程本身耗时 ≥ 静歇时长（补漏批触发了夜→日交界静歇）
    expect(elapsed).toBeGreaterThanOrEqual(BREAK_MS - 300);
    // ② 事件复原：天亮/公布夜亡公告补齐
    await waitFor(
      () => eventsOf(gameId).some((e) => e.day === 1 && e.phase === "day.start"),
      "补漏：第1天天亮公告落盘",
    );
    expect(eventsOf(gameId).some((e) => e.day === 1 && e.phase === "day.dawn")).toBe(true);
    // ③ seq 全局唯一且连续（补漏从 maxSeq 续排，无重复无回退）
    const seqs = eventsOf(gameId).map((e) => e.seq as number);
    expect(new Set(seqs).size).toBe(seqs.length);
    seqs.forEach((v, i) => expect(v).toBe(i + 1));

    await gameService.control(gameId, "pause"); // 清理：停链
    const rt = registry.get(gameId)!;
    await waitFor(() => !rt.ticking, "tick 链停稳");
  }, 60_000);
});
