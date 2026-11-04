// ============================================================
// 现实层事件的事实核查（多方确认）
//
// ★ 2026-10 实测结论（决定了本文件的架构）：
//   · 本机维基百科 / DuckDuckGo 不可达（10s 超时），百度百科 403
//   · Bing 可用但对中文长查询分词退化（搜「三笠 人贩子」返回「三」字字典）
//   · 模型原生联网可用：DeepSeek web_search 20s 给出「漫画第6话」级依据
//
// 故核查分三级：
//   L0 人格卡依据  —— 卡片原文直接支撑 → 免联网，直接采信
//   L1 模型联网   —— 让模型自己检索并给出原作出处（章节/话数）
//   L2 本地 Bing  —— 仅作辅助材料塞进 prompt，不作独立判据
// ============================================================
import { callWithWebSearch } from "./caster";
import { prepareWebContext, cleanWorkName } from "./websearch";
import type { AiTestInput } from "../../contracts/game";

export type Verification =
  | "confirmed"
  | "cross-checked"
  | "single-source"
  | "unverified"
  | "contradicted"
  | "manual";

export interface VerifiedSource {
  title: string;
  url: string;
  tier: string;
  quote?: string;
  reason: string;
}

export interface EventVerdict {
  passed: boolean;
  verification: Verification;
  sources: VerifiedSource[];
  reason: string;
  /** 逐要素核对结果（who/what/where/when/result）*/
  elements?: Record<string, ElementCheck>;
  /** 与原作不符之处（有则必定不通过）*/
  discrepancies?: string[];
  /** 若整体成立但细节有误，这里是修正后的事件描述 */
  correctedEvent?: string;
  /** 修正后的年份 */
  correctedEra?: string;
  /** 修正后的年龄 */
  correctedAge?: number | null;
  /** 修正后的地点（空串 = 无法确定，应留空不显示）*/
  correctedPlace?: string;
  /** 修正后的时间依据 */
  correctedEraBasis?: string;
  /**
   * 可修正性。
   *
   * ★ 三分类的核心：事件真实存在、但要素有误（人称/时间/地点/年龄）→ fixable=true，
   *   应当**修正后入库**，而不是丢弃。
   *   只有「事件不存在 / 同人二创 / AI 编造」才 fixable=false 丢弃。
   */
  fixable?: boolean;
}

