import type { Hono } from "hono";
import type { HttpBindings } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import fs from "fs";
import path from "path";

type App = Hono<{ Bindings: HttpBindings }>;

export function serveStaticFiles(app: App) {
  // dist/public 定位必须同时兼容两种加载方式（历史事故：只按相对 import.meta.dirname
  // 推导，开发模式下解析到 api/dist/public → ENOENT → /game/* 等 SPA 路由一律 500）：
  //   · 生产：esbuild 打包为 dist/boot.js（import.meta.dirname = <root>/dist）
  //   · 开发：vite dev 直接加载 api/lib/vite.ts（import.meta.dirname = <root>/api/lib）
  // 以「存在 index.html」为准多候选探测，绝不依赖单一布局假设。
  const candidates = [
    path.resolve(process.cwd(), "dist/public"),
    path.resolve(import.meta.dirname, "../../dist/public"),
    path.resolve(import.meta.dirname, "../dist/public"),
  ];
  const distPath =
    candidates.find((p) => fs.existsSync(path.join(p, "index.html"))) ?? candidates[0];

  // 带内容 hash 的构建产物（/assets/*.js|css）：长效缓存，二次访问秒开（移动端弱网收益最大）
  app.use("/assets/*", async (c, next) => {
    await next();
    if (c.res.status === 200) {
      c.res.headers.set("Cache-Control", "public, max-age=31536000, immutable");
    }
  });
  // index.html 不缓存：保证新版本发布后刷新即得
  app.use("/", async (c, next) => {
    await next();
    c.res.headers.set("Cache-Control", "no-cache");
  });

  app.use("*", serveStatic({ root: distPath }));

  app.notFound(async (c) => {
    const accept = c.req.header("accept") ?? "";
    if (!accept.includes("text/html")) {
      return c.json({ error: "Not Found" }, 404);
    }
    // SPA 回退：/game/:id、/guide 等前端路由一律回 index.html。
    // 必须走 serveStatic 文件响应（而非 readFileSync + c.html 字符串响应）——
    // 历史事故：字符串响应会被 compress 中间件 gzip 压缩，随后 vite dev 的 HTML
    // 转换器又把 /@vite/client 脚本注入到已压缩的字节流里，gzip 流损坏，
    // 浏览器报 ERR_CONTENT_DECODING_FAILED，对局页永远停在加载态。
    // serveStatic 文件流响应不被 compress 处理（与 / 路径行为一致），注入安全。
    try {
      const serveIndex = serveStatic({ root: distPath, path: "index.html" });
      const res = await serveIndex(c, async () => {});
      if (res) return res;
      return c.text("前端构建缺失，请先执行 npm run build", 503);
    } catch (err) {
      console.error("[serveStaticFiles] index.html 回退失败:", err);
      return c.text("前端构建缺失，请先执行 npm run build", 503);
    }
  });
}
