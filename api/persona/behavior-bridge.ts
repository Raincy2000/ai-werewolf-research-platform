import type { MirrorReport } from "../../contracts/persona";

/** 把心镜结果完整转交给同一主体；不按战术内容审查或删除思想。 */
export function buildBehaviorBridge(mirror: MirrorReport): string {
  const tensions = mirror.tensions
    .flatMap((group) => group.poles.map((pole) => pole.urge.trim()))
    .filter(Boolean)
    .slice(0, 6);
  const bonds = (mirror.bonds ?? [])
    .map((bond) => `对${bond.toward}：${bond.feel}；由此想${bond.urge}`)
    .filter((text) => text.trim().length > 0)
    .slice(0, 8);
  const control = `此刻自我控制余量为 ${mirror.selfControl}/100。`;
  const impulse = mirror.impulse.trim();
  const currentReaction = mirror.currentReaction?.trim() ?? "";
  const hasReflection = mirror.wantsReflection === true || tensions.length > 0 || bonds.length > 0 || !!impulse;
  if (!currentReaction && !hasReflection) return "";
  return [
    "【隐性行为倾向】（只影响你的反应，不是你能向他人宣讲的心理知识）",
    "以下是你此刻实际出现的心理、意图与关系经验。",
    currentReaction ? `当前事件引起的原始反应：${currentReaction}` : "",
    impulse ? `此刻的直接想法或需求：${impulse}` : "",
    tensions.length ? `心里同时存在这些方向：${tensions.join("；")}` : "",
    hasReflection ? control : "",
    ...bonds,
  ].filter(Boolean).join("\n");
}
