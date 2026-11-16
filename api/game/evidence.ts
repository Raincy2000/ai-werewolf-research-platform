// ============================================================
// 不可变事实索引：公共事实与主体私域共用同一原文，绝不做有损记忆降级。
// - 公共索引与 AI 公开记录同口径：狼频道、观察者权衡、夜间私密行动不公开。
// - 私域索引只含当前座位事件；狼队频道只在调用方明确属于见面狼时加入。
// - 格式化只做展示，不截断、不省略，任何公开事实都可通过 #seq 回溯。
// ============================================================

import { createHash } from "node:crypto";
import type { GameEvent } from "../../contracts/game";
import { buildIntentTrail, formatIntentTrail, type IntentDecisionRow } from "./intent";

export type EvidenceVisibility = "public" | "self" | "wolfTeam" | "postgamePublic" | "observerOnly";

export interface EvidenceRef {
  gameId: string;
  seq: number;
  day: number;
  phase: string;
  visibility: EvidenceVisibility;
  ownerSeat: number | null;
  actorLabel: string | null;
  title: string;
  text: string;
  contentHash: string;
}

function refOf(gameId: string, event: GameEvent, visibility: EvidenceVisibility, ownerSeat: number | null): EvidenceRef {
  const content = JSON.stringify({
    gameId,
    seq: event.seq,
    phase: event.phase,
    type: event.type,
    actor: event.actor,
    title: event.title,
    content: event.content,
  });
  return {
    gameId,
    seq: event.seq,
    day: event.day,
    phase: event.phase,
    visibility,
    ownerSeat,
    actorLabel: event.actorLabel,
    title: event.title,
    text: event.content,
    contentHash: createHash("sha256").update(content).digest("hex"),
  };
}

export function buildPublicEvidenceIndex(gameId: string, events: GameEvent[]): EvidenceRef[] {
  return events
    .filter((event) => {
      const channel = event.meta?.channel;
      if (channel === "wolf" || channel === "skillThink") return false;
      if (event.phase.startsWith("night.") && event.type === "action") return false;
      return true;
    })
    .map((event) => refOf(gameId, event, "public", event.actor));
}

/** 赛后信息壁垒解除：夜间行动与狼频道转为公共事实；观察者心理仍永不进入玩家认知。 */
export function buildPostgamePublicEvidenceIndex(gameId: string, events: GameEvent[]): EvidenceRef[] {
  return events
    .filter((event) => event.meta?.channel !== "skillThink")
    .map((event) => refOf(gameId, event, "postgamePublic", event.actor));
}

export function buildPrivateEvidenceIndex(
  gameId: string,
  seat: number,
  events: GameEvent[],
  options: { wolfTeam: boolean },
): EvidenceRef[] {
  return events
    .filter((event) => {
      if (event.meta?.channel === "wolf") return options.wolfTeam;
      return event.actor === seat;
    })
    .map((event) => refOf(gameId, event, event.meta?.channel === "wolf" ? "wolfTeam" : "self", seat));
}

/** 全文展示：只改变排版，不改变事实内容；没有字数预算与“已省略”降级路径。 */
export function formatEvidenceRefs(refs: EvidenceRef[], label = "完整事实索引"): string {
  const lines = refs.map((ref) => {
    const actor = ref.actorLabel ?? (ref.ownerSeat != null ? `${ref.ownerSeat}号玩家` : "系统");
    return `[#${ref.seq}] ${actor}《${ref.title}》${ref.text}`;
  });
  return `【${label}】（原始事件，可回溯；摘要仅辅助阅读）\n${lines.join("\n")}`;
}

/** 本人自传体事实：只认事件行动者，不把“全桌发生的事”误记成“我做过的事”。 */
export function buildSelfFactIndex(
  gameId: string,
  seat: number,
  events: GameEvent[],
  options: { wolfTeam: boolean },
): EvidenceRef[] {
  return events
    .filter((event) => event.actor === seat && (event.meta?.channel !== "wolf" || options.wolfTeam))
    .map((event) => refOf(gameId, event, event.meta?.channel === "wolf" ? "wolfTeam" : "self", seat));
}

