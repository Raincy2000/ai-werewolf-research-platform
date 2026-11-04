import { describe, expect, it } from "vitest";
import {
  RSQ_ITEMS,
  RSQ_ITEMS_VERSION,
  RSQ_ITEM_MAP,
  RSQ_BATTERY_ITEM_NOS,
  pickBatteryLevel,
  computeDimensions,
  computeDerived,
  scoreRSQ,
  renderQuestionnaire,
} from "./rsq";

/** 构造一份"全部 4 分"的答卷 */
function neutralAnswers(): Record<number, number> {
  const raw: Record<number, number> = {};
  for (const it of RSQ_ITEMS) {
    if (it.scale === "open") continue;
    raw[it.no] = 4;
  }
  return raw;
}

/** 覆盖指定题号为指定分数 */
function withScores(base: Record<number, number>, patch: Record<number, number>): Record<number, number> {
  return { ...base, ...patch };
}

describe("RSQ 题库结构", () => {
  it("题号 1–120 连续无缺、无重复", () => {
    const nos = RSQ_ITEMS.map((i) => i.no);
    expect(nos.length).toBe(120);
    expect(new Set(nos).size).toBe(120);
    for (let i = 1; i <= 120; i++) expect(nos).toContain(i);
  });

  it("每题都有 module 与 text", () => {
    for (const it of RSQ_ITEMS) {
      expect(it.module.length).toBeGreaterThan(0);
      expect(it.text.length).toBeGreaterThan(2);
    }
  });

  it("反题必须带 pairWith，且配对题存在", () => {
    for (const it of RSQ_ITEMS) {
      if (!it.reverse) continue;
      expect(it.pairWith).toBeDefined();
      expect(RSQ_ITEM_MAP.has(it.pairWith!)).toBe(true);
      // 配对题不应也是反题
      expect(RSQ_ITEM_MAP.get(it.pairWith!)!.reverse).toBeFalsy();
    }
  });

  it("效度题 13 道、暗黑题 6 道", () => {
    expect(RSQ_ITEMS.filter((i) => i.validity).length).toBe(13);
    expect(RSQ_ITEMS.filter((i) => i.dark).length).toBe(6);
  });

  it("开放题只有 110 / 111 / 120", () => {
    const opens = RSQ_ITEMS.filter((i) => i.scale === "open").map((i) => i.no);
    expect(opens).toEqual([110, 111, 120]);
  });

  it("电池分级：L 全量 120、M 79、S 18", () => {
    expect(RSQ_BATTERY_ITEM_NOS.L.length).toBe(120);
    expect(RSQ_BATTERY_ITEM_NOS.M.length).toBe(79);
    expect(RSQ_BATTERY_ITEM_NOS.S.length).toBe(18);
  });

  it("pickBatteryLevel 按出现次数与累计变化判定", () => {
    expect(pickBatteryLevel(5, 60)).toBe("L");
    expect(pickBatteryLevel(3, 10)).toBe("M");
    expect(pickBatteryLevel(2, 0)).toBe("M");
    expect(pickBatteryLevel(1, 0)).toBe("S");
  });
});

describe("RSQ 计分", () => {
  it("全 4 分（量表中点）→ 所有维度约 50", () => {
    // 注：反题也是 4 分，翻转后仍是 4，故全部落在中点
    const d = computeDimensions(neutralAnswers());
    expect(d.affection).toBe(50);
    expect(d.conflict).toBe(50);
    expect(d.closeness).toBe(50);
  });

  it("反题 7 分等价于正题 1 分", () => {
    // 题 1（正）1 分 + 题 2（反）7 分 → 两个都应映射为 0
    const raw = withScores(neutralAnswers(), { 1: 1, 2: 7 });
    const d = computeDimensions(raw);
    expect(d.companionship).toBe(0);
  });

  it("正题 7 分 + 反题 1 分 → 100", () => {
    const raw = withScores(neutralAnswers(), { 1: 7, 2: 1 });
    const d = computeDimensions(raw);
    expect(d.companionship).toBe(100);
  });

  it("单题维度按 1→0、7→100 映射", () => {
    const raw1 = withScores(neutralAnswers(), { 74: 1 });
    expect(computeDimensions(raw1).closeness).toBe(0);
    const raw7 = withScores(neutralAnswers(), { 74: 7 });
    expect(computeDimensions(raw7).closeness).toBe(100);
  });

  it("宽恕是组合指标：善意高 + 回避低 + 报复低 → 高宽恕", () => {
    const raw = withScores(neutralAnswers(), {
      116: 7, // 整体不再计较（benevolence）
      119: 7, // 愿意重新给机会（benevolence）
      117: 1, // 很少想起对方的错（avoidance，负向）
      118: 1, // 不希望对方向尝同样的滋味（revenge，负向）
    });
    const d = computeDimensions(raw);
    expect(d.forgiveness).toBeGreaterThan(90);
  });

  it("派生指标：又爱又恨 → ambivalence 高", () => {
    const raw = withScores(neutralAnswers(), {
      19: 7, 20: 1, // 喜爱高
      7: 7, 8: 1,   // 对抗高
    });
    const d = computeDimensions(raw);
    const der = computeDerived(d);
    expect(d.affection).toBeGreaterThan(80);
    expect(d.antagonism).toBeGreaterThan(80);
    expect(der.ambivalence).toBeGreaterThan(80);
  });

  it("派生指标：高好感 + 低宽恕 → forgiveGap 大", () => {
    const raw = withScores(neutralAnswers(), {
      19: 7, 20: 1,     // 好感高
      116: 1, 119: 1,   // 不愿原谅
      117: 7, 118: 7,   // 常想、想报复
    });
    const d = computeDimensions(raw);
    const der = computeDerived(d);
    expect(der.forgiveGap).toBeGreaterThan(60);
  });
});

