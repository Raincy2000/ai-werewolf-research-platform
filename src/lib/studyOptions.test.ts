import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const home = readFileSync(new URL("../pages/Home.tsx", import.meta.url), "utf8");
const gameRoom = readFileSync(new URL("../pages/GameRoom.tsx", import.meta.url), "utf8");

describe("赛前学习界面", () => {
  it("提供三种独立来源选项", () => {
    expect(home).toContain("赛前学习");
    expect(home).toContain("对局历史");
    expect(home).toContain("经验指南");
    expect(home).toContain("图书馆");
    expect(home).toContain("studyHistoryEnabled");
    expect(home).toContain("studyGuideEnabled");
    expect(home).toContain("studyLibraryEnabled");
  });

  it("对局进度不再把学习限定为图书馆", () => {
    expect(gameRoom).not.toContain("各座位正在选读图书馆资料并写下学习心得");
    expect(gameRoom).not.toContain("个座位均已完成图书馆学习");
    expect(gameRoom).not.toContain("本局开启图书馆");
  });
});
