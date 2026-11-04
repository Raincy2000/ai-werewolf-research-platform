// ============================================================
// weave（编织）集成测试：内存 SQLite + mock AI 层
// 覆盖 P0-7：cancel 后不写 / failed|cancelled 不被 applied 覆盖 / paused→resume /
// 同用户 running 去重 / 僵尸自愈 / 收尾 progress 保留真实计数 / 截断 / 30 分钟硬上限。
// 另覆盖 I3 对称补全（B→A 占位边，不跨账户）。
// ============================================================
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIG_DB = process.env.DB_DIALECT;
const ORIG_PATH = process.env.SQLITE_PATH;
process.env.DB_DIALECT = "sqlite";
process.env.SQLITE_PATH = ":memory:";
process.env.PRESET_SECRET = process.env.PRESET_SECRET || "weave-it-secret";

afterAll(() => {
  if (ORIG_DB === undefined) delete process.env.DB_DIALECT; else process.env.DB_DIALECT = ORIG_DB;
  if (ORIG_PATH === undefined) delete process.env.SQLITE_PATH; else process.env.SQLITE_PATH = ORIG_PATH;
});

const mocks = vi.hoisted(() => ({
  callWithWebSearch: vi.fn(),
  prepareWebContext: vi.fn(),
  backfillCanonLog: vi.fn(),
}));

vi.mock("../persona/caster", () => ({ callWithWebSearch: mocks.callWithWebSearch }));
vi.mock("../persona/websearch", () => ({
  prepareWebContext: mocks.prepareWebContext,
  cleanWorkName: (w: string) => String(w || "").trim(),
}));
vi.mock("../persona/canonBackfill", () => ({ backfillCanonLog: mocks.backfillCanonLog }));

const { getDb } = await import("../queries/connection");
const tbl = await import("../../db/schema");
const {
  createWeaveJob,
  weaveRelations,
  listCompletionJobs,
  getCompletionStatus,
  resumeCompletion,
} = await import("./weave");
const { finishJob, cancelJobRecord, isJobActive } = await import("./jobControl");
const { encryptSecret } = await import("../lib/authCrypto");
const { defaultPersonaParams, emptyPersonaProfile } = await import("../../contracts/persona");
const { eq } = await import("drizzle-orm");

const UID = "bbbbbbbb-1111-2222-3333-444444444444";
const OTHER_UID = "cccccccc-1111-2222-3333-444444444444";

// ---------- helpers ----------

