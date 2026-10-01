// ============================================================
// AI模拟狼人杀研究平台 - 桌面客户端主进程
// 职责：拉起内嵌 Node 服务（dist/boot.js，SQLite 方言）→ 打开窗口
// 数据布局（userData 目录）：
//   werewolf.db          全部对局/事件/决策/账户/存档（本地 SQLite，可备份）
//   desktop-config.json  机器级密钥（APP_SECRET/PRESET_SECRET 首启随机生成）与 owner 初始密码
// 环境变量（可选）：WW_PORT 固定端口（调试/E2E）；WW_DATA_DIR 覆盖数据目录
// ============================================================
import { app, BrowserWindow, dialog } from "electron";
import { fork } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

// ---------- 单实例 ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

const userData = process.env.WW_DATA_DIR || app.getPath("userData");
fs.mkdirSync(userData, { recursive: true });

// ---------- 文件日志（GUI 进程控制台不可见；排障与用户反馈用） ----------
const logFile = path.join(userData, "desktop.log");
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map(String).join(" ")}\n`;
  try {
    fs.appendFileSync(logFile, line);
  } catch {
    /* 忽略 */
  }
  console.log(...args);
}
log("=== 客户端启动 ===", `packaged=${app.isPackaged}`);

// ---------- 机器级配置（首启生成随机密钥并持久化） ----------
const cfgPath = path.join(userData, "desktop-config.json");
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  } catch {
    return {};
  }
}
const cfg = loadConfig();
let cfgDirty = false;
for (const key of ["appSecret", "presetSecret"]) {
  if (!cfg[key]) {
    cfg[key] = crypto.randomBytes(32).toString("hex"); // 64-hex：authCrypto 直接用作 AES 密钥
    cfgDirty = true;
  }
}
if (!cfg.ownerPassword) {
  // owner（用户01）初始密码：首启随机生成并落盘 desktop-config.json（登录时从该文件读取）；
  // 不在开源代码里硬编码默认密码，也不打印明文
  cfg.ownerPassword = crypto.randomBytes(16).toString("hex");
  cfgDirty = true;
  log("首启生成 owner 初始密码（见 desktop-config.json 的 ownerPassword 字段）");
}
if (cfgDirty) {
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
}

// ---------- 空闲端口 ----------
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

let server = null;
let serverPort = null;
let quitting = false;

async function startServer() {
  serverPort = process.env.WW_PORT ? Number(process.env.WW_PORT) : await freePort();
  const serverPath = app.isPackaged
    ? path.join(process.resourcesPath, "dist", "boot.js")
    : path.resolve(import.meta.dirname, "..", "dist", "boot.js");
  log("serverPath =", serverPath, "| port =", serverPort, "| db =", path.join(userData, "werewolf.db"));
  if (!fs.existsSync(serverPath)) {
    throw new Error(`未找到服务端产物：${serverPath}（请先在项目根目录 npm run build）`);
  }
  log("fork server...");
  server = fork(serverPath, [], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      NODE_ENV: "production",
      PORT: String(serverPort),
      HOST: "127.0.0.1",
      DB_DIALECT: "sqlite",
      SQLITE_PATH: path.join(userData, "werewolf.db"),
      APP_ID: "werewolf-desktop",
      APP_SECRET: cfg.appSecret,
      PRESET_SECRET: cfg.presetSecret,
      OWNER_PASSWORD: cfg.ownerPassword,
    },
    // Electron 内嵌 Node ≥22.5 的 node:sqlite 需此标志（Node 24 上为无害兼容项）
    execArgv: ["--experimental-sqlite"],
    // Electron 的 fork 强制要求 stdio 含 IPC 通道
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  server.stdout.on("data", (d) => log("[srv]", String(d).trim()));
  server.stderr.on("data", (d) => log("[srv!]", String(d).trim()));
  server.on("error", (e) => log("[srv!] fork error:", e?.message ?? e));
  server.on("exit", (code) => {
    log("[srv] exit code", code);
    if (!quitting) {
      dialog.showErrorBox("本地服务退出", `服务进程意外退出（code ${code}），应用即将关闭。`);
      app.quit();
    }
  });

  // 等待服务就绪（最多 30s）
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${serverPort}/api/trpc/ping`);
      if (r.ok) { log("server ready"); return; }
    } catch {
      /* 未就绪 */
    }
    if (Date.now() > deadline) throw new Error("本地服务启动超时（30s）");
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function createMainWindow() {
  const win = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 1100,
    minHeight: 700,
    autoHideMenuBar: true,
    backgroundColor: "#0b0f14",
    title: "AI模拟狼人杀研究平台",
    // 窗口图标：打包版自动用 exe 内嵌图标（electron-builder 由 build/icon.png 生成），开发模式显式指定
    ...(app.isPackaged ? {} : { icon: path.resolve(import.meta.dirname, "build", "icon.png") }),
  });
  await win.loadURL(`http://127.0.0.1:${serverPort}/`);
}

app.whenReady().then(async () => {
  try {
    await startServer();
    await createMainWindow();
    log("window created");
  } catch (e) {
    log("启动失败:", e?.stack ?? e);
    dialog.showErrorBox("启动失败", String(e?.message ?? e));
    app.quit();
  }
});

app.on("second-instance", () => {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isMinimized()) w.restore();
    w.focus();
  }
});
app.on("before-quit", () => {
  quitting = true;
  server?.kill();
});
app.on("window-all-closed", () => {
  server?.kill();
  app.quit();
});
