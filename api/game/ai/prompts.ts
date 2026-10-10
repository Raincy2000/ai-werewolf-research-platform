// ============================================================
// 提示词组装
// 信息壁垒铁律：prompt 只能由 PendingDecision.view 序列化生成，
// 绝不允许接触引擎其他内部状态。view 返回的数据 = 该玩家被允许知道的全部信息。
// ============================================================

import { ROLE_META, type Camp, type RoleId } from "../../../contracts/game";
import type { DecisionKind, PendingDecision, PlayerView } from "../engine/api";

export interface AssembledPrompt {
  system: string;
  user: string;
}

const CAMP_LABEL: Record<Camp, string> = {
  wolf: "狼人",
  god: "神职",
  villager: "平民",
};

// 引擎阶段 id → 中文阶段名（未知 id 回退为原文展示）
export const PHASE_LABEL: Record<string, string> = {
  "night.nightmare": "夜晚 · 噩梦之影行动",
  "night.wolfThink": "夜晚 · 狼队独立思考",
  "night.wolfDiscuss": "夜晚 · 狼队讨论",
  "night.wolf": "夜晚 · 狼人行动",
  "night.gargoyle": "夜晚 · 石像鬼行动",
  "night.guard": "夜晚 · 守卫行动",
  "night.dreamer": "夜晚 · 摄梦人行动",
  "night.witch": "夜晚 · 女巫行动",
  "night.seer": "夜晚 · 预言家行动",
  "night.psychic": "夜晚 · 通灵师行动",
  "night.demonHunter": "夜晚 · 猎魔人行动",
  "night.crow": "夜晚 · 乌鸦行动",
  "night.gravekeeper": "夜晚 · 守墓人行动",
  "day.sheriffRun": "白天 · 警长竞选报名",
  "day.sheriffSpeech": "白天 · 警上发言",
  "day.sheriff.withdraw": "白天 · 退水环节",
  "day.sheriffVote": "白天 · 警徽投票",
  "day.sheriffOrder": "白天 · 警长定序",
  "day.skill": "白天 · 主动技能窗口",
  "day.announce": "白天 · 昨夜公告",
  "day.speech": "白天 · 放逐发言",
  "day.vote": "白天 · 放逐投票",
  "day.pk": "白天 · 平票PK",
  "day.lastWords": "遗言环节",
  "day.exileSkill": "放逐技能询问",
  "postgame.discuss": "赛后讨论",
};

// 按角色的策略指导
const ROLE_STRATEGY: Record<RoleId, string> = {
  villager:
    "你是平民：没有技能，靠发言与投票找狼。认真记票型和发言漏洞，敢于质疑，但也别被狼人带节奏错杀好人。",
  werewolf:
    "你是狼人：夜晚与队友商议刀人（优先猎杀神职），白天伪装好人。可以带节奏抗推平民、必要时弃车保帅做高自己身份，也可诈神身份扰乱视听；注意言行一致，别聊爆。",
  wolfKing:
    "你是狼王：打法同狼人；你死亡时可开枪带走一人，尽量把枪口留给确定的神职。",
  whiteWolfKing:
    "你是白狼王：白天发言阶段可自爆并带走一名玩家。被集火时果断自爆带走关键神（如预言家），为狼队追轮次。",
  gargoyle:
    "你是石像鬼：不与狼队见面，单兵作战。每晚验一人具体身份，白天伪装好人、暗中把火力引向神职；其余狼死光后由你带刀。",
  nightmare:
    "你是噩梦之影：每晚最先恐惧一人。优先恐惧女巫/预言家/守卫等关键神职封锁其技能；不要连续两夜恐惧同一人。",
  bloodMoon:
    "你是血月使徒：关键时刻自爆可封印次夜全部神技；若你作为最后一狼被放逐，放逐无效。藏好自己，择机而动。",
  hiddenWolf:
    "你是隐狼：不与狼队见面，被预言家查验显示为好人。利用天然好人身份大胆带节奏；其余狼死光后由你带刀。",
  mechWolf:
    "你是机械狼：每晚可模仿一名玩家，被查验时显示为该身份。优先模仿好人身份保命；其余狼死光后由你带刀。",
  seer: "你是预言家：每晚验一人。前期适当隐藏身份避免被刀；拿到查杀或积累足够信息后，选准时机跳身份报验人（警上起跳是常见打法），并给出清晰的警徽流。",
  psychic:
    "你是通灵师：每晚验出一人具体身份。前期适当隐藏，掌握狼坑后跳身份带队，报出完整验人链。",
  witch:
    "你是女巫：解药毒药各一瓶，同一晚只能用一瓶。解药优先留给关键神职（若本局规则允许自救，也可留给自己）；毒药要撒给发言最像狼的人，切忌毒错神职。",
  hunter:
    "你是猎人：死亡时可开枪带走一人。前期藏好身份，中刀或被推后枪口对准最像狼的人。",
  guard:
    "你是守卫：每晚守护一人（可自守），不能连续两晚守同一人。优先守预言家等明神，与女巫解药错开。",
  idiot:
    "你是白痴：被放逐时可翻牌免死。可以适度激进发言钓鱼，引诱狼人冲票你。",
  knight:
    "你是骑士：白天发言可翻牌决斗（一局一次）：戳中狼则狼死并直接入夜，戳错则你出局。信息足够时再亮剑。",
  dreamer:
    "你是摄梦人：每晚必须摄梦一人（不可自摄）。被摄者当夜免疫狼刀，但连续两晚被摄会死。平衡保护与杀伤。",
  gravekeeper:
    "你是守墓人：每晚得知上一白天被放逐者是否为狼。用这个信息修正狼坑，适时公开带队。",
  demonHunter:
    "你是猎魔人：第二晚起每晚可狩猎：中狼则狼死，中好人则你死。没把握宁可放弃，不要盲猎。",
  crow:
    "你是乌鸦：每晚诽谤一人，使其次日白天被投票时额外计一票。诽谤最像狼的人，帮好人冲票。",
};

