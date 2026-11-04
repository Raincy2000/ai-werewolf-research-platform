// ============================================================
// 记事簿回写解析 + 铸魂师草稿清洗 + 参数路径读写（铁律1/3）
// ============================================================

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultPersonaParams,
  getParamValue,
  setParamValue,
  type PersonaCard,
} from "../../contracts/persona";
import type { SeatAiConfig } from "../../contracts/game";
import { callAi } from "../game/ai/providers";
import * as personaQueries from "../queries/personas";
import { getDb } from "../queries/connection";
import { applyRelationDelta } from "../network/writeModel";
import { parseWriteback, normalizeRelationAnchor, normalizeMemoryContent, buildWritebackPrompt, runNotebookWriteback } from "./notebook";

vi.mock("../game/ai/providers", () => ({ callAi: vi.fn() }));
vi.mock("../network/writeModel", () => ({ applyRelationDelta: vi.fn() }));
vi.mock("../queries/connection", () => ({ getDb: vi.fn() }));
vi.mock("../queries/personas", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../queries/personas")>();
  return {
    ...actual,
    beginPersonaWriteback: vi.fn(),
    finishPersonaWriteback: vi.fn(),
    insertPersonaMemories: vi.fn(),
    reinforcePersonaMemories: vi.fn(),
    decayPersonaMemories: vi.fn(),
    applyPersonaDrift: vi.fn(),
    saveParamsResidual: vi.fn(),
    insertStateObservations: vi.fn(),
    countSameDirectionObservations: vi.fn(),
    insertTraitUpdates: vi.fn(),
    upsertPersonaRelationship: vi.fn(),
    insertPersonaRelationshipHistory: vi.fn(),
    hasPersonaRelationshipHistory: vi.fn(),
  };
});
import { sanitizeCastedDraft } from "./caster";

