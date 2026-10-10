// ============================================================
// 记事簿回写解析 + 铸魂师草稿清洗 + 参数路径读写（铁律1/3）
// ============================================================

import { describe, expect, it } from "vitest";
import {
  defaultPersonaParams,
  getParamValue,
  setParamValue,
} from "../../contracts/persona";
import { parseWriteback, normalizeRelationAnchor, normalizeMemoryContent, buildWritebackPrompt } from "./notebook";
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
  // 名册含座位与可知性（known）：五条悟=3号、夏油杰=4号、夜神月=9号（均人格可知）
  const others = [
    { seat: 3, name: "五条悟", personaId: 11 },
    { seat: 4, name: "夏油杰", personaId: 12 },
    { seat: 9, name: "夜神月", personaId: 13 },
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
      seatRoster: [{ seat: 3, name: "五条悟", personaId: 11, known: true }],
    });
    expect(user).toContain("20261010001·10号玩家"); // 无人格锚点示例
    expect(user).toContain("精确等于 TA 的人格名"); // 人格锚点规则
  });
});

describe("迷雾双轨：座位代号的归属由人格可知性决定", () => {
  const roster = [
    { seat: 3, name: "五条悟", personaId: 11 },
    { seat: 9, name: "夜神月", personaId: 13 },
  ];
  const titleNo = "20261010001";

  it("人格可知座位的裸代号 → 归一到人格名（根治执念绑座位号事故）", () => {
    // 艾伦对 9 号（夜神月）的敌意：锚点必须是「夜神月」，不是「9号玩家」
    expect(normalizeRelationAnchor("9号玩家", roster, titleNo)).toEqual({
      targetName: "夜神月",
      targetPersonaId: 13,
    });
  });

  it("人格可知座位被误贴标题号前缀 → 仍归一到人格名", () => {
    expect(normalizeRelationAnchor("20261010001·9号玩家", roster, titleNo)).toEqual({
      targetName: "夜神月",
      targetPersonaId: 13,
    });
  });

  it("迷雾中的座位（不在可知名册）→ 保持标题号·代号锚点", () => {
    // 同一局里被上迷雾的人格玩家：观察者不知道 TA 是谁，锚点必须带对局编号
    expect(normalizeRelationAnchor("5号玩家", roster, titleNo)).toEqual({
      targetName: "20261010001·5号玩家",
      targetPersonaId: null,
    });
    // 历史对局里已带标题号的迷雾代号：原样保留（不追贴、不归并）
    expect(normalizeRelationAnchor("20260930001·5号玩家", roster, titleNo)).toEqual({
      targetName: "20260930001·5号玩家",
      targetPersonaId: null,
    });
  });
});

describe("normalizeMemoryContent（记忆内容的座位引用归一）", () => {
  const roster = [
    { seat: 3, name: "五条悟" },
    { seat: 9, name: "夜神月" },
    { seat: 11, name: "艾伦" },
  ];

  it("可知人格的「N号玩家」「N号」引用改写为人格名", () => {
    expect(normalizeMemoryContent("9号玩家当众把我票出去，我记住他了", roster)).toBe(
      "夜神月当众把我票出去，我记住他了",
    );
    expect(normalizeMemoryContent("我信了9号一整局", roster)).toBe("我信了夜神月一整局");
  });

  it("多位座位降序替换，两位数座位不被一位数误伤", () => {
    expect(normalizeMemoryContent("11号和1号联手，3号看穿了他们", roster)).toBe(
      "艾伦和1号联手，五条悟看穿了他们",
    );
  });

  it("无人格/迷雾座位的引用原样保留", () => {
    expect(normalizeMemoryContent("7号玩家发言很可疑", roster)).toBe("7号玩家发言很可疑");
  });
});

describe("铁律0「第一人称本体」（人格即本人，绝不自称其名）", () => {
  const roster = [
    { seat: 3, name: "五条悟" },
    { seat: 9, name: "夜神月" },
  ];

  it("观察者自己的座位引用保持原样（excludeSeat）", () => {
    // 我是 3 号（五条悟）：我的座位号不换成我的名字——「我作为3号猎人」是局内事实
    expect(normalizeMemoryContent("我作为3号猎人被放逐，9号玩家笑的最开心", roster, 3)).toBe(
      "我作为3号猎人被放逐，夜神月笑的最开心",
    );
  });

  it("原文已是「9号夜神月」形态：替换后叠词收拢为一次", () => {
    expect(normalizeMemoryContent("最后带走了9号夜神月", roster)).toBe("最后带走了夜神月");
  });
});

describe("粘连收敛（原文已含人格名片段）", () => {
  it("「9号夜神月」→「夜神月」；「1号艾伦」→「艾伦·耶格尔」（全名+短名粘连）", () => {
    const roster = [
      { seat: 9, name: "夜神月" },
      { seat: 1, name: "艾伦·耶格尔" },
    ];
    expect(normalizeMemoryContent("最后带走9号夜神月", roster)).toBe("最后带走夜神月");
    expect(normalizeMemoryContent("1号艾伦自爆跳预言家", roster)).toBe("艾伦·耶格尔自爆跳预言家");
  });
});
