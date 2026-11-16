// 心理检查「手动开启 + 可续跑」专项测试（对局 20261009001 事故回归 + 新语义锁定）：
// 旧语义：终局自动触发（triggerPersonaEpilogue），依赖 rt.analystAi——未配置分析师或
// 服务重启（恢复后 analystAi 失存）即静默跳过，中断后无法补齐（该局心理检查从未发生）。
// 新语义：终局不自动跑；分出胜负后 startPsyCheck 手动开启，中断/重启后再点只补未完成座位。
// 断言：
// 1) 配置了分析师（autoGenerate）的对局终局后仍无报告（自动触发已摘除）
// 2) startPsyCheck → 记事簿回写 + 报告 + 事件齐出；poll 透出逐座位 done
// 3) 中断续跑：删掉一份报告 + 清内存（强制重放重建）→ 再开只补缺失座位（写回不重跑）
// 4) 未分出胜负拒绝开启
// 5) 认知笔记机制已下线（COGNITION_NOTE_ENABLED=false）：心理检查收尾不再触发书写、不落事件；
//    代码保留——开关置 true 即恢复原语义（自省情景开发时启用）
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
  notebookOptions: [] as { evidence?: { seq: number; visibility: string; ownerSeat: number | null }[] }[],
  anatomistOptions: [] as { evidence?: { seq: number; visibility: string; ownerSeat: number | null }[] }[],
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

// 人格研究站查询层：内存卡库 + 内存报告表
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
  // 2026-10-22：回写幂等台账（测试给「无失败座位」；续跑语义仍按报告缺失判定）
  listPersonaWritebackFailedSeats: async () => [],
  loadMemoryContext: async () => "",
  // 「记性」：开局加载记忆池，注入文本每回合按情境现算（测试给空池即可）
  loadMemoryPool: async () => ({ items: [], relationships: [] }),
  renderMemoryText: () => "",
}));

// 心理检查师与记事簿回写： mock 为即时成功（只验证编排与续跑语义，不验 AI 内容）
vi.mock("../persona/notebook", () => ({
  runNotebookWriteback: async (opts: { evidence?: { seq: number; visibility: string; ownerSeat: number | null }[] }) => {
    h.notebookCalls += 1;
    h.notebookOptions.push(opts);
    return {
      text: "回写摘要",
      memoriesAdded: 1,
      memoriesReinforced: 0,
      relationshipsTouched: 0,
      driftApplied: [],
    };
  },
}));
// 认知笔记自动书写打桩（两程管线属 cognition 单测范围；这里只验证触发编排）
const hCog = vi.hoisted(() => ({ calls: [] as { personaId: number; mode?: string }[], result: null as { content: string; readReport?: boolean } | null }));
vi.mock("../persona/cognition", () => ({
  runCognitionWrite: async (opts: { personaId: number; mode?: string }) => {
    hCog.calls.push({ personaId: opts.personaId, mode: opts.mode });
    return hCog.result;
  },
}));

vi.mock("../persona/anatomist", () => ({
  runPsyCheck: async (_cfg: unknown, opts: { evidence?: { seq: number; visibility: string; ownerSeat: number | null }[] }) => {
    h.anatomistCalls += 1;
    h.anatomistOptions.push(opts);
    return "# 心理检查报告\n（mock）";
  },
}));


// 通用自动应答（托管抹消后，测试流必须由正常 AI 输出推进）：
// 定序/退水/竞选特判；发言类按【你的任务】行判定（规则全文/契约里的「发言」字样会误中全文匹配）；
// 必须行动类取【合法目标】首座；其余 skip
function autoAnswer(user: string): string {
  if (user.includes("升序发言")) return '{"thought":"t","targets":[1]}';
  if (user.includes("退水抉择")) return '{"thought":"t","targets":[0]}';
  if (user.includes("参与竞选")) return '{"thought":"t","targets":[0]}';
  const taskLine = user.slice(user.indexOf("【你的任务】"));
  if (/发表白天发言|发表警上竞选发言|平票PK发言|发表遗言|狼人频道队内讨论|赛后讨论·聊天室/.test(taskLine)) {
    return '{"thought":"t","speech":"测试发言"}';
  }
  const needTarget = user.includes("必须行动") || (!user.includes("允许放弃") && !user.includes("可弃票"));
  if (needTarget) {
    const m = user.match(/【合法目标】([0-9]+)/);
    if (m) return `{"thought":"t","targets":[${m[1]}]}`;
  }
  return '{"thought":"t","skip":true}';
}

