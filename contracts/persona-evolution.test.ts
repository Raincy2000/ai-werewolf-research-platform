// 人格演化动力学（v3 · EWMA）单元测试 —— 把「科学不变量」固化为回归测试
// 文献：Dugan 2023（重复效应凹且饱和）｜Damian 2020（单次极端不主导轨迹）｜
//       Roberts 2017（单局须远小于 0.5SD）｜Fraley 2011（依恋更稳定）｜
//       Diener 2006（个体适应差异 κ）｜Bucciol 2024（调节调节效应）｜
//       Steyer LST（压制场合噪声）｜Roberts & DelVecchio 2000（排序稳定）
import { describe, expect, it } from "vitest";
import {
  ALPHA_BASE,
  ALPHA_EFF_MAX,
  EVOLUTION_MECHANISM_VERSION,
  accumulateStep,
  alphaEff,
  appraisalFactor,
  clampParam,
  defaultPersonaParams,
  driftLimitOf,
  elasticDelta,
  evolveParam,
  formatDriftPanel,
  getParamValue,
  repeatFactor,
  salienceFactor,
} from "./persona";

describe("clampParam（铁律1：0-100 连续量化）", () => {
  it("越界钳位 / 取整 / 非有限值兜底", () => {
    expect(clampParam(101)).toBe(100);
    expect(clampParam(-5)).toBe(0);
    expect(clampParam(96.6)).toBe(97);
    expect(clampParam(Number.NaN)).toBe(0);
    expect(clampParam(Infinity)).toBe(0);
  });
});

describe("分层漂移上限（v3 收紧：特质±1 / 依恋±0.5 / 适应±2 / 状态±4）", () => {
  it("各层取值符合标定", () => {
    expect(driftLimitOf("bigFive.neuroticism")).toBe(1);
    expect(driftLimitOf("attachment.anxiety")).toBe(0.5);
    expect(driftLimitOf("darkTetrad.narcissism")).toBe(2);
    expect(driftLimitOf("sdt.competence")).toBe(2);
    expect(driftLimitOf("emotionRegulation.rumination")).toBe(4);
    expect(driftLimitOf("defenseMechanisms.humor")).toBe(4);
    expect(driftLimitOf("cognitiveBiases.confirmation")).toBe(4);
    expect(driftLimitOf("unknown.path")).toBe(2);
  });
  it("依恋比大五更稳定（Fraley et al. 2011）", () => {
    expect(driftLimitOf("attachment.anxiety")).toBeLessThan(driftLimitOf("bigFive.neuroticism"));
  });
  it("★ 收紧不变量：v3 每层严格小于 v2（±2/±1/±3/±6）", () => {
    expect(driftLimitOf("bigFive.neuroticism")).toBeLessThan(2);
    expect(driftLimitOf("attachment.anxiety")).toBeLessThan(1);
    expect(driftLimitOf("darkTetrad.narcissism")).toBeLessThan(3);
    expect(driftLimitOf("emotionRegulation.rumination")).toBeLessThan(6);
  });
});

describe("α_eff 四因子（§4.3）", () => {
  it("★ α_eff 必须把「次数」经 φ 换算（否则会被当成放大因子）", () => {
    const once = alphaEff({ repeatCount: 1, salience: 1, kappa: 1, appraisal: 1 });
    expect(once).toBeCloseTo(ALPHA_BASE * repeatFactor(1), 8);
    expect(once).toBeLessThan(ALPHA_BASE); // 首次影响必小于基准
  });
  it("φ 重复因子：凹且饱和，永不超过 1（Dugan 2023）", () => {
    expect(repeatFactor(0)).toBe(0);
    expect(repeatFactor(1)).toBeLessThan(0.3);
    expect(repeatFactor(3)).toBeGreaterThan(repeatFactor(1));
    expect(repeatFactor(100)).toBeLessThanOrEqual(1);
    expect(repeatFactor(2) - repeatFactor(1)).toBeGreaterThan(repeatFactor(20) - repeatFactor(19));
  });
  it("ψ 烈度因子：有下限、有封顶（Damian 2020 警告）", () => {
    expect(salienceFactor(50, 50)).toBe(0.2);
    expect(salienceFactor(100, 50)).toBe(1);
    expect(salienceFactor(100, 49)).toBe(1);
  });
  it("α_eff 有界：默认等于 α_base，且不超过实证上限", () => {
    // 默认 repeatCount=1 → 经 φ 换算后必小于基准（首次经历影响最小）
    expect(alphaEff({})).toBeCloseTo(ALPHA_BASE * repeatFactor(1), 8);
    expect(alphaEff({ repeatCount: 1, salience: 1, kappa: 1.5, appraisal: 1.5 })).toBeLessThanOrEqual(ALPHA_EFF_MAX);
    expect(alphaEff({ repeatCount: 0 })).toBe(0);
  });
  it("评价调节：重评/成熟防御缓冲，反刍放大（Bucciol 2024）", () => {
    const calm = appraisalFactor({ cognitiveReappraisal: 100, rumination: 0 });
    const hot = appraisalFactor({ cognitiveReappraisal: 0, rumination: 100 });
    expect(hot).toBeGreaterThan(calm);
    expect(calm).toBeGreaterThanOrEqual(0.5);
    expect(hot).toBeLessThanOrEqual(1.5);
  });
});

