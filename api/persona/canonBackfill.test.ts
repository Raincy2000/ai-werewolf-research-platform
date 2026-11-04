// ============================================================
// canonBackfill 集成测试（内存 SQLite + mock AI 层）
// 覆盖 P0-8 毁数据防护：截断/force 不丢数据/correct 校验与 manual 保护/
// remove 二次核查/增量计划 fallback/busy/stats 落库。
// ============================================================
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const ORIG_DB = process.env.DB_DIALECT;
const ORIG_PATH = process.env.SQLITE_PATH;
process.env.DB_DIALECT = "sqlite";
process.env.SQLITE_PATH = ":memory:";
process.env.PRESET_SECRET = process.env.PRESET_SECRET || "canon-backfill-it-secret";

afterAll(() => {
  if (ORIG_DB === undefined) delete process.env.DB_DIALECT; else process.env.DB_DIALECT = ORIG_DB;
  if (ORIG_PATH === undefined) delete process.env.SQLITE_PATH; else process.env.SQLITE_PATH = ORIG_PATH;
});

const mocks = vi.hoisted(() => ({
  callWithWebSearch: vi.fn(),
  prepareWebContext: vi.fn(),
}));

vi.mock("./caster", () => ({ callWithWebSearch: mocks.callWithWebSearch }));
vi.mock("./websearch", () => ({
  prepareWebContext: mocks.prepareWebContext,
  cleanWorkName: (w: string) => String(w || "").trim(),
}));

const { getDb } = await import("../queries/connection");
const tbl = await import("../../db/schema");
const { backfillCanonLog, eraSortKey, cleanPlace, isThirdPersonMemory, needsCoverageSupplement } = await import("./canonBackfill");
const { encryptSecret } = await import("../lib/authCrypto");
const { defaultPersonaParams, emptyPersonaProfile } = await import("../../contracts/persona");

const UID = "aaaaaaaa-1111-2222-3333-444444444444";

// ---------- AI mock ----------

function enumOne(): string {
  return JSON.stringify({
    events: [
      {
        era: "845年",
        age: 9,
        place: "希干希纳区",
        event: "我杀死了两名绑匪救出三笠",
        source: "漫画第6话",
        eraBasis: "原作明载",
      },
    ],
  });
}

function feelOne(): string {
  return JSON.stringify({ items: [{ idx: 1, feeling: "我害怕但必须做到", impact: "从此她跟着我" }] });
}

function verifyPass(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    supported: true,
    fixable: false,
    confidence: "high",
    basis: "漫画第6话",
    detail: "原作中确实发生了",
    elements: {
      who: { ok: true, note: "" },
      what: { ok: true, note: "" },
      where: { ok: true, note: "" },
      when: { ok: true, note: "" },
      result: { ok: true, note: "" },
    },
    discrepancies: [],
    correctedEvent: "",
    correctedEra: "",
    correctedAge: null,
    correctedPlace: "",
    correctedEraBasis: "",
    sourceUrl: "",
    reason: "ok",
    ...over,
  });
}

function verifyFail(reason = "该事件在原作中不存在，属于 AI 编造"): string {
  return verifyPass({ supported: false, fixable: false, discrepancies: [reason], reason });
}

function removalKeep(): string {
  return JSON.stringify({ remove: false, category: "keep", confidence: "high", reason: "事件真实存在" });
}

function removalConfirm(): string {
  return JSON.stringify({ remove: true, category: "not-exist", confidence: "high", reason: "原作确实没有这段" });
}

interface AiOverrides {
  enum?: () => { text: string; truncated?: boolean; webSearched?: boolean };
  feel?: () => { text: string; truncated?: boolean };
  verify?: (user: string) => string;
  diff?: () => string | "throw" | null;
  order?: () => string;
  removal?: (user: string) => string;
  onRemovalCall?: () => void;
}

const aiCallCount = { enum: 0, feel: 0, verify: 0, diff: 0, order: 0, removal: 0 };

