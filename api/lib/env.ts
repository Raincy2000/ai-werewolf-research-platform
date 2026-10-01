// 本地开发覆盖：.env.local 优先于 .env 加载（dotenv 默认不覆盖已存在的变量，
// 先加载者生效）。生产环境跳过 .env.local——部署包不含该文件，防止误用本地配置。
import { config } from "dotenv";

if (process.env.NODE_ENV !== "production") {
  config({ path: ".env.local" });
}
config();

function required(name: string): string {
  const value = process.env[name];
  if (!value && process.env.NODE_ENV === "production") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value ?? "";
}

export const env = {
  appId: required("APP_ID"),
  appSecret: required("APP_SECRET"),
  isProduction: process.env.NODE_ENV === "production",
  // DB_DIALECT=sqlite 时走桌面客户端的本地 SQLite（node:sqlite），DATABASE_URL 不再必需
  dbDialect: process.env.DB_DIALECT === "sqlite" ? ("sqlite" as const) : ("mysql" as const),
  sqlitePath: process.env.SQLITE_PATH ?? "data/werewolf.db",
  databaseUrl:
    process.env.DB_DIALECT === "sqlite" ? (process.env.DATABASE_URL ?? "") : required("DATABASE_URL"),
};
