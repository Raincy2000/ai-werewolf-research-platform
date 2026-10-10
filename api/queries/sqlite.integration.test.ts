// ============================================================
// SQLite 方言集成测试（桌面客户端前置保障）
// 用真实 node:sqlite（:memory:）跑全部查询模块的 CRUD 表面——
// 既有 205 个测试在模块级 mock 掉查询层，覆盖不到 SQL 方言正确性，本文件补齐。
// 注意：方言在模块加载期确定（db/schema.ts 调度层），必须在动态导入前设 env。
// ============================================================

import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";

// ---- 方言与环境必须在任何业务模块导入前就位 ----
const ORIG_DB_DIALECT = process.env.DB_DIALECT;
const ORIG_SQLITE_PATH = process.env.SQLITE_PATH;
process.env.DB_DIALECT = "sqlite";
process.env.SQLITE_PATH = ":memory:";
process.env.PRESET_SECRET = process.env.PRESET_SECRET || "sqlite-it-preset-secret";

afterAll(() => {
  // 防止方言泄漏到同 worker 后续测试文件
  if (ORIG_DB_DIALECT === undefined) delete process.env.DB_DIALECT;
  else process.env.DB_DIALECT = ORIG_DB_DIALECT;
  if (ORIG_SQLITE_PATH === undefined) delete process.env.SQLITE_PATH;
  else process.env.SQLITE_PATH = ORIG_SQLITE_PATH;
});

// ---- 动态导入（env 就位后）----
const users = await import("./users");
const games = await import("./games");
const decisions = await import("./decisions");
const guide = await import("./guide");
const winrates = await import("./winrates");
const presets = await import("./presets");
const personasQ = await import("./personas");
const { hashPassword } = await import("../lib/authCrypto");
const { getDb } = await import("./connection");
const tbl = await import("../../db/schema");
const { defaultPersonaParams, emptyPersonaProfile } = await import("../../contracts/persona");

// 每用例清库（:memory: 全文件共享；无 FK，顺序删除即可）
beforeEach(async () => {
  const db = getDb();
  for (const t of [
    tbl.sessions,
    tbl.gameEvents,
    tbl.gameDecisions,
    tbl.gameWinrates,
    tbl.gameAnalyses,
    tbl.guideVersions,
    tbl.apiPresets,
    tbl.personaReports,
    tbl.personaDriftLog,
    tbl.personaRelationshipHistory,
    tbl.personaRelationships,
    tbl.personaMemories,
    tbl.personas,
    tbl.games,
    tbl.users,
  ]) {
    await db.delete(t);
  }
});

const UID = "u-sqlite-it-1";

async function seedUser() {
  return users.insertUser({
    id: UID,
    email: "sqlite-it@local.test",
    username: "SQLite集成",
    avatar: "data:image/svg+xml;base64,xxxx",
    passwordHash: await hashPassword("it-password-1"),
    settings: null,
  });
}

const GAME_ID = "g-sqlite-it-1";
async function seedGame() {
  await games.insertGame({
    id: GAME_ID,
    boardId: "standard9",
    boardName: "标准9人局",
    status: "running",
    playerCount: 9,
    setup: { seatRoles: ["werewolf", "seer"], options: { stepDelayMs: 250 } },
    userId: UID,
  });
}

describe("SQLite 方言：用户与会话", () => {
  it("insertUser → findByEmail/Id → updateProfile → settings JSON 往返", async () => {
    const u = await seedUser();
    expect(u.username).toBe("SQLite集成");
    expect(u.createdAt).toBeTruthy();

    expect((await users.findUserByEmail("sqlite-it@local.test"))?.id).toBe(UID);
    expect((await users.findUserById(UID))?.email).toBe("sqlite-it@local.test");

    const renamed = await users.updateUserProfile(UID, { username: "集成改名" });
    expect(renamed?.username).toBe("集成改名");

    const settings = { lobby: { boardId: "standard9" }, analyst: { winRateEnabled: true } };
    await users.saveUserSettings(UID, settings);
    expect(await users.getUserSettings(UID)).toEqual(settings);
  });

  it("createSession → resolveSession → destroySession（expiresAt Date 往返）", async () => {
    await seedUser();
    const { token, expiresAt } = await users.createSession(UID, false);
    expect(token).toBeTruthy();
    expect(expiresAt).toBeInstanceOf(Date);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());

    const u = await users.resolveSession(token);
    expect(u?.id).toBe(UID);

    await users.destroySession(token);
    expect(await users.resolveSession(token)).toBeNull();
    expect(await users.resolveSession(undefined)).toBeNull();
  });
});

