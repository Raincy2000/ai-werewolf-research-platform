// ============================================================
// 主体意图轨迹：只投影既有决策，不生成目标、不补写改口原因。
// 批量座位只通过同阶段事件行动者顺序对齐；无法确认时跳过。
// ============================================================

import type { GameEvent } from "../../contracts/game";
import type { DecisionInput, DecisionKind } from "./engine/api";

export interface IntentDecisionRow {
  idx: number;
  kind: DecisionKind;
  seat: number;
  decision: DecisionInput;
}

export interface IntentSnapshot {
  action: DecisionKind;
  targetSeats: number[];
  rationale: string;
}

export interface IntentRevision {
  revisionId: string;
  gameId: string;
  seat: number;
  decisionIdx: number;
  previous: IntentSnapshot | null;
  next: IntentSnapshot;
  stage: "draft" | "proposed" | "revised" | "voted" | "abandoned";
  triggerEventRefs: Array<{ gameId: string; seq: number }>;
  counterEvidenceRefs: Array<{ gameId: string; seq: number }>;
  /** 主体当场自愿关联的依据；可见性可校验，结论正确性不由系统裁判。 */
  basisEventRefs: Array<{ gameId: string; seq: number }>;
  revisionNarrative: string | null;
}

const WOLF_KINDS = new Set<DecisionKind>(["wolfThink", "wolfDiscuss", "wolfKill"]);
const VOTED_KINDS = new Set<DecisionKind>(["wolfKill", "dayVote", "sheriffVote", "sheriffOrder", "guardProtect", "witchAction", "seerCheck", "hunterShoot", "whiteWolfTake", "exileSkill", "daySkill"]);

function actionDomain(kind: DecisionKind): string {
  if (WOLF_KINDS.has(kind)) return "wolfKill";
  if (kind === "daySpeech" || kind === "dayVote") return "dayVote";
  if (kind === "sheriffSpeech" || kind === "sheriffVote") return "sheriffVote";
  return kind;
}

function stageOf(kind: DecisionKind, input: DecisionInput, previous: IntentRevision | null): IntentRevision["stage"] {
  if (input.skip && previous && actionDomain(previous.next.action) === actionDomain(kind) && previous.next.targetSeats.length > 0) return "abandoned";
  if (kind === "wolfThink") return "draft";
  if (VOTED_KINDS.has(kind)) return "voted";
  if (previous && previous.next.action === kind) return "revised";
  return "proposed";
}

function declaredVoteTargets(input: DecisionInput, kind: DecisionKind): number[] {
  if (kind === "sheriffRun" || kind === "sheriffWithdraw" || kind === "sheriffOrder") return [];
  if (input.targets?.length) return [...input.targets];
  if (input.duel != null) return [input.duel];
  if (input.intent?.targetSeats?.length) return [...input.intent.targetSeats];
  const targets = new Set<number>();
  if (kind === "wolfThink") {
    const thought = input.thought ?? "";
    const thoughtPatterns = [/刀口(?:定|落在|就落在|我签在)?(\d+)号/g, /(?:^|[\n。；，])刀(\d+)号/g, /就这么定：(\d+)号/g, /先点(\d+)号/g];
    for (const pattern of thoughtPatterns) {
      for (const match of thought.matchAll(pattern)) targets.add(Number(match[1]));
    }
    return [...targets];
  }
  const speech = input.speech;
  if (!speech) return [];
  const patterns = [
    /我的票(?:写死在|写在|写|落在|落|投在|投给|投)?(\d+)号/g,
    /我票写(\d+)号/g,
    /这一票(?:写|落在|投给|投在|投)(\d+)号/g,
  ];
  for (const pattern of patterns) {
    for (const match of speech.matchAll(pattern)) targets.add(Number(match[1]));
  }
  return [...targets];
}

function batchPhase(kind: DecisionKind): string | null {
  if (kind === "wolfThink") return "night.wolfThink";
  if (kind === "dayVote") return "day.vote";
  if (kind === "sheriffVote") return "day.sheriff.vote";
  if (kind === "sheriffRun") return "day.sheriff.run";
  if (kind === "sheriffWithdraw") return "day.sheriff.withdraw";
  return null;
}

