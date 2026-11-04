import { describe, expect, it } from "vitest";
import { defaultPersonaParams, emptyPersonaProfile, type PersonaCard } from "../../contracts/persona";
import { buildPersonaContext, createPersonaSnapshot, degradePersonaContext } from "./context";

function card(): PersonaCard {
  return {
    id: 7,
    name: "测试人格",
    source: "manual",
    originName: null,
    originSource: null,
    profile: {
      ...emptyPersonaProfile(),
      summary: "完整身份摘要",
      persona: "完整性格画像",
      experiences: "完整关键经历",
      relationships: "本人知道的关系",
      speechStyle: "短句，克制。" + "独特的节奏与措辞。".repeat(80),
      quotes: ["一", "二", "三", "四", "五"],
      values: "完整价值观",
      desires: "完整欲望",
      fears: "完整恐惧",
      socialMask: "完整社交面具",
      innerWorld: "未被本人意识到的内在冲突",
      quirks: "完整习惯",
      essence: "本人写下的完整自我认知",
    },
    params: { ...defaultPersonaParams(), bigFive: { ...defaultPersonaParams().bigFive, neuroticism: 87 } },
    notes: "仅供研究者查看的秘密备注",
    imageData: null,
    gameCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
  };
}

describe("三层人格上下文", () => {
  it("完整保留显意识与语言材料，并按权限隔离参数、内心和研究备注", () => {
    const c = card();
    const ctx = buildPersonaContext(c, "本人记得的往事");
    expect(ctx.conscious).toContain(c.profile.persona);
    expect(ctx.conscious).toContain(c.profile.values);
    expect(ctx.conscious).toContain(c.profile.essence);
    expect(ctx.conscious).toContain("本人记得的往事");
    expect(ctx.voice).toContain(c.profile.speechStyle);
    expect(ctx.voice).toContain("一／二／三／四／五");
    expect(ctx.latent).toContain("neuroticism");
    expect(ctx.latent).toContain("87");
    expect(ctx.latent).toContain("未被本人意识到的内在冲突");
    expect(`${ctx.conscious}\n${ctx.voice}`).not.toContain("neuroticism");
    expect(`${ctx.conscious}\n${ctx.voice}`).not.toContain("未被本人意识到的内在冲突");
    expect(`${ctx.conscious}\n${ctx.latent}\n${ctx.voice}`).not.toContain("秘密备注");
    expect(ctx.audit.observer).toContain("秘密备注");
  });

  it("快照与原卡及原记忆池解耦", () => {
    const c = card();
    const memory = { items: [{ id: 1, content: "原始记忆" }], relationships: [] };
    const snap = createPersonaSnapshot(c, memory);
    c.profile.persona = "赛后被改写";
    memory.items[0]!.content = "赛后新增记忆";
    expect(snap.card.profile.persona).toBe("完整性格画像");
    expect((snap.memory as typeof memory).items[0]!.content).toBe("原始记忆");
    expect(snap.version).toContain("2026-01-02");
  });

  it("极端预算只整块降级低优先材料并留痕，不动语言风格和隐性参数", () => {
    const ctx = buildPersonaContext(card(), "很长的往事".repeat(500));
    const budgeted = degradePersonaContext(ctx, 2_000);
    expect(budgeted.voice).toBe(ctx.voice);
    expect(budgeted.latent).toBe(ctx.latent);
    expect(budgeted.audit.degraded.length).toBeGreaterThan(0);
    expect(budgeted.conscious).not.toContain("很长的往事");
    expect(budgeted.conscious).toContain("完整性格画像");
    expect(ctx.conscious).toContain("很长的往事");
  });
});