describe("SQLite 方言：对局与事件", () => {
  it("insertGame → updateGame（显式 updatedAt）→ getGame/listGames（setup JSON 往返）", async () => {
    await seedUser();
    await seedGame();

    const g = await games.getGame(GAME_ID);
    expect(g?.status).toBe("running");
    expect((g?.setup as { options: { stepDelayMs: number } }).options.stepDelayMs).toBe(250);
    expect(g?.createdAt).toBeInstanceOf(Date);

    const before = g!.updatedAt;
    await new Promise((r) => setTimeout(r, 5));
    await games.updateGame(GAME_ID, { status: "finished", winner: "wolf", dayCount: 3 });
    const g2 = await games.getGame(GAME_ID);
    expect(g2?.status).toBe("finished");
    expect(g2?.winner).toBe("wolf");
    expect(g2!.updatedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());

    const list = await games.listGames(UID);
    expect(list.some((x: { id: string }) => x.id === GAME_ID)).toBe(true);
    expect(await games.listGames("other-user")).toEqual([]);
  });

  it("appendEvents → 游标增量/全量/最新/阶段/maxSeq/赛后判定（meta JSON 与 null 混合）", async () => {
    await seedUser();
    await seedGame();
    const mk = (seq: number, over: Record<string, unknown> = {}) => ({
      gameId: GAME_ID,
      seq,
      day: 1,
      phase: "night.witch",
      type: "action" as const,
      actor: 3,
      actorLabel: "3号玩家",
      title: `事件${seq}`,
      content: `内容${seq}`,
      thought: seq % 2 ? null : `思考${seq}`,
      meta: seq % 2 ? { repaired: "修正" } : null,
      ...over,
    });
    await games.appendEvents([
      mk(1, { type: "phase", actor: null, actorLabel: null, title: "夜晚 · 女巫行动" }),
      mk(2),
      mk(3, { phase: "postgame.discuss", title: "赛后讨论" }),
    ]);

    const after1 = await games.getEventsAfter(GAME_ID, 1);
    expect(after1.map((e) => e.seq)).toEqual([2, 3]);
    expect(after1[0]!.meta).toBeNull(); // seq2 夹具 meta=null
    expect(after1[0]!.thought).toBe("思考2");
    expect(after1[1]!.meta).toEqual({ repaired: "修正" }); // seq3 夹具 meta 有值

    expect((await games.getAllEvents(GAME_ID)).length).toBe(3);
    expect((await games.getLatestEvents(GAME_ID, 2)).map((e) => e.seq)).toEqual([2, 3]);
    expect((await games.getLatestPhaseEvent(GAME_ID))?.title).toBe("夜晚 · 女巫行动");
    expect(await games.getMaxEventSeq(GAME_ID)).toBe(3);
    expect(await games.hasPostGameEvents(GAME_ID)).toBe(true);
    expect(await games.hasPostGameEvents("nonexistent")).toBe(false);
  });
});

describe("SQLite 方言：决策日志", () => {
  it("appendDecision → getDecisions 按 idx 排序 → countDecisions（decision JSON 往返）", async () => {
    await seedUser();
    await seedGame();
    await decisions.appendDecision({ gameId: GAME_ID, idx: 1, kind: "wolfKill", seat: 2, decision: { thought: "刀3", targets: [3] } });
    await decisions.appendDecision({ gameId: GAME_ID, idx: 0, kind: "witchAction", seat: 3, decision: { thought: "救", witchSave: true } });

    const rows = await decisions.getDecisions(GAME_ID);
    expect(rows.map((r) => r.idx)).toEqual([0, 1]);
    expect((rows[0]!.decision as { witchSave?: boolean }).witchSave).toBe(true);
    expect(await decisions.countDecisions(GAME_ID)).toBe(2);
  });
});