function installAi(o: AiOverrides = {}) {
  aiCallCount.enum = aiCallCount.feel = aiCallCount.verify = aiCallCount.diff = aiCallCount.order = aiCallCount.removal = 0;
  mocks.prepareWebContext.mockResolvedValue({ mode: "none", useBuiltin: false, evidence: "", note: "mock" });
  mocks.callWithWebSearch.mockImplementation(async (_cfg: unknown, system: string, user: string) => {
    const sys = String(system || "");
    if (sys.includes("资料检索员")) {
      aiCallCount.enum++;
      const r = o.enum?.() ?? { text: enumOne() };
      return { text: r.text, webSearched: r.webSearched ?? true, finishReason: r.truncated ? "length" : "stop", truncated: Boolean(r.truncated) };
    }
    if (sys.includes("为下面的事件清单写记忆")) {
      aiCallCount.feel++;
      const r = o.feel?.() ?? { text: feelOne() };
      return { text: r.text, webSearched: false, finishReason: r.truncated ? "length" : "stop", truncated: Boolean(r.truncated) };
    }
    if (sys.includes("事实核查员")) {
      aiCallCount.verify++;
      return { text: o.verify ? o.verify(String(user)) : verifyPass(), webSearched: false, finishReason: "stop" };
    }
    if (sys.includes("记忆整理员")) {
      aiCallCount.diff++;
      if (!o.diff) return { text: '{"ops":[]}', webSearched: false, finishReason: "stop" };
      const r = o.diff();
      if (r === "throw") throw new Error("diff endpoint down");
      if (r == null) return { text: "", webSearched: false, finishReason: "length", truncated: true };
      return { text: r, webSearched: false, finishReason: "stop" };
    }
    if (sys.includes("时间线考证员")) {
      aiCallCount.order++;
      return { text: o.order?.() ?? '{"order":[],"notes":""}', webSearched: false, finishReason: "stop" };
    }
    if (sys.includes("记忆删除复核员")) {
      aiCallCount.removal++;
      o.onRemovalCall?.();
      return { text: o.removal ? o.removal(String(user)) : removalKeep(), webSearched: false, finishReason: "stop" };
    }
    return { text: "{}", webSearched: false, finishReason: "stop" };
  });
}

// ---------- DB helpers ----------

async function resetDb() {
  const db = getDb();
  for (const t of [tbl.personaCanonLog, tbl.canonBackfillJobs, tbl.personas, tbl.apiPresets, tbl.users]) {
    try { await db.delete(t as never); } catch { /* 表可能未建 */ }
  }
}

async function insertPersona(name: string, relationships = ""): Promise<number> {
  const db = getDb();
  const profile = { ...emptyPersonaProfile(), relationships };
  const rows = await db.insert(tbl.personas).values({
    userId: UID,
    name,
    source: "manual",
    originSource: "进击的巨人",
    profile,
    params: defaultPersonaParams(),
  } as never).returning({ id: tbl.personas.id });
  return Number(rows[0]!.id);
}

async function insertCanonRow(
  personaId: number,
  aboutPersonaId: number,
  opts: { seq?: number; origin?: string; eventText: string; feeling?: string; superseded?: number },
): Promise<number> {
  const db = getDb();
  const rows = await db.insert(tbl.personaCanonLog).values({
    personaId,
    aboutPersonaId,
    seq: opts.seq ?? 1,
    era: "845年",
    age: 9,
    place: "希干希纳区",
    eventText: opts.eventText,
    feeling: opts.feeling ?? "旧感受",
    certainty: "stated",
    origin: opts.origin ?? "ai",
    superseded: opts.superseded ?? 0,
    verification: opts.origin === "manual" ? "manual" : "confirmed",
  } as never).returning({ id: tbl.personaCanonLog.id });
  return Number(rows[0]!.id);
}

async function activeCanonRows() {
  const db = getDb();
  const rows: any[] = await db.select().from(tbl.personaCanonLog);
  return rows.filter((r) => r.superseded === 0);
}

async function getJob() {
  const db = getDb();
  const rows: any[] = await db.select().from(tbl.canonBackfillJobs);
  const job = rows[0];
  if (!job) return null;
  let stats: Record<string, unknown> = {};
  try { stats = job.stats ? (JSON.parse(job.stats) as Record<string, unknown>) : {}; } catch { stats = {}; }
  return { ...job, statsParsed: stats };
}