export function buildVoteFactIndex(gameId: string, events: GameEvent[]): EvidenceRef[] {
  return events.filter((event) => event.type === "vote").map((event) => refOf(gameId, event, "public", event.actor));
}

export interface SpeechReferenceRef extends EvidenceRef {
  addressTo: number | number[] | "all" | null;
}

/** 发言归属只读公开正文；回复对象只读引擎明确记录的 addressTo，不从语义猜测。 */
export function buildSpeechReferenceIndex(gameId: string, events: GameEvent[]): SpeechReferenceRef[] {
  return events
    .filter((event) => event.type === "speech" && event.meta?.channel !== "wolf" && event.meta?.channel !== "skillThink")
    .map((event) => {
      const raw = event.meta?.addressTo;
      const addressTo = raw === "all" || typeof raw === "number" || Array.isArray(raw) ? raw : null;
      return { ...refOf(gameId, event, "public", event.actor), addressTo };
    });
}

export function formatSelfFactLedger(refs: EvidenceRef[], seat: number): string {
  return formatEvidenceRefs(refs, `你的完整自我事实台账（${seat}号本人实际行动、投票与发言）`);
}

export function formatVoteFactIndex(refs: EvidenceRef[]): string {
  return formatEvidenceRefs(refs, "完整公开票型（投票人 → 目标，以原始内容为准）");
}

export function formatSpeechReferenceIndex(refs: SpeechReferenceRef[]): string {
  const lines = refs.map((ref) => {
    const actor = ref.actorLabel ?? (ref.ownerSeat != null ? `${ref.ownerSeat}号玩家` : "系统");
    const target = ref.addressTo === "all"
      ? "所有人"
      : Array.isArray(ref.addressTo)
        ? ref.addressTo.map((seat) => `${seat}号玩家`).join("、")
        : typeof ref.addressTo === "number"
          ? `${ref.addressTo}号玩家`
          : "未指定";
    return `[#${ref.seq}] ${actor} → ${target}《${ref.title}》${ref.text}`;
  });
  return `【完整发言与回复指代】（作者、原文与引擎记录的回复对象；未指定不从语义猜测）\n${lines.join("\n")}`;
}

export interface CurrentInteraction {
  latestSeq: number | null;
  latestSpeakerSeat: number | null;
  latestText: string | null;
  explicitlyAddressedSeats: number[] | "all" | null;
  newEventSeqsSinceOwnDecision: number[];
  newSpeeches: Array<{
    seq: number;
    actorSeat: number;
    actorLabel: string;
    text: string;
    addressTo: number | number[] | "all" | null;
  }>;
  round: number;
  legalActions: { canSpeak: true; canSkip: true; targetSeats: number[] };
}