describe("evolveParam（v3 · EWMA：trait ← trait + α_eff × (state − trait)）", () => {
  it("以自身特质为先验：state = trait 时不移动", () => {
    expect(evolveParam(50, 50, "bigFive.neuroticism").value).toBe(50);
  });
  it("★ 单局位移被 α_eff 压制，小于层级上限", () => {
    const r = evolveParam(50, 100, "bigFive.neuroticism");
    expect(Math.abs(r.value - 50)).toBeLessThanOrEqual(1); // 不超层级上限
    expect(Math.abs(r.delta)).toBeLessThan(1); // EWMA 实际位移极小
  });
  it("永不越出 0-100", () => {
    expect(evolveParam(99, 100, "bigFive.neuroticism").value).toBeLessThanOrEqual(100);
    expect(evolveParam(1, 0, "bigFive.agreeableness").value).toBeGreaterThanOrEqual(0);
  });
  it("回归缺陷：重复极值冲击不再发散（原：神经质 96 → 101）", () => {
    let v = 96;
    for (let i = 0; i < 50; i++) {
      v = evolveParam(v, 100, "bigFive.neuroticism", { repeatCount: 5, kappa: 1.5, appraisal: 1.5 }).value;
    }
    expect(v).toBeLessThanOrEqual(100);
    expect(v).toBeGreaterThanOrEqual(90);
  });
  it("极端处同一状态冲击的效力小于中部（弹性阻尼）—— 按浮点 delta 比较", () => {
    // 整数 value 在 EWMA 下常因取整而不变，故阻尼必须在**浮点 delta** 上验证
    const mid = Math.abs(evolveParam(50, 90, "bigFive.neuroticism").delta);
    const edge = Math.abs(evolveParam(96, 90, "bigFive.neuroticism").delta);
    expect(mid).toBeGreaterThan(0);
    expect(edge).toBeLessThan(mid);
  });
  it("★ 返回**未取整**浮点 delta（供小数累积器逐步落账）", () => {
    const r = evolveParam(50, 60, "bigFive.neuroticism");
    expect(r.delta).toBeGreaterThan(0);
    expect(r.delta).toBeLessThan(0.5); // 单局位移极小，取整会归零
    expect(Number.isInteger(r.delta)).toBe(false);
  });
  it("返回 α_eff 与四因子（铁律7：可追溯）", () => {
    const r = evolveParam(50, 80, "bigFive.neuroticism");
    expect(r.alphaEff).toBeGreaterThan(0);
    expect(r.factors.salience).toBeCloseTo(salienceFactor(80, 50), 8);
  });
  it("机制版本已定义（跨版本可比）", () => {
    expect(EVOLUTION_MECHANISM_VERSION).toMatch(/^ewma-/);
  });
});

describe("★ 小数累积器（EWMA 微小位移的落账缓冲）", () => {
  it("单次微小位移不落账，但被留存", () => {
    const a = accumulateStep(0, 0.4);
    expect(a.step).toBe(0);
    expect(a.residual).toBeCloseTo(0.4, 8);
  });
  it("反复小经历最终累积成整数位移（Dugan 2023）", () => {
    let res = 0, total = 0;
    for (let i = 0; i < 3; i++) {
      const r = accumulateStep(res, 0.4);
      res = r.residual;
      total += r.step;
    }
    expect(total).toBe(1); // 0.4×3 = 1.2 → 落 1，余 0.2
    expect(res).toBeCloseTo(0.2, 8);
  });
  it("★ 余数严格有界 [-1, 1]（绝不无限增长）", () => {
    let res = 0;
    for (let i = 0; i < 1000; i++) {
      const r = accumulateStep(res, 0.9);
      res = r.residual;
      expect(res).toBeGreaterThanOrEqual(-1);
      expect(res).toBeLessThanOrEqual(1);
      expect(Number.isFinite(res)).toBe(true);
    }
  });
  it("★ 非有限输入不污染（NaN / Infinity 兜底）", () => {
    const a = accumulateStep(Number.NaN, 0.5);
    expect(a.step).toBe(0);
    expect(Number.isFinite(a.residual)).toBe(true);
    const b = accumulateStep(0, Number.POSITIVE_INFINITY);
    expect(b.step).toBe(0);
    expect(Number.isFinite(b.residual)).toBe(true);
  });
  it("负向同样成立（保号）", () => {
    let res = 0, total = 0;
    for (let i = 0; i < 3; i++) { const r = accumulateStep(res, -0.4); res = r.residual; total += r.step; }
    expect(total).toBe(-1);
    expect(res).toBeCloseTo(-0.2, 8);
  });
});

describe("formatDriftPanel（修复原缺陷：只注入 bigFive）", () => {
  it("覆盖全部层级，且每条路径都能被 getParamValue 解析", () => {
    const p = defaultPersonaParams();
    p.cognitiveBiases = [{ id: "confirmation", label: "确认偏误", strength: 70 }];
    p.defenseMechanisms = [{ id: "humor", label: "幽默", tendency: 80, maturity: "mature" }];
    const panel = formatDriftPanel(p);
    const paths = panel.split("，").map((x) => x.split("=")[0]!);
    for (const prefix of ["bigFive.", "attachment.", "darkTetrad.", "emotionRegulation.", "sdt.", "cognitiveBiases.", "defenseMechanisms."]) {
      expect(paths.some((x) => x.startsWith(prefix))).toBe(true);
    }
    for (const path0 of paths) expect(getParamValue(p, path0)).not.toBeNull();
  });
});
