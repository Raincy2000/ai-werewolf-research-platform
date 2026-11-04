// 关系网写/读收口 + 租户守卫 回归测试（2026-10-22 审计修复）
// 真实 SQLite 内存库；覆盖 P0-1/P0-5/P0-6/P1_readModel 的验收点。
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";

const ORIG_DB = process.env.DB_DIALECT;
const ORIG_PATH = process.env.SQLITE_PATH;
process.env.DB_DIALECT = "sqlite";
process.env.SQLITE_PATH = ":memory:";

afterAll(() => {
  if (ORIG_DB === undefined) delete process.env.DB_DIALECT; else process.env.DB_DIALECT = ORIG_DB;
  if (ORIG_PATH === undefined) delete process.env.SQLITE_PATH; else process.env.SQLITE_PATH = ORIG_PATH;
});

const { getDb } = await import("../queries/connection");
const tbl = await import("../../db/schema");
const wm = await import("./writeModel");
const rm = await import("./readModel");
const guards = await import("./guards");
const { defaultPersonaParams, emptyPersonaProfile } = await import("../../contracts/persona");

const U1 = "11111111-1111-1111-1111-111111111111";
const U2 = "22222222-2222-2222-2222-222222222222";
let P1 = 0, P2 = 0, P3 = 0;

async function seedUsers() {
  const db = getDb();
  await db.insert(tbl.users).values([
    { id: U1, email: "u1@x.com", username: "用户一", avatar: "", passwordHash: "x", createdAt: new Date() },
    { id: U2, email: "u2@x.com", username: "用户二", avatar: "", passwordHash: "x", createdAt: new Date() },
  ] as never);
  const rows: any[] = await db.insert(tbl.personas).values([
    { userId: U1, name: "甲", source: "manual", profile: emptyPersonaProfile(), params: defaultPersonaParams() },
    { userId: U1, name: "乙", source: "manual", profile: emptyPersonaProfile(), params: defaultPersonaParams() },
    { userId: U2, name: "丙", source: "manual", profile: emptyPersonaProfile(), params: defaultPersonaParams() },
  ] as never).returning({ id: tbl.personas.id });
  P1 = rows[0]!.id;
  P2 = rows[1]!.id;
  P3 = rows[2]!.id;
}

beforeEach(async () => {
  const db = getDb();
  for (const t of [tbl.relationDeltas, tbl.personaRelations, tbl.personaCanonLog, tbl.canonBackfillJobs, tbl.relationCompletionJobs, tbl.personas, tbl.users]) {
    await db.delete(t);
  }
  await seedUsers();
});

describe("writeModel：唯一键/台账/clamp/校正", () => {
  it("写入 clamp 0..100，并逐字段落 relation_deltas（I6）", async () => {
    const r = await wm.writeRelationRow({
      fromPersonaId: P1, toPersonaId: P2, layer: "canon", kind: "kin",
      positivity: 999, negativity: 30, trust: 70, actor: "test", originModule: "test",
    });
    expect(r.ok).toBe(true);
    expect(r.created).toBe(true);
    const db = getDb();
    const rows: any[] = await db.select().from(tbl.personaRelations);
    expect(rows.length).toBe(1);
    expect(rows[0].positivity).toBe(100);
    const deltas: any[] = await db.select().from(tbl.relationDeltas);
    expect(deltas.length).toBeGreaterThanOrEqual(3); // 至少 positivity/negativity/trust + kind
    expect(deltas.some((d) => d.param === "positivity" && d.afterValue === 100)).toBe(true);
    expect(deltas.some((d) => d.param === "kind" && d.kindAfter === "kin")).toBe(true);
  });

  it("同键重复写默认不新建 active 行（幂等，不吞悬空）", async () => {
    await wm.writeRelationRow({
      fromPersonaId: P1, toPersonaId: 0, toName: "刘备", layer: "vale", kind: "nemesis",
      positivity: 0, negativity: 70, trust: 10, actor: "test",
    });
    const again = await wm.writeRelationRow({
      fromPersonaId: P1, toPersonaId: 0, toName: "刘备", layer: "vale", kind: "nemesis",
      positivity: 0, negativity: 80, trust: 10, actor: "test", overwrite: false,
    });
    expect(again.created).toBe(false);
    // 同名悬空边只有一条；不同悬空对象可共存
    await wm.writeRelationRow({
      fromPersonaId: P1, toPersonaId: 0, toName: "关羽", layer: "vale", kind: "sworn_friend",
      positivity: 40, negativity: 0, trust: 80, actor: "test",
    });
    const db = getDb();
    const active: any[] = await db.select().from(tbl.personaRelations);
    expect(active.length).toBe(2);
    expect(new Set(active.map((r) => r.toName)).size).toBe(2);
  });

  it("correctRelation：旧行 superseded、新 active 行保留同键、台账 correctedFrom 指向旧行", async () => {
    const first = await wm.writeRelationRow({
      fromPersonaId: P1, toPersonaId: P2, layer: "canon", kind: "beloved",
      positivity: 90, negativity: 0, trust: 90, actor: "test",
    });
    const oldId = first.relationId!;
    const fixed = await wm.correctRelation({
      relationId: oldId,
      patch: { trust: 40, basis: "校正：并非完全信任" },
      actor: "test",
      evidence: ["人工复核"],
    });
    expect(fixed.ok).toBe(true);
    const db = getDb();
    const all: any[] = await db.select().from(tbl.personaRelations);
    const oldRow = all.find((r) => r.id === oldId)!;
    const newRow = all.find((r) => r.id === fixed.relationId)!;
    expect(oldRow.status).toBe("superseded");
    expect(oldRow.supersededBy).toBe(newRow.id);
    expect(newRow.status).toBe("active");
    expect(newRow.trust).toBe(40);
    const deltas: any[] = await db.select().from(tbl.relationDeltas);
    const corr = deltas.filter((d) => d.correctedFrom === oldId);
    expect(corr.length).toBeGreaterThanOrEqual(2); // trust + basis
  });

  it("applyRelationDelta：trust 缺省基线 50，应用后落台账", async () => {
    const r = await wm.applyRelationDelta({
      dyad: { fromPersonaId: P1, toPersonaId: P2 },
      layer: "vale", kind: "unspecified", param: "trust", delta: 10,
      reason: { kind: "event", gameId: "g1", evidence: ["并肩作战"] },
      actor: "test",
    });
    expect(r.ok).toBe(true);
    expect(r.applied).toBe(10);
    const db = getDb();
    const rows: any[] = await db.select().from(tbl.personaRelations);
    expect(rows[0].trust).toBe(60);
  });

  it("非有限数值被拒绝（不产生 0 值污染）", async () => {
    const r = await wm.writeRelationChange({
      dyad: { fromPersonaId: P1, toPersonaId: P2 },
      layer: "canon", kind: "kin", param: "trust", before: null, after: Number.NaN,
      reason: { kind: "manual" }, actor: "test",
    });
    expect(r.ok).toBe(false);
    const db = getDb();
    expect((await db.select().from(tbl.personaRelations)).length).toBe(0);
  });
});

