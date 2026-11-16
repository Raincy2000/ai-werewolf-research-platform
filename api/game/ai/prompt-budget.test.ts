// prompt 长度预算测试（根治：moonshot-v1-8k 后期 prompt 超 8192 token → API 全 400 → 全托管）
// - 模型上下文映射正确
// - 8K 模型：长 log + 长指南下 prompt 总长控制在预算内（log/指南双向截断）
// - 32K 模型：log 仍封顶 12000（大模型不受影响）
// - 截断标记正确出现
import { describe, it, expect } from "vitest";
import type { PendingDecision, PlayerView } from "../engine/api";
import {
  buildPrompt,
  formatPublicLog,
  modelContextTokens,
  promptCharBudget,
} from "./prompts";

function makeView(publicLog: string[]): PlayerView {
  return {
    seat: 3,
    role: "seer",
    roleName: "预言家",
    camp: "god",
    day: 5,
    phase: "day.speech",
    aliveSeats: [1, 2, 3, 5, 6, 10],
    deadSeats: [4, 7, 8, 9, 11, 12],
    revealedRoles: {},
    sheriffSeat: 10,
    selfAlive: true,
    rules: { witchSelfSave: "never" },
    publicLog,
    private: { seerChecks: [{ seat: 5, result: "wolf" }] },
  };
}

function makePending(publicLog: string[]): PendingDecision {
  return {
    seat: 3,
    kind: "daySpeech",
    role: "seer",
    hint: "轮到您发言",
    options: [],
    allowSkip: false,
    view: makeView(publicLog),
  };
}

// 模拟后期规模的公开记录：170 条 × 约 78 字符 ≈ 13300 字符（超 12000 封顶与 8K 预算）
const LONG_LOG = Array.from(
  { length: 170 },
  (_, i) =>
    `${(i % 12) + 1}号玩家发言：上一轮${(i % 5) + 1}号的投票逻辑很矛盾，他先说相信3号是好人，最后却把票投给了3号，这种摇摆是典型的狼人行为，我认为应该重点怀疑并听其解释。`,
);
const LONG_GUIDE = "女巫可结合轮次与风险选择是否用药；警长可结合发言与票型选择归票对象。".repeat(120); // 约 5000+ 字符，全部为可保留的建议文本

