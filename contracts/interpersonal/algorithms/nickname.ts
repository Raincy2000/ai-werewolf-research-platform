// 昵称库与称呼语用（§17 / §20 / §21，纯函数、零 I/O）
// 审计修复（P0-11）：
//   - chooseAddress 先做**硬过滤**（公开场合禁用 publicUse=false；protectOther 禁蔑称），过滤后为空返回 null
//   - familiarityScore 与 familiarEnough 口径统一：threshold 用法必须同时满足 §17.3 亲密度组合条件
//   - threshold 缺省值改用 NICKNAME_LAYER_DEFAULTS 分层回落，不再硬编码 60
import type {
  Nickname, NicknameLayer, RelationStrength, AddressContext,
} from "../types";
import { NICKNAME_LAYER_RANK, NICKNAME_LAYER_DEFAULTS } from "../vocab";
import {
  NICKNAME_THRESHOLD_DEFAULT,
  FAMILIARITY_CLOSENESS_MIN, FAMILIARITY_AFFECT_MIN, FAMILIARITY_TRUST_MIN,
} from "../constants";

/** 0..100 clamp（污染输入按 0 处理，避免负值/超界污染口径） */
function pct(v: number | undefined | null): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, v));
}

/** 亲密度合成（§17.3）：closeness 直通，或 positivity 与 trust 的较小值 */
export function familiarityScore(rel?: RelationStrength | null): number {
  if (!rel) return 0;
  const byCloseness = pct(rel.closeness);
  const byAffect = Math.min(pct(rel.positivity), pct(rel.trust));
  return Math.max(byCloseness, byAffect);
}

/** 亲密度是否达标（§17.3 唯一口径）：closeness ≥ 60 或 (positivity ≥ 70 且 trust ≥ 60) */
export function familiarEnough(rel?: RelationStrength | null): boolean {
  if (!rel) return false;
  if (pct(rel.closeness) >= FAMILIARITY_CLOSENESS_MIN) return true;
  return pct(rel.positivity) >= FAMILIARITY_AFFECT_MIN && pct(rel.trust) >= FAMILIARITY_TRUST_MIN;
}

/**
 * 昵称的实际门槛（§17.2）：显式 threshold > 分层默认 NICKNAME_LAYER_DEFAULTS > 全局默认。
 * 显式阈值 clamp 到 0..100；threshold=0 表示不设亲密度门槛。
 */
export function familiarityThreshold(n: Nickname): number {
  if (typeof n.threshold === "number" && Number.isFinite(n.threshold)) {
    return Math.max(0, Math.min(100, Math.round(n.threshold)));
  }
  const layerDefault = NICKNAME_LAYER_DEFAULTS[n.layer]?.threshold;
  if (typeof layerDefault === "number" && Number.isFinite(layerDefault)) return layerDefault;
  return NICKNAME_THRESHOLD_DEFAULT;
}

/** 该昵称对观察者**是否可见**（含共有人，Petronio CPM） */
export function isNicknameAware(n: Nickname, viewerId: number, ownerId: number): boolean {
  if (viewerId === ownerId) return true;
  switch (n.awareness) {
    case "all": return true;
    case "private":
      return (n.allowedIds ?? []).includes(viewerId) || (n.coOwners ?? []).includes(viewerId);
    case "self":
      return (n.coOwners ?? []).includes(viewerId);
    default: return false;
  }
}

/**
 * 该昵称观察者**能否使用**（三因子，§17.3）。
 * usage=threshold 时：先过 §17.3 亲密度组合条件（familiarEnough），再看数值门槛 familiarityScore ≥ threshold。
 * 两条口径在此统一（P0-11 探针：closeness=positivity=trust=61 + threshold=60 时不可用）。
 */
export function canUseNickname(
  n: Nickname,
  viewerId: number,
  ownerId: number,
  rel?: RelationStrength | null,
  opts?: { allowReckless?: boolean },
): boolean {
  if (viewerId === ownerId) return true;
  if (!isNicknameAware(n, viewerId, ownerId)) return false;
  switch (n.usage) {
    case "all": return true;
    case "threshold": {
      const threshold = familiarityThreshold(n);
      if (threshold <= 0) return true; // 显式不设门槛
      if (familiarEnough(rel) && familiarityScore(rel) >= threshold) return true;
      return opts?.allowReckless === true;
    }
    case "specific":
      if ((n.allowedIds ?? []).includes(viewerId)) return true;
      return opts?.allowReckless === true;
    case "self": return false;
    default: return false;
  }
}

/** 权限层：观察者当前**有资格使用**的全部昵称（不只最高层） */
export function eligibleNicknames(
  nicknames: Nickname[],
  viewerId: number,
  ownerId: number,
  rel?: RelationStrength | null,
): Nickname[] {
  return nicknames.filter((n) => canUseNickname(n, viewerId, ownerId, rel));
}

