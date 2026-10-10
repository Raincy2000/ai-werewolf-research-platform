// ============================================================
// 记事簿回写解析 + 铸魂师草稿清洗 + 参数路径读写（铁律1/3）
// ============================================================

import { describe, expect, it } from "vitest";
import {
  defaultPersonaParams,
  getParamValue,
  setParamValue,
} from "../../contracts/persona";
import { parseWriteback, normalizeRelationAnchor, buildWritebackPrompt } from "./notebook";
import { sanitizeCastedDraft } from "./caster";

describe("parseWriteback（记忆回写清洗与钳位）", () => {  it("合法输出解析；权重/增量/漂移幅度全部钳位", () => {
    const r = parseWriteback(`{"memories":[
        {"type":"trauma","content":"第3天被5号当众票出，我记住了他。","emotionalWeight":130,"reinforceMemoryId":7},
        {"type":"weird","content":"平安夜大家都挺客气。","emotionalWeight":20}
      ],"relationships":[{"targetName":"刘备","relation":"宿怨","affinityDelta":-999,"trustDelta":-30,"note":"被他骗了"}],
      "drift":[{"path":"attachment.anxiety","delta":25,"reason":"反复被背叛"},{"path":"","delta":5,"reason":"无效"}]}`)!;
    expect(r.memories.length).toBe(2);
    expect(r.memories[0]!.emotionalWeight).toBe(100); // 钳位
    expect(r.memories[0]!.reinforceMemoryId).toBe(7);
    expect(r.memories[1]!.type).toBe("general"); // 非法类型归一
    expect(r.relationships[0]!.affinityDelta).toBe(-100); // 钳位
    expect(r.drift.length).toBe(1);
    expect(r.drift[0]!.delta).toBe(12); // 单局漂移上限
  });

  it("空数组合法；垃圾输入返回 null", () => {
    const r = parseWriteback('{"memories":[],"relationships":[],"drift":[]}')!;
    expect(r.memories).toEqual([]);
    expect(parseWriteback("完全不是 JSON")).toBeNull();
  });
});

describe("sanitizeCastedDraft（铸魂师草稿清洗）", () => {
  it("越界钳位/非法条目过滤/语录上限/成熟度回退", () => {
    const draft = sanitizeCastedDraft(
      {
        name: " 曹操 ",
        params: {
          bigFive: { openness: 130, conscientiousness: -5, extraversion: "abc", agreeableness: 25.6, neuroticism: 85 },
          attachment: { anxiety: 75, avoidance: 60 },
          darkTetrad: { machiavellianism: 90, narcissism: 70, psychopathy: 40, sadism: 30 },
          cognitiveBiases: [
            { id: "confirmation", label: "确认偏误", strength: 80 },
            { label: "" }, // 无标签：过滤
          ],
          defenseMechanisms: [{ id: "x", label: "情感隔离", tendency: 70, maturity: "evil" }],
          emotionRegulation: { cognitiveReappraisal: 40, expressiveSuppression: 80, rumination: 65 },
          sdt: { autonomy: 90, competence: 85, relatedness: 30 },
        },
        profile: { summary: "权臣。", quotes: ["a", "b", "c", "d", "e", "f"] },
        inferred: ["bigFive.openness"],
      },
      "默认名",
    );
    expect(draft.name).toBe("曹操");
    expect(draft.params.bigFive.openness).toBe(100);
    expect(draft.params.bigFive.conscientiousness).toBe(0);
    expect(draft.params.bigFive.extraversion).toBe(50); // 非数字回退默认
    expect(draft.params.bigFive.agreeableness).toBe(26); // 四舍五入
    expect(draft.params.cognitiveBiases.length).toBe(1);
    expect(draft.params.defenseMechanisms[0]!.maturity).toBe("neurotic");
    expect(draft.profile.quotes.length).toBe(5);
    expect(draft.params.inferred).toEqual(["bigFive.openness"]);
  });

  it("空输出用兜底名", () => {
    const draft = sanitizeCastedDraft({}, "曹操");
    expect(draft.name).toBe("曹操");
  });
});

