// API 存档查询层：api_presets 表的增删改查
// 账户体系：存档按 userId 隔离；apiKey 以 AES-256-GCM 密文落库，仅在读出时解密返回给本人
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "./connection";
import { env } from "../lib/env";
import { apiPresets } from "../../db/schema";
import { decryptSecret, encryptSecret } from "../lib/authCrypto";
import type { AiProvider, ApiPreset, ApiPresetInput } from "../../contracts/game";

function toApiPreset(row: typeof apiPresets.$inferSelect): ApiPreset {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider as AiProvider,
    baseUrl: row.baseUrl,
    model: row.model,
    apiKey: decryptSecret(row.apiKey),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listPresets(userId: string): Promise<ApiPreset[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(apiPresets)
    .where(eq(apiPresets.userId, userId))
    .orderBy(desc(apiPresets.updatedAt));
  return rows.map(toApiPreset);
}

export async function createPreset(userId: string, input: ApiPresetInput): Promise<ApiPreset> {
  const db = getDb();
  // 主键回取的方言分叉：MySQL 用 insertId；SQLite 用 RETURNING（双方言表对象同名同构）
  const values = {
    name: input.name,
    provider: input.provider,
    baseUrl: input.baseUrl,
    model: input.model,
    apiKey: encryptSecret(input.apiKey),
    userId,
  };
  const id =
    env.dbDialect === "sqlite"
      ? Number((await db.insert(apiPresets).values(values).returning({ id: apiPresets.id }))[0].id)
      : Number((await db.insert(apiPresets).values(values))[0].insertId);
  const row = await db.select().from(apiPresets).where(eq(apiPresets.id, id));
  return toApiPreset(row[0]);
}

export async function updatePreset(
  id: number,
  userId: string,
  patch: Partial<ApiPresetInput>,
): Promise<ApiPreset | null> {
  const db = getDb();
  await db
    .update(apiPresets)
    .set({
      updatedAt: new Date(), // SQLite 无 onUpdateNow：显式刷新（MySQL 下等价无害）
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.provider !== undefined ? { provider: patch.provider } : {}),
      ...(patch.baseUrl !== undefined ? { baseUrl: patch.baseUrl } : {}),
      ...(patch.model !== undefined ? { model: patch.model } : {}),
      ...(patch.apiKey !== undefined ? { apiKey: encryptSecret(patch.apiKey) } : {}),
    })
    .where(and(eq(apiPresets.id, id), eq(apiPresets.userId, userId)));
  const row = await db
    .select()
    .from(apiPresets)
    .where(and(eq(apiPresets.id, id), eq(apiPresets.userId, userId)));
  return row.length ? toApiPreset(row[0]) : null;
}

export async function deletePreset(id: number, userId: string): Promise<boolean> {
  const db = getDb();
  // 先查后删：sqlite-proxy 驱动拿不到 affectedRows（MySQL 可取 res[0].affectedRows），
  // 「存在性检查 + 删除」在双方言下语义一致
  const existing = await db
    .select({ id: apiPresets.id })
    .from(apiPresets)
    .where(and(eq(apiPresets.id, id), eq(apiPresets.userId, userId)))
    .limit(1);
  if (existing.length === 0) return false;
  await db
    .delete(apiPresets)
    .where(and(eq(apiPresets.id, id), eq(apiPresets.userId, userId)));
  return true;
}
