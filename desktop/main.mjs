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
  // owner（用户01）初始密码：首启随机生成并保存到本机配置，不在源码中硬编码。
  cfg.ownerPassword = crypto.randomBytes(16).toString("hex");
  cfgDirty = true;
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

// 便携包瞬态启动崩溃（20261013 实锤：首启「Invalid file descriptor to ICU data」
// exit 2147483651/0x80000003——Temp 自解压未完成或杀软占用 ICU 数据文件，第二次启动即正常）：
// 此类崩溃自动重试（最多 2 次、间隔 1s），不让用户看到「本地服务退出」冤枉弹窗
const TRANSIENT_BOOT_EXIT = new Set([2147483651, -1073740791]); // STATUS_BREAKPOINT / STACK_OVERFLOW
const BOOT_MAX_ATTEMPTS = 3;

async function startServer() {
  serverPort = process.env.WW_PORT ? Number(process.env.WW_PORT) : await freePort();
  const serverPath = app.isPackaged
    ? path.join(process.resourcesPath, "dist", "boot.js")
    : path.resolve(import.meta.dirname, "..", "dist", "boot.js");
  log("serverPath =", serverPath, "| port =", serverPort, "| db =", path.join(userData, "werewolf.db"));
  let lastErr = null;
  for (let attempt = 1; attempt <= BOOT_MAX_ATTEMPTS; attempt++) {
    try {
      await startServerOnce(serverPath);
      return;
    } catch (e) {
      lastErr = e;
      if (!e?.transientBoot || attempt >= BOOT_MAX_ATTEMPTS) throw e;
      log(`[boot] 瞬态启动崩溃（code ${e.exitCode}），1s 后自动重试（第 ${attempt + 1}/${BOOT_MAX_ATTEMPTS} 次）`);
      await new Promise((r) => setTimeout(r, 1000));
      serverPort = process.env.WW_PORT ? Number(process.env.WW_PORT) : await freePort();
    }
  }
  throw lastErr ?? new Error("本地服务启动失败");
}

async function startServerOnce(serverPath) {
  // 便携包自解压竞速的另一面（20261014 实锤「未找到服务端产物」弹窗）：
  // 主进程起跑时 Temp 解压尚未进行到 dist/boot.js——轮询等待其出现（最多 60s），
  // 超时才按瞬态故障交给重试圈（重试时解压早已完成，第二轮必过）
  const waitDeadline = Date.now() + 60_000;
  while (!fs.existsSync(serverPath)) {
    if (Date.now() > waitDeadline) {
      const err = new Error(`未找到服务端产物：${serverPath}（便携包解压异常，请重启应用）`);
      err.transientBoot = true; // 交给重试圈
      err.exitCode = "missing-boot";
      throw err;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  // 前端产物自检（历史事故：portable 自解压偶发丢失 dist/public → 界面只显示
  // 「前端构建缺失」，用户无法自助恢复。这里提前判定并给出可操作提示）
  const publicDir = path.join(path.dirname(serverPath), "public");
  const publicIndex = path.join(publicDir, "index.html");
  if (!fs.existsSync(publicIndex)) {
    // ★ 自愈：便携包自解压偶发丢失 dist/public（历史事故 2026-10-21）。
    // asar 内随包备份了一份前端产物（build.files 含 dist/public/**），
    // 这里从 asar 恢复出来，用户无需重装。
    log("⚠️ 前端产物缺失，尝试从 asar 自愈:", publicIndex);
    try {
      const backupDir = path.join(app.getAppPath(), "dist", "public");
      if (fs.existsSync(path.join(backupDir, "index.html"))) {
        fs.cpSync(backupDir, publicDir, { recursive: true });
        log("✅ 已从 asar 恢复前端产物 →", publicDir);
      } else {
        log("❌ asar 备份也不存在:", backupDir);
      }
    } catch (e) {
      log("❌ asar 自愈失败:", String(e));
    }
  }
  if (!fs.existsSync(publicIndex)) {
    const err = new Error(
      "客户端解压不完整（缺少前端文件），且自动恢复失败。\n请关闭程序后重新运行安装包。",
    );
    err.transientBoot = true;
    err.exitCode = "missing-public";
    throw err;
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
  const self = server;
  let died = null; // 非 null = 进程已退出（就绪前崩溃的退出码）
  server.on("exit", (code) => {
    log("[srv] exit code", code);
    died = code;
    if (quitting) return;
    // 就绪前的瞬态崩溃：交给重试循环（弹窗只留给真正救不回来的情况）
    if (!readyFired && TRANSIENT_BOOT_EXIT.has(Number(code))) return;
    if (!readyFired) return; // 非瞬态的启动期崩溃由 startServerOnce 的超时路径统一报错
    dialog.showErrorBox("本地服务退出", `服务进程意外退出（code ${code}），应用即将关闭。`);
    app.quit();
  });

  // 等待服务就绪（最多 30s；进程退出即时放行给重试判定，不干等）
  let readyFired = false;
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (died !== null) {
      const err = new Error(`服务进程启动期退出（code ${died}）`);
      err.transientBoot = TRANSIENT_BOOT_EXIT.has(Number(died));
      err.exitCode = died;
      throw err;
    }
    try {
      const r = await fetch(`http://127.0.0.1:${serverPort}/api/trpc/ping`);
      if (r.ok) {
        log("server ready");
        readyFired = true;
        return;
      }
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
