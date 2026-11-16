// 本地源码开发入口：系统 Node 启动 Vite，Electron 再连接该地址。
// 不构建 dist、不生成安装包、不复制数据库；窗口退出时同步关闭 Vite。
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";

const require = createRequire(import.meta.url);
const userData = process.env.WW_DATA_DIR || path.join(process.env.APPDATA || path.resolve(import.meta.dirname), "werewolf-desktop");
mkdirSync(userData, { recursive: true });
const cfgPath = path.join(userData, "desktop-config.json");
let cfg = {};
try { cfg = JSON.parse(readFileSync(cfgPath, "utf8")); } catch { /* 首启生成 */ }
for (const key of ["appSecret", "presetSecret"]) {
  if (!cfg[key]) cfg[key] = crypto.randomBytes(32).toString("hex");
}
if (!cfg.ownerPassword) cfg.ownerPassword = crypto.randomBytes(12).toString("base64url");
writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

const port = process.env.WW_PORT ? Number(process.env.WW_PORT) : await new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const selected = server.address().port;
    server.close(() => resolve(selected));
  });
});
const vitePath = path.resolve(import.meta.dirname, "..", "node_modules", "vite", "bin", "vite.js");
const viteCommand = process.execPath;
const viteEnv = {
  ...process.env,
  NODE_ENV: "development",
  DB_DIALECT: "sqlite",
  SQLITE_PATH: path.join(userData, "werewolf.db"),
  APP_ID: "werewolf-desktop",
  APP_SECRET: cfg.appSecret,
  PRESET_SECRET: cfg.presetSecret,
  OWNER_PASSWORD: cfg.ownerPassword,
  ELECTRON_RUN_AS_NODE: "1",
};

let vite = null;
let electron = null;
function stopVite() {
  if (!vite || vite.killed || vite.exitCode !== null) return;
  if (process.platform === "win32") spawnSync("taskkill.exe", ["/pid", String(vite.pid), "/T", "/F"], { windowsHide: true });
  else vite.kill("SIGTERM");
}
process.on("exit", stopVite);
process.on("SIGINT", () => { stopVite(); process.exit(130); });
process.on("SIGTERM", () => { stopVite(); process.exit(143); });

vite = spawn(viteCommand, [vitePath, "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
  cwd: path.resolve(import.meta.dirname, ".."),
  env: viteEnv,
  stdio: "inherit",
});
let viteDied = false;
vite.on("error", () => { viteDied = true; });
vite.on("exit", () => { viteDied = true; });

const url = `http://127.0.0.1:${port}`;
const deadline = Date.now() + 300_000;
for (;;) {
  if (viteDied) throw new Error("Vite 开发服务启动失败");
  try {
    const response = await fetch(`${url}/api/trpc/ping`, { signal: AbortSignal.timeout(10_000) });
    if (response.ok) break;
  } catch { /* 等待服务就绪；单次请求最多等待 10s，避免悬挂请求绕过总超时 */ }
  if (Date.now() > deadline) {
    stopVite();
    throw new Error("Vite 开发服务启动超时（300s）");
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
}

const npmElectron = require("electron");
const localElectron = path.resolve(import.meta.dirname, "electron-dist", "electron.exe");
const electronPath = existsSync(npmElectron) ? npmElectron : localElectron;
if (!existsSync(npmElectron) && !existsSync(localElectron)) {
  stopVite();
  throw new Error(`未找到 Electron 可执行文件：${npmElectron} 或 ${localElectron}`);
}
const env = { ...process.env, WW_DEV_URL: url, WW_DATA_DIR: userData };
delete env.ELECTRON_RUN_AS_NODE;
electron = spawn(electronPath, ["."], {
  cwd: import.meta.dirname,
  env,
  stdio: "inherit",
});
electron.on("error", (error) => {
  console.error("源码开发客户端启动失败：", error);
  stopVite();
  process.exitCode = 1;
});
electron.on("exit", (code, signal) => {
  stopVite();
  if (signal) process.exitCode = 1;
  else process.exitCode = code ?? 0;
});
