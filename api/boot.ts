import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { compress } from "hono/compress";
import type { HttpBindings } from "@hono/node-server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "./router";
import { createContext } from "./context";
import { env } from "./lib/env";

const app = new Hono<{ Bindings: HttpBindings }>();

app.use(bodyLimit({ maxSize: 50 * 1024 * 1024 }));
// gzip/br 压缩：tRPC 轮询 JSON 与静态产物传输量大幅下降（主 JS 约 582KB → ~180KB）
app.use(compress());
app.use("/api/trpc/*", async (c) => {
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req: c.req.raw,
    router: appRouter,
    createContext,
  });
});
app.all("/api/*", (c) => c.json({ error: "Not Found" }, 404));

export default app;

// 用户页面一律由生产构建静态资源供给（dist/public 磁盘哈希资产，vite 进程重启不影响）——
// 根治「vite dev 模块图重启后用户缓存的旧模块地址 404 → 页面持续空白」
//（API 由本 app 的 /api/trpc 路由提供；开发模式下由 @hono/vite-dev-server 托管本 app）
{
  const { serveStaticFiles } = await import("./lib/vite");
  serveStaticFiles(app);
}

// 启动即预热 DB 连接池（首个用户请求不再承担建连延迟，首进更快）；
// 失败不阻塞服务启动（DB 短暂不可用时请求侧仍会按原路径报错/重试）
{
  const { getDb } = await import("./queries/connection");
  const { sql } = await import("drizzle-orm");
  // 预热 DB 连接（sqlite 方言用 run，mysql 用 execute）；失败不阻塞服务启动
  const warm = env.dbDialect === "sqlite" ? getDb().run(sql`SELECT 1`) : getDb().execute(sql`SELECT 1`);
  Promise.resolve(warm).catch((err) => console.warn("[boot] DB 预热失败（不阻塞启动）:", err));
}

// 桌面客户端首启：SQLite 库为空且提供 OWNER_PASSWORD 时自动预建 owner 账户（用户01）
if (env.dbDialect === "sqlite" && process.env.OWNER_PASSWORD) {
  const { getDb } = await import("./queries/connection");
  const { users } = await import("@db/schema");
  const existing = await getDb().select({ id: users.id }).from(users).limit(1);
  if (existing.length === 0) {
    const { runSeedOwner } = await import("./lib/seedOwner");
    await runSeedOwner(process.env.OWNER_PASSWORD);
  }
}

if (env.isProduction) {
  const { serve } = await import("@hono/node-server");
  const { applyServerTimeouts } = await import("./lib/serverTimeouts");

  const port = parseInt(process.env.PORT || "3000");
  // HOST 缺省监听全部网卡；桌面客户端传 HOST=127.0.0.1 仅监听本机回环
  const server = serve({ fetch: app.fetch, port, hostname: process.env.HOST || undefined }, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });
  // 解除 Node http server 默认 300s requestTimeout——铸魂师铸造/分析报告等
  // 单请求长任务不被服务端掐断（根治「铸造途中界面忽然消失」）
  applyServerTimeouts(server as unknown as import("node:http").Server);
}
