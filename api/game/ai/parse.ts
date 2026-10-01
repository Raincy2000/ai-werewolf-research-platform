// ============================================================
// AI 决策解析：从模型文本中鲁棒提取 JSON 并裁剪为 DecisionInput
// - 去 markdown 围栏、截取首个 { 到末个 }
// - targets 过滤到 pending.options 合法范围（options 为空时按存活座位过滤）
// - 发言类必须非空 speech（缺失则用 thought 截取 150 字补上）
// - 彻底失败返回 null，由服务层用启发式合法动作兜底
// ============================================================

import type { DecisionInput, DecisionKind, PendingDecision } from "../engine/api";

const SPEECH_KINDS: ReadonlySet<DecisionKind> = new Set([
  "sheriffSpeech",
  "daySpeech",
  "pkSpeech",
  "lastWords",
]);

// 必须给出合法目标的决策（这些 kind 不允许 skip）
const NEED_TARGET_KINDS: ReadonlySet<DecisionKind> = new Set([
  "nightmareFear",
  "wolfKill",
  "gargoyleCheck",
  "dreamerDream",
  "seerCheck",
  "psychicCheck",
  "sheriffRun",
  "sheriffWithdraw",
  "sheriffVote",
  "dayVote",
  "whiteWolfTake",
]);

function asTrimmedString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

// ---------- 鲁棒修复（DeepSeek 等模型的常见失败形态） ----------
/**
 * 修复1：JSON 字符串值内的原始控制字符转义。
 * 线上实锤的高频形态：模型在 speech/thought 字符串里直接输出换行/制表符，
 * JSON.parse 对未转义控制字符严格报错 → 整次输出被判「无法解析」。
 */