/** 种一对人格（self=艾伦，target=三笠）+ 一个 API 存档，返回常用 id */
async function seedPair() {
  const db = getDb();
  await db.insert(tbl.users).values({
    id: UID,
    email: "canon-it@example.com",
    username: "补完测试",
    avatar: "",
    passwordHash: "x",
    createdAt: new Date(),
  } as never);
  const selfId = await insertPersona("艾伦·耶格尔", "三笠·阿克曼：青梅竹马，毕生所爱。");
  const targetId = await insertPersona("三笠·阿克曼", "艾伦·耶格尔：救命恩人。");
  const presetRows = await db.insert(tbl.apiPresets).values({
    name: "mock",
    provider: "custom",
    baseUrl: "http://mock.local",
    model: "mock-model",
    apiKey: encryptSecret("mock-key"),
    userId: UID,
  } as never).returning({ id: tbl.apiPresets.id });
  const presetId = Number(presetRows[0]!.id);
  return { selfId, targetId, presetId };
}

function argsOf(ids: { selfId: number; targetId: number; presetId: number }, over: Record<string, unknown> = {}) {
  return {
    userId: UID,
    personaId: ids.selfId,
    aboutPersonaId: ids.targetId,
    apiPresetId: ids.presetId,
    allowWeb: true,
    ...over,
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  await resetDb();
  installAi();
});

// ============================================================
// 截断检测
// ============================================================
describe("截断检测（P0-8）", () => {
  it("枚举输出 truncated → job failed、不落任何记忆、stats.truncated 落库", async () => {
    const ids = await seedPair();
    installAi({ enum: () => ({ text: '{"events":[{"era":"845年","event":"半截', truncated: true }) });
    const r = await backfillCanonLog(argsOf(ids));
    expect(r.truncated).toBe(true);
    expect(r.error).toContain("截断");
    expect(await activeCanonRows()).toHaveLength(0);
    const job = await getJob();
    expect(job?.status).toBe("failed");
    expect(job?.error).toContain("截断");
    expect(job?.statsParsed.truncated).toBe(true);
  });

  it("感受输出 truncated → job failed、旧数据保留", async () => {
    const ids = await seedPair();
    await insertCanonRow(ids.selfId, ids.targetId, { eventText: "旧记忆", seq: 1 });
    installAi({ feel: () => ({ text: '{"items":[', truncated: true }) });
    const r = await backfillCanonLog(argsOf(ids));
    expect(r.error).toContain("截断");
    const active = await activeCanonRows();
    expect(active).toHaveLength(1);
    expect(active[0]!.eventText).toBe("旧记忆");
  });
});

// ============================================================
// force：先枚举/核查成功，再软删旧 AI 行
// ============================================================
describe("force 毁数据防护（P0-8）", () => {
  it("生成失败 → 旧 AI 行与 manual 行一条不丢", async () => {
    const ids = await seedPair();
    const oldAi = await insertCanonRow(ids.selfId, ids.targetId, { eventText: "旧AI记忆", seq: 1 });
    const manual = await insertCanonRow(ids.selfId, ids.targetId, { eventText: "用户手录", origin: "manual", seq: 2 });
    installAi({ enum: () => ({ text: '{"events":[]}' }) });
    const r = await backfillCanonLog(argsOf(ids, { force: true }));
    expect(r.error).toContain("保留旧数据");
    const db = getDb();
    const rows: any[] = await db.select().from(tbl.personaCanonLog);
    const byId = new Map(rows.map((x: any) => [x.id, x]));
    expect(byId.get(oldAi)?.superseded).toBe(0);
    expect(byId.get(manual)?.superseded).toBe(0);
  });

  it("候选全部核查失败 → 旧数据一条不丢", async () => {
    const ids = await seedPair();
    const oldAi = await insertCanonRow(ids.selfId, ids.targetId, { eventText: "旧AI记忆", seq: 1 });
    installAi({ verify: () => verifyFail() });
    const r = await backfillCanonLog(argsOf(ids, { force: true }));
    expect(r.error).toContain("保留旧数据");
    const db = getDb();
    const rows: any[] = await db.select().from(tbl.personaCanonLog);
    expect(rows.find((x: any) => x.id === oldAi)?.superseded).toBe(0);
  });

  it("生成+核查成功 → 写入新行后才软删旧 AI 行，manual 永不删", async () => {
    const ids = await seedPair();
    const oldAi = await insertCanonRow(ids.selfId, ids.targetId, { eventText: "旧AI记忆", seq: 1 });
    const manual = await insertCanonRow(ids.selfId, ids.targetId, { eventText: "用户手录", origin: "manual", seq: 2 });
    installAi();
    const r = await backfillCanonLog(argsOf(ids, { force: true }));
    expect(r.error).toBeUndefined();
    expect(r.written).toBe(1);
    expect(r.forceRemoved).toBe(1);
    const db = getDb();
    const rows: any[] = await db.select().from(tbl.personaCanonLog);
    const byId = new Map(rows.map((x: any) => [x.id, x]));
    expect(byId.get(oldAi)?.superseded).toBe(1);
    expect(byId.get(manual)?.superseded).toBe(0);
    expect(byId.get(manual)?.origin).toBe("manual");
    const active = rows.filter((x: any) => x.superseded === 0);
    expect(active).toHaveLength(2); // 新 AI 行 + manual
    const job = await getJob();
    expect(job?.itemCount).toBe(2);
  });

  it("force 清理所有旧 AI active 行（含历史重复行），manual 保留", async () => {
    const ids = await seedPair();
    await insertCanonRow(ids.selfId, ids.targetId, { eventText: "旧AI记忆1", seq: 1 });
    await insertCanonRow(ids.selfId, ids.targetId, { eventText: "旧AI记忆2", seq: 2 });
    const manual = await insertCanonRow(ids.selfId, ids.targetId, { eventText: "用户手录", origin: "manual", seq: 3 });
    installAi();
    const r = await backfillCanonLog(argsOf(ids, { force: true }));
    expect(r.error).toBeUndefined();
    expect(r.forceRemoved).toBe(2);
    const db = getDb();
    const rows: any[] = await db.select().from(tbl.personaCanonLog);
    const active = rows.filter((x: any) => x.superseded === 0);
    expect(active.some((x: any) => x.id === manual && x.origin === "manual")).toBe(true);
    expect(active.filter((x: any) => x.origin !== "manual")).toHaveLength(1);
  });
});