/** 越界倾向（§17.4）：由特质推导 0..1 */
export function boundaryRecklessness(traits: {
  narcissism?: number; machiavellianism?: number; agreeableness?: number;
}): number {
  const narc = (traits.narcissism ?? 50) / 100;
  const mach = (traits.machiavellianism ?? 50) / 100;
  const agree = (traits.agreeableness ?? 50) / 100;
  return Math.max(0, Math.min(1, 0.5 * narc + 0.4 * mach + 0.3 * (1 - agree)));
}

/** 披露广度（§20.3 社会渗透理论 breadth 维） */
export function nicknameBreadth(nicknames: Nickname[]): Record<NicknameLayer, number> {
  const out: Record<NicknameLayer, number> = { public: 0, intimate: 0, private: 0, secret: 0 };
  for (const n of nicknames) out[n.layer]++;
  return out;
}

/** 称呼不对称（§20.6，Brown & Gilman）：A 称 B 与 B 称 A 的层级差 */
export function addressAsymmetry(aToB?: Nickname | null, bToA?: Nickname | null): number {
  const ra = aToB ? NICKNAME_LAYER_RANK[aToB.layer] : 0;
  const rb = bToA ? NICKNAME_LAYER_RANK[bToA.layer] : 0;
  return ra - rb;
}

/**
 * 硬性禁止（§21 语用铁律，P0-11）：
 * ① 公开/正式场合不得使用 publicUse=false 的称呼（面子工作，Brown & Levinson 1987）
 * ② 需要保护对方面子（protectOther）时不得使用蔑称（derogatory）
 * 硬禁止是"不进入候选"，不是扣分——候选只剩被禁称呼时必须返回 null。
 */
export function isAddressCandidateAllowed(n: Nickname, ctx: Pick<AddressContext, "setting" | "faceNeed">): boolean {
  if (ctx.setting === "public" && n.publicUse === false) return false;
  if (ctx.faceNeed === "protectOther" && n.tone === "derogatory") return false;
  return true;
}

/**
 * 称呼选择（§21.4 四输入模型）。
 * ⚠️ **不是取最高亲密层** —— 生气/严肃时会主动降级（§21.5）。
 * 先硬过滤，再按语用得分选择；过滤后为空返回 null。
 */
export function chooseAddress(ctx: AddressContext): Nickname | null {
  const candidates = ctx.eligible.filter((n) => isAddressCandidateAllowed(n, ctx));
  if (candidates.length === 0) return null;
  let best: Nickname | null = null;
  let bestScore = -Infinity;
  for (const n of candidates) {
    const s = scoreAddressCandidate(n, ctx);
    if (s > bestScore) { bestScore = s; best = n; }
  }
  return best;
}

/** 单个候选的语用得分（可单测；硬禁止已由 chooseAddress 先过滤，这里仍保留惩罚作防御） */
export function scoreAddressCandidate(n: Nickname, ctx: AddressContext): number {
  const rank = NICKNAME_LAYER_RANK[n.layer];
  const intent = ctx.intent ?? "neutral";
  let s = 0;
  if (intent === "affiliate") s += rank * 2;
  if (intent === "distance") s -= rank * 2;
  if (intent === "warn") s -= rank * 3;
  if (ctx.setting === "formal") { s += n.tone === "honorific" ? 6 : 0; s -= rank; }
  if (ctx.setting === "private") s += rank;
  if (ctx.setting === "public") {
    if (n.publicUse === false) s -= 100;
    s -= rank * 0.5;
  }
  if (ctx.setting === "crisis") s -= rank * 1.5;
  const valence = ctx.emotion?.valence ?? 0;
  const arousal = ctx.emotion?.arousal ?? 0;
  if (valence < -0.3 && arousal > 0.6) s -= rank * 2;
  if (ctx.faceNeed === "protectOther" && n.tone === "derogatory") s -= 100;
  if (ctx.faceNeed === "protectSelf" && n.tone === "honorific") s += 2;
  return s;
}

/** 降低层级（revoke / 语境降级） */
export function stepDownLayer(layer: NicknameLayer): NicknameLayer {
  const order: NicknameLayer[] = ["public", "intimate", "private", "secret"];
  const i = order.indexOf(layer);
  return i <= 0 ? "public" : (order[i - 1] as NicknameLayer);
}

/** 是否属于「升层」（向更外层披露） */
export function isDisclosureUpgrade(from: NicknameLayer, to: NicknameLayer): boolean {
  return NICKNAME_LAYER_RANK[to] < NICKNAME_LAYER_RANK[from];
}