function expandRows(rows: IntentDecisionRow[], events: GameEvent[]): IntentDecisionRow[] {
  const offsets = new Map<DecisionKind, number>();
  const expanded: IntentDecisionRow[] = [];
  for (const row of [...rows].sort((a, b) => a.idx - b.idx)) {
    if (!row.decision.batchInputs) {
      expanded.push(row);
      continue;
    }
    const phase = batchPhase(row.kind);
    const inputs = row.decision.batchInputs;
    if (row.kind === "daySkill") {
      const skillActors = events
        .filter((event) => event.type === "action" && event.title === "技能权衡" && event.actor != null)
        .map((event) => event.actor!);
      let skillOffset = offsets.get(row.kind) ?? 0;
      for (const decision of inputs) {
        if (decision.speech) {
          const speechEvent = events.find((event) => event.type === "speech" && event.content === decision.speech && event.actor != null);
          if (speechEvent) expanded.push({ idx: row.idx, kind: row.kind, seat: speechEvent.actor!, decision });
          continue;
        }
        const seat = skillActors[skillOffset++];
        if (seat != null) expanded.push({ idx: row.idx, kind: row.kind, seat, decision });
      }
      offsets.set(row.kind, skillOffset);
      continue;
    }
    if (!phase) continue; // 无法证明批量座位映射：跳过，不猜配。
    const actors = events.filter((event) => event.phase === phase && event.actor != null).map((event) => event.actor!);
    const offset = offsets.get(row.kind) ?? 0;
    const seats = actors.slice(offset, offset + inputs.length);
    offsets.set(row.kind, offset + inputs.length);
    if (seats.length !== inputs.length) continue;
    inputs.forEach((decision, index) => expanded.push({ idx: row.idx, kind: row.kind, seat: seats[index]!, decision }));
  }
  return expanded.sort((a, b) => a.idx - b.idx);
}

function eventSeqFor(row: IntentDecisionRow, events: GameEvent[], used: Set<number>): number | null {
  const phase = batchPhase(row.kind) ?? (row.kind === "wolfDiscuss"
    ? "night.wolfDiscuss"
    : row.kind === "wolfKill"
      ? "night.wolf"
      : row.kind === "daySpeech"
        ? "day.speech"
        : row.kind === "sheriffSpeech"
          ? "day.sheriff.speech"
          : row.kind === "postgameSpeak"
            ? "postgame.discuss"
            : null);
  const candidates = events.filter((event) => {
    if (event.actor !== row.seat || used.has(event.seq)) return false;
    if (phase && event.phase !== phase) return false;
    if (row.kind === "daySkill") {
      return row.decision.speech
        ? event.type === "speech"
        : event.type === "action" && event.title === "技能权衡";
    }
    if (row.kind === "dayVote" || row.kind === "sheriffVote") return event.type === "vote";
    if (row.kind === "daySpeech" || row.kind === "sheriffSpeech" || row.kind === "wolfDiscuss" || row.kind === "postgameSpeak") return event.type === "speech" || event.phase === "night.wolfDiscuss";
    return true;
  });
  const exactSpeech = row.decision.speech
    ? candidates.find((event) => event.content === row.decision.speech || event.content.includes(row.decision.speech!))
    : undefined;
  const selected = exactSpeech ?? candidates[0];
  if (!selected) return null;
  used.add(selected.seq);
  return selected.seq;
}

function visibleBetween(gameId: string, seat: number, events: GameEvent[], from: number | null, to: number | null, wolfTeam: boolean) {
  if (to == null) return [];
  return events.filter((event) => {
    if (event.seq !== to || (from != null && event.seq <= from)) return false;
    if (event.actor === seat) return true;
    if (event.meta?.channel === "wolf") return wolfTeam;
    if (event.meta?.channel === "skillThink") return false;
    return !(event.phase.startsWith("night.") && event.type === "action");
  }).map((event) => ({ gameId, seq: event.seq }));
}

function sameTargets(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((target, index) => target === b[index]);
}