// ============================================================
// correct 分支：existingId 校验 / manual 保护 / origin 保留
// ============================================================
describe("correct 分支（P0-8）", () => {
  function diffCorrect(existingId: number, newEvent: string): string {
    return JSON.stringify({
      ops: [{ op: "correct", existingId, reason: "原记录时间错", item: { era: "850年", age: 15, place: "特罗斯特", event: newEvent, feeling: "新感受" } }],
    });
  }

  it("越权/幻觉 existingId（不属于当前 pair）→ 不生效", async () => {
    const ids = await seedPair();
    const row = await insertCanonRow(ids.selfId, ids.targetId, { eventText: "原事件", seq: 1 });
    installAi({ diff: () => diffCorrect(999999, "被改写的事件") });
    const r = await backfillCanonLog(argsOf(ids));
    expect(r.corrected).toBe(0);
    const db = getDb();
    const rows: any[] = await db.select().from(tbl.personaCanonLog);
    const target = rows.find((x: any) => x.id === row);
    expect(target.eventText).toBe("原事件");
    expect(target.superseded).toBe(0);
  });

  it("correct manual 行 → 拒绝修改（manual 保护）", async () => {
    const ids = await seedPair();
    const row = await insertCanonRow(ids.selfId, ids.targetId, { eventText: "用户手录事件", origin: "manual", seq: 1 });
    installAi({ diff: () => diffCorrect(row, "AI 想改写的事件") });
    const r = await backfillCanonLog(argsOf(ids));
    expect(r.corrected).toBe(0);
    const db = getDb();
    const rows: any[] = await db.select().from(tbl.personaCanonLog);
    const target = rows.find((x: any) => x.id === row);
    expect(target.eventText).toBe("用户手录事件");
    expect(target.origin).toBe("manual");
  });

  it("correct AI 行 → 生效且 origin 保留 ai（不被洗成别值）", async () => {
    const ids = await seedPair();
    const row = await insertCanonRow(ids.selfId, ids.targetId, { eventText: "原事件", seq: 1 });
    installAi({ diff: () => diffCorrect(row, "修正后的事件") });
    const r = await backfillCanonLog(argsOf(ids));
    expect(r.corrected).toBe(1);
    const db = getDb();
    const rows: any[] = await db.select().from(tbl.personaCanonLog);
    const target = rows.find((x: any) => x.id === row);
    expect(target.eventText).toBe("修正后的事件");
    expect(target.origin).toBe("ai");
    expect(target.superseded).toBe(0);
  });
});