/** 本轮互动只投影原始事件与明确指代，不从语气或称呼推断主体意图。 */
export function buildCurrentInteraction(
  _gameId: string,
  seat: number,
  events: GameEvent[],
  options: { targetSeats?: number[] } = {},
): CurrentInteraction {
  const postgame = events.filter((event) => event.phase === "postgame.discuss");
  const ownEvents = postgame.filter((event) => event.actor === seat && event.type === "speech");
  const ownLastSeq = ownEvents.at(-1)?.seq ?? 0;
  const latest = postgame.filter((event) => event.type === "speech").at(-1) ?? null;
  const address = latest?.meta?.addressTo;
  const explicitlyAddressedSeats = address === "all"
    ? "all"
    : typeof address === "number" ? [address]
      : Array.isArray(address) ? address.filter((seat): seat is number => typeof seat === "number") : null;
  const newEvents = postgame.filter((event) => event.seq > ownLastSeq);
  return {
    latestSeq: latest?.seq ?? null,
    latestSpeakerSeat: latest?.actor ?? null,
    latestText: latest?.content ?? null,
    explicitlyAddressedSeats,
    newEventSeqsSinceOwnDecision: newEvents.map((event) => event.seq),
    newSpeeches: newEvents.filter((event) => event.type === "speech" && event.actor != null).map((event) => ({
      seq: event.seq,
      actorSeat: event.actor!,
      actorLabel: event.actorLabel ?? `${event.actor}号玩家`,
      text: event.content,
      addressTo: event.meta?.addressTo === "all" || typeof event.meta?.addressTo === "number" || Array.isArray(event.meta?.addressTo)
        ? event.meta.addressTo as number | number[] | "all"
        : null,
    })),
    round: typeof latest?.meta?.round === "number" ? latest.meta.round : 1,
    legalActions: { canSpeak: true, canSkip: true, targetSeats: [...(options.targetSeats ?? [])] },
  };
}

export function formatCurrentInteraction(current: CurrentInteraction): string {
  const address = current.explicitlyAddressedSeats === "all"
    ? "所有人"
    : Array.isArray(current.explicitlyAddressedSeats)
      ? current.explicitlyAddressedSeats.map((seat) => `${seat}号`).join("、")
      : "未指定";
  const newSpeechText = current.newSpeeches.length
    ? current.newSpeeches.map((speech) => {
        const target = speech.addressTo === "all" ? "所有人" : Array.isArray(speech.addressTo)
          ? speech.addressTo.map((seat) => `${seat}号`).join("、")
          : typeof speech.addressTo === "number" ? `${speech.addressTo}号` : "未指定";
        return `[#${speech.seq}] ${speech.actorLabel} → ${target}：${speech.text}`;
      }).join("\n")
    : "无";
  return [
    "【本轮互动事实】",
    current.latestSeq == null
      ? "本轮尚无已落盘的赛后发言。"
      : `最新赛后发言：[#${current.latestSeq}] ${current.latestSpeakerSeat ?? "未知"}号玩家：${current.latestText ?? ""}`,
    `明确点名对象：${address}`,
    `自你上次赛后决策以来的新增事件编号：${current.newEventSeqsSinceOwnDecision.length ? current.newEventSeqsSinceOwnDecision.map((seq) => `#${seq}`).join("、") : "无"}`,
    `自你上次赛后决策以来的新增发言原文：\n${newSpeechText}`,
    "可回应其中任何一条，也可沉默或结束话题；无需总结全局。",
    `当前轮次：第${current.round}轮；可发言或沉默；可点名座位：${current.legalActions.targetSeats.length ? current.legalActions.targetSeats.map((seat) => seat === 0 ? "所有人" : `${seat}号`).join("、") : "无"}`,
  ].join("\n");
}

export type EpisodeAccessChannel = "selfAction" | "public" | "wolfTeam" | "postgameDisclosure";

export interface EpisodeView extends EvidenceRef {
  actorSeat: number | null;
  accessChannel: EpisodeAccessChannel;
  originalText: string;
  /** 主体个人大意只存在于派生认知，不回写 originalText。 */
  personalGist?: string;
}

