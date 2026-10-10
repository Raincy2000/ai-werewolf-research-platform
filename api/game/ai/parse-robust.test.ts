// parseDecision 鲁棒修复测试（DeepSeek 真实失败形态驱动）：
// 1) JSON 字符串值内原始换行/制表符（DeepSeek 高频失败形态）→ 转义后解析成功
// 2) 输出被截断（缺闭合引号/括号）→ 修补救回 thought/speech
// 3) 截断在键值中间 → 回退到完整键值边界
// 4) 围栏+前后解释文字 → 正常提取
// 5) 完全非 JSON → null（交兜底）
import { describe, it, expect } from "vitest";
import type { PendingDecision, PlayerView } from "../engine/api";
import { parseDecision, truncateSpeech } from "./parse";

const view: PlayerView = {
  seat: 3,
  role: "villager",
  roleName: "平民",
  camp: "villager",
  day: 2,
  phase: "day.speech",
  aliveSeats: [1, 2, 3, 5, 6],
  deadSeats: [4],
  revealedRoles: {},
  sheriffSeat: null,
  selfAlive: true,
  rules: { witchSelfSave: "never" },
  publicLog: [],
  private: {},
};

const pending: PendingDecision = {
  seat: 3,
  kind: "daySpeech",
  role: "villager",
  hint: "发言",
  options: [],
  allowSkip: false,
  view,
};

describe("parseDecision 鲁棒修复", () => {
  it("字符串值内原始换行（DeepSeek 形态）：转义后解析成功", () => {
    // speech 值里直接输出真实换行（未转义）——JSON.parse 严格报错，修复后应成功
    const raw = `{"thought": "5号很可疑", "speech": "我认为5号是狼人。
理由有三：第一他投票摇摆；
第二他发言划水。", "targets": [], "skip": false}`;
    const d = parseDecision(raw, pending);
    expect(d).not.toBeNull();
    expect(d!.speech).toContain("我认为5号是狼人");
    expect(d!.speech).toContain("理由有三");
  });

  it("输出被截断（缺闭合引号与括号）：修补救回", () => {
    const raw = `{"thought": "分析中：3号和7号对跳预言家，我倾向于相信3号因为他的验人逻辑连贯", "speech": "我信3号是真预言家，他的验人逻辑连贯，7号的`;
    const d = parseDecision(raw, pending);
    expect(d).not.toBeNull();
    expect(d!.speech).toContain("我信3号是真预言家");
  });

  it("截断在键值中间：回退到完整键值边界", () => {
    const raw = `{"thought": "完整的心理活动", "speech": "完整的发言内容", "tar`;
    const d = parseDecision(raw, pending);
    expect(d).not.toBeNull();
    expect(d!.thought).toBe("完整的心理活动");
    expect(d!.speech).toBe("完整的发言内容");
  });

  it("围栏+前后解释文字：正常提取", () => {
    const raw = `好的，作为3号玩家我来分析：\n\`\`\`json\n{"thought": "想想", "speech": "过麦，听后置位", "targets": []}\n\`\`\`\n以上是我的决策。`;
    const d = parseDecision(raw, pending);
    expect(d).not.toBeNull();
    expect(d!.speech).toBe("过麦，听后置位");
  });

  it("完全非 JSON：返回 null 交兜底", () => {
    expect(parseDecision("我不知道该怎么玩这个游戏……", pending)).toBeNull();
    expect(parseDecision("", pending)).toBeNull();
  });

  it("speech 在前完整写出、thought 被截断（DeepSeek 长推理截断形态）：speech 完整可用", () => {
    // 线上实锤形态：模型把 thought 写成推理小说超 token 上限被截；
    // 新契约 speech 最前，speech 已完整落出，截断的 thought 修补后整决策可用
    const raw = `{"speech":"我认为8号是悍跳狼，理由：他查杀4号平民的收益不成立，真预言家不会这么验。","thought":"昨天8号跳预言家，给4号发查杀。但4号的发言我听着像平民，如果8号是狼，他为什么要查杀一个平民？也有可能4号是狼自刀`;
    const d = parseDecision(raw, pending);
    expect(d).not.toBeNull();
    expect(d!.speech).toContain("我认为8号是悍跳狼");
    expect(d!.thought).toContain("昨天8号跳预言家");
  });

  it("正常 JSON 不受影响", () => {
    const d = parseDecision(
      JSON.stringify({ thought: "t", speech: "大家好我是好人", targets: [1] }),
      pending,
    );
    expect(d!.speech).toBe("大家好我是好人");
  });
});

describe("truncateSpeech（发言长度保护：句界收口，不再腰斩）", () => {
  // 测试辅助：剥括号段后的正文字数（与 parse.ts 内部口径一致）
  const spokenOnly = (s: string) => s.replace(/（[^）]*）|\([^)]*\)/g, "");
  // 事故回归（对局 20261009001）：硬 slice(0,300) 把人格发言从句中砍断，
  // 17 条人格发言 7 条恰好 300 字结尾无标点（「说不完话」观感）
  it("额度内原样保留", () => {
    expect(truncateSpeech("完整的发言。")).toBe("完整的发言。");
    expect(truncateSpeech("a".repeat(800))).toBe("a".repeat(800));
  });

  it("超额在句末标点处收口（不吐半句话）", () => {
    const head = "第一段完整发言。".repeat(20); // 160 字
    const tail = "第二段说到一半被砍";
    const s = truncateSpeech(head + tail, 100);
    expect(s).toBe("第一段完整发言。".repeat(12)); // 96 字，落在句界
    expect(s.endsWith("。")).toBe(true);
  });

  it("括号动作描写不计入字数：正文短则整段保留（含大段动作）", () => {
    const s = truncateSpeech(`${"（顿了顿，环视全场）".repeat(8)}话说到这里就完了。`, 60);
    expect(s).toContain("话说到这里就完了。");
    expect(s).toContain("（顿了顿，环视全场）");
  });

  it("括号豁免 + 正文超限：按正文计数定位后在句界收口", () => {
    const speech = `${"（皱眉）"}${"我是一条完整的发言句子。".repeat(70)}`; // 正文 840 字
    const s = truncateSpeech(speech);
    expect(spokenOnly(s).length).toBeLessThanOrEqual(800);
    expect(s.endsWith("。")).toBe(true);
    expect(s.startsWith("（皱眉）")).toBe(true); // 前置动作保留
  });

  it("前段几乎没有完整句子时退回硬切（防收口太靠前丢失内容）", () => {
    const s = truncateSpeech(`${"啊".repeat(150)}。`, 100);
    expect(s.length).toBe(100); // 句界在 150 字处（>max），且不足额度一半 → 硬切
  });

  it("parseDecision 长发言：人格 600 字级发言完整保留，超 800 句界收口", () => {
    const speech = `${"我是一条完整的发言句子。".repeat(70)}`; // 840 字
    const d = parseDecision(JSON.stringify({ thought: "t", speech }), pending);
    expect(d!.speech!.length).toBeLessThanOrEqual(800);
    expect(d!.speech!.endsWith("。")).toBe(true);
    // 600 字内的发言不再被砍（旧逻辑 300 硬切的回归锚点）
    const mid = "我是一条完整的发言句子。".repeat(50); // 600 字
    const d2 = parseDecision(JSON.stringify({ thought: "t", speech: mid }), pending);
    expect(d2!.speech).toBe(mid);
  });
});
