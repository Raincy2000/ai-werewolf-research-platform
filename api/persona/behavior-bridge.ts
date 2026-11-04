import type { MirrorReport } from "../../contracts/persona";

/** 把心镜结果翻译成行为倾向，而不是交给人物一份可自述的心理参数报告。 */
export function buildBehaviorBridge(mirror: MirrorReport): string {
  const tensions = mirror.tensions
    .flatMap((group) => group.poles.map((pole) => pole.urge.trim()))
    .filter(Boolean)
    .slice(0, 6);
  const bonds = (mirror.bonds ?? [])
    .map((bond) => `对${bond.toward}：${bond.feel}；由此想${bond.urge}`)
    .filter((text) => text.trim().length > 0)
    .slice(0, 8);
  const control = mirror.selfControl <= 30
    ? "此刻克制较弱，冲动更容易直接落到措辞和动作上"
    : mirror.selfControl >= 70
      ? "此刻克制较强，外在反应会比内在感受更收敛"
      : "此刻仍保有克制，但内在拉扯会自然影响反应";
  return [
    "【隐性行为倾向】（只影响你的反应，不是你能向他人宣讲的心理知识）",
    mirror.impulse.trim() ? `此刻最想做的事：${mirror.impulse.trim()}` : "",
    tensions.length ? `心里同时存在这些方向：${tensions.join("；")}` : "",
    control,
    ...bonds,
  ].filter(Boolean).join("\n");
}