function explicitRevisionNarrative(input: DecisionInput, changed: boolean): string | null {
  if (!changed) return null;
  const thought = input.thought ?? "";
  const speech = input.speech ?? "";
  if (/改口|改过来|改成|改为|换成|改刀|换刀|改一|改目标|不再刀|不再投/.test(thought)) return thought;
  if (/改口|改过来|改成|改为|换成|改刀|换刀|改一|改目标|不再刀|不再投/.test(speech)) return speech;
  return null;
}

export function buildIntentTrail(
  gameId: string,
  seat: number,
  rows: IntentDecisionRow[],
  events: GameEvent[],
  options: { wolfTeam: boolean; postgame?: boolean },
): IntentRevision[] {
  const trail: IntentRevision[] = [];
  const usedSeqs = new Set<number>();
  for (const row of expandRows(rows, events)) {
    if (row.seat !== seat || (!options.wolfTeam && WOLF_KINDS.has(row.kind))) continue;
    const rationale = row.decision.intent?.rationale ?? row.decision.thought ?? "";
    const next: IntentSnapshot = { action: row.kind, targetSeats: declaredVoteTargets(row.decision, row.kind), rationale };
    const previousRevision = trail.at(-1) ?? null;
    const previous = previousRevision?.next ?? null;
    const currentSeq = eventSeqFor(row, events, usedSeqs);
    const previousSeq = trail.at(-1)?.triggerEventRefs.at(-1)?.seq ?? null;
    const changed = !!previous && actionDomain(previous.action) === actionDomain(next.action) && !sameTargets(previous.targetSeats, next.targetSeats);
    const basisEventRefs = (row.decision.intent?.basisEventSeqs ?? []).flatMap((seq) => {
      const event = events.find((candidate) => candidate.seq === seq);
      if (!event || event.meta?.channel === "skillThink") return [];
      const visible = options.postgame || event.actor === seat ||
        (event.meta?.channel === "wolf" ? options.wolfTeam : !(event.phase.startsWith("night.") && event.type === "action"));
      return visible ? [{ gameId, seq }] : [];
    });
    trail.push({
      revisionId: `${gameId}:${seat}:${row.idx}`,
      gameId,
      seat,
      decisionIdx: row.idx,
      previous,
      next,
      stage: stageOf(row.kind, row.decision, previousRevision),
      triggerEventRefs: visibleBetween(gameId, seat, events, previousSeq, currentSeq, options.wolfTeam),
      counterEvidenceRefs: [],
      basisEventRefs: [...new Map(basisEventRefs.map((ref) => [ref.seq, ref])).values()],
      revisionNarrative: explicitRevisionNarrative(row.decision, changed),
    });
  }
  return trail;
}

function targetsText(targets: number[]): string {
  return targets.length ? targets.map((seat) => `${seat}号`).join("、") : "无明确目标";
}

export function formatIntentTrail(revisions: IntentRevision[]): string {
  if (revisions.length === 0) return "【你的完整意图轨迹】（当前尚无已落盘意图）";
  const lines = revisions.map((revision) => {
    const changed = !!revision.previous && actionDomain(revision.previous.action) === actionDomain(revision.next.action) && !sameTargets(revision.previous.targetSeats, revision.next.targetSeats);
    const sameDomain = !!revision.previous && actionDomain(revision.previous.action) === actionDomain(revision.next.action);
    const transition = sameDomain
      ? `${targetsText(revision.previous!.targetSeats)} → ${targetsText(revision.next.targetSeats)}`
      : targetsText(revision.next.targetSeats);
    const revisionText = changed
      ? `\n改口说明：${revision.revisionNarrative ?? "未明确解释改口（系统不代写原因）"}`
      : "";
    return `[决策#${revision.decisionIdx}｜${revision.stage}｜${revision.next.action}] ${transition}\n当时完整想法：${revision.next.rationale || "（未填写）"}${revisionText}`;
  });
  return `【你的完整意图轨迹】（这是你此前自己的思考与行动，不是系统命令；可继续、修正或放弃，改变由你依据当下信息决定）\n${lines.join("\n")}`;
}
