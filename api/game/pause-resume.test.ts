import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DecisionInput, PendingDecision } from "./engine/api";

const h = vi.hoisted(() => ({
  games: new Map<string, Record<string, unknown>>(),
  events: [] as Record<string, unknown>[],
  decisions: [] as Record<string, unknown>[],
  engine: null as ReturnType<typeof makeEngine> | null,
  calls: 0,
  mode: "hold" as "hold" | "ok",
  response: '{"thought":"t","witchSave":true}',
  releases: [] as Array<() => void>,
}));

vi.mock("../queries/games", () => ({
  countGamesOnDate: async () => 0,
  insertGame: async (row: Record<string, unknown>) => { h.games.set(row.id as string, { ...row }); },
  updateGame: async (id: string, patch: Record<string, unknown>) => {
    const row = h.games.get(id);
    if (row) Object.assign(row, patch);
  },
  getGame: async (id: string) => h.games.get(id) ?? null,
  listGames: async () => [...h.games.values()],
  appendEvents: async (rows: Record<string, unknown>[]) => { h.events.push(...rows); },
  getEventsAfter: async (gameId: string, afterSeq: number) =>
    h.events.filter((e) => e.gameId === gameId && (e.seq as number) > afterSeq),
  getAllEvents: async (gameId: string) => h.events.filter((e) => e.gameId === gameId),
  getDeadSeats: async () => [],
  deathSeatsFromEvents: () => [],
}));

vi.mock("../queries/decisions", () => ({
  appendDecision: async (row: Record<string, unknown>) => { h.decisions.push({ ...row }); },
  getDecisions: async (gameId: string) =>
    h.decisions.filter((d) => d.gameId === gameId).sort((a, b) => (a.idx as number) - (b.idx as number)),
}));

vi.mock("./ai/providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ai/providers")>();
  return {
    ...actual,
    callAi: async () => {
      h.calls += 1;
      if (h.mode === "ok") {
        return { ok: true, text: h.response, latencyMs: 1, error: null };
      }
      return new Promise((resolve) => {
        h.releases.push(() => resolve({ ok: true, text: h.response, latencyMs: 1, error: null }));
      });
    },
  };
});

vi.mock("./engine/index", () => ({
  createEngine: () => h.engine,
  MEETING_WOLVES: new Set(["werewolf"]),
}));

function viewFor(seat: number, role: PendingDecision["role"]): PendingDecision["view"] {
  return {
    seat,
    role,
    roleName: role,
    camp: role === "werewolf" ? "wolf" : "god",
    day: 1,
    phase: "night.witch",
    aliveSeats: [1, 2, 3, 4, 5, 6, 7, 8, 9],
    deadSeats: [],
    revealedRoles: {},
    sheriffSeat: null,
    selfAlive: true,
    rules: { witchSelfSave: "firstNight" },
    publicLog: [],
    private: role === "witch"
      ? { witchPotions: { save: true, poison: true }, witchVictimTonight: 2 }
      : {},
  };
}

function singlePending(kind: PendingDecision["kind"] = "witchAction"): PendingDecision {
  return {
    seat: 3,
    role: kind === "witchAction" ? "witch" : "werewolf",
    kind,
    options: [1, 2, 5],
    allowSkip: true,
    hint: "请完成当前技能决策",
    view: viewFor(3, kind === "witchAction" ? "witch" : "werewolf"),
  };
}

function batchPending(): PendingDecision {
  const first = singlePending("wolfKill");
  const second = { ...singlePending("wolfKill"), seat: 2, view: viewFor(2, "werewolf") };
  return { ...first, batch: [first, second] };
}

function makeEngine(pending: PendingDecision) {
  const state = { decided: [] as DecisionInput[] };
  return {
    state,
    getSnapshot: () => ({
      day: 1,
      phase: "night.witch",
      phaseLabel: "夜晚 · 技能行动",
      winner: null,
      finished: false,
      pendingSeat: pending.seat,
      pendingKind: pending.kind,
      pendingActs: [],
      players: [],
    }),
    advance: () => state.decided.length > 0
      ? { events: [], pending: null }
      : { events: [], pending },
    decide: (input: DecisionInput) => {
      state.decided.push(input);
      return [];
    },
    isFinished: () => false,
  };
}

const { gameService, registry } = await import("./service");

async function waitFor(condition: () => boolean, label: string, timeoutMs = 1200): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (condition()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`等待超时：${label}`);
}

