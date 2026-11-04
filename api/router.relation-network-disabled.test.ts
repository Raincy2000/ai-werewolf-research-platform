import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const relationReads = vi.hoisted(() => ({
  relationships: vi.fn(() => { throw new Error("关系读取不应执行"); }),
  history: vi.fn(() => { throw new Error("关系沿革读取不应执行"); }),
  incoming: vi.fn(() => { throw new Error("incoming 关系读取不应执行"); }),
}));

vi.mock("./queries/personas", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./queries/personas")>();
  return {
    ...actual,
    getPersona: vi.fn(async () => ({ id: 1, name: "测试人格" }) as never),
    listPersonaMemories: vi.fn(async () => []),
    listPersonaDrift: vi.fn(async () => []),
    listPersonaCognitionNotes: vi.fn(async () => []),
    listPersonaRelationships: relationReads.relationships,
    listPersonaRelationshipHistory: relationReads.history,
    listIncomingPersonaRelationships: relationReads.incoming,
  };
});

import { appRouter } from "./router";

const ctx = {
  req: new Request("http://test.local/api/trpc"),
  resHeaders: new Headers(),
  user: {
    id: "u1",
    email: "u1@example.com",
    username: "u1",
    avatar: "",
    createdAt: new Date(0).toISOString(),
  },
};

describe("关系网从新版本停用", () => {
  it("主路由不暴露 network", () => {
    expect(appRouter).not.toHaveProperty("network");
  });

  it("启动入口不再执行旧关系迁移", () => {
    const boot = readFileSync(new URL("./boot.ts", import.meta.url), "utf8");
    expect(boot).not.toContain("migrateLegacyRelations");
  });

  it("人格详情保留响应形状但不读关系数据", async () => {
    const detail = await appRouter.createCaller(ctx).persona.detail({ id: 1 });
    expect(detail?.card).toEqual({ id: 1, name: "测试人格" });
    expect(detail?.relationships).toEqual([]);
    expect(detail?.relationshipHistory).toEqual([]);
    expect(detail?.incomingRelationships).toEqual([]);
    expect(relationReads.relationships).not.toHaveBeenCalled();
    expect(relationReads.history).not.toHaveBeenCalled();
    expect(relationReads.incoming).not.toHaveBeenCalled();
  });
});