vi.mock("./ai/providers", () => ({
  callAi: async (_cfg: unknown, _system: string, user: string) => ({ ok: true, text: autoAnswer(user), latencyMs: 1, error: null }),
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
  h.notebookOptions.length = 0;
  h.anatomistOptions.length = 0;
  h.cards.clear();
  registry.clear();
  guideCache.clear();
  h.cards.set(101, makeCard(101, "曹操"));
  h.cards.set(102, makeCard(102, "刘备"));

  hCog.calls.length = 0;
  hCog.result = null;
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
    // 完整事实按座位分域：公共索引共享，狼频道不泄露给非狼座位。
    expect(h.notebookOptions.every((opts) => (opts.evidence?.length ?? 0) > 0)).toBe(true);
    expect(h.anatomistOptions.every((opts) => (opts.evidence?.length ?? 0) > 0)).toBe(true);
    const publicA = h.notebookOptions[0]!.evidence!.filter((e) => e.visibility === "public").map((e) => e.seq);
    const publicB = h.notebookOptions[1]!.evidence!.filter((e) => e.visibility === "public").map((e) => e.seq);
    expect(publicA).toEqual(publicB);
    const players = registry.get(gameId)!.engine.getSnapshot().players;
    for (const opts of h.notebookOptions) {
      const nonWolfSeats = players.filter((p) => p.role !== "werewolf").map((p) => p.seat);
      expect(opts.evidence!.some((e) => e.visibility === "wolfTeam" && e.ownerSeat != null && nonWolfSeats.includes(e.ownerSeat))).toBe(false);
    }
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

  it("自动心理检查：赛后讨论结束后使用对局属主身份自动开始，无需手动点击", async () => {
    const { gameService } = await import("./service");
    const ownerId = "real-owner";
    const { gameId } = await gameService.createGame({
      boardId: "standard9",
      seats: makeSeats(9),
      options: { ...OPTS, postGameDiscuss: true, postGameAutoStart: true, autoPsyCheck: true },
      seatPersonas: [
        { seat: 1, personaId: 101 },
        { seat: 2, personaId: 102 },
      ],
    }, ownerId);
    await gameService.control(gameId, "start", ownerId);
    await waitFor(() => registry.get(gameId)?.status === "finished", "赛后讨论结束", 90_000);
    // 旧实现匿名调用 startPsyCheck，被归属校验拒绝后静默吞错，这里两份报告永远不会出现。
    await waitFor(() => reportsOf(gameId).length === 2, "自动开始并生成两份心理检查", 30_000);
    expect(h.anatomistCalls).toBe(2);
    expect(eventsOf(gameId).some((e) => e.title === "赛后讨论结束")).toBe(true);
    expect(eventsOf(gameId).some((e) => e.title === "自动心理检查启动失败")).toBe(false);
    expect((await gameService.poll(gameId, 0, undefined, ownerId)).psyCheck?.seats).toEqual([
      { seat: 1, status: "done" },
      { seat: 2, status: "done" },
    ]);
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

describe("赛后自动书写认知笔记（**机制已下线**：对局侧零痕迹；代码保留待自省情景）", () => {
  async function gameToFinish(): Promise<string> {
    const { gameService } = await import("./service");
    const { gameId } = await gameService.createGame({
      boardId: "standard9",
      seats: makeSeats(9),
      options: OPTS,
      seatPersonas: [
        { seat: 1, personaId: 101 },
        { seat: 2, personaId: 102 },
      ],
    });
    await gameService.control(gameId, "start");
    await waitFor(() => registry.get(gameId)?.status === "finished", "对局结束", 90_000);
    return gameId;
  }

  it("机制下线：心理检查完成后**不**触发书写、不落任何认知笔记事件（卡上开关已无关）", async () => {
    const { gameService } = await import("./service");
    // 用 importActual 读**真实**常量（该模块被 vi.mock 拦截，直接 import 拿不到）
    const { COGNITION_NOTE_ENABLED } = await vi.importActual<
      typeof import("../persona/cognition")
    >("../persona/cognition");
    hCog.result = { content: "我这才看清自己几分。", readReport: true };
    const gameId = await gameToFinish();
    const r = await gameService.startPsyCheck(gameId, null);
    expect(r.started).toBe(true);
    // 心理检查报告本身照常生成（该机制不受影响）
    await waitFor(
      () => eventsOf(gameId).filter((e) => e.title === "心理检查报告已生成").length >= 2,
      "两座位心理检查报告已生成",
    );
    if (COGNITION_NOTE_ENABLED) {
      // 机制启用时（自省情景开发后）恢复原断言
      await waitFor(() => hCog.calls.length >= 2, "两座位自动书写触发");
      expect(hCog.calls.every((c) => c.mode === "auto")).toBe(true);
      await waitFor(
        () => eventsOf(gameId).filter((e) => e.title === "认知笔记已更新").length >= 2,
        "两篇认知笔记事件落盘",
      );
    } else {
      expect(hCog.calls.length).toBe(0);
      expect(eventsOf(gameId).filter((e) => e.title === "认知笔记已更新").length).toBe(0);
      expect(eventsOf(gameId).filter((e) => e.title === "认知笔记书写失败").length).toBe(0);
    }
  }, 120_000);

  it("显式关闭的人格不触发", async () => {
    const { gameService } = await import("./service");
    for (const id of [101, 102]) {
      const c = h.cards.get(id)!;
      h.cards.set(id, { ...c, autoCognition: { enabled: false, includeReports: false, includeDrift: false } });
    }
    const gameId = await gameToFinish();
    const r = await gameService.startPsyCheck(gameId, null);
    expect(r.started).toBe(true);
    await waitFor(
      () => eventsOf(gameId).filter((e) => e.title === "心理检查报告已生成").length >= 2,
      "两座位报告生成",
    );
    await new Promise((r2) => setTimeout(r2, 300));
    expect(hCog.calls.length).toBe(0);
  }, 120_000);
});