describe("parseWriteback（记忆回写清洗与钳位）", () => {
  it("合法输出解析；权重/效价/增量/漂移幅度全部按分层钳位", () => {
    const r = parseWriteback(`{"memories":[
        {"type":"trauma","content":"第3天被5号当众票出，我记住了他。","emotionalWeight":130,"valence":-140,"reinforceMemoryId":7},
        {"type":"weird","content":"平安夜大家都挺客气。","emotionalWeight":20}
      ],"relationships":[{"targetName":"刘备","relation":"宿怨","affinityDelta":-999,"trustDelta":-30,"note":"被他骗了"}],
      "drift":[{"path":"attachment.anxiety","delta":25,"reason":"反复被背叛"},{"path":"","delta":5,"reason":"无效"}]}`)!;
    expect(r.memories.length).toBe(2);
    expect(r.memories[0]!.emotionalWeight).toBe(100); // 唤醒度钳位
    expect(r.memories[0]!.valence).toBe(-100); // 效价钳位（Russell 1980 情绪二维）
    expect(r.memories[0]!.reinforceMemoryId).toBe(7);
    expect(r.memories[1]!.type).toBe("general"); // 非法类型归一
    expect(r.memories[1]!.valence).toBe(0); // 缺省效价
    expect(r.relationships[0]!.affinityDelta).toBe(-100); // 钳位
    expect(r.drift.length).toBe(1);
    // 分层漂移上限（v3 收紧）：依恋层 ±0.5（Fraley et al. 2011：依恋较大五更稳定）
    expect(r.drift[0]!.delta).toBe(0.5);
    expect(r.drift[0]!.path).toBe("attachment.anxiety");
  });

  it("分层漂移上限（v3）：特质层 ±1、适应层 ±2、状态层 ±4", () => {
    const r = parseWriteback(JSON.stringify({
      memories: [],
      relationships: [],
      drift: [
        { path: "bigFive.neuroticism", delta: 99, reason: "x" },
        { path: "sdt.competence", delta: 99, reason: "y" },
        { path: "defenseMechanisms.humor", delta: 99, reason: "z" },
      ],
    }))!;
    const byPath = Object.fromEntries(r.drift.map((d) => [d.path, Math.abs(d.delta)]));
    expect(byPath["bigFive.neuroticism"]).toBe(1); // v3 特质层 ±1
    expect(byPath["sdt.competence"]).toBe(2); // v3 适应层 ±2
    expect(byPath["defenseMechanisms.humor"]).toBe(4); // v3 状态层 ±4
  });

  it("单局漂移预算：Σ|delta| 超预算等比缩放（保号）", () => {
    const r = parseWriteback(JSON.stringify({
      memories: [],
      relationships: [],
      drift: [
        { path: "emotionRegulation.rumination", delta: 99, reason: "a" },
        { path: "defenseMechanisms.humor", delta: 99, reason: "b" },
        { path: "cognitiveBiases.confirmation", delta: 99, reason: "c" },
      ],
    }))!;
    const total = r.drift.reduce((s, d) => s + Math.abs(d.delta), 0);
    expect(total).toBeLessThanOrEqual(12);      // 预算生效
    expect(r.drift.every((d) => d.delta > 0)).toBe(true); // 保号
  });

  it("高光记忆类型 triumph 合法且带正效价（创伤后成长通道）", () => {
    const r = parseWriteback('{"memories":[{"type":"triumph","content":"我识破了悍跳","emotionalWeight":80,"valence":90}],"relationships":[],"drift":[]}')!;
    expect(r.memories[0]!.type).toBe("triumph");
    expect(r.memories[0]!.valence).toBe(90);
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

  it("漂移参考面板注入全部层级 + PTG 双通道（修复：原来只注入 bigFive）", () => {
    const card = {
      id: 1,
      name: "测试人格",
      params: {
        bigFive: { openness: 50, conscientiousness: 50, extraversion: 50, agreeableness: 16, neuroticism: 96 },
        attachment: { anxiety: 50, avoidance: 50 },
        darkTetrad: { machiavellianism: 50, narcissism: 50, psychopathy: 50, sadism: 50 },
        cognitiveBiases: [{ id: "confirmation", label: "确认偏误", strength: 70 }],
        defenseMechanisms: [{ id: "humor", label: "幽默", tendency: 80, maturity: "mature" }],
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
      seatRoster: [],
    });
    // 根因 R1 回归：全部层级都必须在面板里（否则 LLM 只能在大五内漂移）
    for (const prefix of ["bigFive.", "attachment.", "darkTetrad.", "emotionRegulation.", "sdt."]) {
      expect(user).toContain(prefix);
    }
    expect(user).toContain("cognitiveBiases.confirmation=");   // 数组型参数必须用 group.<id>
    expect(user).toContain("defenseMechanisms.humor=");
    expect(user).toContain("bigFive.neuroticism=96");           // 携带当前值
    // 根因 R3/R4 回归：PTG 双通道 + 情绪二维 + 分层幅度
    expect(user).toContain("创伤后成长");
    expect(user).toContain("valence");
    expect(user).toContain("大五 ±2");
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

describe("runNotebookWriteback（赛后关系写入停用）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockReturnValue({
      select: () => ({
        from: () => ({
          where: () => ({ orderBy: async () => [] }),
        }),
      }),
    } as never);
    vi.mocked(personaQueries.beginPersonaWriteback).mockResolvedValue(true);
    vi.mocked(personaQueries.insertPersonaMemories).mockResolvedValue([101]);
    vi.mocked(personaQueries.insertStateObservations).mockResolvedValue([201]);
    vi.mocked(personaQueries.countSameDirectionObservations).mockResolvedValue(0);
    vi.mocked(personaQueries.upsertPersonaRelationship).mockResolvedValue({ affinity: 40, trust: 45 } as never);
    vi.mocked(personaQueries.hasPersonaRelationshipHistory).mockResolvedValue(false);
    vi.mocked(callAi).mockResolvedValue({
      ok: true,
      text: JSON.stringify({
        memories: [{ type: "trauma", content: "五条悟骗了我", emotionalWeight: 80, valence: -60, reinforceMemoryId: null }],
        relationships: [{ targetName: "五条悟", relation: "宿敌", affinityDelta: -10, trustDelta: -5, note: "被他骗了" }],
        drift: [{ path: "bigFive.neuroticism", delta: 1, reason: "被背叛" }],
      }),
    } as never);
  });

  it("保留记忆与漂移写入，但不写新旧关系存储", async () => {
    const card = {
      id: 1,
      name: "测试人格",
      params: defaultPersonaParams(),
      paramsResidual: { "bigFive.neuroticism": 1 },
      gameCount: 1,
    } as unknown as PersonaCard;
    const summary = await runNotebookWriteback({
      cfg: {} as SeatAiConfig,
      card,
      seat: 1,
      roleName: "平民",
      outcome: "神民阵营胜利",
      gameTitleNo: "20261010001",
      digest: "摘要",
      gameId: "game-1",
      otherPersonas: [{ seat: 2, name: "五条悟", personaId: 11, known: true }],
    });

    expect(personaQueries.insertPersonaMemories).toHaveBeenCalled();
    expect(personaQueries.applyPersonaDrift).toHaveBeenCalled();
    expect(applyRelationDelta).not.toHaveBeenCalled();
    expect(personaQueries.upsertPersonaRelationship).not.toHaveBeenCalled();
    expect(personaQueries.insertPersonaRelationshipHistory).not.toHaveBeenCalled();
    expect(summary?.relationshipsTouched).toBe(0);
  });
});
