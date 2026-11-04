// ============================================================
// 现实层增量补完：把「新生成的候选事件」与「已入库的记录」做 diff
//
// 用户定调：重新补完时，要
//   · 保留原有正确的
//   · 补上新的
//   · 更正错的
// 而不是推倒重来。
//
// 所以流程是：已有记录 + 新候选 → 计划(keep/correct/add/drop) → 只执行增改
// ============================================================
import { callWithWebSearch } from "./caster";
import type { AiTestInput } from "../../contracts/game";

/** 已入库的一条记忆（diff 时的左值）*/
export interface ExistingMemory {
  id: number;
  era: string;
  age: number | null;
  place: string | null;
  eventText: string;
  feeling: string;
  /** ai = AI 生成；manual = 用户手录或编辑过（**绝不可删**）*/
  origin?: string;
}

/** 新生成的候选（diff 时的右值）*/
export interface CandidateMemory {
  era: string;
  age?: number | string;
  place?: string;
  event: string;
  feeling: string;
  impact?: string | null;
  source?: string;
  eraBasis?: string;
}

export type DiffOpKind = "keep" | "correct" | "add" | "drop" | "remove";

/** 允许删除已有记录的理由 —— 只有这两种 */
export type RemoveReason = "not-exist" | "unrelated";

export interface DiffOp {
  op: DiffOpKind;
  /** keep / correct 指向的已有记录 id */
  existingId?: number;
  /** correct / add 的新内容 */
  item?: CandidateMemory;
  /** correct 的原因（原记录错在哪）*/
  reason?: string;
}

const SYSTEM_LINES = [
  "你是记忆整理员。任务：把「新检索到的事件」与「已入库的记忆」做对照，",
  "决定哪些保留、哪些更正、哪些新增。",
  "",
  "【五条规则】",
  "1. keep   —— 已有记录准确无误，**保留**（不要重复新增）",
  "2. correct —— 已有记录有误（时间/地点/年龄/人称/地点细节与原作不符），给出修正后的完整内容",
  "3. add    —— 新检索到的事件确实存在且未被收录，作为新记录加入",
  "4. drop   —— 新事件与已有重复，或无法核实，忽略（只作用于新候选）",
  "",
  "5. remove —— 删除一条已有记录。只有两种情况允许：",
  "   a) not-exist  —— 该事件在原作中根本不存在（AI 编造、同人、二创）",
  "   b) unrelated  —— 该事件对「本人格对关系人的关系认知」**没有任何影响**",
  "",
  "   【unrelated 的严格判定 —— 极重要】",
  "   要判断的不是「关系人有没有出现在这个事件里」，",
  "   而是「**这个事件有没有让本人格对关系人的看法/感受/关系发生变化**」。",
  "",
  "   ★ 反面例子（关系人不在场，但必须保留，不许 remove）：",
  "     · 夏油杰屠村叛逃 —— 五条是事后得知、不在场，但这是两人关系的转折点 → 保留",
  "     · 灰原雄牺牲 —— 让夏油动摇，也让五条日后悔恨「没察觉杰在往下掉」→ 保留",
  "     · 五条悟被封印 —— 夏油（遗体）虽不在场，但封印直接导致后续对峙 → 保留",
  "     · 任何「我因为这件事，对 TA 的看法变了」的事件 → 一律保留",
  "",
  "   ★ 真正可删的例子（与这条关系毫无关系）：",
  "     · 事件只涉及第三人，本人格对关系人的看法**丝毫未变** → 可删",
  "",
  "   必须给 reason 说明是 not-exist 还是 unrelated，并写清判断依据。",
  "",
  "   【绝对禁止 remove】：",
  "   · 已标注「用户录入」的记录 —— 用户亲手写的，永远不许删",
  "   · 仅仅因为「表述不同」「不够精确」「可以写得更好」就想删的 —— 这类应该 correct，不是 remove",
  "   · 拿不准的一律 keep",
  "",
  "【删除尺度】宁可保留一条不完美的记录，也不要删掉一条真实的记忆。",
  "",
  "【铁律】",
  "· **宁可 keep 也不乱改**：已有记录若与原作一致，必须 keep，不许为了「看起来不同」而更正",
  "· correct 必须说明原记录错在哪（reason），且修正后的内容要有原作依据",
  "· add 不许与已列入重复（同一件事换个说法也算重复）",
  "· 拿不准的一律 drop",
  "",
  "只输出 JSON：",
  '{"ops":[',
  '  {"op":"keep","existingId":1},',
  '  {"op":"correct","existingId":2,"reason":"原记录地点写成「帕岛」，原作是马莱雷贝利欧",',
  '   "item":{"era":"2005年","age":16,"place":"马莱·雷贝利欧","event":"...","feeling":"...","source":"漫画第123话"}},',
  '  {"op":"add","item":{"era":"2007年","age":18,"place":"某村","event":"...","feeling":"...","source":"..."}}',
  ']}',
];
const SYSTEM = SYSTEM_LINES.join("\n");

