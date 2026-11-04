import { describe, expect, it } from "vitest";
import { encryptSecret } from "../lib/authCrypto";
import { analystAiOfSetup } from "./recovery";
import type { StoredSetup } from "./service";

describe("分析师配置恢复", () => {
  it("从加密 setup 恢复模型配置与自动生成开关", () => {
    const cfg = { provider: "deepseek" as const, baseUrl: "http://mock.local/v1", model: "analyst-model", apiKey: "sk-mock" };
    const setup = {
      seatRoles: [],
      seatModels: [],
      options: { stepDelayMs: 500, sheriffEnabled: true, allowSelfDestruct: true, speechRoundsLimit: 2 },
      analystAiEnc: encryptSecret(JSON.stringify(cfg)),
      analystAutoGenerate: false,
    } as StoredSetup;
    expect(analystAiOfSetup(setup)).toEqual({ ...cfg, autoGenerate: false });
  });
});
