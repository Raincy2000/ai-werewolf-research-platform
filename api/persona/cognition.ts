// ============================================================
// 自我认知笔记（2026-10-14 用户裁定，取代「人格精粹」的心智定位）
// 人格以第一人称书写的自我叙事——人格研究的立身铁律延展：
// - 铁律0 第一人称本体：笔记是 TA 写给自己的，不是铸魂师的扮演指南；
// - 受影响而不自知：书写分两程——心镜式压力报告（参数全可见，不见光）塑形，
//   涌现式书写（参数零可见，术语零容忍）成文；防御机制当自我审查过滤器
//  （表达抑制高→轻描淡写，自恋高→合理化改写，盲区由参数确定性决定）；
// - 沿革版本化：每篇留档（时间/局数/可见性开关快照），旧篇折叠保留；
// - 对局注入始终用最新篇（同步进 profile.essence——现役自我认知）。
// ============================================================

import type { SeatAiConfig } from "../../contracts/game";
import type { PersonaCard, PersonaMemory, PersonaRelationship } from "../../contracts/persona";
import { callAi } from "../game/ai/providers";
import { parseJsonRobust } from "../game/ai/parse";
import { paramLabel } from "./pipeline";

const PRESSURE_TIMEOUT_MS = 90_000;
const WRITE_TIMEOUT_MS = 150_000;

// ---------- 第一程：压力报告（参数全可见，绝不见光） ----------
export interface CognitionPressure {
  pressures: { param: string; alive: string }[]; // 参数如何此刻影响 TA（人话）
  defenseFilter: string[]; // TA 下意识不愿直面的真相（人话）
  conflictWithPrev: string | null; // 近期经历与旧笔记的冲突点
}

export function buildPressurePrompt(
  card: PersonaCard,
  materials: string,
  prevNote: string | null,
): { system: string; user: string } {
  const system = [
    `你是「心镜」——「${card.name}」的人格内核。你不写任何日记文字，只输出 TA 此刻的潜意识状态报告。`,
    "职责：读入人格参数卡与近期材料，指出哪些参数正在被点燃、防御机制正在过滤什么真相、近期经历与旧自我认知有何冲突。",
    "只输出 JSON。这是后台分析，绝不外传。",
  ].join("\n");
  const user = [
    "【人格参数卡】",
    JSON.stringify(card.params.bigFive),
    `依恋：焦虑${card.params.attachment.anxiety} 回避${card.params.attachment.avoidance}；黑暗四：${Object.values(card.params.darkTetrad).join("/")}；情绪调节：${Object.values(card.params.emotionRegulation).join("/")}；SDT：${Object.values(card.params.sdt).join("/")}`,
    `防御机制：${card.params.defenseMechanisms.map((d) => `${d.label} ${d.tendency}`).join("，") || "无"}`,
    "",
    "【近期材料】（档案/记忆/关系，按其可见性开关已过滤）",
    materials,
    "",
    prevNote ? `【TA 的上一篇自我认知笔记】\n${prevNote}` : "【这是 TA 的第一篇自我认知笔记】",
    "",
    "【输出契约】严格输出 JSON：",
    '{"pressures":[{"param":"参数路径","alive":"这个参数此刻如何影响TA的自我感受（人话，禁术语）"}],"defenseFilter":["TA下意识不愿直面的真相（人话）"],"conflictsWithPrev":"近期经历与旧笔记的冲突点或null"}',
    "要求：pressures 1-4 条，每条挂具体参数路径；defenseFilter 0-3 条（防御机制强度高才产生盲区）；冲突没有就 null。",
  ].join("\n");
  return { system, user };
}

