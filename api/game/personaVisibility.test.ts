import { describe, expect, it } from "vitest";
import { buildPersonaCircleText } from "./personaVisibility";

const BINDINGS = [
  { seat: 1, name: "艾伦·耶格尔", appearance: "黑发锐利眼神，制服笔挺，压迫感强" },
  { seat: 3, name: "张雪峰", appearance: "东北口音，语速快，表情夸张接地气" },
  { seat: 5, name: "五条悟", appearance: "白发眼罩，高挑慵懒，气场玩世不恭" },
  { seat: 7, name: "夏油杰", appearance: "黑长发束起，笑容温和眼神深沉" },
];

describe("玩家人格可见度（人格圈层知晓文本）", () => {
  it("full（默认）：列出其他全部有人格玩家姓名与外貌气质；自己不在列表", () => {
    const t = buildPersonaCircleText(1, BINDINGS, "full", undefined)!;
    expect(t).toContain("3号=张雪峰（外貌气质：东北口音，语速快，表情夸张接地气）");
    expect(t).toContain("5号=五条悟（外貌气质：白发眼罩，高挑慵懒，气场玩世不恭）");
    expect(t).toContain("7号=夏油杰");
    expect(t).not.toContain("1号=艾伦");
    expect(t).toContain("姓名与外貌气质");
    expect(t).toContain("迷雾");
    // undefined 等价 full（默认完全可见）
    expect(buildPersonaCircleText(1, BINDINGS, undefined, undefined)).toBe(t);
  });

  it("full：外貌气质缺失的座位回退为仅姓名", () => {
    const t = buildPersonaCircleText(1, [
      { seat: 2, name: "夜神月", appearance: "清秀冷峻，眼神锐利" },
      { seat: 4, name: "神秘人", appearance: null },
      { seat: 6, name: "无名氏" },
    ], "full", undefined)!;
    expect(t).toContain("2号=夜神月（外貌气质：清秀冷峻，眼神锐利）");
    expect(t).toContain("4号=神秘人");
    expect(t).toContain("6号=无名氏");
    expect(t).not.toContain("4号=神秘人（");
    expect(t).not.toContain("6号=无名氏（");
  });

  it("full：全场只有自己一个人格时，无圈层名单，全员迷雾", () => {
    const t = buildPersonaCircleText(1, [{ seat: 1, name: "艾伦·耶格尔" }], "full", undefined)!;
    expect(t).not.toContain("人格圈层");
    expect(t).toContain("迷雾");
  });

  it("partial：被上迷雾的人格玩家从他人名单消失；未上迷雾的仍可见", () => {
    const t = buildPersonaCircleText(1, BINDINGS, "partial", [3, 5])!;
    expect(t).toContain("7号=夏油杰"); // 未上迷雾仍可见
    expect(t).not.toContain("3号=张雪峰"); // 被上迷雾→不在名单
    expect(t).not.toContain("5号=五条悟");
    // 被雾者不在名单→落入迷雾句
    expect(t).toContain("迷雾");
  });

  it("partial：被上迷雾者自己知道自己在雾里；未被雾者无此提示", () => {
    const foggy = buildPersonaCircleText(3, BINDINGS, "partial", [3])!;
    expect(foggy).toContain("你自己处于迷雾状态");
    expect(foggy).toContain("其他玩家不知道你的人格");
    const clear = buildPersonaCircleText(5, BINDINGS, "partial", [3])!;
    expect(clear).not.toContain("你自己处于迷雾状态");
  });

  it("none：全员迷雾，不列任何姓名，可推测但不得假装确知", () => {
    const t = buildPersonaCircleText(1, BINDINGS, "none", undefined)!;
    expect(t).toContain("所有玩家对你而言都是迷雾");
    expect(t).not.toContain("五条悟");
    expect(t).not.toContain("夏油杰");
    expect(t).toContain("自行推测");
  });
});
