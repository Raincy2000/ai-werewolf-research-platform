// ============================================================
// 玩家人格可见度（人格圈层的信息壁垒）：三档语义的唯一事实源
// 仅「有人格卡座位的玩家」的 prompt 注入本段（service 层 pipeline 分岔处）——
// 普通 AI 座位不受任何影响；圈层只共享人格【姓名】，不泄露人格详情与身份信息（狼/好人）。
// ============================================================

export interface PersonaCircleBinding {
  seat: number;
  name: string;
  appearance?: string | null; // 外貌与气质（人格公开档案；圈层可见时随姓名一并共享）
}

export type PersonaVisibility = "full" | "partial" | "none";

/** 生成该人格座位应看到的「人格圈层知晓」文本；无圈层内容时返回 null（不注入） */
export function buildPersonaCircleText(
  seat: number,
  bindings: PersonaCircleBinding[],
  visibility: PersonaVisibility | undefined,
  fogSeats: number[] | undefined,
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
      const app = (b.appearance ?? "").trim();
      return app ? `${b.seat}号=${b.name}（外貌气质：${app}）` : `${b.seat}号=${b.name}`;
    };
    lines.push(
      `【人格圈层】你知道这些座位背后的人格（姓名与外貌气质；其详细人格与身份你不清楚，可观察言行自行推测）：` +
        known.map(fmt).join("；") + "。",
    );
  }
  lines.push(
    "除此之外的玩家对你而言都是迷雾（不知道其真实人格，可自行推测，也可能谁都猜不中），不得假装确知迷雾身份。",
  );
  if (vis === "partial" && fog.has(seat)) {
    lines.push(
      "注意：你自己处于迷雾状态——其他玩家不知道你的人格（你的言行不会被对号入座，可利用这一点，也可有意引导）。",
    );
  }
  return lines.join("\n");
}