const SYSTEM_LINES = [
  "你是「人格研究站」的事实核查员。你的任务是：核实这条记忆是否成立，并在可修正时给出修正。",
  "",
  "【第一步：可采信来源 —— 按可信度】",
  "  1. 原作正传（漫画 / 小说 / 动画 / 游戏正传）",
  "  2. 官方设定集、公式书、作者访谈、作者后记",
  "  3. 官方授权或官方认可的衍生作品（官方手游、官方主机游戏、官方外传、官方舞台剧）",
  "  4. 作者后续补充的情节设定（续作、番外、官方问答）",
  "  以上四类都算依据。举例：灰原雄的术式「蒸汽咒法」原作漫画未出现，",
  "  但在官方认可的《咒术回战》游戏剧情中有 —— 属第 3 类，应当采信。",
  "  【不可采信】同人、二创、AU、私设、粉丝分析、非官方改编。",
  "",
  "【第二步：判定结果 —— 必须是三分类之一】",
  "  ① 完全正确",
  "     supported=true，fixable=false，discrepancies=[]，elements 全部 ok",
  "",
  "  ② 可修正（fixable=true）—— 事件本身真实存在，只是要素有误：",
  "     · 人称错（写成第三人称「五条悟与夏油杰…」，应为「我和杰…」）",
  "     · 时间错（如写 2006 年，实际是 2005 年）",
  "     · 地点错（如把薨星宫的袭击写成了冲绳）、地点模糊（某地/资料未载）",
  "     · 年龄错",
  "     → supported=true，fixable=true，必须在 corrected* 里给出全部修正值",
  "     → 这类错误不影响事件真实性，修正后应当入库，不许丢弃",
  "",
  "  ③ 不可采信（fixable=false）—— 事件根本不存在：",
  "     · 原作没有这件事 / 属同人二创 / AI 编造 / 与已知事实矛盾到无法修正",
  "     → supported=false，丢弃",
  "",
  "  【重要】人称错误、地点错误一律归入 ② 可修正，绝不能因为人称或地点判事件不存在。",
  "",
  "【第三步：组合一致性 —— 最容易出错，优先检查】",
  "  逐要素都对，不代表组合起来对。必须单独检查要素之间的搭配：",
  "  典型错误：「在冲绳与伏黑甚尔交战」——",
  "    冲绳(真实地点) + 伏黑甚尔(真实人物) + 交战(真实事件)，",
  "    但甚尔实际是在东京咒术高专（薨星宫）袭击的，冲绳只是护送理子去玩的地方。",
  "    → 这个组合是假的，必须判错。",
  "  检查方法：分别自问「这件事发生在 A 地吗？」「A 地发生过这件事吗？」",
  "  同样检查「谁做了这件事」「什么时间做的」是否与其它已知事实冲突。",
  "",
  "【第四步：逐要素核对】",
  "  1. who    —— 谁在场、谁做了什么？（有没有张冠李戴）",
  "  2. what   —— 具体做了什么、怎么做的？",
  "  3. where  —— 发生在哪？地名用标准译名（帕拉迪岛不是帕岛）",
  "  4. when   —— 时间/年龄对不对？（差一年也算错）",
  "  5. result —— 结果是什么？（谁活谁死、谁被阻止）",
  "",
  "【第五步：关系影响性检查 —— 必查】",
  "  这条事件是否**改变了主角与关系人的关系**？",
  "  改变可以是主动的（参与/目睹/得知），也可以是被动的（主角未必意识到）：",
  "  · 允许：世界性记忆删除、对方对主角做了某事而主角不知情、",
  "    诅咒/契约/心理操作改变了主角的态度",
  "  ——这些**都算关系事件**，一律保留。",
  "",
  "  【唯一该判为真正无关的情况】",
  "  事件既没有涉及主角，也没有改变主角对关系人的任何认知、情感或立场，",
  "  与这段关系**毫无因果关联**。",
  "",
  "  【写法核对】",
  "  · 主角能感知 → 应写成他的视角",
  "  · 主角不能感知 → 应写成「客观发生了什么 + 关系如何改变」，",
  "    允许出现「我不记得 / 我不知道 / 但那之后有什么不一样了」",
  "  · 若把「主角不可能知道的他人私密经历」直接写成主角的亲身记忆，",
  "    属于 ② 可修正，改写为「主角能感知到的部分」或「客观事实 + 关系变化」。",
  "【第六步：人称检查 —— 必查】",
  "  event 必须以「我」为叙述主体。允许合理语境出现自己的名字（别人称呼我、身份声明、转述）。",
  "  · 错误（整段第三人称客观摘要）：「五条悟与夏油杰在高专入学成为同期」「对五条而言…」",
  "  · 正确：「我和杰在高专入学时成了同期」「杰喊了我一声『悟』」「我是五条悟，最强」",
  "  · 违反时归入 ② 可修正，在 correctedEvent 里改写成第一人称。",
  "",
  "【时间考究】",
  "  · 优先原作明载；原作没明说但能由设定推定的，要核对推理链是否成立",
  "    （如「高专二年级 + 主线 2006 年 → 入学 2005 年」）",
  "  · era 保留最详细粒度（有月日写月日，跨多年写范围）",
  "",
  "【出处要求】必须给出具体出处：章节号/话数/集数/卷数/设定集页码/游戏章节名。",
  "  引不出出处时按可修正处理（fixable=true，给出修正），不要直接判不存在。",
  "",
  "只输出 JSON：",
  '{"supported":true|false,"fixable":true|false,"confidence":"high|medium|low",',
  ' "basis":"原作出处（如 漫画第6话 少女看见的世界 / 官方设定集 P.36）",',
  ' "detail":"原作里这件事到底怎么发生的（含谁做了什么、结果）",',
  ' "elements":{"who":{"ok":true,"note":""},"what":{"ok":true,"note":""},"where":{"ok":true,"note":""},"when":{"ok":true,"note":""},"result":{"ok":true,"note":""}},',
  ' "discrepancies":["与原作不符之处，逐条列出；没有则空数组"],',
  ' "correctedEvent":"修正后的事件描述（第一人称）；无修正则空字符串",',
  ' "correctedEra":"核对后的正确时间（如 2005年）；正确则原样返回",',
  ' "correctedAge":核对后的正确年龄（数字）；正确则原样返回,',
  ' "correctedPlace":"核对后的正确地点（单一具体）；无法确定则返回空字符串",',
  ' "correctedEraBasis":"若时间基于推断，给出正确推理链；原作明载则写「原作明载」",',
  ' "sourceUrl":"可核对的原作资料链接（若有）",',
  ' "reason":"判定理由"}',
];
const SYSTEM = SYSTEM_LINES.join("\n");

