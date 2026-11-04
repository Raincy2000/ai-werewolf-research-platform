// ============================================================
// L2 持久层：昵称文本索引（§17.9）
// 权威数据在 personas.profile.nicknames；本表只是**物化索引**
// ⚠️ 只索引 awareness = all 的（公开/亲密层）；隐私层不进索引
// ============================================================
import { eq, inArray } from "drizzle-orm";
import { getDb } from "../../../queries/connection";
import { insertIgnore } from "../../../queries/dialect";
import { personaNicknameIndex } from "../../../../db/schema";
import type { Nickname } from "../../../../contracts/interpersonal";

/** 重建某人格的昵称索引（幂等：先删后插） */
export async function rebuildNicknameIndex(personaId: number, nicknames: Nickname[]): Promise<number> {
  const db = getDb();
  await db.delete(personaNicknameIndex).where(eq(personaNicknameIndex.personaId, personaId));
  const visible = nicknames.filter((n) => n.awareness === "all" && String(n.text || "").trim());
  if (visible.length === 0) return 0;
  let n = 0;
  for (const nk of visible) {
    try {
      await insertIgnore(personaNicknameIndex, { personaId, text: nk.text.trim(), layer: nk.layer });
      n++;
    } catch {
      /* 同人格内重复昵称跳过，不阻塞其余 */
    }
  }
  return n;
}

/** 按昵称文本找到人格（识别用） */
export async function findPersonaByNickname(text: string): Promise<number | null> {
  const db = getDb();
  const rows = await db
    .select({ personaId: personaNicknameIndex.personaId })
    .from(personaNicknameIndex)
    .where(eq(personaNicknameIndex.text, text.trim()))
    .limit(1);
  return rows.length ? rows[0]!.personaId : null;
}

/** 批量解析多个名字 → personaId 映射 */
export async function resolveNicknames(texts: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const clean = [...new Set(texts.map((t) => t.trim()).filter(Boolean))];
  if (clean.length === 0) return out;
  const db = getDb();
  const rows = await db
    .select({ text: personaNicknameIndex.text, personaId: personaNicknameIndex.personaId })
    .from(personaNicknameIndex)
    .where(inArray(personaNicknameIndex.text, clean));
  for (const r of rows) out.set(r.text, r.personaId);
  return out;
}

/** 列出某人格的索引条目 */
export async function listNicknameIndex(personaId: number) {
  const db = getDb();
  return db.select().from(personaNicknameIndex).where(eq(personaNicknameIndex.personaId, personaId));
}
