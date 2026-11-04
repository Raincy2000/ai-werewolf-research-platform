// 旧关系表迁移 + 关系网 schema 增量 DDL 回归测试（2026-10-22）
import { describe, it, expect, beforeEach, afterAll } from "vitest";

const ORIG_DB = process.env.DB_DIALECT;
const ORIG_PATH = process.env.SQLITE_PATH;
process.env.DB_DIALECT = "sqlite";
process.env.SQLITE_PATH = ":memory:";

afterAll(() => {
  if (ORIG_DB === undefined) delete process.env.DB_DIALECT; else process.env.DB_DIALECT = ORIG_DB;
  if (ORIG_PATH === undefined) delete process.env.SQLITE_PATH; else process.env.SQLITE_PATH = ORIG_PATH;
});

const { getDb, __rawSqliteForTest } = await import("./connection");
const tbl = await import("../../db/schema");
const { migrateLegacyRelations } = await import("./relationsMigration");
const { defaultPersonaParams, emptyPersonaProfile } = await import("../../contracts/persona");

const UID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
let P1 = 0, P2 = 0;

beforeEach(async () => {
  const db = getDb();
  for (const t of [tbl.relationDeltas, tbl.personaRelations, tbl.personaRelationships, tbl.personas, tbl.users]) {
    await db.delete(t);
  }
  await db.insert(tbl.users).values({
    id: UID, email: "mig@x.com", username: "迁移", avatar: "", passwordHash: "x", createdAt: new Date(),
  } as never);
  const rows: any[] = await db.insert(tbl.personas).values([
    { userId: UID, name: "甲", source: "manual", profile: emptyPersonaProfile(), params: defaultPersonaParams() },
    { userId: UID, name: "乙", source: "manual", profile: emptyPersonaProfile(), params: defaultPersonaParams() },
  ] as never).returning({ id: tbl.personas.id });
  P1 = rows[0]!.id;
  P2 = rows[1]!.id;
});

describe("relationsMigration：旧汇总表 → persona_relations.vale", () => {
  it("affinity 双维映射 + trust/basis 保留 + 幂等", async () => {
    const db = getDb();
    await db.insert(tbl.personaRelationships).values({
      personaId: P1, targetPersonaId: P2, targetName: "乙",
      relation: "宿怨", affinity: -60, trust: 20, note: "旧账", gameId: "g1",
    } as never);
    const first = await migrateLegacyRelations();
    expect(first.migrated).toBe(1);
    const rows: any[] = await db.select().from(tbl.personaRelations);
    expect(rows.length).toBe(1);
    expect(rows[0].layer).toBe("vale");
    expect(rows[0].kind).toBe("unspecified");
    expect(rows[0].negativity).toBe(60);
    expect(rows[0].positivity).toBe(0);
    expect(rows[0].trust).toBe(20);
    expect(rows[0].basis).toBe("旧账");
    const second = await migrateLegacyRelations();
    expect(second.migrated).toBe(0);
    expect(second.skipped).toBe(1);
    expect((await db.select().from(tbl.personaRelations)).length).toBe(1);
  });
});

describe("schema 增量 DDL（0107/0108/0109）", () => {
  it("canon 任务统计列 / 回写台账表 / 关系 partial unique / 别名昵称按人格唯一", async () => {
    getDb();
    const raw = __rawSqliteForTest();
    const cols = raw.prepare("SELECT name FROM pragma_table_info('canon_backfill_jobs')").all() as any[];
    const names = new Set(cols.map((c) => c.name));
    expect(names.has("stats")).toBe(true);
    expect(names.has("web_searched")).toBe(true);
    expect(names.has("warning")).toBe(true);
    const canonCols = raw.prepare("SELECT name FROM pragma_table_info('persona_canon_log')").all() as any[];
    expect(new Set(canonCols.map((c) => c.name)).has("sort_order")).toBe(true);

    const writeback = raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='persona_writeback_runs'").all() as any[];
    expect(writeback.length).toBe(1);

    const idx = raw.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as any[];
    const idxNames = new Set(idx.map((i) => i.name));
    expect(idxNames.has("idx_rel_active")).toBe(true);
    expect(idxNames.has("idx_alias_persona_name")).toBe(true);
    expect(idxNames.has("idx_nni_persona_text")).toBe(true);
    expect(idxNames.has("idx_rel_dyad")).toBe(false);
    expect(idxNames.has("idx_alias_uniq")).toBe(false);
  });

  it("active 唯一：superseded 行可保留同键，active 同键冲突", async () => {
    const db = getDb();
    const now = new Date();
    await db.insert(tbl.personaRelations).values({
      fromPersonaId: P1, toPersonaId: P2, layer: "canon", kind: "kin", form: "CS",
      status: "active", originModule: "test", createdAt: now, updatedAt: now,
    } as never);
    // 同键 active 应被 partial unique 拒绝
    await expect(db.insert(tbl.personaRelations).values({
      fromPersonaId: P1, toPersonaId: P2, layer: "canon", kind: "kin", form: "CS",
      status: "active", originModule: "test", createdAt: now, updatedAt: now,
    } as never)).rejects.toBeTruthy();
    // superseded 同键可插入（历史行）
    await db.insert(tbl.personaRelations).values({
      fromPersonaId: P1, toPersonaId: P2, layer: "canon", kind: "kin", form: "CS",
      status: "superseded", originModule: "test", createdAt: now, updatedAt: now,
    } as never);
    expect((await db.select().from(tbl.personaRelations)).length).toBe(2);
  });
});