// ============================================================
// remove 二次核查
// ============================================================
describe("remove 二次核查（P0-8）", () => {
  function diffRemove(existingId: number, reason = "not-exist 原作不存在"): string {
    return JSON.stringify({ ops: [{ op: "remove", existingId, reason }] });
  }

  it("复核未确认 → 记录保留 + stats.pendingRemovals=1", async () => {
    const ids = await seedPair();
    const row = await insertCanonRow(ids.selfId, ids.targetId, { eventText: "待删事件", seq: 1 });
    installAi({ diff: () => diffRemove(row), removal: () => removalKeep() });
    const r = await backfillCanonLog(argsOf(ids));
    expect(r.removed).toBe(0);
    expect(r.pendingRemovals).toBe(1);
    const db = getDb();
    const rows: any[] = await db.select().from(tbl.personaCanonLog);
    expect(rows.find((x: any) => x.id === row)?.superseded).toBe(0);
    const job = await getJob();
    expect(job?.statsParsed.pendingRemovals).toBe(1);
  });

  it("复核确认 → 软删 + removed=1", async () => {
    const ids = await seedPair();
    const row = await insertCanonRow(ids.selfId, ids.targetId, { eventText: "待删事件", seq: 1 });
    installAi({ diff: () => diffRemove(row), removal: () => removalConfirm() });
    const r = await backfillCanonLog(argsOf(ids));
    expect(r.removed).toBe(1);
    expect(r.pendingRemovals).toBe(0);
    const db = getDb();
    const rows: any[] = await db.select().from(tbl.personaCanonLog);
    expect(rows.find((x: any) => x.id === row)?.superseded).toBe(1);
  });

  it("manual 行 remove → 直接拒绝，不触发二次核查", async () => {
    const ids = await seedPair();
    const row = await insertCanonRow(ids.selfId, ids.targetId, { eventText: "用户手录", origin: "manual", seq: 1 });
    let removalCalled = 0;
    installAi({
      diff: () => diffRemove(row),
      removal: () => removalConfirm(),
      onRemovalCall: () => { removalCalled++; },
    });
    const r = await backfillCanonLog(argsOf(ids));
    expect(removalCalled).toBe(0);
    expect(r.removed).toBe(0);
    const db = getDb();
    const rows: any[] = await db.select().from(tbl.personaCanonLog);
    expect(rows.find((x: any) => x.id === row)?.superseded).toBe(0);
  });

  it("理由不合规（如「想写得更好」）→ 直接保留，不触发二次核查", async () => {
    const ids = await seedPair();
    const row = await insertCanonRow(ids.selfId, ids.targetId, { eventText: "待改事件", seq: 1 });
    let removalCalled = 0;
    installAi({
      diff: () => diffRemove(row, "可以写得更好"),
      onRemovalCall: () => { removalCalled++; },
    });
    const r = await backfillCanonLog(argsOf(ids));
    expect(removalCalled).toBe(0);
    expect(r.removed).toBe(0);
    expect(r.kept).toBeGreaterThanOrEqual(1);
  });
});

// ============================================================
// 增量计划失败 → 全量新增 fallback
// ============================================================
describe("增量计划失败 fallback（P0-8）", () => {
  it("计划抛错 → 真正执行全量新增（旧记录保留）", async () => {
    const ids = await seedPair();
    const old = await insertCanonRow(ids.selfId, ids.targetId, { eventText: "旧事件A", seq: 1 });
    installAi({
      // 生成 1 条新事件
      enum: () =>
        ({
          text: JSON.stringify({ events: [{ era: "850年", age: 15, place: "特罗斯特", event: "我在新事件B现场", source: "漫画第2话" }] }),
        }),
      diff: () => "throw",
    });
    const r = await backfillCanonLog(argsOf(ids));
    expect(r.error).toBeUndefined();
    expect(r.fallbackUsed).toBe(true);
    expect(r.written).toBe(1);
    const active = await activeCanonRows();
    expect(active.map((x: any) => x.eventText).sort()).toEqual(["旧事件A", "我在新事件B现场"].sort());
    expect(active.find((x: any) => x.id === old)).toBeTruthy();
  });

  it("计划输出不可解析（截断）→ 同样 fallback，不静默空跑", async () => {
    const ids = await seedPair();
    await insertCanonRow(ids.selfId, ids.targetId, { eventText: "旧事件A", seq: 1 });
    installAi({
      enum: () =>
        ({
          text: JSON.stringify({ events: [{ era: "850年", age: 15, place: "特罗斯特", event: "我在新事件B现场" }] }),
        }),
      diff: () => null,
    });
    const r = await backfillCanonLog(argsOf(ids));
    expect(r.fallbackUsed).toBe(true);
    expect(r.written).toBe(1);
    const job = await getJob();
    expect(job?.status).toBe("done");
    expect(job?.statsParsed.fallbackUsed).toBe(true);
  });
});