describe("setParamValue / getParamValue（漂移读写）", () => {
  it("固定维度/集合条目写入 + 钳位 + 非法路径无操作", () => {
    let p = defaultPersonaParams();
    p = setParamValue(p, "bigFive.neuroticism", 88);
    expect(getParamValue(p, "bigFive.neuroticism")).toBe(88);
    p = setParamValue(p, "bigFive.neuroticism", 120);
    expect(getParamValue(p, "bigFive.neuroticism")).toBe(100);
    p = setParamValue(p, "cognitiveBiases.确认偏误", 66);
    expect(getParamValue(p, "cognitiveBiases.确认偏误")).toBe(66);
    p = setParamValue(p, "defenseMechanisms.合理化", 70);
    expect(getParamValue(p, "defenseMechanisms.合理化")).toBe(70);
    const before = JSON.stringify(p);
    p = setParamValue(p, "nonsense.path", 10);
    expect(JSON.stringify(p)).toBe(before); // 非法路径不变
    expect(getParamValue(p, "nonsense.path")).toBeNull();
  });
});

describe("normalizeRelationAnchor（关系锚点双轨制）", () => {
  const others = [
    { name: "五条悟", personaId: 11 },
    { name: "夏油杰", personaId: 12 },
  ];
  const titleNo = "20261010001";

  it("人格玩家对象：锚点=人格名本身（不带座位号，跨局存续）", () => {
    const r = normalizeRelationAnchor("五条悟", others, titleNo);
    expect(r).toEqual({ targetName: "五条悟", targetPersonaId: 11 });
  });

  it("模型误带包裹/座位号描述时仍能匹配人格：锚点归一为人格名", () => {
    expect(normalizeRelationAnchor("「夏油杰」", others, titleNo)).toEqual({
      targetName: "夏油杰",
      targetPersonaId: 12,
    });
    // 误贴标题号前缀的人格名：剥前缀后命中人格
    expect(normalizeRelationAnchor("20261010001·五条悟", others, titleNo)).toEqual({
      targetName: "五条悟",
      targetPersonaId: 11,
    });
  });

  it("代号+人格名混合形态（「3号玩家（五条悟）」）：恰好提到一个人格名即归一到人格锚点", () => {
    expect(normalizeRelationAnchor("3号玩家（五条悟）", others, titleNo)).toEqual({
      targetName: "五条悟",
      targetPersonaId: 11,
    });
    // 提到多个人格名：无法确定锚点，原样保留
    expect(normalizeRelationAnchor("五条悟和夏油杰", others, titleNo)).toEqual({
      targetName: "五条悟和夏油杰",
      targetPersonaId: null,
    });
  });

  it("无人格玩家对象：裸代号自动补齐对局标题号前缀（跨局不碰撞）", () => {
    const r = normalizeRelationAnchor("10号玩家", others, titleNo);
    expect(r).toEqual({ targetName: "20261010001·10号玩家", targetPersonaId: null });
  });

  it("已带标题号的无人格代号不重复加前缀", () => {
    const r = normalizeRelationAnchor("20261009001·3号玩家", others, titleNo);
    expect(r).toEqual({ targetName: "20261009001·3号玩家", targetPersonaId: null });
  });

  it("既非人格也非座位代号的自由文本：原样保留", () => {
    const r = normalizeRelationAnchor("全体好人", others, titleNo);
    expect(r).toEqual({ targetName: "全体好人", targetPersonaId: null });
  });
});

describe("buildWritebackPrompt（关系锚点双轨写进契约）", () => {
  it("prompt 明确双轨规则：人格名锚点 / 标题号·代号锚点", () => {
    const card = {
      id: 1,
      name: "测试人格",
      params: {
        bigFive: { openness: 50, conscientiousness: 50, extraversion: 50, agreeableness: 50, neuroticism: 50 },
        attachment: { anxiety: 50, avoidance: 50 },
        darkTetrad: { machiavellianism: 50, narcissism: 50, psychopathy: 50, sadism: 50 },
        cognitiveBiases: [],
        defenseMechanisms: [],
        emotionRegulation: { cognitiveReappraisal: 50, expressiveSuppression: 50, rumination: 50 },
        sdt: { autonomy: 50, competence: 50, relatedness: 50 },
        inferred: [],
      },
      profile: { quotes: [] },
    } as unknown as Parameters<typeof buildWritebackPrompt>[0]["card"];
    const { user } = buildWritebackPrompt({
      card,
      seat: 3,
      roleName: "平民",
      outcome: "神民阵营胜利",
      gameTitleNo: "20261010001",
      digest: "摘要",
      memories: [],
      relationships: [],
      otherPersonas: ["五条悟"],
    });
    expect(user).toContain("20261010001·10号玩家"); // 无人格锚点示例
    expect(user).toContain("精确等于 TA 的人格名"); // 人格锚点规则
  });
});