describe("SQLite 方言：经验指南与分析报告", () => {
  it("版本序列/getLatest/count/list/get/listScopes", async () => {
    await seedUser();
    await guide.insertGuideVersion({ scope: "common", version: 1, content: "共通V1", userId: UID, note: "" });
    await guide.insertGuideVersion({ scope: "common", version: 2, content: "共通V2", userId: UID, note: "改进" });
    await guide.insertGuideVersion({ scope: "standard9", version: 1, content: "版型V1", userId: UID, note: "" });

    expect((await guide.getLatestGuide(UID, "common"))?.content).toBe("共通V2");
    expect(await guide.countGuides(UID, "common")).toBe(2);
    expect((await guide.listGuideVersions(UID, "common"))[0]!.version).toBe(2);
    expect((await guide.getGuideVersion(UID, "common", 1))?.content).toBe("共通V1");
    expect((await guide.listGuideScopes(UID)).sort()).toEqual(["common", "standard9"]);
  });

  it("upsertAnalysis 插入后覆盖 → getAnalysis", async () => {
    await guide.upsertAnalysis(GAME_ID, "报告V1", "mock-model");
    expect((await guide.getAnalysis(GAME_ID))?.report).toBe("报告V1");
    await guide.upsertAnalysis(GAME_ID, "报告V2", "mock-model");
    const a = await guide.getAnalysis(GAME_ID);
    expect(a?.report).toBe("报告V2");
    expect(a?.createdAt).toBeTruthy();
  });
});

describe("SQLite 方言：胜率推测", () => {
  it("insertWinRate → 游标增量 → 最新一条（reasons JSON 往返）", async () => {
    await winrates.insertWinRate({ gameId: GAME_ID, day: 1, phase: "day.speech", goodPct: 55, wolfPct: 45, reasons: ["3号发言好"], triggerLabel: "3号白天发言" });
    const second = await winrates.insertWinRate({ gameId: GAME_ID, day: 1, phase: "day.vote", goodPct: 60, wolfPct: 40, reasons: ["放逐4号", "狼队减员"], triggerLabel: "放逐投票" });

    const all = await winrates.getWinRatesAfter(GAME_ID, 0);
    expect(all.length).toBe(2);
    expect(all[1]!.reasons).toEqual(["放逐4号", "狼队减员"]);

    const cursor = all[0]!.id;
    const inc = await winrates.getWinRatesAfter(GAME_ID, cursor);
    expect(inc.length).toBe(1);

    const latest = await winrates.getLatestWinRate(GAME_ID);
    expect(latest?.goodPct).toBe(60);
    expect(latest?.triggerLabel).toBe("放逐投票");
    void second;
  });
});

describe("SQLite 方言：AI 存档库（$returningId + 加解密）", () => {  it("create/list/update/remove 全链路（apiKey 密文落库、解密回读、updatedAt 刷新）", async () => {
    await seedUser();
    const p = await presets.createPreset(UID, { name: "存档A", provider: "kimi", baseUrl: "https://api.moonshot.cn/v1", model: "kimi-k2", apiKey: "sk-secret-a" });
    expect(p.id).toBeGreaterThan(0);
    expect(p.apiKey).toBe("sk-secret-a"); // 读出即解密

    const list = await presets.listPresets(UID);
    expect(list.some((x) => x.name === "存档A")).toBe(true);
    expect(await presets.listPresets("other-user")).toEqual([]); // 按用户隔离

    const t0 = list[0]!.updatedAt;
    await new Promise((r) => setTimeout(r, 5));
    const updated = await presets.updatePreset(p.id, UID, { model: "kimi-k2-0905" });
    expect(updated?.model).toBe("kimi-k2-0905");
    expect(updated!.updatedAt >= t0).toBe(true);

    expect(await presets.deletePreset(p.id, UID)).toBe(true);
    expect(await presets.listPresets(UID)).toEqual([]);
  });
});