function escapeRawControlChars(text: string): string {
  let out = "";
  let inStr = false;
  let esc = false;
  for (const ch of text) {
    if (esc) {
      out += ch;
      esc = false;
      continue;
    }
    if (inStr && ch === "\\") {
      out += ch;
      esc = true;
      continue;
    }
    if (ch === '"') {
      inStr = !inStr;
      out += ch;
      continue;
    }
    if (inStr && (ch === "\n" || ch === "\r" || ch === "\t")) {
      out += ch === "\n" ? "\\n" : ch === "\r" ? "\\r" : "\\t";
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * 修复2：截断 JSON 修补（输出被服务端长度上限截断，缺闭合引号/括号）。
 * 策略：先补闭合未闭合的字符串，再按栈补齐未闭合括号；
 * 仍失败则回退到最后一个完整键值边界（丢弃未完成尾项）再闭合。
 * 救回部分字段（thought/speech 完整即可用）远胜于整次判废。
 */
function repairTruncatedJson(raw: string): unknown {
  // 扫描结构状态
  let inStr = false;
  let esc = false;
  const stack: string[] = [];
  const commaPos: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (inStr && ch === "\\") {
      esc = true;
      continue;
    }
    if (ch === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") stack.pop();
    else if (ch === ",") commaPos.push(i);
  }
  const tryParse = (s: string): unknown => {
    try {
      const v = JSON.parse(s);
      return typeof v === "object" && v !== null ? v : undefined;
    } catch {
      return undefined;
    }
  };
  // 闭合未闭合字符串 + 补齐括号
  const base = inStr ? raw + '"' : raw;
  let out = tryParse(base + [...stack].reverse().join(""));
  if (out !== undefined) return out;
  // 回退到最后一个完整键值边界，丢弃未完成尾项后闭合
  for (let k = commaPos.length - 1; k >= 0; k--) {
    const cut = base.slice(0, commaPos[k]);
    const st: string[] = [];
    let s2 = false;
    let e2 = false;
    for (const ch of cut) {
      if (e2) {
        e2 = false;
        continue;
      }
      if (s2 && ch === "\\") {
        e2 = true;
        continue;
      }
      if (ch === '"') {
        s2 = !s2;
        continue;
      }
      if (s2) continue;
      if (ch === "{") st.push("}");
      else if (ch === "[") st.push("]");
      else if (ch === "}" || ch === "]") st.pop();
    }
    out = tryParse(cut + st.reverse().join(""));
    if (out !== undefined) return out;
  }
  return undefined;
}

/**
 * 终极打捞：JSON 修复链全部失败后的最后手段——
 * 用正则从原文提取第一个完整的 "thought"/"speech" 字符串值（容忍其后内容损坏）。
 * 返回 null 表示连一个完整字段都救不出。
 */
function salvageFields(text: string): DecisionInput | null {
  const grab = (key: string): string => {
    const m = text.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
    if (!m) return "";
    try {
      return JSON.parse(`"${m[1]}"`) as string;
    } catch {
      return m[1];
    }
  };
  const thought = grab("thought").trim();
  const speech = grab("speech").trim();
  if (!thought && !speech) return null;
  const decision: DecisionInput = { thought: (thought || speech).slice(0, 600) };
  if (speech) decision.speech = speech.slice(0, 300);
  return decision;
}

/** 解析 JSON 文本：原样 → 控制字符转义 → 截断修补，逐级降级 */
export function parseJsonRobust(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    /* 进入修复链 */
  }
  try {
    return JSON.parse(escapeRawControlChars(text));
  } catch {
    /* 继续降级 */
  }
  return repairTruncatedJson(escapeRawControlChars(text));
}

function toIntArray(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  return v.filter(
    (t): t is number => typeof t === "number" && Number.isInteger(t),
  );
}

export function parseDecision(rawText: string, pending: PendingDecision): DecisionInput | null {
  if (!rawText) return null;
  // 去 markdown 围栏后截取首个 { 到末个 }
  const cleaned = rawText.replace(/```(?:json)?/gi, "");
  const start = cleaned.indexOf("{");
  if (start < 0) return null;
  // 截取首个 { 到末个 }；若无闭合 }（输出被截断）则取到文本尾，交修复链补救
  const end = cleaned.lastIndexOf("}");
  const jsonText = cleaned.slice(start, end > start ? end + 1 : undefined);

  const obj = parseJsonRobust(jsonText);
  if (obj === undefined) {
    // 终极打捞：JSON 整体报废（如字符串内含未转义引号、思维链混入花括号）时，
    // 用正则直接提取完整的 thought/speech 字符串字段——救回可用内容远胜于整次托管
    const salvaged = salvageFields(cleaned);
    if (!salvaged) return null;
    return salvaged;
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;

  const thought = asTrimmedString(o.thought);
  const isSpeechKind = SPEECH_KINDS.has(pending.kind);

  // 发言类必须非空 speech：缺失则用 thought 截取 150 字补上；仍为空则不再用通用句顶替——
  // 留空让引擎校验抛错，服务层据此带原因重试 AI（治好「空发言被静默顶替、对局噪声」）
  let speech = asTrimmedString(o.speech);
  if (isSpeechKind && !speech) speech = thought.slice(0, 150).trim();

  // targets 过滤到合法范围（options 空数组表示任意存活者）
  const legal = pending.options.length > 0 ? pending.options : pending.view.aliveSeats;
  const targets = [...new Set(toIntArray(o.targets).filter((t) => legal.includes(t)))];
  // skip 仅在引擎允许放弃时生效，防止必选动作被非法跳过
  const skip = o.skip === true && pending.allowSkip;

  // 必需目标类：过滤后无合法目标且未明确 skip → 视为坏输出，交服务层兜底
  if (NEED_TARGET_KINDS.has(pending.kind) && targets.length === 0 && !skip) {
    return null;
  }

  const decision: DecisionInput = { thought: thought.slice(0, 600) };
  if (speech) decision.speech = speech.slice(0, 300);
  if (targets.length > 0) decision.targets = targets;
  if (skip) decision.skip = true;
  if (o.selfDestruct === true) decision.selfDestruct = true;
  if (o.surrender === true) decision.surrender = true;
  if (o.declareVictory === true) decision.declareVictory = true;
  if (typeof o.duel === "number" && Number.isInteger(o.duel)) {
    // 骑士决斗目标必须是存活玩家，非法则忽略该字段
    if (pending.view.aliveSeats.includes(o.duel)) decision.duel = o.duel;
  } else if (o.duel === null) {
    decision.duel = null;
  }
  if (o.witchSave === true) decision.witchSave = true;

  // ---------- 语义清洗：互斥字段（防止引擎校验抛错） ----------
  // 女巫同一晚只能用一瓶药：skip=什么都不做优先；用解药则不能再下毒；下毒则不能同时用解药
  if (pending.kind === "witchAction") {
    if (decision.skip === true) {
      delete decision.targets;
      delete decision.witchSave;
    } else if (decision.witchSave === true) {
      delete decision.targets;
    } else if (decision.targets && decision.targets.length > 0) {
      decision.witchSave = false;
    }
  }
  // selfDestruct 与 duel 互斥：优先自爆，清除决斗目标
  if (decision.selfDestruct === true && decision.duel != null) {
    delete decision.duel;
  }
  // 赛后讨论：非空 speech 发言优先（历史事故：skip 优先曾把 AI 的有效发言整段删掉→线上全员零发言）；
  // 仅无发言时 skip=本轮弃权（不消耗机会）
  if (pending.kind === "postgameSpeak" && decision.speech?.trim()) {
    delete decision.skip;
  } else if (pending.kind === "postgameSpeak" && decision.skip === true) {
    delete decision.speech;
  }
  return decision;
}