// ============================================================
// busy / 防抖 / 软删过滤 / stats 落库 / eraSortKey
// ============================================================
describe("任务生命周期与统计（P0-7/P1-14）", () => {
  it("同一 pair 已有 running 任务 → busy + skipped，不调用 AI", async () => {
    const ids = await seedPair();
    const db = getDb();
    await db.insert(tbl.canonBackfillJobs).values({
      personaId: ids.selfId,
      aboutPersonaId: ids.targetId,
      status: "running",
      createdAt: new Date(),
      itemCount: 0,
    } as never);
    const r = await backfillCanonLog(argsOf(ids));
    expect(r.busy).toBe(true);
    expect(r.skipped).toBe(true);
    expect(aiCallCount.enum).toBe(0);
  });

  it("done 且 60 秒内 → skipped（防连点）", async () => {
    const ids = await seedPair();
    const db = getDb();
    await db.insert(tbl.canonBackfillJobs).values({
      personaId: ids.selfId,
      aboutPersonaId: ids.targetId,
      status: "done",
      itemCount: 3,
      finishedAt: new Date(),
    } as never);
    const r = await backfillCanonLog(argsOf(ids));
    expect(r.skipped).toBe(true);
    expect(r.written).toBe(3);
    expect(aiCallCount.enum).toBe(0);
  });

  it("首次全量成功 → stats/webSearched/itemCount 落库", async () => {
    const ids = await seedPair();
    const r = await backfillCanonLog(argsOf(ids));
    expect(r.error).toBeUndefined();
    expect(r.written).toBe(1);
    expect(r.webSearched).toBe(true);
    const job = await getJob();
    expect(job?.status).toBe("done");
    expect(job?.itemCount).toBe(1);
    expect(job?.webSearched).toBe(1);
    expect(job?.statsParsed.written).toBe(1);
    expect(job?.statsParsed.generated).toBe(1);
    expect(job?.statsParsed.webSearched).toBe(true);
  });

  it("未联网时 warning 落库并随结果返回", async () => {
    const ids = await seedPair();
    installAi({ enum: () => ({ text: enumOne(), webSearched: false }) });
    const r = await backfillCanonLog(argsOf(ids, { allowWeb: false }));
    expect(r.webSearched).toBe(false);
    expect(r.webWarning).toBeTruthy();
    const job = await getJob();
    expect(job?.warning).toContain("未能联网");
    expect(job?.webSearched).toBe(0);
  });

  it("提示词强制「我」的关系认知，不是客观百科（用户 2026-10-22）", async () => {
    const ids = await seedPair();
    await backfillCanonLog(argsOf(ids));
    const calls = mocks.callWithWebSearch.mock.calls as unknown as Array<[unknown, string, string]>;
    const enumCall = calls.find((c) => String(c[1]).includes("资料检索员"));
    expect(enumCall).toBeTruthy();
    expect(String(enumCall![1])).toContain("禁止百科式编年史");
    expect(String(enumCall![1])).toContain("我当时怎么理解这件事");
    expect(String(enumCall![1])).toContain("走马灯/冥界/死后世界");
    expect(String(enumCall![1])).toContain("官方续作/外传/剧场版");
    expect(String(enumCall![2])).toContain("你的人格底色");
    const feelCall = calls.find((c) => String(c[1]).includes("为下面的事件清单写记忆"));
    expect(feelCall).toBeTruthy();
    expect(String(feelCall![1])).toContain("禁止客观旁白");
    expect(String(feelCall![1])).toContain("禁止以「他/她/TA」或主角本名开头");
  });

  it("人格已软删 → 拒绝补完", async () => {
    const ids = await seedPair();
    const db = getDb();
    const { eq } = await import("drizzle-orm");
    await db.update(tbl.personas).set({ deletedAt: new Date() } as never).where(eq(tbl.personas.id, ids.selfId));
    const r = await backfillCanonLog(argsOf(ids));
    expect(r.error).toContain("人格不存在");
  });
});

