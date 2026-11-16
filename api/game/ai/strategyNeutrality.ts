// ============================================================
// 策略表达中立化：官方规则与客观事实可以明确陈述；策略、经验、心得只作建议。
// 这里只处理策略文本，不处理 JSON 输出契约或官方规则，避免把硬规则软化。
// ============================================================

export const STRATEGY_NEUTRALITY_PROMPT = [
  "【策略中立约定】官方规则与客观事实可以明确陈述；策略、经验和心得只作建议。",
  "不得把单个案例或高频打法概括为固定答案，不得用“必须/优先/果断/切忌/务必”等强制词指定打法，也不得用“只应/立即/尽早”等固定时机词把特定打法包装为默认最优解。",
  "保留反例、替代策略及其收益和风险；公开身份、隐藏、上警、退水等选择都可以结合情境讨论，不能预设唯一正确时机。",
  "历史参考只描述案例及其条件，不写成本局行动方案；每条参考同时给出不适用边界或收益反转条件。",
  "样本量与置信度只描述证据覆盖情况，不代表策略必然有效。",
].join("\n");

const OFFICIAL_RULE_PREFIX = /^(\s*[-*]?\s*[^，；。]*?(?:官方规则|本局规则|规则补充|同一晚只能|不能连续两夜|不能连续两晚|不可自摄|不可自救|不能自救|最后一狼.*自爆)[^，；。]*)/;
const ABSOLUTE_STRATEGY = /必须|应当|应该|优先|果断|切忌|务必|不要|不能|不可|不应|不得|绝不|别/;

/** 旧策略文本兼容层：能可靠改写的转为建议，仍带绝对命令的策略行停用。 */
export function neutralizeStrategyText(text: string): string {
  return text.split("\n").flatMap((line) => {
    // 规则与策略可能混在一行：仅保留开头的规则事实，后续策略继续中立化。
    const official = OFFICIAL_RULE_PREFIX.exec(line);
    const rulePrefix = official?.[0] ?? "";
    const strategyText = rulePrefix ? line.slice(rulePrefix.length) : line;
    const softened = strategyText
      .replace(/不为藏锋(?:而)?不上警/g, "可因藏锋留在警下")
      .replace(/警上必跳/g, "警上可选择起跳")
      .replace(/必跳/g, "可选择起跳")
      .replace(/必须起跳/g, "可考虑起跳")
      .replace(/必须上警|必上警/g, "可考虑上警")
      .replace(/只应/g, "可考虑")
      .replace(/应(?=明确|把|在|立即|尽早|先|主动|公开|利用|继续|按|给|用|停止|避免|让|谨慎|评估|选择)/g, "可考虑")
      .replace(/立即/g, "可在合适时机")
      .replace(/尽早/g, "选择合适时机")
      .replace(/应尽早报出验人/g, "可根据信息收益与暴露风险选择报验时机")
      .replace(/不应该|不应|不该/g, "可谨慎避免")
      .replace(/应当|应该/g, "可考虑")
      .replace(/必须/g, "可考虑")
      .replace(/务必/g, "可酌情")
      .replace(/优先/g, "可重点考虑")
      .replace(/果断/g, "可评估后选择")
      .replace(/切忌/g, "可注意避免")
      .replace(/不要/g, "可谨慎避免");
    // 不把无法可靠判断语义的绝对命令继续交给玩家；只停用该策略部分，不改写历史库。
    if (ABSOLUTE_STRATEGY.test(softened)) return rulePrefix ? [rulePrefix] : [];
    return [rulePrefix + softened];
  }).join("\n");
}

/** 复盘仅软化经验教训章节；事实描述、规则认知错误和输出格式不被改写。 */
export function neutralizeAnalysisReport(text: string): string {
  const heading = /(^|\n)##\s*六[、.．]\s*经验教训[^\n]*\n?/.exec(text);
  if (!heading || heading.index == null) return text;
  const index = heading.index + heading[0].length;
  return text.slice(0, index) + neutralizeStrategyText(text.slice(index));
}
