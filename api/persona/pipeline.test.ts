// ============================================================
// 心镜/涌现管线单元测试（铁律2 参数溢出、铁律6 撕裂、双/单程自适应）
// ============================================================

import { describe, expect, it } from "vitest";
import type { PendingDecision } from "../game/engine/api";
import type { PersonaCard } from "../../contracts/persona";
import { defaultPersonaParams, emptyPersonaProfile } from "../../contracts/persona";
import { buildPrompt, modelContextTokens } from "../game/ai/prompts";
import {
  buildEmergencePrompt,
  buildMirrorPrompt,
  buildSinglePrompt,
  formatTensionTemplate,
  emptyMirrorReport,
  paramLabel,
  paramValueOf,
  parseMirrorReport,
  shouldUseDualPipeline,
} from "./pipeline";

// ---------- 夹具 ----------
export function makeCard(over?: Partial<PersonaCard>): PersonaCard {
  return {
    id: 1,
    name: "曹操",
    source: "ai-cast",
    originName: "曹操",
    originSource: "《三国演义》",
    profile: { ...emptyPersonaProfile(), persona: "多疑善谋，宁负天下人。", quotes: ["宁教我负天下人"] },
    params: {
      ...defaultPersonaParams(),
      bigFive: { openness: 70, conscientiousness: 80, extraversion: 75, agreeableness: 25, neuroticism: 85 },
      darkTetrad: { machiavellianism: 90, narcissism: 70, psychopathy: 40, sadism: 30 },
      attachment: { anxiety: 75, avoidance: 60 },
    },
    notes: "",
    imageData: null,
    gameCount: 3,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  };
}

export function makePending(kind: PendingDecision["kind"] = "daySpeech"): PendingDecision {
  return {
    seat: 3,
    role: "villager",
    kind,
    options: [1, 2, 4, 5],
    allowSkip: false,
    hint: "请发表白天发言",
    view: {
      seat: 3,
      role: "villager",
      roleName: "平民",
      camp: "villager",
      day: 2,
      phase: "day.speech",
      aliveSeats: [1, 2, 3, 4, 5],
      deadSeats: [6],
      revealedRoles: {},
      sheriffSeat: 1,
      selfAlive: true,
      rules: { witchSelfSave: "never" },
      publicLog: ["1号玩家发言：我觉得2号有问题", "6号玩家被放逐出局"],
      private: {},
    },
  };
}

describe("parseMirrorReport（铁律2：无触发参数判非法）", () => {
  it("合法报告解析成功（含强度 0-100 → 0-1 归一）", () => {
    const text = `{"pressures":[{"param":"bigFive.neuroticism","value":85,"reason":"被2号当众质疑"}],
      "tensions":[{"poles":[{"param":"bigFive.agreeableness","urge":"想维持和气"},{"param":"darkTetrad.machiavellianism","urge":"想借刀杀人"}],"intensity":75}],
      "defenses":[{"mechanism":"合理化","toward":"自己的多疑"}],"trauma":null,"impulse":"先稳住2号","selfControl":40}`;
    const r = parseMirrorReport(text)!;
    expect(r.pressures[0]!.param).toBe("bigFive.neuroticism");
    expect(r.tensions[0]!.intensity).toBe(0.75);
    expect(r.selfControl).toBe(40);
  });

  it("平静、无撕裂和无创伤均为合法空反应，只有结构非法才拒绝", () => {
    const empty = parseMirrorReport('{"pressures":[],"tensions":[],"defenses":[],"trauma":null,"impulse":"","currentReaction":"","selfControl":50}');
    expect(empty).not.toBeNull();
    expect(empty!.pressures).toEqual([]);
    expect(empty!.tensions).toEqual([]);
    expect(empty!.currentReaction).toBe("");
    expect(parseMirrorReport("不是 JSON")).toBeNull();
    expect(parseMirrorReport('{"pressures":[{"param":"","reason":"x"}]}')).toBeNull();
  });

  it("单极撕裂被丢弃（撕裂必须 ≥2 极同时拉扯）", () => {
    const r = parseMirrorReport(
      '{"tensions":[{"poles":[{"param":"a","urge":"x"}],"intensity":0.9}],"pressures":[{"param":"p","value":1,"reason":"r"}]}',
    )!;
    expect(r.tensions.length).toBe(0);
    expect(r.pressures.length).toBe(1);
  });
});