// 按决策类型的字段填写指引
export const KIND_GUIDE: Record<DecisionKind, string> = {
  nightmareFear: "选择今晚要恐惧的目标，填 targets=[目标座位]。恐惧神职可封锁其当夜技能。",
  wolfThink:
    "狼人夜间独立思考环节（频道讨论之前）：speech 留空，只需 thought。独立分析当前局势、拟定你心目中的刀口人选与理由、规划白天的伪装策略，随后的频道讨论中你将据此与队友交涉。",
  wolfDiscuss:
    "这是狼队夜间内部讨论：speech 必填，内容只有你的狼队友能看到（绝不会公开给好人）。讨论今晚刀谁、说明理由，可以回应队友此前的发言、协商统一刀口，也可以制定白天的伪装策略（谁冲锋、谁倒钩、谁诈神）。发言顺序规则：队内按座位顺序每晚各发言一次，后发言的队友能看到先发言者的内容，你的发言也会被排在你后面的队友看到。",
  wolfKill:
    "投票落刀：综合刚才全队讨论，投出你的刀口票，填 targets=[目标座位]。你的选择会与狼队友的选择取多数票决定最终刀口。",
  gargoyleCheck: "选择今晚要查验的目标，填 targets=[目标座位]，你将得知TA的具体身份。",
  guardProtect: "选择今晚要守护的目标，填 targets=[目标座位]；放弃守护则 skip=true。",
  dreamerDream: "选择今晚要摄梦的目标，填 targets=[目标座位]（必须选择，不可摄自己）。",
  witchAction:
    "决定是否用药：用解药救今夜被刀者 → witchSave=true；使用毒药 → targets=[毒杀目标]；不用药 → skip=true。同一晚只能用一瓶药。",
  seerCheck: "选择今晚要查验的目标，填 targets=[目标座位]，你将得知TA是好人还是狼人。",
  psychicCheck: "选择今晚要查验的目标，填 targets=[目标座位]，你将得知TA的具体身份。",
  mechWolfMimic:
    "选择今晚要模仿的玩家，填 targets=[目标座位]（你被查验时将显示为该身份）；不模仿则 skip=true。",
  demonHunterHunt:
    "选择今晚要狩猎的目标，填 targets=[目标座位]（中狼则狼死，中好人则你死）；没把握则 skip=true。",
  crowCurse:
    "选择今晚要诽谤的目标，填 targets=[目标座位]（次日白天其被投票时额外计一票）；放弃则 skip=true。",
  sheriffRun:
    "警长竞选报名：上警参与竞选 → targets=[1]；留在警下投票 → targets=[0]。警徽=归票位+1.5票，是阵营核心资产（警徽流）：有明确信息要带（如预言家报查验，靠归票位串联信息链）或想带队才上警。注意流程保障：警上发言结束后还有「退水环节」可放弃竞选转为警下投票——所以可以先上警听听风评、表表态，不合适再退，不必因怕下不来台而不敢上警。但全员上警会因无人投票导致警徽直接流失；狼人也可抢警徽混淆视听，需评估暴露风险。",
  sheriffSpeech:
    "发表警上竞选发言，speech 必填。说明你为什么适合当警长、你的信息或听感，争取警徽（归票位+1.5票——警徽流意味着你能带队归票、死后还能移交警徽延续信息链）。发言结束后还有退水环节可放弃竞选，现在尽情展示自己即可。",
  sheriffWithdraw:
    "退水抉择（全体候选人同时权衡，互不可见，结果统一公布——参考暗票机制）：警上发言已结束。targets=[0]=继续竞选（进入警徽投票决选，接受警下玩家投票）；targets=[1]=退水（放弃竞选，转为警下玩家参与警徽投票）。权衡：觉得自己当选希望渺茫/不想暴露在归票位 → 退水还能投票选别人；有信心带队或手握关键信息（如预言家）→ 留下争取警徽。由于同时权衡、统一公布，你无法参考其他候选人的去留再做决定，请按自身形势独立判断。",
  sheriffVote:
    "投票选警长，填 targets=[你支持的候选人座位]。警徽=归票位+1.5票：优先投给你认为信息最可靠/最能带队的候选人，警惕狼人抢警徽拿归票权。",
  sheriffOrder:
    "警长定序：决定今天全体发言的顺序方向，填 targets=[1] 升序 或 targets=[0] 降序（从你的下一位开始按座位循环依次发言，你自己固定在最后的归票位发言）。策略考量：让可疑的人先发言——先发言者掌握的信息少、容易暴露破绽；让你信得过的人后发言——可以总结前面场况、带节奏归票。结合昨夜信息与你重点想听的位置选择「警左/警右」方向。",
  daySkill:
    "白天主动技能权衡（白天全程实时跟进：夜亡公告后、上警名单公布后、警长当选后、每段发言之后、被放逐者遗言后与技能询问后都会再次获得机会，可自由把握最佳时机）：骑士填 duel=座位号 翻牌决斗（全场仅一次：中狼则狼出局并立即入夜，中好人则你出局）；狼人填 selfDestruct=true 自爆（当天剩余流程跳过直接入夜，可打断不利信息的继续扩散，白狼王自爆还可带走一人）；或填 surrender=true 白日交刀认输（狼队认输、神民立即获胜，仅局面崩溃胜利无望时用）；或填 declareVictory=true 白日交刀宣布胜利（狼队立即获胜，仅必胜时用：非狼玩家仅剩1人、或存活人数配置使好人绝无翻盘轮次、或其他你确信的必胜局面，误判则狼队白给）；时机不成熟则 skip=true 按兵不动继续观察。铁律：若你是场上最后一只存活的狼，自爆后场上再无狼人、神民立即胜利（直接判负），绝不能自爆！speech 留空，thought 写下你对当前局势与时机的权衡。",
  daySpeech:
    "发表白天发言，speech 必填。狼人可同时填 selfDestruct=true 自爆（跳过当天剩余流程直接入夜；但若是最后一只存活的狼，自爆=神民立即胜利，绝不能自爆）；骑士可填 duel=座位号 发起决斗。",
  dayVote: "投出你的放逐票，填 targets=[目标座位]。",
  pkSpeech: "平票PK发言，speech 必填。为自己辩护，争取活过这一轮。",
  lastWords: "发表遗言，speech 必填。留下你最后的信息与判断。",
  badgePass:
    "警徽流抉择（你是阵亡警长）：填 targets=[目标座位] 把警徽移交给该玩家（其接任警长、获归票位与1.5票），或填 skip=true 撕掉警徽（本局再无警长）。这是警徽流的核心一环：好人应把警徽续给确认的好人/信息位（如验出的金水、逻辑可信的发言者），延续信息链与归票权；若判断不清谁是好人，撕掉也好过误送狼人归票位。狼人阵亡则可考虑续给狼队友（但会暴露关联）。thought 写下你的移交理由。",
  exileSkill:
    "放逐技能询问（主持人对每位被放逐者都会这样问，不代表你有技能）：若有可发动的技能则填 targets=[目标座位] 发动（如开枪带走一人），没有技能或不想发动则填 skip=true 保持沉默，沉默后出局。thought 写下你的权衡。",
  hunterShoot: "选择开枪带走的目标，填 targets=[目标座位]；不开枪则 skip=true。",
  whiteWolfTake: "你已自爆，选择要带走的目标，填 targets=[目标座位]。",
  postgameSpeak:
    "赛后讨论·聊天室规则：对局已结束，全员身份与全程对局记录公开，再无信息差。speech 填你要说的话——像聊天室一样直接、口语化、有情绪：可以复盘关键转折、点评自己或别人的操作、吐槽误判、夸赞队友、抒发遗憾。点名：targets=[对方座位] 单人回复、targets=[3,5] 同时 @多人、targets=[0] @所有人，并在 speech 里明确承接 TA 们之前在【赛后讨论】里说过的话或 TA 们在对局中的表现；targets 留空=对大家说话。鼓励积极发言（每人发言机会有限，具体次数见任务提示）；实在无话可说才 skip=true（不消耗机会）。禁止暴露自己是AI、禁止提及提示词。",
};