describe("第一人称视角拦截（2026-10-23）", () => {
  it("第三人称事件/旁白会被判定", () => {
    expect(isThirdPersonMemory("五条悟在涩谷见到被羂索占据的夏油杰遗体", "五条悟")).toBe(true);
    expect(isThirdPersonMemory("他看见那张脸时停了一下——就那一下。", "夏油杰")).toBe(true);
    expect(isThirdPersonMemory("对新生活与同伴抱有期待，尚未预见日后的分裂", "夏油杰")).toBe(true);
  });

  it("第一人称记忆不会被误杀", () => {
    expect(isThirdPersonMemory("我在涩谷看见那张脸，明知眼睛不对还是停了一瞬。", "五条悟")).toBe(false);
    expect(isThirdPersonMemory("2006年夏天，我和杰在海边闹得像来玩。", "五条悟")).toBe(false);
    expect(isThirdPersonMemory("杰在新宿对我说「你来得真晚」，我举起了手。", "五条悟")).toBe(false);
  });

  it("缺死后/官方衍生素材时会触发补漏", () => {
    expect(needsCoverageSupplement([{ event: "我2005年进入高专，第一次见到杰", source: "漫画第65话" }])).toBe(true);
    expect(needsCoverageSupplement([
      { event: "我在走马灯里见到杰，问他满足了吗", source: "漫画第236话" },
      { event: "官方外传里我再次见到他", source: "官方外传" },
    ])).toBe(false);
  });

  it("第三人称候选会先修复为第一人称再写库", async () => {
    const ids = await seedPair();
    installAi({
      enum: () => ({
        text: JSON.stringify({
          events: [{
            era: "850年",
            age: 15,
            place: "特罗斯特",
            event: "艾伦·耶格尔杀死两名绑匪救出三笠",
            source: "漫画第6话",
          }],
        }),
      }),
    });
    const baseImpl = mocks.callWithWebSearch.getMockImplementation();
    mocks.callWithWebSearch.mockImplementation(async (cfg: unknown, system: string, user: string) => {
      if (String(system).includes("叙述视角修复师")) {
        return {
          text: JSON.stringify({
            items: [{ idx: 1, event: "我杀死两名绑匪救出三笠", feeling: "我害怕但必须做到", impact: null }],
          }),
          webSearched: false,
          finishReason: "stop",
          truncated: false,
        };
      }
      return baseImpl!(cfg, system, user);
    });
    const r = await backfillCanonLog(argsOf(ids));
    expect(r.error).toBeUndefined();
    const rows = await activeCanonRows();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((x: any) => !isThirdPersonMemory(x.eventText, "艾伦·耶格尔"))).toBe(true);
    expect(rows.every((x: any) => !isThirdPersonMemory(x.feeling, "艾伦·耶格尔"))).toBe(true);
  });
});

describe("eraSortKey / cleanPlace 快修（P0-8 P2）", () => {
  it("「年末/后/底」不再被漏判（原正则 \\str* 笔误）", () => {
    expect(eraSortKey("2005年末")).toBe("2005-13-00");
    expect(eraSortKey("2005年底")).toBe("2005-13-00");
    expect(eraSortKey("2005年后")).toBe("2005-13-00");
    expect(eraSortKey("2005年8月后")).toBe("2005-09-00");
  });

  it("排序：2005年 < 2005年8月 < 2005年末", () => {
    const eras = ["2005年末", "2005年8月", "2005年"];
    const sorted = [...eras].sort((a, b) => eraSortKey(a).localeCompare(eraSortKey(b)));
    expect(sorted).toEqual(["2005年", "2005年8月", "2005年末"]);
  });

  it("cleanPlace：占位词置空、拼接只留主地点、括号说明剔除", () => {
    expect(cleanPlace("未知")).toBeNull();
    expect(cleanPlace("")).toBeNull();
    expect(cleanPlace(null)).toBeNull();
    expect(cleanPlace("东京都及周边")).toBe("东京都");
    expect(cleanPlace("海外任务地（具体地点资料未载）")).toBe("海外任务地");
  });
});