describe("SQLite 方言：图书馆与赛前学习笔记", () => {
  it("library_docs 增删查（按用户隔离）", async () => {
    const lib = await import("./library");
    await seedUser();
    const id = await lib.insertLibraryDoc({
      userId: UID,
      name: "狼人杀进阶指南.md",
      format: "md",
      content: "# 金水包含平民\n预言家验出的好人不限神职。",
      sizeBytes: 42,
    });
    expect(id).toBeGreaterThan(0);

    const list = await lib.listLibraryDocs(UID);
    expect(list.length).toBe(1);
    expect(list[0]!.name).toBe("狼人杀进阶指南.md");
    expect(await lib.listLibraryDocs("other-user")).toEqual([]);

    const full = await lib.getLibraryDoc(id, UID);
    expect(full?.content).toContain("金水包含平民");
    expect(await lib.getLibraryDoc(id, "other-user")).toBeNull();

    const contents = await lib.getAllLibraryContents(UID);
    expect(contents.length).toBe(1);

    expect(await lib.deleteLibraryDoc(id, "other-user")).toBe(false); // 越权不可删
    expect(await lib.deleteLibraryDoc(id, UID)).toBe(true);
    expect(await lib.listLibraryDocs(UID)).toEqual([]);
  });

  it("game_studies 学习笔记 upsert 与按局读取", async () => {
    const lib = await import("./library");
    await lib.upsertStudyNote("g-study-1", 3, "我学到了金水包括平民。");
    await lib.upsertStudyNote("g-study-1", 3, "更新后的心得。");
    await lib.upsertStudyNote("g-study-1", 5, "另一个座位的心得。");

    const rows = await lib.getStudyNotes("g-study-1");
    expect(rows.length).toBe(2);
    expect(rows.find((r) => r.seat === 3)?.notes).toBe("更新后的心得。");
    expect(rows.find((r) => r.seat === 5)?.notes).toContain("另一个座位");
    expect(await lib.getStudyNotes("g-none")).toEqual([]);
  });
});

