// ============================================================
// 分析师流水线（重构后）测试
// - logDigest：确定性摘要（长对局 ≤6000 字且身份表/胜负/末日复盘完整；空对局不炸；截断规则）
// - buildAnalysisPrompt：总长 ≤7000 字，六段输出要求
// - runAnalysis/runDistillCommon/runDistillBoard：callAi 传 { jsonMode:false, timeoutMs:600s, maxRetries:2 }
// - service 分段流水线：analyze→distill→done 阶段流转 + 内存检查点（analyze 完成即落库）
// - 自愈：running 任务 60s 无心跳 → getAnalysis 触发复活，有 report 检查点只重跑 distill
// - 终局自动分析接线 / 经验指南注入（buildPrompt）
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ROLE_META } from "../../../contracts/game";
import type {
  AnalysisJobStage,
  AnalystAiConfig,
  GameEvent,
  GameSnapshot,
  RoleId,
} from "../../../contracts/game";
import type { DecisionInput, PendingDecision } from "../engine/api";

// ---------- 共享 mock 状态（vi.hoisted 保证在 mock factory 前初始化） ----------
const h = vi.hoisted(() => ({
  games: new Map<string, Record<string, unknown>>(),
  events: [] as Record<string, unknown>[],
  decisions: [] as Record<string, unknown>[],
  guides: [] as Record<string, unknown>[],
  analyses: new Map<string, Record<string, unknown>>(),
  aiQueue: [] as (string | Promise<string>)[], // 脚本化 AI：依序吐出
  aiCalls: [] as { system: string; user: string; opts?: unknown }[],
  engine: null as ReturnType<typeof makeFakeEngine> | null,
}));

vi.mock("../../queries/games", () => ({
  countGamesOnDate: async () => 0,
  insertGame: async (row: Record<string, unknown>) => {
    // 模拟 DB defaultNow：createdAt/updatedAt 由数据库填默认值
    h.games.set(row.id as string, { createdAt: new Date(), updatedAt: new Date(), ...row });
  },
  updateGame: async (id: string, patch: Record<string, unknown>) => {
    const g = h.games.get(id);
    if (g) Object.assign(g, patch);
  },
  getGame: async (id: string) => h.games.get(id) ?? null,
  listGames: async (_userId: string) => [...h.games.values()],
  appendEvents: async (rows: Record<string, unknown>[]) => {
    h.events.push(...rows);
  },
  getEventsAfter: async (gameId: string, afterSeq: number) =>
    h.events.filter((e) => e.gameId === gameId && (e.seq as number) > afterSeq),
  getAllEvents: async (gameId: string) => h.events.filter((e) => e.gameId === gameId),
}));

// 决策日志内存化（与 winrate/recovery 等测试同一模式）：
// 真实 appendDecision 直连 TiDB，本地无 VPC 网络时会挂起至超时、拖垮对局循环
vi.mock("../../queries/decisions", () => ({
  appendDecision: async (row: Record<string, unknown>) => {
    h.decisions.push({ ...row });
  },
  getDecisions: async (gameId: string) =>
    h.decisions
      .filter((d) => d.gameId === gameId)
      .sort((a, b) => (a.idx as number) - (b.idx as number)),
}));

vi.mock("../../queries/guide", () => {
  // 行内 scope 缺省视为 "common"（模拟 DB 默认值）
  const scopeOf = (g: Record<string, unknown>) => (g.scope as string | undefined) ?? "common";
  return {
    getLatestGuide: async (_userId: string, scope: string) =>
      h.guides
        .filter((g) => scopeOf(g) === scope)
        .sort((a, b) => (b.version as number) - (a.version as number))[0] ?? null,
    countGuides: async (_userId: string, scope: string) => h.guides.filter((g) => scopeOf(g) === scope).length,
    insertGuideVersion: async (row: Record<string, unknown>) => {
      h.guides.push({ createdAt: new Date(), ...row });
    },
    listGuideVersions: async (_userId: string, scope: string, limit = 50) =>
      h.guides
        .filter((g) => scopeOf(g) === scope)
        .sort((a, b) => (b.version as number) - (a.version as number))
        .slice(0, limit),
    getGuideVersion: async (_userId: string, scope: string, version: number) =>
      h.guides.find((g) => scopeOf(g) === scope && g.version === version) ?? null,
    listGuideScopes: async (_userId: string) => [...new Set(h.guides.map((g) => scopeOf(g)))],
    upsertAnalysis: async (gameId: string, report: string, model: string) => {
      h.analyses.set(gameId, { gameId, report, model, createdAt: new Date() });
    },
    getAnalysis: async (gameId: string) => h.analyses.get(gameId) ?? null,
  };
});

vi.mock("./providers", () => ({
  callAi: async (_cfg: unknown, system: string, user: string, opts?: unknown) => {
    h.aiCalls.push({ system, user, opts });
    const next = h.aiQueue.shift();
    if (next == null) return { ok: false, text: null, latencyMs: 1, error: "queue empty" };
    const text = typeof next === "string" ? next : await next;
    return { ok: true, text, latencyMs: 1, error: null };
  },
}));

vi.mock("../engine/index", () => ({
  createEngine: () => h.engine,
}));

// ---------- 假引擎：一次决策后结束对局（用于终局自动分析接线测试） ----------
function makeFakeEngine() {
  const state = { finished: false, decided: [] as DecisionInput[] };
  return {
    state,
    getSnapshot: () => ({
      day: 1,
      phase: "night.witch",
      phaseLabel: "夜晚 · 女巫行动",
      // 与真实引擎一致：分出胜负（endGame）前 winner 为 null，服务层据此做「分出胜负即落库」判定
      winner: (state.finished ? "wolf" : null) as "wolf" | "good" | null,
      finished: state.finished,
      pendingSeat: 3,
      players: [],
    }),
    advance: () => ({
      events: [
        {
          day: 1,
          phase: "night.witch",
          type: "phase" as const,
          actor: null,
          title: "女巫行动",
          content: "女巫请睁眼",
          thought: null,
          meta: null,
        },
      ],
      pending: state.finished ? null : witchPending,
    }),
    decide: (input: DecisionInput) => {
      state.decided.push(input);
      state.finished = true;
      return [
        {
          day: 1,
          phase: "night.witch",
          type: "action" as const,
          actor: 3,
          title: "夜间行动",
          content: "女巫行动完毕",
          thought: input.thought ?? null,
          meta: null,
        },
      ];
    },
    isFinished: () => state.finished,
  };
}

