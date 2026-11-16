import { describe, expect, it } from "vitest";
import type { MirrorReport } from "../../contracts/persona";
import { buildBehaviorBridge } from "./behavior-bridge";

describe("隐性行为桥接", () => {
  it("保留冲动、拉扯与关系倾向，但不泄露参数路径和数值", () => {
    const mirror: MirrorReport = {
      pressures: [{ param: "bigFive.neuroticism", value: 87, reason: "被质疑" }],
      tensions: [{ poles: [
        { param: "bigFive.agreeableness", urge: "想维持和气" },
        { param: "darkTetrad.machiavellianism", urge: "想借刀杀人" },
      ], intensity: 0.8 }],
      defenses: [{ mechanism: "合理化", toward: "自己的多疑" }],
      trauma: null,
      impulse: "先稳住二号",
      currentReaction: "这句话让我先停顿一下。",
      selfControl: 25,
      bonds: [{ toward: "二号", feel: "不甘心被轻视", urge: "让他收回判断" }],
    };
    const text = buildBehaviorBridge(mirror);
    expect(text).toContain("先稳住二号");
    expect(text).toContain("这句话让我先停顿一下");
    expect(text).toContain("想维持和气");
    expect(text).toContain("想借刀杀人");
    expect(text).toContain("不甘心被轻视");
    expect(text).toContain("25/100");
    expect(text).not.toContain("如何回应由你决定");
    expect(text).not.toContain("是否以及如何行动由你决定");
    expect(text).not.toContain("更容易直接落到措辞和动作上");
    expect(text).not.toContain("bigFive");
    expect(text).not.toContain("87");
    expect(text).not.toContain("0.8");
    expect(text).not.toContain("合理化");
  });
});
