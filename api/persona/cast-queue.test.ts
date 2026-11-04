// ============================================================
// 铸魂生产队列测试（统一架构：单轮=入队1、批量=入队N、中途加入无缝衔接）
// 锁定：滚动并发窗（上限 2）、无队头阻塞、中途加入、排队终止不启动、失败不阻塞后续
// ============================================================

import { describe, it, expect, vi } from "vitest";

// 持久化查询层打桩（队列单测不碰库）
vi.mock("../queries/personas", () => ({
  upsertPersonaCastDraft: async () => {},
  listPersonaCastDrafts: async () => [],
  deletePersonaCastDraft: async () => {},
  setCastDraftStatus: async () => {},
  upsertCastCheckpoint: async () => {},
  listCastCheckpoints: async () => [],
  deleteCastCheckpoints: async () => {},
  listAllCastCheckpointParams: async () => [],
}));

const { enqueueCasts, castQueueDepth, castApiIdentity } = await import("./castQueue");
const { getCastProgress, castControl } = await import("./progress");

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 可控任务：返回 {开始 Promise, 放行 }——不放行则一直挂在检查点外 */
function controllable() {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  return { gate, release };
}

describe("铸魂生产队列", () => {
  it("滚动并发窗：同时最多 2 个在跑，走一个补一个（无队头阻塞）", async () => {
    const gates = [controllable(), controllable(), controllable(), controllable()];
    const done: string[] = [];
    enqueueCasts(
      "uq",
      gates.map((g, i) => ({
        name: `人格${i}`,
        run: async () => {
          await g.gate;
          done.push(`人格${i}`);
          return null; // 无产物（测试不碰草稿落库）
        },
      })),
    );
    await tick(30);
    expect(castQueueDepth().running).toBe(2); // 窗口上限
    expect(castQueueDepth().queued).toBe(2);
    // 放行 0 号：2 号补位（滚动，不等 1 号）
    gates[0]!.release();
    await tick(30);
    expect(done).toContain("人格0");
    expect(castQueueDepth().running).toBe(2);
    gates.forEach((g) => g.release());
    await tick(50);
    expect(done.length).toBe(4);
    expect(castQueueDepth()).toEqual({ queued: 0, running: 0 });
  });

  it("中途加入：跑着两个时再来一个单轮，入队排队、有空位即启动", async () => {
    const a = controllable();
    const b = controllable();
    const c = controllable();
    const done: string[] = [];
    enqueueCasts("um", [
      { name: "甲", run: async () => { await a.gate; done.push("甲"); return null; } },
      { name: "乙", run: async () => { await b.gate; done.push("乙"); return null; } },
    ]);
    await tick(30);
    expect(castQueueDepth().running).toBe(2);
    // 中途加入（单轮加入与批量同构）
    const [{ castId: cId }] = enqueueCasts("um", [
      { name: "丙", run: async () => { await c.gate; done.push("丙"); return null; } },
    ]);
    await tick(20);
    expect(getCastProgress(cId!)?.label).toContain("排队中"); // 排队亮卡
    expect(castQueueDepth().queued).toBe(1);
    a.release();
    await tick(30);
    expect(castQueueDepth().running).toBe(2); // 丙补位
    b.release();
    c.release();
    await tick(50);
    expect(done).toContain("丙");
  });

  it("排队中被终止：不启动、不占窗口", async () => {
    const a = controllable();
    const b = controllable();
    const done: string[] = [];
    const jobs = enqueueCasts("ux", [
      { name: "A", run: async () => { await a.gate; done.push("A"); return null; } },
      { name: "B", run: async () => { await b.gate; done.push("B"); return null; } },
      { name: "C", run: async () => { done.push("C"); return null; } },
    ]);
    await tick(30);
    // 终止排队中的 C（未起跑）
    castControl(jobs[2]!.castId, "ux", "cancel");
    a.release();
    b.release();
    await tick(60);
    expect(done).toContain("A");
    expect(done).toContain("B");
    expect(done).not.toContain("C"); // C 从未启动
  });

  it("任务失败不阻塞队列（错误落登记处，后续照常滚动）", async () => {
    const done: string[] = [];
    enqueueCasts("uf", [
      { name: "炸", run: async () => { throw new Error("铸造失败演示"); } },
      { name: "好", run: async () => { done.push("好"); return null; } },
      { name: "也好", run: async () => { done.push("也好"); return null; } },
    ]);
    await tick(80);
    expect(done).toEqual(["好", "也好"]);
    expect(castQueueDepth()).toEqual({ queued: 0, running: 0 });
  });
});

describe("按 API 身份分组调度（2026-10-14 用户裁定）", () => {
  const K = (s: string) => castApiIdentity({ provider: "kimi", baseUrl: "http://m", model: "m", apiKey: s });

  it("同 API 最多 2 个铸造；不同 API 可并行（两 API × 2 = 4 个同时跑）", async () => {
    const gates = Array.from({ length: 5 }, () => controllable());
    const done: string[] = [];
    // A A B B A：A 组第三个应排队
    const keys = [K("a"), K("a"), K("b"), K("b"), K("a")];
    enqueueCasts(
      "ug",
      gates.map((g, i) => ({
        name: `人格${i}`,
        apiKeys: [keys[i]!],
        run: async () => { await g.gate; done.push(`人格${i}`); return null; },
      })),
    );
    await tick(40);
    // 前 4 个（A×2+B×2）在跑，第 5 个（A）排队
    expect(castQueueDepth().running).toBe(4);
    expect(castQueueDepth().queued).toBe(1);
    gates[0]!.release(); // A 组空一位
    await tick(40);
    expect(done).toContain("人格0");
    expect(castQueueDepth().running).toBe(4); // 第 5 个（A）补位
    expect(castQueueDepth().queued).toBe(0);
    gates.forEach((g) => g.release());
    await tick(60);
    expect(done.length).toBe(5);
  });

  it("全局总闸 6：三个 API 各 3 个任务，最多 6 个同时跑", async () => {
    const gates = Array.from({ length: 9 }, () => controllable());
    const keys = Array.from({ length: 9 }, (_, i) => K(["x", "y", "z"][i % 3]!));
    enqueueCasts(
      "ug2",
      gates.map((g, i) => ({
        name: `P${i}`,
        apiKeys: [keys[i]!],
        run: async () => { await g.gate; return null; },
      })),
    );
    await tick(40);
    expect(castQueueDepth().running).toBe(6); // 全局总闸（每组额度 2×3=6，恰平）
    expect(castQueueDepth().queued).toBe(3);
    gates.forEach((g) => g.release());
    await tick(80);
    expect(castQueueDepth()).toEqual({ queued: 0, running: 0 });
  });

  it("API 身份区分密钥与模型（同模型不同 Key = 不同身份）", () => {
    expect(castApiIdentity({ provider: "kimi", baseUrl: "http://a", model: "m", apiKey: "k1" })).not.toBe(
      castApiIdentity({ provider: "kimi", baseUrl: "http://a", model: "m", apiKey: "k2" }),
    );
    expect(castApiIdentity({ provider: "kimi", baseUrl: "http://a", model: "m1", apiKey: "k" })).not.toBe(
      castApiIdentity({ provider: "kimi", baseUrl: "http://a", model: "m2", apiKey: "k" }),
    );
  });
});
