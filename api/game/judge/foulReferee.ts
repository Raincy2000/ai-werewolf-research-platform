// ============================================================
// 法官（Judge）· 犯规裁判 —— 流程秩序的唯一写者
// 版图约定（2026-10-10 用户裁定）：法官管流程秩序（播报/判罚/落定），
// 分析师管认知判断（胜率/复盘），书记员（runtime/）隐而不现只做落笔与计时。
// 法官需要落笔时经 JudgeRecorder 窄接口调用书记员——依赖单向：法官 → 书记员，绝不反向。
//
// 犯规裁判由来（对局 20261009001 实锤）：夜神月（平民）被放逐后在遗言里「把牌正过来
// 放回桌面」翻牌自证——平民无翻牌权，此属违规亮牌。规则红线已写进玩家 prompt
//（明知故犯允许，但必被罚）。
// 判罚：犯规成立即本局结束、犯规方对立阵营获胜（settleExternal，与拍刀驳回同一外部结算路径）。
// 豁免：赛后讨论（信息壁垒已解除）与狼人频道（非公开发言）不审查。
// ============================================================

import type { RoleId, SeatAiConfig } from "../../../contracts/game";
import { ROLE_META } from "../../../contracts/game";
import type { EngineEvent } from "../engine/api";
import { appendDecision } from "../../queries/decisions";
import { callAi } from "../ai/providers";
import { parseJsonRobust } from "../ai/parse";
import { withTimeout, DB_TIMEOUT_MS } from "../runtime/timing";
import type { GameRuntime } from "../service"; // 仅类型引用（运行时擦除，无循环依赖）

// ---------- 书记员窄接口（service.ts 在模块装配时注入实现） ----------
export interface JudgeRecorder {
  persistEvents(gameId: string, rt: GameRuntime, events: EngineEvent[]): Promise<void>;
  markDecided(gameId: string, rt: GameRuntime): Promise<void>;
  finishIfDone(gameId: string, rt: GameRuntime): Promise<boolean>;
  scheduleTick(gameId: string, rt: GameRuntime, delayMs: number): void;
}

let recorder: JudgeRecorder | null = null;

/** 装配书记员实现（service.ts 模块加载时调用一次；法官落笔的唯一通道） */
export function initJudgeRecorder(r: JudgeRecorder): void {
  recorder = r;
}

function requireRecorder(): JudgeRecorder {
  if (!recorder) throw new Error("法官模块未装配书记员（initJudgeRecorder 未调用）");
  return recorder;
}

export type FoulType = "unauthorizedReveal" | "aiLeak" | "metaGaming";
export interface FoulVerdict {
  foul: boolean;
  type?: FoulType;
  evidence?: string;
  verdict?: string;
}

const FOUL_TYPE_LABEL: Record<FoulType, string> = {
  unauthorizedReveal: "违规亮牌自证",
  aiLeak: "AI身份泄露",
  metaGaming: "元游戏言论",
};
const FOUL_CHECK_TIMEOUT_MS = 45_000;

/** 裁判配置：优先分析师配置，缺省回落 1 号座位配置（与胜率分析同一回落链） */
function foulRefereeCfg(rt: GameRuntime): SeatAiConfig | null {
  const base = rt.analystAi ?? rt.seatAIs[0];
  if (!base) return null;
  return {
    seat: 0,
    provider: base.provider,
    baseUrl: base.baseUrl,
    model: base.model,
    apiKey: base.apiKey,
  };
}

