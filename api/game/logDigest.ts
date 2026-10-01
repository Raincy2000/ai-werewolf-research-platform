// ============================================================
// 确定性日志摘要器：把整局事件流机械压缩成 ≤6000 字的结构化中文摘要
// - 纯函数，不调用任何 AI；输出即分析师 prompt 的直接输入
// - 结构：对局信息 / 全员身份表 / 逐日（夜+天）时间线 / 对局结果
// - 硬限 6000 字，超限依次降级：砍心理活动 → 发言截断 120→60 → 丢弃最早一天的发言
//   （行动、投票、死亡与结果始终保留）；兜底硬切片保住身份表/胜负/末日复盘
// ============================================================

import type { Camp, GameEvent, GameSnapshot } from "../../contracts/game";

export const LOG_DIGEST_CHAR_LIMIT = 9_000; // 摘要总量硬上限（分析提质：更多素材）

const SPEECH_LIMIT = 120; // 白天发言每条截取
const COMPACT_SPEECH_LIMIT = 60; // 二级压缩后的发言截取
const THOUGHT_LIMIT = 80; // 代表性心理活动每条截取
const MAX_THOUGHTS_PER_SECTION = 3; // 每夜/每天最多附的代表性心理活动条数
const WOLF_CHANNEL_LIMIT = 100; // 狼人频道讨论每条截取（夜间讨论可能较长）

const CAMP_LABEL: Record<Camp, string> = {
  wolf: "狼人阵营",
  god: "神职",
  villager: "平民",
};

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

// ---------- 身份表 ----------
function formatRoster(snapshot: GameSnapshot): string {
  return snapshot.players
    .map((p) => {
      const life = p.alive ? "存活" : `死亡${p.deathInfo ? `（${p.deathInfo}）` : ""}`;
      const sheriff = p.sheriff ? "·警长" : "";
      const model = p.aiModel ? ` [${p.aiModel}]` : "";
      return `${p.seat}号 ${p.roleName}（${CAMP_LABEL[p.camp]}）${life}${sheriff}${model}`;
    })
    .join("\n");
}

// ---------- 逐日分桶 ----------
interface LabeledText {
  label: string;
  content: string;
}

interface DayBucket {
  day: number;
  nightActions: string[]; // 夜间行动全文（狼刀/用药/验人/守护/摄梦/狩猎/恐惧等）
  nightThoughts: LabeledText[]; // 夜间代表性心理活动（转折性事件：行动/投票类）
  deaths: string[]; // 死亡公告（夜亡/枪带走/决斗/放逐出局）
  speeches: LabeledText[]; // 白天发言（含警上/PK/遗言）
  dayThoughts: LabeledText[]; // 白天代表性心理活动
  votes: string[]; // 投票明细（紧凑形如 1→5 / 2弃票）
  results: string[]; // 投票结果 / 放逐结果
  skills: string[]; // 技能发动（开枪/决斗/自爆/诽谤等）
  affairs: string[]; // 局势事件（警长落地/翻牌/平安日/进入黑夜等）
}

function newBucket(day: number): DayBucket {
  return {
    day,
    nightActions: [],
    nightThoughts: [],
    deaths: [],
    speeches: [],
    dayThoughts: [],
    votes: [],
    results: [],
    skills: [],
    affairs: [],
  };
}

// 投票明细紧凑化："3号玩家投给5号（警长1.5票）。" → "3→5(1.5票)"；"3号玩家弃票。" → "3弃票"
function compactVote(ev: GameEvent): string {
  const m = ev.content.match(/(\d+)号玩家投给(\d+)号/);
  if (m) return `${m[1]}→${m[2]}${/1\.5票/.test(ev.content) ? "(1.5票)" : ""}`;
  if (/弃票/.test(ev.content)) return `${ev.actor ?? "?"}弃票`;
  return ev.content;
}

