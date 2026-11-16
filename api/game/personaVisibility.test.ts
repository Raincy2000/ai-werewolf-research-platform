import { describe, expect, it } from "vitest";
import { buildPersonaCircleText, buildPostgamePersonaFactText, injectCircleText, type PersonaBondInfo } from "./personaVisibility";

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

  it("none：全员迷雾只陈述未知信息，不指导或禁止推测", () => {
    const t = buildPersonaCircleText(1, BINDINGS, "none", undefined)!;
    expect(t).toContain("所有玩家对你而言都是迷雾");
    expect(t).not.toContain("五条悟");
    expect(t).not.toContain("夏油杰");
    expect(t).not.toContain("自行推测");
    expect(t).not.toContain("不得假装确知");
    expect(t).toContain("人格身份不属于你的已知信息");
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

  it("full 可见时只提供人格事实与称呼信息，不附加认知或战术指导", () => {
    const t = buildPersonaCircleText(1, BINDINGS, "full", undefined)!;
    expect(t).toContain("已知人格的人格名与座位号均可用于称呼");
    expect(t).not.toContain("预判、游说、结盟或提防");
    expect(t).not.toContain("利用这一点");
    expect(t).not.toContain("如何影响你的理解、信任与选择由你决定");
    expect(t).toContain("迷雾玩家仅提供座位号");
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

describe("赛后人格出局对照", () => {
  it("直接绑定座位、人格名和出局时间，并遵守人格可见度", () => {
    const text = buildPostgamePersonaFactText(1, [
      { seat: 1, name: "两面宿傩" },
      { seat: 10, name: "夜神月" },
      { seat: 11, name: "张雪峰" },
    ], { 1: "第三日 · 被放逐", 10: "第三日 · 被放逐" }, "full", undefined);
    expect(text).toContain("10号夜神月=第三日 · 被放逐");
    expect(text).toContain("1号两面宿傩=第三日 · 被放逐");
    expect(text).toContain("11号张雪峰=存活至对局结束");
    const fog = buildPostgamePersonaFactText(1, [{ seat: 10, name: "夜神月" }], { 10: "第三日 · 被放逐" }, "none", undefined);
    expect(fog).not.toContain("夜神月");
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

describe("关系方向铁律（2026-10-14 用户裁定）", () => {
  it("人格只能知道自己对别人的感受，绝不能看到别人对自己的感受", () => {
    // PersonaBondInfo 在 service 层按「观察者=感受持有方」组装（getSeatBonds 只取 personaId=观察者的行）；
    // 本测试锁定渲染层：即便传入羁绊，文本也必须始终以「你→对方」陈述，绝无「对方→你」
    const bonds: PersonaBondInfo[] = [
      { seat: 3, name: "张雪峰", relation: "宿敌", affinity: -40, trust: 20, note: "首刀点我名" },
    ];
    const t = buildPersonaCircleText(1, BINDINGS, "full", undefined, bonds)!;
    expect(t).toContain("【你与在场人格的羁绊】"); // 主语永远是你
    expect(t).not.toMatch(/他对你|TA 对你|对你的(?:亲疏|信任|感受|评价)|眼中的你/); // 绝无反向视角措辞（「对你而言的迷雾」是合法固有措辞）
  });
});
