// 本地存档库（未登录态 localStorage 持久化）的纯逻辑测试
import { describe, expect, it } from "vitest";
import type { ApiPresetInput } from "@contracts/game";
import {
  PRESETS_STORAGE_KEY,
  createLocalPreset,
  deleteLocalPresets,
  loadLocalPresets,
  loadMirrorPresets,
  saveLocalPresets,
  saveMirrorPresets,
  updateLocalPreset,
  type StorageLike,
} from "@/lib/localPresets";

/** 内存版 StorageLike 替身（node 环境无 localStorage） */
function makeStorage(): StorageLike & { dump: () => Record<string, string> } {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    dump: () => Object.fromEntries(map),
  };
}

const INPUT: ApiPresetInput = {
  name: "测试存档",
  provider: "kimi",
  baseUrl: "https://api.example.com",
  model: "model-x",
  apiKey: "sk-test",
};

describe("本地存档库 localPresets", () => {
  it("空存储读取返回空数组", () => {
    expect(loadLocalPresets(makeStorage())).toEqual([]);
  });

  it("新建存档：id 为递减负数且新存档排最前", () => {
    const s = makeStorage();
    const a = createLocalPreset(INPUT, s);
    const b = createLocalPreset({ ...INPUT, name: "第二个" }, s);
    expect(a.id).toBe(-1);
    expect(b.id).toBe(-2);
    const list = loadLocalPresets(s);
    expect(list.map((p) => p.id)).toEqual([-2, -1]);
    expect(list[0].updatedAt).toBeTruthy();
  });

  it("更新存档：命中则合并字段且 id 不可被覆盖；未命中返回 null", () => {
    const s = makeStorage();
    const created = createLocalPreset(INPUT, s);
    const updated = updateLocalPreset(created.id, { name: "改名", model: "model-y" }, s);
    expect(updated).not.toBeNull();
    expect(updated!.id).toBe(created.id);
    expect(updated!.name).toBe("改名");
    expect(updated!.model).toBe("model-y");
    expect(updated!.apiKey).toBe(INPUT.apiKey); // 未 patch 的字段保持
    expect(updateLocalPreset(999, { name: "x" }, s)).toBeNull();
  });

  it("批量删除存档：返回剩余列表，清空后移除存储 key", () => {
    const s = makeStorage();
    const a = createLocalPreset(INPUT, s);
    const b = createLocalPreset({ ...INPUT, name: "第二个" }, s);
    const rest = deleteLocalPresets(new Set([a.id]), s);
    expect(rest.map((p) => p.id)).toEqual([b.id]);
    deleteLocalPresets(new Set([b.id]), s);
    expect(s.dump()[PRESETS_STORAGE_KEY]).toBeUndefined();
    expect(loadLocalPresets(s)).toEqual([]);
  });

  it("坏数据容错：非法 JSON / 非数组 / 缺字段条目均不抛出", () => {
    const s = makeStorage();
    s.setItem(PRESETS_STORAGE_KEY, "not-json{{{");
    expect(loadLocalPresets(s)).toEqual([]);
    s.setItem(PRESETS_STORAGE_KEY, JSON.stringify({ foo: 1 }));
    expect(loadLocalPresets(s)).toEqual([]);
    s.setItem(
      PRESETS_STORAGE_KEY,
      JSON.stringify([
        { id: -1, name: "好条目", provider: "kimi" },
        { id: "bad", name: "坏id" },
        null,
      ]),
    );
    const list = loadLocalPresets(s);
    expect(list).toHaveLength(1);
    expect(list[0].baseUrl).toBe(""); // 缺省字段补空串
  });

  it("覆盖写：saveLocalPresets 完整替换内容", () => {
    const s = makeStorage();
    const a = createLocalPreset(INPUT, s);
    saveLocalPresets([{ ...a, name: "覆盖后" }], s);
    expect(loadLocalPresets(s).map((p) => p.name)).toEqual(["覆盖后"]);
  });
});

describe("账户云端镜像（loadMirrorPresets/saveMirrorPresets）", () => {
  it("按账户隔离读写镜像，互不影响", () => {
    const s = makeStorage();
    const a = createLocalPreset(INPUT, s);
    saveMirrorPresets("u1", [a], s);
    saveMirrorPresets("u2", [], s);
    expect(loadMirrorPresets("u1", s).map((p) => p.name)).toEqual(["测试存档"]);
    expect(loadMirrorPresets("u2", s)).toEqual([]);
    expect(loadMirrorPresets("u3", s)).toEqual([]);
  });

  it("镜像与游客本地库使用不同 key，互不覆盖", () => {
    const s = makeStorage();
    const a = createLocalPreset(INPUT, s);
    saveMirrorPresets("u1", [a], s);
    expect(loadLocalPresets(s).length).toBe(1); // createLocalPreset 写的游客库
    saveLocalPresets([], s);
    expect(loadLocalPresets(s)).toEqual([]); // 清空游客库
    expect(loadMirrorPresets("u1", s).length).toBe(1); // 镜像仍在
  });

  it("空数组写入即移除镜像 key", () => {
    const s = makeStorage();
    const a = createLocalPreset(INPUT, s);
    saveMirrorPresets("u1", [a], s);
    saveMirrorPresets("u1", [], s);
    expect(loadMirrorPresets("u1", s)).toEqual([]);
    expect(Object.keys(s.dump()).some((k) => k.includes("mirror"))).toBe(false);
  });

  it("损坏数据安全返回空数组", () => {
    const s = makeStorage();
    s.setItem(`${PRESETS_STORAGE_KEY}.mirror.u1`, "{oops");
    expect(loadMirrorPresets("u1", s)).toEqual([]);
  });
});