/**
 * 卡片依据检查：事件是否直接源自人格卡原文。
 * 人格卡是系统内既有的权威事实来源，不需要联网二次验证。
 */
export function cardSupportsEvent(basis: string, cardText: string): boolean {
  const words = (s: string) =>
    (s || "").replace(/[，。！？、；：（）【】《》\s·「」『』]/g, " ").split(" ").filter((w) => w.length >= 2);
  const basisWords = words(basis);
  if (basisWords.length === 0) return false;
  const card = String(cardText || "");
  if (!card.trim()) return false;
  const hit = basisWords.filter((w) => card.includes(w)).length;
  return hit / basisWords.length >= 0.5;
}

export interface ElementCheck { ok: boolean; note: string }

function parseVerdict(text: string): {
  supported: boolean;
  confidence: "high" | "medium" | "low";
  basis: string;
  detail: string;
  sourceUrl: string;
  reason: string;
  elements: Record<string, ElementCheck>;
  discrepancies: string[];
  correctedEvent: string;
  correctedEra: string;
  correctedAge: number | null;
  /** undefined = 模型没给这个字段；"" = 模型明确说「无法确定」（两者语义不同） */
  correctedPlace: string | undefined;
  correctedEraBasis: string;
  fixable: boolean;
} | null {
  const cleaned = String(text || "").replace(/```(?:json)?/gi, "");
  const s = cleaned.indexOf("{");
  const e = cleaned.lastIndexOf("}");
  if (s < 0 || e <= s) return null;
  try {
    const o = JSON.parse(cleaned.slice(s, e + 1)) as Record<string, unknown>;
    const conf = String(o.confidence ?? "low");
    // 逐要素结果
    const elements: Record<string, ElementCheck> = {};
    const rawEl = o.elements as Record<string, unknown> | undefined;
    if (rawEl && typeof rawEl === "object") {
      for (const [k, v] of Object.entries(rawEl)) {
        const e = v as Record<string, unknown>;
        elements[k] = { ok: e?.ok === true, note: String(e?.note ?? "") };
      }
    }
    const discrepancies = Array.isArray(o.discrepancies)
      ? (o.discrepancies as unknown[]).map((x) => String(x)).filter(Boolean)
      : [];
    return {
      supported: o.supported === true,
      confidence: conf === "high" ? "high" : conf === "medium" ? "medium" : "low",
      basis: String(o.basis ?? ""),
      detail: String(o.detail ?? ""),
      sourceUrl: String(o.sourceUrl ?? ""),
      reason: String(o.reason ?? ""),
      elements,
      discrepancies,
      correctedEvent: String(o.correctedEvent ?? ""),
      correctedEra: String(o.correctedEra ?? ""),
      correctedAge: typeof o.correctedAge === "number" ? o.correctedAge : Number.isFinite(Number(o.correctedAge)) && o.correctedAge != null && String(o.correctedAge) !== "" ? Number(o.correctedAge) : null,
      correctedPlace: o.correctedPlace == null ? undefined : String(o.correctedPlace),
      correctedEraBasis: String(o.correctedEraBasis ?? ""),
      fixable: o.fixable === true,
    };
  } catch {
    return null;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label + " 超时（" + Math.round(ms / 1000) + "s）")), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/** 模型联网核查单次上限（Kimi k3 实测 108s，DeepSeek 20s）*/
const VERIFY_TIMEOUT_MS = 200_000;

export async function verifyCanonEvent(input: {
  work: string;
  character: string;
  event: string;
  /** 声称的时间（必须核对）*/
  era?: string;
  /** 声称的年龄（必须核对）*/
  age?: number | null;
  /** 声称的地点（必须核对：要具体、精确、不拼接、不模糊）*/
  place?: string | null;
  /** 时间依据（原作明载 / 推定链）——核查时判断推定是否合理 */
  eraBasis?: string;
  /** 同一视角下**已确认正确**的其他事件，用作交叉对照 */
  contextEvents?: string[];
  cfg: AiTestInput;
  basis?: string;
  /** 生成阶段声称的原作出处（如「漫画第6话」）*/
  claimedSource?: string;
  cardText?: string;
}): Promise<EventVerdict> {
  const { work, character, event, cfg, basis, cardText, claimedSource, era, age, place, eraBasis, contextEvents } = input;

  // ===== L0：人格卡直接支撑 → 免联网 =====
  if (basis && cardText && cardSupportsEvent(basis, cardText)) {
    return {
      passed: true,
      verification: "confirmed",
      sources: [{ title: "人格卡原文", url: "card://persona", tier: "B", quote: basis, reason: "人格卡明确记载" }],
      reason: "人格卡直接支撑：" + basis.slice(0, 80),
    };
  }

  // ===== L2（辅助材料）：按 provider 决定联网方式 =====
  const workName = cleanWorkName(work || "");
  let local: string[] = [];
  let useBuiltin = false;
  try {
    const wc = await withTimeout(
      prepareWebContext(cfg, character, workName || event.slice(0, 40)),
      40_000,
      "联网准备",
    );
    useBuiltin = wc.useBuiltin;
    local = wc.evidence ? wc.evidence.split("\n").filter((x) => x.trim()).slice(0, 12) : [];
  } catch {
    local = [];
  }

  // ===== L1：模型联网核查 =====
  const ctx = Array.isArray(contextEvents) ? contextEvents.filter(Boolean) : [];
  const lines: string[] = [
    "作品：「" + (workName || work || "未知") + "」",
    "人物：「" + character + "」",
    ctx.length > 0 ? "【同视角已确认的其他记忆 —— 用于交叉对照】" : "",
    ...ctx.slice(0, 14).map((x, i) => "  " + (i + 1) + ". " + x),
    ctx.length > 0 ? "注意：待核实事件若与上述任何一条矛盾（同一时间/地点/人物却是另一起事件），判为不符。" : "",
    "",
    "待核实事件：「" + event + "」",
    era ? "声称时间：「" + era + "」——请核对年份是否准确" : "",
    age != null ? "声称年龄：「" + age + "岁」——请按作品时间线核对" : "",
    place ? "声称地点：「" + place + "」——请核对是否具体、准确、单一（不许模糊或拼接）" : "",
    eraBasis ? "时间依据：「" + eraBasis + "」——若为推定，请判断推理链是否成立（如「高专二年级 + 主线2006年 → 入学2005年」）；推理不成立则纠正" : "",
  ];
  if (basis) lines.push("该事件声称的人格卡依据：「" + basis + "」");
  if (claimedSource) lines.push("生成阶段声称的原作出处：「" + claimedSource + "」——请重点核实这个出处是否真实存在、是否确实对应此事。");
  if (local.length > 0) {
    lines.push("", "【服务端检索到的网页资料（来自 DeepSeek 搜索，含原作剧情描述）】", ...local);
  }
  lines.push("", "请联网检索原作，判断该事件是否确实发生，并按约定 JSON 输出。");
  const user = lines.join("\n");

  let r: { text: string; webSearched: boolean; offlineReason?: string } | null = null;
  try {
    // 模型自带联网（Kimi/Anthropic）才让它自己搜；否则基于已拿到的材料判断
    r = await withTimeout(
      callWithWebSearch(cfg, SYSTEM, user, { web: useBuiltin }),
      VERIFY_TIMEOUT_MS,
      "事实核查",
    );
  } catch (e) {
    return {
      passed: false,
      verification: "unverified",
      sources: [],
      reason: "核查调用失败：" + (e instanceof Error ? e.message : String(e)).slice(0, 120),
    };
  }

  const verdict = r ? parseVerdict(r.text) : null;
  if (!verdict) {
    return {
      passed: false,
      verification: "unverified",
      sources: [],
      reason: "核查模型未产出可解析判断",
    };
  }

  const sources: VerifiedSource[] = [];
  if (verdict.basis) {
    sources.push({
      title: verdict.basis.slice(0, 80),
      url: verdict.sourceUrl || "web://model-search",
      tier: "C",
      quote: verdict.detail.slice(0, 200),
      reason: "模型联网检索给出的原作出处",
    });
  }

  const elements = verdict.elements;
  const discrepancies = verdict.discrepancies;

  // ============================================================
  // ★ 判定顺序（关键）：先判「可修正」，再判「不可采信」
  //
  //   历史 bug：discrepancies 门禁排在 fixable 判断之前，导致
  //   「人称错」「年龄错」这类可修正错误把整条事件拒掉 —— 修正永远轮不到。
  // ============================================================

  /** 判断某条 discrepancy 是否属于「可修正」类型（要素有误但事件为真）*/
  const isFixableKind = (d: string): boolean => {
    // 明确表示事件不存在的 → 不可修正
    if (/不存在|没有这|并非事实|同人|二创|编造|虚构|无法成立|纯属/.test(d)) return false;
    // 人称 / 年龄 / 时间 / 地点 类 → 可修正
    return /人称|第一人称|第三人称|主角本名|自己的名字|年龄|岁|年份|时间|日期|地点|地名|模糊|未载|拼接|译名|应该写|应为/.test(d);
  };

  const allFixable = discrepancies.length > 0 && discrepancies.every(isFixableKind);
  const hasFixContent = Boolean(
    (verdict.correctedEvent && verdict.correctedEvent.trim()) ||
      (verdict.correctedPlace && verdict.correctedPlace.trim()) ||
      (verdict.correctedEra && verdict.correctedEra.trim()) ||
      (verdict.correctedAge != null && Number.isFinite(Number(verdict.correctedAge))) ||
      (verdict.correctedEraBasis && verdict.correctedEraBasis.trim()),
  );

  // ① 可修正：模型标了 fixable，或所有 discrepancy 都属于可修正类型，且有修正内容
  if ((verdict.fixable || allFixable) && hasFixContent && verdict.supported !== false) {
    return {
      passed: true,
      verification: "cross-checked",
      sources,
      elements,
      discrepancies: [],
      correctedEvent: verdict.correctedEvent || undefined,
      correctedEra: verdict.correctedEra || undefined,
      correctedAge: verdict.correctedAge,
      correctedPlace: verdict.correctedPlace,
      correctedEraBasis: verdict.correctedEraBasis || undefined,
      fixable: true,
      reason: "已修正：" + (discrepancies.join("；") || verdict.reason || "").slice(0, 200),
    };
  }

  // ② 不可修正的不符 → 拒绝
  if (discrepancies.length > 0) {
    return {
      passed: false,
      verification: "contradicted",
      sources,
      elements,
      discrepancies,
      correctedEvent: verdict.correctedEvent || undefined,
      correctedEra: verdict.correctedEra || undefined,
      correctedAge: verdict.correctedAge,
      correctedPlace: verdict.correctedPlace,
      reason: "要素不符：" + discrepancies.join("；").slice(0, 240),
    };
  }

  // 关键要素未确认也拒绝
  const failedEls = Object.entries(elements).filter(([, v]) => !v.ok).map(([k]) => k);
  if (failedEls.length > 0) {
    return {
      passed: false,
      verification: "unverified",
      sources,
      elements,
      discrepancies: failedEls.map((k) => k + " 未获原作支持"),
      correctedEvent: verdict.correctedEvent || undefined,
      correctedEra: verdict.correctedEra || undefined,
      correctedAge: verdict.correctedAge,
      correctedPlace: verdict.correctedPlace,
      reason: "要素未确认：" + failedEls.join("、"),
    };
  }

  if (!verdict.supported) {
    return {
      passed: false, verification: "unverified", sources, elements, discrepancies,
      correctedEvent: verdict.correctedEvent || undefined,
      reason: verdict.reason || "模型判定无原作依据",
    };
  }

  if (verdict.basis && (verdict.confidence === "high" || verdict.confidence === "medium")) {
    return {
      passed: true,
      verification: verdict.confidence === "high" ? "confirmed" : "cross-checked",
      sources,
      elements,
      discrepancies: [],
      correctedEvent: verdict.correctedEvent || undefined,
      correctedEra: verdict.correctedEra || undefined,
      correctedAge: verdict.correctedAge,
      correctedPlace: verdict.correctedPlace,
      reason: (verdict.detail || verdict.reason || "").slice(0, 160),
    };
  }

  return {
    passed: false,
    verification: "single-source",
    sources,
    reason: "模型认为可信但未给出具体原作出处（未达入库门槛）",
  };
}

// ============================================================
// 删除二次核查（2026-10-22 审计 P0-8）
//
// remove 是现实层最高风险操作：diff 模型的「事件不存在 / 与关系无关」理由不可单独采信
// （幻觉/误判会永久软删已核实记忆）。这里独立跑一次核查，作为第二道闸门：
//   · 只有「明确确认应当删除」且置信度非 low 才 confirmed=true；
//   · 调用失败 / 解析失败 / 拿不准 → 一律 false（保守保留，宁可留一条不完美记忆）。
// ============================================================
const REMOVAL_SYSTEM_LINES = [
  "你是「人格研究站」的记忆删除复核员（第二道闸门）。",
  "上游整理员提出要删除一条**已核实入库**的关系记忆。你的任务：独立复核是否真的应当删除。",
  "",
  "【只有两种情况允许删除】",
  "  a) not-exist —— 该事件在原作中根本不存在（AI 编造、同人、二创、与设定矛盾到无法修正）",
  "  b) unrelated —— 该事件对「视角人物对关系对象的认知 / 情感 / 立场」**没有任何影响**",
  "",
  "【必须保留（不得删除）】",
  "  · 记忆只是表述不同 / 不够精确 / 可以写得更好 —— 这类应更正，不是删除",
  "  · 关系人不在场、但视角人物因此改变了对 TA 的看法（得知/目睹/被动受影响都算）",
  "  · 你拿不准的 —— 一律保留",
  "",
  "【删除尺度】宁可保留一条不完美的真实记忆，也不要删掉一条可能真实存在的关系事件。",
  "",
  "只输出 JSON：",
  '{"remove":true|false,"category":"not-exist|unrelated|keep","confidence":"high|medium|low",',
  ' "reason":"复核依据（如原作出处/为什么无关）"}',
];
const REMOVAL_SYSTEM = REMOVAL_SYSTEM_LINES.join("\n");

/** 删除复核单次上限（含联网准备）*/
const REMOVAL_TIMEOUT_MS = 150_000;

export interface RemovalVerdict {
  /** 是否确认应当删除（保守：失败/低置信度一律 false）*/
  confirmed: boolean;
  /** not-exist | unrelated | keep */
  category: "not-exist" | "unrelated" | "keep";
  confidence: "high" | "medium" | "low";
  reason: string;
}

function parseRemoval(text: string): {
  remove: boolean;
  category: "not-exist" | "unrelated" | "keep";
  confidence: "high" | "medium" | "low";
  reason: string;
} | null {
  const cleaned = String(text || "").replace(/```(?:json)?/gi, "");
  const a = cleaned.indexOf("{");
  const b = cleaned.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try {
    const o = JSON.parse(cleaned.slice(a, b + 1)) as Record<string, unknown>;
    const rawCat = String(o.category ?? "").toLowerCase();
    const category: "not-exist" | "unrelated" | "keep" =
      rawCat.includes("not-exist") || rawCat.includes("not_exist")
        ? "not-exist"
        : rawCat.includes("unrelated")
          ? "unrelated"
          : "keep";
    const conf = String(o.confidence ?? "low");
    const confidence: "high" | "medium" | "low" =
      conf === "high" ? "high" : conf === "medium" ? "medium" : "low";
    return {
      remove: o.remove === true,
      category,
      confidence,
      reason: String(o.reason ?? ""),
    };
  } catch {
    return null;
  }
}

