// canonVerify 单元测试（mock AI 层，覆盖 P0-8 的可修正/不可采信/删除二次核查）
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  callWithWebSearch: vi.fn(),
  prepareWebContext: vi.fn(),
}));

vi.mock("./caster", () => ({ callWithWebSearch: mocks.callWithWebSearch }));
vi.mock("./websearch", () => ({
  prepareWebContext: mocks.prepareWebContext,
  cleanWorkName: (w: string) => String(w || "").trim(),
}));

const { verifyCanonEvent, verifyRemoval, cardSupportsEvent } = await import("./canonVerify");

const cfg = { provider: "custom", baseUrl: "http://mock.local", model: "mock", apiKey: "k" } as never;

function pass(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    supported: true,
    fixable: false,
    confidence: "high",
    basis: "漫画第1话",
    detail: "原作里确实发生了",
    elements: {
      who: { ok: true, note: "" },
      what: { ok: true, note: "" },
      where: { ok: true, note: "" },
      when: { ok: true, note: "" },
      result: { ok: true, note: "" },
    },
    discrepancies: [],
    correctedEvent: "",
    correctedEra: "",
    correctedAge: null,
    correctedPlace: "",
    correctedEraBasis: "",
    sourceUrl: "",
    reason: "ok",
    ...over,
  });
}

function mockReply(text: string, extra: Record<string, unknown> = {}) {
  mocks.callWithWebSearch.mockResolvedValue({ text, webSearched: false, finishReason: "stop", ...extra });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prepareWebContext.mockResolvedValue({ mode: "none", useBuiltin: false, evidence: "", note: "mock" });
});

describe("cardSupportsEvent（L0 人格卡依据）", () => {
  it("卡片原文覆盖 ≥50% 关键词 → true", () => {
    expect(cardSupportsEvent("我杀死了两名绑匪", "我杀死了两名绑匪，把围巾围在三笠脖子上")).toBe(true);
  });
  it("卡片未提及 → false", () => {
    expect(cardSupportsEvent("我在月球上摘了一朵花", "我们是青梅竹马")).toBe(false);
  });
  it("空输入 → false", () => {
    expect(cardSupportsEvent("", "abc")).toBe(false);
    expect(cardSupportsEvent("abc", "")).toBe(false);
  });
});

describe("verifyCanonEvent 事实核查", () => {
  it("L0：人格卡直接支撑 → 免联网 confirmed", async () => {
    const v = await verifyCanonEvent({
      work: "进击的巨人",
      character: "艾伦",
      event: "我杀死了两名绑匪",
      cfg,
      basis: "我杀死了两名绑匪",
      cardText: "我杀死了两名绑匪，把围巾围在三笠脖子上",
    });
    expect(v.passed).toBe(true);
    expect(v.verification).toBe("confirmed");
    expect(mocks.callWithWebSearch).not.toHaveBeenCalled();
  });

  it("supported+high → passed confirmed 并带来源", async () => {
    mockReply(pass());
    const v = await verifyCanonEvent({ work: "作品", character: "我", event: "某事", cfg });
    expect(v.passed).toBe(true);
    expect(v.verification).toBe("confirmed");
    expect(v.sources.length).toBe(1);
  });

  it("可修正（fixable）→ passed cross-checked，空串 correctedPlace 语义保留", async () => {
    mockReply(
      pass({
        fixable: true,
        discrepancies: ["人称错误：应为第一人称"],
        correctedEvent: "我参加了那场战斗",
        correctedPlace: "",
        reason: "事件真实存在，仅人称与地点需修正",
      }),
    );
    const v = await verifyCanonEvent({ work: "作品", character: "我", event: "他参加了那场战斗", cfg });
    expect(v.passed).toBe(true);
    expect(v.verification).toBe("cross-checked");
    expect(v.correctedEvent).toBe("我参加了那场战斗");
    // "" = 模型明确说「无法确定地点」，必须与「没给该字段」（undefined）区分开
    expect(v.correctedPlace).toBe("");
  });

  it("未给 correctedPlace → undefined（不覆盖原值）", async () => {
    const raw = JSON.parse(pass({ fixable: true, discrepancies: ["年龄错误"], correctedAge: 10, reason: "年龄需修正" })) as Record<string, unknown>;
    delete raw.correctedPlace; // 模型完全没给该字段
    mockReply(JSON.stringify(raw));
    const v = await verifyCanonEvent({ work: "作品", character: "我", event: "某事件", cfg });
    expect(v.passed).toBe(true);
    expect(v.correctedPlace).toBeUndefined();
  });

  it("不可采信（事件不存在）→ passed=false contradicted", async () => {
    mockReply(
      pass({
        supported: false,
        confidence: "high",
        discrepancies: ["该事件在原作中不存在，属于 AI 编造"],
        reason: "原作无此事件",
      }),
    );
    const v = await verifyCanonEvent({ work: "作品", character: "我", event: "编造事件", cfg });
    expect(v.passed).toBe(false);
    expect(v.verification).toBe("contradicted");
  });

  it("模型输出不可解析 → passed=false unverified", async () => {
    mockReply("完全不是 JSON");
    const v = await verifyCanonEvent({ work: "作品", character: "我", event: "某事", cfg });
    expect(v.passed).toBe(false);
    expect(v.verification).toBe("unverified");
  });

  it("核查调用抛错（超时/断网）→ passed=false unverified", async () => {
    mocks.callWithWebSearch.mockRejectedValue(new Error("事实核查 超时（200s）"));
    const v = await verifyCanonEvent({ work: "作品", character: "我", event: "某事", cfg });
    expect(v.passed).toBe(false);
    expect(v.verification).toBe("unverified");
    expect(v.reason).toContain("超时");
  });

  it("支持但无具体出处 → passed=false single-source", async () => {
    mockReply(pass({ basis: "", confidence: "low" }));
    const v = await verifyCanonEvent({ work: "作品", character: "我", event: "某事", cfg });
    expect(v.passed).toBe(false);
    expect(v.verification).toBe("single-source");
  });
});