/** 当前座位的完整合法认知域；来源分区不改变任何事实内容。 */
export function buildEpisodeViews(
  gameId: string,
  seat: number,
  events: GameEvent[],
  options: { wolfTeam: boolean; postgame: boolean },
): EpisodeView[] {
  const rows = new Map<number, EpisodeView>();
  for (const event of events) {
    if (event.meta?.channel === "skillThink") continue;
    const isWolf = event.meta?.channel === "wolf";
    const isSelf = event.actor === seat && (!isWolf || options.wolfTeam);
    const isWolfTeam = isWolf && options.wolfTeam && !isSelf;
    const isPublic = options.postgame
      ? true
      : !isWolf && !(event.phase.startsWith("night.") && event.type === "action");
    if (!isSelf && !isWolfTeam && !isPublic) continue;
    const accessChannel: EpisodeAccessChannel = isSelf
      ? "selfAction"
      : isWolfTeam
        ? "wolfTeam"
        : options.postgame
          ? "postgameDisclosure"
          : "public";
    const existing = rows.get(event.seq);
    // 本人公共发言同时满足 public/selfAction，保留更具体的本人来源。
    if (existing && existing.accessChannel === "selfAction") continue;
    const visibility: EvidenceVisibility = isSelf
      ? isWolf ? "wolfTeam" : "self"
      : isWolfTeam ? "wolfTeam" : options.postgame ? "postgamePublic" : "public";
    rows.set(event.seq, {
      ...refOf(gameId, event, visibility, event.actor),
      actorSeat: event.actor,
      accessChannel,
      originalText: event.content,
    });
  }
  return [...rows.values()].sort((a, b) => a.seq - b.seq);
}

/** 仅按可见性过滤指针；不过滤、纠正或改写主体的解释。 */
export function filterVisibleBasisEventSeqs(views: EpisodeView[], seqs: number[]): number[] {
  const visible = new Set(views.map((view) => view.seq));
  return [...new Set(seqs.filter((seq) => Number.isInteger(seq) && visible.has(seq)))];
}

export function formatSelfActionLedger(views: EpisodeView[], seat: number): string {
  return formatEvidenceRefs(
    views.filter((view) => view.accessChannel === "selfAction" && view.actorSeat === seat),
    `你的本人实际行动台账（${seat}号；他人事件不会因同场出现而并入此台账）`,
  );
}

export interface LiveCognition {
  publicFacts: string;
  selfFacts: string;
  intentTrail?: string;
  postgameFacts?: string;
  currentInteraction?: string;
}

/** 实时决策认知包：公共全文 + 当前座位私域与意图轨迹；赛后追加票型、发言指代与本轮互动。 */
export function buildLiveCognition(
  gameId: string,
  seat: number,
  events: GameEvent[],
  options: { wolfTeam: boolean; postgame: boolean; decisions?: IntentDecisionRow[]; targetSeats?: number[] },
): LiveCognition {
  const publicFacts = formatEvidenceRefs(
    options.postgame
      ? buildPostgamePublicEvidenceIndex(gameId, events.filter((event) => event.type !== "speech" && event.type !== "vote"))
      : buildPublicEvidenceIndex(gameId, events),
    options.postgame ? "赛后完整公共事实（信息壁垒已解除）" : "完整公共事实",
  );
  const episodeViews = buildEpisodeViews(gameId, seat, events, options);
  const selfRefs = buildSelfFactIndex(gameId, seat, events, options);
  const ownSeqs = new Set(selfRefs.map((ref) => ref.seq));
  const teammateRefs = buildPrivateEvidenceIndex(gameId, seat, events, options)
    .filter((ref) => !ownSeqs.has(ref.seq));
  const selfFacts = [
    formatSelfActionLedger(episodeViews, seat),
    teammateRefs.length ? formatEvidenceRefs(teammateRefs.sort((a, b) => a.seq - b.seq), "你可见的狼队友行动（不是你本人的行动）") : "",
  ].filter(Boolean).join("\n");
  return {
    publicFacts,
    selfFacts,
    ...(options.decisions
      ? { intentTrail: formatIntentTrail(buildIntentTrail(gameId, seat, options.decisions, events, options)) }
      : {}),
    ...(options.postgame
      ? {
          postgameFacts: `${formatVoteFactIndex(buildVoteFactIndex(gameId, events))}\n${formatSpeechReferenceIndex(buildSpeechReferenceIndex(gameId, events))}`,
          currentInteraction: formatCurrentInteraction(buildCurrentInteraction(gameId, seat, events, options)),
        }
      : {}),
  };
}