function mirrorWithTensions() {
  return parseMirrorReport(`{"pressures":[{"param":"bigFive.neuroticism","value":85,"reason":"被质疑"}],
    "tensions":[{"poles":[{"param":"bigFive.agreeableness","urge":"想维持和气"},{"param":"darkTetrad.machiavellianism","urge":"想借刀杀人"}],"intensity":75}],
    "defenses":[],"trauma":null,"impulse":"先稳住2号","selfControl":40}`)!;
}

describe("emptyMirrorReport（心镜失败只标记状态缺失）", () => {
  it("不由参数编造任何压力、撕裂、关系或冲动", () => {
    const r = emptyMirrorReport();
    expect(r.pressures).toEqual([]);
    expect(r.tensions).toEqual([]);
    expect(r.bonds).toEqual([]);
    expect(r.impulse).toBe("");
  });
});

describe("formatTensionTemplate（张力模板四段式）", () => {
  it("含撕裂组/冲突强度/身体痕迹/涌现输出，且 ≤1600 字", () => {
    const card = makeCard();
    const mirror = mirrorWithTensions();
    const t = formatTensionTemplate(card, mirror, "手指敲击桌面", "我先听听再说。");
    expect(t).toContain("【当前撕裂】");
    expect(t).toContain("冲突强度：");
    expect(t).toContain("【身体痕迹】手指敲击桌面");
    expect(t).toContain("【涌现输出】我先听听再说。");
    expect(t.length).toBeLessThanOrEqual(1600);
  });
});

describe("双/单程自适应与 prompt 组装", () => {
  it("shouldUseDualPipeline：<32K 单程，≥32K 双程", () => {
    expect(shouldUseDualPipeline(8_192)).toBe(false);
    expect(shouldUseDualPipeline(modelContextTokens("moonshot-v1-8k"))).toBe(false);
    expect(shouldUseDualPipeline(modelContextTokens("kimi-k2"))).toBe(true);
  });

  it("buildMirrorPrompt 含人格卡/记事簿/铁律约束", () => {
    const { system, user } = buildMirrorPrompt(makeCard(), "- [创伤·强度80] 被5号背叛过", makePending());
    expect(system).toContain("心镜");
    expect(system).toContain("只记录实际出现的参数触发");
    expect(user).toContain("被5号背叛过");
    expect(user).toContain("马基雅维利 90");
  });

  it("心镜先获得本轮真实发言，空反应合法且不强制撕裂", () => {
    const pending = makePending("postgameSpeak");
    const base = buildPrompt(pending, {
      cognition: {
        publicFacts: "【赛后完整公共事实】\n旧事实仍在",
        selfFacts: "【你的完整自我事实台账】\n我此前保持沉默",
        currentInteraction: "【本轮互动事实】\n最新发言：2号玩家：你刚才为什么沉默？\n明确点名：3号",
      },
    });
    const { user } = buildMirrorPrompt(makeCard(), null, pending, undefined, base);
    expect(user).toContain("你刚才为什么沉默？");
    expect(user).toContain("明确点名：3号");
    expect(user).toContain("currentReaction");
    expect(user).not.toContain("pressures≥1 或 tensions≥1");
  });

  it("主体独立定向不读他人逐字话术，涌现保留公共事实但不附加回应指导", () => {
    const pending = makePending();
    const base = buildPrompt(pending, {
      cognition: {
        publicFacts: "【完整公共事实】\n六只手共用一把尺子",
        selfFacts: "【你的完整自我事实台账】\n我投6号",
        intentTrail: "【你的完整意图轨迹】\n12号→6号→12号，理由完整",
      },
    });
    const mirror = buildMirrorPrompt(makeCard(), null, pending, undefined, base);
    expect(mirror.user).not.toContain("六只手");
    expect(mirror.user).not.toContain("一把尺子");
    expect(mirror.user).toContain("我投6号");
    expect(mirror.user).toContain("12号→6号→12号，理由完整");
    const emergence = buildEmergencePrompt(makeCard(), mirrorWithTensions(), null, base, null, pending);
    expect(emergence.user).toContain("六只手共用一把尺子");
    expect(emergence.user).not.toContain("【公开证据边界】");
    expect(emergence.system).not.toContain("他人的话是互动材料");
    expect(emergence.system).not.toContain("如何权衡与选择");
    expect(emergence.user).not.toContain("如何回应由你决定");
    expect(emergence.user).not.toContain("是否以及如何行动由你决定");
    const single = buildSinglePrompt(makeCard(), null, pending, base);
    expect(single.user).not.toContain("【公开证据边界】");
    expect(single.user).not.toContain("是否形成、保留或改变战术由你决定");
  });

  it("buildEmergencePrompt：主体契约保留身体反应，但不生成观察者分析", () => {
    const card = makeCard();
    const mirror = mirrorWithTensions();
    const base = buildPrompt(makePending(), {});
    const { system, user } = buildEmergencePrompt(card, mirror, null, base);
    expect(system).toContain("你就是 TA");
    expect(user).toContain("【心镜 · 你此刻的人格状态报告】");
    expect(user).toContain("bodyTrace");
    expect(user).not.toContain("analysisGt");
    expect(user).not.toContain("analysisPsy");
    // 基础版 JSON 契约不应残留（人格版契约接管）
    expect(user).not.toContain('"thought":"你的真实内心推理');
  });

  it("buildSinglePrompt：同一契约内含 mirror 段与决策字段", () => {
    const { user } = buildSinglePrompt(makeCard(), null, makePending(), buildPrompt(makePending(), {}));
    expect(user).toContain('"mirror"');
    expect(user).toContain('"pressures"');
    expect(user).toContain("bodyTrace");
  });

  it("完整人格与语言资料进入心镜和表达层，不做数百字截断", () => {
    const card = makeCard();
    card.profile.speechStyle = "克制短句。" + "独有措辞节奏。".repeat(100);
    card.profile.quotes = ["一", "二", "三", "四", "五"];
    card.profile.values = "完整价值观".repeat(100);
    card.profile.essence = "完整自我认知".repeat(100);
    const mirrorPrompt = buildMirrorPrompt(card, null, makePending());
    const emergePrompt = buildEmergencePrompt(card, mirrorWithTensions(), null, buildPrompt(makePending(), {}));
    expect(mirrorPrompt.user).toContain(card.profile.values);
    expect(emergePrompt.system).toContain(card.profile.speechStyle);
    expect(emergePrompt.system).toContain("一／二／三／四／五");
    expect(emergePrompt.system).toContain(card.profile.essence);
  });

  it("双程表达层不接收可自述的原始参数报告", () => {
    const card = makeCard();
    const { user } = buildEmergencePrompt(card, mirrorWithTensions(), null, buildPrompt(makePending(), {}));
    expect(user).not.toContain('"pressures"');
    expect(user).not.toContain("bigFive.neuroticism");
    expect(user).toContain("【隐性行为倾向】");
  });
});

