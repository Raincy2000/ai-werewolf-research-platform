/**
 * 一次性迁移脚本（薄封装）：预建 owner 账户（用户01），并把存量无主数据归属到该账户；
 * 同时把存量明文 API Key 加密为 v1: 格式。实现见 api/lib/seedOwner.ts。
 * 用法：OWNER_PASSWORD=... npx tsx scripts/seed-owner.ts
 */
import { runSeedOwner } from "../api/lib/seedOwner.js";

async function main() {
  const pw = process.env.OWNER_PASSWORD;
  if (!pw || pw.length < 8) throw new Error("OWNER_PASSWORD 环境变量缺失或过短");
  await runSeedOwner(pw);
  process.exit(0);
}

main().catch((e) => {
  console.error("[seed] 失败:", e);
  process.exit(1);
});
