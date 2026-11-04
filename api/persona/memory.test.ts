import { describe, it, expect } from "vitest";
import {
  SELF_MECHANISM_VERSION,
  buildSituationSignature,
  composeRemembered,
  containsMechanismName,
  recallMemories,
  scoreMemory,
  situationMatch,
  valenceMatch,
  type MemoryItem,
} from "./memory";

const mem = (over: Partial<MemoryItem> & { id: number }): MemoryItem => ({
  type: "general",
  content: `记忆${over.id}`,
  strength: 50,
  valence: 0,
  emotionalWeight: 50,
  situationSignature: "game:day:seer:none",
  lifecycle: "active",
  ...over,
});

describe("记性：检索层（§4.10.4）", () => {
  it("H2 稳定排序：同分按 id 升序", () => {
    const items = [3, 1, 2].map((id) => mem({ id, strength: 50, content: `c${id}` }));
    const got = recallMemories(items, { k: 3 });
    expect(got.map((m) => m.id)).toEqual([1, 2, 3]);
  });

  it("归档记忆不参与检索（§4.10.5，不物理删除）", () => {
    const items = [mem({ id: 1, strength: 99 }), mem({ id: 2, strength: 10, lifecycle: "archived" })];
    const got = recallMemories(items, { k: 5 });
    expect(got.map((m) => m.id)).toEqual([1]);
  });

  it("编码特异性：签名一致者排名更前（**加权**而非硬过滤）", () => {
    // 同强度下，情境一致者应当反超 → 证明情境真在起作用
    const items = [
      mem({ id: 1, situationSignature: "game:night:wolf:high", strength: 60 }),
      mem({ id: 2, situationSignature: "game:day:seer:none", strength: 60 }),
    ];
    const got = recallMemories(items, { signature: "game:day:seer:none", k: 5 });
    expect(got.map((m) => m.id)).toEqual([2, 1]);
    expect(got.length).toBe(2); // 不再被硬过滤挡掉
  });

  it("情境一致性足够高时可越过强度差距", () => {
    const items = [
      mem({ id: 1, situationSignature: "game:good", strength: 80 }),
      mem({ id: 2, situationSignature: "game:good", strength: 55 }),
    ];
    const got = recallMemories(items, { signature: "game:good", k: 5 });
    expect(got.map((m) => m.id)).toEqual([1, 2]);
    // 无签名（历史数据）时退回纯强度排序——不奖不罚
    const legacy = [mem({ id: 1, strength: 80 }), mem({ id: 2, strength: 55 })];
    const got2 = recallMemories(legacy, { signature: "game:good", k: 5 });
    expect(got2.map((m) => m.id)).toEqual([1, 2]);
  });

  it("签名无命中时不返空（全部候选参与排序）", () => {
    const items = [mem({ id: 1, situationSignature: "a", strength: 10 }), mem({ id: 2, situationSignature: "b", strength: 90 })];
    const got = recallMemories(items, { signature: "不存在", k: 5 });
    expect(got.length).toBe(2);
    expect(got.map((m) => m.id)).toEqual([2, 1]);
  });

  it("situationMatch：按段计匹配率", () => {
    expect(situationMatch("game:good", "game:good")).toBe(1);
    expect(situationMatch("game:wolf", "game:good")).toBe(0.5);
    expect(situationMatch(null, "game:good")).toBe(0);
    expect(situationMatch("game:good", null)).toBe(0);
  });

  it("H1 纯函数：同输入必得同输出", () => {
    const items = [1, 2, 3, 4].map((id) => mem({ id, strength: id * 10 }));
    const a = recallMemories(items, { k: 3, affect: { valence: -0.5, arousal: 0.8 } });
    const b = recallMemories(items, { k: 3, affect: { valence: -0.5, arousal: 0.8 } });
    expect(a.map((m) => m.id)).toEqual(b.map((m) => m.id));
  });

  it("情绪一致性：效价接近当下情绪者得分更高", () => {
    const sad = mem({ id: 1, valence: -80, strength: 50 });
    const glad = mem({ id: 2, valence: 80, strength: 50 });
    const affect = { valence: -0.9, arousal: 0.5 };
    expect(scoreMemory(sad, { affect })).toBeGreaterThan(scoreMemory(glad, { affect }));
    expect(valenceMatch(-80, -0.9)).toBeGreaterThan(valenceMatch(80, -0.9));
  });
});

describe("记性：组装层（§4.10.2 命名硬规则）", () => {
  it("输出不含任何机制名", () => {
    const text = composeRemembered([mem({ id: 1, content: "5号当众把你票了出去" })], {
      concerns: ["你还没咽下那口气"],
    });
    expect(containsMechanismName(text)).toBeNull();
    expect(containsMechanismName("自传体记忆：...")).toBe("自传体");
    expect(containsMechanismName("记事簿：...")).toBe("记事簿");
  });

  it("默认完整保留被唤起的记忆，不再按 320 字静默截断", () => {
    const long = "啊".repeat(500);
    const text = composeRemembered([mem({ id: 1, content: long })]);
    expect(text).toContain(long);
  });

  it("显式预算下才按字符上限裁剪", () => {
    const long = "啊".repeat(500);
    const text = composeRemembered([mem({ id: 1, content: long })], { charCap: 120 });
    expect(text.length).toBeLessThanOrEqual(120);
  });

  it("空输入返回空串", () => {
    expect(composeRemembered([], {})).toBe("");
  });
});

describe("记性：情境签名与版本", () => {
  it("签名稳定可复现", () => {
    const a = buildSituationSignature({ phase: "day", day: 2, role: "seer", pressure: "high" });
    const b = buildSituationSignature({ phase: "day", day: 2, role: "seer", pressure: "high" });
    expect(a).toBe(b);
    expect(a).toContain("day");
  });
  it("机制版本已定义（D3）", () => {
    expect(SELF_MECHANISM_VERSION).toMatch(/^self-/);
  });
});