function parseDiffOps(text: string): DiffOp[] {
  const cleaned = String(text || "").replace(/```(?:json)?/gi, "");
  const a = cleaned.indexOf("{");
  const b = cleaned.lastIndexOf("}");
  if (a < 0 || b <= a) return [];
  try {
    const o = JSON.parse(cleaned.slice(a, b + 1)) as Record<string, unknown>;
    const arr = Array.isArray(o.ops) ? o.ops : [];
    const out: DiffOp[] = [];
    for (const raw of arr) {
      const r = raw as Record<string, unknown>;
      const op = String(r.op ?? "").toLowerCase();
      if (op !== "keep" && op !== "correct" && op !== "add" && op !== "drop" && op !== "remove") continue;
      const existingId = Number(r.existingId);
      const itemRaw = r.item as Record<string, unknown> | undefined;
      const item: CandidateMemory | undefined = itemRaw
        ? {
            era: String(itemRaw.era ?? "").trim() || "时期不明",
            age: itemRaw.age as number | string | undefined,
            place: itemRaw.place != null ? String(itemRaw.place) : undefined,
            event: String(itemRaw.event ?? "").trim(),
            feeling: String(itemRaw.feeling ?? "").trim(),
            impact: itemRaw.impact != null ? String(itemRaw.impact) : null,
            source: itemRaw.source != null ? String(itemRaw.source) : undefined,
            eraBasis: itemRaw.eraBasis != null ? String(itemRaw.eraBasis) : undefined,
          }
        : undefined;
      out.push({
        op,
        existingId: Number.isFinite(existingId) && existingId > 0 ? existingId : undefined,
        item,
        reason: r.reason != null ? String(r.reason).trim() : undefined,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * 生成增量计划。
 * 失败时返回 null（调用方回退到「全量新增」策略）。
 *
 * opts.signal：任务级取消（canon 补完 deadline / 上层中止）
 * opts.trace：带出底层 finish_reason（调用方据此检测输出截断）
 */
export async function planIncrementalDiff(
  input: {
    existing: ExistingMemory[];
    candidates: CandidateMemory[];
    cfg: AiTestInput;
    work: string;
    character: string;
  },
  opts?: { signal?: AbortSignal; trace?: { finishReason: string | null } },
): Promise<DiffOp[] | null> {
  const { existing, candidates, cfg, work, character } = input;
  if (existing.length === 0 || candidates.length === 0) return null;

  const user = [
    "【视角人物】" + character,
    work ? "【作品】" + work : "",
    "",
    "【已入库的记忆】",
    ...existing.map((e, i) =>
      (i + 1) +
      ". id=" + e.id +
      (e.origin === "manual" ? " 【用户录入 · 不可删】" : "") +
      " [" + e.era + (e.age != null ? " · " + e.age + "岁" : "") + (e.place ? " · " + e.place : "") + "] " +
      e.eventText,
    ),
    "",
    "【新检索到的事件】",
    ...candidates.map((c, i) =>
      (i + 1) + ". [" + c.era + (c.age != null ? " · " + c.age + "岁" : "") + (c.place ? " · " + c.place : "") + "] " + c.event,
    ),
    "",
    "请对照后输出操作清单（keep / correct / add / drop），按约定 JSON 输出。",
  ].filter(Boolean).join("\n");

  const r = await callWithWebSearch(cfg, SYSTEM, user, { web: false, signal: opts?.signal });
  if (opts?.trace) opts.trace.finishReason = r.finishReason ?? opts.trace.finishReason;
  return parseDiffOps(r.text);
}

export { parseDiffOps };


// ============================================================
// 顺序考证：同精度时间的事件，必须按「剧情因果」排，不能只看时间字符串
//
// 用户定调：考证算法要拉满。
// 典型错误：灰原雄牺牲(2007) / 夏油屠村(2007) / 新宿诀别(2007) 三者同年同精度，
// 纯字符串排序按生成顺序排，结果「屠村」排在「灰原之死」前面 —— 因果倒置。
// 正确顺序：灰原之死 → 夏油动摇 → 屠村 → 诀别。
// ============================================================

const ORDER_SYSTEM_LINES = [
  "你是作品剧情的时间线考证员。任务：判断给定事件的**剧情先后顺序**。",
  "",
  "【判断依据 —— 按优先级】",
  "1. 事件里明确给出的时间（年/月/日/季节）",
  "2. 剧情因果链：起因在前，结果在后",
  "   · 「灰原雄牺牲导致夏油动摇」→ 灰原之死必须在「屠村」之前",
  "   · 「理子之死导致五条觉醒后反杀」→ 理子之死在前",
  "   · 「失去同伴 → 理念崩坏 → 屠杀」→ 按此顺序",
  "3. 角色年龄、身份变化（学生 → 叛逃 → 被封印）",
  "4. 作品叙事顺序（章节先后）",
  "",
  "【原则】",
  "· 时间精度不同时，先按时间；同一精度（都只有年份）时，必须按因果排。",
  "· 只调整有明确依据的，拿不准的保持原相对顺序。",
  "· 输出必须是输入 id 的一个排列，不能增删。",
  "",
  "只输出 JSON：",
  '{"order":[3,1,5,2,4],"notes":"调整说明（简述哪个顺序被纠正、为什么）"}',
];
const ORDER_SYSTEM = ORDER_SYSTEM_LINES.join("\n");

/** 解析顺序考证结果 */
export function parseOrder(text: string): { order: number[]; notes: string } | null {
  const cleaned = String(text || "").replace(/```(?:json)?/gi, "");
  const a = cleaned.indexOf("{");
  const b = cleaned.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try {
    const o = JSON.parse(cleaned.slice(a, b + 1)) as Record<string, unknown>;
    const arr = Array.isArray(o.order) ? o.order : [];
    const order = arr.map((x) => Number(x)).filter((n) => Number.isFinite(n));
    if (order.length === 0) return null;
    return { order, notes: String(o.notes ?? "") };
  } catch {
    return null;
  }
}

/**
 * 考证事件顺序。
 * 返回按剧情先后排列的 id 数组；失败返回 null。
 */
export async function verifyEventOrder(
  input: {
    cfg: AiTestInput;
    work: string;
    character: string;
    events: Array<{ id: number; era: string; event: string }>;
  },
  opts?: { signal?: AbortSignal; trace?: { finishReason: string | null } },
): Promise<{ order: number[]; notes: string } | null> {
  const { cfg, work, character, events } = input;
  if (events.length < 2) return null;

  const user = [
    "【视角人物】" + character,
    work ? "【作品】" + work : "",
    "",
    "【待排事件】（id 供输出引用，不要改动 id）",
    ...events.map(
      (e) => "  id=" + e.id + "  [" + e.era + "]  " + e.event,
    ),
    "",
    "请判断这些事件的剧情先后，输出 order 数组（id 的排列）。",
  ].filter(Boolean).join("\n");

  const r = await callWithWebSearch(cfg, ORDER_SYSTEM, user, { web: false, signal: opts?.signal });
  if (opts?.trace) opts.trace.finishReason = r.finishReason ?? opts.trace.finishReason;
  return parseOrder(r.text);
}
