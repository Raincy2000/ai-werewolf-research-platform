// 现实层仓储集成测试 —— 真实 SQLite 内存库
import { describe, it, expect, afterAll, beforeEach } from "vitest";

const ORIG_DB = process.env.DB_DIALECT;
const ORIG_PATH = process.env.SQLITE_PATH;
process.env.DB_DIALECT = "sqlite";
process.env.SQLITE_PATH = ":memory:";

afterAll(() => {
  if (ORIG_DB === undefined) delete process.env.DB_DIALECT; else process.env.DB_DIALECT = ORIG_DB;
  if (ORIG_PATH === undefined) delete process.env.SQLITE_PATH; else process.env.SQLITE_PATH = ORIG_PATH;
});

const { getDb } = await import("../../queries/connection");
const tbl = await import("../../../db/schema");
const {
  listCanonLog,
  listCanonLogFor,
  canonCoverage,
  addManualCanonEvent,
  updateCanonEvent,
  deleteCanonEvent,
  listBackfillJobs,
  reorderCanonEvents,
} = await import("./canonLogRepo");

const UID = "cccccccc-dddd-eeee-ffff-000000000000";
let A = 0;
let B = 0;

async function seed() {
  const db = getDb();
  await db.insert(tbl.users).values({
    id: UID, email: "canon@example.com", username: "现实层测试", avatar: "",
    passwordHash: "x", createdAt: new Date(),
  } as never);
  const { defaultPersonaParams, emptyPersonaProfile } = await import("../../../contracts/persona");
  const rows = await db.insert(tbl.personas).values([
    { userId: UID, name: "测试甲", source: "ai-cast", profile: emptyPersonaProfile(), params: defaultPersonaParams() },
    { userId: UID, name: "测试乙", source: "ai-cast", profile: emptyPersonaProfile(), params: defaultPersonaParams() },
  ] as never).returning({ id: tbl.personas.id });
  A = rows[0]!.id;
  B = rows[1]!.id;
}

beforeEach(async () => {
  const db = getDb();
  for (const t of [tbl.personaCanonLog, tbl.canonBackfillJobs, tbl.personas, tbl.users]) {
    await db.delete(t);
  }
  await seed();
});

describe("现实层仓储", () => {
  it("建表成功且可写入", async () => {
    const id = await addManualCanonEvent({
      personaId: A,
      aboutPersonaId: B,
      era: "845年 · 希干希纳区",
      eventText: "他从人贩子手里救了我",
      feeling: "当时我只觉得他疯了。后来才明白，那天之后我的世界就只剩下他。",
      impact: "从此追随",
    });
    expect(id).toBeGreaterThan(0);
    const items = await listCanonLog(A, B);
    expect(items.length).toBe(1);
    expect(items[0]!.eventText).toContain("救了我");
    expect(items[0]!.verification).toBe("manual");
    expect(items[0]!.origin).toBe("manual");
  });

  it("按 seq 升序排列（时间顺序）", async () => {
    for (let i = 1; i <= 3; i++) {
      await addManualCanonEvent({
        personaId: A, aboutPersonaId: B,
        era: "第" + i + "件",
        eventText: "事件" + i,
        feeling: "感受" + i,
      });
    }
    const asc = await listCanonLog(A, B);
    expect(asc.map((x) => x.seq)).toEqual([1, 2, 3]);
    const desc2 = await listCanonLog(A, B, { order: "desc" });
    expect(desc2.map((x) => x.seq)).toEqual([3, 2, 1]);
  });

  it("编辑后 origin 转为 manual", async () => {
    const id = await addManualCanonEvent({
      personaId: A, aboutPersonaId: B,
      era: "850年", eventText: "原事件", feeling: "原感受",
    });
    await updateCanonEvent(id, { eventText: "改过的事件" });
    const items = await listCanonLog(A, B);
    expect(items[0]!.eventText).toBe("改过的事件");
    expect(items[0]!.verification).toBe("manual");
  });

  it("软删除后默认列表不再返回", async () => {
    const id = await addManualCanonEvent({
      personaId: A, aboutPersonaId: B,
      era: "850年", eventText: "要删的", feeling: "x",
    });
    await deleteCanonEvent(id);
    expect((await listCanonLog(A, B)).length).toBe(0);
    expect((await listCanonLog(A, B, { includeSuperseded: true })).length).toBe(1);
  });

  it("listCanonLogFor 覆盖多对象", async () => {
    await addManualCanonEvent({ personaId: A, aboutPersonaId: B, era: "t1", eventText: "e1", feeling: "f1" });
    const C = A;
    await addManualCanonEvent({ personaId: A, aboutPersonaId: B, era: "t2", eventText: "e2", feeling: "f2" });
    const all = await listCanonLogFor(A);
    expect(all.length).toBe(2);
    expect(all.every((x) => x.personaId === A)).toBe(true);
  });

  it("覆盖统计", async () => {
    await addManualCanonEvent({ personaId: A, aboutPersonaId: B, era: "t", eventText: "e", feeling: "f" });
    const cov = await canonCoverage(UID, A);
    expect(cov.pairs).toBe(1);
    expect(cov.items).toBe(1);
  });

  it("补完任务台账可读", async () => {
    const db = getDb();
    await db.insert(tbl.canonBackfillJobs).values({
      personaId: A, aboutPersonaId: B,
      status: "done", itemCount: 5, model: "test-model", promptVersion: "canon-l1-v1",
    } as never);
    const jobs = await listBackfillJobs(UID, A);
    expect(jobs.length).toBe(1);
    expect(jobs[0]!.status).toBe("done");
    expect(jobs[0]!.itemCount).toBe(5);
  });

  it("拖动排序：按 orderedIds 写 sortOrder，非法集合拒绝", async () => {
    const id1 = await addManualCanonEvent({ personaId: A, aboutPersonaId: B, era: "t1", eventText: "e1", feeling: "f1" });
    const id2 = await addManualCanonEvent({ personaId: A, aboutPersonaId: B, era: "t2", eventText: "e2", feeling: "f2" });
    const r = await reorderCanonEvents({ personaId: A, aboutPersonaId: B, orderedIds: [id2, id1] });
    expect(r.updated).toBe(2);
    const items = await listCanonLog(A, B);
    const byId = new Map(items.map((x) => [x.id, x]));
    expect(byId.get(id2)!.sortOrder).toBe(1);
    expect(byId.get(id1)!.sortOrder).toBe(2);
    await expect(
      reorderCanonEvents({ personaId: A, aboutPersonaId: B, orderedIds: [id2] }),
    ).rejects.toThrow(/全部事件/);
  });
});