// 代表性心理活动：仅取自转折性事件（行动/投票类，玩家的真实决策动机），每条截 80 字
function toThought(ev: GameEvent): LabeledText | null {
  if (!ev.thought?.trim()) return null;
  if (ev.type !== "action" && ev.type !== "vote") return null;
  return { label: `${ev.actorLabel ?? "系统"}·${ev.title}`, content: clip(ev.thought.trim(), THOUGHT_LIMIT) };
}

// 发言标签：公开发言不带后缀，其余带场合后缀（警上发言/PK发言/遗言等）
function speechLabel(ev: GameEvent): string {
  const who = ev.actor != null ? `${ev.actor}号` : (ev.actorLabel ?? "?");
  return ev.title === "公开发言" ? who : `${who}（${ev.title}）`;
}

interface DigestModel {
  header: string; // 对局信息 + 身份表
  days: DayBucket[];
  gameResult: string | null; // 对局结果事件全文
}

function buildModel(snapshot: GameSnapshot, events: GameEvent[]): DigestModel {
  const winnerLabel =
    snapshot.winner === "wolf"
      ? "狼人阵营胜利"
      : snapshot.winner === "good"
        ? "好人阵营胜利"
        : "未定（对局未完结）";
  const statusLine =
    snapshot.status !== "finished" ? `\n- 状态：对局未完结（以下为基于已有日志的阶段性记录）` : "";
  const header = [
    "【对局信息】",
    `- 版型：${snapshot.boardName}`,
    `- 结果：${winnerLabel}`,
    `- 持续天数：${snapshot.day} 天${statusLine}`,
    "",
    "【全员身份表】（上帝视角，玩家互相不知道彼此身份）",
    formatRoster(snapshot),
  ].join("\n");

  const byDay = new Map<number, DayBucket>();
  const bucketOf = (day: number): DayBucket => {
    let b = byDay.get(day);
    if (!b) {
      b = newBucket(day);
      byDay.set(day, b);
    }
    return b;
  };

  let gameResult: string | null = null;
  for (const ev of events) {
    if (ev.type === "phase") continue; // 阶段标记无信息量
    if (ev.type === "result") {
      gameResult = ev.content; // 对局结果（含终局身份表），始终完整保留
      continue;
    }
    if (ev.day < 1) continue; // 开局系统事件（版型信息头部已含）

    const b = bucketOf(ev.day);
    if (ev.phase.startsWith("night.")) {
      // 夜间：行动/系统事件全文保留；狼人频道讨论截取（可能较长）
      const text = ev.title === "狼人频道" ? clip(ev.content, WOLF_CHANNEL_LIMIT) : ev.content;
      b.nightActions.push(`- ${text}`);
      const t = toThought(ev);
      if (t) b.nightThoughts.push(t);
      continue;
    }

    // 白天（含警长竞选/开枪/遗言等 day.* 阶段）
    const t = toThought(ev);
    if (t) b.dayThoughts.push(t);
    switch (ev.type) {
      case "speech":
        b.speeches.push({ label: speechLabel(ev), content: ev.content });
        break;
      case "vote":
        if (ev.actor != null) b.votes.push(compactVote(ev));
        else if (ev.title === "放逐结果") b.results.push(`放逐结果：${ev.content}`);
        else b.results.push(`${ev.title}：${ev.content}`); // 投票结果/警徽投票结果
        break;
      case "death":
        b.deaths.push(ev.content);
        break;
      case "action":
        b.skills.push(ev.content);
        break;
      case "system":
        b.affairs.push(ev.content);
        break;
    }
  }

  const days = [...byDay.values()].sort((a, b) => a.day - b.day);
  return { header, days, gameResult };
}

// ---------- 渲染（支持降级参数） ----------
interface RenderOptions {
  thoughts: boolean; // 是否附代表性心理活动
  speechLimit: number; // 发言截取长度
  dropSpeechDays: number; // 丢弃最早 N 天的发言（保留行动与结果）
}

