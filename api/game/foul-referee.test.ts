// ============================================================
// 犯规裁判测试（分析师担任，实时审查公开发言的内容级犯规）
// 事故由来：对局 20261009001 夜神月（平民）被放逐后遗言「把牌正过来放回桌面」
// 翻牌自证——平民无翻牌权，属违规亮牌，当时无任何检测与惩罚机制。
// 覆盖：
// 1) parseFoulVerdict 解析与保守原则（类型缺失/非法一律不判）
// 2) buildFoulCheckPrompt 要素（真实身份裁判专用、判定标准、输出契约）
// 3) 犯规成立 → settleExternal 对立阵营获胜 + auditSettle 决策日志 + 判罚事件落盘
// 4) 裁判判不犯规/不可用 → 对局照常（绝不误判破局）
// 5) buildPrompt 含规则红线（玩家事先知情：犯规=对立阵营获胜）
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DecisionInput, EngineEvent } from "./engine/api";

// ---------- 共享 mock 状态 ----------
const h = vi.hoisted(() => ({
  games: new Map<string, Record<string, unknown>>(),
  events: [] as Record<string, unknown>[],
  decisions: [] as Record<string, unknown>[],
  aiQueue: [] as string[],
  aiCalls: [] as { system: string; user: string }[],
  engine: null as ReturnType<typeof makeFoulEngine> | null,
}));

vi.mock("../queries/games", () => ({
  countGamesOnDate: async () => 0,
  insertGame: async (row: Record<string, unknown>) => {
    h.games.set(row.id as string, { ...row });
  },
  updateGame: async (id: string, patch: Record<string, unknown>) => {
    const g = h.games.get(id);
    if (g) Object.assign(g, patch);
  },
  getGame: async (id: string) => h.games.get(id) ?? null,
  listGames: async () => [...h.games.values()],
  appendEvents: async (rows: Record<string, unknown>[]) => {
    h.events.push(...rows);
  },
  getEventsAfter: async (gameId: string, afterSeq: number) =>
    h.events.filter((e) => e.gameId === gameId && (e.seq as number) > afterSeq),
  getAllEvents: async (gameId: string) => h.events.filter((e) => e.gameId === gameId),
}));

vi.mock("../queries/decisions", () => ({
  appendDecision: async (row: Record<string, unknown>) => {
    h.decisions.push({ ...row });
  },
  getDecisions: async (gameId: string) =>
    h.decisions
      .filter((d) => d.gameId === gameId)
      .sort((a, b) => (a.idx as number) - (b.idx as number)),
}));

vi.mock("./ai/providers", () => ({
  callAi: async (_cfg: unknown, system: string, user: string) => {
    h.aiCalls.push({ system, user });
    const next = h.aiQueue.shift();
    if (next == null) return { ok: false, text: null, latencyMs: 1, error: "queue empty" };
    return { ok: true, text: next, latencyMs: 1, error: null };
  },
}));

vi.mock("./engine/index", () => ({
  createEngine: () => h.engine,
  MEETING_WOLVES: new Set(["werewolf"]),
}));