describe("RSQ 效度检测", () => {
  it("空答卷 / 中性答卷：一致性满分", () => {
    const r = scoreRSQ(neutralAnswers());
    expect(r.validity.consistency).toBe(1);
  });

  it("正反题互相矛盾 → 一致性大幅下降", () => {
    // 让**所有**反题与其正题都给 7 分（反题未翻转 = 完全矛盾）
    const raw = neutralAnswers();
    for (const it of RSQ_ITEMS) {
      if (!it.reverse || it.pairWith == null) continue;
      raw[it.pairWith] = 7;
      raw[it.no] = 7;
    }
    const r = scoreRSQ(raw);
    expect(r.validity.consistency).toBeLessThan(0.2);
  });

  it("部分反题矛盾 → 一致性小幅下降", () => {
    const raw = withScores(neutralAnswers(), { 1: 7, 2: 7, 3: 7, 4: 7, 5: 7, 6: 7 });
    const r = scoreRSQ(raw);
    expect(r.validity.consistency).toBeLessThan(0.95);
    expect(r.validity.consistency).toBeGreaterThan(0.8);
  });

  it("印象管理题全部 7 分 → 社会赞许性高", () => {
    const raw = withScores(neutralAnswers(), {
      88: 7, 89: 7, 90: 7, 91: 7, 92: 7,
      93: 7, 94: 7, 95: 7, 96: 7, 97: 7,
    });
    const r = scoreRSQ(raw);
    expect(r.validity.socialDesirability).toBeGreaterThan(0.6);
  });

  it("夜神月型：暗黑高 + 印象管理高 → polished-deceiver", () => {
    const raw = withScores(neutralAnswers(), {
      // 印象管理满分（装圣人）
      88: 7, 89: 7, 90: 7, 91: 7, 92: 7,
      // 暗黑也满分（露馅）
      98: 7, 99: 7, 100: 7, 101: 7, 102: 7, 103: 7,
    });
    const r = scoreRSQ(raw);
    expect(r.validity.darkTriad).toBeGreaterThan(70);
    expect(r.validity.flags).toContain("dark-desirability-conflict");
    expect(r.validity.flags).toContain("polished-deceiver");
  });

  it("跨源偏离 G 高 → overall 显著下降", () => {
    const base = neutralAnswers();
    const r0 = scoreRSQ(base, { behavioralGap: 0 });
    const r1 = scoreRSQ(base, { behavioralGap: 0.8 });
    expect(r1.validity.overall).toBeLessThan(r0.validity.overall);
    expect(r0.validity.overall - r1.validity.overall).toBeGreaterThan(0.1);
  });

  it("verdict 分级正确", () => {
    const good = scoreRSQ(neutralAnswers());
    expect(good.validity.verdict).toBe("reliable");

    // 全套作弊：矛盾 + 印象管理 + 谎言论 + 跨源偏离
    const bad = scoreRSQ(
      withScores(neutralAnswers(), {
        1: 7, 2: 7, 3: 7, 4: 7, 5: 7, 6: 7, 7: 7, 8: 7,
        88: 7, 89: 7, 90: 7, 91: 7, 92: 7,
        104: 7, 105: 7, 106: 7,
      }),
      { behavioralGap: 0.9 },
    );
    expect(["questionable", "likely-deceptive"]).toContain(bad.validity.verdict);
  });

  it("整数极端作答 → extreme-response 标记", () => {
    const raw: Record<number, number> = {};
    for (const it of RSQ_ITEMS) if (it.scale !== "open") raw[it.no] = 7;
    const r = scoreRSQ(raw);
    expect(r.validity.flags).toContain("extreme-response");
  });

  it("答题直列 → straight-lining 标记", () => {
    const raw: Record<number, number> = {};
    for (const it of RSQ_ITEMS) if (it.scale !== "open") raw[it.no] = 4;
    const r = scoreRSQ(raw);
    expect(r.validity.flags).toContain("straight-lining");
  });
});

describe("RSQ 问卷渲染", () => {
  it("生成前言与题项", () => {
    const q = renderQuestionnaire({ targetName: "三笠·阿克曼" });
    expect(q.preface).toContain("私密");
    expect(q.preface).toContain("三笠·阿克曼");
    expect(q.preface).toContain("保密");
    expect(q.items.length).toBe(120);
  });

  it("可只出指定题号", () => {
    const q = renderQuestionnaire({ targetName: "A", itemNos: RSQ_BATTERY_ITEM_NOS.S });
    expect(q.items.length).toBe(18);
  });

  it("洗牌后仍是同一集合，且配对题间隔 >= 10", () => {
    const q = renderQuestionnaire({ targetName: "A", shuffle: true, seed: 7 });
    const nos = q.items.map((i) => i.no);
    expect(nos.length).toBe(120);
    expect(new Set(nos).size).toBe(120);

    const pos = new Map(nos.map((no, i) => [no, i]));
    for (const it of RSQ_ITEMS) {
      if (it.pairWith == null) continue;
      const a = pos.get(it.no);
      const b = pos.get(it.pairWith);
      if (a == null || b == null) continue;
      expect(Math.abs(a - b)).toBeGreaterThanOrEqual(10);
    }
  });

  it("同 seed 洗牌结果一致（可复现）", () => {
    const a = renderQuestionnaire({ targetName: "A", shuffle: true, seed: 99 });
    const b = renderQuestionnaire({ targetName: "A", shuffle: true, seed: 99 });
    expect(a.items.map((i) => i.no)).toEqual(b.items.map((i) => i.no));
  });

  it("题库版本号存在", () => {
    expect(RSQ_ITEMS_VERSION).toMatch(/^rsq-/);
  });
});
