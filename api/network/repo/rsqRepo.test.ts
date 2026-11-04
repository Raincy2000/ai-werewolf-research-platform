// RSQ 仓储集成测试 —— 用真实 SQLite（内存库）跑通读写
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
const { RSQ_ITEMS, scoreRSQ } = await import("../../persona/rsq");
const {
  saveRSQResponse,
  getLatestRSQ,
  listRSQHistory,
  listRSQByGame,
  listLatestRSQFor,
  rsqCoverage,
} = await import("./rsqRepo");

const UID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
let A = 0;
let B = 0;

/** 构造一份答卷：全部 4 分，可覆写 */
function answers(patch: Record<number, number> = {}): Record<number, number> {
  const raw: Record<number, number> = {};
  for (const it of RSQ_ITEMS) {
    if (it.scale !== "open") raw[it.no] = 4;
  }
  return { ...raw, ...patch };
}

async function seed() {
  const db = getDb();
  await db.insert(tbl.users).values({
    id: UID, email: "rsq@example.com", username: "RSQ测试", avatar: "",
    passwordHash: "x", createdAt: new Date(),
  } as never);
  const { defaultPersonaParams, emptyPersonaProfile } = await import("../../../contracts/persona");
  const rows = await db
    .insert(tbl.personas)
    .values([
      { userId: UID, name: "测试甲", source: "ai-cast", profile: emptyPersonaProfile(), params: defaultPersonaParams() },
      { userId: UID, name: "测试乙", source: "ai-cast", profile: emptyPersonaProfile(), params: defaultPersonaParams() },
    ] as never)
    .returning({ id: tbl.personas.id });
  A = rows[0]!.id;
  B = rows[1]!.id;

  // 建一条关系行（用于验证核心维度同步）
  await db.insert(tbl.personaRelations).values({
    fromPersonaId: A,
    toPersonaId: B,
    layer: "vale",
    kind: "peer",
    form: "EM",
    originModule: "rsq-it",
    originVersion: "1.0",
    awareness: "full",
    disclosable: 1,
    status: "active",
    violationCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as never);
}

beforeEach(async () => {
  const db = getDb();
  for (const t of [tbl.rsqResponses, tbl.personaRelations, tbl.personas, tbl.users]) {
    await db.delete(t);
  }
  await seed();
});

describe("RSQ 仓储", () => {
  it("建表成功：rsq_responses 可写入且 11 个扩展列可读", async () => {
    // 直接跑一次写入 → 读回，验证表与列都存在
    const result = scoreRSQ(answers());
    const id = await saveRSQResponse({ fromPersonaId: A, toPersonaId: B, result });
    expect(id).toBeGreaterThan(0);

    // 逐列验证：用 drizzle select 触发全部列
    const db = getDb();
    const rsqRows = await db.select().from(tbl.rsqResponses);
    expect(rsqRows.length).toBe(1);
    const r = rsqRows[0]!;
    expect(r.dimensionsJson.length).toBeGreaterThan(10);
    expect(r.derivedJson.length).toBeGreaterThan(10);
    expect(r.validityJson.length).toBeGreaterThan(10);
    expect(r.rawJson.length).toBeGreaterThan(10);

    const relRows = await db.select().from(tbl.personaRelations);
    const rel = relRows[0]!;
    for (const c of [
      "rsqResponseId", "rsqAffection", "rsqAntagonism", "rsqFaith",
      "rsqCommitment", "rsqForgiveness", "rsqCloseness",
      "rsqAmbivalence", "rsqEquityBalance", "rsqVerdict", "rsqUpdatedAt",
    ] as const) {
      expect(c in rel).toBe(true);
    }
  });

  it("保存一次填写并读回", async () => {
    const result = scoreRSQ(answers({ 19: 7, 20: 1 }));
    const id = await saveRSQResponse({ fromPersonaId: A, toPersonaId: B, gameId: "g1", batteryLevel: "L", result });
    expect(id).toBeGreaterThan(0);

    const got = await getLatestRSQ(A, B);
    expect(got).not.toBeNull();
    expect(got!.dims.affection).toBe(result.dims.affection);
    expect(got!.itemsVersion).toBe(result.itemsVersion);
    expect(got!.gameId).toBe("g1");
  });

  it("保存时同步核心维度到 persona_relations", async () => {
    const result = scoreRSQ(answers({ 19: 7, 20: 1, 7: 7, 8: 1 })); // 高喜爱 + 高对抗
    const id = await saveRSQResponse({ fromPersonaId: A, toPersonaId: B, result });

    const db = getDb();
    const rows = await db.select().from(tbl.personaRelations);
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(row.rsqResponseId).toBe(id);
    expect(row.rsqAffection).toBe(result.dims.affection);
    expect(row.rsqAntagonism).toBe(result.dims.antagonism);
    expect(row.rsqAmbivalence).toBe(result.derived.ambivalence);
    expect(row.rsqVerdict).toBe(result.validity.verdict);
    expect(row.rsqUpdatedAt).toBeInstanceOf(Date);
  });

  it("可关闭同步", async () => {
    const result = scoreRSQ(answers());
    await saveRSQResponse({ fromPersonaId: A, toPersonaId: B, result, syncToRelation: false });
    const db = getDb();
    const rows = await db.select().from(tbl.personaRelations);
    expect(rows[0]!.rsqResponseId).toBeNull();
  });

  it("时间轴：多次填写按时间排序，且最新一条可单独取", async () => {
    const t0 = new Date("2026-10-01T10:00:00Z");
    const t1 = new Date("2026-10-05T10:00:00Z");
    const t2 = new Date("2026-10-09T10:00:00Z");

    await saveRSQResponse({ fromPersonaId: A, toPersonaId: B, result: scoreRSQ(answers({ 19: 3 })), answeredAt: t0 });
    await saveRSQResponse({ fromPersonaId: A, toPersonaId: B, result: scoreRSQ(answers({ 19: 7 })), answeredAt: t2 });
    await saveRSQResponse({ fromPersonaId: A, toPersonaId: B, result: scoreRSQ(answers({ 19: 5 })), answeredAt: t1 });

    const desc = await listRSQHistory(A, B);
    expect(desc.length).toBe(3);
    expect(desc[0]!.answeredAt.getTime()).toBe(t2.getTime()); // 最新在前
    expect(desc[2]!.answeredAt.getTime()).toBe(t0.getTime());

    const asc = await listRSQHistory(A, B, { order: "asc" });
    expect(asc[0]!.answeredAt.getTime()).toBe(t0.getTime());
    expect(asc[2]!.answeredAt.getTime()).toBe(t2.getTime());

    const latest = await getLatestRSQ(A, B);
    expect(latest!.answeredAt.getTime()).toBe(t2.getTime());
  });

  it("按对局取全部填写", async () => {
    await saveRSQResponse({ fromPersonaId: A, toPersonaId: B, gameId: "game-x", result: scoreRSQ(answers()) });
    await saveRSQResponse({ fromPersonaId: B, toPersonaId: A, gameId: "game-x", result: scoreRSQ(answers()) });
    await saveRSQResponse({ fromPersonaId: A, toPersonaId: B, gameId: "game-y", result: scoreRSQ(answers()) });

    const rows = await listRSQByGame("game-x");
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.gameId)).toEqual(["game-x", "game-x"]);
  });

  it("listLatestRSQFor：每个对象只取最新一条", async () => {
    // 注意：affection 由正题 19 与反题 20 共同决定，两者都要覆写
    await saveRSQResponse({ fromPersonaId: A, toPersonaId: B, result: scoreRSQ(answers({ 19: 1, 20: 7 })), answeredAt: new Date("2026-10-01") });
    await saveRSQResponse({ fromPersonaId: A, toPersonaId: B, result: scoreRSQ(answers({ 19: 7, 20: 1 })), answeredAt: new Date("2026-10-08") });

    const latest = await listLatestRSQFor(A);
    expect(latest.length).toBe(1);
    expect(latest[0]!.toPersonaId).toBe(B);
    expect(latest[0]!.dims.affection).toBe(100); // 取到较晚那条
  });

  it("覆盖统计", async () => {
    await saveRSQResponse({ fromPersonaId: A, toPersonaId: B, result: scoreRSQ(answers()) });
    await saveRSQResponse({ fromPersonaId: A, toPersonaId: B, result: scoreRSQ(answers()) });
    const cov = await rsqCoverage();
    expect(cov.pairs).toBe(1);
    expect(cov.total).toBe(2);
  });

  it("效度与反馈被完整持久化", async () => {
    const result = scoreRSQ(answers({ 88: 7, 89: 7, 90: 7, 91: 7, 92: 7 }), {
      feedback: {
        affect: 2,
        willingness: 3,
        perceivedDepth: 6,
        hardestItems: [{ itemNo: 21, reason: "不好回答", tag: "ambiguous" }],
        missingDimensions: [{ suggestion: "没问是否当参照系", possibleDimension: "reference" }],
      },
    });
    await saveRSQResponse({ fromPersonaId: A, toPersonaId: B, result });
    const got = await getLatestRSQ(A, B);
    expect(got!.validity.verdict).toBe(result.validity.verdict);
    expect(got!.validity.flags).toEqual(result.validity.flags);
    expect(got!.feedback?.affect).toBe(2);
    expect(got!.feedback?.hardestItems[0]?.itemNo).toBe(21);
    expect(got!.feedback?.missingDimensions[0]?.possibleDimension).toBe("reference");
  });
});
