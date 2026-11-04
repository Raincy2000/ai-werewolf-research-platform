import { describe, expect, it } from "vitest";
import { defaultPersonaParams, emptyPersonaProfile, type PersonaCard } from "../../contracts/persona";
import { buildPsyCheckPrompt } from "./anatomist";

describe("心理检查人物性别", () => {
  it("人格卡性别优先于女巫等角色字面，不得据角色改写性别", () => {
    const card: PersonaCard = {
      id: 10,
      name: "两面宿傩",
      source: "ai-cast",
      originName: "两面宿傩",
      originSource: "《咒术回战》",
      profile: { ...emptyPersonaProfile(), gender: "男", persona: "男性，诅咒之王" },
      params: defaultPersonaParams(),
      notes: "",
      imageData: null,
      gameCount: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const { user } = buildPsyCheckPrompt({ card, seat: 1, roleName: "女巫", outcome: "出局", digest: "摘要" });
    expect(user).toContain("性别：男");
    expect(user).toContain("不得因角色名称推断或改变人物性别");
    expect(user).toContain("人称使用「他」");
  });
});
