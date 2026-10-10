// ============================================================
// 关系沿革追溯回填（铁律3 补史）：人格锚点关系的历史对局逐局蒸馏
// 由来（2026-10-11 用户裁定）：关系沿革不能只从下一局开始记——历史对局的事件日志都在，
// 必须逐局回溯蒸馏出关系变化（标签/增量/注记），按时间重放累计快照。
// 纪律：回填行带 backfill=1 标记（区别于赛后实时回写）；汇总行（persona_relationships）不动；
// 幂等——同一 (persona, target, gameId) 已有历史行则跳过；AI 故障跳过该局绝不阻塞。
// ============================================================

import type { RoleId, SeatAiConfig } from "../../contracts/game";
import { ROLE_META } from "../../contracts/game";
import { callAi } from "../game/ai/providers";
import { parseJsonRobust } from "../game/ai/parse";
import { getDb } from "../queries/connection";
import { games, personaRelationships, personaRelationshipHistory, personas } from "../../db/schema";
import { isNull } from "drizzle-orm";
import { insertPersonaRelationshipHistory } from "../queries/personas";
import { getAllEvents } from "../queries/games";

const BACKFILL_TIMEOUT_MS = 120_000;

export interface BackfillRelation {
  relation: string;
  affinityDelta: number;
  trustDelta: number;
  note: string;
}

/** 追溯蒸馏 prompt：只看这一局，给出 A 对 B 的关系变化 */
export function buildBackfillPrompt(opts: {
  observerName: string;
  observerSeat: number;
  observerRole: string;
  targetName: string;
  targetSeat: number;
  targetRole: string;
  outcome: string;
  titleNo: string;
  digest: string;
}): { system: string; user: string } {
  const system = [
    "你是「记事簿」的补史官——为数字人类心理学实验场补写历史对局的关系沿革。",
    "你只输出结构化 JSON，禁止任何其他文字。",
    "视角铁律：以观察者本人的第一人称立场评估——TA 就是本人，不是扮演。",
  ].join("\n");
  const user = [
    `【对局】标题号「${opts.titleNo}」`,
    `【观察者】${opts.observerName}（本局 ${opts.observerSeat} 号 · ${opts.observerRole}）`,
    `【对象】${opts.targetName}（本局 ${opts.targetSeat} 号 · ${opts.targetRole}）`,
    `【结局】${opts.outcome}`,
    "",
    "【对局公开记录】",
    opts.digest,
    "",
    "【任务】评估这一局里「观察者对对象」的关系变化：",
    '{"relation":"这局形成/变化的关系标签（如 宿敌/同盟/亦敌亦友/敬佩/警惕）","affinityDelta":0,"trustDelta":0,"note":"关键事件一句（第一人称视角，≤60字）"}',
    "规则：affinityDelta/trustDelta 取 -100..100 的增量（被背叛信任大跌、被救信任大涨……）；",
    "两人本局毫无实质交互就返回 null 字符串：{\"relation\":\"\"} ——平庸的同场不产生沿革。",
  ].join("\n");
  return { system, user };
}

