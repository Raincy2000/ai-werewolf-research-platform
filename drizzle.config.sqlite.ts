import { defineConfig } from "drizzle-kit";

// SQLite 方言迁移生成（桌面客户端建库用；生成产物经整理后内嵌 db/sqlite-ddl.ts）：
//   npx drizzle-kit generate --config drizzle.config.sqlite.ts
// 纯离线生成，不需要 DATABASE_URL。
export default defineConfig({
  schema: "./db/schema.sqlite.ts",
  out: "./db/migrations-sqlite",
  dialect: "sqlite",
});
