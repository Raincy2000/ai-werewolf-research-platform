// ============================================================
// 心理检查师（原「解剖师」）：对局后为人格座位撰写《心理检查报告》
// （更名缘由：人格跨对局长期留存、持续演进——尸检对应死亡语义，不合适；
// 心理检查=对一场对局后的在续人格做状态体检）
// 铁律4「双视角分析」：每个转折点必须同时给出博弈论解释与人格动力学解释；
// 铁律6 附录：关键时刻的参数撕裂逐帧还原（哪几极在拉扯、强度多少、哪边胜出、代价是什么）。
// ============================================================

import type { SeatAiConfig } from "../../contracts/game";
import type { PersonaCard } from "../../contracts/persona";
import { callAi } from "../game/ai/providers";
import { ANALYST_MAX_RETRIES, ANALYST_TIMEOUT_MS } from "../game/analyst";

export function buildPsyCheckPrompt(opts: {
  card: PersonaCard;
  seat: number;
  roleName: string;
  outcome: string;
  digest: string;
  gameTitleNo?: string;
}): { system: string; user: string } {
  const { card, seat, roleName, outcome, digest } = opts;
  const system = [
    "你是「心理检查师」——数字人类心理学实验场的人格心理检查师。对局结束，你为一个人格撰写《心理检查报告》。这个人格不会被销毁：TA 会带着这一局的印记继续走向下一局——你的检查是在续生命的状态体检，不是遗体解剖。",
    "你同时拥有两种目光：博弈论（轮次/信息集/收益矩阵）与人格动力学（参数拉扯/防御/创伤/依恋）。",
    "铁律4：每个转折点必须同时输出【博弈论解释】与【人格动力学解释】，二者并列、不得互相替代。",
    "铁律6：还原撕裂——人格的真实不在结果里，在几组参数同时拉扯的过程里。",
    "你的分析必须有证据：引用摘要中「第几天、几号、具体发言/行动/心理活动」，禁止泛泛而谈。",
  ].join("\n");

  const paramsSnapshot = [
    `大五：开放${card.params.bigFive.openness} 尽责${card.params.bigFive.conscientiousness} 外向${card.params.bigFive.extraversion} 宜人${card.params.bigFive.agreeableness} 神经质${card.params.bigFive.neuroticism}`,
    `依恋：焦虑${card.params.attachment.anxiety} 回避${card.params.attachment.avoidance}；黑暗四：马基雅维利${card.params.darkTetrad.machiavellianism} 自恋${card.params.darkTetrad.narcissism} 精神病态${card.params.darkTetrad.psychopathy} 施虐${card.params.darkTetrad.sadism}`,
    `情绪调节：重评${card.params.emotionRegulation.cognitiveReappraisal} 抑制${card.params.emotionRegulation.expressiveSuppression} 反刍${card.params.emotionRegulation.rumination}；SDT：自主${card.params.sdt.autonomy} 胜任${card.params.sdt.competence} 归属${card.params.sdt.relatedness}`,
  ].join("\n");

  const user = [
    `【检查对象】${card.name}（本局 ${seat} 号 · ${roleName}）；本局结局：${outcome}`,
    opts.gameTitleNo ? `【对局标题号】${opts.gameTitleNo}` : "",
    card.originName ? `【原型】${card.originName}${card.originSource ? ` · ${card.originSource}` : ""}` : "",
    "",
    "【人格参数卡快照】（本局赛后当前值）",
    paramsSnapshot,
    "",
    card.profile.persona ? `【人设】${card.profile.persona.slice(0, 500)}` : "",
    "",
    "【对局摘要】",
    digest,
    "",
    "【输出要求】markdown 格式，全文 ≤2000 字，严格包含以下章节（## 标题）：",
    "## 一、人格卡快照",
    "（TA 带着怎样的参数与过往走进这局：两三句，点出最醒目的冲突参数组合）",
    "## 二、三个关键转折点",
    "（逐点写：①事件（第几天/谁/具体言行）②【博弈论解释】轮次/信息/收益 ③【人格动力学解释】哪些参数驱动了这个选择）",
    "## 三、参数撕裂还原",
    "（挑 1-2 个 TA 最挣扎的时刻逐帧还原：参数A要什么 / 参数B要什么 / 冲突强度估计 / 最终哪边胜出 / 付出的代价；引用心理活动片段为证）",
    "## 四、人格状态与走向",
    "（这一局之后 TA 的状态如何：确认了什么执念、留下了什么印记、可能怎样改变 TA——人格持续演进，为记事簿的人格漂移提供注解）",
  ].join("\n");
  return { system, user };
}

/** 执行心理检查（失败抛错，由调用方记事件流，绝不影响对局收敛） */
export async function runPsyCheck(
  cfg: SeatAiConfig,
  opts: {
    card: PersonaCard;
    seat: number;
    roleName: string;
    outcome: string;
    digest: string;
    gameTitleNo?: string;
  },
): Promise<string> {
  const prompt = buildPsyCheckPrompt(opts);
  const res = await callAi(cfg, prompt.system, prompt.user, {
    jsonMode: false,
    timeoutMs: ANALYST_TIMEOUT_MS,
    maxRetries: ANALYST_MAX_RETRIES,
  });
  if (!res.ok || !res.text?.trim()) {
    throw new Error(`心理检查师生成报告失败：${res.error ?? "返回内容为空"}`);
  }
  return res.text.trim();
}
