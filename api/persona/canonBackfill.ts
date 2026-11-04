// ============================================================
// 现实层（L1）补完：单视角关系记忆生成
//
// 铁律：
//  1. 完全单视角 —— 只给本人格卡 + 他对目标的描述，不与对方配对、不对齐。
//  2. 事件唯一 —— 同一件事只记一条，多种感觉写在同一段 feeling 里。
//  3. 不封顶 —— 只要影响过关系就记，数量由 AI 自己判断。
//  4. 全量验证 —— 每条都要过事实核查，未达门槛不入库。
//  5. 幂等 —— 每对最多一个任务；重跑走增量，force 才整对重建。
//
// 2026-10-22 审计 P0-8/P0-7/P1-14 修复：
//  - planIncrementalDiff / verifyEventOrder 两处裸调用加 180s 超时；
//  - job 级 25 分钟 deadline，逐事件检查；running 时重复启动返回 busy；
//  - correct 分支 existingRows.find 校验 existingId（越权 id 不生效）、manual 行不更正、origin 不被洗成 ai；
//  - remove 分支先跑 verifyRemoval 二次核查，未确认则 kept 并计入 stats.pendingRemovals；
//  - force 改为「先完成枚举/核查，再软删旧 AI 行并写入」——生成/核查失败不丢旧数据；
//  - 增量计划失败真正执行全量新增 fallback（按事件文本去重）；
//  - 截断检测：caster 返回 truncated/finishReason=length 时 job failed，不落半截数据；
//  - stats/warning/webSearched 落库；itemCount = 该 pair 当前 active 记忆总数。
// ============================================================
import { and, eq, isNull, ne } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { personas, personaCanonLog, canonBackfillJobs } from "../../db/schema";
import { listPresets } from "../queries/presets";
import { callWithWebSearch } from "../persona/caster";
import { prepareWebContext, cleanWorkName } from "../persona/websearch";
import { planIncrementalDiff, verifyEventOrder } from "./canonDiff";
import { verifyCanonEvent, verifyRemoval, cardSupportsEvent } from "../persona/canonVerify";
import { insertReturningId } from "../queries/dialect";
import type { AiTestInput } from "../../contracts/game";

export interface BackfillResult {
  jobId: number;
  /** ★ 本次生成是否真的联网（由 API 实证，不是假设）*/
  webSearched?: boolean;
  /** 无联网时的说明 */
  webWarning?: string;
  /** AI 生成的候选事件数 */
  generated: number;
  /** 通过事实核查的 */
  verified: number;
  /** 被拒的 */
  rejected: number;
  /** 实际入库（新增）*/
  written: number;
  /** 更正的条数（增量模式）*/
  corrected?: number;
  /** 保留未动的条数（增量模式）*/
  kept?: number;
  /** 因「事件不存在 / 与关系人无关」被移除的条数（增量模式，且通过二次核查）*/
  removed?: number;
  /** 待人工确认的删除（二次核查未通过，记录保留）*/
  pendingRemovals?: number;
  /** force 模式下软删的旧 AI 行数 */
  forceRemoved?: number;
  /** 增量计划失败后是否走了全量新增 fallback */
  fallbackUsed?: boolean;
  /** 跳过原因（幂等命中 / 正在运行 busy）*/
  skipped?: boolean;
  /** 同一 pair 已有任务在运行（不重复启动）*/
  busy?: boolean;
  /** 输出被截断（job failed）*/
  truncated?: boolean;
  error?: string;
}

export interface BackfillItem {
  seq: number;
  era: string;
  /** 当时年龄 */
  age: number | null;
  /** 发生地点 */
  place: string | null;
  event: string;
  feeling: string;
  impact: string | null;
  certainty: string;
  /** 人格卡原文依据（有则免联网核查）*/
  basis?: string;
  /** 原作出处（话数/集数/章节名）*/
  source?: string;
  /** 时间依据：原作明载 / 按设定推定的推理链 */
  eraBasis?: string;
}

const PROMPT_VERSION = "canon-l1-v3";

/** 阶段1：联网穷举事件清单上限（Kimi k3 联网慢，给足 10 分钟）*/
const ENUM_TIMEOUT_MS = 600_000;

/** 阶段2：基于清单写感受上限（不联网，纯生成）*/
const FEEL_TIMEOUT_MS = 180_000;

/** 增量计划 / 顺序考证单次上限（审计 P0-7：此前是裸 await，端点不响应会永久 hang）*/
const DIFF_TIMEOUT_MS = 180_000;
const ORDER_TIMEOUT_MS = 180_000;

/** 删除二次核查单次上限 */
const REMOVAL_TIMEOUT_MS = 180_000;

/** job 级硬上限（25 分钟）：逐事件检查，超时中止并保留旧数据 */
const JOB_DEADLINE_MS = 25 * 60_000;

/** 同一 pair 刚完成后的防抖窗口（防连点重复跑）*/
const DONE_DEBOUNCE_MS = 60_000;

/** 给 Promise 加超时（caster 的 longFetch 主动取消了传输层超时）*/
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(label + " 超时（" + Math.round(ms / 1000) + "s）")),
      ms,
    );
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

