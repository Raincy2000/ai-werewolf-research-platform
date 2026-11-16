import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let child: ChildProcess | null = null;
let tempDir = "";
let origin = "";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("无法分配测试端口"));
      server.close(() => resolve(address.port));
    });
  });
}

beforeAll(async () => {
  tempDir = mkdtempSync(path.join(process.cwd(), ".vite-dev-static-test-"));
  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [
    path.resolve("node_modules/vite/bin/vite.js"),
    "--host", "127.0.0.1", "--port", String(port), "--strictPort",
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "development",
      DB_DIALECT: "sqlite",
      SQLITE_PATH: path.join(tempDir, "werewolf.db"),
      APP_ID: "vite-dev-static-test",
      APP_SECRET: "test-only",
      PRESET_SECRET: "0".repeat(64),
      OWNER_PASSWORD: "test-only",
      ELECTRON_RUN_AS_NODE: "1",
    },
    stdio: "ignore",
  });
  const deadline = Date.now() + 75_000;
  for (;;) {
    try {
      const response = await fetch(`${origin}/api/trpc/ping`);
      if (response.ok) break;
    } catch { /* 等待启动 */ }
    if (Date.now() > deadline) throw new Error("Vite 测试服务启动超时");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}, 90_000);

afterAll(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise<void>((resolve) => child!.once("exit", () => resolve()));
    if (process.platform === "win32") spawnSync("taskkill.exe", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    else child.kill("SIGTERM");
    await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 3_000))]);
  }
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

describe("真实 Vite 开发服务：无 dist 的首页", () => {
  it("没有构建产物时由 Vite 返回前端页面，而不是 503", async () => {
    const page = await fetch(`${origin}/`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('<div id="root"></div>');
    expect(html).not.toContain("前端构建缺失");
  }, 30_000);
});