describe("SQLite 方言：人格研究库", () => {  const personaInput = () => ({
    name: "曹操",
    originName: "曹操",
    originSource: "《三国演义》",
    profile: {
      ...emptyPersonaProfile(),
      summary: "东汉末年权臣，多疑善谋。",
      quotes: ["宁教我负天下人，休教天下人负我"],
    },
    params: {
      ...defaultPersonaParams(),
      inferred: ["bigFive.agreeableness"],
    },
    notes: "高神经质-高马基雅维利样本",
  });

  it("create/get/list/update/remove 全链路（profile/params JSON 往返、按用户隔离）", async () => {
    await seedUser();
    const created = await personasQ.createPersona(UID, personaInput());
    expect(created.id).toBeGreaterThan(0);
    expect(created.profile.summary).toContain("多疑善谋");
    expect(created.params.bigFive.neuroticism).toBe(50);
    expect(created.params.inferred).toEqual(["bigFive.agreeableness"]);

    const got = await personasQ.getPersona(created.id, UID);
    expect(got?.name).toBe("曹操");
    expect(await personasQ.getPersona(created.id, "other-user")).toBeNull(); // 越权不可见

    const list = await personasQ.listPersonas(UID);
    expect(list.length).toBe(1);
    expect(list[0]!.bigFive.openness).toBe(50);
    expect(list[0]!.inferredCount).toBe(1);
    expect(await personasQ.listPersonas("other-user")).toEqual([]);

    const t0 = created.updatedAt;
    await new Promise((r) => setTimeout(r, 5));
    const updated = await personasQ.updatePersona(created.id, UID, {
      params: { ...created.params, bigFive: { ...created.params.bigFive, neuroticism: 88 }, inferred: [] },
    });
    expect(updated?.params.bigFive.neuroticism).toBe(88);
    expect(updated?.params.inferred).toEqual([]);
    expect(updated!.updatedAt >= t0).toBe(true);

    expect(await personasQ.deletePersona(created.id, "other-user")).toBe(false); // 越权不可删
    expect(await personasQ.deletePersona(created.id, UID)).toBe(true);
    expect(await personasQ.getPersona(created.id, UID)).toBeNull();
  });

  it("记事簿读取 + 软删连体保留 + 还原 + 彻底删除级联（心理检查报告保留）", async () => {
    await seedUser();
    const created = await personasQ.createPersona(UID, personaInput());
    const db = getDb();
    // 直接落库三类记事簿数据 + 一份心理检查报告（写入管线 P4 才开放，这里验证表结构与回收站语义）
    await db.insert(tbl.personaMemories).values({
      personaId: created.id, gameId: "g-x", type: "trauma",
      content: "第2夜被挚友 3 号投出局，信任崩塌。", emotionalWeight: 90, strength: 80,
    });
    await db.insert(tbl.personaRelationships).values({
      personaId: created.id, targetPersonaId: null, targetName: "刘备",
      relation: "宿怨", affinity: -70, trust: 10, note: "被其连环计所害", gameId: "g-x",
    });
    await db.insert(tbl.personaDriftLog).values({
      personaId: created.id, gameId: "g-x",
      changes: [{ path: "attachment.anxiety", from: 30, to: 45, reason: "被盟友背叛" }], note: "首局后漂移",
    });
    await db.insert(tbl.personaReports).values({
      gameId: "g-x", personaId: created.id, seat: 2, report: "# 心理检查报告", model: "mock",
    });

    const mem = await personasQ.listPersonaMemories(created.id, UID);
    expect(mem?.length).toBe(1);
    expect(mem![0]!.type).toBe("trauma");
    const rel = await personasQ.listPersonaRelationships(created.id, UID);
    expect(rel?.length).toBe(1);
    expect(rel![0]!.affinity).toBe(-70);
    const drift = await personasQ.listPersonaDrift(created.id, UID);
    expect(drift?.length).toBe(1);
    expect(drift![0]!.changes[0]!.to).toBe(45);
    expect(await personasQ.listPersonaMemories(created.id, "other-user")).toBeNull();

    // 软删入回收站：主列表/详情不可见，记忆/关系/漂移连体保留
    expect(await personasQ.deletePersona(created.id, UID)).toBe(true);
    expect(await personasQ.getPersona(created.id, UID)).toBeNull();
    expect((await personasQ.listPersonas(UID)).length).toBe(0);
    expect((await db.select().from(tbl.personaMemories)).length).toBe(1);
    expect((await db.select().from(tbl.personaDriftLog)).length).toBe(1);
    const trash = await personasQ.listPersonaTrash(UID);
    expect(trash.length).toBe(1);
    expect(trash[0]!.name).toBe("曹操");
    expect(new Date(trash[0]!.expiresAt).getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);

    // 还原：原样回来（参数/记忆/漂移全在）
    expect(await personasQ.restorePersona(created.id, UID)).toBe(true);
    const restored = await personasQ.getPersona(created.id, UID);
    expect(restored?.params.inferred).toEqual(["bigFive.agreeableness"]);
    expect((await personasQ.listPersonaDrift(created.id, UID))?.length).toBe(1);
    expect((await personasQ.listPersonaTrash(UID)).length).toBe(0);

    // 彻底删除（需先在回收站）：级联清除记忆/关系/漂移；心理检查报告作为研究档案保留
    expect(await personasQ.destroyPersona(created.id, UID)).toBe(false); // 未入回收站不可直删
    expect(await personasQ.deletePersona(created.id, UID)).toBe(true);
    expect(await personasQ.destroyPersona(created.id, UID)).toBe(true);
    expect((await db.select().from(tbl.personaMemories)).length).toBe(0);
    expect((await db.select().from(tbl.personaRelationships)).length).toBe(0);
    expect((await db.select().from(tbl.personaDriftLog)).length).toBe(0);
    expect((await db.select().from(tbl.personas)).length).toBe(0);
    expect((await db.select().from(tbl.personaReports)).length).toBe(1);
  });

  it("圈层羁绊查询：listRelationshipsAmong 只返回双方都在集合内的关系", async () => {
    await seedUser();
    const a = await personasQ.createPersona(UID, personaInput());
    const b = await personasQ.createPersona(UID, { ...personaInput(), name: "刘备" });
    const c = await personasQ.createPersona(UID, { ...personaInput(), name: "孙权" });
    const db = getDb();
    // A→B（在场两人）、B→A、C→A（C 不在查询集合）、A→场外自由文本（无 targetPersonaId）
    await db.insert(tbl.personaRelationships).values([
      { personaId: a.id, targetPersonaId: b.id, targetName: "刘备", relation: "宿怨", affinity: -60, trust: 20, note: "赤壁旧账" },
      { personaId: b.id, targetPersonaId: a.id, targetName: "曹操", relation: "警惕", affinity: -30, trust: 40, note: "" },
      { personaId: c.id, targetPersonaId: a.id, targetName: "曹操", relation: "中立", affinity: 0, trust: 50, note: "" },
      { personaId: a.id, targetPersonaId: null, targetName: "袁绍", relation: "旧识", affinity: 10, trust: 50, note: "" },
    ]);
    const rows = await personasQ.listRelationshipsAmong([a.id, b.id]);
    expect(rows.length).toBe(2); // 仅 A→B 与 B→A（双方都在场）
    expect(rows.every((r) => [a.id, b.id].includes(r.personaId) && [a.id, b.id].includes(r.targetPersonaId!))).toBe(true);
    expect(rows.some((r) => r.relation === "宿怨" && r.note === "赤壁旧账")).toBe(true);
    expect(await personasQ.listRelationshipsAmong([a.id])).toEqual([]); // 少于 2 张卡直接空
    expect(await personasQ.listRelationshipsAmong([])).toEqual([]);
  });

  it("回收站惰性过期清理：超过 30 天保留期的软删人格被彻底删除", async () => {
    await seedUser();
    const created = await personasQ.createPersona(UID, personaInput());
    const db = getDb();
    await db.insert(tbl.personaMemories).values({
      personaId: created.id, gameId: "g-x", type: "general", content: "陈年旧事。",
    });
    expect(await personasQ.deletePersona(created.id, UID)).toBe(true);
    // 手工把删除时间改到 31 天前（模拟过期）
    await db
      .update(tbl.personas)
      .set({ deletedAt: new Date(Date.now() - 31 * 86_400_000) })
      .where(eq(tbl.personas.id, created.id));
    // 打开回收站即触发惰性清理：人格与连体数据一并彻底清除
    expect(await personasQ.listPersonaTrash(UID)).toEqual([]);
    expect((await db.select().from(tbl.personas)).length).toBe(0);
    expect((await db.select().from(tbl.personaMemories)).length).toBe(0);
  });
});


