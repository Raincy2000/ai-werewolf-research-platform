import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../pages/Personas.tsx", import.meta.url), "utf8");

describe("人格研究站不显示关系网", () => {
  it("不挂载关系图、关系页签和关系弹窗", () => {
    expect(source).not.toContain("<RelationGraphBar");
    expect(source).not.toContain('value="relations"');
    expect(source).not.toContain("<RelationEditDialog");
    expect(source).not.toContain("<CanonEventDialog");
    expect(source).not.toContain("<RSQQuestionnaireDialog");
    expect(source).not.toContain("<RSQReportDialog");
  });

  it("保留人物档案和重要关系自由文本", () => {
    expect(source).toContain('value="profile"');
    expect(source).toContain("重要关系");
  });
});
