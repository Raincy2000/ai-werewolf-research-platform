// 端到端冒烟：mock AI 服务器 + 真实服务全链路 + 信息壁垒实测
// 用法: 先 npm run build，再 node scripts/smoke-e2e.mjs
import http from "node:http";
import { spawn } from "node:child_process";

const APP_PORT = 3111;
const MOCK_PORT = 8611;
const BASE = `http://127.0.0.1:${APP_PORT}/api/trpc`;

const captured = []; // {seat, system, user}
let callSeq = 0;

// ---------- mock OpenAI 兼容服务器 ----------
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

    // 解析合法目标
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
    const marker = `THOUGHT-${callSeq}-seat${seat}-${Math.random().toString(36).slice(2, 8)}`;
    const payload = {
      thought: marker,
      speech: needSpeech ? `我是${seat}号玩家，这轮我观察到局势很微妙，建议大家理性分析票型，我过。` : undefined,
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

// ---------- tRPC 客户端 ----------
// 账户体系：game.create 等接口需登录（authedProcedure）——注册冒烟专用用户后全程 Bearer 头
let TOKEN = null;
const authHeaders = () => (TOKEN ? { authorization: `Bearer ${TOKEN}` } : {});

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await new Promise((r) => mock.listen(MOCK_PORT, r));
  console.log(`mock AI server on :${MOCK_PORT}`);

  // 启动应用服务器（已构建 dist/boot.js）
  server = spawn("node", ["dist/boot.js"], {
    env: { ...process.env, PORT: String(APP_PORT), NODE_ENV: "production" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stderr.on("data", (d) => process.stderr.write(`[srv] ${d}`));
  // 等待端口
  let up = false;
  for (let i = 0; i < 60; i++) {
    try { await trpcQuery("ping", undefined); up = true; break; } catch { await sleep(500); }
  }
  if (!up) throw new Error("app server failed to start");
  console.log("app server up");

  // 注册冒烟专用用户（账户体系：对局创建需登录态）
  const email = `smoke-${Date.now()}@local.test`;
  const reg = await trpcMutate("auth.register", { email, password: "smoke-pass-123", username: "冒烟测试" });
  TOKEN = reg.sessionToken;
  if (!TOKEN) throw new Error("auth.register 未返回 sessionToken");
  console.log("smoke user registered:", email);

  // 创建对局：9人标准局（快），全部座位用 custom 指向 mock
  const boards = await trpcQuery("game.boards", undefined);
  const board = boards.find((b) => b.id === (process.env.BOARD_ID || "standard9"));
  if (!board) throw new Error("standard9 board missing");
  const seats = Array.from({ length: board.playerCount }, (_, i) => ({
    seat: i + 1,
    provider: "custom",
    baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`,
    model: "mock-model",
    apiKey: "sk-mock",
  }));
  const { gameId } = await trpcMutate("game.create", {
    boardId: process.env.BOARD_ID || "standard9",
    seats,
    options: { stepDelayMs: 250, sheriffEnabled: process.env.SHERIFF !== "0", allowSelfDestruct: true, speechRoundsLimit: 2 },
  });
  console.log("game created:", gameId);

  await trpcMutate("game.control", { gameId, action: "start" });
  console.log("game started");

  // 轮询直到结束
  let afterSeq = 0, lastSnap = null, totalEvents = 0, pauseTested = false;
  const deadline = Date.now() + 8 * 60 * 1000;
  while (Date.now() < deadline) {
    const { snapshot, events } = await trpcQuery("game.poll", { gameId, afterSeq });
    lastSnap = snapshot;
    if (events.length) {
      totalEvents += events.length;
      afterSeq = events[events.length - 1].seq;
      const last = events[events.length - 1];
      console.log(`  [seq ${last.seq}] day${snapshot.day} ${snapshot.phaseLabel} | +${events.length} events | last: ${last.title}`);
    }
    if (snapshot.status === "finished") break;
    // 中途测试一次暂停/恢复
    if (!pauseTested && totalEvents > 30 && snapshot.status === "running") {
      pauseTested = true;
      await trpcMutate("game.control", { gameId, action: "pause" });
      const p1 = await trpcQuery("game.poll", { gameId, afterSeq });
      if (p1.snapshot.status !== "paused") throw new Error("pause failed");
      console.log("  pause OK, resume...");
      await trpcMutate("game.control", { gameId, action: "start" });
    }
    await sleep(400);
  }
  if (!lastSnap || lastSnap.status !== "finished") throw new Error("game did not finish in time");
  console.log(`\n=== game finished: winner=${lastSnap.winner}, days=${lastSnap.day}, events=${totalEvents}, aiCalls=${callSeq} ===`);

  // 导出
  const exp = await trpcQuery("game.export", { gameId });
  if (!exp.events || exp.events.length < totalEvents) throw new Error("export events mismatch");
  console.log(`export OK: ${exp.events.length} events`);

  // ---------- 信息壁垒断言 ----------
  const violations = [];
  // 1) thought 唯一标记绝不回灌到「他人」prompt（对局笔记：本人 prompt 含本人想法合法）
  for (const c of captured) {
    const text = c.system + "\n" + c.user;
    const alien = [...text.matchAll(/THOUGHT-\d+-seat(\d+)-[a-z0-9]+/g)].some(
      (m) => Number(m[1]) !== c.seat,
    );
    if (alien) {
      violations.push(`alien thought marker echoed into prompt for seat ${c.seat}`);
    }
  }
  // 2) 结构泄漏检查
  for (const c of captured) {
    const text = c.system + "\n" + c.user;
    if (text.includes("seatRoles")) violations.push(`seatRoles leaked to seat ${c.seat}`);
    const isWolf = /身份是【(狼人|狼王|白狼王|石像鬼|噩梦之影|血月使徒|隐狼|机械狼)】/.test(c.system);
    if (!isWolf && text.includes("你的狼队友")) {
      violations.push(`wolf teammates leaked to non-wolf seat ${c.seat}`);
    }
    const isWitch = /身份是【女巫】/.test(c.system);
    if (!isWitch && /今夜 \d+号 被狼人袭击/.test(text)) {
      violations.push(`witch victim info leaked to seat ${c.seat}`);
    }
  }

  server.kill();
  mock.close();
  await sleep(500); // 等被终止子进程的句柄收尾，避免 Windows 上退出断言

  if (violations.length) {
    console.error("\n!!! 信息壁垒违规 !!!");
    violations.slice(0, 20).forEach((v) => console.error(" -", v));
    process.exit(1);
  }
  console.log("\n信息壁垒断言全部通过");
  console.log(`AI 调用次数: ${callSeq}, 捕获 prompt: ${captured.length}`);
  process.exit(0);
}

let server;

main().catch(async (e) => {
  console.error("SMOKE FAIL:", e);
  try { server?.kill(); } catch { /* 忽略 */ }
  try { mock.close(); } catch { /* 忽略 */ }
  await sleep(500);
  process.exit(1);
});