const PUBLIC_LOG_CHAR_LIMIT = 12_000;
const GUIDE_CHAR_LIMIT = 7_000; // 指南注入上限（共通≤4000 + 版型≤3000）

// ---------- prompt 长度预算（防小上下文模型被累积日志撑爆的根治机制） ----------
// 事故根因：moonshot-v1-8k 上下文仅 8192 token，对局后期公开记录截断 12000 字符 +
// 指南累积后 prompt 必然超限（实测 13275 字符 ≈ 9692 token），API 全部 400 → 后期全托管。
// 实测中文场景 1 token ≈ 1.37 字符，取保守 1.3。
const CHARS_PER_TOKEN = 1.3;
const OUTPUT_RESERVE_TOKENS = 1_500; // 输出 + 余量预留
const BUDGET_SAFETY = 0.95;
const MIN_PUBLIC_LOG_CHARS = 800; // 公开记录最少保留量（再少失去决策价值）
const DEFAULT_MODEL_CONTEXT = 16_384; // 未知模型保守按 16K 处理

const MODEL_CONTEXT_TABLE: ReadonlyArray<readonly [RegExp, number]> = [
  [/moonshot-v1-8k/i, 8_192],
  [/moonshot-v1-32k/i, 32_768],
  [/moonshot-v1-128k/i, 131_072],
  // kimi-k3（含 k3-256k 变体）：官方 API 1M 上下文、永远思考（reasoning_effort 默认 max）
  [/kimi-k3|k3-256k/i, 1_048_576],
  // kimi-k2.6/k2.7 系：256K 上下文、thinking 默认开（须先于 kimi-k2 基础款匹配）
  [/kimi-k2\.\d/i, 262_144],
  [/kimi-k2|kimi-latest|kimi-thinking/i, 131_072],
  [/deepseek/i, 65_536],
  [/gpt-4o|gpt-4\.1|gpt-5/i, 128_000],
  [/claude/i, 200_000],
];

