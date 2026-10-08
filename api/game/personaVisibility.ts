// ============================================================
// 玩家人格可见度（人格圈层的信息壁垒）：三档语义的唯一事实源
// 仅「有人格卡座位的玩家」的 prompt 注入本段（service 层 pipeline 分岔处）——
// 普通 AI 座位不受任何影响；圈层只共享人格【姓名/基本印象/外貌气质/羁绊】，
// 不泄露人格详情与身份信息（狼/好人）。
// ============================================================

export interface PersonaCircleBinding {
  seat: number;
  name: string;
  appearance?: string | null; // 外貌与气质（人格公开档案；圈层可见时随姓名一并共享）
  summary?: string | null; // 基本印象（profile.summary 首句；防性别/身份误读——如「他」/「她」）
  originSource?: string | null; // 出处（作品名/「现实人物」）
}

/** 观察者人格与在场另一人格的羁绊（记事簿跨局关系 + 档案互提的原作渊源） */
export interface PersonaBondInfo {
  seat: number; // 对方座位
  name: string; // 对方人格名
  relation: string; // 关系标签（如「信任」「宿怨」「亦敌亦友」）
  affinity: number; // -100..100 亲疏（负=敌意）
  trust: number; // 0..100 信任度
  note: string; // 关键事件一句话（空=无注记）
  origin?: string; // 原作渊源说明（档案记载互提；有值时优先于关系行展示）
}

export type PersonaVisibility = "full" | "partial" | "none";

function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** 生成该人格座位应看到的「人格圈层知晓」文本；无圈层内容时返回 null（不注入） */
export function buildPersonaCircleText(
  seat: number,
  bindings: PersonaCircleBinding[],
  visibility: PersonaVisibility | undefined,
  fogSeats: number[] | undefined,
  bonds?: PersonaBondInfo[],
): string | null {
  const vis = visibility ?? "full"; // 默认完全可见

  if (vis === "none") {
    return [
      "【人格迷雾】本局所有玩家对你而言都是迷雾：你不知道任何人的真实人格——",
      "可以观察言行自行推测（也可能谁都猜不中），但不得假装确知某位玩家是谁。",
    ].join("");
  }

  const fog = new Set(vis === "partial" ? (fogSeats ?? []) : []);
  // 自己的人格自己当然清楚（essence 已注入）；列出的是「其他」可见人格玩家
  const known = bindings.filter((b) => b.seat !== seat && !fog.has(b.seat));
  const lines: string[] = [];
  if (known.length > 0) {
    const fmt = (b: PersonaCircleBinding) => {
      let head = `${b.seat}号=${b.name}`;
      if (b.originSource?.trim()) head += `（${clip(b.originSource, 32)}）`;
      const parts = [head];
      const summary = b.summary?.trim();
      if (summary) parts.push(`基本印象：${clip(summary, 60)}`);
      const app = b.appearance?.trim();
      if (app) parts.push(`外貌气质：${clip(app, 60)}`);
      return parts.join("，");
    };
    lines.push(
      `【人格圈层】迷雾散开——你知道这些座位背后的真实人格（其详细人格与游戏身份你不清楚）：` +
        known.map(fmt).join("；") + "。",
    );
    // 称呼与博弈指引：人格名互称 + 基于认知的博弈（用户核心设想）
    lines.push(
      "你可以直呼已知人格的人格名来对话（如「五条悟，你刚才那波……」），人格名与座位号可自由混用；" +
        "你了解 TA 们的人格底色与作风——可以用你对 TA 的认知去预判、游说、结盟或提防。" +
        "但记住：人格只是参考，本局身份与立场才是博弈本体（也可能有人刻意扮演反差）。对迷雾中的玩家仍按座位号称呼。",
    );
  }
  lines.push(
    "除此之外的玩家对你而言都是迷雾（不知道其真实人格，可自行推测，也可能谁都猜不中），不得假装确知迷雾身份。",
  );
  // 羁绊注入：仅限「可见人格」——对方在迷雾里时你不知道 TA 是谁，羁绊无从谈起
  const knownSeats = new Set(known.map((b) => b.seat));
  const myBonds = (bonds ?? []).filter((b) => knownSeats.has(b.seat));
  if (myBonds.length > 0) {
    const fmtBond = (b: PersonaBondInfo) =>
      b.origin
        ? `${b.seat}号${b.name}：原作渊源——${clip(b.origin, 80)}`
        : `${b.seat}号${b.name}：${b.relation || "旧识"}（亲疏${b.affinity}，信任${b.trust}）${b.note ? `——${clip(b.note, 60)}` : ""}`;
    lines.push(
      `【你与在场人格的羁绊】（你亲历或熟知的过往，他人不知道这些细节——可在博弈中利用，也当心对方同样记得）：` +
        myBonds.map(fmtBond).join("；") + "。",
    );
  }
  if (vis === "partial" && fog.has(seat)) {
    lines.push(
      "注意：你自己处于迷雾状态——其他玩家不知道你的人格（你的言行不会被对号入座，可利用这一点，也可有意引导）。",
    );
  }
  return lines.join("\n");
}

/** 把圈层文本注入基础 prompt 的 user 段——必须落在【输出契约】之前：
 *  人格管线（单/双程）会截断契约之后的部分另接人格契约，尾部追加会被静默切断
 *  （对局 20260930001 实锤：圈层文本全程未达 AI，人格玩家互不认识）。 */
export function injectCircleText(baseUser: string, circleText: string): string {
  const cutIdx = baseUser.indexOf("【输出契约】");
  return cutIdx >= 0
    ? `${baseUser.slice(0, cutIdx)}${circleText}\n\n${baseUser.slice(cutIdx)}`
    : `${baseUser}\n\n${circleText}`;
}