const witchPending: PendingDecision = {
  seat: 3,
  role: "witch",
  kind: "witchAction",
  options: [1, 2, 5],
  allowSkip: true,
  hint: "今夜被刀的是 2号，是否用药？",
  view: {
    seat: 3,
    role: "witch",
    roleName: "女巫",
    camp: "god",
    day: 1,
    phase: "night.witch",
    aliveSeats: [1, 2, 3, 4, 5, 6, 7, 8, 9],
    deadSeats: [],
    revealedRoles: {},
    sheriffSeat: null,
    selfAlive: true,
    publicLog: [],
    private: { witchPotions: { save: true, poison: true }, witchVictimTonight: 2 },
  },
};

// ---------- 测试夹具 ----------
const SEAT_ROLES: RoleId[] = [
  "seer",
  "witch",
  "hunter",
  "villager",
  "villager",
  "villager",
  "werewolf",
  "werewolf",
  "werewolf",
];

const SNAPSHOT: GameSnapshot = {
  gameId: "g-snap",
  boardId: "standard9",
  boardName: "9人标准局（暗牌）",
  titleNo: "20260804001",
  status: "finished",
  day: 3,
  phase: "finished",
  phaseLabel: "对局已结束",
  players: SEAT_ROLES.map((role, i) => ({
    seat: i + 1,
    role,
    roleName: ROLE_META[role].name,
    camp: ROLE_META[role].camp,
    alive: i % 3 !== 0,
    sheriff: i === 0,
    deathInfo: i % 3 === 0 ? "第1夜被刀" : null,
    aiModel: "mock-model",
  })),
  winner: "wolf",
  seq: 100,
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

let evSeq = 0;
function makeEvent(partial: Partial<GameEvent> & Pick<GameEvent, "type" | "content">): GameEvent {
  return {
    seq: ++evSeq,
    day: 1,
    phase: "day.speech",
    actor: 1,
    actorLabel: "1号玩家",
    title: partial.type === "speech" ? "公开发言" : "放逐投票",
    thought: null,
    meta: null,
    createdAt: new Date().toISOString(),
    ...partial,
  };
}

// 长对局：8 天 ×（夜间行动 + 死亡公告 + 36 条长发言 + 投票 + 结果），共 400+ 事件
function makeLongGameEvents(): GameEvent[] {
  const events: GameEvent[] = [];
  let seq = 0;
  const push = (
    partial: Partial<GameEvent> & Pick<GameEvent, "type" | "content" | "day" | "phase">,
  ) => {
    events.push({
      seq: ++seq,
      actor: null,
      actorLabel: null,
      title: "",
      thought: null,
      meta: null,
      createdAt: new Date().toISOString(),
      ...partial,
    });
  };
  for (let day = 1; day <= 8; day++) {
    // 夜间行动（狼刀/女巫/验人）
    push({
      day, phase: "night.wolf", type: "action", actor: 7, actorLabel: "7号玩家",
      title: "狼刀投票", content: `7号狼人选择袭击${(day % 9) + 1}号玩家。`,
      thought: `第${day}夜刀人理由：` + "狼".repeat(60),
    });
    push({
      day, phase: "night.wolf", type: "action",
      title: "狼刀落定", content: `狼队最终决定袭击${(day % 9) + 1}号玩家。`,
    });
    push({
      day, phase: "night.witch", type: "action", actor: 2, actorLabel: "2号玩家",
      title: "解药", content: `女巫使用解药救${(day % 9) + 1}号玩家。`, thought: "救人理由",
    });
    push({
      day, phase: "night.seer", type: "action", actor: 1, actorLabel: "1号玩家",
      title: "预言家查验", content: `预言家查验${(day % 9) + 1}号玩家，结果为【狼人】。`,
      thought: "验人理由",
    });
    // 死亡公告
    push({
      day, phase: "day.dawn", type: "death", title: "死亡公告",
      content: day % 2 ? `昨夜${day}号玩家死亡。` : "昨夜平安夜，无人死亡。",
    });
    // 白天发言：9 人 × 4 轮，每条 300 字正文 + 120 字心理
    for (let round = 0; round < 4; round++) {
      for (let seat = 1; seat <= 9; seat++) {
        push({
          day, phase: "day.speech", type: "speech", actor: seat, actorLabel: `${seat}号玩家`,
          title: "公开发言",
          content: `第${day}天第${round + 1}轮${seat}号发言：` + "言".repeat(300),
          thought: "心".repeat(120),
        });
      }
    }
    // 放逐投票（含心理）+ 投票结果 + 放逐结果 + 出局公告
    for (let seat = 1; seat <= 9; seat++) {
      push({
        day, phase: "day.vote", type: "vote", actor: seat, actorLabel: `${seat}号玩家`,
        title: "放逐投票",
        content: seat === 9 ? `9号玩家弃票。` : `${seat}号玩家投给${((seat + day) % 9) + 1}号。`,
        thought: `第${day}天投票理由`,
      });
    }
    push({ day, phase: "day.vote", type: "vote", title: "投票结果", content: `${day}号5票，${day + 1}号3票` });
    push({ day, phase: "day.vote", type: "vote", title: "放逐结果", content: `${day}号玩家被放逐。` });
    push({ day, phase: "day.vote", type: "death", title: "死亡公告", content: `${day}号玩家被放逐出局。` });
  }
  push({
    day: 8, phase: "game.over", type: "result", title: "游戏结果",
    content: "狼人阵营胜利！1号【预言家】出局，7号【狼人】存活",
  });
  return events;
}

const LONG_SNAPSHOT: GameSnapshot = { ...SNAPSHOT, day: 8 };

const ANALYST: AnalystAiConfig = {
  provider: "kimi",
  baseUrl: "http://mock.local/v1",
  model: "analyst-model",
  apiKey: "sk-analyst",
};

// 账户体系：全部服务调用需携带归属用户（单用户测试夹具统一用 U1）
const U1 = "u-test";

function insertFinishedGame(gameId: string): void {
  h.games.set(gameId, {
    id: gameId,
    userId: U1,
    boardId: "standard9",
    boardName: "9人标准局（暗牌）",
    status: "finished",
    winner: "wolf",
    dayCount: 2,
    playerCount: 9,
    setup: {
      seatRoles: SEAT_ROLES,
      seatModels: SEAT_ROLES.map(() => "mock-model"),
      options: { stepDelayMs: 5, sheriffEnabled: false, allowSelfDestruct: true, speechRoundsLimit: 2 },
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  h.events.push(
    {
      gameId, seq: 1, day: 1, phase: "day.speech", type: "speech", actor: 1,
      actorLabel: "1号玩家", title: "公开发言", content: "我是好人，过。", thought: "其实我是狼", meta: null,
    },
    {
      gameId, seq: 2, day: 1, phase: "day.vote", type: "vote", actor: null,
      actorLabel: null, title: "投票结果", content: "5号 4票出局", thought: null, meta: null,
    },
  );
}

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("waitFor 超时");
}

// ---------- 延迟加载被测模块（等 mock 注册完毕） ----------
const { gameService, analysisJobs, guideCache, getCachedGuideText } = await import("../service");
const {
  buildAnalysisPrompt,
  buildCommonDistillPrompt,
  buildBoardDistillPrompt,
  buildBoardRulesText,
  runAnalysis,
  runDistillCommon,
  runDistillBoard,
  ANALYSIS_TOTAL_CHAR_LIMIT,
  ANALYST_TIMEOUT_MS,
  ANALYST_MAX_RETRIES,
} = await import("../analyst");
const { buildLogDigest, LOG_DIGEST_CHAR_LIMIT } = await import("../logDigest");
const { buildPrompt } = await import("./prompts");

beforeEach(() => {
  h.games.clear();
  h.events.length = 0;
  h.decisions.length = 0;
  h.guides.length = 0;
  h.analyses.clear();
  h.aiQueue.length = 0;
  h.aiCalls.length = 0;
  h.engine = null;
  analysisJobs.clear();
  guideCache.clear();
});

describe("buildLogDigest 确定性摘要", () => {
  it("长对局（400+ 事件）输出 ≤6000 字，且身份表/胜负/末日复盘完整", () => {
    const events = makeLongGameEvents();
    expect(events.length).toBeGreaterThan(400);

    const digest = buildLogDigest(LONG_SNAPSHOT, events);
    expect(digest.length).toBeLessThanOrEqual(LOG_DIGEST_CHAR_LIMIT);

    // 身份表完整：全员 9 个座位都在
    expect(digest).toContain("【全员身份表】");
    for (let seat = 1; seat <= 9; seat++) expect(digest).toContain(`${seat}号 `);
    expect(digest).toContain("预言家");
    // 胜负完整（头部结果 + 对局结果事件）
    expect(digest).toContain("狼人阵营胜利");
    expect(digest).toContain("【对局结果】");
    // 末日复盘完整：最后一天的时间线与放逐结果保留（降级只砍发言/心理，不砍行动与结果）
    expect(digest).toContain("〔第8天〕");
    expect(digest).toContain("放逐结果：8号玩家被放逐。");
    expect(digest).toContain("〔第8夜〕");
    expect(digest).toContain("狼队最终决定袭击");
  });

  it("空对局不炸：仅有对局信息与身份表", () => {
    const digest = buildLogDigest(SNAPSHOT, []);
    expect(digest).toContain("【对局信息】");
    expect(digest).toContain("9人标准局（暗牌）");
    expect(digest).toContain("【全员身份表】");
    expect(digest).toContain("（暂无对局日志）");
    expect(digest.length).toBeLessThanOrEqual(LOG_DIGEST_CHAR_LIMIT);
  });

  it("截断规则：发言截 120 字；投票紧凑化；心理活动仅取行动/投票类且截 80 字", () => {
    const events = [
      makeEvent({ type: "speech", content: "发".repeat(500), thought: "演说内心".repeat(50) }),
      makeEvent({ type: "vote", content: "1号玩家投给5号。", thought: "念".repeat(300) }),
      makeEvent({ type: "vote", actor: 2, actorLabel: "2号玩家", content: "2号玩家弃票。" }),
      makeEvent({
        type: "action", phase: "night.witch", actor: 2, actorLabel: "2号玩家",
        title: "毒药", content: "女巫使用毒药毒杀7号玩家。", thought: "毒".repeat(200),
      }),
    ];
    const digest = buildLogDigest(SNAPSHOT, events);

    // 发言截 120
    expect(digest).toContain("发".repeat(120));
    expect(digest).not.toContain("发".repeat(121));
    // 发言的 thought 不展示（心理活动仅取转折性事件：行动/投票类）
    expect(digest).not.toContain("演说内心");
    // 投票紧凑化
    expect(digest).toContain("1→5");
    expect(digest).toContain("2弃票");
    // 行动全文保留 + 心理截 80
    expect(digest).toContain("女巫使用毒药毒杀7号玩家。");
    expect(digest).toContain("念".repeat(80));
    expect(digest).not.toContain("念".repeat(81));
    expect(digest).toContain("毒".repeat(80));
    expect(digest).not.toContain("毒".repeat(81));
  });

  it("未完结对局标注阶段性记录", () => {
    const digest = buildLogDigest({ ...SNAPSHOT, status: "paused", winner: null }, []);
    expect(digest).toContain("未定（对局未完结）");
    expect(digest).toContain("阶段性记录");
  });
});

describe("buildAnalysisPrompt 新架构", () => {
  it("长对局 prompt 总长 ≤10500 字，含摘要与六段输出要求（≤3000 字报告）", () => {
    const { system, user } = buildAnalysisPrompt(LONG_SNAPSHOT, makeLongGameEvents());
    expect(user.length).toBeLessThanOrEqual(ANALYSIS_TOTAL_CHAR_LIMIT);
    expect(ANALYSIS_TOTAL_CHAR_LIMIT).toBe(10_500);
    // 摘要主体（logDigest 输出）
    expect(user).toContain("【全员身份表】");
    expect(user).toContain("【逐日时间线】");
    // 六段结构与精炼要求
    expect(user).toContain("## 一、对局概述");
    expect(user).toContain("## 二、关键转折点分析");
    expect(user).toContain("## 三、心理博弈分析");
    expect(user).toContain("## 四、规则认知错误与明显失误清单");
    expect(user).toContain("## 五、阵营表现点评");
    expect(user).toContain("## 六、经验教训");
    expect(user).toContain("3000");
    expect(system).toContain("上帝视角");
  });

  it("system 注入本局规则行与规则认知校正指令（按 BOARDS 查版型定义）", () => {
    // 9人标准局：女巫仅首夜可自救、无警长
    const nine = buildAnalysisPrompt(SNAPSHOT, []);
    expect(nine.system).toContain("本局版型：9人标准局（暗牌）");
    expect(nine.system).toContain("女巫仅首夜可自救");
    expect(nine.system).toContain("无警长");
    expect(nine.system).toContain("屠边");
    // 认知校正指令：相悖认知是玩家的规则认知错误，不得当作合理策略采纳
    expect(nine.system).toContain("规则认知错误");
    expect(nine.system).toContain("绝不可将其当作合理策略采纳");

    // 12人标准场：女巫全程不可自救、有警长（本次事故版型）
    const snap12: GameSnapshot = {
      ...SNAPSHOT,
      boardId: "standard12",
      boardName: "12人标准场（预女猎白）",
    };
    const twelve = buildAnalysisPrompt(snap12, []);
    expect(twelve.system).toContain("本局版型：12人标准场（预女猎白）");
    expect(twelve.system).toContain("女巫全程不可自救");
    expect(twelve.system).toContain("有警长");

    // 未知版型：回退用快照里的版型名，不炸
    const unknown = buildAnalysisPrompt({ ...SNAPSHOT, boardId: "nope", boardName: "自定义局" }, []);
    expect(unknown.system).toContain("本局版型：自定义局");
  });

  it("runAnalysis 以 { jsonMode:false, timeoutMs:600s, maxRetries:2 } 调 callAi", async () => {
    h.aiQueue.push("# 报告");
    await runAnalysis(ANALYST, SNAPSHOT, []);
    expect(h.aiCalls.length).toBe(1);
    expect(h.aiCalls[0].opts).toMatchObject({
      jsonMode: false,
      timeoutMs: ANALYST_TIMEOUT_MS,
      maxRetries: ANALYST_MAX_RETRIES,
    });
    expect(ANALYST_TIMEOUT_MS).toBe(600_000);
    expect(ANALYST_MAX_RETRIES).toBe(2);
  });

  it("runAnalysis 失败时抛错（AI 无响应）", async () => {
    await expect(runAnalysis(ANALYST, SNAPSHOT, [])).rejects.toThrow("分析师AI生成报告失败");
  });
});

describe("buildCommonDistillPrompt 共通蒸馏 prompt", () => {
  it("含旧指南与新报告，要求与版型无关的通用策略，含长度与格式要求", () => {
    const { user } = buildCommonDistillPrompt("旧指南内容XYZ", "新报告内容ABC");
    expect(user).toContain("旧指南内容XYZ");
    expect(user).toContain("新报告内容ABC");
    expect(user).toContain("4000");
    expect(user).toContain("去重");
    expect(user).toContain("与具体版型角色配置无关的通用策略");
  });

  it("含规则差异约束：经验不得依赖特定规则设定，涉规则差异须条件化表述否则剔除", () => {
    const { user } = buildCommonDistillPrompt(null, "报告");
    expect(user).toContain("规则存在差异");
    expect(user).toContain("不得依赖某一特定规则设定");
    expect(user).toContain("条件化表述");
    expect(user).toContain("若规则允许自救");
  });

  it("无旧指南时提示创建首版", () => {
    const { user } = buildCommonDistillPrompt(null, "报告");
    expect(user).toContain("第一份指南");
  });

  it("runDistillCommon 以 { jsonMode:false, timeoutMs:600s, maxRetries:2 } 调 callAi", async () => {
    h.aiQueue.push("# 共通指南");
    const out = await runDistillCommon(ANALYST, null, "报告");
    expect(out).toContain("共通指南");
    expect(h.aiCalls[0].opts).toMatchObject({
      jsonMode: false,
      timeoutMs: ANALYST_TIMEOUT_MS,
      maxRetries: ANALYST_MAX_RETRIES,
    });
  });

  it("runDistillCommon 失败时抛错", async () => {
    await expect(runDistillCommon(ANALYST, null, "报告")).rejects.toThrow("蒸馏共通指南失败");
  });
});

describe("buildBoardDistillPrompt 版型蒸馏 prompt", () => {
  const CTX = {
    boardName: "12人白狼王守卫",
    rolesSummary: "预女猎守 + 4民 vs 3狼+白狼王",
    rulesText: "女巫全程不可自救 · 有警长 · 屠边",
  };

  it("含版型名/角色配置/旧指南/新报告，要求仅适用该版型，含长度与格式要求", () => {
    const { system, user } = buildBoardDistillPrompt(CTX, "旧版型指南XYZ", "新报告内容ABC");
    expect(system).toContain("12人白狼王守卫");
    expect(user).toContain("12人白狼王守卫");
    expect(user).toContain("预女猎守 + 4民 vs 3狼+白狼王");
    expect(user).toContain("旧版型指南XYZ");
    expect(user).toContain("新报告内容ABC");
    expect(user).toContain("3000");
    expect(user).toContain("去重");
    expect(user).toContain("仅适用于版型");
  });

  it("含【本版型规则】区块，并要求所有经验符合规则、严禁与规则相悖的建议", () => {
    const { user } = buildBoardDistillPrompt(CTX, null, "报告");
    // 本版型规则区块原样注入
    expect(user).toContain("【本版型规则】女巫全程不可自救 · 有警长 · 屠边");
    // 蒸馏要求：符合规则 + 禁止相悖建议（女巫自救示例）+ 反面教训口径
    expect(user).toContain("所有经验必须符合【本版型规则】");
    expect(user).toContain("严禁输出与规则相悖的建议");
    expect(user).toContain("女巫自救");
    expect(user).toContain("规则认知错误");
    expect(user).toContain("反面教训");
  });

  it("无旧指南时提示创建该版型首版", () => {
    const { user } = buildBoardDistillPrompt(CTX, null, "报告");
    expect(user).toContain("第一份指南");
  });

  it("runDistillBoard 以 { jsonMode:false, timeoutMs:600s, maxRetries:2 } 调 callAi", async () => {
    h.aiQueue.push("# 版型指南");
    const out = await runDistillBoard(ANALYST, CTX, null, "报告");
    expect(out).toContain("版型指南");
    expect(h.aiCalls[0].opts).toMatchObject({
      jsonMode: false,
      timeoutMs: ANALYST_TIMEOUT_MS,
      maxRetries: ANALYST_MAX_RETRIES,
    });
  });

  it("runDistillBoard 失败时抛错", async () => {
    await expect(runDistillBoard(ANALYST, CTX, null, "报告")).rejects.toThrow("蒸馏版型指南失败");
  });
});

describe("buildBoardRulesText 版型规则文本", () => {
  it("按 BOARDS 定义组装：女巫自救规则 + 警长 + 固定屠边后缀", () => {
    expect(buildBoardRulesText("standard9")).toBe("女巫仅首夜可自救 · 无警长 · 屠边");
    expect(buildBoardRulesText("standard12")).toBe("女巫全程不可自救 · 有警长 · 屠边");
    expect(buildBoardRulesText("wolfKingGuard12")).toBe("女巫全程不可自救 · 有警长 · 屠边");
  });

  it("未知版型回退占位文本，不抛错", () => {
    expect(buildBoardRulesText("nope")).toContain("规则未知");
  });
});

describe("buildPrompt 经验指南注入", () => {
  it("注入 guide：输出含【经验指南】且位于【策略参考】之前", () => {
    const { user } = buildPrompt(witchPending, { guide: "狼人第一夜优先刀预言家" });
    expect(user).toContain("【经验指南】");
    expect(user).toContain("狼人第一夜优先刀预言家");
    expect(user.indexOf("【经验指南】")).toBeLessThan(user.indexOf("【策略参考】"));
  });

  it("guide 为空/缺省则不插入【经验指南】", () => {
    expect(buildPrompt(witchPending).user).not.toContain("【经验指南】");
    expect(buildPrompt(witchPending, { guide: "" }).user).not.toContain("【经验指南】");
    expect(buildPrompt(witchPending, { guide: "  " }).user).not.toContain("【经验指南】");
  });

  it("向后兼容：第二参数为 string 时视为 retryNote", () => {
    const { user } = buildPrompt(witchPending, "该目标不合法");
    expect(user).toContain("上一次输出非法");
    expect(user).toContain("该目标不合法");
    expect(user).not.toContain("【经验指南】");
  });
});

describe("service.generateAnalysis 分段流水线", () => {
  it("analyze→distill(共通→版型)→done 阶段流转正确；两段蒸馏各落库正确 scope；analyze 完成即落库；running 中重复触发返回 started:false", async () => {
    const gameId = "g-flow";
    insertFinishedGame(gameId);

    // 脚本化 AI：analyze（复盘报告）与两段 distill（共通/版型）均用可控 Promise
    let resolveReport!: (s: string) => void;
    let resolveCommon!: (s: string) => void;
    let resolveBoard!: (s: string) => void;
    h.aiQueue.push(new Promise<string>((r) => (resolveReport = r)));
    h.aiQueue.push(new Promise<string>((r) => (resolveCommon = r)));
    h.aiQueue.push(new Promise<string>((r) => (resolveBoard = r)));

    const r1 = await gameService.generateAnalysis(gameId, U1, ANALYST);
    expect(r1.started).toBe(true);

    // running 中重复触发 → started:false
    const r2 = await gameService.generateAnalysis(gameId, U1, ANALYST);
    expect(r2.started).toBe(false);

    // 阶段 1：analyze（撰写报告），报告未产出 → 无落库
    await waitFor(async () => (await gameService.getAnalysis(gameId, U1)).jobStage === "analyze");
    let a = await gameService.getAnalysis(gameId, U1);
    expect(a.jobStatus).toBe("running");
    expect(a.report).toBeNull();

    // 报告产出 → analyze 完成：报告立即落库 + 内存检查点，阶段推进到 distill
    resolveReport("# 复盘报告\n## 五、经验教训\n- 狼人：别冲票队友");
    await waitFor(async () => (await gameService.getAnalysis(gameId, U1)).jobStage === "distill");
    expect(h.analyses.get(gameId)?.report).toContain("复盘报告"); // 检查点语义：distill 未完成报告已落库
    expect(analysisJobs.get(gameId)?.report).toContain("复盘报告");
    expect(h.guides.length).toBe(0); // distill 尚未完成，指南未落库

    // 共通段完成 → scope="common" v1 落库 + commonDone 检查点，版型段仍在跑
    resolveCommon("# 共通指南v1\n- 狼人：优先刀预言家");
    await waitFor(() => h.guides.length === 1);
    expect(analysisJobs.get(gameId)?.commonDone).toBe(true);
    expect((await gameService.getAnalysis(gameId, U1)).jobStatus).toBe("running"); // 版型段未完成

    // 版型段完成 → done，stage 归 null
    resolveBoard("# 版型指南v1\n- 女巫：首夜救人");
    await waitFor(async () => (await gameService.getAnalysis(gameId, U1)).jobStatus === "done");
    a = await gameService.getAnalysis(gameId, U1);
    expect(a.jobStage).toBeNull();
    expect(a.report?.report).toContain("复盘报告");
    expect(a.report?.model).toBe("analyst-model");
    expect(a.jobError).toBeNull();

    // ① 两段蒸馏各落库正确 scope：common v1 + standard9 v1，版本序列各自独立
    expect(h.guides.length).toBe(2);
    const commonRow = h.guides.find((g) => g.scope === "common")!;
    const boardRow = h.guides.find((g) => g.scope === "standard9")!;
    expect(commonRow.version).toBe(1);
    expect(boardRow.version).toBe(1);
    expect(commonRow.gameId).toBe(gameId);
    expect(boardRow.gameId).toBe(gameId);
    expect(String(commonRow.content)).toContain("共通指南v1");
    expect(String(boardRow.content)).toContain("版型指南v1");
    // note 分别注明"共通"/版型名
    expect(String(commonRow.note)).toContain("共通");
    expect(String(commonRow.note)).toContain("狼人胜");
    expect(String(boardRow.note)).toContain("9人标准局");
    expect(String(boardRow.note)).toContain("狼人胜");

    // 蒸馏完成后刷新该版型注入缓存（共通+版型拼接）
    const cached = guideCache.get(`${U1}:standard9`);
    expect(cached?.text).toContain("【共通经验】");
    expect(cached?.text).toContain("共通指南v1");
    expect(cached?.text).toContain("【本版型经验·9人标准局（暗牌）】");
    expect(cached?.text).toContain("版型指南v1");

    // 三次 AI 调用都带分析师参数（600s / 2 次重试 / 非 jsonMode）
    expect(h.aiCalls.length).toBe(3);
    for (const call of h.aiCalls) {
      expect(call.opts).toMatchObject({ jsonMode: false, timeoutMs: 600_000, maxRetries: 2 });
    }
    // analyze 调用输入为新摘要格式（≤10500 字）
    expect(h.aiCalls[0].user).toContain("【逐日时间线】");
    expect(h.aiCalls[0].user.length).toBeLessThanOrEqual(ANALYSIS_TOTAL_CHAR_LIMIT);
    // 共通蒸馏 prompt 要求通用策略；版型蒸馏 prompt 带版型名与角色配置
    expect(h.aiCalls[1].user).toContain("与具体版型角色配置无关的通用策略");
    expect(h.aiCalls[2].user).toContain("9人标准局（暗牌）");
    expect(h.aiCalls[2].user).toContain("经典入门版型，暗牌小局节奏明快");
    // service 构造的 rulesText：standard9 → 女巫仅首夜可自救 · 无警长 · 屠边
    expect(h.aiCalls[2].user).toContain("【本版型规则】女巫仅首夜可自救 · 无警长 · 屠边");

    // guide() 返回 GuideOverview：common + boards
    const g = await gameService.guide(U1);
    expect(g.common.version).toBe(1);
    expect(g.common.entryCount).toBe(1);
    expect(g.common.content).toContain("共通指南v1");
    expect(g.boards.length).toBe(1);
    expect(g.boards[0].boardId).toBe("standard9");
    expect(g.boards[0].boardName).toBe("9人标准局（暗牌）");
    expect(g.boards[0].guide.version).toBe(1);
    expect(g.boards[0].guide.content).toContain("版型指南v1");

    // scope 化查询：guideVersions/guideVersion 按 scope 隔离
    expect((await gameService.guideVersions(U1, "common")).length).toBe(1);
    expect((await gameService.guideVersions(U1, "standard9")).length).toBe(1);
    expect((await gameService.guideVersions(U1, "wolfKingGuard12")).length).toBe(0);
    expect((await gameService.guideVersion(U1, "common", 1))?.content).toContain("共通指南v1");
    expect((await gameService.guideVersion(U1, "standard9", 1))?.content).toContain("版型指南v1");
    expect(await gameService.guideVersion(U1, "standard9", 99)).toBeNull();

    // 第二局：两段蒸馏 prompt 各含旧指南与新报告，两个 scope 版本各自 +1
    const gameId2 = "g-flow-2";
    insertFinishedGame(gameId2);
    h.aiQueue.push("# 报告2", "# 共通指南v2\n- 好人：记票型", "# 版型指南v2\n- 预言家：藏好");
    await gameService.generateAnalysis(gameId2, U1, ANALYST);
    await waitFor(async () => (await gameService.getAnalysis(gameId2, U1)).jobStatus === "done");

    expect(h.guides.length).toBe(4);
    expect(h.guides.filter((g) => g.scope === "common").at(-1)!.version).toBe(2);
    expect(h.guides.filter((g) => g.scope === "standard9").at(-1)!.version).toBe(2);
    const commonDistillCall = h.aiCalls.at(-2)!;
    expect(commonDistillCall.user).toContain("共通指南v1");
    expect(commonDistillCall.user).toContain("报告2");
    const boardDistillCall = h.aiCalls.at(-1)!;
    expect(boardDistillCall.user).toContain("版型指南v1");
    expect(boardDistillCall.user).toContain("报告2");
    expect((await gameService.guide(U1)).common.version).toBe(2);
  });

  it("分析师AI失败 → jobStatus failed 且保留原始错误，报告与指南均不落库", async () => {
    const gameId = "g-fail";
    insertFinishedGame(gameId);
    // aiQueue 空 → callAi 返回 ok:false（error: "queue empty"）
    const r = await gameService.generateAnalysis(gameId, U1, ANALYST);
    expect(r.started).toBe(true);
    await waitFor(async () => (await gameService.getAnalysis(gameId, U1)).jobStatus === "failed");
    const a = await gameService.getAnalysis(gameId, U1);
    expect(a.jobError).toContain("分析师AI生成报告失败");
    expect(a.jobError).toContain("queue empty"); // 原始 API 错误保留
    expect(a.jobStage).toBeNull();
    expect(h.analyses.has(gameId)).toBe(false);
    expect(h.guides.length).toBe(0);
  });

  it("对局不存在或未结束 → 抛错", async () => {
    await expect(gameService.generateAnalysis("g-nope", U1, ANALYST)).rejects.toThrow("不存在");
    h.games.set("g-running", { id: "g-running", status: "running", userId: U1, createdAt: new Date() });
    await expect(gameService.generateAnalysis("g-running", U1, ANALYST)).rejects.toThrow("进行中");
    h.games.set("g-created", { id: "g-created", status: "created", userId: U1, createdAt: new Date() });
    await expect(gameService.generateAnalysis("g-created", U1, ANALYST)).rejects.toThrow("尚未开始");
    // 已暂停的对局允许阶段性复盘
    h.games.set("g-paused", { id: "g-paused", status: "paused", userId: U1, createdAt: new Date() });
    const r = await gameService.generateAnalysis("g-paused", U1, ANALYST);
    expect(r.started).toBe(true);
  });

  it("无内存任务记录时按库里有无论 done/idle（模拟服务重启）", async () => {
    // 账户体系：不存在的对局一律 NOT_FOUND（归属校验先于状态推导）
    await expect(gameService.getAnalysis("g-none", U1)).rejects.toThrow("不存在");
    h.games.set("g-manual", { id: "g-manual", status: "finished", userId: U1, createdAt: new Date() });
    h.analyses.set("g-manual", {
      gameId: "g-manual", report: "旧报告", model: "m", createdAt: new Date(),
    });
    const a = await gameService.getAnalysis("g-manual", U1);
    expect(a.jobStatus).toBe("done");
    expect(a.report?.report).toBe("旧报告");
  });
});

describe("分析任务自愈（60s 无心跳复活）", () => {
  it("stage=distill 且持 report 检查点的停滞 running 任务 → getAnalysis 触发复活且只重跑 distill", async () => {
    const gameId = "g-stale";
    insertFinishedGame(gameId);
    // 检查点语义：analyze 阶段产物已落库
    h.analyses.set(gameId, {
      gameId, report: "检查点报告XYZ", model: "analyst-model", createdAt: new Date(),
    });
    // 构造 61s 前停滞的 running 任务（simulate 进程波动导致 distill 阶段死亡，共通段未完成）
    const staleJob = {
      status: "running" as const,
      stage: "distill" as AnalysisJobStage,
      error: null,
      updatedAt: Date.now() - 61_000,
      report: "检查点报告XYZ",
      commonDone: false,
      cfg: ANALYST,
      snapshot: SNAPSHOT,
    };
    analysisJobs.set(gameId, staleJob);
    h.aiQueue.push("# 复活共通指南\n- 女巫：首夜救人", "# 复活版型指南\n- 预言家：藏好");

    // getAnalysis 触发自愈复活
    const before = await gameService.getAnalysis(gameId, U1);
    expect(before.jobStatus).toBe("running");
    expect(before.jobStage).toBe("distill");

    await waitFor(async () => (await gameService.getAnalysis(gameId, U1)).jobStatus === "done");

    // 只重跑了 distill 两段：全程仅 2 次 AI 调用，且输入为检查点报告（analyze 被跳过）
    expect(h.aiCalls.length).toBe(2);
    expect(h.aiCalls[0].user).toContain("检查点报告XYZ");
    expect(h.aiCalls[0].user).toContain("【现有共通经验指南】");
    expect(h.aiCalls[0].user).not.toContain("【逐日时间线】");
    expect(h.aiCalls[1].user).toContain("检查点报告XYZ");
    expect(h.aiCalls[1].user).toContain("【现有本版型经验指南】");
    // 两个 scope 各落库一个新版本（note 用检查点快照的版型/胜负）
    expect(h.guides.length).toBe(2);
    const commonRow = h.guides.find((g) => g.scope === "common")!;
    const boardRow = h.guides.find((g) => g.scope === "standard9")!;
    expect(String(commonRow.note)).toContain("共通");
    expect(String(commonRow.note)).toContain("狼人胜");
    expect(String(boardRow.note)).toContain("9人标准局");
    expect(String(boardRow.note)).toContain("狼人胜");
    // 终态：stage 归 null
    const fin = await gameService.getAnalysis(gameId, U1);
    expect(fin.jobStage).toBeNull();
    expect(fin.jobError).toBeNull();
  });

  it("commonDone 检查点命中的停滞任务 → 复活只续跑版型段（共通段跳过，不重复落库）", async () => {
    const gameId = "g-stale-common-done";
    insertFinishedGame(gameId);
    h.analyses.set(gameId, {
      gameId, report: "检查点报告XYZ", model: "analyst-model", createdAt: new Date(),
    });
    // 共通段此前已落库（进程死于版型段中途）
    h.guides.push({
      scope: "common", version: 1, content: "既有共通指南", gameId, note: "共通｜旧",
      createdAt: new Date(),
    });
    analysisJobs.set(gameId, {
      status: "running",
      stage: "distill" as AnalysisJobStage,
      error: null,
      updatedAt: Date.now() - 61_000,
      report: "检查点报告XYZ",
      commonDone: true, // 内存检查点：共通段已完成
      cfg: ANALYST,
      snapshot: SNAPSHOT,
    });
    h.aiQueue.push("# 续跑版型指南\n- 守卫：别乱守");

    await gameService.getAnalysis(gameId, U1); // 触发复活
    await waitFor(async () => (await gameService.getAnalysis(gameId, U1)).jobStatus === "done");

    // 仅 1 次 AI 调用（版型蒸馏），且 prompt 含版型上下文
    expect(h.aiCalls.length).toBe(1);
    expect(h.aiCalls[0].user).toContain("检查点报告XYZ");
    expect(h.aiCalls[0].user).toContain("【现有本版型经验指南】");
    // 共通指南未重复落库（仍 1 行），版型指南新增 1 行
    expect(h.guides.filter((g) => g.scope === "common").length).toBe(1);
    expect(h.guides.filter((g) => g.scope === "standard9").length).toBe(1);
    expect(String(h.guides.find((g) => g.scope === "standard9")!.content)).toContain("续跑版型指南");
  });

  it("无 report 检查点的停滞 running 任务 → 复活后从头重跑（analyze+两段 distill）", async () => {
    const gameId = "g-stale-full";
    insertFinishedGame(gameId);
    analysisJobs.set(gameId, {
      status: "running",
      stage: "analyze",
      error: null,
      updatedAt: Date.now() - 61_000,
      report: null,
      commonDone: false,
      cfg: ANALYST,
      snapshot: null,
    });
    h.aiQueue.push("# 重跑报告", "# 重跑共通指南", "# 重跑版型指南");

    await gameService.getAnalysis(gameId, U1); // 触发复活
    await waitFor(async () => (await gameService.getAnalysis(gameId, U1)).jobStatus === "done");

    // 从头重跑：analyze（含摘要）+ 共通/版型两段 distill（含报告）三次调用
    expect(h.aiCalls.length).toBe(3);
    expect(h.aiCalls[0].user).toContain("【逐日时间线】");
    expect(h.aiCalls[1].user).toContain("重跑报告");
    expect(h.aiCalls[2].user).toContain("重跑报告");
    expect(h.analyses.get(gameId)?.report).toContain("重跑报告");
    expect(h.guides.length).toBe(2);
    expect(h.guides.some((g) => g.scope === "common")).toBe(true);
    expect(h.guides.some((g) => g.scope === "standard9")).toBe(true);
  });

  it("新鲜 running 任务（<60s）不触发复活", async () => {
    const gameId = "g-fresh";
    insertFinishedGame(gameId);
    analysisJobs.set(gameId, {
      status: "running",
      stage: "analyze",
      error: null,
      updatedAt: Date.now(), // 新鲜心跳
      report: null,
      commonDone: false,
      cfg: ANALYST,
      snapshot: null,
    });
    await gameService.getAnalysis(gameId, U1);
    await new Promise((r) => setTimeout(r, 50));
    expect(h.aiCalls.length).toBe(0); // 未发起任何复活调用
  });
});

describe("终局自动分析（接线1：createGame 配置 analystAi）", () => {
  it("对局结束后自动复盘：报告落库 + 两段指南蒸馏 + jobStatus done", async () => {
    h.engine = makeFakeEngine();
    // 脚本化 AI：① 对局决策 ② 复盘报告 ③ 共通指南蒸馏 ④ 版型指南蒸馏
    h.aiQueue.push(
      '{"thought":"保守","skip":true}',
      "# 自动复盘报告",
      "# 自动共通指南\n- 女巫：首夜救人",
      "# 自动版型指南\n- 预言家：藏好",
    );

    const seats = Array.from({ length: 9 }, (_, i) => ({
      seat: i + 1,
      provider: "kimi" as const,
      baseUrl: "http://mock.local/v1",
      model: "mock-model",
      apiKey: "sk-mock",
    }));
    const { gameId } = await gameService.createGame({
      boardId: "standard9",
      seats,
      options: { stepDelayMs: 5, sheriffEnabled: false, allowSelfDestruct: true, speechRoundsLimit: 2 },
      analystAi: ANALYST,
    }, U1);
    await gameService.control(gameId, "start", U1);

    // 对局结束 → 自动分析跑完
    await waitFor(() => h.games.get(gameId)?.status === "finished");
    await waitFor(async () => (await gameService.getAnalysis(gameId, U1)).jobStatus === "done");

    expect(h.analyses.get(gameId)?.report).toContain("自动复盘报告");
    // 两段蒸馏：common 与 standard9 各落库 v1
    expect(h.guides.length).toBe(2);
    expect(h.guides.find((g) => g.scope === "common")!.version).toBe(1);
    expect(h.guides.find((g) => g.scope === "standard9")!.version).toBe(1);
    expect(String(h.guides.find((g) => g.scope === "standard9")!.note)).toContain("狼人胜");
    // 四次 AI 调用：决策 → 复盘（含身份表与逐日时间线）→ 共通蒸馏 → 版型蒸馏（均含报告）
    expect(h.aiCalls.length).toBe(4);
    expect(h.aiCalls[1].user).toContain("【全员身份表】");
    expect(h.aiCalls[1].user).toContain("【逐日时间线】");
    expect(h.aiCalls[1].opts).toMatchObject({ jsonMode: false, timeoutMs: 600_000, maxRetries: 2 });
    expect(h.aiCalls[2].user).toContain("自动复盘报告");
    expect(h.aiCalls[3].user).toContain("自动复盘报告");
  });

  it("autoGenerate=false：终局不自动复盘（jobStatus 保持 idle，无分析调用）", async () => {
    h.engine = makeFakeEngine();
    h.aiQueue.push('{"thought":"保守","skip":true}');

    const seats = Array.from({ length: 9 }, (_, i) => ({
      seat: i + 1,
      provider: "kimi" as const,
      baseUrl: "http://mock.local/v1",
      model: "mock-model",
      apiKey: "sk-mock",
    }));
    const { gameId } = await gameService.createGame({
      boardId: "standard9",
      seats,
      options: { stepDelayMs: 5, sheriffEnabled: false, allowSelfDestruct: true, speechRoundsLimit: 2 },
      analystAi: { ...ANALYST, autoGenerate: false },
    }, U1);
    await gameService.control(gameId, "start", U1);

    await waitFor(() => h.games.get(gameId)?.status === "finished");
    await new Promise((r) => setTimeout(r, 50));

    // 只有一次对局决策调用，绝无任何复盘/蒸馏调用
    expect(h.aiCalls.length).toBe(1);
    expect((await gameService.getAnalysis(gameId, U1)).jobStatus).toBe("idle");
    expect(h.analyses.get(gameId)).toBeUndefined();
    expect(h.guides.length).toBe(0);
  });
});

describe("getCachedGuideText 按版型拼接注入文本", () => {
  function pushGuide(scope: string, version: number, content: string): void {
    h.guides.push({ scope, version, content, gameId: null, note: "", createdAt: new Date() });
  }

  it("共通+版型：两层齐全时拼接【共通经验】与【本版型经验·版型名】", async () => {
    pushGuide("common", 1, "共通内容X");
    pushGuide("standard9", 2, "版型内容Y");

    const text = await getCachedGuideText(U1, "standard9");
    expect(text).toContain("【共通经验】");
    expect(text).toContain("共通内容X");
    expect(text).toContain("【本版型经验·9人标准局（暗牌）】");
    expect(text).toContain("版型内容Y");
    // 共通段在前，版型段在后
    expect(text.indexOf("【共通经验】")).toBeLessThan(text.indexOf("【本版型经验·"));
  });

  it("仅共通：该版型无特定内容时省略【本版型经验】层", async () => {
    pushGuide("common", 1, "只有共通");

    const text = await getCachedGuideText(U1, "standard12");
    expect(text).toContain("【共通经验】");
    expect(text).toContain("只有共通");
    expect(text).not.toContain("【本版型经验");
  });

  it("仅版型：无共通内容时省略【共通经验】层", async () => {
    pushGuide("standard9", 1, "只有版型");

    const text = await getCachedGuideText(U1, "standard9");
    expect(text).not.toContain("【共通经验】");
    expect(text).toContain("【本版型经验·9人标准局（暗牌）】");
    expect(text).toContain("只有版型");
  });

  it("两层都空：返回空串", async () => {
    expect(await getCachedGuideText(U1, "standard9")).toBe("");
  });

  it("60s TTL 内命中缓存不重复查库；版型之间缓存互不影响", async () => {
    pushGuide("common", 1, "共通V1");
    const first = await getCachedGuideText(U1, "standard9");
    expect(first).toContain("共通V1");

    // 库已更新但缓存未过期：仍返回旧文本
    pushGuide("common", 2, "共通V2");
    expect(await getCachedGuideText(U1, "standard9")).toContain("共通V1");
    // 另一版型是独立缓存项：首次读取拿到最新
    expect(await getCachedGuideText(U1, "standard12")).toContain("共通V2");
  });
});
