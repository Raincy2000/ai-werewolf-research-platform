// 事故回归测试：对局 0ca4c7a3 在第 279 号流程崩溃——
// 根因：服务层兜底的发言类集合漏了 wolfDiscuss，AI 连续失败时兜底决策无 speech，
// 被引擎拒绝（"发言类决策必须提供非空 speech"）→ 误判引擎内部异常 → 对局崩溃且无法重启。
// 本文件用真实引擎（无 mock）验证：兜底决策对任何决策类型都合法可用，特别是 wolfDiscuss。
import { describe, it, expect } from "vitest";
import { createEngine } from "./engine";
import { SPEECH_REQUIRED_KINDS } from "./engine/api";
import type { DecisionKind, PendingDecision, PlayerView } from "./engine/api";
import { heuristicDecision } from "./service";
import type { RoleId } from "../../contracts/game";

const STD12: RoleId[] = [
  "werewolf", "werewolf", "werewolf", "werewolf",
  "seer", "witch", "hunter", "idiot",
  "villager", "villager", "villager", "villager",
];

const OPTS = { stepDelayMs: 0, sheriffEnabled: true, allowSelfDestruct: true, speechRoundsLimit: 1 };

describe("兜底决策合法性（事故回归）", () => {
  it("真实引擎驱动到狼队讨论：兜底决策含非空 speech 且被引擎接受", () => {
    const engine = createEngine({ boardId: "standard12", seatRoles: STD12, options: OPTS });
    // 全程用兜底决策应答，一路推进到第一个 wolfDiscuss 待决（第1夜狼队思考×4之后）
    let adv = engine.advance();
    let guard = 0;
    while (adv.pending && adv.pending.kind !== "wolfDiscuss" && guard++ < 300) {
      // 顺带验证：途中所有决策类型的兜底都被引擎接受（不得再出现兜底被拒崩溃）
      expect(() => engine.decide(heuristicDecision(adv.pending!, "测试"))).not.toThrow();
      adv = engine.advance();
    }
    expect(adv.pending?.kind).toBe("wolfDiscuss");

    const fb = heuristicDecision(adv.pending!, "测试");
    expect(typeof fb.speech).toBe("string");
    expect(fb.speech!.trim().length).toBeGreaterThan(0);
    expect(() => engine.decide(fb)).not.toThrow();
  });

  it("所有发言类决策（SPEECH_REQUIRED_KINDS）的兜底均提供非空 speech", () => {
    // 最小 PlayerView 桩（heuristicDecision 只读 kind/options/allowSkip/aliveSeats）
    const stubView = {
      day: 2, phase: "night.wolfDiscuss", role: "werewolf", camp: "wolf",
      aliveSeats: [1, 2, 3, 4, 5], deadSeats: [], players: [],
      sheriffSeat: null, selfAlive: true,
      public: { log: [], announcedDeaths: [], sheriffSeat: null },
      private: {},
    } as unknown as PlayerView;
    for (const kind of SPEECH_REQUIRED_KINDS) {
      const pending: PendingDecision = {
        seat: 1, kind: kind as DecisionKind, role: "werewolf", hint: "", options: [], allowSkip: false, view: stubView,
      };
      const fb = heuristicDecision(pending, "测试");
      expect(typeof fb.speech, `kind=${kind} 的兜底必须提供 speech`).toBe("string");
      expect(fb.speech!.trim().length, `kind=${kind} 的兜底 speech 必须非空`).toBeGreaterThan(0);
    }
  });

  it("服务层与引擎的发言类集合同源（禁止两处列表漂移）", async () => {
    // 服务层 SPEECH_KINDS 即 SPEECH_REQUIRED_KINDS（同一对象引用）
    const svc = await import("./service");
    // 通过行为验证同源：wolfDiscuss 兜底含 speech（若两处列表再次漂移此测试立即变红）
    const engine = createEngine({ boardId: "standard12", seatRoles: STD12, options: OPTS });
    let adv = engine.advance();
    let guard = 0;
    while (adv.pending && adv.pending.kind !== "wolfDiscuss" && guard++ < 300) {
      engine.decide(heuristicDecision(adv.pending!, "测试"));
      adv = engine.advance();
    }
    expect(adv.pending?.kind).toBe("wolfDiscuss");
    expect(heuristicDecision(adv.pending!, "测试").speech?.trim()).toBeTruthy();
    expect(typeof svc.heuristicDecision).toBe("function");
  });
});

describe("赛后讨论兜底（postgameSpeak）", () => {
  it("单 pending 的兜底为 skip（弃权）且被真实引擎接受（聊天室逐个单问）", () => {
    const engine = createEngine({
      boardId: "standard12",
      seatRoles: STD12,
      options: { ...OPTS, postGameDiscuss: true },
    });
    let pgChecked = 0;
    let adv = engine.advance();
    let guard = 0;
    while (!engine.isFinished() && guard++ < 3000) {
      const p = adv.pending;
      if (!p) {
        adv = engine.advance();
        continue;
      }
      if (p.kind === "postgameSpeak") {
        pgChecked++;
        // 聊天室机制：赛后讨论按座位顺序逐个单问（非批次）；兜底=本轮弃权（skip=true，绝不代发言）
        expect(p.batch).toBeUndefined();
        const fb = heuristicDecision(p, "测试");
        expect(fb.skip).toBe(true);
        expect(fb.speech).toBeUndefined();
        expect(() => engine.decide(fb)).not.toThrow();
      } else if (p.kind === "wolfKill") {
        // 速杀脚本：顺次刀平民（9→10→11→12），快速分出胜负进入赛后
        engine.decide({ thought: "t", targets: [8 + p.view.day] });
      } else if (p.kind === "dayVote" || p.kind === "sheriffVote") {
        // 确定性：全员弃票（兜底对投票类会随机选人，可能提前放逐平民打乱速杀脚本）
        engine.decide({
          thought: "t",
          batchInputs: (p.batch ?? [p]).map(() => ({ thought: "t", skip: true })),
        });
      } else {
        // 其余决策全部走兜底，顺带验证任何类型的兜底都被引擎接受
        expect(() => engine.decide(heuristicDecision(p, "测试"))).not.toThrow();
      }
      adv = engine.advance();
    }
    expect(engine.isFinished()).toBe(true);
    // 首轮 12 人全员弃权 → 环节立即结束（恰好一轮、逐个单问共 12 个待决）
    expect(pgChecked).toBe(12);
  });
});
