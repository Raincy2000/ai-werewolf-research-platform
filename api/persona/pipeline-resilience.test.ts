// 人格决策真实调用链回归：runPersonaPipeline → callAi → longFetch。
// 心镜失败可降级，但决定玩家行动的涌现层必须能挺过短暂 5xx 故障窗口。
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingDecision } from "../game/engine/api";
import type { PersonaCard } from "../../contracts/persona";
import { defaultPersonaParams, emptyPersonaProfile } from "../../contracts/persona";

const h = {
  calls: 0,
  emergence500s: 0,
  emptyMirror: false,
};

vi.mock("../lib/longFetch", () => ({
  longFetch: async () => {
    h.calls += 1;
    if (h.calls === 1) {
      const content = h.emptyMirror
        ? '{"pressures":[],"tensions":[],"defenses":[],"trauma":null,"impulse":"","currentReaction":"","selfControl":50}'
        : '{"pressures":[{"param":"bigFive.neuroticism","value":70,"reason":"夜晚的不确定性"}],"tensions":[],"impulse":"谨慎行动","selfControl":60}';
      return new Response(JSON.stringify({
        choices: [{ message: { content } }],
      }), { status: 200 });
    }
    if (h.emergence500s > 0) {
      h.emergence500s -= 1;
      return new Response(JSON.stringify({ error: { message: "Internal Server Error" } }), { status: 500 });
    }
    return new Response(JSON.stringify({
      choices: [{ message: { content: '{"thought":"独立判断","witchSave":true,"bodyTrace":"平静","analysisGt":"","analysisPsy":""}' } }],
    }), { status: 200 });
  },
  netErrorMessage: (error: Error) => `网络失败（${error.message}）`,
}));

const { runPersonaPipeline } = await import("./pipeline");

function card(): PersonaCard {
  return {
    id: 1,
    name: "测试人格",
    source: "ai-cast",
    originName: "测试人格",
    originSource: null,
    profile: emptyPersonaProfile(),
    params: defaultPersonaParams(),
    notes: "",
    imageData: null,
    gameCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function pending(): PendingDecision {
  return {
    seat: 4,
    role: "witch",
    kind: "witchAction",
    options: [1, 2, 4],
    allowSkip: true,
    hint: "今夜被刀的是2号，请决定是否使用解药。",
    view: {
      seat: 4,
      role: "witch",
      roleName: "女巫",
      camp: "god",
      day: 1,
      phase: "night.witch",
      aliveSeats: [1, 2, 3, 4],
      deadSeats: [],
      revealedRoles: {},
      sheriffSeat: null,
      selfAlive: true,
      rules: { witchSelfSave: "firstNight" },
      publicLog: [],
      private: { witchPotions: { save: true, poison: true }, witchVictimTonight: 2 },
    },
  };
}

beforeEach(() => {
  h.calls = 0;
  h.emergence500s = 0;
  h.emptyMirror = false;
});

describe("人格决策的间歇性服务故障恢复", () => {
  it("涌现连续三次 HTTP 500 后恢复，保留人格自己的用药决策", async () => {
    h.emergence500s = 3;
    const res = await runPersonaPipeline({
      cfg: { seat: 4, provider: "deepseek", baseUrl: "http://mock.local/v1", model: "deepseek-v4-flash", apiKey: "sk-mock" },
      card: card(),
      memoryText: null,
      pending: pending(),
      base: { system: "游戏规则", user: "女巫夜间行动" },
      modelContext: 131_072,
      deadlineAt: Date.now() + 120_000,
    });
    expect(res.error).toBeNull();
    expect(res.decision?.witchSave).toBe(true);
    expect(res.decision?.thought).toBe("独立判断");
    expect(h.calls).toBe(5); // 心镜 1 次 + 涌现 4 次（首发及三次 500 后，第四次涌现成功）
  }, 20_000);

  it("心镜平静空反应不重试、不补戏，涌现仍保留主体自己的决定", async () => {
    h.emptyMirror = true;
    const res = await runPersonaPipeline({
      cfg: { seat: 4, provider: "deepseek", baseUrl: "http://mock.local/v1", model: "deepseek-v4-flash", apiKey: "sk-mock" },
      card: card(),
      memoryText: null,
      pending: pending(),
      base: { system: "游戏规则", user: "女巫夜间行动" },
      modelContext: 131_072,
      deadlineAt: Date.now() + 120_000,
    });
    expect(res.error).toBeNull();
    expect(res.decision?.witchSave).toBe(true);
    expect(h.calls).toBe(2); // 心镜 1 次 + 涌现 1 次；空反应不触发补写重试。
    expect(res.personaMeta?.tensions).toEqual([]);
  });
});
