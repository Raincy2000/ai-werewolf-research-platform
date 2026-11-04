// canonDiff 单元测试（解析 / 增量计划 / 顺序考证 / trace 透传，mock AI）
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ callWithWebSearch: vi.fn() }));
vi.mock("./caster", () => ({ callWithWebSearch: mocks.callWithWebSearch }));

const { parseDiffOps, parseOrder, planIncrementalDiff, verifyEventOrder } = await import("./canonDiff");

const cfg = { provider: "custom", baseUrl: "http://mock.local", model: "mock", apiKey: "k" } as never;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("parseDiffOps 增量计划解析", () => {
  it("解析 keep/correct/add/drop/remove 并过滤非法 op", () => {
    const text = JSON.stringify({
      ops: [
        { op: "keep", existingId: 1 },
        { op: "correct", existingId: 2, reason: "时间错", item: { era: "2005年", event: "改后", feeling: "感受" } },
        { op: "add", item: { era: "2007年", event: "新增", feeling: "感受" } },
        { op: "drop" },
        { op: "remove", existingId: 3, reason: "not-exist 原作不存在" },
        { op: "explode" },
      ],
    });
    const ops = parseDiffOps(text);
    expect(ops.map((o) => o.op)).toEqual(["keep", "correct", "add", "drop", "remove"]);
    expect(ops[1]!.existingId).toBe(2);
    expect(ops[2]!.item?.event).toBe("新增");
  });

  it("非 JSON / 空串 → []", () => {
    expect(parseDiffOps("oops")).toEqual([]);
    expect(parseDiffOps("")).toEqual([]);
  });

  it("非法 existingId（0/负数）丢弃", () => {
    const ops = parseDiffOps(JSON.stringify({ ops: [{ op: "keep", existingId: 0 }, { op: "keep", existingId: -5 }] }));
    expect(ops[0]!.existingId).toBeUndefined();
    expect(ops[1]!.existingId).toBeUndefined();
  });
});

describe("parseOrder 顺序解析", () => {
  it("解析 order/notes 并过滤非数字", () => {
    const r = parseOrder(JSON.stringify({ order: [3, 1, "2", 0], notes: "因果调整" }));
    expect(r?.order).toEqual([3, 1, 2, 0]);
    expect(r?.notes).toBe("因果调整");
  });
  it("非法 → null", () => {
    expect(parseOrder("not json")).toBeNull();
    expect(parseOrder(JSON.stringify({ order: [] }))).toBeNull();
  });
});

describe("planIncrementalDiff", () => {
  const existing = [
    { id: 1, era: "845年", age: 9, place: "希干希纳区", eventText: "我救出三笠", feeling: "害怕" },
  ];
  const candidates = [{ era: "850年", age: 15, place: "特罗斯特", event: "我救下阿尔敏", feeling: "决意" }];

  it("无已有记录/无候选 → null 且不调用 AI", async () => {
    expect(await planIncrementalDiff({ existing: [], candidates, cfg, work: "w", character: "c" })).toBeNull();
    expect(await planIncrementalDiff({ existing, candidates: [], cfg, work: "w", character: "c" })).toBeNull();
    expect(mocks.callWithWebSearch).not.toHaveBeenCalled();
  });

  it("正常计划 → 返回 ops", async () => {
    mocks.callWithWebSearch.mockResolvedValue({
      text: JSON.stringify({ ops: [{ op: "keep", existingId: 1 }, { op: "add", item: candidates[0] }] }),
      webSearched: false,
    });
    const ops = await planIncrementalDiff({ existing, candidates, cfg, work: "w", character: "c" });
    expect(ops?.length).toBe(2);
    // 调用参数：不联网、无 signal 时也保持既有协议
    expect(mocks.callWithWebSearch).toHaveBeenCalledWith(cfg, expect.any(String), expect.any(String), {
      web: false,
      signal: undefined,
    });
  });

  it("把 finishReason 写入 trace（调用方据此判定截断 → fallback）", async () => {
    mocks.callWithWebSearch.mockResolvedValue({
      text: JSON.stringify({ ops: [] }),
      webSearched: false,
      finishReason: "length",
      truncated: true,
    });
    const trace: { finishReason: string | null } = { finishReason: null };
    const ops = await planIncrementalDiff({ existing, candidates, cfg, work: "w", character: "c" }, { trace });
    expect(ops).toEqual([]);
    expect(trace.finishReason).toBe("length");
  });

  it("模型输出不可解析 → 空数组（由调用方 fallback）", async () => {
    mocks.callWithWebSearch.mockResolvedValue({ text: "不是 JSON", webSearched: false });
    const ops = await planIncrementalDiff({ existing, candidates, cfg, work: "w", character: "c" });
    expect(ops).toEqual([]);
  });
});

describe("verifyEventOrder", () => {
  const events = [
    { id: 1, era: "845年", event: "我救出三笠" },
    { id: 2, era: "850年", event: "我救下阿尔敏" },
  ];

  it("<2 条 → null 且不调用 AI", async () => {
    expect(await verifyEventOrder({ cfg, work: "w", character: "c", events: [events[0]!] })).toBeNull();
    expect(mocks.callWithWebSearch).not.toHaveBeenCalled();
  });

  it("返回 order 并透传 finishReason", async () => {
    mocks.callWithWebSearch.mockResolvedValue({
      text: JSON.stringify({ order: [2, 1], notes: "因果在前" }),
      webSearched: false,
      finishReason: "stop",
    });
    const trace: { finishReason: string | null } = { finishReason: null };
    const r = await verifyEventOrder({ cfg, work: "w", character: "c", events }, { trace });
    expect(r?.order).toEqual([2, 1]);
    expect(trace.finishReason).toBe("stop");
  });

  it("AI 输出截断 → 手写 JSON 解析失败为 null（调用方保留时间排序）", async () => {
    mocks.callWithWebSearch.mockResolvedValue({ text: '{"order":[2,', webSearched: false, finishReason: "length" });
    const r = await verifyEventOrder({ cfg, work: "w", character: "c", events });
    expect(r).toBeNull();
  });
});