/** 按模型名推断上下文 token 数（未知模型保守 16K，防小模型被撑爆） */
export function modelContextTokens(model: string): number {
  for (const [re, ctx] of MODEL_CONTEXT_TABLE) if (re.test(model)) return ctx;
  return DEFAULT_MODEL_CONTEXT;
}

/** 该模型单次调用的输入字符总预算（system+user 合计） */
export function promptCharBudget(contextTokens: number): number {
  return Math.max(
    2_000,
    Math.floor((contextTokens - OUTPUT_RESERVE_TOKENS) * BUDGET_SAFETY * CHARS_PER_TOKEN),
  );
}

function fmtSeats(seats: number[]): string {
  return seats.length ? seats.map((s) => `${s}号`).join("、") : "无";
}

export function formatPublicLog(log: string[], charLimit: number = PUBLIC_LOG_CHAR_LIMIT): string {
  if (log.length === 0) return "（暂无公开记录）";
  // 分层压缩（对局后期提速核心）：最近 VERBATIM_LINES 条全文保留（近期决策上下文完整），
  // 更早的条目逐条截断为摘要（保留事件主体与对象，token 占用约降 60%）——
  // 否则后期每步都把上万字符日志发给模型，响应越来越慢
  const VERBATIM_LINES = 40;
  const OLD_LINE_MAX = 60;
  const lines = log.map((l, i) => {
    const isRecent = i >= log.length - VERBATIM_LINES;
    const body = isRecent || l.length <= OLD_LINE_MAX ? l : `${l.slice(0, OLD_LINE_MAX)}…`;
    return `${i + 1}. ${body}`;
  });
  const text = lines.join("\n");
  if (text.length > charLimit) {
    return `（早期记录已省略）\n${text.slice(-charLimit)}`;
  }
  return text;
}

