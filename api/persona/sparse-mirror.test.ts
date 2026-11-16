import { describe, expect, it } from "vitest";
import { buildBehaviorBridge } from "./behavior-bridge";
import { buildEmergencePrompt, buildMirrorPrompt, emptyMirrorReport, formatTensionTemplate, parseMirrorReport } from "./pipeline";
import { makeCard, makePending } from "./pipeline.test";
import { buildPrompt } from "../game/ai/prompts";

describe("R2 稀疏心镜与空状态展示", () => {
  it("主体明确表示不继续反思时，其他深层字段保持为空而非自动补戏", () => {
    const mirror = parseMirrorReport(JSON.stringify({
      pressures: [], tensions: [], defenses: [], trauma: null, impulse: "",
      currentReaction: "", wantsReflection: false, selfControl: 50, bonds: [],
    }))!;
    expect(mirror.wantsReflection).toBe(false);
    expect(buildBehaviorBridge(mirror)).toBe("");
    expect(emptyMirrorReport().wantsReflection).toBe(false);
  });

  it("心镜提示以当前反应为默认主项，不暗示每轮必有最强冲动", () => {
    const prompt = buildMirrorPrompt(makeCard(), null, makePending("postgameSpeak"), null, buildPrompt(makePending("postgameSpeak"), {}));
    expect(prompt.user).toContain('"wantsReflection"');
    expect(prompt.system).toContain("普通反应、平静与无反应都是正常结果");
    expect(prompt.user).not.toContain("此刻最强烈的想法、需求或意图");
  });

  it("空心镜不向涌现层注入控制余量，也不生成空心理模块", () => {
    const mirror = emptyMirrorReport();
    const pending = makePending("daySpeech");
    const base = buildPrompt(pending, {});
    const prompt = buildEmergencePrompt(makeCard(), mirror, null, base, null, pending, 0);
    expect(prompt.user).not.toContain("【隐性行为倾向】");
    expect(prompt.user).not.toContain("自我控制余量");
    expect(formatTensionTemplate(makeCard(), mirror, "", "")).toBe("");
  });

  it("发言上限不再附加完整述职义务", () => {
    const pending = makePending("postgameSpeak");
    const prompt = buildEmergencePrompt(makeCard(), emptyMirrorReport(), null, buildPrompt(pending, {}), null, pending, 0);
    expect(prompt.user).not.toContain("逻辑要完整说完");
  });
});
