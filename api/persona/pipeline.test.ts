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
  mirrorFallbackReport,
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

  it("pressures 与 tensions 皆空 → null（无根表演判非法）", () => {
    expect(parseMirrorReport('{"pressures":[],"tensions":[],"impulse":"x"}')).toBeNull();
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

describe("mirrorFallbackReport（心镜失败的确定性兜底：触发参数来自卡本身）", () => {
  it("极端参数成为触发源；宜人⇄黑暗面构成天然撕裂", () => {
    const r = mirrorFallbackReport(makeCard(), makePending());
    expect(r.pressures.length).toBeGreaterThan(0);
    expect(r.tensions.length).toBeGreaterThan(0);
    expect(r.tensions[0]!.poles.length).toBe(2);
    // 曹操焦虑/回避双高 → 还应补一组依恋撕裂
    expect(r.tensions.length).toBe(2);
  });
});

describe("formatTensionTemplate（张力模板四段式）", () => {
  it("含撕裂组/冲突强度/身体痕迹/涌现输出，且 ≤1600 字", () => {
    const card = makeCard();
    const mirror = mirrorFallbackReport(card, makePending());
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
    expect(system).toContain("参数溢出");
    expect(user).toContain("被5号背叛过");
    expect(user).toContain("马基雅维利 90");
  });

  it("buildEmergencePrompt：基础输出契约被人格契约替代（含 bodyTrace/analysisGt）", () => {
    const card = makeCard();
    const mirror = mirrorFallbackReport(card, makePending());
    const base = buildPrompt(makePending(), {});
    const { system, user } = buildEmergencePrompt(card, mirror, null, base);
    expect(system).toContain("你就是 TA");
    expect(user).toContain("【心镜 · 你此刻的人格状态报告】");
    expect(user).toContain("bodyTrace");
    expect(user).toContain("analysisGt");
    // 基础版 JSON 契约不应残留（人格版契约接管）
    expect(user).not.toContain('"thought":"你的真实内心推理');
  });

  it("buildSinglePrompt：同一契约内含 mirror 段与决策字段", () => {
    const { user } = buildSinglePrompt(makeCard(), null, makePending(), buildPrompt(makePending(), {}));
    expect(user).toContain('"mirror"');
    expect(user).toContain('"pressures"');
    expect(user).toContain("bodyTrace");
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
    const mirror = mirrorFallbackReport(card, pending);
    const { system } = buildEmergencePrompt(card, mirror, null, base);
    expect(system).toContain("你已经死过一次");
    expect(system).toContain("穿越到了米勒山谷的村庄小镇");
    expect(system).toContain("出局不等于死亡");
    expect(system).toContain("巨人之力");
    expect(system).toContain("全部失效");
  });

  it("在世铸造卡 → 忽然穿越；原创手动卡 → 山谷原住民（能力设定不存在）", () => {
    const alive = makeCard();
    alive.profile = { ...alive.profile, aliveStatus: "alive" };
    const m1 = mirrorFallbackReport(alive, pending);
    expect(buildEmergencePrompt(alive, m1, null, base).system).toContain("忽然穿越到了米勒山谷");

    const original = makeCard({ source: "manual" });
    original.profile = { ...original.profile, specialAbilities: "言灵" };
    const m2 = mirrorFallbackReport(original, pending);
    const s2 = buildEmergencePrompt(original, m2, null, base).system;
    expect(s2).toContain("米勒山谷村庄小镇土生土长的原住民");
    expect(s2).toContain("在这里不存在");
  });
});