async function waitFor<T>(fn: () => T | Promise<T>, timeoutMs = 4000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function relationTo(name: string): string {
  return JSON.stringify({
    relations: [
      {
        name,
        aliases: [name.split("·")[0]],
        kind: "kin",
        form: "CS",
        positivity: 70,
        negativity: 10,
        trust: 80,
        closeness: 90,
        dependence: 40,
        reciprocity: 60,
        powerBalance: 0,
        formality: 20,
        commitment: 95,
        basis: "漫画第1话",
      },
    ],
  });
}

const EMPTY_REL = JSON.stringify({ relations: [] });

interface AiBehavior {
  /** 按人格名返回文本；默认艾伦→三笠、其他人空 */
  reply?: (name: string) => { text: string; truncated?: boolean; webSearched?: boolean };
  onCall?: (name: string) => void | Promise<void>;
}

function installAi(behavior: AiBehavior = {}) {
  mocks.backfillCanonLog.mockResolvedValue({});
  mocks.prepareWebContext.mockResolvedValue({
    mode: "builtin",
    useBuiltin: true,
    evidence: "",
    note: "mock 内置联网",
  });
  mocks.callWithWebSearch.mockImplementation(async (_cfg: unknown, _system: string, user: string) => {
    const m = String(user || "").match(/人物名：「([^」]+)」/);
    const name = m?.[1] ?? "?";
    if (behavior.onCall) await behavior.onCall(name);
    const r = behavior.reply
      ? behavior.reply(name)
      : name.includes("艾伦")
        ? { text: relationTo("三笠·阿克曼"), webSearched: true }
        : { text: EMPTY_REL, webSearched: true };
    return {
      text: r.text,
      webSearched: r.webSearched ?? true,
      finishReason: r.truncated ? "length" : "stop",
      truncated: Boolean(r.truncated),
    };
  });
}

async function resetDb() {
  const db = getDb();
  for (const t of [tbl.relationCompletionItems, tbl.relationCompletionJobs, tbl.personaRelations, tbl.personas, tbl.apiPresets, tbl.users]) {
    try { await db.delete(t as never); } catch { /* 表可能未建 */ }
  }
}

async function insertUser(id: string, email: string) {
  const db = getDb();
  await db.insert(tbl.users).values({
    id,
    email,
    username: "编织测试",
    avatar: "",
    passwordHash: "x",
    createdAt: new Date(),
  } as never);
}

async function insertPersona(userId: string, name: string): Promise<number> {
  const db = getDb();
  const rows = await db.insert(tbl.personas).values({
    userId,
    name,
    source: "manual",
    originSource: "进击的巨人",
    profile: { ...emptyPersonaProfile(), relationships: "" },
    params: defaultPersonaParams(),
  } as never).returning({ id: tbl.personas.id });
  return Number(rows[0]!.id);
}

async function insertPreset(userId: string): Promise<number> {
  const db = getDb();
  const rows = await db.insert(tbl.apiPresets).values({
    name: "mock",
    provider: "custom",
    baseUrl: "http://mock.local",
    model: "mock-model",
    apiKey: encryptSecret("mock-key"),
    userId,
  } as never).returning({ id: tbl.apiPresets.id });
  return Number(rows[0]!.id);
}

/** 种 2 个人格（艾伦、三笠）+ API 存档 */
async function seed() {
  await insertUser(UID, "weave-it@example.com");
  const a = await insertPersona(UID, "艾伦·耶格尔");
  const b = await insertPersona(UID, "三笠·阿克曼");
  const presetId = await insertPreset(UID);
  return { a, b, presetId };
}

async function jobRow(jobId: number) {
  const db = getDb();
  const rows: any[] = await db.select().from(tbl.relationCompletionJobs);
  const row = rows.find((r) => Number(r.id) === jobId);
  if (!row) return null;
  let progress: Record<string, unknown> = {};
  let stats: Record<string, unknown> = {};
  try { progress = row.progress ? JSON.parse(row.progress) : {}; } catch { progress = {}; }
  try { stats = row.stats ? JSON.parse(row.stats) : {}; } catch { stats = {}; }
  return { ...row, progressParsed: progress, statsParsed: stats };
}

async function setJobStatus(jobId: number, status: string) {
  const db = getDb();
  await db.update(tbl.relationCompletionJobs).set({ status } as never)
    .where(eq(tbl.relationCompletionJobs.id, jobId));
}

beforeEach(async () => {
  vi.clearAllMocks();
  await resetDb();
  installAi();
});

afterEach(() => {
  vi.useRealTimers();
});

// ============================================================
describe("编织主流程（P0-7/P1-16/I3）", () => {
  it("写入关系 + I3 对称占位边；收尾 progress 保留真实计数（不再被 {phase:done} 覆盖）", async () => {
    const { a, b, presetId } = await seed();
    const created = await createWeaveJob({ userId: UID, personaIds: [a, b], apiPresetId: presetId });
    expect(created.reused).toBe(false);

    const r = await weaveRelations({ userId: UID, personaIds: [a, b], apiPresetId: presetId, jobId: created.jobId });
    expect(r.written).toBe(1);
    expect(r.cards).toBe(2);

    const job = await jobRow(created.jobId);
    expect(job?.status).toBe("applied");
    // ★ 修复「汇总恒 0」：progress 里必须是真实计数，而不是 {phase:"done"}
    expect(job?.progressParsed.phase).toBe("done");
    expect(job?.progressParsed.written).toBe(1);
    expect(job?.progressParsed.webSearched).toBe(2);
    expect(Array.isArray(job?.progressParsed.log)).toBe(true);
    expect(job?.progressParsed.doneIds).toEqual([a, b]);
    expect(job?.statsParsed.written).toBe(1);
    // ★ I3：B→A 占位边
    expect(job?.statsParsed.symmetry).toBe(1);
    expect(job?.statsParsed.webSearched).toBe(2);

    const db = getDb();
    const edges: any[] = await db.select().from(tbl.personaRelations);
    expect(edges).toHaveLength(2);
    const real = edges.find((e) => e.fromPersonaId === a && e.toPersonaId === b);
    const sym = edges.find((e) => e.fromPersonaId === b && e.toPersonaId === a);
    expect(real?.layer).toBe("canon");
    expect(sym?.layer).toBe("canon");
    expect(sym?.kind).toBe("unspecified");
    expect(String(sym?.basis ?? "")).toContain("对称补齐");
    expect(sym?.sourceRef).toBe("weave:" + created.jobId);
    // 台账 items 只记真实写入（对称占位不重复计）
    const items: any[] = await db.select().from(tbl.relationCompletionItems);
    expect(items).toHaveLength(1);
  });

  it("AI 输出截断 → 该卡失败不写入，job 仍 applied 且 stats.truncated=1", async () => {
    const { a, b, presetId } = await seed();
    installAi({
      reply: (name) => (name.includes("艾伦") ? { text: '{"relations":[', truncated: true } : { text: EMPTY_REL }),
    });
    const created = await createWeaveJob({ userId: UID, personaIds: [a, b], apiPresetId: presetId });
    const r = await weaveRelations({ userId: UID, personaIds: [a, b], apiPresetId: presetId, jobId: created.jobId });
    expect(r.written).toBe(0);
    expect(r.failed.some((f) => f.error.includes("截断"))).toBe(true);
    const db = getDb();
    const edges: any[] = await db.select().from(tbl.personaRelations);
    expect(edges).toHaveLength(0);
    const job = await jobRow(created.jobId);
    expect(job?.status).toBe("applied");
    expect(job?.statsParsed.truncated).toBe(1);
  });

  it("后置现实层补完队列补完双向 pair（force=true，含反向关系记忆）", async () => {
    const { a, b, presetId } = await seed();
    const created = await createWeaveJob({ userId: UID, personaIds: [a, b], apiPresetId: presetId });
    await weaveRelations({ userId: UID, personaIds: [a, b], apiPresetId: presetId, jobId: created.jobId });
    await waitFor(() => mocks.backfillCanonLog.mock.calls.length >= 2);
    expect(mocks.backfillCanonLog).toHaveBeenCalledTimes(2);
    const args = mocks.backfillCanonLog.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(args.some((x) => x.personaId === a && x.aboutPersonaId === b && x.force === true)).toBe(true);
    expect(args.some((x) => x.personaId === b && x.aboutPersonaId === a && x.force === true)).toBe(true);
    // 生命周期：applied 必须晚于后置补完队列，不能提前把“完成”抛给 UI
    const job = await jobRow(created.jobId);
    expect(job?.status).toBe("applied");
    const progress = JSON.parse(String(job?.progress ?? "{}")) as { backfill?: { done: number; total: number } };
    expect(progress.backfill?.done).toBe(progress.backfill?.total);
    expect(progress.backfill?.total).toBeGreaterThan(0);
  });
});

// ============================================================
describe("任务生命周期（P0-7）", () => {
  it("同用户 running job 去重：第二次 createWeaveJob 返回 reused=true 的同一 jobId", async () => {
    const { a, presetId } = await seed();
    const first = await createWeaveJob({ userId: UID, personaIds: [a], apiPresetId: presetId });
    const second = await createWeaveJob({ userId: UID, personaIds: [a], apiPresetId: presetId });
    expect(second.reused).toBe(true);
    expect(second.jobId).toBe(first.jobId);
    const db = getDb();
    const rows: any[] = await db.select().from(tbl.relationCompletionJobs);
    expect(rows).toHaveLength(1);
  });

  it("finishJob CAS：failed 不会被后来的 applied 覆盖", async () => {
    const { a, presetId } = await seed();
    const created = await createWeaveJob({ userId: UID, personaIds: [a], apiPresetId: presetId });
    expect(await finishJob(created.jobId, "failed", { finishedAt: new Date() })).toBe("failed");
    expect(await finishJob(created.jobId, "applied", { finishedAt: new Date() })).toBe("failed");
    expect((await jobRow(created.jobId))?.status).toBe("failed");
  });

  it("cancelJobRecord 后：状态恒为 cancelled，finishJob(applied) 不能翻案", async () => {
    const { a, presetId } = await seed();
    const created = await createWeaveJob({ userId: UID, personaIds: [a], apiPresetId: presetId });
    expect(await cancelJobRecord(created.jobId)).toBe(true);
    expect(await finishJob(created.jobId, "applied", { finishedAt: new Date() })).toBe("cancelled");
    expect((await jobRow(created.jobId))?.status).toBe("cancelled");
  });

  it("运行中 cancel → 真正中止 AI 调用且不再写关系（cancel 后不写）", async () => {
    const { a, b, presetId } = await seed();
    const created = await createWeaveJob({ userId: UID, personaIds: [a, b], apiPresetId: presetId });
    // AI mock：永不 resolve，但响应 abort
    mocks.callWithWebSearch.mockImplementation(
      async (_cfg: unknown, _system: string, _user: string, opts?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          const onAbort = () => {
            const err = new Error("任务已终止");
            err.name = "AbortError";
            reject(err);
          };
          if (opts?.signal?.aborted) onAbort();
          else opts?.signal?.addEventListener("abort", onAbort, { once: true });
        }),
    );
    const p = weaveRelations({ userId: UID, personaIds: [a, b], apiPresetId: presetId, jobId: created.jobId });
    await waitFor(() => isJobActive(created.jobId));
    expect(await cancelJobRecord(created.jobId)).toBe(true);
    const r = await p;
    expect(r.written).toBe(0);
    const db = getDb();
    const edges: any[] = await db.select().from(tbl.personaRelations);
    expect(edges).toHaveLength(0);
    const job = await jobRow(created.jobId);
    expect(job?.status).toBe("cancelled");
    expect((job?.progressParsed as Record<string, unknown>).phase).toBe("cancelled");
  });

  it("paused → resumeCompletion 续跑：不重复已完成人格、不打断累计计数", async () => {
    const { a, b, presetId } = await seed();
    const created = await createWeaveJob({ userId: UID, personaIds: [a, b], apiPresetId: presetId });
    const calls: string[] = [];
    installAi({ onCall: (name) => { calls.push(name); } });
    // 第二张卡进入「联网准备」时把任务置 paused → 该卡写入前被发现暂停
    let prepCalls = 0;
    mocks.prepareWebContext.mockImplementation(async () => {
      prepCalls++;
      if (prepCalls === 2) await setJobStatus(created.jobId, "paused");
      return { mode: "builtin", useBuiltin: true, evidence: "", note: "mock" };
    });
    const pausedRun = await weaveRelations({ userId: UID, personaIds: [a, b], apiPresetId: presetId, jobId: created.jobId });
    expect(pausedRun.cards).toBe(1); // 只完成了艾伦
    let job = await jobRow(created.jobId);
    expect(job?.status).toBe("paused");
    expect(job?.progressParsed.phase).toBe("paused");
    expect(job?.progressParsed.written).toBe(1);
    expect(job?.progressParsed.doneIds).toEqual([a]);

    // resume：不应再跑艾伦
    installAi({ onCall: (name) => { calls.push(name); } });
    const res = await resumeCompletion(created.jobId, UID);
    expect(res.ok).toBe(true);
    expect(res.started).toBe(true);
    await waitFor(async () => (await jobRow(created.jobId))?.status === "applied");
    job = await jobRow(created.jobId);
    expect(job?.status).toBe("applied");
    expect(job?.progressParsed.doneIds).toEqual([a, b]);
    expect(job?.progressParsed.written).toBe(1);
    // 艾伦只跑过一次（第一轮）；第二轮只跑三笠
    expect(calls.filter((n) => n.includes("艾伦"))).toHaveLength(1);
    expect(calls.filter((n) => n.includes("三笠")).length).toBeGreaterThanOrEqual(1);
  });

  it("resumeCompletion 归属校验：他人的 job 拒绝继续", async () => {
    await insertUser(OTHER_UID, "other@example.com");
    const { a, presetId } = await seed();
    const created = await createWeaveJob({ userId: UID, personaIds: [a], apiPresetId: presetId });
    await setJobStatus(created.jobId, "paused");
    const res = await resumeCompletion(created.jobId, OTHER_UID);
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain("不属于");
  });

  it("30 分钟硬上限 → abort 并置 failed（不再永远 running）", async () => {
    await insertUser(UID, "weave-it@example.com");
    const ids: number[] = [];
    for (let i = 0; i < 8; i++) ids.push(await insertPersona(UID, "测试人格" + i));
    const presetId = await insertPreset(UID);
    const created = await createWeaveJob({ userId: UID, personaIds: ids, apiPresetId: presetId });
    vi.useFakeTimers();
    // 每次 AI 调用都永不 resolve（单次 240s 超时逐卡失败，30 分钟后硬上限真正 abort）
    mocks.callWithWebSearch.mockImplementation(() => new Promise(() => { /* never */ }));
    const p = weaveRelations({ userId: UID, personaIds: ids, apiPresetId: presetId, jobId: created.jobId });
    await vi.advanceTimersByTimeAsync(30 * 60_000 + 5_000);
    const r = await p;
    vi.useRealTimers();
    expect(r.failed[0]?.error).toContain("30 分钟");
    const job = await jobRow(created.jobId);
    expect(job?.status).toBe("failed");
    expect(job?.progressParsed.phase).toBe("timeout");
  });
});

