#!/usr/bin/env node
/**
 * db:push 安全闸门。
 * 教训（2026-08-02）：drizzle-kit push 对 TiDB 执行了破坏性部分 DDL，
 * 重建了 api_presets 导致存量存档全丢。TiDB 与 drizzle push 的 DDL 不兼容（error 8200）。
 * 因此本项目禁止直接 push：schema 变更一律走「手写增量 SQL 迁移」（仅 ADD COLUMN/CREATE TABLE，禁止 DROP）。
 */
if (process.env.ALLOW_DESTRUCTIVE_PUSH !== "1") {
  console.error(
    [
      "⛔ 已拦截 drizzle-kit push（对 TiDB 有破坏性 DDL 风险，曾导致 api_presets 数据丢失）。",
      "",
      "正确做法：手写增量 SQL 迁移并在数据库手动执行（只允许 CREATE TABLE / ADD COLUMN 等增量操作）。",
      "参考：db/migrations/ 与 scripts/seed-owner.ts 的迁移方式。",
      "",
      "若你完全清楚风险并坚持执行：ALLOW_DESTRUCTIVE_PUSH=1 npm run db:push",
    ].join("\n"),
  );
  process.exit(1);
}
// 显式确认后才放行真正的 drizzle-kit push
require("child_process").spawnSync("npx", ["drizzle-kit", "push"], {
  stdio: "inherit",
  shell: false,
});