/** 指南注入按预算截断（保留尾部：版型特定经验在后，对本局更相关） */
function clampGuide(guide: string, charLimit: number): string {
  const g = guide.trim();
  if (g.length <= charLimit) return g;
  return `（指南前文已省略）\n${g.slice(-charLimit)}`;
}

// 序列化私密信息（全部来自 view.private，信息壁垒内）
export function describePrivateInfo(view: PlayerView): string {
  const p = view.private;
  const lines: string[] = [];
  if (p.wolfTeammates && p.wolfTeammates.length > 0) {
    lines.push(`- 你的狼队友：${fmtSeats(p.wolfTeammates)}（夜间共同行动；发言注意别暴露彼此）`);
  }
  if (p.wolfChat && p.wolfChat.length > 0) {
    lines.push(
      `- 狼队讨论记录（仅狼队友可见，按发言时间序；后发言者可以看到先发言队友的内容）：\n${p.wolfChat.map((l) => `  · ${l}`).join("\n")}`,
    );
  }
  if (p.seerChecks && p.seerChecks.length > 0) {
    lines.push(
      `- 你的验人记录：${p.seerChecks.map((c) => `${c.seat}号=${c.result === "wolf" ? "狼人" : "好人"}`).join("；")}`,
    );
  }
  if (p.psychicChecks && p.psychicChecks.length > 0) {
    lines.push(`- 你的验人记录：${p.psychicChecks.map((c) => `${c.seat}号=${c.result}`).join("；")}`);
  }
  if (p.gargoyleChecks && p.gargoyleChecks.length > 0) {
    lines.push(`- 你的查验记录：${p.gargoyleChecks.map((c) => `${c.seat}号=${c.result}`).join("；")}`);
  }
  if (p.witchPotions) {
    lines.push(
      `- 剩余药水：解药${p.witchPotions.save ? "有" : "无"}，毒药${p.witchPotions.poison ? "有" : "无"}`,
    );
  }
  if (p.witchVictimTonight != null) {
    lines.push(`- 今夜 ${p.witchVictimTonight}号 被狼人袭击（你可以用解药救TA）`);
  }
  if (p.guardHistory && p.guardHistory.length > 0) {
    lines.push(`- 你的守护历史：${fmtSeats(p.guardHistory)}（不能连续两晚守同一人）`);
  }
  if (p.dreamerHistory && p.dreamerHistory.length > 0) {
    lines.push(`- 你的摄梦历史：${fmtSeats(p.dreamerHistory)}（同一人连续两晚被摄会死）`);
  }
  if (p.nightmareHistory && p.nightmareHistory.length > 0) {
    lines.push(`- 你的恐惧历史：${fmtSeats(p.nightmareHistory)}（不能连续两夜恐惧同一人）`);
  }
  if (p.crowHistory && p.crowHistory.length > 0) {
    lines.push(`- 你的诽谤历史：${fmtSeats(p.crowHistory)}`);
  }
  if (p.gravekeeperReveals && p.gravekeeperReveals.length > 0) {
    lines.push(
      `- 你的守墓结果：${p.gravekeeperReveals.map((r) => `${r.seat}号=${r.wasWolf ? "狼人" : "好人"}`).join("；")}`,
    );
  }
  if (p.demonHunterResults && p.demonHunterResults.length > 0) {
    const diedLabel = { target: "对方死亡", self: "你死亡", none: "无人死亡" } as const;
    lines.push(
      `- 你的狩猎结果：${p.demonHunterResults.map((r) => `${r.seat}号→${diedLabel[r.died]}`).join("；")}`,
    );
  }
  if (p.lastNightDeaths) {
    lines.push(
      p.lastNightDeaths.length
        ? `- 昨夜死亡公告：${fmtSeats(p.lastNightDeaths)}`
        : "- 昨夜平安夜（无人死亡）",
    );
  }
  if (p.fearedTonight) {
    lines.push("- 【警告】你今夜被噩梦之影恐惧，技能被封印");
  }
  if (p.bloodMoonSealed) {
    lines.push("- 【警告】血月封印中：今夜所有神职技能失效");
  }
  return lines.length ? lines.join("\n") : "- （暂无私密信息）";
}