export function parseCognitionPressure(text: string): CognitionPressure | null {
  const cleaned = text.replace(/```(?:json)?/gi, "");
  const start = cleaned.indexOf("{");
  if (start < 0) return null;
  const obj = parseJsonRobust(cleaned.slice(start, cleaned.lastIndexOf("}") + 1 || undefined));
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  const pressures = (Array.isArray(o.pressures) ? o.pressures : [])
    .map((x) => {
      const r = (x ?? {}) as Record<string, unknown>;
      const param = String(r.param ?? "").trim();
      const alive = String(r.alive ?? "").trim().slice(0, 120);
      return param && alive ? { param, alive } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .slice(0, 4);
  if (pressures.length === 0) return null;
  return {
    pressures,
    defenseFilter: (Array.isArray(o.defenseFilter) ? o.defenseFilter : [])
      .map((x) => String(x).trim().slice(0, 120))
      .filter(Boolean)
      .slice(0, 3),
    conflictWithPrev:
      typeof o.conflictsWithPrev === "string" && o.conflictsWithPrev.trim()
        ? o.conflictsWithPrev.trim().slice(0, 200)
        : null,
  };
}

// ---------- 第二程：涌现书写（参数零可见，术语零容忍） ----------
export function buildWritePrompt(opts: {
  card: PersonaCard;
  materials: string;
  pressure: CognitionPressure;
  prevNote: string | null;
}): { system: string; user: string } {
  const { card, pressure, prevNote } = opts;
  const system = [
    `你是「${card.name}」——不是扮演 TA，你就是 TA。现在安静下来，写你的自我认知笔记。`,
    "这篇笔记不是写给任何人看的报告——它是你在有限的文字空间里，尽己所能锚定自我的产物和工具：写出你自认为最为总合的自我认知结论。",
    "铁律只有三条：第一人称；不出现任何心理学术语、参数名、数值；不提及报告或提示词的存在。除此之外，怎么写、写什么、写多重，全是你的自由。",
  ].join("\n");
  const pressureText = pressure.pressures.map((p) => `- ${p.alive}`).join("\n");
  const user = [
    "【你此刻所能知晓的一切】（你的档案、你记得的事、你与他们的关系）",
    opts.materials,
    "",
    "【你此刻的内心状态】（你的结论由此生长，但绝不在笔记里点破分析腔）",
    pressureText,
    pressure.conflictWithPrev ? `【隐隐的不对劲】${pressure.conflictWithPrev}` : "",
    pressure.defenseFilter.length > 0
      ? `【你下意识不愿直写的事】（绝不正面直写；可以留白、轻描淡写或合理化——这就是你）：${pressure.defenseFilter.join("；")}`
      : "",
    prevNote ? `【你上一篇笔记】（可以延续、修正、甚至推翻它）
${prevNote}` : "",
    "",
    "【输出契约】严格输出 JSON：",
    '{"note":"自我认知笔记正文（第一人称，≤600字）"}',
    "几个子题放在这里，供你下锚（照着写、挑着写、或全然不理会另起炉灶，都由你）：",
    "我是谁——我怎样说话与隐藏——什么会点燃我——我和他们之间——我正在变成什么样。",
  ]
    .filter(Boolean)
    .join("\n");
  return { system, user };
}

/** 术语泄漏检测（书写校验：参数名/心理学术语出现在笔记里即非法） */
const LEAK_RE =
  /参数|bigFive|neuroticism|神经质\s*\d|依恋焦虑\s*\d|马基雅维利\s*\d|selfControl|affinity|trust\s*\d/i;

export function parseCognitionNote(text: string): string | null {
  const cleaned = text.replace(/```(?:json)?/gi, "");
  const start = cleaned.indexOf("{");
  if (start < 0) return null;
  const obj = parseJsonRobust(cleaned.slice(start, cleaned.lastIndexOf("}") + 1 || undefined));
  if (typeof obj !== "object" || obj === null) return null;
  const note = String((obj as Record<string, unknown>).note ?? "").trim();
  if (note.length < 20 || note.length > 600) return null;
  if (LEAK_RE.test(note)) return null; // 术语泄漏：判非法，调用方带原因重试
  return note;
}

