import { describe, expect, it } from "vitest";
import { memoryMaterialKindOf, recallMemories, type MemoryItem } from "./memory";
import { buildWritebackPrompt } from "./notebook";
import { buildPersonaContext } from "./context";
import { makeCard } from "./pipeline.test";

function memory(id: number, patch: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id,
    type: "general",
    content: `记忆${id}`,
    strength: 80,
    valence: 0,
    emotionalWeight: 20,
    lifecycle: "active",
    ...patch,
  };
}

describe("R4 事件经验与语言材料分流", () => {
  it("检索只返回本人经历；观察者报告和语言锚点不能借高强度混入", () => {
    const observer = memory(2, { content: "分析师说他应当更冷静", strength: 100, origin: "observer_report" });
    const voice = memory(3, { content: "账格署名台词模板", strength: 99, materialKind: "languageAnchor" });
    const experience = memory(1, { content: "第2天我投给了6号", strength: 40, origin: "game" });
    expect(memoryMaterialKindOf(observer)).toBe("observerReport");
    expect(memoryMaterialKindOf(voice)).toBe("languageAnchor");
    expect(memoryMaterialKindOf(experience)).toBe("eventExperience");
    expect(recallMemories([observer, voice, experience], { k: 6 }).map((item) => item.id)).toEqual([1]);
  });

  it("回写契约明确保留经历与个人意义，不沉淀报告腔或语言模板", () => {
    const prompt = buildWritebackPrompt({
      card: makeCard(), seat: 1, roleName: "平民", outcome: "好人阵营胜利", gameTitleNo: "20261114001",
      digest: "", memories: [], relationships: [], seatRoster: [],
    });
    expect(prompt.user).toContain("记忆只保存经历与个人意义");
    expect(prompt.user).toContain("不保存修辞模板、观察者报告或语言风格");
  });

  it("人格语言只来自人物自身语言资料，不从研究备注生成声音", () => {
    const card = makeCard({ notes: "观察者认为应该使用账格署名", profile: { ...makeCard().profile, speechStyle: "短句，直接。" } });
    const context = buildPersonaContext(card, null);
    expect(context.voice).toContain("短句，直接。");
    expect(context.voice).not.toContain("观察者认为");
    expect(context.voice).not.toContain("账格署名");
  });
});
