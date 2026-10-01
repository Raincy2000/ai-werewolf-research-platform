/**
 * owner 账户（用户01）预建与存量数据归属迁移（幂等）。
 * 调用方：
 * - scripts/seed-owner.ts（运维脚本，OWNER_PASSWORD 环境变量传入）
 * - api/boot.ts（桌面客户端 SQLite 首启：users 为空且 OWNER_PASSWORD 存在时自动执行）
 * 注意：密码仅从参数/环境变量读取，绝不硬编码/落盘/打印。
 */
import { eq, isNull } from "drizzle-orm";
import { getDb } from "../queries/connection.js";
import { users, apiPresets, games, guideVersions } from "../../db/schema.js";
import { hashPassword, encryptSecret, isEncrypted } from "./authCrypto.js";
import { DEFAULT_AVATAR } from "../../contracts/auth.js";
import { randomUUID } from "node:crypto";

const OWNER_EMAIL = process.env.OWNER_EMAIL || "owner@example.com"; // 可通过 OWNER_EMAIL 环境变量自定义
const OWNER_USERNAME = "用户01";

export async function runSeedOwner(ownerPassword: string): Promise<void> {
  if (!ownerPassword || ownerPassword.length < 8) {
    throw new Error("owner 密码缺失或过短（≥8 位）");
  }
  const db = getDb();

  // 1) 创建 / 复用 owner 账户
  let [owner] = await db.select().from(users).where(eq(users.email, OWNER_EMAIL)).limit(1);
  if (!owner) {
    const id = randomUUID();
    await db.insert(users).values({
      id,
      email: OWNER_EMAIL,
      username: OWNER_USERNAME,
      avatar: DEFAULT_AVATAR,
      passwordHash: await hashPassword(ownerPassword),
      settings: null,
      createdAt: new Date(),
    });
    [owner] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    console.log("[seed] owner 账户已创建: id=%s username=%s", id, OWNER_USERNAME);
  } else {
    console.log("[seed] owner 账户已存在: id=%s（跳过创建，不重置密码）", owner.id);
  }
  if (!owner) throw new Error("owner 账户创建失败");
  const uid = owner.id;

  // 2) 无主数据归属（drizzle 查询构建器，双方言可移植——原裸 SQL 依赖 mysql 的 db.execute）
  const claim = async (table: any, name: string) => {
    const r = await db.update(table).set({ userId: uid }).where(isNull(table.userId));
    const n = (r as any)[0]?.affectedRows ?? (r as any).affectedRows ?? "?"; // sqlite-proxy 无 affectedRows，仅日志
    console.log("[seed] %s 归属迁移完成，影响行数: %s", name, n);
  };
  await claim(apiPresets, "api_presets");
  await claim(games, "games");
  await claim(guideVersions, "guide_versions");

  // 3) 存量明文 API Key 加密（幂等：跳过已是 v1: 的）
  const rows = await db
    .select({ id: apiPresets.id, apiKey: apiPresets.apiKey })
    .from(apiPresets)
    .where(eq(apiPresets.userId, uid));
  let enc = 0;
  for (const row of rows) {
    if (!row.apiKey || isEncrypted(row.apiKey)) continue;
    await db
      .update(apiPresets)
      .set({ apiKey: encryptSecret(row.apiKey) })
      .where(eq(apiPresets.id, row.id));
    enc++;
  }
  console.log("[seed] 明文 API Key 加密完成: %d 条（共检查 %d 条）", enc, rows.length);

  // 4) games.setup 中明文 seatAIs → seatAIsEnc（幂等）
  const gameRows = await db
    .select({ id: games.id, setup: games.setup })
    .from(games)
    .where(eq(games.userId, uid));
  let genc = 0;
  for (const g of gameRows) {
    const setup = g.setup as any;
    if (!setup || !Array.isArray(setup.seatAIs) || setup.seatAIsEnc) continue;
    setup.seatAIsEnc = encryptSecret(JSON.stringify(setup.seatAIs));
    delete setup.seatAIs;
    await db.update(games).set({ setup }).where(eq(games.id, g.id));
    genc++;
  }
  console.log("[seed] games.setup 席位配置加密完成: %d 条（共检查 %d 条）", genc, gameRows.length);
  console.log("[seed] 全部完成 ✔");
}