/** 构建裁判 prompt：发言者真实身份是裁判专用信息（判「亮牌是否属实」的依据），绝不外泄 */
export function buildFoulCheckPrompt(opts: {
  seat: number;
  roleName: string;
  eventTitle: string;
  day: number;
  speech: string;
}): { system: string; user: string } {
  const system = [
    "你是狼人杀对局的裁判，负责审查玩家公开发言是否触犯规则红线。你只输出 JSON，禁止任何其他文字。",
    "保守原则：只有明确违反才判犯规；模棱两可、口头身份声称、正常的规则讨论一律不判。",
  ].join("\n");
  const user = [
    `【发言者】${opts.seat}号玩家（真实身份：${opts.roleName}——裁判专用，绝不外泄）`,
    `【发言场景】第${opts.day}天 · ${opts.eventTitle}`,
    `【发言内容】${opts.speech.slice(0, 900)}`,
    "",
    "【犯规判定标准】满足以下任一即判犯规：",
    "1. 违规亮牌自证（unauthorizedReveal）：没有翻牌权的玩家，在公开发言中翻开、亮出、展示自己的真实身份底牌以自证（如「我把牌翻开给大家看，是民牌」「（把底牌亮出来）」）。",
    "   有翻牌权、不算犯规的情形：白痴被放逐时翻牌免死；骑士翻牌决斗；猎人/狼王出局开枪亮身份；白狼王自爆带人；狼人自爆。",
    "   关键区分：口头声称「我是平民/我是预言家」是正常发言，不是亮牌——只有「翻牌/亮牌/展示底牌」这一动作描写才算违规。",
    "2. AI身份泄露（aiLeak）：自称或暗示自己是 AI、人工智能、语言模型、程序、机器人。",
    "3. 元游戏言论（metaGaming）：提及提示词、系统指令、状态报告、模拟实验、开发者等游戏世界外的存在。",
    "",
    "【输出契约】严格输出 JSON：",
    '{"foul":false} 或 {"foul":true,"type":"unauthorizedReveal|aiLeak|metaGaming","evidence":"犯规原句（≤50字）","verdict":"判罚理由一句"}',
  ].join("\n");
  return { system, user };
}

