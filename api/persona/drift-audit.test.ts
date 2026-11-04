// ============================================================
// 人格演化健康审计（优化方案 P5：监控 + 回归护栏）
// 对真实库体检：参数越界 / 漂移维度集中度 / 方向熵 / 阻尼抑制率
//
// 运行方式（需指定桌面端数据库）：
//   WW_AUDIT_DB="C:\\Users\\<you>\\AppData\\Roaming\\werewolf-desktop\\werewolf.db" \
//     npx vitest run api/persona/drift-audit
// ============================================================
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { clampParam, evolveParam } from "../../contracts/persona";

const DB = process.env.WW_AUDIT_DB;

interface Change { path: string; from: number; to: number }

describe.skipIf(!DB)("人格漂移健康审计（真实库）", () => {
  it("新规则下越界清零，并输出维度/方向体检报告", () => {
    const db = new DatabaseSync(DB!, { readOnly: true });
    const rows = db.prepare("SELECT changes FROM persona_drift_log").all() as { changes: string }[];

    let total = 0;
    let legacyOob = 0;
    let newOob = 0;
    let suppressed = 0;
    const legacyDims: Record<string, number> = {};
    const dir: Record<string, number> = {};

    for (const r of rows) {
      let changes: Change[];
      try { changes = JSON.parse(r.changes) as Change[]; } catch { continue; }
      for (const c of changes) {
        total++;
        const group = c.path.split(".")[0] ?? "?";
        legacyDims[group] = (legacyDims[group] ?? 0) + 1;
        if (c.to > 100 || c.to < 0) legacyOob++;
        // 用 v3 管线重放：EWMA（α_eff 含四因子）→ 弹性阻尼 → 分层安全网 → 硬钳位
        // 旧记录只给了 delta，此处按新语义解释为「本局表现相对自身特质的偏离量」
        const state = clampParam(c.from + (c.to - c.from));
        const { value: next } = evolveParam(c.from, state, c.path);
        if (next > 100 || next < 0) newOob++;
        if (next === c.from) suppressed++;
        const key = c.to >= c.from ? "↑" : "↓";
        dir[key] = (dir[key] ?? 0) + 1;
      }
    }

    const pct = (n: number) => ((n / total) * 100).toFixed(1) + "%";
    const share = Object.entries(legacyDims)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${pct(v)}`)
      .join("｜");
    const entropy = -Object.values(legacyDims)
      .map((v) => v / total)
      .reduce((s, p) => s + (p > 0 ? p * Math.log(p) : 0), 0);

    console.log(`[审计] 漂移项 ${total}｜历史越界 ${legacyOob}｜新规则越界 ${newOob}`);
    console.log(`[审计] 历史维度分布：${share}`);
    console.log(`[审计] 维度熵 ${entropy.toFixed(3)}（越接近 ln(组数) 越均衡）`);
    console.log(`[审计] 历史方向：${JSON.stringify(dir)}`);
    console.log(`[审计] 新管线抑制（阻尼/钳位后无净变化）：${suppressed} 项（${pct(suppressed)}）`);

    expect(newOob).toBe(0);
    db.close();
  });
});