describe("verifyRemoval 删除二次核查（P0-8）", () => {
  const base = {
    work: "进击的巨人",
    character: "艾伦",
    target: "三笠",
    event: { era: "845年", eventText: "我救出了三笠", feeling: "我不能失去她" },
    cfg,
  };

  it("确认删除（not-exist, high）→ confirmed", async () => {
    mockReply(JSON.stringify({ remove: true, category: "not-exist", confidence: "high", reason: "原作无此事件" }));
    const v = await verifyRemoval(base);
    expect(v.confirmed).toBe(true);
    expect(v.category).toBe("not-exist");
  });

  it("remove=false → 保守保留", async () => {
    mockReply(JSON.stringify({ remove: false, category: "keep", confidence: "high", reason: "事件真实" }));
    const v = await verifyRemoval(base);
    expect(v.confirmed).toBe(false);
    expect(v.category).toBe("keep");
  });

  it("低置信度 → 保守保留", async () => {
    mockReply(JSON.stringify({ remove: true, category: "unrelated", confidence: "low", reason: "也许无关" }));
    const v = await verifyRemoval(base);
    expect(v.confirmed).toBe(false);
  });

  it("类别不合规（keep）→ 保守保留", async () => {
    mockReply(JSON.stringify({ remove: true, category: "keep", confidence: "high", reason: "拿不准" }));
    const v = await verifyRemoval(base);
    expect(v.confirmed).toBe(false);
  });

  it("输出不可解析 → 保守保留", async () => {
    mockReply("我又不是 JSON");
    const v = await verifyRemoval(base);
    expect(v.confirmed).toBe(false);
    expect(v.reason).toContain("保守");
  });

  it("调用失败 → 保守保留", async () => {
    mocks.callWithWebSearch.mockRejectedValue(new Error("network down"));
    const v = await verifyRemoval(base);
    expect(v.confirmed).toBe(false);
    expect(v.reason).toContain("失败");
  });

  it("输出截断 → 保守保留", async () => {
    mockReply(JSON.stringify({ remove: true, category: "not-exist", confidence: "high", reason: "x" }), {
      truncated: true,
      finishReason: "length",
    });
    const v = await verifyRemoval(base);
    expect(v.confirmed).toBe(false);
    expect(v.reason).toContain("截断");
  });
});