describe("paramValueOf / paramLabel", () => {
  it("固定维度/集合条目/未知路径", () => {
    const card = makeCard();
    expect(paramValueOf(card, "bigFive.neuroticism")).toBe(85);
    expect(paramValueOf(card, "cognitiveBiases.确认偏误")).toBe(50);
    expect(paramValueOf(card, "defenseMechanisms.合理化")).toBe(50);
    expect(paramValueOf(card, "bigFive.x")).toBeNull();
    expect(paramLabel(card, "bigFive.neuroticism")).toBe("神经质 85");
    expect(paramLabel(card, "cognitiveBiases.确认偏误")).toBe("确认偏误 50");
  });
});

describe("米勒山谷穿越认知注入（涌现 system）", () => {
  const pending = makePending();
  const base = buildPrompt(pending, {});

  it("已故铸造卡 → 死后穿越 + 出局≠死亡 + 能力封印", () => {
    const card = makeCard();
    card.profile = {
      ...card.profile,
      aliveStatus: "deceased",
      specialAbilities: "巨人之力",
    };
    const mirror = mirrorWithTensions();
    const { system } = buildEmergencePrompt(card, mirror, null, base);
    // 分身降临设定（2026-10-15 用户裁定）：原世界生命最后一刻分出的分身降临米勒山谷
    expect(system).toContain("生命的最后一刻");
    expect(system).toContain("米勒山谷的村庄小镇");
    expect(system).toContain("分身");
    expect(system).toContain("出局不等于死亡");
    expect(system).toContain("巨人之力");
    expect(system).toContain("全部失效");
  });

  it("在世铸造卡 → 忽然穿越；原创手动卡 → 山谷原住民（能力设定不存在）", () => {
    const alive = makeCard();
    alive.profile = { ...alive.profile, aliveStatus: "alive" };
    const m1 = mirrorWithTensions();
    const s1 = buildEmergencePrompt(alive, m1, null, base).system;
    expect(s1).toContain("米勒山谷的村庄小镇");
    expect(s1).toContain("分身");

    const original = makeCard({ source: "manual" });
    original.profile = { ...original.profile, specialAbilities: "言灵" };
    const m2 = mirrorWithTensions();
    const s2 = buildEmergencePrompt(original, m2, null, base).system;
    expect(s2).toContain("米勒山谷村庄小镇土生土长的原住民");
    expect(s2).toContain("在这里不存在");
  });
});
