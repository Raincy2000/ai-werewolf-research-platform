import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";

function snapshot(seq: number, text: string) {
  return {
    events: [{
      seq, day: 1, phase: "postgame.discuss", type: "speech", actor: 1, actorLabel: "1号玩家",
      title: "赛后讨论", content: text, thought: null, meta: null, createdAt: new Date(0).toISOString(),
    }],
    decisions: [],
  };
}

describe("R5 开发环境认知快照对比命令", () => {
  it("读取前后快照并输出差值，没有拟真分或客户端依赖", () => {
    const dir = mkdtempSync(path.join(process.cwd(), ".cognition-compare-test-"));
    try {
      const before = path.join(dir, "before.json");
      const after = path.join(dir, "after.json");
      writeFileSync(before, JSON.stringify(snapshot(1, "旧版一句话。")));
      writeFileSync(after, JSON.stringify(snapshot(1, "新版回答。")));
      const output = execFileSync(process.execPath, ["scripts/cognition-compare.mjs", before, after], {
        cwd: process.cwd(), encoding: "utf8",
      });
      const report = JSON.parse(output);
      expect(report.before.language.spokenCharacterCount).toBe(5);
      expect(report.after.language.spokenCharacterCount).toBe(4);
      expect(report.diff.language.spokenCharacterCount).toBe(-1);
      expect(report.diff.source.sameEvents).toBe(false);
      expect(report).not.toHaveProperty("score");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