describe("readModel：readDyad 只给双边；outgoingOnly=false 真正读入边", () => {
  beforeEach(async () => {
    await wm.writeRelationRow({ fromPersonaId: P1, toPersonaId: P2, layer: "canon", kind: "comrade", positivity: 40, actor: "test" });
    await wm.writeRelationRow({ fromPersonaId: P1, toPersonaId: P3, layer: "canon", kind: "nemesis", negativity: 60, actor: "test" });
    await wm.writeRelationRow({ fromPersonaId: P2, toPersonaId: P1, layer: "vale", kind: "unspecified", trust: 70, actor: "test" });
  });

  it("readDyad(a,b) 不泄露 a 对第三人的边", async () => {
    const rows = await rm.readDyad(P1, P2);
    const ids = rows.map((r) => r.toPersonaId).sort();
    expect(ids).toEqual([P1, P2].sort());
    expect(rows.every((r) => r.toPersonaId !== P3 && r.fromPersonaId !== P3)).toBe(true);
  });

  it("outgoingOnly=false 返回入边（旧实现把 vale 层丢了）", async () => {
    const rows = await rm.readRelations({ personaId: P1, outgoingOnly: false });
    expect(rows.some((r) => r.direction === "incoming" && r.fromPersonaId === P2)).toBe(true);
    expect(rows.some((r) => r.direction === "outgoing" && r.toPersonaId === P3)).toBe(true);
  });
});

describe("guards：租户归属", () => {
  it("ownedPersonaIds 只返回当前用户未软删人格", async () => {
    expect((await guards.ownedPersonaIds(U1)).sort()).toEqual([P1, P2].sort());
    expect(await guards.ownedPersonaIds(U1, [P3])).toEqual([]);
  });

  it("跨账户读写被拒绝（FORBIDDEN）", async () => {
    await expect(guards.assertOwnedPersona(U1, P3)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(guards.assertOwnedPersonas(U1, [P1, P3])).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("canon 事件 / 补完任务按双端人格与 userId 校验", async () => {
    const db = getDb();
    const [ev] = await db.insert(tbl.personaCanonLog).values({
      personaId: P3, aboutPersonaId: P3, seq: 1, era: "t", eventText: "e", feeling: "f",
    } as never).returning({ id: tbl.personaCanonLog.id });
    await expect(guards.assertOwnedCanonEvent(U1, ev!.id)).rejects.toMatchObject({ code: "FORBIDDEN" });

    const [job] = await db.insert(tbl.relationCompletionJobs).values({
      userId: U1, scope: "{}", status: "running", progress: "{}",
    } as never).returning({ id: tbl.relationCompletionJobs.id });
    await expect(guards.assertOwnedCompletionJob(U2, job!.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(guards.assertOwnedCompletionJob(U1, job!.id)).resolves.toBeUndefined();
  });
});
