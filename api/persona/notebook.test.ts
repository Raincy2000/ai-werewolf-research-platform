// ============================================================
// 记事簿回写解析 + 铸魂师草稿清洗 + 参数路径读写（铁律1/3）
// ============================================================

import { describe, expect, it } from "vitest";
import {
  defaultPersonaParams,
  getParamValue,
  setParamValue,
} from "../../contracts/persona";
import { parseWriteback } from "./notebook";
import { sanitizeCastedDraft } from "./caster";

describe("parseWriteback（记忆回写清洗与钳位）", () => {
  it("合法输出解析；权重/增量/漂移幅度全部钳位", () => {
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