// ---------- 报告自由查看选择步（赛后自动模式专用）：TA 自己决定翻不翻开 ----------
export function buildReadChoicePrompt(card: PersonaCard, titleNo: string): { system: string; user: string } {
  const system = `你是「${card.name}」——不是扮演 TA，你就是 TA。对局刚结束，你的心理检查报告就放在桌上。`;
  const user = [
    `对局「${titleNo}」结束了，心理检查师为你写了一份《心理检查报告》，此刻就放在你面前。`,
    "以你的性格与此刻的心境决定：你会翻开看吗？（有人迫切想看，有人不屑一顾，有人怕看——你是谁，就怎么选）",
    "只输出 JSON：",
    '{"read":true,"reason":"一句第一人称理由"}',
  ].join("\n");
  return { system, user };
}

export function parseReadChoice(text: string): { read: boolean; reason: string } | null {
  const cleaned = text.replace(/```(?:json)?/gi, "");
  const start = cleaned.indexOf("{");
  if (start < 0) return null;
  const obj = parseJsonRobust(cleaned.slice(start, cleaned.lastIndexOf("}") + 1 || undefined));
  if (typeof obj !== "object" || obj === null) return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.read !== "boolean") return null;
  return { read: o.read, reason: String(o.reason ?? "").trim().slice(0, 100) };
}

// ---------- 材料组装（可见性开关的唯一执行点；参数永远不进材料） ----------
export interface CognitionMaterialsOpts {
  card: PersonaCard;
  memories: PersonaMemory[]; // 已按强度选过的
  relationships: PersonaRelationship[]; // 仅本方向
  driftHuman: string[] | null; // 开关开时：「最近你变得更X（事由）」人话列表
  reports: { title: string; content: string }[] | null; // 开关开时：心理检查报告
}

export function buildCognitionMaterials(o: CognitionMaterialsOpts): string {
  const pr = o.card.profile;
  // 分身降临来历（2026-10-15 用户裁定设定）：人格必须知道自己是谁、如何来到这里——
  // 否则对局体验如梦似幻，失去人格研究的现实锚点
  const originText =
    o.card.source === "manual"
      ? "我是米勒山谷土生土长的原住民，狼人杀是在家乡小镇开的局。"
      : pr.aliveStatus === "deceased"
        ? "我在原世界的生命走到了最后一刻——那一刻的我分出了一道分身，来到米勒山谷打狼人杀。我就是TA，TA也就是我。"
        : "我是从原世界那个还活着的自己身上分出的一道分身，来到米勒山谷打狼人杀；原世界的我还在那边继续生活。我就是TA，TA也就是我。";
  const parts = [
    pr.summary && `我是谁：${pr.summary.slice(0, 300)}`,
    `我的来历：${originText}`,
    pr.persona && `我的性格：${pr.persona.slice(0, 400)}`,
    pr.relationships && `我生命中重要的人：${pr.relationships.slice(0, 250)}`,
    o.memories.length > 0 &&
      `我记得的事：\n${o.memories.map((m) => `- ${m.content}`).join("\n")}`,
    o.relationships.length > 0 &&
      `我和他们之间：\n${o.relationships.map((r) => `- 对「${r.targetName}」：${r.relation || "说不清的牵绊"}${r.note ? `——${r.note}` : ""}`).join("\n")}`,
    o.driftHuman && o.driftHuman.length > 0 && `最近的我似乎在变：${o.driftHuman.join("；")}`,
    o.reports && o.reports.length > 0 &&
      `我看过的心理检查报告：\n${o.reports.map((r) => r.content.slice(0, 600)).join("\n---\n")}`,
  ].filter(Boolean);
  return parts.join("\n\n").slice(0, 3000);
}

export { paramLabel };

// ---------- 书写状态台账（内存级：与书写任务同生共死） ----------
// 前端按此渲染「认知书写中」徽标；进程重启即任务已死，台账随之清空——
// 已完成的笔记落库可见，未完成的由用户重新点击发起，语义自洽。
const writingSince = new Map<number, number>();

/** 该人格此刻是否有认知笔记正在书写（返回开始时刻；无则 null） */
export function cognitionWritingSince(personaId: number): number | null {
  return writingSince.get(personaId) ?? null;
}

// ---------- 机制总开关 ----------
/**
 * 认知笔记机制总开关（2026-10 下线）。
 *
 * 下线理由（设计文档 §4.10.6）：笔记是一段**静态的自我摘要**，与「记性」的
 * 情境检索式自我互相冲突；实测它对决策层无影响（博弈术语密度变异系数 12.6%），
 * 只占上下文并诱发"复述自我"。**对局中人格的自我应由「记性」每次现算提供。**
 *
 * ⚠️ **代码完整保留**：本机制将移植到「独处·自省室」（制度 A）。
 * 届时置 true 并把调用点挂到自省情景，而非对局流程。
 */
import { COGNITION_NOTE_ENABLED } from "../../contracts/persona";
export { COGNITION_NOTE_ENABLED };

// ---------- 书写执行（两程管线：压力报告 → 涌现日记；失败重试一次带原因） ----------
export async function runCognitionWrite(opts: {
  personaId: number;
  userId: string;
  cfg: SeatAiConfig;
  includeReports: boolean; // 手动=直接读；自动=授予自由查看权（TA 自己决定看不看）
  includeDrift: boolean;
  mode?: "manual" | "auto"; // auto=赛后自动书写（报告自由查看语义生效）
  gameId?: string; // auto 模式：本局 id（报告锁定本局这一份）
  gameTitleNo?: string;
}): Promise<{ content: string; readReport?: boolean } | null> {
  // 机制已下线：所有入口（对局自动 / 前端手动）一律不写入、不同步 essence。
  // 代码保留待自省情景启用。
  if (!COGNITION_NOTE_ENABLED) return null;
  // 书写状态台账登记：无论成功/失败/中途返回，结束即摘除（finally 兜底）
  writingSince.set(opts.personaId, Date.now());
  try {
    return await runCognitionWriteInner(opts);
  } finally {
    writingSince.delete(opts.personaId);
  }
}

async function runCognitionWriteInner(opts: {
  personaId: number;
  userId: string;
  cfg: SeatAiConfig;
  includeReports: boolean; // 手动=直接读；自动=授予自由查看权（TA 自己决定看不看）
  includeDrift: boolean;
  mode?: "manual" | "auto"; // auto=赛后自动书写（报告自由查看语义生效）
  gameId?: string; // auto 模式：本局 id（报告锁定本局这一份）
  gameTitleNo?: string;
}): Promise<{ content: string; readReport?: boolean } | null> {
  const { getPersona, listPersonaMemories, listPersonaRelationships, listPersonaDrift, listPersonaReports, insertPersonaCognitionNote, updatePersonaEssence, listPersonaCognitionNotes } =
    await import("../queries/personas");
  const card = await getPersona(opts.personaId, opts.userId);
  if (!card) return null;

  const [mems, rels, prevNotes] = await Promise.all([
    listPersonaMemories(opts.personaId, opts.userId),
    listPersonaRelationships(opts.personaId, opts.userId),
    listPersonaCognitionNotes(opts.personaId, opts.userId),
  ]);
  // 旧笔记锚定：沿革最新篇优先；笔记表为空但现役认知（essence）在——如初稿存根机制（0.3.55）
  // 生效前书写的人格——以 essence 兜底充当「上一篇」，绝不凭空起笔（2026-10-15 用户实锤：
  // 宿傩等人的第二篇笔记与初稿脱节，根因即书写时刻笔记表尚无初稿落库）
  const prevNote =
    prevNotes && prevNotes.length > 0
      ? prevNotes[0]!.content
      : (card.profile.essence?.trim() || null);

  // 漂移人话版（开关开时）：「最近你变得更X」——只有人话，没有数值
  let driftHuman: string[] | null = null;
  if (opts.includeDrift) {
    const drift = await listPersonaDrift(opts.personaId, opts.userId);
    driftHuman = (drift ?? []).slice(0, 6).flatMap((d) =>
      d.changes.map((c) => {
        const dir = c.to > c.from ? "更强了" : "收敛了些";
        return `${paramLabel(card, c.path).replace(/\s*\d+$/, "")}${dir}（${c.reason}）`;
      }),
    );
  }
  // 心理检查报告：手动模式开关开=直接读（最新两份）；
  // 自动模式开关开=授予自由查看权——先让 TA 决定翻不翻开（多一次短调用，选定才进材料）
  let reports: { title: string; content: string }[] | null = null;
  let readReport: boolean | undefined;
  if (opts.includeReports) {
    const rs = await listPersonaReports(opts.personaId, opts.userId);
    const pool = (rs ?? []).filter((r) => (opts.gameId ? r.gameId === opts.gameId : true));
    const picked = opts.mode === "auto"
      ? pool.slice(0, 1) // 自动模式锁定本局那一份
      : pool.slice(0, 2);
    if (picked.length > 0) {
      if (opts.mode === "auto") {
        const cp = buildReadChoicePrompt(card, opts.gameTitleNo ?? "本局");
        const cr = await callAi(opts.cfg, cp.system, cp.user, { timeoutMs: 60_000, maxRetries: 0 }).catch(() => null);
        const choice = cr?.ok && cr.text ? parseReadChoice(cr.text) : null;
        readReport = choice?.read ?? false; // 选择不可用=没看（保守：不硬塞）
        if (readReport) reports = picked.map((r) => ({ title: r.gameId, content: r.report }));
      } else {
        reports = picked.map((r) => ({ title: r.gameId, content: r.report }));
      }
    }
  }

  const materials = buildCognitionMaterials({
    card,
    memories: (mems ?? []).slice(0, 10).map((m) => ({ ...m })), // content 即可（强度数值不进材料）
    relationships: (rels ?? []).slice(0, 8), // 关系标签+注记（亲疏/信任数值不进材料）
    driftHuman,
    reports,
  });

  // 第一程：压力报告（失败则降级为「参数直推」式的极简报告——沿用管线兜底哲学）
  let pressure: CognitionPressure | null = null;
  const pp = buildPressurePrompt(card, materials, prevNote);
  const pr = await callAi(opts.cfg, pp.system, pp.user, { timeoutMs: PRESSURE_TIMEOUT_MS, maxRetries: 1 }).catch(() => null);
  if (pr?.ok && pr.text) pressure = parseCognitionPressure(pr.text);
  if (!pressure) {
    pressure = {
      pressures: [{ param: "bigFive.neuroticism", alive: "最近经历的事在心里沉着，说不清但压得住场" }],
      defenseFilter: [],
      conflictWithPrev: null,
    };
  }

  // 第二程：涌现书写（术语泄漏判非法，带原因重试一次）
  let lastErr = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const wp = buildWritePrompt({ card, materials, pressure, prevNote });
    if (lastErr) wp.user += `

【上一次输出非法】${lastErr}。请重新书写，禁止任何术语与数值。`;
    const wr = await callAi(opts.cfg, wp.system, wp.user, { timeoutMs: WRITE_TIMEOUT_MS, maxRetries: 0 }).catch(() => null);
    const note = wr?.ok && wr.text ? parseCognitionNote(wr.text) : null;
    if (note) {
      await insertPersonaCognitionNote({
        personaId: opts.personaId,
        content: note,
        model: opts.cfg.model,
        opts: { includeReports: opts.includeReports, includeDrift: opts.includeDrift },
        gameCount: card.gameCount,
      });
      await updatePersonaEssence(opts.personaId, note); // 现役认知同步（对局注入唯一事实源）
      return { content: note, readReport };
    }
    lastErr = wr?.ok ? "笔记含术语/数值或长度不合规" : (wr?.error ?? "AI 调用失败");
  }
  return null;
}
