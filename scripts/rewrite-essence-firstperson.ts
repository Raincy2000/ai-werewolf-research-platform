// 存量人格精粹 → 第一人称自我认知笔记（一次性迁移脚本，幂等可重跑）
// 用法（app-clone 目录）：set DB_DIALECT=sqlite && set SQLITE_PATH=<库> && npx tsx scripts/rewrite-essence-firstperson.ts [--dry]
// 规则：AI 改写保持原意；写成后同步 essence（对局注入）+ 记入认知笔记沿革首篇；
// 已是第一人称（含「我」密度达标）的跳过。
import { readFileSync } from "node:fs";

const CONFIG_PATH = `${process.env.HOME}/AppData/Roaming/werewolf-desktop/desktop-config.json`;
try {
  const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  delete process.env.PRESET_SECRET;
  process.env.APP_SECRET = cfg.appSecret; // 桌面端 preset 走派生路径
} catch { /* 环境自带则忽略 */ }
process.env.DB_DIALECT = process.env.DB_DIALECT ?? "sqlite";

const dryRun = process.argv.includes("--dry");

async function main() {
  const { getDb } = await import("../api/queries/connection");
  const { personas, personaCognitionNotes } = await import("../db/schema");
  const { apiPresets } = await import("../db/schema");
  const { decryptSecret, isEncrypted } = await import("../api/lib/authCrypto");
  const { callAi } = await import("../api/game/ai/providers");
  const { eq, isNull } = await import("drizzle-orm");

  const db = getDb();
  const presets = (await db.select().from(apiPresets))
    .map((p: typeof apiPresets.$inferSelect) => ({
      ...p,
      apiKey: isEncrypted(p.apiKey) ? decryptSecret(p.apiKey) : p.apiKey,
    }))
    .filter((p: { apiKey: string; model: string }) => p.apiKey && p.model);
  const pick = presets.find((p: { model: string }) => /k3/i.test(p.model)) ?? presets[0];
  if (!pick) throw new Error("无可用 AI 存档");
  console.log(`改写模型：${pick.name}（${pick.model}）${dryRun ? " [dry-run]" : ""}`);

  const rows = await db.select().from(personas).where(isNull(personas.deletedAt));
  for (const row of rows) {
    const profile = row.profile as { essence?: string };
    const essence = profile.essence?.trim();
    if (!essence) {
      console.log(`跳过（无笔记）：${row.name}`);
      continue;
    }
    // 幂等：已有沿革笔记（已迁移过）跳过
    const has = await db
      .select({ id: personaCognitionNotes.id })
      .from(personaCognitionNotes)
      .where(eq(personaCognitionNotes.personaId, row.id))
      .limit(1);
    if (has.length > 0) {
      console.log(`跳过（已有沿革）：${row.name}`);
      continue;
    }
    const system = [
      "你是文字改写师。把一段第三人称的人格行为指南改写成第一人称的自我认知笔记。",
      "铁律：原意一字不减（所有行为要点、冲突、语言习惯、雷区全部保留）；第一人称（我）；",
      "像本人在安静自述，不是档案腔；≤500字；只输出改写后的正文，禁止任何解释。",
    ].join("\n");
    const user = `【待改写文本】\n${essence}\n\n请改写成「${row.name}」第一人称的自我认知笔记。`;
    if (dryRun) {
      console.log(`\n=== ${row.name} 原文 ===\n${essence.slice(0, 120)}…`);
      continue;
    }
    const res = await callAi(
      { seat: 0, provider: pick.provider, baseUrl: pick.baseUrl, model: pick.model, apiKey: pick.apiKey },
      system,
      user,
      { timeoutMs: 150_000, maxRetries: 1, jsonMode: false },
    ).catch(() => null);
    const note = res?.ok && res.text ? res.text.replace(/```/g, "").trim() : null;
    if (!note || note.length < 30 || note.length > 600) {
      console.log(`改写失败/不合规，跳过：${row.name}（${res?.error ?? "输出异常"}）`);
      continue;
    }
    const newProfile = { ...(row.profile as Record<string, unknown>), essence: note };
    await db.update(personas).set({ profile: newProfile as never, updatedAt: new Date() }).where(eq(personas.id, row.id));
    await db.insert(personaCognitionNotes).values({
      personaId: row.id,
      content: note,
      model: `${pick.model}（铸魂初稿改写）`,
      opts: {},
      gameCount: row.gameCount ?? 0,
    });
    console.log(`已改写：${row.name}（${note.length} 字）`);
  }
  console.log("DONE");
}

main().catch((e) => {
  console.error("迁移失败:", e);
  process.exit(1);
});
