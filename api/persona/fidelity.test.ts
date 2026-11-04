import { describe, expect, it } from "vitest";
import { buildFidelityRetryNote, duplicateExactText, inspectPersonaText, mergePersonaTextOnly, sharedStylePhrases } from "./fidelity";

describe("人格表达保真", () => {
  it("检测参数和研究机制自述，但不误伤正常游戏措辞", () => {
    expect(inspectPersonaText("我的大五神经质 80，所以人格参数漂移让我害怕")).toHaveLength(3);
    expect(inspectPersonaText("我投二号，因为他的警徽流不完整")).toEqual([]);
  });

  it("检测跨座位复用的显著句式，忽略普通短游戏词", () => {
    const prior = ["4号玩家发言：票落座位，不落感觉，这是今天唯一的尺。"];
    expect(sharedStylePhrases("票落座位，不落感觉，这是今天唯一的尺。我接一半。", prior)).toContain("票落座位，不落感觉");
    expect(sharedStylePhrases("我投二号，警徽应该留下。", prior)).toEqual([]);
  });

  it("完全重复检测忽略排版空白，重试注记明确冻结行动", () => {
    expect(duplicateExactText("同一句话。\n下一行", " 同一句话。 下一行 ")).toBe(true);
    const note = buildFidelityRetryNote(["参数自述"], { targets: [2], skip: false });
    expect(note).toContain("参数自述");
    expect(note).toContain("不得改变");
    expect(note).toContain('"targets":[2]');
  });

  it("表达重写只合并文本字段，投票和技能目标始终保留原值", () => {
    const original = { targets: [2], witchSave: true, skip: false, speech: "旧话", thought: "旧想法" };
    const rewritten = { targets: [5], witchSave: false, skip: true, speech: "新话", thought: "新想法" };
    expect(mergePersonaTextOnly(original, rewritten)).toEqual({ targets: [2], witchSave: true, skip: false, speech: "新话", thought: "新想法" });
  });
});
