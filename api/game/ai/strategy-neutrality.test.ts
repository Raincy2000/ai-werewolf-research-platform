import { describe, expect, it, vi } from "vitest";
import { ROLE_META, type GameSnapshot, type RoleId } from "../../../contracts/game";
import type { PendingDecision } from "../engine/api";
import { buildPrompt, KIND_GUIDE } from "./prompts";
import {
  buildAnalysisPrompt,
  buildBoardDistillPrompt,
  buildCommonDistillPrompt,
  buildHistoryRefPrompt,
  buildStudyPrompt,
  runAnalysis,
  runDistillBoard,
  runDistillCommon,
} from "../analyst";
import { createEngine } from "../engine/index";

vi.mock("./providers", () => ({
  callAi: async () => ({
    ok: true,
    text: "# 复盘\n## 六、经验教训\n- 第一天必须起跳报验，抢轮次。",
    latencyMs: 1,
    error: null,
  }),
}));

function pending(role: RoleId, kind: PendingDecision["kind"]): PendingDecision {
  return {
    seat: 3,
    role,
    kind,
    options: [0, 1],
    allowSkip: true,
    hint: "请结合局势独立判断",
    view: {
      seat: 3,
      role,
      roleName: ROLE_META[role].name,
      camp: ROLE_META[role].camp,
      day: 1,
      phase: kind === "sheriffSpeech" ? "day.sheriff.speech" : "day.speech",
      aliveSeats: [1, 2, 3, 4, 5, 6, 7, 8, 9],
      deadSeats: [],
      revealedRoles: {},
      sheriffSeat: null,
      selfAlive: true,
      publicLog: [],
      private: { seerChecks: [{ seat: 4, result: "wolf" }] },
    },
  };
}

const SNAPSHOT: GameSnapshot = {
  gameId: "neutral-test",
  boardId: "standard9",
  boardName: "9人标准局（暗牌）",
  titleNo: "20261105001",
  status: "finished",
  day: 1,
  phase: "finished",
  phaseLabel: "对局已结束",
  players: [],
  winner: "good",
  seq: 0,
  pendingSeat: null,
  pendingKind: null,
  pendingSeats: [],
  pendingActs: [],
  phaseBreaking: "none",
  phaseBreakTotalMs: 0,
  phaseBreakStartedAt: 0,
  speechRoundsLimit: 2,
  createdAt: new Date().toISOString(),
};

