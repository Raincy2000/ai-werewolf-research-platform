const FORBIDDEN_SELF_REPORT: Array<[RegExp, string]> = [
  [/大五|黑暗四|依恋焦虑|依恋回避|马基雅维利主义/g, "人格模型自述"],
  [/神经质\s*\d+|开放性\s*\d+|尽责性\s*\d+|外向性\s*\d+|宜人性\s*\d+/g, "参数数值自述"],
  [/人格参数漂移|参数漂移|心镜状态报告|人格状态报告/g, "研究机制自述"],
];

function compact(text: string): string {
  return text.replace(/\s+/g, "").trim();
}

/** 只检查人物可见文本；观察者侧 analysisPsy 不经过此检查。 */
export function inspectPersonaText(text: string): string[] {
  const issues: string[] = [];
  for (const [pattern, label] of FORBIDDEN_SELF_REPORT) {
    pattern.lastIndex = 0;
    if (pattern.test(text) && !issues.includes(label)) issues.push(label);
  }
  return issues;
}

/** 检测完全复用的九字及以上片段；普通“投票／警徽”等短术语不会触发。 */
export function sharedStylePhrases(current: string, priorPeers: string[]): string[] {
  const source = compact(current);
  const peers = priorPeers.map(compact).filter(Boolean);
  if (source.length < 9 || peers.length === 0) return [];
  const found: string[] = [];
  for (let i = 0; i <= source.length - 9; i += 1) {
    const gram = source.slice(i, i + 9);
    if (/^[0-9#号玩家发言]+$/.test(gram)) continue;
    if (peers.some((peer) => peer.includes(gram)) && !found.includes(gram)) found.push(gram);
    if (found.length >= 3) break;
  }
  return found;
}

export function duplicateExactText(current: string, previous: string | null | undefined): boolean {
  return Boolean(current.trim() && previous?.trim() && compact(current) === compact(previous));
}

export function mergePersonaTextOnly<T extends object>(original: T, rewritten: T): T {
  return {
    ...original,
    speech: (rewritten as { speech?: unknown }).speech,
    thought: (rewritten as { thought?: unknown }).thought,
  } as T;
}

export function buildFidelityRetryNote(issues: string[], lockedAction: unknown): string {
  return [
    "【表达保真重写】上一次文本存在：" + issues.join("、"),
    "只重写 speech、thought、bodyTrace，不得改变任何投票、技能目标或行动字段。",
    `【已冻结行动】${JSON.stringify(lockedAction)}`,
    "重写时沿用本人语言风格，不得复制其他玩家的口癖、比喻体系和句式，不得自述人格参数或研究机制。",
  ].join("\n");
}
