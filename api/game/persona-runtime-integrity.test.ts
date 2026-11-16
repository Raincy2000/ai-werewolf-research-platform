import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertPersonaCircleCoverage } from "./personaVisibility";

const circle = "【人格圈层】3号=两面宿傩（男性，人称用「他」）";

describe("人格名册运行时完整性", () => {
  it("可见人格名册未进入实际提示时直接失败，不静默生成性别认知", () => {
    expect(() => assertPersonaCircleCoverage("【输出契约】", circle)).toThrow(/人格名册/);
    expect(() => assertPersonaCircleCoverage(`${circle}\n【输出契约】`, circle)).not.toThrow();
    expect(() => assertPersonaCircleCoverage("普通对局", null)).not.toThrow();
  });

  it("源码窗口有可见身份，避免与旧打包客户端混淆", () => {
    const main = readFileSync(new URL("../../desktop/main.mjs", import.meta.url), "utf8");
    expect(main).toContain('devUrl ? "AI模拟狼人杀研究平台 · 源码开发版"');
  });
});
