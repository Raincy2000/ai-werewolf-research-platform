// ============================================================
// 人格契约 zod 校验测试：铁律1「人格量化」的输入边界
// - 合法默认卡通过；越界值/超长集合一律拒绝
// - partial() 用于 update 路由（补丁语义）
// ============================================================

import { describe, expect, it } from "vitest";
import {
  defaultPersonaParams,
  emptyPersonaProfile,
  personaInputSchema,
} from "./persona";

function validInput() {
  return {
    name: "曹操",
    originName: "曹操",
    originSource: "《三国演义》",
    profile: { ...emptyPersonaProfile(), summary: "东汉末年权臣。" },
    params: defaultPersonaParams(),
    notes: "",
  };
}

describe("personaInputSchema", () => {
  it("合法默认卡通过（推断项/自定义偏差/自定义防御机制均可）", () => {
    const input = validInput();
    input.params.inferred = ["bigFive.openness"];
    input.params.cognitiveBiases.push({ id: "custom-x", label: "幸存者偏差", strength: 60 });
    input.params.defenseMechanisms.push({
      id: "custom-y",
      label: "情感隔离",
      tendency: 70,
      maturity: "neurotic",
    });
    const r = personaInputSchema.safeParse(input);
    expect(r.success).toBe(true);
  });

  it("数值越界（<0 / >100 / 非整数）一律拒绝", () => {
    for (const v of [-1, 101, 50.5]) {
      const input = validInput();
      input.params.bigFive.openness = v as number;
      expect(personaInputSchema.safeParse(input).success).toBe(false);
    }
  });

  it("空人格名拒绝；语录 >5 条拒绝；偏差 >12 条拒绝", () => {
    const noName = validInput();
    noName.name = "  ";
    expect(personaInputSchema.safeParse(noName).success).toBe(false);

    const tooManyQuotes = validInput();
    tooManyQuotes.profile.quotes = ["a", "b", "c", "d", "e", "f"];
    expect(personaInputSchema.safeParse(tooManyQuotes).success).toBe(false);

    const tooManyBiases = validInput();
    tooManyBiases.params.cognitiveBiases = Array.from({ length: 13 }, (_, i) => ({
      id: `b${i}`,
      label: `偏差${i}`,
      strength: 50,
    }));
    expect(personaInputSchema.safeParse(tooManyBiases).success).toBe(false);
  });

  it("防御机制成熟度枚举之外拒绝", () => {
    const input = validInput();
    input.params.defenseMechanisms[0]!.maturity = "evil" as never;
    expect(personaInputSchema.safeParse(input).success).toBe(false);
  });

  it("partial() 补丁语义：单字段补丁合法、缺字段不报错", () => {
    const patchSchema = personaInputSchema.partial();
    expect(patchSchema.safeParse({ name: "新名字" }).success).toBe(true);
    expect(patchSchema.safeParse({}).success).toBe(true);
    expect(patchSchema.safeParse({ name: "" }).success).toBe(false);
  });
});
