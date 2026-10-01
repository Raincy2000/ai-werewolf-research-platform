// 桌面客户端服务端 E2E：SQLite 方言 + 自动建户 + mock AI 完整对局 + 库文件断言
// 用法：npm run build 后 node scripts/desktop-e2e.mjs
import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const APP_PORT = 3113;
const MOCK_PORT = 8613;
const BASE = `http://127.0.0.1:${APP_PORT}/api/trpc`;
const DATA_DIR = path.resolve("tmp/desktop-e2e-data");
const DB_FILE = path.join(DATA_DIR, "werewolf.db");

const captured = [];
let callSeq = 0;
let TOKEN = null;
const authHeaders = () => (TOKEN ? { authorization: `Bearer ${TOKEN}` } : {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- mock OpenAI 兼容服务器（与 smoke-e2e 同款） ----------
const mock = http.createServer((req, res) => {
  if (req.method !== "POST") { res.writeHead(404); res.end(); return; }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    callSeq++;
    let parsed;
    try { parsed = JSON.parse(body); } catch { parsed = {}; }
    const msgs = parsed.messages ?? [];
    const sys = msgs.find((m) => m.role === "system")?.content ?? "";
    const user = msgs.find((m) => m.role === "user")?.content ?? "";
    const seatMatch = sys.match(/座位号(\d+)号/);
    const seat = seatMatch ? Number(seatMatch[1]) : -1;
    captured.push({ seat, system: sys, user });

    let targets = [];
    if (/参与竞选/.test(user)) {
      targets = [Math.random() < 0.6 ? 1 : 0];
    } else {
      const m = user.match(/【合法目标】([0-9号、]+)/);
      if (m) {
        const nums = [...m[1].matchAll(/(\d+)号/g)].map((x) => Number(x[1]));
        if (nums.length) targets = [nums[Math.floor(Math.random() * nums.length)]];
      }
    }
    const allowSkip = /允许放弃/.test(user);
    const skip = allowSkip && Math.random() < 0.3;
    if (skip) targets = [];
    const needSpeech = /speech 必填/.test(user);
    const payload = {
      thought: `THOUGHT-${callSeq}-seat${seat}`,
      speech: needSpeech ? `我是${seat}号玩家，这轮我观察到局势很微妙，我过。` : undefined,
      targets,
      skip,
      selfDestruct: false,
      duel: null,
      witchSave: /解药/.test(user) && Math.random() < 0.5,
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "chatcmpl-mock",
      choices: [{ message: { role: "assistant", content: JSON.stringify(payload) }, finish_reason: "stop" }],
      usage: { total_tokens: 10 },
    }));
  });
});

async function trpcQuery(path, input) {
  const url = `${BASE}/${path}?input=${encodeURIComponent(JSON.stringify({ json: input }))}`;
  const r = await fetch(url, { headers: authHeaders() });
  const j = await r.json();
  if (j.error) throw new Error(`${path}: ${JSON.stringify(j.error).slice(0, 300)}`);
  return j.result.data.json;
}
async function trpcMutate(path, input) {
  const r = await fetch(`${BASE}/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify({ json: input }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${path}: ${JSON.stringify(j.error).slice(0, 300)}`);
  return j.result.data.json;
}