describe("策略表达中立化", () => {
  it("竞选提示只给合法动作与流程，不指导公开或保留身份", () => {
    const { system, user } = buildPrompt(pending("seer", "sheriffSpeech"));
    const text = `${system}\n${user}`;
    for (const forbidden of ["【策略参考】", "【心理博弈】", "不要假设、不要编造", "自由形成", "不该反水", "把精力放在最新变化上", "是否公开是你的策略选择"]) {
      expect(text).not.toContain(forbidden);
    }
    expect(KIND_GUIDE.sheriffSpeech).toBe("发表警上竞选发言，speech 必填。发言结束后进入退水环节。");
  });

  it("全部角色都不注入角色策略参考，只保留任务与输出契约", () => {
    for (const role of Object.keys(ROLE_META) as RoleId[]) {
      const text = buildPrompt(pending(role, "daySpeech")).user;
      expect(text, role).not.toContain("【策略参考】");
      expect(text, role).not.toContain("【心理博弈】");
      expect(text, role).toContain("【你的任务】");
      expect(text, role).toContain("【输出契约】");
    }
  });

  it("上警、竞选发言与退水只描述选项和规则结果", () => {
    expect(KIND_GUIDE.sheriffRun).toContain("targets=[1]=上警参与竞选");
    expect(KIND_GUIDE.sheriffRun).toContain("targets=[0]=留在警下投票");
    expect(KIND_GUIDE.sheriffWithdraw).toContain("targets=[0]=继续竞选");
    expect(KIND_GUIDE.sheriffWithdraw).toContain("targets=[1]=退水");
    for (const text of [KIND_GUIDE.sheriffRun, KIND_GUIDE.sheriffSpeech, KIND_GUIDE.sheriffWithdraw, KIND_GUIDE.sheriffVote, KIND_GUIDE.sheriffOrder, KIND_GUIDE.badgePass, KIND_GUIDE.wolfDiscuss]) {
      for (const forbidden of ["独立判断", "暴露风险", "可信者", "可疑者", "信息可靠", "伪装策略", "无优劣预设", "公开成本", "竞选意愿", "带节奏"]) {
        expect(text).not.toContain(forbidden);
      }
    }
  });

  it("指南与赛前心得保留原文，不附加系统理解指令", () => {
    const text = buildPrompt(pending("seer", "daySpeech"), {
      guide: "- 第一天必须起跳报验，抢轮次。",
      studyNote: "- 我不为藏锋不上警。",
    }).user;
    expect(text).toContain("第一天必须起跳报验");
    expect(text).toContain("我不为藏锋不上警");
    expect(text).not.toContain("可考虑起跳");
    expect(text).not.toContain("可因藏锋留在警下");
    expect(text).not.toContain("只作情境化建议");
    expect(text).not.toContain("不必照搬");
  });

  it("否定式资料与官方硬规则都保留原文，不做现场语义替换", () => {
    const text = buildPrompt(pending("witch", "daySpeech"), {
      guide: "- 女巫不应该盲毒。\n- 官方规则：同一晚只能使用一瓶药。",
    }).user;
    expect(text).toContain("女巫不应该盲毒");
    expect(text).not.toContain("可谨慎避免盲毒");
    expect(text).toContain("官方规则：同一晚只能使用一瓶药。");
  });

  it("绝对化资料不被静默删除，角色技能限制仍保留", () => {
    const text = buildPrompt(pending("seer", "daySpeech"), {
      guide: "- 警徽流绝不能留队友。\n- 不能连续两夜恐惧同一人。",
    }).user;
    expect(text).toContain("警徽流绝不能留队友");
    expect(text).toContain("不能连续两夜恐惧同一人");
  });

  it("资料中的固定时机与强制动作保留原文，不由正则决定其语义", () => {
    const text = buildPrompt(pending("seer", "daySpeech"), {
      guide: "- 只应在狼面极高时决斗。\n- 验出狼时立即报点。\n- 首夜救过人就可在白天尽早主动报出。\n- 应明确验人范围。",
    }).user;
    expect(text).toContain("只应在狼面极高时决斗");
    expect(text).toContain("验出狼时立即报点");
    expect(text).toContain("应明确验人范围");
    expect(text).not.toContain("可考虑在狼面极高时决斗");
    expect(text).not.toContain("可在合适时机");
  });

  it("官方规则与策略混排时保留完整原文，不做静默删改", () => {
    const text = buildPrompt(pending("witch", "daySpeech"), {
      guide: "- 解药不能自救，首夜有人中刀可尽早用药。",
    }).user;
    expect(text).toContain("解药不能自救");
    expect(text).toContain("尽早用药");
    expect(text).not.toContain("选择合适时机");
  });

  it("复盘、指南、历史参考和学习生成都明确禁止把单一打法写成固定答案", () => {
    const contexts = [
      buildAnalysisPrompt(SNAPSHOT, []).user,
      buildCommonDistillPrompt(null, "历史报告").user,
      buildBoardDistillPrompt({ boardName: "标准局", rolesSummary: "预言家", rulesText: "规则" }, null, "历史报告").user,
      buildHistoryRefPrompt(3, "预言家", "标准局", "摘要").user,
      buildStudyPrompt(3, "标准局", "材料", "预言家").user,
    ];
    for (const text of contexts) {
      expect(text).toContain("不得把单个案例或高频打法概括为固定答案");
      expect(text).toContain("反例");
    }
  });

  it("历史复盘只提供适用边界与收益反转条件，不预定本局行动", () => {
    const { system, user } = buildHistoryRefPrompt(3, "预言家", "白狼王骑士", "摘要");
    const text = `${system}\n${user}`;
    expect(text).toContain("本局行动方案");
    expect(text).toContain("不适用边界");
    expect(text).toContain("收益反转");
  });

  it("实际生成的复盘和指南会解除旧输出中的强制策略", async () => {
    const cfg = { seat: 0, provider: "kimi" as const, baseUrl: "http://test.local", model: "test", apiKey: "test" };
    const report = await runAnalysis(cfg, SNAPSHOT, []);
    expect(report).toContain("可考虑起跳");
    expect(report).not.toContain("必须起跳");
    const common = await runDistillCommon(cfg, null, "历史报告");
    expect(common).toContain("可考虑起跳");
    expect(common).not.toContain("必须起跳");
    const board = await runDistillBoard(cfg, { boardName: "标准局", rolesSummary: "预言家", rulesText: "规则" }, null, "历史报告");
    expect(board).toContain("可考虑起跳");
    expect(board).not.toContain("必须起跳");
  });

  it("引擎的竞选报名提示只描述选项、流程与警徽流失条件", () => {
    const roles: RoleId[] = ["seer", "witch", "hunter", "villager", "villager", "villager", "werewolf", "werewolf", "werewolf"];
    const engine = createEngine({ boardId: "standard9", seatRoles: roles, options: { sheriffEnabled: true, stepDelayMs: 0, allowSelfDestruct: true, speechRoundsLimit: 2 } });
    let hint = "";
    for (let i = 0; i < 80 && !hint; i++) {
      const { pending: p } = engine.advance();
      if (!p) continue;
      if (p.kind === "sheriffRun") {
        hint = p.hint;
        break;
      }
      if (p.batch) {
        engine.decide({ thought: "t", batchInputs: p.batch.map((sub) => ({ thought: "t", speech: "测试", targets: [sub.options[0] ?? 0] })) });
      } else {
        engine.decide({ thought: "t", speech: "测试", targets: p.options.length ? [p.options[0]] : undefined, skip: p.allowSkip ? true : undefined });
      }
    }
    expect(hint).toContain("targets=[1]=上警参与竞选");
    expect(hint).toContain("targets=[0]=留在警下投票");
    expect(hint).toContain("若最终全员留任，警下无人投票，警徽流失");
    for (const forbidden of ["独立判断", "公开成本", "竞选意愿", "暴露风险", "合理选择"]) {
      expect(hint).not.toContain(forbidden);
    }
  });
});