/** 解析追溯输出；空 relation 表示本局无实质交互（合法跳过），非法输出返回 null */
export function parseBackfillRelation(text: string): BackfillRelation | "empty" | null {
  const cleaned = text.replace(/```(?:json)?/gi, "");
  const start = cleaned.indexOf("{");
  if (start < 0) return null;
  const end = cleaned.lastIndexOf("}");
  const obj = parseJsonRobust(cleaned.slice(start, end > start ? end + 1 : undefined));
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  const relation = String(o.relation ?? "").trim().slice(0, 32);
  if (!relation) return "empty";
  const clamp = (v: unknown) => {
    const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : 0;
    return Math.max(-100, Math.min(100, n));
  };
  return {
    relation,
    affinityDelta: clamp(o.affinityDelta),
    trustDelta: clamp(o.trustDelta),
    note: String(o.note ?? "").trim().slice(0, 120),
  };
}

// ---------- 回填执行 ----------

interface SeatBinding {
  seat: number;
  personaId: number;
  name: string;
  role?: string;
}

interface GameRowLite {
  id: string;
  titleNo: string;
  winner: string | null;
  createdAt: number;
  bindings: SeatBinding[];
  visibility: string;
  fogSeats: number[];
}

/** 对局摘要（回填专用）：双方相关发言 + 关键事件（死亡/投票/结果），长度封顶 */
function buildBackfillDigest(
  events: { day: number; phase: string; type: string; actor: number | null; title: string; content: string }[],
  seatA: number,
  seatB: number,
  maxChars = 3600,
): string {
  const keyTypes = new Set(["death", "vote", "result"]);
  const lines: string[] = [];
  for (const e of events) {
    const involves = e.actor === seatA || e.actor === seatB;
    if (!involves && !keyTypes.has(e.type)) continue;
    const actor = e.actor != null ? `${e.actor}号` : "系统";
    lines.push(`[第${e.day}天] ${actor}·${e.title}：${e.content.slice(0, 200)}`);
  }
  let out = lines.join("\n");
  // 超长则从尾部保留（后期交互对关系定型更重要），头部保留首夜
  while (out.length > maxChars && lines.length > 6) {
    lines.splice(2, 1);
    out = lines.join("\n");
  }
  return out;
}

const clampSum = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(v)));

function roleLabel(role: string | undefined): string {
  return role ? (ROLE_META[role as RoleId]?.name ?? role) : "未知身份";
}

/**
 * 执行追溯回填：所有人格锚点关系 × 双方同场的历史对局，逐局蒸馏追加历史行。
 * 返回逐行处理日志。dryRun=true 只列计划不写库。
 */
export async function runHistoryBackfill(
  cfg: SeatAiConfig,
  opts?: { dryRun?: boolean; shard?: number; shards?: number },
): Promise<string[]> {
  const log: string[] = [];
  const db = getDb();

  // 1) 人格名册与座位绑定（setup.seatPersonas）
  const personaRows = await db.select().from(personas).where(isNull(personas.deletedAt));
  const personaName = new Map(personaRows.map((p: typeof personas.$inferSelect) => [p.id, p.name as string]));
  const gameRows = await db.select().from(games);
  const gameMap = new Map<string, GameRowLite>();
  for (const g of gameRows) {
    let bindings: SeatBinding[] = [];
    let visibility = "full";
    let fogSeats: number[] = [];
    try {
      // setup 是 JSON mode 列：drizzle 已解析为对象（字符串仅作防御兼容）
      const setup = (typeof g.setup === "string" ? JSON.parse(g.setup) : g.setup) as {
        seatPersonas?: SeatBinding[];
        options?: { personaVisibility?: string; personaFogSeats?: number[] };
        seatRoles?: string[];
      };
      bindings = setup.seatPersonas ?? [];
      visibility = setup.options?.personaVisibility ?? "full";
      fogSeats = setup.options?.personaFogSeats ?? [];
      const roles: string[] = setup.seatRoles ?? [];
      bindings = bindings.map((b) => ({ ...b, role: roles[b.seat - 1] ?? "" }));
    } catch {
      continue;
    }
    if (bindings.length === 0) continue;
    gameMap.set(g.id, {
      id: g.id,
      titleNo: (g.titleNo as string) || g.id.slice(0, 8),
      winner: g.winner as string | null,
      createdAt: Number(g.createdAt),
      bindings,
      visibility,
      fogSeats,
    });
  }

  // 2) 既有历史行（幂等跳过）
  const histRows = await db.select().from(personaRelationshipHistory);
  const hasHist = new Set(histRows.map((h: typeof personaRelationshipHistory.$inferSelect) => `${h.personaId}|${h.targetPersonaId}|${h.gameId}`));

  // 3) 人格锚点关系逐条回溯
  const relRows = await db.select().from(personaRelationships);
  let personaLinked = relRows.filter((r: typeof personaRelationships.$inferSelect) => r.targetPersonaId != null);
  // 分片执行（关系索引取模）：单次运行时长可控，幂等跳过保证可分次续跑
  if (opts?.shards && opts.shards > 1) {
    const shard = opts.shard ?? 0;
    personaLinked = personaLinked.filter((_: unknown, i: number) => i % opts.shards! === shard);
    log.push(`分片 ${shard + 1}/${opts.shards}`);
  }
  log.push(`人格锚点关系 ${personaLinked.length} 条`);

  const clampTrust = (v: number) => clampSum(v, 0, 100);
  const clampAff = (v: number) => clampSum(v, -100, 100);

  // 并发闸：关系之间并行（各关系的重放序列内部仍严格按时间序），上限 4 防撞限流
  const CONCURRENCY = 4;
  let cursor = 0;
  const worker = async () => {
  while (cursor < personaLinked.length) {
    const rel = personaLinked[cursor++]!;
    const observerId = rel.personaId;
    const targetId = rel.targetPersonaId!;
    const observerName = personaName.get(observerId) ?? rel.targetName;
    const targetName = personaName.get(targetId) ?? rel.targetName;
    // 双方同场的对局（按时间正序）；迷雾局跳过（观察者不知对方人格，不产生人格锚点沿革）
    const shared = [...gameMap.values()]
      .filter((g) => {
        const ob = g.bindings.find((b) => b.personaId === observerId);
        const tg = g.bindings.find((b) => b.personaId === targetId);
        if (!ob || !tg) return false;
        if (g.visibility === "none") return false;
        if (g.visibility === "partial" && g.fogSeats.includes(tg.seat)) return false;
        return true;
      })
      .sort((a, b) => a.createdAt - b.createdAt);

    let affinity = 0;
    let trust = 50; // 信任基线（与新关系一致）
    for (const g of shared) {
      if (hasHist.has(`${observerId}|${targetId}|${g.id}`)) continue;
      const ob = g.bindings.find((b) => b.personaId === observerId)!;
      const tg = g.bindings.find((b) => b.personaId === targetId)!;
      const plan = `${observerName} → ${targetName} @ ${g.titleNo}`;
      if (opts?.dryRun) {
        log.push(`计划回填：${plan}`);
        continue;
      }
      const events = await getAllEvents(g.id);
      const digest = buildBackfillDigest(events, ob.seat, tg.seat);
      const prompt = buildBackfillPrompt({
        observerName,
        observerSeat: ob.seat,
        observerRole: roleLabel(ob.role),
        targetName,
        targetSeat: tg.seat,
        targetRole: roleLabel(tg.role),
        outcome: g.winner === "wolf" ? "狼人阵营胜利" : g.winner === "good" ? "神民阵营胜利" : "未知",
        titleNo: g.titleNo,
        digest: digest || "（无相关记录）",
      });
      const res = await callAi(cfg, prompt.system, prompt.user, {
        timeoutMs: BACKFILL_TIMEOUT_MS,
        maxRetries: 1,
      }).catch(() => null);
      const parsed = res?.ok && res.text ? parseBackfillRelation(res.text) : null;
      if (!parsed) {
        log.push(`跳过（AI 不可用/输出非法）：${plan}`);
        continue;
      }
      if (parsed === "empty") {
        log.push(`跳过（本局无实质交互）：${plan}`);
        continue;
      }
      affinity = clampAff(affinity + parsed.affinityDelta);
      trust = clampTrust(trust + parsed.trustDelta);
      await insertPersonaRelationshipHistory({
        personaId: observerId,
        targetPersonaId: targetId,
        targetName,
        gameId: g.id,
        titleNo: g.titleNo,
        relation: parsed.relation,
        affinityDelta: parsed.affinityDelta,
        trustDelta: parsed.trustDelta,
        affinity,
        trust,
        note: parsed.note,
        backfill: true,
      });
      hasHist.add(`${observerId}|${targetId}|${g.id}`);
      log.push(`已回填：${plan}（${parsed.relation} 亲疏${parsed.affinityDelta >= 0 ? "+" : ""}${parsed.affinityDelta} 信任${parsed.trustDelta >= 0 ? "+" : ""}${parsed.trustDelta}）`);
    }
  }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, personaLinked.length) }, () => worker()));
  return log;
}
