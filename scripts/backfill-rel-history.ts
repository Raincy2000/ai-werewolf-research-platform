// 关系沿革追溯回填执行器（桌面库一次性补史，幂等可重跑）
// 用法（app-clone 目录下）：
//   set DB_DIALECT=sqlite && set SQLITE_PATH=<库路径> && set PRESET_SECRET=<桌面配置> && npx tsx scripts/backfill-rel-history.ts [--dry]
// 复盘/治理脚本，不随开源发布（维护工具）。
import { readFileSync } from "node:fs";

const CONFIG_PATH = process.env.HOME
  ? `${process.env.HOME}/AppData/Roaming/werewolf-desktop/desktop-config.json`
  : "";
try {
  const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  // 桌面端 preset 加密实际走派生路径 sha256("preset-key:"+appSecret)——
  // 必须清掉 .env.local 注入的 PRESET_SECRET（64hex 会优先命中），再让 APP_SECRET 落到桌面值
  delete process.env.PRESET_SECRET;
  process.env.APP_SECRET = cfg.appSecret;
} catch {
  /* 无桌面配置时要求 PRESET_SECRET 已在环境中 */
}
process.env.DB_DIALECT = process.env.DB_DIALECT ?? "sqlite";

const dryRun = process.argv.includes("--dry");
const argVal = (k: string) => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? Number(process.argv[i + 1]) : undefined;
};
const shard = argVal("--shard");
const shards = argVal("--shards");

async function main() {
  const { getDb } = await import("../api/queries/connection");
  const { apiPresets } = await import("../db/schema");
  const { decryptSecret, isEncrypted } = await import("../api/lib/authCrypto");
  const { runHistoryBackfill } = await import("../api/persona/historyBackfill");

  const db = getDb();
  const presets = await db.select().from(apiPresets);
  const usable = presets
    .map((p: typeof apiPresets.$inferSelect) => ({
      ...p,
      apiKey: isEncrypted(p.apiKey) ? decryptSecret(p.apiKey) : p.apiKey,
    }))
    .filter((p) => p.apiKey && p.model);
  // 优先 K3（深读质量），其次任意可用存档
  const pick = usable.find((p) => /k3/i.test(p.model)) ?? usable[0];
  if (!pick) throw new Error("无可用 AI 存档（api_presets 为空或缺 key）");
  console.log(`使用 AI 存档：${pick.name}（${pick.model}）${dryRun ? " [dry-run]" : ""}`);

  const log = await runHistoryBackfill(
    { seat: 0, provider: pick.provider, baseUrl: pick.baseUrl, model: pick.model, apiKey: pick.apiKey },
    { dryRun, shard, shards },
  );
  for (const line of log) console.log(line);
}

main().catch((e) => {
  console.error("回填失败:", e);
  process.exit(1);
});
