import { createHash } from "node:crypto";
import type { GameEvent } from "../../contracts/game";
import type { DecisionInput } from "./engine/api";

export interface CognitionDecisionRow {
  decision: DecisionInput;
}

export interface SharedPhrase {
  text: string;
  speakerCount: number;
  occurrenceCount: number;
}

export interface CognitionAudit {
  source: {
    eventCount: number;
    actorEventCount: number;
    eventHash: string;
  };
  intent: {
    decisionCount: number;
    explicitIntentCount: number;
    basisReferenceCount: number;
  };
  interaction: {
    speechCount: number;
    directedSpeechCount: number;
    silenceCount: number;
  };
  language: {
    speakerCount: number;
    spokenCharacterCount: number;
    sharedPhrases: SharedPhrase[];
  };
}

type IntentLike = { basisEventSeqs?: unknown };

function intentOf(input: DecisionInput): IntentLike | null {
  const value = (input as DecisionInput & { intent?: unknown }).intent;
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as IntentLike
    : null;
}

function spokenText(text: string): string {
  return text
    .replace(/（[^）]*）|\([^)]*\)/g, "")
    .replace(/[\s\p{P}\p{S}]/gu, "");
}

/** 描述性语言审计：通用四字片段，不设禁词、好坏分或目标分布。 */
export function sharedLanguagePhrases(events: GameEvent[], width = 4, limit = 20): SharedPhrase[] {
  const perSpeaker = new Map<number, Map<string, number>>();
  for (const event of events) {
    if (event.type !== "speech" || event.actor == null) continue;
    const text = spokenText(event.content);
    const counts = perSpeaker.get(event.actor) ?? new Map<string, number>();
    for (let index = 0; index + width <= text.length; index += 1) {
      const phrase = text.slice(index, index + width);
      counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
    }
    perSpeaker.set(event.actor, counts);
  }
  const phrases = new Map<string, { speakers: Set<number>; occurrenceCount: number }>();
  for (const [seat, counts] of perSpeaker) {
    for (const [text, count] of counts) {
      const row = phrases.get(text) ?? { speakers: new Set<number>(), occurrenceCount: 0 };
      row.speakers.add(seat);
      row.occurrenceCount += count;
      phrases.set(text, row);
    }
  }
  return [...phrases.entries()]
    .filter(([, row]) => row.speakers.size >= 2)
    .map(([text, row]) => ({ text, speakerCount: row.speakers.size, occurrenceCount: row.occurrenceCount }))
    .sort((a, b) => b.speakerCount - a.speakerCount || b.occurrenceCount - a.occurrenceCount || a.text.localeCompare(b.text, "zh-CN"))
    .slice(0, limit);
}

/** R0：只读快照。所有计数都可回到原始事件／决策，不参与运行时动作选择。 */
export function buildCognitionAudit(events: GameEvent[], decisions: CognitionDecisionRow[] = []): CognitionAudit {
  const speeches = events.filter((event) => event.type === "speech" && event.actor != null);
  const directedSpeechCount = speeches.filter((event) => {
    const target = event.meta?.addressTo;
    return target === "all" || typeof target === "number" || (Array.isArray(target) && target.length > 0);
  }).length;
  const explicitIntents = decisions.map((row) => intentOf(row.decision)).filter((row): row is IntentLike => row !== null);
  const basisReferenceCount = explicitIntents.reduce(
    (sum, intent) => sum + (Array.isArray(intent.basisEventSeqs) ? intent.basisEventSeqs.filter((seq) => Number.isInteger(seq)).length : 0),
    0,
  );
  return {
    source: {
      eventCount: events.length,
      actorEventCount: events.filter((event) => event.actor != null).length,
      eventHash: createHash("sha256").update(JSON.stringify(events.map((event) => [event.seq, event.actor, event.content]))).digest("hex"),
    },
    intent: {
      decisionCount: decisions.length,
      explicitIntentCount: explicitIntents.length,
      basisReferenceCount,
    },
    interaction: {
      speechCount: speeches.length,
      directedSpeechCount,
      silenceCount: events.filter((event) => /选择沉默|暂不发言/.test(event.content)).length,
    },
    language: {
      speakerCount: new Set(speeches.map((event) => event.actor)).size,
      spokenCharacterCount: speeches.reduce((sum, event) => sum + spokenText(event.content).length, 0),
      sharedPhrases: sharedLanguagePhrases(events),
    },
  };
}

/** R5：开发环境基线对比；只返回计数差，不计算“拟真分”。 */
export function compareCognitionAudits(before: CognitionAudit, after: CognitionAudit) {
  return {
    source: {
      eventCount: after.source.eventCount - before.source.eventCount,
      actorEventCount: after.source.actorEventCount - before.source.actorEventCount,
      sameEvents: before.source.eventHash === after.source.eventHash,
    },
    intent: {
      decisionCount: after.intent.decisionCount - before.intent.decisionCount,
      explicitIntentCount: after.intent.explicitIntentCount - before.intent.explicitIntentCount,
      basisReferenceCount: after.intent.basisReferenceCount - before.intent.basisReferenceCount,
    },
    interaction: {
      speechCount: after.interaction.speechCount - before.interaction.speechCount,
      directedSpeechCount: after.interaction.directedSpeechCount - before.interaction.directedSpeechCount,
      silenceCount: after.interaction.silenceCount - before.interaction.silenceCount,
    },
    language: {
      speakerCount: after.language.speakerCount - before.language.speakerCount,
      spokenCharacterCount: after.language.spokenCharacterCount - before.language.spokenCharacterCount,
      beforeSharedPhrases: before.language.sharedPhrases,
      afterSharedPhrases: after.language.sharedPhrases,
    },
  };
}
