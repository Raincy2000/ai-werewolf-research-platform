// ============================================================
// 拍刀审核：分析师 AI 以官方规则、完整进程和真实技能存量推演合法后续。
// unavailable 仅表示无法完成审核，绝不等于狼队失败。
// ============================================================

import type { GameEvent } from "../../contracts/game";
import { BOARDS, ROLE_META } from "../../contracts/game";
import { getAllEvents } from "../queries/games";
import { callAi } from "./ai/providers";
import { isThinkingModel } from "./ai/modelCaps";
import { parseJsonRobust } from "./ai/parse";
import { buildBoardRulesText } from "./analyst";
import { buildPostgamePublicEvidenceIndex, formatEvidenceRefs } from "./evidence";
import type { GameRuntime } from "./service";

export type VictoryAuditOutcome = "pass" | "reject" | "unavailable";
export interface VictoryAiAuditResult {
  outcome: VictoryAuditOutcome;
  reason: string;
}

function parseVerdict(text: string): VictoryAiAuditResult | null {
  const cleaned = text.replace(/```(?:json)?/gi, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  const obj = parseJsonRobust(cleaned.slice(start, end + 1));
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const record = obj as Record<string, unknown>;
  const outcome = record.verdict === "wolf_win" ? "pass" : record.verdict === "not_guaranteed" ? "reject" : null;
  if (!outcome) return null;
  return { outcome, reason: typeof record.reason === "string" && record.reason.trim() ? record.reason.trim().slice(0, 600) : "（分析师未附理由）" };
}

export function buildVictoryAiAuditPrompt(rt: GameRuntime, events: GameEvent[]): { system: string; user: string } {
  const snap = rt.engine.getSnapshot();
  const playerLines = snap.players.map((p) => {
    const status = p.alive ? "存活" : `出局（${p.deathInfo ?? "原因未知"}）`;
    return `${p.seat}号 ${ROLE_META[p.role]?.name ?? p.role}（${p.camp}）：${status}${p.sheriff ? "，警长" : ""}；技能存量：${p.stock.length ? p.stock.join("、") : "无"}`;
  });
  const facts = formatEvidenceRefs(buildPostgamePublicEvidenceIndex("", events), "完整对局进程（含夜间行动，分析师上帝视角）");
  const system = [
    "你是狼人杀拍刀审核分析师，拥有上帝视角。你的任务不是估胜率，而是判断狼队此刻宣布提前胜利是否已经必然成立。",
    "必须逐项推演所有合法后续：放逐狼、放逐神民、平票、骑士决斗、守卫守护、女巫用药、狼人自爆及夜间刀口。只要存在一条符合规则的反制路径，就不能放行。",
    "只依据官方规则、真实进程、存活身份与技能存量；玩家的自述和胜率预测都不是事实。不得用‘非狼超过一人’等人数捷径代替推演。",
    '严格只输出 JSON：{"verdict":"wolf_win 或 not_guaranteed","reason":"关键轮次与反制路径分析"}',
  ].join("\n");
  const user = [
    `版型：${BOARDS.find((b) => b.id === rt.boardId)?.name ?? rt.boardId}`,
    `【本局官方规则】\n${buildBoardRulesText(rt.boardId, rt.options.sheriffEnabled)}`,
    `当前进度：第${snap.day}天 · ${snap.phaseLabel}`,
    `用户配置：${JSON.stringify(rt.options)}`,
    "【真实存活身份与技能存量】",
    ...playerLines,
    facts,
  ].join("\n\n");
  return { system, user };
}

export async function runVictoryAiAudit(options: {
  gameId: string;
  rt: GameRuntime;
  events?: GameEvent[];
  callAiFn?: typeof callAi;
}): Promise<VictoryAiAuditResult> {
  const { gameId, rt } = options;
  const base = rt.analystAi ?? (rt.seatAIs[0] ? {
    provider: rt.seatAIs[0].provider,
    baseUrl: rt.seatAIs[0].baseUrl,
    model: rt.seatAIs[0].model,
    apiKey: rt.seatAIs[0].apiKey,
  } : null);
  if (!base) return { outcome: "unavailable", reason: "未配置拍刀审核分析师" };
  const events = options.events ?? await getAllEvents(gameId);
  const { system, user } = buildVictoryAiAuditPrompt(rt, events);
  const call = options.callAiFn ?? callAi;
  const res = await call({ ...base, seat: 0 }, system, user, {
    maxRetries: 1,
    timeoutMs: isThinkingModel(base) ? 180_000 : 120_000,
  });
  if (!res.ok || !res.text) return { outcome: "unavailable", reason: res.error ?? "拍刀审核分析师调用失败" };
  return parseVerdict(res.text) ?? { outcome: "unavailable", reason: "拍刀审核分析师输出无法解析" };
}