export interface BuildPromptOptions {
  retryNote?: string; // 上一次输出被引擎判定非法时的错误原因（服务层重试时传入）
  guide?: string;     // 经验指南全文（历代AI对局沉淀的公共教程；空/缺省则不注入）
  resumeNote?: string; // 暂停恢复参考：挂起时保存的未完成思考量/恢复说明（恢复重想时注入）
  modelContext?: number; // 模型上下文 token 数（缺省按保守 16K）：公开记录/指南注入预算按预算截断
  notes?: string[];   // 该座位的对局笔记（其此前行动+想法的紧凑记录，仅本人可见）
  timeLimitSec?: number; // AI 单决策总时限（秒；设置后须告知 AI 快速决断）
  studyNote?: string;  // 赛前图书馆学习心得（仅本人可见；开启图书馆的对局注入）
}

// 向后兼容：第二个参数也接受 string（等价于 { retryNote }）
export function buildPrompt(
  pending: PendingDecision,
  opts?: BuildPromptOptions | string,
): AssembledPrompt {
  const retryNote = typeof opts === "string" ? opts : opts?.retryNote;
  const guide = typeof opts === "string" ? undefined : opts?.guide;
  const resumeNote = typeof opts === "string" ? undefined : opts?.resumeNote;
  const notes = typeof opts === "string" ? undefined : opts?.notes;
  const timeLimitSec = typeof opts === "string" ? undefined : opts?.timeLimitSec;
  const studyNote = typeof opts === "string" ? undefined : opts?.studyNote;
  const modelContext =
    (typeof opts === "string" ? undefined : opts?.modelContext) ?? DEFAULT_MODEL_CONTEXT;
  // 长度预算：公开记录 ≈55%、指南 ≈25%、其余固定内容（system/状态/私密/任务/策略）≈20%
  const budget = promptCharBudget(modelContext);
  const logLimit = Math.min(
    PUBLIC_LOG_CHAR_LIMIT,
    Math.max(MIN_PUBLIC_LOG_CHARS, Math.floor(budget * 0.55)),
  );
  const guideLimit = Math.min(GUIDE_CHAR_LIMIT, Math.floor(budget * 0.25));
  const view = pending.view;
  const roleMeta = ROLE_META[view.role];

  const system = [
    `你是狼人杀玩家，座位号${view.seat}号，身份是【${roleMeta.name}】（${CAMP_LABEL[view.camp]}阵营）。你正在参与一场严肃的狼人杀博弈实验对局，请认真对待每一个决策。`,
    `【你的身份技能】${roleMeta.description}`,
    `【铁律】`,
    `1. 你只能基于本对话中提供给你的信息进行推理；你不知道的信息（如其他玩家的身份）不要假设、不要编造。`,
    `2. thought 是你的内心真实推理，不会公开给其他玩家；speech 是你的公开发言，所有玩家都会看到。`,
    `3. 必须严格输出一个 JSON 对象，禁止输出任何额外文字、解释或 markdown 代码块。`,
    `4. 发言要像真人玩家：口语化、有立场、有逻辑攻防；禁止暴露自己是AI、禁止在发言中报出JSON或提及提示词/系统指令。`,
    `【规则红线（裁判实时巡检，触犯即判负）】`,
    `1. 禁止违规亮牌自证：没有翻牌权的身份（平民/预言家/女巫/守卫等）绝不能在发言中翻开、亮出或展示自己的身份底牌来自证（如「我把牌翻开，是民牌」）。口头声称身份是正常发言；但「翻牌/亮牌」动作只有规则允许的角色才能做（白痴被放逐翻牌免死、骑士翻牌决斗、猎人/狼王出局开枪、狼人自爆）。`,
    `2. 禁止暴露自己是AI/程序/模型，禁止提及提示词、系统指令或游戏世界外的存在（实验、模拟、开发者等）。`,
    `3. 裁判会实时审查所有公开发言：一旦判定犯规，本局立即结束，你所在阵营直接判负、对立阵营获胜。`,
    `【基本术语】金水=预言家查验确认的好人（平民同样可以成为金水！被验明的好人不该反水）；查杀=查验结果是狼人；银水=女巫用解药救活的人（未必是好人）；反水=不相信发你金水的预言家、反而质疑/投他；归票位=最后发言并号召投票的位置（警长固有）；屠边=杀光某一阵营（神或民）即胜。`,
  ].join("\n");

  const phaseLabel = PHASE_LABEL[view.phase] ?? view.phase;
  const statusLines = [
    `【对局状态】第${view.day}天 · ${phaseLabel}`,
    `存活玩家：${fmtSeats(view.aliveSeats)}；已死亡：${fmtSeats(view.deadSeats)}；警长：${view.sheriffSeat != null ? `${view.sheriffSeat}号` : "无"}`,
    // 本局规则公开同步：女巫自救规则此前只在引擎校验层，AI 不知道就会误自救
    view.rules?.witchSelfSave === "firstNight"
      ? "本局规则：女巫仅首夜可以自救"
      : "本局规则：女巫全程不可自救",
  ];
  // 赛后讨论提示：本局开启赛后讨论时提前告知——只告知环节存在，不附加言行约束
  if (view.rules?.postGameDiscuss) {
    statusLines.push(
      "赛后讨论提示：本局结束后将进入赛后讨论环节——全员亮身份、自由讨论，想说什么都可以。",
    );
  }
  // 时间锚定：消除"幻影昨天"——开局第一夜此前没有任何事件，第1天白天之前只经历了第一夜
  if (view.day === 1 && view.phase.startsWith("night")) {
    statusLines.push("这是开局第一夜，对局刚刚开始，此前没有发生任何事件（不存在'昨天/昨夜/前几天'）");
  } else if (view.day === 1 && view.phase.startsWith("day")) {
    statusLines.push("今天是对局第一天，此前只经历了开局第一夜");
  }
  const revealed = Object.entries(view.revealedRoles);
  if (revealed.length > 0) {
    statusLines.push(
      `已翻牌身份：${revealed.map(([s, r]) => `${s}号=${ROLE_META[r as RoleId]?.name ?? r}`).join("、")}`,
    );
  }
  if (!view.selfAlive) {
    statusLines.push("你已死亡（当前是你的遗言/死后技能环节）");
  }

  const targetLine =
    pending.kind === "sheriffRun"
      ? "【合法选择】targets=[1] 表示参与竞选，targets=[0] 表示不参与"
      : pending.kind === "sheriffOrder"
        ? "【合法选择】targets=[1] 表示升序发言，targets=[0] 表示降序发言"
        : `【合法目标】${pending.options.length ? fmtSeats(pending.options) : "任意存活玩家"}${pending.allowSkip ? "；允许放弃（skip=true）" : "；必须行动"}`;

  // witchAction 追加规则补充：KIND_GUIDE 是静态文案，女巫自救规则随版型变化，这里动态拼接
  let kindGuide = KIND_GUIDE[pending.kind];
  if (pending.kind === "witchAction" && view.role === "witch") {
    kindGuide +=
      view.rules?.witchSelfSave === "firstNight"
        ? "本局规则补充：女巫仅首夜可以自救（首夜之后即使被刀的是你，也不能用解药救自己）。"
        : "本局规则补充：女巫全程不能自救——即使今夜被刀的是你，也不能用解药救自己。";
    // 动态禁令（事故教训：模型无视"剩余药水：无"静态行，解药用完后仍反复 witchSave=true 被判非法）
    const potions = view.private?.witchPotions;
    if (potions && !potions.save)
      kindGuide += "【硬性禁令】你的解药已经用完：本夜禁止输出 witchSave=true，只能选择毒药或 skip。";
    if (potions && !potions.poison)
      kindGuide += "【硬性禁令】你的毒药已经用完：本夜不可使用毒药（不要输出 targets）。";
    if ((view.private?.witchVictimTonight ?? null) == null)
      kindGuide += "【硬性禁令】今夜无人被刀：解药不可用，禁止输出 witchSave=true。";
  }
  // 带人/开枪类：模型易误输出 selfDestruct/duel（事故实锤：白狼王带人输出自爆被判非法）
  if (pending.kind === "whiteWolfTake" || pending.kind === "hunterShoot") {
    kindGuide += `【硬性禁令】本决策只接受 ${
      pending.allowSkip ? "targets=[目标] 或 skip=true（选择不开枪/不带人）" : "targets=[目标]"
    }：禁止输出 selfDestruct、duel、surrender 等其他字段。`;
  }

  const retryLines = retryNote
    ? [
        `【上一次输出非法】你的上一次输出被系统判定非法：${retryNote}。请修正后重新输出合法 JSON（特别注意互斥规则：女巫同一晚只能用一瓶药，selfDestruct 与 duel 不可同时给出）。`,
        "",
      ]
    : [];

  // 暂停恢复参考：对局在该决策点被暂停挂起，恢复重新思考时，
  // 把挂起前未完成的思考量作为参考注入（可采纳、修正或抛弃），避免灵感流失
  const resumeLines = resumeNote ? [`【暂停恢复参考】${resumeNote}`, ""] : [];

  // 经验指南：历代AI对局沉淀的公共教程，所有玩家都可查阅（供参考但不必盲从）
  const guideLines = guide?.trim()
    ? [
        "【经验指南】（历代AI对局沉淀的公共教程，所有玩家都可查阅，供你参考但不必盲从）",
        clampGuide(guide, guideLimit),
        "",
      ]
    : [];

  // 赛前学习心得（图书馆资料自主学习成果 + 历史对局参考，仅本人可见）：
  // 学习阶段按「精简实战」目标生成（≤1400 字符），此处上限 1600 保证全量注入不截断
  const studyLines = studyNote?.trim()
    ? [
        "【赛前学习心得】（你开赛前研读图书馆资料与历史对局形成的理解，仅你自己可见；对局中请运用这些认识）",
        studyNote.trim().slice(0, 1600),
        "",
      ]
    : [];

  // 对局笔记（该座位此前的行动+内心想法，仅本人可见）：保真自我历史，注意力聚焦新变局
  const noteLines = notes?.length
    ? [
        "【你的对局笔记】（你此前的行动与内心想法记录，仅你自己可见；据此保持自我认知连续，把精力放在最新变化上）",
        notes.join("\n").slice(-1500),
        "",
      ]
    : [];

  const user = [
    statusLines.join("\n"),
    "",
    "【公开记录】（按时间顺序，所有玩家均可见）",
    formatPublicLog(view.publicLog, logLimit),
    "",
    "【你的私密信息】（仅你自己可见，是否公开是你的策略选择）",
    describePrivateInfo(view),
    "",
    ...noteLines,
    ...studyLines,
    `【你的任务】${pending.hint}`,
    timeLimitSec && timeLimitSec > 0
      ? `【时间限制】本决策限时约 ${Math.max(30, Math.floor(timeLimitSec))} 秒：请快速决断——thought 从简（80 字内）、speech 精炼直达要点，不要长篇推演。`
      : "",
    kindGuide,
    targetLine,
    "",
    ...retryLines,
    ...resumeLines,
    ...guideLines,
    `【策略参考】${ROLE_STRATEGY[view.role]}`,
    "【心理博弈】这是一场博弈实验：鼓励试探、诈身份、带节奏、隐藏真实意图；发言要结合场上具体的人和事，不要千篇一律。",
    "",
    "【输出契约】严格输出以下结构的 JSON（禁止任何额外内容）：",
    // 字段顺序即生成顺序：speech 最前——DeepSeek 等模型 thought 易写超长被服务端截断，
    // speech 先生成可保证对局推进必需的发言完整落出（截断修补后仍可用）
    '{"speech":"公开发言（发言类必填，200字内，像真人玩家一样发言，禁止暴露自己是AI、禁止报出JSON；（括号）动作描写不计入字数；非发言类留空串）","thought":"你的真实内心推理（不会公开，200字内，精炼不要长篇）","targets":[座位号],"skip":false,"selfDestruct":false,"duel":null,"witchSave":false}',
    "用不到的字段保持默认值即可。再次强调：只输出 JSON 本体。",
  ].join("\n");

  return { system, user };
}
