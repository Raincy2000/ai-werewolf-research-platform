// 心镜→涌现双程管线的预算纪律回归测试（对局 20260930002 事故）：
// 心镜内部重试曾烧掉 80% 决策预算（104s×2），涌现层只剩 52s 残羹必败托管——
// 修复后：心镜总开销 35% 封顶（首发+解析重试共享上限、超限即本地兜底），
// 涌现拿全部剩余预算，各环节 deadlineAt 透传约束内部重试。
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { PendingDecision } from "../game/engine/api";
import type { PersonaCard } from "../../contracts/persona";
import { defaultPersonaParams, emptyPersonaProfile } from "../../contracts/persona";
import { injectCircleText } from "../game/personaVisibility";

// ---------- 夹具 ----------
function makeCard(): PersonaCard {
  return {
    id: 1,
    name: "曹操",
    source: "ai-cast",
    originName: "曹操",
    originSource: "《三国演义》",
    profile: { ...emptyPersonaProfile(), persona: "多疑善谋，宁负天下人。", quotes: ["宁教我负天下人"] },
    params: {
      ...defaultPersonaParams(),
      bigFive: { openness: 70, conscientiousness: 80, extraversion: 75, agreeableness: 25, neuroticism: 85 },
      darkTetrad: { machiavellianism: 90, narcissism: 70, psychopathy: 40, sadism: 30 },
    },
    notes: "",
    imageData: null,
    gameCount: 3,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function makePending(): PendingDecision {
  return {
    seat: 3,
    role: "villager",
    kind: "daySpeech",
    options: [],
    allowSkip: false,
    hint: "请发表白天发言",
    view: {
      seat: 3,
      role: "villager",
      roleName: "平民",
      camp: "villager",
      day: 2,
      phase: "day.speech",
      aliveSeats: [1, 2, 3, 4, 5],
      deadSeats: [6],
      revealedRoles: {},
      sheriffSeat: 1,
      selfAlive: true,
      rules: { witchSelfSave: "never" },
      publicLog: ["1号玩家发言：我觉得2号有问题"],
      private: {},
    },
  };
}

const VALID_MIRROR = `{"pressures":[{"param":"bigFive.neuroticism","value":85,"reason":"被质疑"}],
  "tensions":[{"poles":[{"param":"bigFive.agreeableness","urge":"想和气"},{"param":"darkTetrad.machiavellianism","urge":"想操控"}],"intensity":75}],
  "defenses":[],"trauma":null,"impulse":"先稳住","selfControl":40}`;
const INVALID_MIRROR = '{"pressures":[],"tensions":[],"impulse":"x"}'; // 铁律2 判非法
const VALID_EMERGENCE = '{"thought":"权衡","speech":"大家好，我先听听。","bodyTrace":"握拳","analysisGt":"观望","analysisPsy":"防御"}';

// ---------- callAi 记录器：按调用顺序出脚本 ----------
const h = {
  calls: [] as { timeoutMs?: number; deadlineAt?: number; system: string; user: string }[],
  script: [] as ({ ok: boolean; text: string | null } | "hang")[],
  t0: 0,
};

vi.mock("../game/ai/providers", () => ({
  callAi: async (_cfg: unknown, system: string, user: string, opts?: { timeoutMs?: number; deadlineAt?: number }) => {
    h.calls.push({ timeoutMs: opts?.timeoutMs, deadlineAt: opts?.deadlineAt, system, user });
    const next = h.script.shift() ?? { ok: false, text: null };
    if (next === "hang") return { ok: false, text: null, latencyMs: 1, error: "请求超时" };
    return next.ok
      ? { ok: true, text: next.text, latencyMs: 1, error: null }
      : { ok: false, text: next.text, latencyMs: 1, error: "请求超时" };
  },
}));

const { runPersonaPipeline } = await import("./pipeline");

const CFG = { seat: 3, provider: "kimi" as const, baseUrl: "http://mock.local/v1", model: "kimi-k3", apiKey: "sk-mock" };
const BASE = { system: "系统提示", user: "对局情境" };

beforeEach(() => {
  h.calls.length = 0;
  h.script.length = 0;
  h.t0 = Date.now();
});

describe("双程管线预算纪律（涌现优先）", () => {
  it("心镜失败：仅占 35% 上限并降级本地兜底；涌现拿满剩余预算并成功", async () => {
    h.script.push("hang", { ok: true, text: VALID_EMERGENCE });
    const deadlineAt = h.t0 + 260_000; // 思考型模型决策预算下限
    const res = await runPersonaPipeline({
      cfg: CFG,
      card: makeCard(),
      memoryText: null,
      pending: makePending(),
      base: BASE,
      modelContext: 1_048_576, // kimi-k3 → 双程
      deadlineAt,
    });

    expect(res.decision).not.toBeNull();
    expect(res.decision!.speech).toContain("大家好");
    expect(res.personaMeta?.dual).toBe(true);

    // 心镜：35% 上限（≈91s），deadlineAt 把心镜内部重试也锁在上限内
    expect(h.calls.length).toBe(2);
    expect(h.calls[0]!.timeoutMs).toBeGreaterThan(90_000);
    expect(h.calls[0]!.timeoutMs).toBeLessThanOrEqual(91_000);
    expect(h.calls[0]!.deadlineAt).toBeLessThanOrEqual(h.t0 + 91_000 + 50);
    // 涌现：拿到剩余全部（≈169s）→ 单次上限取 baseTimeout 150s，且共享决策点 deadlineAt
    expect(h.calls[1]!.timeoutMs).toBe(150_000);
    expect(h.calls[1]!.deadlineAt).toBe(deadlineAt);
  });

  it("心镜输出非法：解析重试与首发共享 35% 上限（不额外追加预算）", async () => {
    h.script.push({ ok: true, text: INVALID_MIRROR }, "hang", { ok: true, text: VALID_EMERGENCE });
    const deadlineAt = h.t0 + 260_000;
    const res = await runPersonaPipeline({
      cfg: CFG,
      card: makeCard(),
      memoryText: null,
      pending: makePending(),
      base: BASE,
      modelContext: 1_048_576,
      deadlineAt,
    });
    expect(res.decision).not.toBeNull();
    // 心镜首发 + 解析重试 + 涌现 = 3 次调用；重试的死线 = 心镜上限死线（同一 cap）
    expect(h.calls.length).toBe(3);
    expect(h.calls[1]!.deadlineAt).toBe(h.calls[0]!.deadlineAt);
    expect(h.calls[1]!.timeoutMs).toBeLessThanOrEqual(91_000);
    // 涌现预算不受心镜重试侵蚀
    expect(h.calls[2]!.timeoutMs).toBe(150_000);
  });

  it("心镜成功：不触发解析重试，涌现直接跟上（共 2 次调用）", async () => {
    h.script.push({ ok: true, text: VALID_MIRROR }, { ok: true, text: VALID_EMERGENCE });
    const res = await runPersonaPipeline({
      cfg: CFG,
      card: makeCard(),
      memoryText: null,
      pending: makePending(),
      base: BASE,
      modelContext: 1_048_576,
      deadlineAt: h.t0 + 260_000,
    });
    expect(res.decision).not.toBeNull();
    expect(h.calls.length).toBe(2);
  });
});


describe("圈层文本抵达管线（对局 20260930001 截断事故回归）", () => {
  // 事故：service 曾把圈层文本追加在 base.user 尾部（【输出契约】之后），
  // 人格单/双程都在契约处截断 → 文本从未抵达 AI → 人格玩家全程互不认识。
  // 修复后：injectCircleText 落在契约前，双程涌现层与单程合并层都必须收到。
  const BASE_WITH_CONTRACT = {
    system: "系统提示",
    user: "【对局状态】第1天\n【公开记录】1. 2号发言\n\n【输出契约】严格输出 JSON……",
  };

  it("双程：涌现层收到的 user 含圈层文本（在契约段之前）", async () => {
    h.script.push({ ok: true, text: VALID_MIRROR }, { ok: true, text: VALID_EMERGENCE });
    const base = {
      ...BASE_WITH_CONTRACT,
      user: injectCircleText(BASE_WITH_CONTRACT.user, "【人格圈层】3号=张雪峰，基本印象：考研名师"),
    };
    const res = await runPersonaPipeline({
      cfg: CFG,
      card: makeCard(),
      memoryText: null,
      pending: makePending(),
      base,
      modelContext: 1_048_576, // 双程
      deadlineAt: h.t0 + 260_000,
    });
    expect(res.decision).not.toBeNull();
    const emergeUser = h.calls.at(-1)!.user;
    expect(emergeUser).toContain("【人格圈层】3号=张雪峰");
    expect(emergeUser.indexOf("人格圈层")).toBeLessThan(emergeUser.indexOf("【输出契约】"));
  });

  it("单程：合并层收到的 user 同样含圈层文本", async () => {
    h.script.push({ ok: true, text: '{"mirror":{"pressures":[{"param":"bigFive.neuroticism","value":85,"reason":"被质疑"}]},"thought":"权衡","speech":"我先听听。"}' });
    const base = {
      ...BASE_WITH_CONTRACT,
      user: injectCircleText(BASE_WITH_CONTRACT.user, "【人格圈层】5号=五条悟"),
    };
    const res = await runPersonaPipeline({
      cfg: CFG,
      card: makeCard(),
      memoryText: null,
      pending: makePending(),
      base,
      modelContext: 16_384, // 单程合并
      deadlineAt: h.t0 + 260_000,
    });
    expect(res.decision).not.toBeNull();
    expect(h.calls.at(-1)!.user).toContain("【人格圈层】5号=五条悟");
  });
});