/**
 * remove 分支的二次核查（独立于 diff 计划）。
 * 返回 confirmed=false 时调用方必须保留原记录（计入 stats.pendingRemovals）。
 */
export async function verifyRemoval(input: {
  work: string;
  character: string;
  /** 关系对象名（帮助判断是否与这段关系相关）*/
  target?: string;
  /** 待删记忆 */
  event: { era?: string; eventText: string; feeling?: string | null };
  /** 上游 diff 给出的删除理由（仅作参考，不采信为结论）*/
  diffReason?: string;
  /** 同一视角下已入库的其他记忆（交叉对照，防误删）*/
  contextEvents?: string[];
  /** 人格卡里关于关系对象的描述（若有，帮助判断相关性）*/
  cardText?: string;
  cfg: AiTestInput;
}): Promise<RemovalVerdict> {
  const { work, character, target, event, diffReason, contextEvents, cardText, cfg } = input;
  const keep = (reason: string): RemovalVerdict => ({
    confirmed: false,
    category: "keep",
    confidence: "low",
    reason,
  });

  // L2 辅助材料（可选，失败不阻断复核）
  const workName = cleanWorkName(work || "");
  let local: string[] = [];
  let useBuiltin = false;
  try {
    const wc = await withTimeout(
      prepareWebContext(cfg, character, workName || event.eventText.slice(0, 40)),
      40_000,
      "删除复核联网准备",
    );
    useBuiltin = wc.useBuiltin;
    local = wc.evidence ? wc.evidence.split("\n").filter((x) => x.trim()).slice(0, 8) : [];
  } catch {
    local = [];
  }

  const ctx = Array.isArray(contextEvents) ? contextEvents.filter(Boolean) : [];
  const lines: string[] = [
    "作品：「" + (workName || work || "未知") + "」",
    "视角人物：「" + character + "」",
    target ? "关系对象：「" + target + "」" : "",
    "",
    ctx.length > 0 ? "【同视角已入库的其他记忆（用于判断这条是否与关系无关）】" : "",
    ...ctx.slice(0, 12).map((x, i) => "  " + (i + 1) + ". " + x),
    "",
    "【待复核删除的记忆】",
    (event.era ? "时间：" + event.era + "；" : "") + "事件：" + event.eventText,
    event.feeling ? "第一人称感受：" + event.feeling.slice(0, 300) : "",
    cardText ? "人格卡里关于关系对象的描述：" + cardText.slice(0, 400) : "",
    "",
    "【上游整理员提出的删除理由（仅供参考，不能直接采信）】",
    diffReason ? diffReason.slice(0, 300) : "（未给出）",
    local.length > 0 ? "" : "",
    ...(local.length > 0 ? ["【服务端检索到的网页资料】", ...local] : []),
    "",
    "请独立判断：这条记忆是否真的应当删除？按约定 JSON 输出。",
  ].filter(Boolean);
  const user = lines.join("\n");

  try {
    const r = await withTimeout(
      callWithWebSearch(cfg, REMOVAL_SYSTEM, user, { web: useBuiltin }),
      REMOVAL_TIMEOUT_MS,
      "删除复核",
    );
    if (r.truncated) return keep("删除复核输出被截断，保守保留");
    const v = parseRemoval(r.text);
    if (!v) return keep("删除复核未产出可解析结论，保守保留");
    if (!v.remove) {
      return {
        confirmed: false,
        category: "keep",
        confidence: v.confidence,
        reason: "复核认为不应删除：" + (v.reason || "未给出理由").slice(0, 200),
      };
    }
    if (v.category === "keep") {
      return { confirmed: false, category: "keep", confidence: v.confidence, reason: "复核未给出合规删除类别，保守保留" };
    }
    if (v.confidence === "low") {
      return { confirmed: false, category: "keep", confidence: "low", reason: "复核置信度低，保守保留：" + v.reason.slice(0, 160) };
    }
    return {
      confirmed: true,
      category: v.category,
      confidence: v.confidence,
      reason: v.reason.slice(0, 240),
    };
  } catch (e) {
    return keep("删除复核调用失败，保守保留：" + (e instanceof Error ? e.message : String(e)).slice(0, 120));
  }
}