// ============================================================
describe("completionStatus / listCompletionJobs（P0-7）", () => {
  it("僵尸自愈：running 且创建超 2 小时 → 自动置 failed", async () => {
    await insertUser(UID, "weave-it@example.com");
    const db = getDb();
    const rows = await db.insert(tbl.relationCompletionJobs).values({
      userId: UID,
      scope: "{}",
      status: "running",
      createdAt: new Date(Date.now() - 3 * 60 * 60_000),
    } as never).returning({ id: tbl.relationCompletionJobs.id });
    const jobId = Number(rows[0]!.id);
    const view = await getCompletionStatus(jobId, UID);
    expect(view?.status).toBe("failed");
    expect((await jobRow(jobId))?.status).toBe("failed");
  });

  it("僵尸自愈：running 但带 finishedAt → failed", async () => {
    await insertUser(UID, "weave-it@example.com");
    const db = getDb();
    const rows = await db.insert(tbl.relationCompletionJobs).values({
      userId: UID,
      scope: "{}",
      status: "running",
      createdAt: new Date(),
      finishedAt: new Date(),
    } as never).returning({ id: tbl.relationCompletionJobs.id });
    const jobId = Number(rows[0]!.id);
    expect((await getCompletionStatus(jobId, UID))?.status).toBe("failed");
  });

  it("归属校验：他人任务返回 null", async () => {
    const { a, presetId } = await seed();
    const created = await createWeaveJob({ userId: UID, personaIds: [a], apiPresetId: presetId });
    expect(await getCompletionStatus(created.jobId, OTHER_UID)).toBeNull();
  });

  it("listCompletionJobs：只返回进行中的 pending/running/paused；完成/终止/失败不再恢复，按 createdAt 倒序、最多 20 条、只返回本人", async () => {
    await insertUser(UID, "weave-it@example.com");
    await insertUser(OTHER_UID, "other@example.com");
    const db = getDb();
    const active = ["pending", "running", "paused"];
    for (let i = 0; i < 25; i++) {
      await db.insert(tbl.relationCompletionJobs).values({
        userId: UID,
        scope: "{}",
        status: active[i % active.length],
        createdAt: new Date(Date.now() - i * 1000),
      } as never);
    }
    // 已完成/已终止/失败的任务不得再出现在“生成进度”里
    for (const status of ["applied", "cancelled", "failed"]) {
      await db.insert(tbl.relationCompletionJobs).values({
        userId: UID,
        scope: "{}",
        status,
        createdAt: new Date(),
      } as never);
    }
    await db.insert(tbl.relationCompletionJobs).values({
      userId: OTHER_UID,
      scope: "{}",
      status: "running",
      createdAt: new Date(),
    } as never);
    const list = await listCompletionJobs(UID);
    expect(list).toHaveLength(20);
    expect(list.every((j) => ["pending", "running", "paused"].includes(j.status))).toBe(true);
    for (let i = 1; i < list.length; i++) {
      const prev = new Date(list[i - 1]!.createdAt as never).getTime();
      const cur = new Date(list[i]!.createdAt as never).getTime();
      expect(prev).toBeGreaterThanOrEqual(cur);
    }
  });

  it("createWeaveJob 会先收掉超 2 小时的僵尸 running 任务", async () => {
    await insertUser(UID, "weave-it@example.com");
    const db = getDb();
    const stale = await db.insert(tbl.relationCompletionJobs).values({
      userId: UID,
      scope: "{}",
      status: "running",
      createdAt: new Date(Date.now() - 3 * 60 * 60_000),
    } as never).returning({ id: tbl.relationCompletionJobs.id });
    const staleId = Number(stale[0]!.id);
    const created = await createWeaveJob({ userId: UID, personaIds: [1] });
    expect(created.reused).toBe(false);
    expect(created.jobId).not.toBe(staleId);
    expect((await jobRow(staleId))?.status).toBe("failed");
  });
});