describe("prompt 长度预算", () => {
  it("模型上下文映射：已知型号精确命中，未知型号保守 16K", () => {
    expect(modelContextTokens("moonshot-v1-8k")).toBe(8192);
    expect(modelContextTokens("moonshot-v1-32k")).toBe(32768);
    expect(modelContextTokens("moonshot-v1-128k")).toBe(131072);
    expect(modelContextTokens("deepseek-chat")).toBe(65536);
    expect(modelContextTokens("some-unknown-model")).toBe(16384);
  });

  it("模型上下文映射：kimi-k3 系命中 1M、k2.x 系命中 256K（人格双程管线不再静默降级）", () => {
    // 事故回归（对局 20260930001）：kimi-k3 不在表中按 16K 处理 →
    // shouldUseDualPipeline(16384)=false，心镜→涌现双程管线全程静默降级为单程（dual=false ×97）
    expect(modelContextTokens("kimi-k3")).toBe(1_048_576);
    expect(modelContextTokens("k3-256k")).toBe(1_048_576);
    expect(modelContextTokens("kimi-k2.6")).toBe(262_144);
    expect(modelContextTokens("kimi-k2.7-code")).toBe(262_144);
    // 双程管线阈值（≥32K）达标确认
    expect(modelContextTokens("kimi-k3")).toBeGreaterThanOrEqual(32_768);
    // kimi-k2 基础款仍是 131K（不被 k2.x 规则误吞）
    expect(modelContextTokens("kimi-k2")).toBe(131_072);
  });

  it("8K 模型：长 log + 长指南下 prompt 总长不超过预算（8192 token ≈ 8267 字符）", () => {
    const budget = promptCharBudget(8192);
    const { system, user } = buildPrompt(makePending(LONG_LOG), {
      guide: LONG_GUIDE,
      modelContext: modelContextTokens("moonshot-v1-8k"),
    });
    const total = system.length + user.length;
    expect(total).toBeLessThanOrEqual(budget);
    // log 与指南均被截断（带省略标记）
    expect(user).toContain("（早期记录已省略）");
    expect(user).toContain("（指南前文已省略）");
    // 关键决策信息仍在（截断不丢任务与私密信息）
    expect(user).toContain("【你的任务】");
    expect(user).toContain("你的验人记录");
  });

  it("32K 模型：log 封顶 12000 + 旧条目分层压缩（近期记录完整保留）", () => {
    const { user } = buildPrompt(makePending(LONG_LOG), {
      guide: LONG_GUIDE,
      modelContext: modelContextTokens("moonshot-v1-32k"),
    });
    // 分层压缩：170 条中最早 130 条逐条截断为 60 字摘要，最近 40 条完整保留
    //（断言带行号与换行边界：循环夹具中「1号…」是「131. 11号…」的子串，裸 not.toContain 会误中）
    expect(user).not.toContain(`\n1. ${LONG_LOG[0]}\n`); // 第 1 条不再完整出现
    expect(user).toContain(`\n1. ${LONG_LOG[0].slice(0, 60)}…\n`); // 而是 60 字摘要形式
    expect(user).toContain(LONG_LOG[LONG_LOG.length - 1]); // 最近一条完整在
    expect(user).not.toContain("（指南前文已省略）"); // 指南 5000+ < 预算 9653 不截断
    // 更大规模（400 条，压缩后仍超 12000）→ 触发总量封顶与「早期记录已省略」
    const LONGER_LOG = Array.from({ length: 400 }, (_, i) => LONG_LOG[i % LONG_LOG.length]);
    const { user: user2 } = buildPrompt(makePending(LONGER_LOG), {
      guide: LONG_GUIDE,
      modelContext: modelContextTokens("moonshot-v1-32k"),
    });
    expect(user2).toContain("（早期记录已省略）");
    expect(user2).toContain(LONGER_LOG[LONGER_LOG.length - 1]);
  });

  it("出局时间线进入状态区，不依赖长公开记录猜测死亡日期", () => {
    const pending = makePending([]);
    pending.view.deathTimeline = { 10: "第三日 · 被放逐", 2: "第二夜 · 被女巫毒杀" };
    const { user } = buildPrompt(pending);
    expect(user).toContain("【出局时间线】");
    expect(user).toContain("10号=第三日 · 被放逐");
    expect(user).toContain("2号=第二夜 · 被女巫毒杀");
  });

  it("赛后权威事实卡只列引擎事实，不指导玩家如何理解", () => {
    const pending = makePending([]);
    pending.kind = "postgameSpeak";
    pending.view.phase = "postgame.discuss";
    pending.view.deathTimeline = { 10: "第三日 · 被放逐" };
    const { user } = buildPrompt(pending);
    expect(user).toContain("【赛后权威事实卡】");
    expect(user).toContain("10号=第三日 · 被放逐");
    expect(user).not.toContain("不要沿用其错误");
    expect(user.indexOf("【赛后权威事实卡】")).toBeGreaterThan(user.indexOf("【你的任务】"));
    expect(user.indexOf("【赛后权威事实卡】")).toBeLessThan(user.indexOf("【输出契约】"));
  });

  it("发言契约只陈述阶段、顺序和合法可能，不指导或禁止身份推理", () => {
    const pending = makePending([]);
    pending.view.speech = {
      stage: "pkSpeech",
      orderedSeats: [4, 8],
      spokenSeats: [4],
      remainingSeats: [8],
      interruptedSeats: [2],
      mandatory: true,
      nextStages: { 4: ["lastWords", "postgame"], 8: ["lastWords", "postgame"], 2: ["daySpeech"] },
    };
    const { user } = buildPrompt(pending);
    expect(user).toContain("【发言与回应契约】");
    expect(user).toContain("pkSpeech");
    expect(user).toContain("已发言：4号");
    expect(user).toContain("待发言：8号");
    expect(user).toContain("中断：2号");
    expect(user).toContain("后续合法可能");
    expect(user).toContain("当前阶段已发言者不能在该阶段再次普通回应。");
    for (const text of ["不证明清白", "不得仅凭", "分析配合需要", "后续阶段是否存在", "不能提前预支", "【心理博弈】"]) {
      expect(user).not.toContain(text);
    }
  });

  it("资料原文不被运行时改写，且不再常驻角色策略参考", () => {
    const rawGuide = "预言家必须第一天起跳，绝不留到第二天。";
    const { user } = buildPrompt(makePending([]), { guide: rawGuide });
    expect(user).toContain(rawGuide);
    expect(user).not.toContain("可考虑第一天起跳");
    expect(user).not.toContain("【策略参考】");
  });

  it("发言风格与赛后参与方式由主体决定，不使用统一积极攻防指令", () => {
    const normal = buildPrompt(makePending([]));
    expect(normal.system).not.toContain("有立场、有逻辑攻防");
    const pending = makePending([]);
    pending.kind = "postgameSpeak";
    const postgame = buildPrompt(pending);
    expect(postgame.user).not.toContain("鼓励积极发言");
  });

  it("早期公开记录超限时保留完整编号索引，而不是无声丢弃", () => {
    const lines = Array.from({ length: 80 }, (_, i) => `[#${i + 1}] ${i + 1}号玩家发言：第${i + 1}条记录`);
    const text = formatPublicLog(lines, 300);
    expect(text).toContain("早期记录编号索引");
    expect(text).toContain("#1");
    expect(text).toContain("#40");
    expect(text).toContain("[#80]");
  });

  it("缺省 modelContext 按保守 16K 处理", () => {
    const budget = promptCharBudget(16384);
    const { system, user } = buildPrompt(makePending(LONG_LOG), { guide: LONG_GUIDE });
    expect(system.length + user.length).toBeLessThanOrEqual(budget);
  });
});