function renderThoughts(list: LabeledText[]): string[] {
  if (list.length === 0) return [];
  const picked = list.slice(0, MAX_THOUGHTS_PER_SECTION);
  const lines = picked.map((t) => `  - ${t.label}：${t.content}`);
  const more = list.length > picked.length ? [`  - （另有 ${list.length - picked.length} 条心理活动从略）`] : [];
  return ["· 心理（代表性）：", ...lines, ...more];
}

function render(model: DigestModel, opts: RenderOptions): string {
  const parts: string[] = [model.header, "", "【逐日时间线】"];
  if (model.days.length === 0) {
    parts.push("（暂无对局日志）");
  }
  model.days.forEach((b, i) => {
    if (b.nightActions.length > 0 || (opts.thoughts && b.nightThoughts.length > 0)) {
      parts.push(`〔第${b.day}夜〕`);
      parts.push(...b.nightActions);
      if (opts.thoughts) parts.push(...renderThoughts(b.nightThoughts));
    }
    parts.push(`〔第${b.day}天〕`);
    for (const d of b.deaths) parts.push(`· 死亡公告：${d}`);
    if (i < opts.dropSpeechDays) {
      if (b.speeches.length > 0) parts.push(`· 发言：已省略（共${b.speeches.length}条）`);
    } else if (b.speeches.length > 0) {
      parts.push("· 发言：");
      for (const s of b.speeches) parts.push(`  - ${s.label}：${clip(s.content, opts.speechLimit)}`);
    }
    if (opts.thoughts) parts.push(...renderThoughts(b.dayThoughts));
    if (b.votes.length > 0) parts.push(`· 投票明细：${b.votes.join("；")}`);
    for (const r of b.results) parts.push(`· ${r}`);
    for (const s of b.skills) parts.push(`· 技能发动：${s}`);
    for (const a of b.affairs) parts.push(`· 局势：${a}`);
  });
  if (model.gameResult) {
    parts.push("", "【对局结果】", model.gameResult);
  }
  return parts.join("\n");
}

// ---------- 入口：机械提取 + 分级降级，硬限 6000 字 ----------
export function buildLogDigest(snapshot: GameSnapshot, events: GameEvent[]): string {
  const model = buildModel(snapshot, events);

  // 降级序列：完整 → 砍心理活动 → 发言截 60 → 逐天丢弃最早的发言
  const attempts: RenderOptions[] = [
    { thoughts: true, speechLimit: SPEECH_LIMIT, dropSpeechDays: 0 },
    { thoughts: false, speechLimit: SPEECH_LIMIT, dropSpeechDays: 0 },
    { thoughts: false, speechLimit: COMPACT_SPEECH_LIMIT, dropSpeechDays: 0 },
    ...model.days.map((_, i) => ({
      thoughts: false,
      speechLimit: COMPACT_SPEECH_LIMIT,
      dropSpeechDays: i + 1,
    })),
  ];
  for (const opts of attempts) {
    const out = render(model, opts);
    if (out.length <= LOG_DIGEST_CHAR_LIMIT) return out;
  }

  // 极端兜底：时间线只留尾部（末日复盘优先），头部（对局信息+身份表）与对局结果完整保留
  const minimal = render(model, {
    thoughts: false,
    speechLimit: COMPACT_SPEECH_LIMIT,
    dropSpeechDays: model.days.length,
  });
  if (minimal.length <= LOG_DIGEST_CHAR_LIMIT) return minimal;

  const tail = model.gameResult ? `\n\n【对局结果】\n${model.gameResult}` : "";
  const budget = LOG_DIGEST_CHAR_LIMIT - model.header.length - tail.length - 30;
  const timeline = render({ ...model, gameResult: null }, {
    thoughts: false,
    speechLimit: COMPACT_SPEECH_LIMIT,
    dropSpeechDays: model.days.length,
  });
  const kept = timeline.slice(-Math.max(0, budget));
  return `${model.header}\n（早期记录已省略）\n${kept}${tail}`;
}