// ---------- 假引擎：首 tick 落一条犯规/正常发言事件，之后空转等待裁判 ----------
function makeFoulEngine(speechContent: string, offenderSeat = 9, offenderCamp = "villager") {
  const state = { finished: false, advanced: 0, settled: null as null | { winner: string; note?: string; pub?: string } };
  const players = [
    { seat: offenderSeat, role: offenderCamp === "wolf" ? "werewolf" : "villager", camp: offenderCamp, alive: false },
    { seat: 1, role: "werewolf", camp: "wolf", alive: true },
  ];
  return {
    state,
    getSnapshot: () => ({
      day: 3,
      phase: "day.lastWords",
      phaseLabel: "遗言",
      winner: (state.settled?.winner as "wolf" | "good" | null) ?? null,
      finished: state.finished,
      pendingSeat: null,
      pendingActs: [],
      players,
    }),
    advance: () => {
      state.advanced += 1;
      if (state.advanced === 1) {
        const ev: EngineEvent = {
          day: 3,
          phase: "day.lastWords",
          type: "speech",
          actor: offenderSeat,
          title: "遗言",
          content: speechContent,
          thought: null,
          meta: null,
        };
        return { events: [ev], pending: null };
      }
      return {
        events: [
          {
            day: 3,
            phase: "day.lastWords" as const,
            type: "phase" as const,
            actor: null,
            title: "心跳",
            content: "（等待）",
            thought: null,
            meta: null,
          },
        ],
        pending: null,
      };
    },
    decide: (_input: DecisionInput): EngineEvent[] => [],
    settleExternal: (winner: "wolf" | "good", note?: string, pubLine?: string): EngineEvent[] => {
      state.settled = { winner, note, pub: pubLine };
      state.finished = true;
      return [
        {
          day: 3,
          phase: "day.lastWords",
          type: "result" as const,
          actor: null,
          title: winner === "good" ? "神民阵营胜利" : "狼人阵营胜利",
          content: `${winner === "good" ? "神民" : "狼人"}阵营获胜${note ?? ""}`,
          thought: null,
          meta: null,
        },
      ];
    },
    isFinished: () => state.finished,
  };
}

const { gameService, buildFoulCheckPrompt, parseFoulVerdict } = await import("./service");
const { buildPrompt } = await import("./ai/prompts");

async function startGame(speech: string, camp = "villager"): Promise<string> {
  h.engine = makeFoulEngine(speech, 9, camp);
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
  });
  await gameService.control(gameId, "start");
  return gameId;
}

async function waitStatus(gameId: string, want: string, timeoutMs = 5000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (h.games.get(gameId)?.status === want) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`超时：对局状态未变为 ${want}（当前 ${h.games.get(gameId)?.status}）`);
}

beforeEach(() => {
  h.games.clear();
  h.events.length = 0;
  h.decisions.length = 0;
  h.aiQueue.length = 0;
  h.aiCalls.length = 0;
  h.engine = null;
});

describe("parseFoulVerdict（裁判输出解析，保守原则）", () => {
  it("合法犯规裁决解析成功", () => {
    const v = parseFoulVerdict(
      '{"foul":true,"type":"unauthorizedReveal","evidence":"把牌正过来放回桌面","verdict":"平民无翻牌权"}',
    );
    expect(v).toEqual({
      foul: true,
      type: "unauthorizedReveal",
      evidence: "把牌正过来放回桌面",
      verdict: "平民无翻牌权",
    });
  });

  it("foul=true 但类型缺失/非法 → 保守不判", () => {
    expect(parseFoulVerdict('{"foul":true}')!.foul).toBe(false);
    expect(parseFoulVerdict('{"foul":true,"type":"cheating"}')!.foul).toBe(false);
  });

  it("foul=false 与垃圾输入", () => {
    expect(parseFoulVerdict('{"foul":false}')!.foul).toBe(false);
    expect(parseFoulVerdict("不是 JSON")).toBeNull();
  });
});

describe("buildFoulCheckPrompt（裁判 prompt 要素）", () => {
  it("含真实身份（裁判专用）、三类犯规标准与输出契约", () => {
    const p = buildFoulCheckPrompt({
      seat: 9,
      roleName: "平民",
      eventTitle: "遗言",
      day: 3,
      speech: "我把牌翻开给大家看",
    });
    expect(p.user).toContain("真实身份：平民");
    expect(p.user).toContain("裁判专用");
    expect(p.user).toContain("违规亮牌自证");
    expect(p.user).toContain("AI身份泄露");
    expect(p.user).toContain("元游戏言论");
    expect(p.user).toContain("口头声称");
    expect(p.system).toContain("保守原则");
  });
});