describe("SQLite 方言：对局标题号（games.title_no）", () => {
  it("insertGame/getGame titleNo 往返 + countGamesOnDate 当日计数", async () => {
    await seedUser();
    await seedGame(); // seedGame 未显式传 titleNo（schema 默认 ''）
    const g = await games.getGame(GAME_ID);
    expect(g?.titleNo).toBe("");

    const { countGamesOnDate } = await import("./games");
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart.getTime() + 86400_000);
    const n0 = await countGamesOnDate(UID, dayStart, dayEnd);
    await games.insertGame({
      id: "g-tno-2",
      boardId: "standard9",
      boardName: "标准9人局",
      titleNo: "20260811002",
      status: "created",
      playerCount: 9,
      setup: { seatRoles: ["seer"], options: { stepDelayMs: 250 } },
      userId: UID,
    });
    expect(await countGamesOnDate(UID, dayStart, dayEnd)).toBe(n0 + 1);
    expect((await games.getGame("g-tno-2"))?.titleNo).toBe("20260811002");
  });

  it("DDL_0003 迁移：ALTER 加列 + 存量按当日序号回填（窗口函数）", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const { SQLITE_DDL_0003 } = await import("../../db/sqlite-ddl");
    const raw = new DatabaseSync(":memory:");
    // 模拟旧库：无 title_no 的 games 表 + 三个存量对局（A 用户同日两局、B 用户同日一局）
    raw.exec(`CREATE TABLE games (
      id text PRIMARY KEY NOT NULL, board_id text NOT NULL, board_name text NOT NULL,
      status text DEFAULT 'created' NOT NULL, winner text, day_count integer DEFAULT 1 NOT NULL,
      player_count integer NOT NULL, setup text NOT NULL, user_id text,
      created_at integer NOT NULL, updated_at integer NOT NULL
    )`);
    const t = (h: number, m: number) => new Date(2026, 7, 4, h, m, 0).getTime(); // 本地同日
    const ins = (id: string, uid: string, ts: number) =>
      raw
        .prepare(
          "INSERT INTO games (id, board_id, board_name, player_count, setup, user_id, created_at, updated_at) VALUES (?, 'b', 'n', 9, '{}', ?, ?, ?)",
        )
        .run(id, uid, ts, ts);
    ins("g1", "A", t(10, 0));
    ins("g2", "A", t(15, 30));
    ins("g3", "B", t(12, 0));

    raw.exec(SQLITE_DDL_0003);

    expect(raw.prepare("SELECT 1 FROM pragma_table_info('games') WHERE name='title_no'").get()).toBeTruthy();
    const rows = raw.prepare("SELECT id, title_no FROM games ORDER BY id").all() as {
      id: string;
      title_no: string;
    }[];
    expect(rows).toEqual([
      { id: "g1", title_no: "20260804001" },
      { id: "g2", title_no: "20260804002" },
      { id: "g3", title_no: "20260804001" },
    ]);
  });
});

