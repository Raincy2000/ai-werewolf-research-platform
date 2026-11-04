import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const service = readFileSync(new URL("./service.ts", import.meta.url), "utf8");
const notebook = readFileSync(new URL("../persona/notebook.ts", import.meta.url), "utf8");

describe("纯对局路径不连接关系网", () => {
  it("人格决策不调用关系摘要或调用台", () => {
    expect(service).not.toContain("buildRelationDigest(");
    expect(service).not.toContain("assembleInvocation(");
    expect(service).not.toContain("getSeatBonds(");
    expect(service).toContain("relationDigest: null");
  });

  it("赛后不写新旧关系存储", () => {
    expect(notebook).not.toContain("applyRelationDelta(");
    expect(notebook).not.toContain("upsertPersonaRelationship(");
    expect(notebook).not.toContain("insertPersonaRelationshipHistory(");
    expect(notebook).toContain("relationshipsTouched: 0");
  });
});