let server;
async function main() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  await new Promise((r) => mock.listen(MOCK_PORT, r));
  console.log(`mock AI server on :${MOCK_PORT}`);

  // 与桌面主进程一致的环境（SQLite 方言 + 自动建户）
  server = spawn("node", ["--experimental-sqlite", "dist/boot.js"], {
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(APP_PORT),
      HOST: "127.0.0.1",
      DB_DIALECT: "sqlite",
      SQLITE_PATH: DB_FILE,
      APP_ID: "werewolf-desktop",
      APP_SECRET: "desktop-e2e-app-secret",
      PRESET_SECRET: "desktop-e2e-preset-secret",
      OWNER_PASSWORD: "desktop-e2e-owner-password",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stderr.on("data", (d) => process.stderr.write(`[srv] ${d}`));
  let up = false;
  for (let i = 0; i < 60; i++) {
    try { await trpcQuery("ping", undefined); up = true; break; } catch { await sleep(500); }
  }
  if (!up) throw new Error("app server failed to start");
  console.log("app server up (sqlite dialect)");

  // 1) 首启自动建户：用户01 直接可登录
  const login = await trpcMutate("auth.login", { email: "owner@example.com", password: "desktop-e2e-owner-password", remember: true });
  TOKEN = login.sessionToken;
  if (login.user?.username !== "用户01") throw new Error("自动建户失败：" + JSON.stringify(login.user));
  console.log("✔ 用户01 自动建户并登录");

  // 2) 创建并打完整局（mock AI 全部座位）
  const seats = Array.from({ length: 9 }, (_, i) => ({
    seat: i + 1, provider: "custom", baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`, model: "mock-model", apiKey: "sk-mock",
  }));
  const { gameId } = await trpcMutate("game.create", {
    boardId: "standard9", seats,
    options: { stepDelayMs: 250, sheriffEnabled: true, allowSelfDestruct: true, speechRoundsLimit: 2 },
  });
  await trpcMutate("game.control", { gameId, action: "start" });
  console.log("✔ 对局创建并启动:", gameId);

  let afterSeq = 0, lastSnap = null, totalEvents = 0;
  const deadline = Date.now() + 8 * 60 * 1000;
  while (Date.now() < deadline) {
    const { snapshot, events } = await trpcQuery("game.poll", { gameId, afterSeq });
    lastSnap = snapshot;
    if (events.length) {
      totalEvents += events.length;
      afterSeq = events[events.length - 1].seq;
    }
    if (snapshot.status === "finished") break;
    await sleep(400);
  }
  if (!lastSnap || lastSnap.status !== "finished") throw new Error("game did not finish in time");
  console.log(`✔ 完整对局结束: winner=${lastSnap.winner}, days=${lastSnap.day}, events=${totalEvents}, aiCalls=${callSeq}`);

  // 3) SQLite 库文件直接断言（对局大数据确在本地文件）
  server.kill();
  await sleep(800);
  const raw = new DatabaseSync(DB_FILE, { readOnly: true });
  const counts = {
    games: raw.prepare("SELECT COUNT(*) c FROM games").get().c,
    events: raw.prepare("SELECT COUNT(*) c FROM game_events").get().c,
    decisions: raw.prepare("SELECT COUNT(*) c FROM game_decisions").get().c,
    users: raw.prepare("SELECT COUNT(*) c FROM users").get().c,
  };
  raw.close();
  if (counts.games !== 1 || counts.events !== totalEvents || counts.decisions < 1 || counts.users !== 1) {
    throw new Error("SQLite 库文件断言失败: " + JSON.stringify({ counts, totalEvents }));
  }
  console.log("✔ SQLite 库文件断言:", JSON.stringify(counts));

  // 4) 信息壁垒断言（同 smoke）；对局笔记机制下本人 prompt 含本人历史想法为合法，
  // 仅「他人想法标记」算壁垒违规
  const violations = [];
  for (const c of captured) {
    const text = c.system + "\n" + c.user;
    const alien = [...text.matchAll(/THOUGHT-\d+-seat(\d+)/g)].some(
      (m) => Number(m[1]) !== c.seat,
    );
    if (alien) violations.push(`alien thought echoed to seat ${c.seat}`);
    if (text.includes("seatRoles")) violations.push(`seatRoles leaked to seat ${c.seat}`);
  }
  if (violations.length) throw new Error("信息壁垒违规: " + violations.slice(0, 3).join(" | "));
  console.log("✔ 信息壁垒断言通过");

  mock.close();
  await sleep(500);
  console.log("\n=== 桌面服务端 E2E 全部通过 ===");
  process.exit(0);
}

main().catch(async (e) => {
  console.error("DESKTOP E2E FAIL:", e);
  try { server?.kill(); } catch { /* 忽略 */ }
  try { mock.close(); } catch { /* 忽略 */ }
  await sleep(500);
  process.exit(1);
});
