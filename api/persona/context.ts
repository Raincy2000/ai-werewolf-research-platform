import type { PersonaCard } from "../../contracts/persona";

export const PERSONA_CONTEXT_VERSION = "persona-context-v1";

export interface PersonaContext {
  /** 本人能够知道、记得并主动引用的材料。 */
  conscious: string;
  /** 只驱动行为、不得被人物自述的参数与潜在冲突。 */
  latent: string;
  /** 最终表达专用：完整语言风格与全部语气锚点。 */
  voice: string;
  audit: {
    version: string;
    observer: string;
    degraded: string[];
  };
}

export interface PersonaSnapshot<TMemory = unknown> {
  card: PersonaCard;
  memory: TMemory;
  version: string;
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

/** 开局冻结人格与记忆，避免赛后回写改变本局语义。 */
export function createPersonaSnapshot<TMemory>(
  card: PersonaCard,
  memory: TMemory,
): PersonaSnapshot<TMemory> {
  return {
    card: copy(card),
    memory: copy(memory),
    version: `${PERSONA_CONTEXT_VERSION}:${card.updatedAt}`,
  };
}

function line(label: string, value: string | null | undefined): string {
  const text = value?.trim();
  return text ? `【${label}】${text}` : "";
}

/**
 * 单一权限边界：这里决定哪些资料能被本人说出，哪些只能潜在影响行为。
 * 不在此处按字符数裁剪；预算降级必须由调用方显式记录。
 */
export function buildPersonaContext(card: PersonaCard, memoryText: string | null): PersonaContext {
  const p = card.profile;
  const conscious = [
    line("你是谁", p.summary),
    line("人设与性格", p.persona),
    line("塑造你的经历", p.experiences),
    line("你知道的重要关系", p.relationships),
    line("你的价值观", p.values),
    line("你的欲望与驱动力", p.desires),
    line("你的恐惧与软肋", p.fears),
    line("你的社交面具", p.socialMask),
    line("你的习惯与癖好（仅作本人历史倾向；关系信物不自动等于本人固定穿戴或高频动作。新的习惯可通过主体自己的观察、学习或模仿逐渐形成，系统不把他人动作预置为本人习惯）", p.quirks),
    line("你亲笔写下的自我认知（用于校准，不得复述）", p.essence),
    memoryText?.trim() ? `【你记得的往事】${memoryText.trim()}` : "",
  ].filter(Boolean).join("\n");
  const latent = [
    "【隐性行为调制：不得自述、不得引用参数名或数值】",
    JSON.stringify(card.params),
    line("你未必意识到的内在冲突", p.innerWorld),
  ].filter(Boolean).join("\n");
  const voice = [
    line("你的完整语言风格", p.speechStyle),
    p.quotes.length ? `【你说过的话（语气锚点，不必每轮使用）】${p.quotes.join("／")}` : "",
  ].filter(Boolean).join("\n");
  return {
    conscious,
    latent,
    voice,
    audit: {
      version: `${PERSONA_CONTEXT_VERSION}:${card.updatedAt}`,
      observer: card.notes,
      degraded: [],
    },
  };
}

/** 小上下文模型的显式降级：整块舍弃低优先材料，绝不截断句子或削弱语言／参数层。 */
export function degradePersonaContext(ctx: PersonaContext, charCap: number): PersonaContext {
  if (charCap <= 0 || ctx.conscious.length + ctx.latent.length + ctx.voice.length <= charCap) return ctx;
  const blocks = ctx.conscious.split(/\n(?=【)/).filter(Boolean);
  const total = () => blocks.join("\n").length + ctx.latent.length + ctx.voice.length;
  const priority = [
    "你记得的往事",
    "你的习惯与癖好",
    "你的社交面具",
    "你知道的重要关系",
    "塑造你的经历",
    "你的欲望与驱动力",
    "你的价值观",
    "你的恐惧与软肋",
    "你亲笔写下的自我认知（用于校准，不得复述）",
  ];
  const degraded: string[] = [];
  for (const label of priority) {
    if (total() <= charCap) break;
    const index = blocks.findIndex((block) => block.startsWith(`【${label}】`));
    if (index < 0) continue;
    blocks.splice(index, 1);
    degraded.push(label);
  }
  return {
    ...ctx,
    conscious: blocks.join("\n"),
    audit: { ...ctx.audit, degraded: [...ctx.audit.degraded, ...degraded] },
  };
}
