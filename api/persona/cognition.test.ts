// ============================================================
// 自我认知笔记书写管线测试（铁律延展：受影响而不自知）
// - 压力报告解析（参数挂靠校验）
// - 笔记校验（第一人称容量、术语/数值泄漏判非法）
// - 材料组装（可见性开关执行点：参数永远不进材料）
// ============================================================

import { describe, it, expect } from "vitest";
import { defaultPersonaParams, emptyPersonaProfile } from "../../contracts/persona";
import type { PersonaCard } from "../../contracts/persona";
import {
  buildPressurePrompt,
  parseCognitionPressure,
  buildWritePrompt,
  parseCognitionNote,
  buildCognitionMaterials,
} from "./cognition";

const card = {
  id: 1,
  name: "夜神月",
  params: defaultPersonaParams(),
  profile: { ...emptyPersonaProfile(), summary: "天才高中生", persona: "冷静自持" },
} as unknown as PersonaCard;

describe("压力报告（心镜式，参数全可见不见光）", () => {
  it("prompt 含参数卡与旧笔记；解析校验 pressures 非空", () => {
    const p = buildPressurePrompt(card, "材料", "旧笔记内容");
    expect(p.user).toContain("旧笔记内容");
    expect(p.user).toContain("防御机制");
    const parsed = parseCognitionPressure(
      '{"pressures":[{"param":"darkTetrad.narcissism","alive":"被质疑时会想立刻证明自己"}],"defenseFilter":["不愿承认自己也会怕"],"conflictsWithPrev":null}',
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.pressures[0]!.param).toBe("darkTetrad.narcissism");
    expect(parsed!.defenseFilter).toContain("不愿承认自己也会怕");
    // pressures 空 → 非法（无根报告）
    expect(parseCognitionPressure('{"pressures":[],"defenseFilter":[],"conflictsWithPrev":null}')).toBeNull();
  });
});

describe("涌现书写（参数零可见，术语零容忍）", () => {
  const pressure = {
    pressures: [{ param: "darkTetrad.narcissism", alive: "被质疑时会想立刻证明自己" }],
    defenseFilter: ["不愿承认自己也会怕"],
    conflictWithPrev: null,
  };

  it("书写 prompt 绝不出现参数名/数值，含防御过滤与旧笔记", () => {
    const p = buildWritePrompt({ card, materials: "材料", pressure, prevNote: "旧笔记" });
    expect(p.user).toContain("被质疑时会想立刻证明自己"); // 人话感受进
    expect(p.user).not.toContain("narcissism"); // 参数名不进
    expect(p.user).not.toContain("darkTetrad");
    expect(p.user).toContain("不愿承认自己也会怕"); // 防御过滤进（作为留白指引）
    expect(p.user).toContain("旧笔记");
    expect(p.system).toContain("第一人称");
  });

  it("笔记校验：合法放行；术语泄漏/过短/超长判非法", () => {
    expect(parseCognitionNote('{"note":"我开始明白，我不是永远正确的那一个。可承认这一点比我想象的难。"}')).not.toBeNull();
    expect(parseCognitionNote('{"note":"我的神经质参数最近上升了"}')).toBeNull(); // 术语泄漏
    expect(parseCognitionNote('{"note":"太短"}')).toBeNull();
    expect(parseCognitionNote("不是 JSON")).toBeNull();
  });
});

describe("材料组装（可见性开关的唯一执行点）", () => {
  it("开关关闭：报告与漂移不进材料；记忆/关系无数值", () => {
    const m = buildCognitionMaterials({
      card,
      memories: [
        {
          id: 1, personaId: 1, gameId: "g", type: "general",
          content: "我首夜就识破了他", emotionalWeight: 60, valence: 60, strength: 70,
          createdAt: "", updatedAt: "",
        },
      ],
      relationships: [
        { id: 1, personaId: 1, targetPersonaId: 2, targetName: "艾伦·耶格尔", relation: "宿敌", affinity: -40, trust: 20, note: "首刀点我名", gameId: null, updatedAt: "" },
      ],
      driftHuman: null,
      reports: null,
    });
    expect(m).toContain("我首夜就识破了他");
    expect(m).toContain("宿敌");
    expect(m).not.toContain("强度"); // 无数值
    expect(m).not.toContain("-40"); // 亲疏数值不进
    expect(m).not.toContain("报告");
  });

  it("开关开启：漂移人话与报告内容进材料", () => {
    const m = buildCognitionMaterials({
      card,
      memories: [],
      relationships: [],
      driftHuman: ["依恋回避更强了（反复被背叛）"],
      reports: [{ title: "g1", content: "报告正文：他在压力下……" }],
    });
    expect(m).toContain("依恋回避更强了");
    expect(m).toContain("报告正文");
  });
});
