import type { Camp, RoleId } from "../../contracts/game";

export interface VictoryAuditPlayer {
  role: RoleId;
  camp: Camp;
  alive: boolean;
  stock: string[];
}

/**
 * 保守、确定性的提前胜利审核：
 * - 没有非狼时已经无需再玩，放行；非狼超过一人时不允许提前宣布。
 * - 仅剩一名非狼时，只排除仍可直接改变夜刀结果的反制路径：
 *   守卫保护、女巫解药、骑士尚未使用的决斗。
 * - 毒药、已耗技能及摄梦人的“不能摄自己”不被误算为额外反制。
 *
 * 不调用模型、不读取胜率、不使用概率；同一引擎状态必得同一结果。
 */
export function deterministicVictoryAudit(players: VictoryAuditPlayer[]): "pass" | "reject" {
  const alive = players.filter((p) => p.alive);
  if (!alive.some((p) => p.camp === "wolf")) return "reject";
  const nonWolves = alive.filter((p) => p.camp !== "wolf");
  if (nonWolves.length === 0) return "pass";

  // 双屠边收官：神、民各只剩一人，且至少两狼在场。无论白天放逐谁，
  // 入夜刀掉另一边都立即屠边；平票后再刀一人，也会回到单非狼的终局审核。
  // 只在双方都没有直接反制存量时采用此捷径，其他多人局面继续保守驳回。
  if (nonWolves.length === 2 && alive.filter((p) => p.camp === "wolf").length >= 2) {
    const bothBoundaries = new Set(nonWolves.map((p) => p.camp)).size === 2;
    const hasCounterplay = nonWolves.some((p) =>
      p.role === "guard" ||
      (p.role === "witch" && (p.stock.includes("解药可用") || p.stock.includes("毒药可用"))) ||
      (p.role === "knight" && p.stock.includes("决斗可用")),
    );
    if (bothBoundaries && !hasCounterplay) return "pass";
  }
  if (nonWolves.length > 1) return "reject";

  const target = nonWolves[0]!;
  const hasCounterplay =
    target.role === "guard" ||
    (target.role === "witch" && target.stock.includes("解药可用")) ||
    (target.role === "knight" && target.stock.includes("决斗可用"));
  return hasCounterplay ? "reject" : "pass";
}