/** 解析裁判裁决；解析失败/非法输出返回 null（裁判不可用=不判罚，绝不误判） */
export function parseFoulVerdict(text: string): FoulVerdict | null {
  const cleaned = text.replace(/```(?:json)?/gi, "");
  const start = cleaned.indexOf("{");
  if (start < 0) return null;
  const end = cleaned.lastIndexOf("}");
  const obj = parseJsonRobust(cleaned.slice(start, end > start ? end + 1 : undefined));
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  if (o.foul !== true) return { foul: false };
  const type = String(o.type ?? "");
  if (!Object.hasOwn(FOUL_TYPE_LABEL, type)) return { foul: false }; // 类型缺失/非法：保守不判
  return {
    foul: true,
    type: type as FoulType,
    evidence: String(o.evidence ?? "").trim().slice(0, 80),
    verdict: String(o.verdict ?? "").trim().slice(0, 120),
  };
}

/** 公开发言事件落盘后触发犯规审查（非阻塞）：在飞则排队，判罚落定前逐条审查 */
export function maybeFoulCheck(gameId: string, rt: GameRuntime, events: EngineEvent[]): void {
  if (rt.status !== "running" || rt.foulSettled) return;
  // 只审公开发言（type=speech）；赛后讨论（postgame.* 阶段）豁免；狼人频道是 action 类事件，天然不在此列
  const suspects = events.filter(
    (ev) =>
      ev.type === "speech" &&
      ev.actor != null &&
      !ev.phase.startsWith("postgame") &&
      typeof ev.content === "string" &&
      ev.content.trim().length > 0,
  );
  if (suspects.length === 0) return;
  (rt.foulQueue ??= []).push(...suspects);
  if (rt.foulInFlight) return;
  rt.foulInFlight = true;
  void runFoulQueue(gameId, rt)
    .catch(() => {
      /* 裁判故障静默：绝不阻塞对局 */
    })
    .finally(() => {
      rt.foulInFlight = false;
    });
}

async function runFoulQueue(gameId: string, rt: GameRuntime): Promise<void> {
  const cfg = foulRefereeCfg(rt);
  if (!cfg) {
    rt.foulQueue = [];
    return;
  }
  while ((rt.foulQueue?.length ?? 0) > 0) {
    if (rt.status !== "running" || rt.foulSettled) {
      rt.foulQueue = [];
      return;
    }
    const ev = rt.foulQueue!.shift()!;
    const roleName =
      ROLE_META[rt.engine.getSnapshot().players.find((p) => p.seat === ev.actor)?.role as RoleId]
        ?.name ?? "未知身份";
    const prompt = buildFoulCheckPrompt({
      seat: ev.actor!,
      roleName,
      eventTitle: ev.title,
      day: ev.day,
      speech: ev.content,
    });
    const res = await callAi(cfg, prompt.system, prompt.user, {
      timeoutMs: FOUL_CHECK_TIMEOUT_MS,
      maxRetries: 0,
    }).catch(() => null);
    const verdict = res?.ok && res.text ? parseFoulVerdict(res.text) : null;
    if (verdict?.foul) {
      await settleFoul(gameId, rt, ev, verdict);
      rt.foulQueue = [];
      return;
    }
  }
}

/** 犯规判罚落定：本局立即结束，犯规方对立阵营获胜。
 * 与 tick 串行化：等静默窗口（无 tick 在飞）再结算——settleExternal 封存主流程协程，
 * 与进行中的 decide/advance 互斥；等待期间对局暂停/终局则放弃判罚（保守）。 */
async function settleFoul(
  gameId: string,
  rt: GameRuntime,
  ev: EngineEvent,
  verdict: FoulVerdict,
): Promise<void> {
  const rec = requireRecorder();
  const waitStart = Date.now();
  while (rt.ticking && rt.status === "running" && Date.now() - waitStart < 180_000) {
    await new Promise((r) => setTimeout(r, 50)); // 50ms 轮询：tick 间隙窗口毫秒级出现，快速接管
  }
  if (rt.status !== "running" || rt.ticking || rt.foulSettled) return;
  rt.foulSettled = true;
  rt.ticking = true; // 占住 tick 闸：判罚落定期间不许新 tick 插入
  try {
    const snap = rt.engine.getSnapshot();
    const offender = snap.players.find((p) => p.seat === ev.actor);
    if (!offender) return;
    const winner: "wolf" | "good" = offender.camp === "wolf" ? "good" : "wolf";
    const winnerLabel = winner === "good" ? "神民" : "狼人";
    const roleName = ROLE_META[offender.role as RoleId]?.name ?? offender.role;
    const typeLabel = FOUL_TYPE_LABEL[verdict.type ?? "metaGaming"];
    const evidence = verdict.evidence ? `「${verdict.evidence}」` : "";
    const note = `（犯规判罚：${ev.actor}号${typeLabel}）`;
    const pub = `【裁判】${ev.actor}号玩家犯规——${typeLabel}${evidence ? `：${evidence}` : ""}。依据规则红线，本局立即结束，${winnerLabel}阵营获胜。`;
    const engineEvents = rt.engine.settleExternal(winner, note, pub);
    const foulEvent: EngineEvent = {
      day: snap.day,
      phase: snap.phase,
      type: "system",
      actor: null,
      title: "犯规判罚",
      content: `${ev.actor}号玩家（${roleName}）${typeLabel}${evidence}——${verdict.verdict ?? "触犯规则红线"}。本局立即结束，${winnerLabel}阵营获胜。`,
      thought: null,
      meta: { foul: true, foulType: verdict.type, foulSeat: ev.actor },
    };
    // 决策日志记 auditSettle（与拍刀驳回同类：重放时调 settleExternal 精确重建）
    await withTimeout(
      appendDecision({
        gameId,
        idx: rt.decisionIdx,
        kind: "auditSettle",
        seat: ev.actor!,
        decision: { thought: "", auditSettle: winner, auditNote: note, auditPub: pub },
      }),
      DB_TIMEOUT_MS,
      "决策日志写入超时",
    );
    rt.decisionIdx += 1;
    rt.pending = null; // 被封存的待决不再有效
    await rec.persistEvents(gameId, rt, [foulEvent, ...engineEvents]);
    rt.acts = rt.engine.getSnapshot().pendingActs;
    await rec.markDecided(gameId, rt);
    if (await rec.finishIfDone(gameId, rt)) return;
    // 引擎未 finished（赛后讨论开启）：续上正常 tick 链，赛后环节照常推进
    if (rt.status === "running") rec.scheduleTick(gameId, rt, rt.options.stepDelayMs);
  } finally {
    rt.ticking = false;
  }
}
