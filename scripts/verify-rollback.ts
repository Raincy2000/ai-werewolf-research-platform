// 回溯手术验证：在桌面库副本上重放决策日志，校验与事件流一致
// 用法：app-clone 目录下 SQLITE_PATH=../../tmp-audit/rollback-verify.db npx tsx ../tmp-audit/verify-rollback.ts
process.env.DB_DIALECT = "sqlite";
process.env.SQLITE_PATH = process.env.SQLITE_PATH ?? "../../tmp-audit/rollback-verify.db";

const { getGame, getAllEvents } = await import("../api/queries/games");
const { getDecisions } = await import("../api/queries/decisions");

const GAME_ID = process.env.VERIFY_GAME_ID ?? "9bb07675-a883-4cf2-b04a-ca3942cfa524";

const row = await getGame(GAME_ID);
const events = await getAllEvents(GAME_ID);
const decisions = await getDecisions(GAME_ID);
console.log(`库状态: status=${row?.status} winner=${row?.winner} 事件=${events.length} 决策=${decisions.length}`);
console.log(`末事件: seq${events.at(-1)?.seq} 「${events.at(-1)?.title}」${events.at(-1)?.actor ?? ""}号`);
console.log(`末决策: idx${decisions.at(-1)?.idx} ${decisions.at(-1)?.kind} seat${decisions.at(-1)?.seat}`);

const { createEngine } = await import("../api/game/engine/index");
const setup = (typeof row!.setup === "string" ? JSON.parse(row!.setup as string) : row!.setup) as {
  seatRoles: never[];
  options: Record<string, unknown>;
};
const engine = createEngine({ boardId: row!.boardId, seatRoles: setup.seatRoles, options: setup.options });

const produced: { title: string; actor: number | null }[] = [];
let consumedCount = 0;
let pending = null as null | { kind: string; seat: number };
for (let step = 0; step < 500; step++) {
  if (!pending) {
    const r = engine.advance();
    for (const e of r.events) produced.push({ title: e.title, actor: e.actor });
    pending = r.pending;
    if (!pending) break;
    continue;
  }
  const next = decisions[consumedCount];
  if (!next) break; // 日志用尽：引擎停在此处待决（手术的恢复点）
  if (next.kind !== pending.kind) {
    console.error(`❌ 分叉：引擎待决 ${pending.kind}@${pending.seat}，日志 idx${next.idx}=${next.kind}@${next.seat}`);
    process.exit(1);
  }
  const evs = engine.decide(next.decision as never);
  for (const e of evs) produced.push({ title: e.title, actor: e.actor });
  consumedCount++;
  pending = null;
}

console.log(`重放：消费决策 ${consumedCount}/${decisions.length}，引擎产出事件 ${produced.length}（库 ${events.length}）`);
if (consumedCount !== decisions.length) {
  console.error("❌ 决策日志未消费完");
  process.exit(1);
}
const libTitles = events.map((e) => `${e.title}@${e.actor ?? "-"}`);
const prodTitles = produced.map((e) => `${e.title}@${e.actor ?? "-"}`);
let mismatch = 0;
for (let i = 0; i < Math.max(libTitles.length, prodTitles.length); i++) {
  if (libTitles[i] !== prodTitles[i]) {
    if (mismatch++ < 5) console.error(`  差异#${i}: 库=${libTitles[i]} 重放=${prodTitles[i]}`);
  }
}
if (mismatch) {
  console.error(`❌ 事件序列不一致 ${mismatch} 处`);
  process.exit(1);
}
console.log(`✅ 重放一致。恢复点待决：${pending ? `${pending.kind}@${pending.seat}号` : "（引擎已走尽）"}`);
