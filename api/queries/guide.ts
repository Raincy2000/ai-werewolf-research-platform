import { and, eq, desc, count } from "drizzle-orm";
import { guideVersions, gameAnalyses } from "../../db/schema";

// 连接层延迟加载：本模块在单元测试中被 vi.mock 整体替换，而 connection.ts 顶层
// 使用 @db/* 别名（vitest 无此别名映射）。顶层静态 import 它会导致未 mock 本模块
// 的既有测试在加载期崩溃；延迟到首次真正查询时再加载则互不影响。
async function db() {
  const { getDb } = await import("./connection");
  return getDb();
}

// ---------- 经验指南版本（账户体系：按 userId+scope 双重隔离；scope: common=共通，其余=版型 id） ----------
export async function getLatestGuide(userId: string, scope: string) {
  const rows = await (await db())
    .select()
    .from(guideVersions)
    .where(and(eq(guideVersions.userId, userId), eq(guideVersions.scope, scope)))
    .orderBy(desc(guideVersions.version))
    .limit(1);
  return rows[0] ?? null;
}

export async function countGuides(userId: string, scope: string) {
  const rows = await (await db())
    .select({ value: count() })
    .from(guideVersions)
    .where(and(eq(guideVersions.userId, userId), eq(guideVersions.scope, scope)));
  return rows[0]?.value ?? 0;
}

export async function insertGuideVersion(row: typeof guideVersions.$inferInsert) {
  await (await db()).insert(guideVersions).values(row);
}

export async function listGuideVersions(userId: string, scope: string, limit = 50) {
  return (await db())
    .select()
    .from(guideVersions)
    .where(and(eq(guideVersions.userId, userId), eq(guideVersions.scope, scope)))
    .orderBy(desc(guideVersions.version))
    .limit(limit);
}

export async function getGuideVersion(userId: string, scope: string, version: number) {
  const rows = await (await db())
    .select()
    .from(guideVersions)
    .where(
      and(
        eq(guideVersions.userId, userId),
        eq(guideVersions.scope, scope),
        eq(guideVersions.version, version),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

// 列出该用户所有已有指南的 distinct scope（"common" 与各版型 id）
export async function listGuideScopes(userId: string): Promise<string[]> {
  const rows = await (await db())
    .selectDistinct({ scope: guideVersions.scope })
    .from(guideVersions)
    .where(eq(guideVersions.userId, userId));
  return rows.map((r: { scope: string }) => r.scope);
}

// ---------- 对局分析报告（同 gameId 覆盖；访问控制由服务层按对局归属把关） ----------
export async function getAnalysis(gameId: string) {
  const rows = await (await db())
    .select()
    .from(gameAnalyses)
    .where(eq(gameAnalyses.gameId, gameId))
    .limit(1);
  return rows[0] ?? null;
}

export async function upsertAnalysis(gameId: string, report: string, model: string) {
  const existing = await getAnalysis(gameId);
  if (existing) {
    await (await db())
      .update(gameAnalyses)
      .set({ report, model })
      .where(eq(gameAnalyses.gameId, gameId));
  } else {
    await (await db()).insert(gameAnalyses).values({ gameId, report, model });
  }
}
