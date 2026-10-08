import { describe, expect, it } from "vitest";
import { buildPersonaCircleText, injectCircleText, type PersonaBondInfo } from "./personaVisibility";

const BINDINGS = [
  { seat: 1, name: "艾伦·耶格尔", appearance: "黑发锐利眼神，制服笔挺，压迫感强" },
  { seat: 3, name: "张雪峰", appearance: "东北口音，语速快，表情夸张接地气" },
  { seat: 5, name: "五条悟", appearance: "白发眼罩，高挑慵懒，气场玩世不恭" },
  { seat: 7, name: "夏油杰", appearance: "黑长发束起，笑容温和眼神深沉" },
];

describe("玩家人格可见度（人格圈层知晓文本）", () => {
  it("full（默认）：列出其他全部有人格玩家姓名与外貌气质；自己不在列表", () => {
    const t = buildPersonaCircleText(1, BINDINGS, "full", undefined)!;
    expect(t).toContain("3号=张雪峰，外貌气质：东北口音，语速快，表情夸张接地气");
    expect(t).toContain("5号=五条悟，外貌气质：白发眼罩，高挑慵懒，气场玩世不恭");
    expect(t).toContain("7号=夏油杰");
    expect(t).not.toContain("1号=艾伦");
    expect(t).toContain("迷雾散开");
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
    expect(t).toContain("2号=夜神月，外貌气质：清秀冷峻，眼神锐利");
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

describe("人格圈层增强（基本印象/互称指引/羁绊注入）", () => {
  it("基本印象与出处随姓名共享（防性别/身份误读：张雪峰是「他」）", () => {
    const t = buildPersonaCircleText(1, [
      {
        seat: 3,
        name: "张雪峰",
        originSource: "现实人物",
        summary: "考研辅导名师，男性，东北人，以犀利直白的教育评论走红",
        appearance: "东北口音，语速快",
      },
    ], "full", undefined)!;
    expect(t).toContain("3号=张雪峰（现实人物）");
    expect(t).toContain("基本印象：考研辅导名师，男性");
    expect(t).toContain("外貌气质：东北口音");
  });

  it("full 可见时携带人格名互称与认知博弈指引", () => {
    const t = buildPersonaCircleText(1, BINDINGS, "full", undefined)!;
    expect(t).toContain("直呼已知人格的人格名");
    expect(t).toContain("预判、游说、结盟或提防");
    expect(t).toContain("人格只是参考"); // 人格不破博弈本体的护栏
    expect(t).toContain("对迷雾中的玩家仍按座位号称呼");
  });

  it("羁绊注入：记事簿关系行（亲疏/信任/注记）+ 原作渊源", () => {
    const bonds: PersonaBondInfo[] = [
      { seat: 5, name: "五条悟", relation: "亦敌亦友", affinity: 40, trust: 35, note: "上一局他把你归票出局" },
      { seat: 7, name: "夏油杰", relation: "", affinity: 0, trust: 0, note: "", origin: "你的档案记载着你们的渊源（「挚友，后决裂」）" },
      { seat: 9, name: "场外人格", relation: "信任", affinity: 80, trust: 90, note: "不在本局" },
    ];
    const t = buildPersonaCircleText(1, BINDINGS, "full", undefined, bonds)!;
    expect(t).toContain("【你与在场人格的羁绊】");
    expect(t).toContain("5号五条悟：亦敌亦友（亲疏40，信任35）——上一局他把你归票出局");
    expect(t).toContain("7号夏油杰：原作渊源——你的档案记载着你们的渊源");
    expect(t).not.toContain("场外人格"); // 不在场羁绊不注入
  });

  it("羁绊只注入可见人格：partial 下被雾者的羁绊不出现", () => {
    const bonds: PersonaBondInfo[] = [
      { seat: 3, name: "张雪峰", relation: "宿怨", affinity: -60, trust: 10, note: "旧账" },
      { seat: 5, name: "五条悟", relation: "信任", affinity: 70, trust: 80, note: "" },
    ];
    const t = buildPersonaCircleText(1, BINDINGS, "partial", [3], bonds)!;
    expect(t).toContain("5号五条悟：信任"); // 可见者的羁绊保留
    expect(t).not.toContain("宿怨"); // 被雾者的羁绊不注入（你都不知道 TA 是谁）
  });

  it("none 档：全员迷雾，羁绊与互称指引均不出现", () => {
    const bonds: PersonaBondInfo[] = [
      { seat: 3, name: "张雪峰", relation: "宿怨", affinity: -60, trust: 10, note: "旧账" },
    ];
    const t = buildPersonaCircleText(1, BINDINGS, "none", undefined, bonds)!;
    expect(t).not.toContain("羁绊");
    expect(t).not.toContain("张雪峰");
    expect(t).not.toContain("人格名");
  });

  it("信息壁垒：圈层文本绝不携带游戏身份词（狼/好人阵营不透）", () => {
    const bonds: PersonaBondInfo[] = [
      { seat: 5, name: "五条悟", relation: "信任", affinity: 70, trust: 80, note: "他是狼" },
    ];
    const t = buildPersonaCircleText(1, BINDINGS, "full", undefined, bonds)!;
    // 圈层语义只共享人格信息；身份壁垒文案在场
    expect(t).toContain("游戏身份你不清楚");
    // 注记原文虽被透传（用户数据），但羁绊行不得由系统引入身份判定——本用例锁定格式不主动添加
    expect(t).toContain("5号五条悟：信任（亲疏70，信任80）");
  });
});

describe("injectCircleText（注入位铁律：必须落在【输出契约】之前）", () => {
  const BASE = "【对局状态】第1天\n【公开记录】1. 2号发言\n【输出契约】严格输出 JSON……";
  it("契约前注入：圈层文本不被人格管线的契约截断切断（对局 20260930001 回归）", () => {
    const out = injectCircleText(BASE, "【人格圈层】3号=张雪峰");
    expect(out).toContain("【人格圈层】3号=张雪峰\n\n【输出契约】");
    expect(out.indexOf("人格圈层")).toBeLessThan(out.indexOf("【输出契约】"));
    expect(out).toContain("【对局状态】");
  });
  it("无契约标记时回退尾部追加（兜底不丢内容）", () => {
    const out = injectCircleText("仅情境无契约", "【人格圈层】X");
    expect(out).toBe("仅情境无契约\n\n【人格圈层】X");
  });
});
