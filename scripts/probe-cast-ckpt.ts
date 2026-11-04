// 探针：直接调 router 的 persona.cast  mutation，验证 params 检查点是否落盘
// 用法：app-clone 下 npx tsx scripts/probe-cast-ckpt.ts
process.env.DB_DIALECT = "sqlite";
process.env.SQLITE_PATH = ":memory:";
process.env.PRESET_SECRET = process.env.PRESET_SECRET ?? "a".repeat(64);

const { appRouter } = await import("../api/router");
const { getDb } = await import("../api/queries/connection");
const { personaCastCheckpoints } = await import("../db/schema");

const caller = appRouter.createCaller({
  req: new Request("http://test.local/"),
  resHeaders: new Headers(),
  user: { id: "u-probe", email: "p@t.local", username: "p", avatar: "", createdAt: new Date().toISOString() },
} as never);

const quad = { provider: "kimi" as const, baseUrl: "http://127.0.0.1:1/v1", model: "m", apiKey: "k" };
const r = await caller.persona.cast({
  name: "探针人格",
  searchAi: quad, understandAi: quad, synthAi: quad,
  web: { stage1: false, stage2: false, stage3: false },
  deepRead: { segmented: false, selfCritique: false },
  castId: "probe-cast-1",
});
console.log("cast 返回:", r);
// 等一拍让 fire-and-forget 落盘
await new Promise((r2) => setTimeout(r2, 500));
const db = getDb();
const rows = await db.select().from(personaCastCheckpoints);
console.log("检查点行:", rows.map((r: typeof personaCastCheckpoints.$inferSelect) => r.stage));
if (!rows.some((r: typeof personaCastCheckpoints.$inferSelect) => r.stage === "params")) {
  console.error("❌ params 检查点未落盘");
  process.exit(1);
}
console.log("✅ params 检查点已落盘");
// 队列里的任务会因网络不通失败——等它走完（失败也没关系，只验证检查点已写）
await new Promise((r2) => setTimeout(r2, 2000));
process.exit(0);