describe("persona_relationship_history（关系沿革：追加写+正序读）", () => {
  it("upsert 汇总 + 历史追加 + 按时间正序读取", async () => {
    await users.insertUser({ id: "relh-user-1", email: "relh@example.com", username: "沿革测试", avatar: "", passwordHash: await hashPassword("password123"), settings: null });
    const u = await users.findUserByEmail("relh@example.com");
    const created = await personasQ.createPersona(
      u!.id,
      { name: "艾伦·耶格尔", params: defaultPersonaParams(), profile: emptyPersonaProfile() },
      "manual",
    );
    const pid = created.id;

    // 两局两次回写：汇总行 upsert 归并，历史行各留一条
    const s1 = await personasQ.upsertPersonaRelationship({
      personaId: pid, targetPersonaId: 13, targetName: "夜神月",
      relation: "宿敌", affinityDelta: -30, trustDelta: -20, note: "第一局被算计", gameId: "g1",
    });
    await personasQ.insertPersonaRelationshipHistory({
      personaId: pid, targetPersonaId: 13, targetName: "夜神月", gameId: "g1", titleNo: "20261009001",
      relation: "宿敌", affinityDelta: -30, trustDelta: -20,
      affinity: s1.affinity, trust: s1.trust, note: "第一局被算计",
    });
    const s2 = await personasQ.upsertPersonaRelationship({
      personaId: pid, targetPersonaId: 13, targetName: "夜神月",
      relation: "亦敌亦友", affinityDelta: 10, trustDelta: 15, note: "第二局并肩作战", gameId: "g2",
    });
    await personasQ.insertPersonaRelationshipHistory({
      personaId: pid, targetPersonaId: 13, targetName: "夜神月", gameId: "g2", titleNo: "20261010001",
      relation: "亦敌亦友", affinityDelta: 10, trustDelta: 15,
      affinity: s2.affinity, trust: s2.trust, note: "第二局并肩作战", backfill: true,
    });

    // 汇总行：累计值（亲和 -30+10=-20；信任 50-20+15=45）
    const rels = await personasQ.listPersonaRelationships(pid, u!.id);
    expect(rels!.length).toBe(1);
    expect(rels![0]!.affinity).toBe(-20);
    expect(rels![0]!.trust).toBe(45);

    // 历史行：两条、正序、快照与汇总结算值一致
    const hist = await personasQ.listPersonaRelationshipHistory(pid, u!.id);
    expect(hist!.length).toBe(2);
    expect(hist![0]!.titleNo).toBe("20261009001");
    expect(hist![0]!.affinity).toBe(-30);
    expect(hist![1]!.titleNo).toBe("20261010001");
    expect(hist![1]!.affinity).toBe(-20); // 快照=结算后累计
    expect(hist![1]!.trust).toBe(45);
    expect(hist![0]!.backfill).toBe(false); // 赛后实时回写
    expect(hist![1]!.backfill).toBe(true); // 追溯回填标记
  });
});