describe("犯规判罚集成（settleExternal 路径）", () => {
  it("平民翻牌自证被裁判判犯规 → 本局立即结束、狼人阵营获胜、判罚全程留痕", async () => {
    h.aiQueue.push(
      '{"foul":true,"type":"unauthorizedReveal","evidence":"把牌正过来放回桌面，一张民牌","verdict":"平民无翻牌权，翻牌自证违规"}',
    );
    const gameId = await startGame("（站起身，先把手里的牌正过来放回桌面）……一张民牌。");
    await waitStatus(gameId, "finished");

    // 对立阵营获胜（平民犯规 → 狼人胜）
    expect(h.games.get(gameId)!.winner).toBe("wolf");
    expect(h.engine!.state.settled?.winner).toBe("wolf");
    // 裁判拿到的 prompt 含发言者真实身份
    expect(h.aiCalls[0]!.user).toContain("真实身份：平民");
    // 决策日志记 auditSettle（重放可精确重建）
    const audit = h.decisions.find((d) => d.kind === "auditSettle");
    expect(audit).toBeDefined();
    expect((audit!.decision as { auditSettle: string }).auditSettle).toBe("wolf");
    expect((audit!.decision as { auditPub: string }).auditPub).toContain("违规亮牌自证");
    // 判罚事件与裁决广播落盘
    expect(h.events.some((e) => e.title === "犯规判罚")).toBe(true);
    expect(
      h.events.some((e) => typeof e.content === "string" && e.content.includes("狼人阵营获胜")),
    ).toBe(true);
  });

  it("狼人犯规 → 神民阵营获胜", async () => {
    h.aiQueue.push(
      '{"foul":true,"type":"aiLeak","evidence":"我作为AI","verdict":"自称AI"}',
    );
    const gameId = await startGame("其实我作为AI知道所有身份", "wolf");
    await waitStatus(gameId, "finished");
    expect(h.games.get(gameId)!.winner).toBe("good");
  });

  it("裁判判不犯规 → 对局不被打扰（无判罚事件、无外部结算）", async () => {
    h.aiQueue.push('{"foul":false}');
    const gameId = await startGame("我是预言家，昨晚验了5号是金水。"); // 口头身份声称≠亮牌
    await new Promise((r) => setTimeout(r, 800));
    expect(h.games.get(gameId)!.status).toBe("running");
    expect(h.events.some((e) => e.title === "犯规判罚")).toBe(false);
    expect(h.decisions.some((d) => d.kind === "auditSettle")).toBe(false);
    expect(h.engine!.state.settled).toBeNull();
    // 裁判确实审查过这条发言
    expect(h.aiCalls.length).toBeGreaterThanOrEqual(1);
    await gameService.control(gameId, "terminate");
  });

  it("裁判不可用（AI 故障）→ 静默跳过，对局照常", async () => {
    // aiQueue 留空：callAi 返回失败
    const gameId = await startGame("（把牌翻开）大家看，我是平民！");
    await new Promise((r) => setTimeout(r, 800));
    expect(h.games.get(gameId)!.status).toBe("running");
    expect(h.events.some((e) => e.title === "犯规判罚")).toBe(false);
    await gameService.control(gameId, "terminate");
  });
});

describe("玩家规则红线（buildPrompt 事先告知）", () => {
  it("system 含规则红线：违规亮牌定义 + 判罚后果", () => {
    const pending = {
      seat: 3,
      role: "villager" as const,
      kind: "daySpeech" as const,
      options: [],
      allowSkip: false,
      hint: "发言",
      view: {
        seat: 3,
        role: "villager" as const,
        roleName: "平民",
        camp: "villager" as const,
        day: 2,
        phase: "day.speech",
        aliveSeats: [1, 2, 3],
        deadSeats: [],
        revealedRoles: {},
        sheriffSeat: null,
        selfAlive: true,
        publicLog: [],
        private: {},
      },
    };
    const { system } = buildPrompt(pending);
    expect(system).toContain("规则红线");
    expect(system).toContain("违规亮牌自证");
    expect(system).toContain("对立阵营获胜");
    expect(system).toContain("白痴被放逐翻牌免死"); // 合法翻牌权的白名单
  });
});