async function startGame(pending: PendingDecision): Promise<string> {
  h.engine = makeEngine(pending);
  const seats = Array.from({ length: 9 }, (_, i) => ({
    seat: i + 1,
    provider: "custom" as const,
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

function releaseAi(): void {
  h.mode = "ok";
  const releases = h.releases.splice(0);
  for (const release of releases) release();
}

beforeEach(() => {
  h.games.clear();
  h.events.length = 0;
  h.decisions.length = 0;
  h.engine = null;
  h.calls = 0;
  h.mode = "hold";
  h.response = '{"thought":"t","witchSave":true}';
  h.releases.length = 0;
});

describe("手动暂停与继续不得破坏技能决策", () => {
  it("女巫用药中暂停后立即继续：重新询问同一点并采纳用药，不假运行也不跳过", async () => {
    const gameId = await startGame(singlePending());
    try {
      await waitFor(() => h.calls === 1, "女巫首次调用");
      const pausing = gameService.control(gameId, "pause");
      const starting = gameService.control(gameId, "start");
      await Promise.all([pausing, starting]);
      await waitFor(() => h.calls >= 2, "继续后重新询问女巫");
      releaseAi();
      await waitFor(() => h.engine!.state.decided.length === 1, "女巫决策被采纳");
      expect(h.engine!.state.decided[0]).toMatchObject({ witchSave: true });
      expect(h.engine!.state.decided[0]).not.toMatchObject({ skip: true });
    } finally {
      releaseAi();
      await gameService.control(gameId, "terminate");
    }
  });

  it("女巫用药中暂停并稍后继续：原决策点仍只被消费一次", async () => {
    const gameId = await startGame(singlePending());
    try {
      await waitFor(() => h.calls === 1, "女巫首次调用");
      await gameService.control(gameId, "pause");
      await waitFor(() => !registry.get(gameId)!.ticking, "暂停 tick 停稳");
      await gameService.control(gameId, "start");
      await waitFor(() => h.calls >= 2, "稍后继续后重新询问女巫");
      releaseAi();
      await waitFor(() => h.engine!.state.decided.length === 1, "女巫决策被采纳");
      expect(h.engine!.state.decided).toHaveLength(1);
      expect(h.engine!.state.decided[0]).toMatchObject({ witchSave: true });
    } finally {
      releaseAi();
      await gameService.control(gameId, "terminate");
    }
  });

  it("累计计时随暂停停止、继续累加、终止冻结并实时写入 setup", async () => {
    const gameId = await startGame(singlePending());
    const setup = () => (h.games.get(gameId)!.setup as { timing?: { accumulatedMs: number; runningSince: number | null; endedAt: number | null } }).timing;
    expect(setup()!.runningSince).not.toBeNull();
    await gameService.control(gameId, "pause");
    const first = setup()!.accumulatedMs;
    await new Promise((r) => setTimeout(r, 30));
    expect(setup()!.accumulatedMs).toBe(first);
    await gameService.control(gameId, "start");
    await new Promise((r) => setTimeout(r, 30));
    await gameService.control(gameId, "pause");
    expect(setup()!.accumulatedMs).toBeGreaterThan(first);
    await gameService.control(gameId, "terminate");
    const ended = setup()!;
    expect(ended.endedAt).not.toBeNull();
    await new Promise((r) => setTimeout(r, 20));
    expect(setup()!.accumulatedMs).toBe(ended.accumulatedMs);
  });

  it("批量技能中暂停后立即继续：整批重新询问，不把任何人按 skip 落库", async () => {
    h.response = '{"thought":"t","targets":[1]}';
    const gameId = await startGame(batchPending());
    try {
      await waitFor(() => h.calls === 2, "批量首次两个调用");
      const pausing = gameService.control(gameId, "pause");
      const starting = gameService.control(gameId, "start");
      await Promise.all([pausing, starting]);
      await waitFor(() => h.calls >= 4, "继续后整批重新询问");
      releaseAi();
      await waitFor(() => h.engine!.state.decided.length === 1, "批量决策被采纳");
      const input = h.engine!.state.decided[0];
      expect(input.batchInputs).toHaveLength(2);
      expect(input.batchInputs?.every((x) => x.targets?.[0] === 1 && x.skip !== true)).toBe(true);
    } finally {
      releaseAi();
      await gameService.control(gameId, "terminate");
    }
  });
});