function timeOf(v: unknown): number {
  if (v instanceof Date) return v.getTime();
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** 事件文本归一化（用于 fallback 全量新增时去重）*/
function normalizeMemoryText(s: string): string {
  return String(s || "")
    .replace(/[\s，。！？、；：（）【】《》「」『』·.,!?;:'"()\[\]<>]/g, "")
    .toLowerCase();
}

/** 从人格卡 relationships 文本里，抽出提到目标人物的那一段 */
function extractAbout(relationships: unknown, targetName: string): string {
  const text = typeof relationships === "string" ? relationships : "";
  if (!text) return "";
  // relationships 常用「名字：描述」分段，按分号/换行切
  const segs = text.split(/[;；\n]/).map((x) => x.trim()).filter(Boolean);
  const hit = segs.filter((s) => s.includes(targetName));
  return hit.length > 0 ? hit.join("；") : "";
}

// ============================================================
// 两阶段生成（Kimi k3 联网穷举单次常超 300s，必须拆开）
//   阶段 1：联网只出「事件清单」（输出小、快）
//   阶段 2：不联网，基于清单写第一人称感受（纯生成、快）
// ============================================================

/**
 * 清洗时间表达。
 *
 * 用户定调：**不强制精确到年**，而是保留「已知真实的最详细时间」。
 * 支持：2005年 / 2006年8月 / 1990-2005年 / 两千年前 / 幼年 / 某事件之后
 */
export function cleanEra(raw: string): string {
  let x = String(raw || "").trim();
  if (!x) return "时期不明";
  // 复合串「2006年 · 16岁 · 东京都」→ 取时间段（第一段）
  const segs = x.split(/[·｜|]/).map((y) => y.trim()).filter(Boolean);
  if (segs.length > 1) x = segs[0]!;
  // 去掉年龄残留
  x = x.replace(/[（(]?\d+\s*岁[）)]?/g, "").trim();
  x = x.replace(/^[\s·、,，]+|[\s·、,，]+$/g, "");

  // ★ 混进描述文字时只保留时间表达
  //   例：「2017年12月24日（杰死亡）；遗体被羂索占据在其后」→「2017年12月24日」
  const timeExpr = x.match(/^(\d{4}\s*年(?:\s*\d{1,2}\s*月)?(?:\s*\d{1,2}\s*日)?(?:\s*[前后末]|\s*之后)?)/);
  if (timeExpr) x = timeExpr[1].trim();
  // 含分号/长括号说明 → 取第一段
  if (/[；;]/.test(x)) x = x.split(/[；;]/)[0]!.trim();
  if (/[（(]/.test(x)) x = x.split(/[（(]/)[0]!.trim();

  return x.slice(0, 24) || "时期不明";
}

/**
 * 清洗地点。
 *
 * 用户定调：「未知的就不提」。
 * 所以模糊表述一律置空（前端不显示），拼接地点只留主地点。
 */
export function cleanPlace(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  let x = String(raw).trim();
  if (!x) return null;
  // 去掉括号补充说明（「海外任务地（具体地点资料未载）」→「海外任务地」）
  x = x.replace(/[（(][^）)]*[）)]/g, "").trim();
  // 只有**纯占位词**才丢弃；「某村」「海外任务地」这类模糊地点要保留
  // （用户定调：五条不可能跑到空里，写模糊即可）
  if (/^(资料未载|未载|不详|未知|不明|待考|具体地点|无|—|-)$/.test(x)) return null;
  // 「A及B」「A和B」这类拼接：只保留第一个
  x = (x.split(/[及和与]/)[0] ?? "").trim();
  // 反复出现的「·」分隔里，超过 3 段的截断
  const segs = x.split("·").map((y) => y.trim()).filter(Boolean);
  if (segs.length === 0) return null;
  x = segs.slice(0, 2).join("·");
  if (x.length > 40) return null;
  return x || null;
}

/**
 * 时间排序键（与前端 RelationDetailPanel.timeKey 保持同一规则）。
 * 保留月/日/季节，避免「2006年夏」「2006年8月」「2006年」被压成同一键。
 */
export function eraSortKey(era: string): string {
  const str = String(era || "");
  const y = str.match(/(\d{4})/);
  if (!y) return "9999-99-99";
  const mo = str.match(/(\d{1,2})\s*月/);
  const dd = str.match(/(\d{1,2})\s*日/);
  // 「N月后」「N年末」「之后」表示该时段的末尾 → 用 month=13 表示"年末之后"
  // ★ 审计 P0-8：原正则 /(末|底|后|之后|以后)\str*$/ 的 "\str*" 打错（字面 s + t），
  //   实测「2005年末/2005年后」均 false → 年末排序成死代码。这里修为尾部空白匹配。
  const isLate = /(末|底|后|之后|以后)\s*$/.test(str.trim());
  let month = mo ? Number(mo[1]) : 0;
  if (!month) {
    if (/春/.test(str)) month = 3;
    else if (/夏/.test(str)) month = 6;
    else if (/秋/.test(str)) month = 9;
    else if (/冬/.test(str)) month = 12;
  }
  // 年末/月后 → 排到该年（或该月之后）最后
  if (isLate) month = month > 0 ? month + 1 : 13;
  const pad = (n: number) => String(n).padStart(2, "0");
  // month=13 时直接输出 "13"，保证排在 12 之后
  return y[1] + "-" + pad(month) + "-" + pad(dd && !isLate ? Number(dd[1]) : 0);
}

export interface EnumeratedEvent {
  era: string;
  /** 当时年龄 */
  age?: number | string;
  /** 发生地点 */
  place?: string;
  event: string;
  source?: string;
  /** 时间依据：原作明载 / 按设定推定的推理链 */
  eraBasis?: string;
}

const ENUM_SYSTEM_LINES = [
  "你是某部作品/现实人物的资料检索员，但输出不是百科词条，而是**角色本人记得的关系事件**。任务是**联网穷举**两个人之间所有让关系发生转折的事件。",
  "",
  "【要求】",
  "1. 必须联网检索原作（或现实公开资料）。",
  "2. 可采信来源（按可信度）：",
  "   ① 原作正传（漫画/小说/动画/游戏正传）",
  "   ② 官方设定集、公式书、作者访谈、后记",
  "   ③ **官方授权或认可的衍生作品**（官方手游/主机游戏/外传小说/舞台剧）",
  "   ④ 作者后续补充的设定（续作、番外、官方问答）",
  "   以上四类都算依据。例：灰原雄的术式「蒸汽咒法」原作漫画未提，但在官方认可的游戏剧情中有——应采信。",
  "   仅排除：同人、二创、AU、私设、粉丝分析、非官方改编。",
  "3. 【必须主动检索官方衍生】除原作正传外，还要主动检索：",
  "   · 官方设定集 / 公式书（术式、血统、年表常在这里补完）",
  "   · 官方授权游戏剧情（例：灰原雄的术式「蒸汽咒法」原作漫画未提，官方游戏里有）",
  "   · 作者访谈、后记、官方问答",
  "   这些来源里补充的设定与剧情，**必须纳入**，不能因为是「衍生」就略过。",
  "3. 尽量穷举：初遇、结盟、并肩、共同的失去、互相拯救、理念分裂、背叛、沉默、诀别……",
  "   不要只写大事件——那些「看起来小、但关系从此不同了」的时刻同样要写。",
  "   还要写「关系人不在场、但我因此对 TA 的看法变了」的事件——",
  "   例：我得知 TA 屠了村（我不在场，但从此无法再坦然面对 TA）。",
  "3.1 【必须扫描的关系节点 —— 缺一类都算漏】",
  "   逐项检查，有原作依据就写：",
  "   ① 初遇/相识/成为同期或搭档；② 并肩/互相拯救/共同失去；",
  "   ③ 理念分裂/背叛/诀别/未能挽留；④ 死亡/临终/遗言/最后一面；",
  "   ⑤ 走马灯/冥界/死后世界/黄泉/灵魂重逢/轮回/幻觉/梦境/回忆——",
  "      即使主角已经死亡，也要写；死亡不是关系事件的终点。",
  "   ⑥ 官方续作/外传/剧场版/官方游戏/设定集/公式书/作者访谈里的情节；",
  "   ⑦ 关系人不在场、但主角得知后改变看法的事件。",
  "   例：五条悟死前的走马灯在冥界/机场与夏油杰再会；五条悟死后在官方续作/设定中的再会——",
  "   这类事件必须写进双方各自的关系记忆，不能只写一边。",
  "   如果原作只画了 A 的走马灯、没画 B 的视角：B 侧也要写 B 在死后/另一边/后来得知的认知；",
  "   依据不足的部分标「存疑」，不要编造具体细节。",
  "4. 每个事件必须给全这五项：",
  "     era   时间（如「845年」）",
  "     age   当时主角几岁（数字，如 9）",
  "     place 发生地点——**必须给一个可定位的值，不许留空**：",
  "       · 优先写原作明确提到的具体地名（如「希干希纳区」「雷贝利欧收容区」）",
  "       · 原作没说细，就写到能确定的最大范围（如「日本·东京都」「马莱大陆」）",
  "       · 连地域都推不出，写「未明确地点」——但不要留空",
  "     event 第一人称记忆——用「我」写，绝不出现主角自己的名字",
  "       **句首主语只能是「我」（或时间/地点状语）**；禁止以主角本名、第三人称「他/她/TA」",
  "       或客观事件名开头（如「五条悟与夏油杰……」/「夏油杰发动……」）。",
  "       必须写清：发生了什么、在场还有谁、结果如何；",
  "       **但更必须写「我当时怎么理解这件事」**：我看到的/听到的、我当时的判断、我以为 TA 是什么样的人、",
  "       我有没有误解、我记住了哪个细节。事件是「我的记忆」，不是历史大事记。",
  "       ❌ 禁止百科式编年史：如「五条悟与夏油杰在高专入学成为同期」「夏油杰发动百鬼夜行」；",
  "       ✅ 正例：「我入学那天第一次见到杰，只觉得这家伙笑得温和，没想到后来会跟他搭档那么多年」",
  "       ✅ 正例：「我听说杰屠了村，第一反应是不信——直到看见现场，我才明白我们回不去了」",
  "       每条 event 至少要有一处「我当时/我以为/我记得/我觉得/我没意识到/我后来才明白/我不敢承认」这类主观认知词。",
  "     source 原作出处（如「漫画第6话」「官方设定集 P.36」「游戏《咒术回战 Phantom Parade》第2章」）",
  "5. 【地点铁律】",
  "   · **必须给值**：事件一定发生在某个地方，绝不写空",
  "   · 能精确就精确；不能精确就写大范围（国家/城市）",
  "   · 完全推不出就写「未明确地点」",
  "   · 不许用「及」「和」拼接多个地点——只写最主要的那一个",
  "   · 不许在括号里写补充说明",
  "   · 地名用标准译名",
  "6. 【时间考究 —— 必须走推定流程，不许一笔带过】",
  "   ① 优先写原作明确给出的时间（如「850年」「2006年8月」「两千年前」）；",
  "   ② 原作没明说、但能由设定推定的，**必须推定并给出推理链**：",
  "      · 例：某角色「高专二年级」，主线时间为 2006 年 → 他们入学相识应为 2005 年；",
  "      · 例：已知角色年龄与设定年份 → 反推事件发生年；",
  "      · 例：「在某事件之前发生」→ 用该事件的时间反推；",
  "   ③ 推定结果写进 era，推理链写进 eraBasis；",
  "   ④ 完全推不出的，era 写「时期不明」，eraBasis 说明为什么推不出；",
  "   ⑤ era **保留最详细粒度**：有月日写月日，有年代写年代，跨多年写范围（如「1990-2005年」）。",
  "   ⑥ 【精度一致性 —— 极重要】同一段连续剧情里的事件，时间精度必须一致：",
  "      如果「理子之死」写作「2006年夏」，那么同一段里的「冲绳游玩」「觉醒反转术式」",
  "      也必须写到「2006年夏」或更细，**不许一个写「2006年」一个写「2006年夏」**。",
  "      否则排序时「2006年」会被误排到「2006年夏」之前，导致时间线错乱。",
  "7. 【关系事件的成立条件 —— 最重要】",
  "   一个事件能成为「主角对某人」的关系记忆，当且仅当：",
  "   该事件改变了主角与这个人的关系（认知 / 情感 / 立场 / 命运联系）。",
  "   改变可以是【主动】的，也可以是【被动】的：",
  "   · 主动：主角参与、目睹、得知 —— 这时写他看到/听到/经历的部分",
  "   · 被动：事件作用于主角，但主角未必意识到 ——",
  "     例：世界性记忆删除后他不再记得对方，但关系已经变了；",
  "     例：对方对主角做了某事，主角并不知情；",
  "     例：诅咒、契约、心理操作改变了主角对对方的态度。",
  "   这两类都要写。不要因为「主角可能不知道」就略过。",
  "",
  "   【写法】",
  "   · 主角能感知时：写他的视角（我参与 / 我看到 / 我听说）",
  "   · 主角不能感知时：写「客观上发生了什么 + 这件事如何改变了我们的关系」，",
  "     允许写「我不记得 / 我不知道 / 但那之后有什么不一样了」",
  "",
  "8. 【人称规则】event 是「他记得的事」，所以：",
  "   · 必须用「我」作为叙述主体；**feeling 也必须用「我」**；",
  "   · **允许**在合理语境出现自己的名字：",
  "     - 别人称呼我：「杰喊了一声『悟』」",
  "     - 身份声明：「我是五条悟，最强」",
  "     - 转述他人提到我：「他们都在说五条悟怎么怎么样」",
  "     - 自我评价时的第三人称口吻：「五条悟这个人啊，其实……」",
  "   · **禁止**的是：把整段写成第三人称客观摘要",
  "     如「五条悟与夏油杰在高专入学成为同期」——这种没有任何「我」的叙述",
  "   · 一句话：只要叙述主体是「我」，出现名字没问题。",
  "9. 输出精简：event 一句话说清即可，但必须带主观认知，不要写成百科条目。",
  "",
  "只输出 JSON：",
  '{"events":[{"era":"844年","age":9,"place":"希干希纳区郊外·山屋","event":"我杀死两名绑匪救出三笠，把自己的围巾围在她脖子上","source":"漫画第6话《少女看见的世界》","eraBasis":"原作明载"}]}',
];
const ENUM_SYSTEM = ENUM_SYSTEM_LINES.join("\n");

/** 第二轮补漏：只找第一轮漏掉的死亡/冥界/官方衍生事件，避免“大事件有了、再会与衍生没有” */
const ENUM_FILL_SYSTEM_LINES = [
  "你是「铸魂师」的补漏检索员。上一轮已经列出了一批关系事件；你只负责找漏，不重写已有内容。",
  "【必须逐项检查】",
  "1. 死亡/临终/遗言/最后一面；",
  "2. 走马灯/冥界/死后世界/黄泉/灵魂重逢/轮回/幻觉/梦境/回忆；",
  "3. 官方续作/外传/剧场版/官方游戏/设定集/公式书/作者访谈里的关键情节；",
  "4. 一方死后、另一方在另一边/后来得知的再会或认知变化；",
  "5. 关系人不在场、但主角得知后改变看法的事件。",
  "【事实铁律】只写有原作/官方资料依据的；不确定的标「存疑」；没有就返回空数组，绝不编造。",
  "【人称铁律】event 必须是「我」的第一人称记忆；句首只能是「我」或时间/地点状语。",
  "【去重】只输出上一轮没有的事件；相同事件不要重复。",
  "只输出 JSON：",
  '{"events":[{"era":"...","age":0,"place":"...","event":"我...","source":"...","eraBasis":"..."}]}',
];
const ENUM_FILL_SYSTEM = ENUM_FILL_SYSTEM_LINES.join("\n");

/** 是否缺少“死后/走马灯/官方衍生”这类容易漏的事件 */
export function needsCoverageSupplement(events: Array<{ event: string; source?: string }>): boolean {
  const blob = events.map((e) => e.event + " " + (e.source ?? "")).join("\n");
  const hasAfterlife = /(走马灯|冥界|死后|灵魂|黄泉|三途|轮回|遗言|最后一面|再会)/.test(blob);
  const hasOfficialSide = /(官方|续作|外传|剧场版|游戏|设定集|公式书|访谈|后记)/.test(blob);
  return !hasAfterlife || !hasOfficialSide;
}

/** 按 era + event 归一化去重 */
function mergeEnumerated(base: EnumeratedEvent[], extra: EnumeratedEvent[]): EnumeratedEvent[] {
  const seen = new Set(base.map((e) => (e.era + "|" + e.event).replace(/\s+/g, "")));
  const out = [...base];
  for (const e of extra) {
    const k = (e.era + "|" + e.event).replace(/\s+/g, "");
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}

/** 解析阶段1的 JSON：{events:[{era,event,source,phase}]} */
export function parseEnumerated(text: string): EnumeratedEvent[] {
  const cleaned = String(text || "").replace(/```(?:json)?/gi, "");
  const a = cleaned.indexOf("{");
  const b = cleaned.lastIndexOf("}");
  if (a < 0 || b <= a) return [];
  try {
    const o = JSON.parse(cleaned.slice(a, b + 1)) as Record<string, unknown>;
    const arr = Array.isArray(o.events) ? o.events : [];
    const out: EnumeratedEvent[] = [];
    for (const raw of arr) {
      const r = raw as Record<string, unknown>;
      const event = String(r.event ?? "").trim();
      if (!event) continue;
      const ageRaw = Number(r.age);
      out.push({
        era: cleanEra(String(r.era ?? "")),
        age: Number.isFinite(ageRaw) && ageRaw > 0 ? ageRaw : undefined,
        // 地点必须有值（用户定调：不能出现「跑到空里」）
        place: cleanPlace(r.place != null ? String(r.place) : null) ?? "未明确地点",
        event: event.slice(0, 300),
        source: r.source != null && String(r.source).trim() ? String(r.source).trim() : undefined,
        eraBasis: r.eraBasis != null && String(r.eraBasis).trim() ? String(r.eraBasis).trim() : undefined,
      });
    }
    return out;
  } catch {
    return [];
  }
}

const FEEL_SYSTEM_LINES = [
  "你是某部作品中的角色。现在要以**第一人称**为下面的事件清单写记忆。",
  "",
  "【对每条事件】",
  "  - feeling：你当时的感受、中途的动摇、现在的看法（写在同一段里，不要分成几条）",
  "  - impact：这件事改变了什么",
  "",
  "【铁律】",
  "1. 事件本身不能改（那是已经核实过的原作事实）。",
  "2. 每条事件只写一次感受；同一件事的多种感觉写在同一段。",
  "3. 用你的人格卡里那个人的口吻说话。",
  "4. 【禁止客观旁白】feeling 必须从「我」的认知出发：我当时怎么想、我怎样骗自己、我害怕/不甘/舍不得什么；",
  "   允许偏见、误判、自欺、说不出口的话。不要写史书式总结。",
  "   **feeling 句首只能是「我」（或时间/场景状语）**；禁止以「他/她/TA」或主角本名开头。",
  "   反例：「他看见那张脸时停了一下——就那一下。」（第三人称旁白）",
  "   反例：「对新生活与同伴抱有期待，尚未预见日后的分裂」（这是旁白，不是你）",
  "   正例：「我那时真觉得日子会一直这样下去，甚至懒得去看他眼里的阴影；现在回头看，那才是我最不敢承认的轻松。」",
  "5. impact 写「这件事在我心里改变了什么」（我对 TA 的看法 / 我自己的选择），不是事件的历史意义总结。",
  "6. 【人称铁律】必须用「我」，绝对不出现你自己的名字。",
  "   错误示例：「对五条而言这是少有的轻松时光」「五条自觉唯我独尊」「五条忙于任务」",
  "   正确示例：「那几天是我少有的轻松时光」「我第一次觉得自己无所不能」「我忙着任务，没看见他」",
  "",
  "只输出 JSON：",
  '{"items":[{"idx":1,"feeling":"...","impact":"..."}]}',
];
const FEEL_SYSTEM = FEEL_SYSTEM_LINES.join("\n");

/** 解析阶段2的 JSON：{items:[{idx,feeling,impact}]} */
export function parseFeelings(text: string): Map<number, { feeling: string; impact: string | null }> {
  const m = new Map<number, { feeling: string; impact: string | null }>();
  const cleaned = String(text || "").replace(/```(?:json)?/gi, "");
  const a = cleaned.indexOf("{");
  const b = cleaned.lastIndexOf("}");
  if (a < 0 || b <= a) return m;
  try {
    const o = JSON.parse(cleaned.slice(a, b + 1)) as Record<string, unknown>;
    const arr = Array.isArray(o.items) ? o.items : [];
    for (const raw of arr) {
      const r = raw as Record<string, unknown>;
      const idx = Number(r.idx);
      const feeling = String(r.feeling ?? "").trim();
      if (!Number.isFinite(idx) || !feeling) continue;
      m.set(idx, {
        feeling,
        impact: r.impact != null && String(r.impact).trim() ? String(r.impact).trim() : null,
      });
    }
  } catch {
    /* 解析失败返回空 */
  }
  return m;
}

/**
 * 判断一条关系记忆是否仍是第三人称/客观旁白。
 *
 * 用户实锤（2026-10-23）：event 可以是「五条悟在涩谷见到……」这种客观摘要，
 * feeling 也可以是「他看见那张脸时停了一下……」这种第三人称旁白。
 * 这里只做硬性视角拦截，不改写内容；改写交给 repairThirdPersonItems。
 */
export function isThirdPersonMemory(text: string, selfName?: string): boolean {
  const s = String(text ?? "").trim();
  if (!s) return true;
  // 没有第一人称主体，基本就是旁白/百科
  if (!s.includes("我")) return true;
  // 句首直接是主角本名（如「五条悟在涩谷……」/「夏油杰发动……」）
  if (selfName && s.startsWith(selfName)) return true;
  // 句首就是第三人称代词
  if (/^(他|她|TA|ta)(?=[\u4e00-\u9fa5])/.test(s)) return true;
  // 本名出现在「我」之前 → 先介绍别人/主角，再说我，仍像旁白
  if (selfName) {
    const me = s.indexOf("我");
    const name = s.indexOf(selfName);
    if (name >= 0 && name < me) return true;
  }
  return false;
}

const FIRST_PERSON_FIX_SYSTEM = [
  "你是叙述视角修复师。下面是一组关系记忆；每条都必须改成**本人格的第一人称记忆**。",
  "【只改视角】",
  "- event 与 feeling 的叙述主体必须是「我」；句首只能是「我」或时间/地点/场景状语。",
  "- 禁止句首用主角本名、第三人称「他/她/TA」或客观事件标题。",
  "- 只能改叙述视角和措辞；不得增删事件、时间、地点、来源、事实，不得改变人物关系。",
  "- 保留原句里的引语与语气；不要加新剧情。",
  "- impact 同样用「我」的视角写；没有就输出 null。",
  "",
  "只输出 JSON：",
  '{"items":[{"idx":1,"event":"...","feeling":"...","impact":"..."}]}',
].join("\n");

/** 把第三人称/客观记忆批量修复为第一人称；修不好就拒收，绝不把第三人称写进库 */
async function repairThirdPersonItems(
  items: BackfillItem[],
  cfg: AiTestInput,
  selfName: string,
  targetName: string,
  log: string[],
): Promise<{ items: BackfillItem[]; rejected: number }> {
  const badIdx = items
    .map((item, idx) => ({ item, idx }))
    .filter(({ item }) => isThirdPersonMemory(item.event, selfName) || isThirdPersonMemory(item.feeling, selfName));
  if (badIdx.length === 0) return { items, rejected: 0 };

  const payload = {
    self: selfName,
    target: targetName,
    items: badIdx.map(({ item, idx }) => ({
      idx: idx + 1,
      era: item.era,
      event: item.event,
      feeling: item.feeling,
      impact: item.impact,
    })),
  };

  let parsed: Array<{ idx: number; event?: string; feeling?: string; impact?: string | null }> = [];
  try {
    const res = await withTimeout(
      callWithWebSearch(cfg, FIRST_PERSON_FIX_SYSTEM, JSON.stringify(payload), { web: false }),
      FEEL_TIMEOUT_MS,
      "第一人称修复",
    );
    if (!res.truncated) {
      const cleaned = String(res.text || "").replace(/```(?:json)?/gi, "");
      const a = cleaned.indexOf("{");
      const b = cleaned.lastIndexOf("}");
      if (a >= 0 && b > a) {
        const obj = JSON.parse(cleaned.slice(a, b + 1)) as Record<string, unknown>;
        if (Array.isArray(obj.items)) {
          parsed = (obj.items as unknown[])
            .map((x) => x as Record<string, unknown>)
            .map((x) => ({
              idx: Number(x.idx),
              event: x.event != null ? String(x.event).trim() : undefined,
              feeling: x.feeling != null ? String(x.feeling).trim() : undefined,
              impact: x.impact == null || String(x.impact).trim() === "" ? null : String(x.impact).trim(),
            }));
        }
      }
    }
  } catch {
    /* 修复失败 → 下面按「仍不合格」拒收 */
  }

  const byIdx = new Map(parsed.filter((x) => Number.isFinite(x.idx)).map((x) => [x.idx, x]));
  const out: BackfillItem[] = [];
  let rejected = 0;
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const fixed = byIdx.get(i + 1);
    const event = fixed?.event || item.event;
    const feeling = fixed?.feeling || item.feeling;
    const impact = fixed && fixed.impact !== undefined ? fixed.impact : item.impact;
    if (isThirdPersonMemory(event, selfName) || isThirdPersonMemory(feeling, selfName)) {
      rejected++;
      log.push("视角拒收（仍为第三人称）：" + String(event).slice(0, 36));
      continue;
    }
    out.push({ ...item, event, feeling, impact });
  }
  if (out.length !== items.length) {
    log.push("第一人称修复：" + (items.length - rejected) + " 条通过，" + rejected + " 条拒收");
  }
  return { items: out, rejected };
}

/** 增量统计（成功/失败都要落库，UI 才能解释「为什么没写」）*/
interface BackfillStats {
  generated: number;
  verified: number;
  rejected: number;
  written: number;
  corrected: number;
  kept: number;
  removed: number;
  pendingRemovals: number;
  forceRemoved: number;
  fallbackUsed: boolean;
  webSearched: boolean;
  reseqCount: number;
  reason?: string;
  truncated?: boolean;
}

function emptyStats(): BackfillStats {
  return {
    generated: 0,
    verified: 0,
    rejected: 0,
    written: 0,
    corrected: 0,
    kept: 0,
    removed: 0,
    pendingRemovals: 0,
    forceRemoved: 0,
    fallbackUsed: false,
    webSearched: false,
    reseqCount: 0,
  };
}

/** 进程内并发守卫：同一 pair 同时只允许一个补完协程（DB running 状态之外的兜底） */
const runningPairs = new Set<string>();

/**
 * 现实层补完（单对人格）。
 *
 * 幂等/并发约束：
 *  - 同一 pair 已有 running 任务（未超 25 分钟且无 finishedAt）→ 返回 {busy:true, skipped:true}；
 *  - status=done 且 60 秒内刚完成 → 返回 skipped（防连点）；
 *  - force=true 才整对重建，且「先枚举/核查成功，再软删旧 AI 行」。
 */
export async function backfillCanonLog(input: {
  userId: string;
  personaId: number;
  aboutPersonaId: number;
  apiPresetId?: number | null;
  allowWeb?: boolean;
  /** 强制重跑（重建 AI 记录，manual 永不删）*/
  force?: boolean;
}): Promise<BackfillResult> {
  const pairKey = input.personaId + "->" + input.aboutPersonaId;
  if (runningPairs.has(pairKey)) {
    return { jobId: 0, busy: true, skipped: true, generated: 0, verified: 0, rejected: 0, written: 0 };
  }
  runningPairs.add(pairKey);
  try {
    return await backfillCanonLogInner(input);
  } finally {
    runningPairs.delete(pairKey);
  }
}

async function backfillCanonLogInner(input: {
  userId: string;
  personaId: number;
  aboutPersonaId: number;
  apiPresetId?: number | null;
  allowWeb?: boolean;
  force?: boolean;
}): Promise<BackfillResult> {
  const db = getDb();
  const { userId, personaId, aboutPersonaId, apiPresetId, allowWeb = true, force = false } = input;
  const stats = emptyStats();
  let candidates: BackfillItem[] = [];
  let webWarning: string | undefined;
  let jobId = 0;
  let deadlineAt = Date.now() + JOB_DEADLINE_MS;

  const fail = async (msg: string, extra?: Partial<BackfillStats>): Promise<BackfillResult> => {
    Object.assign(stats, extra);
    if (jobId) {
      try {
        await db.update(canonBackfillJobs).set({
          status: "failed",
          error: msg.slice(0, 500),
          stats: JSON.stringify({ ...stats, reason: msg }),
          webSearched: stats.webSearched ? 1 : 0,
          warning: webWarning ?? null,
          finishedAt: new Date(),
        }).where(eq(canonBackfillJobs.id, jobId));
      } catch { /* 台账写失败不掩盖真实错误 */ }
    }
    return {
      jobId,
      webSearched: stats.webSearched,
      webWarning,
      generated: stats.generated,
      verified: stats.verified,
      rejected: stats.rejected,
      written: stats.written,
      corrected: stats.corrected,
      kept: stats.kept,
      removed: stats.removed,
      pendingRemovals: stats.pendingRemovals,
      forceRemoved: stats.forceRemoved,
      fallbackUsed: stats.fallbackUsed,
      truncated: stats.truncated,
      error: msg,
    };
  };

  // ---- 读取任务（每对最多一行）----
  const existingJobs: any[] = await db
    .select()
    .from(canonBackfillJobs)
    .where(and(eq(canonBackfillJobs.personaId, personaId), eq(canonBackfillJobs.aboutPersonaId, aboutPersonaId)))
    .limit(1);
  const job = existingJobs[0];
  jobId = Number(job?.id ?? 0);

  // ---- running 去重：同一 pair 正在跑 → busy（不重复计费/不并发写）----
  if (job && job.status === "running") {
    const started = timeOf(job.createdAt);
    const fin = timeOf(job.finishedAt);
    const stale = fin > 0 || (started > 0 && Date.now() - started > JOB_DEADLINE_MS + 60_000);
    if (!stale) {
      return {
        jobId,
        busy: true,
        skipped: true,
        generated: 0,
        verified: 0,
        rejected: 0,
        written: 0,
      };
    }
    // 僵尸 running（进程中断）：允许重新接管
  }

  // ---- 幂等：仅拦截「刚跑完就重复点击」，不阻止真正的增量补完 ----
  if (job && job.status === "done" && !force) {
    const finishedAt = timeOf(job.finishedAt);
    if (finishedAt > 0 && Date.now() - finishedAt < DONE_DEBOUNCE_MS) {
      return {
        jobId,
        generated: 0,
        verified: 0,
        rejected: 0,
        written: Number(job.itemCount ?? 0),
        skipped: true,
      };
    }
  }

  // ---- 模型配置 ----
  let cfg: AiTestInput | null = null;
  try {
    const presets = await listPresets(String(userId));
    const chosen = apiPresetId != null ? presets.find((p) => p.id === apiPresetId) : presets[0];
    if (chosen) cfg = { provider: chosen.provider, baseUrl: chosen.baseUrl, model: chosen.model, apiKey: chosen.apiKey };
  } catch {
    cfg = null;
  }
  if (!cfg) {
    return {
      jobId,
      generated: 0,
      verified: 0,
      rejected: 0,
      written: 0,
      error: "无可用 API 配置",
    };
  }

  // ---- 读人格卡（只认当前用户的未软删人格，防跨用户/已删人格补完）----
  const rows: any[] = await db
    .select()
    .from(personas)
    .where(and(eq(personas.userId, String(userId)), isNull(personas.deletedAt)))
    .limit(500);
  const self = rows.find((r: { id: number }) => r.id === personaId);
  const target = rows.find((r: { id: number }) => r.id === aboutPersonaId);
  if (!self || !target) {
    return { jobId, generated: 0, verified: 0, rejected: 0, written: 0, error: "人格不存在或已删除" };
  }

  // ---- 建/更新任务 ----
  try {
    if (!jobId) {
      jobId = await insertReturningId(canonBackfillJobs, {
        personaId,
        aboutPersonaId,
        status: "running",
        model: cfg.model ?? null,
        promptVersion: PROMPT_VERSION,
        itemCount: 0,
      });
    } else {
      await db.update(canonBackfillJobs).set({
        status: "running",
        model: cfg.model ?? null,
        promptVersion: PROMPT_VERSION,
        error: null,
        warning: null,
        stats: null,
        webSearched: 0,
        finishedAt: null,
      }).where(eq(canonBackfillJobs.id, jobId));
    }
  } catch (e) {
    return {
      jobId,
      generated: 0,
      verified: 0,
      rejected: 0,
      written: 0,
      error: "建任务失败：" + (e instanceof Error ? e.message : String(e)),
    };
  }
  deadlineAt = Date.now() + JOB_DEADLINE_MS;

  const log: string[] = [];
  const checkDeadline = (label: string): void => {
    if (Date.now() > deadlineAt) {
      throw new Error("补完任务超过 25 分钟上限（阶段：" + label + "），已中止（旧数据保留）");
    }
  };

  try {
    // ============================================================
    // 读已有记录（增量基础 + 核查交叉对照）
    // ★ force 不再提前软删！先读出来做语境，等生成+核查成功后才软删。
    // ============================================================
    checkDeadline("读取已有记录");
    const existingRows: any[] = await db
      .select()
      .from(personaCanonLog)
      .where(
        and(
          eq(personaCanonLog.personaId, personaId),
          eq(personaCanonLog.aboutPersonaId, aboutPersonaId),
          eq(personaCanonLog.superseded, 0),
        ),
      )
      .orderBy(personaCanonLog.seq);

    // ---- 构造单视角提示 ----
    let prof: Record<string, unknown> = {};
    try { prof = typeof self.profile === "string" ? JSON.parse(self.profile) : (self.profile as never); } catch { prof = {}; }
    const aboutText = extractAbout((prof as Record<string, unknown>).relationships, target.name);
    const originSource = String((self as Record<string, unknown>).originSource ?? (prof as Record<string, unknown>).originSource ?? "").trim();

    // ★ 人格卡的字段名是 summary/persona/experiences/relationships/values/innerWorld...
    //   （不是 background/personality——之前传错名导致 AI 收到空字段，一条都生成不出来）
    const pf = prof as Record<string, unknown>;
    const str = (k: string, max: number) => String(pf[k] ?? "").slice(0, max);

    // ===== 阶段 1a：用存档 API 的**原生搜索能力**检索材料 =====
    const workName = cleanWorkName(originSource);
    checkDeadline("联网准备");
    // ★ 按存档里选的 API 决定联网方式
    const web = await prepareWebContext(
      cfg,
      self.name + " " + target.name,
      workName,
    ).catch(() => ({ mode: "none" as const, useBuiltin: false, evidence: "", note: "联网准备失败" }));
    const materials = web.evidence ? web.evidence.split("\n").filter((x) => x.trim()) : [];
    const apiSearched = web.mode !== "none" && materials.length > 0;
    log.push("阶段1a：" + web.note + " · " + materials.length + " 段材料");

    // ===== 阶段 1b：基于检索材料穷举「事件清单」=====
    const enumUser = [
      "【身份锚定】",
      "视角人物：「" + self.name + "」",
      originSource ? "出处：" + originSource : "出处：未标注",
      "关系对象：「" + target.name + "」",
      "",
      "【你的人格底色（你就是这个人，用你的眼睛看这些事）】",
      "人格摘要：" + (str("summary", 400) || "（无）"),
      "自我叙述：" + (str("persona", 700) || "（无）"),
      "内心世界：" + (str("innerWorld", 400) || "（无）"),
      "你说话的调子：" + (str("quotes", 300) || "（无）"),
      "",
      "【人格卡里的相关描述（仅作交叉参考）】",
      aboutText ? aboutText.slice(0, 400) : "（无）",
      "",
      materials.length > 0 ? "【检索到的原作资料（据此穷举，不要编造资料里没有的）】" : "【没有检索到资料，请基于你的知识穷举，并标注置信度】",
      ...materials.slice(0, 18),
      "",
      "请据此穷举这两个人之间**所有让关系发生转折的事件**，按时间顺序，输出精简 JSON。",
      "每条的 event 必须是「我」当时的记忆与认知，不是百科摘要；source 只做事实出处核对。",
    ].filter(Boolean).join("\n");

    checkDeadline("事件清单穷举");
    // 模型自带联网（Kimi/Anthropic）才让它自己搜；否则用已拿到的材料
    const enumRes = await withTimeout(
      callWithWebSearch(cfg, ENUM_SYSTEM, enumUser, { web: allowWeb && web.useBuiltin }),
      ENUM_TIMEOUT_MS,
      "事件清单穷举",
    );
    // ★ 截断检测：半截 JSON 不能当「没检索到」静默空跑（P0-8）
    if (enumRes.truncated) {
      stats.truncated = true;
      return await fail(
        "事件清单输出被截断（finish_reason=" + (enumRes.finishReason ?? "length") + "），本次不落库（旧数据保留）",
      );
    }
    // ★ 联网状态由 API 实证。DeepSeek 的 Responses 端点没有 web_search，
    //   webSearched 会是 false —— 此时必须如实告知，不能假装检索过。
    // ★ 联网状态 = 「API 搜索真的拿到了材料」或「模型自带联网真的执行了」
    const webSearched = enumRes.webSearched === true || apiSearched;
    stats.webSearched = webSearched;
    webWarning = webSearched
      ? undefined
      : "所选 API 未能联网检索（模型无内置联网，且 Search API 未返回材料）。本次事件来自模型内部知识，可能不完整；建议检查 API Key 或改用 Kimi k3。";
    let enumerated = parseEnumerated(enumRes.text);
    log.push("阶段1：穷举到 " + enumerated.length + " 条事件" + (webSearched ? "（已联网）" : "（未联网）"));

    // ★ 用户实锤：走马灯/冥界再会、官方衍生情节在首轮穷举里容易漏。
    //   首轮缺“死后/官方衍生”时，再跑一次只补漏的枚举，并去重合并。
    if (webSearched && enumerated.length > 0 && needsCoverageSupplement(enumerated)) {
      try {
        const fillUser = [
          ...enumUser.split("\n"),
          "",
          "【上一轮已经列出的事件（不要重复）】",
          ...enumerated.map((e, i) => (i + 1) + ". " + e.era + " — " + e.event + (e.source ? "（" + e.source + "）" : "")),
          "",
          "请只输出遗漏的事件；重点检查：死亡/遗言/最后一面、走马灯/冥界/死后世界/灵魂重逢、",
          "官方续作/外传/剧场版/官方游戏/设定集/公式书/作者访谈、以及一方死后另一方得知/再会的事件。",
          "没有遗漏就输出 {\"events\":[]}；event 仍必须是「我」的第一人称记忆。",
        ].join("\n");
        const fillRes = await withTimeout(
          callWithWebSearch(cfg, ENUM_FILL_SYSTEM, fillUser, { web: allowWeb && web.useBuiltin }),
          ENUM_TIMEOUT_MS,
          "补漏枚举",
        );
        if (!fillRes.truncated) {
          const extra = parseEnumerated(fillRes.text);
          if (extra.length > 0) {
            const before = enumerated.length;
            enumerated = mergeEnumerated(enumerated, extra);
            log.push("阶段1补漏：追加 " + (enumerated.length - before) + " 条（疑似漏掉的死后/官方衍生事件）");
          } else {
            log.push("阶段1补漏：无新增");
          }
        } else {
          log.push("阶段1补漏：输出截断，跳过补漏（不阻塞主流程）");
        }
      } catch {
        log.push("阶段1补漏：调用失败，跳过补漏（不阻塞主流程）");
      }
    }

    // ===== 阶段 2：基于清单写第一人称感受（不联网，纯生成）=====
    if (enumerated.length > 0) {
      const feelUser = [
        "【你是】" + self.name + "，出自 " + (originSource || "未知作品") + "。",
        "【口吻参考】" + (str("persona", 300) || "（无）"),
        "【你说话的调子】" + (str("quotes", 300) || "（无）"),
        "【你心里最深的东西】" + (str("innerWorld", 300) || "（无）"),
        "",
        "【事件清单（已经核实；如果句子仍像百科，不要附和它的客观口吻，用你的记忆重新感受它）】",
        ...enumerated.map((e: EnumeratedEvent, i: number) =>
          (i + 1) + ". " + e.era +
          (e.age != null ? " · " + e.age + "岁" : "") +
          (e.place ? " · " + e.place : "") +
          " — " + e.event +
          (e.source ? "（" + e.source + "）" : "")
        ),
        "",
        "请为上述每条事件写你的感受与影响，按 idx 对应，输出 JSON。",
      ].join("\n");

      checkDeadline("感受生成");
      const feelRes = await withTimeout(
        callWithWebSearch(cfg, FEEL_SYSTEM, feelUser, { web: false }),
        FEEL_TIMEOUT_MS,
        "感受生成",
      );
      if (feelRes.truncated) {
        stats.truncated = true;
        return await fail(
          "感受输出被截断（finish_reason=" + (feelRes.finishReason ?? "length") + "），本次不落库（旧数据保留）",
        );
      }
      const feelings = parseFeelings(feelRes.text);
      candidates = enumerated.map((e: EnumeratedEvent, i: number) => ({
        seq: i + 1,
        era: e.era,
        age: e.age != null && Number.isFinite(Number(e.age)) ? Number(e.age) : null,
        place: e.place ?? null,
        event: e.event,
        feeling: feelings.get(i + 1)?.feeling ?? "（感受待补）",
        impact: feelings.get(i + 1)?.impact ?? null,
        certainty: "stated",
        basis: undefined,
        source: e.source,
        eraBasis: e.eraBasis,
      }));
      log.push("阶段2：为 " + feelings.size + " 条生成了感受");
    }
    // ★ 用户实锤：event/feeling 仍有第三人称客观叙述。入库前统一做第一人称修复，
    //   修不好就拒收，绝不把旁白写进关系事件。
    const repaired = await repairThirdPersonItems(candidates, cfg, self.name, target.name, log);
    candidates = repaired.items;
    stats.rejected += repaired.rejected;
    if (candidates.length === 0) {
      return await fail("候选事件全部无法转为第一人称叙述，已保留旧数据（未软删/未写入）", {
        generated: repaired.items.length + repaired.rejected,
        rejected: stats.rejected,
      });
    }
    stats.generated = candidates.length;

    /** 同视角已入库的记忆 —— 作为核查时的交叉对照，防止「要素都对但组合错」 */
    const contextEvents = existingRows.map(
      (r: { era: string; age: number | null; place: string | null; eventText: string }) =>
        r.era +
        (r.age != null ? " · " + r.age + "岁" : "") +
        (r.place ? " · " + r.place : "") +
        " —— " + r.eventText,
    );

    /** 核查一条候选；通过则返回采纳修正后的最终内容 */
    const verifyOne = async (item: BackfillItem) => {
      checkDeadline("事实核查");
      // ★ P0-8：枚举 item 的 basis 恒 undefined → L0 免核查路径不可达。
      //   这里在「事件文本与人格卡相关描述高度重合」时补 basis（>=50% 词命中），
      //   让 L0 真正可达；其余仍走完整核查。
      const l0Basis =
        item.basis && aboutText && cardSupportsEvent(item.basis, aboutText)
          ? item.basis
          : aboutText && item.event && cardSupportsEvent(item.event, aboutText)
            ? item.event
            : undefined;
      const v = await verifyCanonEvent({
        work: originSource || "",
        character: self.name,
        event: item.event,
        era: item.era,
        age: item.age,
        place: item.place,
        eraBasis: item.eraBasis,
        contextEvents,
        cfg,
        basis: l0Basis,
        cardText: aboutText,
        claimedSource: item.source,
      });
      if (!v.passed) return null;
      const fixedEvent = v.correctedEvent && v.correctedEvent.trim() ? v.correctedEvent.trim() : item.event;
      const fixedEra = v.correctedEra && v.correctedEra.trim() ? cleanEra(v.correctedEra) : item.era;
      const fixedAge =
        v.correctedAge != null && Number.isFinite(Number(v.correctedAge)) ? Number(v.correctedAge) : item.age;
      // ★ P0-8：区分「模型没给 correctedPlace」（undefined → 保留原值）
      //   与「模型明确说无法确定」（"" → 清空，不再退回错误原值）
      const fixedPlace: string | null =
        v.correctedPlace !== undefined ? cleanPlace(v.correctedPlace) : (item.place ?? null);
      const fixedEraBasis = v.correctedEraBasis && v.correctedEraBasis.trim() ? v.correctedEraBasis.trim() : item.eraBasis;
      return {
        item: { ...item, event: fixedEvent, era: fixedEra, age: fixedAge, place: fixedPlace, eraBasis: fixedEraBasis },
        v,
      };
    };

    /** 插入一条已核查记忆（返回新行 id：force 清理时用于只保留本次新行） */
    const insertVerified = async (
      item: BackfillItem,
      v: { sources: unknown[]; verification: string; fixable?: boolean },
      seq: number,
    ): Promise<number> => {
      const id = await insertReturningId(personaCanonLog, {
        personaId,
        aboutPersonaId,
        seq,
        era: item.era,
        age: item.age,
        place: item.place,
        eraBasis: item.eraBasis ?? null,
        eventText: item.event,
        feeling: item.feeling,
        impact: item.impact,
        certainty: item.certainty,
        sourceRef: originSource || null,
        sourceCount: v.sources.length,
        sourcesJson: JSON.stringify(v.sources),
        verification: v.fixable ? "cross-checked" : v.verification,
        origin: "ai",
      });
      return Number(id);
    };

    const nextSeq = (): number =>
      existingRows.reduce((m: number, r: { seq: number }) => Math.max(m, r.seq), 0) + stats.written + stats.corrected + 1;

    // ============================================================
    // 执行分支
    //   A) force            —— 先枚举/核查成功，再软删旧 AI 行并写入
    //   B) 增量（已有记录）  —— diff 计划；计划失败 → 真全量新增 fallback
    //   C) 首次全量
    // ============================================================
    const initialActiveCount = existingRows.length;

    if (force) {
      // ---- A1. 生成失败不丢旧数据：候选为空直接失败（旧行一条不动）----
      if (candidates.length === 0) {
        return await fail("未生成任何候选事件（输出为空/不可解析），已保留旧数据（未软删）", {
          generated: 0,
        });
      }
      // ---- A2. 先完成全部核查（失败也不删旧行）----
      const verifiedItems: { item: BackfillItem; v: any }[] = [];
      for (const item of candidates) {
        checkDeadline("force 核查");
        const vv = await verifyOne(item);
        if (!vv) {
          stats.rejected++;
          log.push("拒收：" + item.event.slice(0, 30));
          continue;
        }
        verifiedItems.push(vv);
      }
      if (verifiedItems.length === 0) {
        return await fail("候选事件全部未通过事实核查，已保留旧数据（未软删）", {
          generated: candidates.length,
          rejected: stats.rejected,
        });
      }
      // ---- A3. 先写新行（写失败时旧行仍在，不丢数据）----
      const insertedAiIds: number[] = [];
      let seq = 0;
      for (const { item, v } of verifiedItems) {
        checkDeadline("force 写入");
        seq++;
        insertedAiIds.push(await insertVerified(item, v, seq));
        stats.written++;
      }
      // ---- A4. 新数据落库成功后才软删旧 AI 行（manual 永不删）----
      // ★ 不再只删「开始时读到的旧行」：并发/历史重复行也要清掉，
      //   否则会出现同一条关系事件重复 2–3 份（用户实锤）。
      //   保留：本次新写入的 id + 所有 manual 行；其余 active AI 行全部 soft delete。
      const keepIds = new Set<number>(insertedAiIds);
      const activeAiRows: any[] = await db
        .select({ id: personaCanonLog.id, origin: personaCanonLog.origin })
        .from(personaCanonLog)
        .where(
          and(
            eq(personaCanonLog.personaId, personaId),
            eq(personaCanonLog.aboutPersonaId, aboutPersonaId),
            eq(personaCanonLog.superseded, 0),
            ne(personaCanonLog.origin, "manual"),
          ),
        );
      for (const row of activeAiRows) {
        const id = Number(row.id);
        if (keepIds.has(id)) continue;
        await db.update(personaCanonLog).set({ superseded: 1 }).where(eq(personaCanonLog.id, id));
        stats.forceRemoved++;
      }
      if (stats.forceRemoved > 0) log.push("force：软删旧 AI 记忆 " + stats.forceRemoved + " 条（manual 保留）");
      stats.verified = stats.written;
    } else if (initialActiveCount > 0) {
      // ===== B. 增量：先计划，再只执行增/改 =====
      log.push("增量模式：已有 " + initialActiveCount + " 条，候选 " + candidates.length + " 条");
      const diffTrace: { finishReason: string | null } = { finishReason: null };
      let ops: Awaited<ReturnType<typeof planIncrementalDiff>> = null;
      try {
        ops = await withTimeout(
          planIncrementalDiff(
            {
              existing: existingRows.map((r: any) => ({
                id: r.id,
                era: r.era,
                age: r.age ?? null,
                place: r.place ?? null,
                eventText: r.eventText,
                feeling: r.feeling,
                origin: r.origin,
              })),
              candidates: candidates.map((c) => ({
                era: c.era,
                age: c.age ?? undefined,
                place: c.place ?? undefined,
                event: c.event,
                feeling: c.feeling,
                impact: c.impact ?? null,
                source: c.source,
                eraBasis: c.eraBasis,
              })),
              cfg,
              work: originSource || "",
              character: self.name,
            },
            { trace: diffTrace },
          ),
          DIFF_TIMEOUT_MS,
          "增量计划",
        );
      } catch (e) {
        log.push("增量计划失败：" + (e instanceof Error ? e.message : String(e)) + "（回退全量新增）");
        ops = null;
      }
      if (diffTrace.finishReason === "length" || diffTrace.finishReason === "max_tokens") {
        log.push("增量计划输出被截断，回退全量新增");
        ops = null;
      }
      if (!ops || ops.length === 0) {
        // ===== B-fallback：真正执行全量新增（按归一化事件文本去重）=====
        stats.fallbackUsed = true;
        log.push("增量计划失败/为空，回退为全量新增候选");
        const existingTexts = new Set(existingRows.map((r: any) => normalizeMemoryText(r.eventText)));
        for (const c of candidates) {
          checkDeadline("fallback 新增");
          if (existingTexts.has(normalizeMemoryText(c.event))) {
            stats.kept++;
            continue;
          }
          const vv = await verifyOne(c);
          if (!vv) {
            stats.rejected++;
            continue;
          }
          await insertVerified(vv.item, vv.v, nextSeq());
          existingTexts.add(normalizeMemoryText(c.event));
          stats.written++;
          stats.verified++;
        }
      } else {
        // ===== B-ops：按计划执行（keep/correct/add/drop/remove）=====
        const seenCorrectIds = new Set<number>();
        for (const op of ops) {
          checkDeadline("增量执行");
          if (op.op === "keep") { stats.kept++; continue; }

          // ★ remove：删除已有记录。用户录入绝不删；且必须先过独立二次核查。
          if (op.op === "remove") {
            if (!op.existingId) continue;
            const row = existingRows.find((x: any) => x.id === op.existingId);
            // ★ P0-8：existingId 必须属于当前 pair（越权/幻觉 id 直接忽略）
            if (!row) {
              log.push("忽略 remove #" + op.existingId + "：id 不属于当前 pair");
              stats.kept++;
              continue;
            }
            // 用户亲手录入/编辑过 → 永久保护
            if (row.origin === "manual") {
              log.push("拒绝删除用户录入 #" + op.existingId);
              stats.kept++;
              continue;
            }
            // 理由必须是 not-exist 或 unrelated
            const reason = String(op.reason ?? "").toLowerCase();
            const isNotExist = /not-exist|不存在|没有这|编造|同人/.test(reason);
            const isUnrelated = /unrelated|无关|不涉及|不构成/.test(reason);
            if (!isNotExist && !isUnrelated) {
              log.push("拒绝删除 #" + op.existingId + "：理由不合规（" + (op.reason ?? "空") + "）");
              stats.kept++;
              continue;
            }
            // ★ 二次核查（P0-8）：diff 理由不可单独采信
            let removal: Awaited<ReturnType<typeof verifyRemoval>>;
            try {
              removal = await withTimeout(
                verifyRemoval({
                  work: originSource || "",
                  character: self.name,
                  target: target.name,
                  event: { era: row.era, eventText: row.eventText, feeling: row.feeling },
                  diffReason: op.reason,
                  contextEvents,
                  cardText: aboutText,
                  cfg,
                }),
                REMOVAL_TIMEOUT_MS,
                "删除二次核查",
              );
            } catch (e) {
              removal = {
                confirmed: false,
                category: "keep",
                confidence: "low",
                reason: "删除二次核查失败：" + (e instanceof Error ? e.message : String(e)),
              };
            }
            if (!removal.confirmed) {
              // 未确认 → 保留，计入待人工确认（绝不静默删）
              stats.kept++;
              stats.pendingRemovals++;
              log.push("保留 #" + op.existingId + "（二次核查未确认）：" + removal.reason.slice(0, 60));
              continue;
            }
            await db
              .update(personaCanonLog)
              .set({ superseded: 1 })
              .where(eq(personaCanonLog.id, row.id));
            stats.removed++;
            log.push(
              "移除 #" + row.id + "（" + removal.category + "，二次核查确认）：" +
                removal.reason.slice(0, 60),
            );
            continue;
          }

          if (op.op === "drop" || !op.item) continue;
          const bi: BackfillItem = {
            seq: 0,
            era: cleanEra(op.item.era),
            age: op.item.age != null && Number.isFinite(Number(op.item.age)) ? Number(op.item.age) : null,
            place: cleanPlace(op.item.place ?? null) ?? "未明确地点",
            event: op.item.event,
            feeling: op.item.feeling,
            impact: op.item.impact ?? null,
            certainty: "stated",
            source: op.item.source,
            eraBasis: op.item.eraBasis,
          };
          const vv = await verifyOne(bi);
          if (!vv) { stats.rejected++; continue; }

          if (op.op === "correct") {
            // ★ P0-8：existingId 必须属于当前 pair
            const row = op.existingId ? existingRows.find((x: any) => x.id === op.existingId) : undefined;
            if (!row) {
              log.push("忽略 correct：existingId " + (op.existingId ?? "空") + " 不属于当前 pair");
              continue;
            }
            if (seenCorrectIds.has(row.id)) continue;
            seenCorrectIds.add(row.id);
            // ★ 用户录入/编辑过的记录：AI 不得改写（manual 保护）
            if (row.origin === "manual") {
              log.push("拒绝更正用户录入 #" + row.id);
              stats.kept++;
              continue;
            }
            // ★ 写回时**不写 origin**：保留原 origin（manual 不得被洗成 ai）
            await db
              .update(personaCanonLog)
              .set({
                era: vv.item.era,
                age: vv.item.age,
                place: vv.item.place,
                eraBasis: vv.item.eraBasis ?? null,
                eventText: vv.item.event,
                feeling: vv.item.feeling,
                impact: vv.item.impact,
                certainty: vv.item.certainty,
                sourceRef: originSource || null,
                sourceCount: (vv.v as { sources: unknown[] }).sources.length,
                sourcesJson: JSON.stringify((vv.v as { sources: unknown[] }).sources),
                verification: (vv.v as { fixable?: boolean }).fixable ? "cross-checked" : (vv.v as { verification: string }).verification,
              })
              .where(eq(personaCanonLog.id, row.id));
            stats.corrected++;
            stats.verified++;
            log.push("更正 #" + row.id + "：" + (op.reason ?? "").slice(0, 40));
          } else {
            await insertVerified(vv.item, vv.v, nextSeq());
            stats.written++;
            stats.verified++;
          }
        }
      }
    } else {
      // ===== C. 首次全量 =====
      for (const item of candidates) {
        checkDeadline("全量新增");
        const vv = await verifyOne(item);
        if (!vv) {
          stats.rejected++;
          log.push("拒收：" + item.event.slice(0, 30));
          continue;
        }
        await insertVerified(vv.item, vv.v, item.seq);
        stats.written++;
        stats.verified++;
      }
    }

    // ============================================================
    // 顺序考证（两段）
    //   ① 时间字符串排序 —— 年/月/日/季节
    //   ② 因果顺序校验   —— 同精度时间的事件按剧情因果排
    // ============================================================
    const reseq: any[] = await db
      .select()
      .from(personaCanonLog)
      .where(
        and(
          eq(personaCanonLog.personaId, personaId),
          eq(personaCanonLog.aboutPersonaId, aboutPersonaId),
          eq(personaCanonLog.superseded, 0),
        ),
      );

    // ① 时间排序
    let inOrder = [...reseq].sort((a: any, b: any) => eraSortKey(a.era).localeCompare(eraSortKey(b.era)));

    // ② 因果校验（>=3 条才值得跑；超时/截断不影响已写入数据，只跳过排序优化）
    if (inOrder.length >= 3 && Date.now() < deadlineAt) {
      try {
        const orderTrace: { finishReason: string | null } = { finishReason: null };
        const plan = await withTimeout(
          verifyEventOrder(
            {
              cfg,
              work: originSource || "",
              character: self.name,
              events: inOrder.map((r: any) => ({
                id: r.id,
                era: r.era,
                event: r.eventText,
              })),
            },
            { trace: orderTrace },
          ),
          ORDER_TIMEOUT_MS,
          "顺序考证",
        );
        if (orderTrace.finishReason === "length" || orderTrace.finishReason === "max_tokens") {
          log.push("顺序考证输出被截断，保留时间排序");
        } else if (plan && plan.order.length >= 2) {
          const byId = new Map(inOrder.map((r: any) => [r.id, r]));
          const reordered: any[] = [];
          for (const id of plan.order) {
            const hit = byId.get(id);
            if (hit) {
              reordered.push(hit);
              byId.delete(id);
            }
          }
          // 未出现在 order 里的补到末尾（AI 漏列时不丢数据）
          for (const r of byId.values()) reordered.push(r);
          if (reordered.length === inOrder.length) {
            inOrder = reordered;
            if (plan.notes) log.push("因果校验：" + plan.notes.slice(0, 80));
          }
        }
      } catch (e) {
        log.push("因果校验失败，保留时间排序：" + (e instanceof Error ? e.message.slice(0, 60) : ""));
      }
    } else if (inOrder.length >= 3) {
      log.push("因果校验因 25 分钟上限跳过，保留时间排序");
    }

    let reseqCount = 0;
    for (let i = 0; i < inOrder.length; i++) {
      if (inOrder[i].seq !== i + 1) {
        await db.update(personaCanonLog).set({ seq: i + 1 }).where(eq(personaCanonLog.id, inOrder[i].id));
        reseqCount++;
      }
    }
    stats.reseqCount = reseqCount;
    if (reseqCount > 0) log.push("顺序校正：重排 " + reseqCount + " 条 seq");

    // ---- 收尾：stats/warning/itemCount（= 当前 active 总数）一次写回 ----
    const activeTotal = inOrder.length;
    stats.verified = stats.written + stats.corrected;
    const finalStats: BackfillStats & { log?: string[] } = { ...stats, log };
    await db.update(canonBackfillJobs).set({
      status: "done",
      itemCount: activeTotal,
      model: cfg.model ?? null,
      promptVersion: PROMPT_VERSION,
      error: null,
      stats: JSON.stringify(finalStats),
      webSearched: webSearched ? 1 : 0,
      warning: webWarning ?? null,
      finishedAt: new Date(),
    }).where(eq(canonBackfillJobs.id, jobId));

    return {
      jobId,
      webSearched,
      webWarning,
      generated: candidates.length,
      verified: stats.written + stats.corrected,
      rejected: stats.rejected,
      written: stats.written,
      corrected: stats.corrected,
      kept: stats.kept,
      removed: stats.removed,
      pendingRemovals: stats.pendingRemovals,
      forceRemoved: stats.forceRemoved,
      fallbackUsed: stats.fallbackUsed,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return await fail(msg);
  }
}
