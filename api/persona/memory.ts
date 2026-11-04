// ============================================================
// 「记性」：记忆层 / 检索层 / 组装层（设计文档 §4.10）
// ------------------------------------------------------------
// 命名硬规则：
//   · 内部子系统叫「记性」；
//   · 机制名**一律不得进入 prompt**（禁止出现「自传体」「记忆库」「档案」等字眼）；
//   · prompt 里只给内容。
//
// 工程硬约束（§4.10.7）：
//   H1 可重放 —— 检索是纯函数；同 (items, affect, signature, k, now) 必得同一结果
//   H2 稳定排序 —— 同分按 id 升序
//   H4 无 embedding 依赖
//   H6 token 上限裁剪
// ============================================================

/** 机制版本：写入调制日志，保证跨版本可比较（D3） */
export const SELF_MECHANISM_VERSION = "self-1.0";

export interface MemoryItem {
  id: number;
  type: string; // trauma | triumph | relationship | general
  content: string;
  strength: number; // 0..100
  valence: number; // -100..100
  emotionalWeight: number; // 0..100
  situationSignature?: string | null;
  lifecycle?: string | null; // active | archived
}

/** 情绪状态（跨回合持久，见 §14.6） */
export interface AffectState {
  valence: number; // -1..1
  arousal: number; // 0..1
}

/** 检索参数 */
export interface RecallOptions {
  affect?: AffectState;
  /** 情境签名（编码特异性：Tulving & Thomson 1973）。缺失则退化为全局检索 */
  signature?: string | null;
  /** 情绪一致性权重（Bower 1981 情绪一致性记忆） */
  gammaValence?: number;
  /** 情境一致性权重（编码特异性 Tulving & Thomson 1973） */
  gammaSignature?: number;
  /** 强度权重 */
  k?: number;
  /** 字符上限（H6） */
  charCap?: number;
  /** 时间戳基准（回合序号或毫秒），用于时程衰减 */
  now?: number;
  /** 「当下最在意的事」，来自当前情境/参数，置于最前 */
  concerns?: string[];
}

const DEF = { gammaValence: 0.6, gammaSignature: 0.8, k: 5, charCap: 0, now: 0 };

/** 情绪一致性：效价越接近，越易被唤起 */
export function valenceMatch(memValence: number, affectValence: number): number {
  return 1 - Math.abs(memValence / 100 - affectValence) / 2;
}

/**
 * 情境一致性（编码特异性）：按 `:` 分段求匹配率 0..1。
 * 例：`game:wolf` vs `game:wolf` → 1.0；`game:wolf` vs `game:good` → 0.5；
 *     无签名（历史数据）→ 0（不奖不罚，靠其他维度排序）。
 */
export function situationMatch(memSig: string | null | undefined, wantSig: string | null | undefined): number {
  if (!memSig || !wantSig) return 0;
  const a = memSig.split(":");
  const b = wantSig.split(":");
  const n = Math.max(a.length, b.length);
  if (n === 0) return 0;
  let same = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] === b[i]) same++;
  return same / n;
}

/**
 * 单条记忆的检索得分（纯函数）。
 * score = strength × (1 + γ_val·情绪一致性) × (1 + γ_sig·情境一致性) × 生命期修正
 *
 * ⚠️ 情境是**加权**而非**硬过滤**：狼人杀里签名天然稀疏，
 * 硬过滤会把绝大部分记忆挡在门外（退化成"检索不到"）。
 */
export function scoreMemory(m: MemoryItem, opts: RecallOptions = {}): number {
  const o = { ...DEF, ...opts };
  const base = Math.max(0, Math.min(100, m.strength)) / 100;
  const vm = valenceMatch(m.valence, o.affect?.valence ?? 0);
  const sm = situationMatch(m.situationSignature, o.signature);
  const score = base * (1 + o.gammaValence * vm) * (1 + o.gammaSignature * sm);
  // 归档记忆不参与检索（§4.10.5，不物理删除）
  return m.lifecycle === "archived" ? 0 : score;
}

/**
 * 检索层（纯函数、无 I/O、无 embedding）。
 * · 候选：全部 active 记忆（情境一致性进 scoring，见 situationMatch）
 * · 排序：得分降序；**同分按 id 升序**（H2 稳定排序）
 */
export function recallMemories(items: MemoryItem[], opts: RecallOptions = {}): MemoryItem[] {
  const o = { ...DEF, ...opts };
  // 归档记忆永不参与；其余全部候选，由得分（含情境一致性）排序——不做硬过滤
  const active = items.filter((m) => m.lifecycle !== "archived");
  const scored = active.map((m) => ({ m, s: scoreMemory(m, o) }));
  scored.sort((a, b) => (b.s - a.s) || (a.m.id - b.m.id));
  return scored.slice(0, Math.max(0, o.k)).map((x) => x.m);
}

/**
 * 组装层：把检索结果组装成「当下自我」的一段话。
 * ⚠️ 严格约束 —— 只输出内容，**不得出现任何机制名**。
 */
export function composeRemembered(items: MemoryItem[], opts: RecallOptions = {}): string {
  const o = { ...DEF, ...opts };
  const concerns = (o.concerns ?? []).map((c) => c.trim()).filter(Boolean);
  const bodies = items
    .map((m) => m.content.trim().replace(/\s+/g, " "))
    .filter(Boolean);
  if (concerns.length === 0 && bodies.length === 0) return "";
  const lines: string[] = [];
  if (concerns.length > 0) {
    lines.push("（心里真正压着的事）", ...concerns.map((c) => `· ${c}`));
  }
  if (bodies.length > 0) {
    lines.push("（你还记得）", ...bodies.map((b) => `· ${b}`));
  }
  const text = lines.join("\n");
  return o.charCap > 0 ? text.slice(0, o.charCap) : text;
}

/** 机制名黑名单校验：prompt 素材中不得出现这些字眼（§4.10.2） */
export const FORBIDDEN_MECHANISM_WORDS = [
  "自传体",
  "记忆库",
  "档案库",
  "知识库",
  "记事簿",
  "数据库",
  "检索层",
  "组装层",
];

export function containsMechanismName(text: string): string | null {
  for (const w of FORBIDDEN_MECHANISM_WORDS) if (text.includes(w)) return w;
  return null;
}

/** 情境签名：由对局状态派生（编码特异性检索键）。必须稳定、可复现。 */
export function buildSituationSignature(input: {
  scenarioKind?: string;
  phase?: string;
  day?: number;
  role?: string;
  pressure?: "none" | "low" | "high";
}): string {
  const parts = [
    input.scenarioKind ?? "game",
    input.phase ?? "unknown",
    input.role ?? "unknown",
    input.pressure ?? "none",
  ];
  return parts.join(":");
}
