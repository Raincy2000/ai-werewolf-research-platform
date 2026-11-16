import { describe, expect, it } from "vitest";
import type { GameEvent } from "../../contracts/game";
import type { PendingDecision, PlayerView } from "./engine/api";
import {
  buildLiveCognition,
  buildSelfFactIndex,
  buildSpeechReferenceIndex,
  buildVoteFactIndex,
  formatSelfFactLedger,
  formatSpeechReferenceIndex,
  formatVoteFactIndex,
} from "./evidence";
import { buildPrompt } from "./ai/prompts";

function event(seq: number, patch: Partial<GameEvent>): GameEvent {
  return {
    seq,
    day: 1,
    phase: "day.speech",
    type: "speech",
    actor: null,
    actorLabel: null,
    title: "公开发言",
    content: "公开事实",
    thought: null,
    meta: null,
    createdAt: new Date().toISOString(),
    ...patch,
  };
}

const events: GameEvent[] = [
  event(19, { day: 1, phase: "night.wolf", type: "action", title: "狼刀落定", content: "狼队最终决定袭击7号玩家。" }),
  event(21, { day: 1, phase: "night.guard", type: "action", actor: 4, actorLabel: "4号玩家", title: "守护", content: "守卫今夜守护了4号玩家。" }),
  event(23, { day: 1, phase: "night.witch", type: "action", actor: 10, actorLabel: "10号玩家", title: "解药", content: "女巫使用解药救7号玩家。" }),
  event(303, { day: 3, phase: "day.vote", type: "vote", actor: 4, actorLabel: "4号玩家", title: "放逐投票", content: "4号玩家投给6号。" }),
  event(308, { day: 3, phase: "day.vote", type: "vote", actor: 9, actorLabel: "9号玩家", title: "放逐投票", content: "9号玩家投给4号。" }),
  event(392, { day: 4, phase: "postgame.discuss", actor: 9, actorLabel: "9号玩家", title: "赛后讨论", content: "8号，你有没有想过他可能是女巫？", meta: { addressTo: 8 } }),
  event(10, { day: 1, phase: "night.wolfDiscuss", type: "action", actor: 1, actorLabel: "1号玩家", title: "狼人频道", content: "刀7号", meta: { channel: "wolf" } }),
];

function makePending(publicLog: string[]): PendingDecision {
  const view: PlayerView = {
    seat: 3,
    role: "seer",
    roleName: "预言家",
    camp: "god",
    day: 5,
    phase: "day.speech",
    aliveSeats: [1, 2, 3],
    deadSeats: [4],
    revealedRoles: {},
    sheriffSeat: null,
    selfAlive: true,
    rules: { witchSelfSave: "never" },
    publicLog,
    private: { seerChecks: [{ seat: 5, result: "wolf" }] },
  };
  return { seat: 3, kind: "daySpeech", role: "seer", hint: "轮到您发言", options: [], allowSkip: false, view };
}

describe("座位自我事实与赛后指代", () => {
  it("自我台账保真本人守夜与投票，公开记录保留他人行动但不冒充自我经历", () => {
    const self4 = buildSelfFactIndex("g", 4, events, { wolfTeam: false });
    expect(self4.map((ref) => ref.seq)).toEqual([21, 303]);
    const text = formatSelfFactLedger(self4, 4);
    expect(text).toContain("守卫今夜守护了4号玩家");
    expect(text).toContain("4号玩家投给6号");
    expect(text).not.toContain("9号玩家投给4号");
    expect(text).not.toContain("刀7号");
  });

  it("票型与回复对象按原始记录绑定，不把9号问8号错配给10号", () => {
    const votes = formatVoteFactIndex(buildVoteFactIndex("g", events));
    expect(votes).toContain("#303");
    expect(votes).toContain("4号玩家投给6号");
    const speeches = formatSpeechReferenceIndex(buildSpeechReferenceIndex("g", events));
    expect(speeches).toContain("#392");
    expect(speeches).toContain("9号玩家 → 8号玩家");
    expect(speeches).not.toContain("9号玩家 → 10号玩家");
    expect(speeches).toContain("8号，你有没有想过他可能是女巫？");
  });

  it("实时认知包保持公共事实一致、私域隔离，赛后附完整票型与发言指代", () => {
    const ordinary = buildLiveCognition("g", 4, events, { wolfTeam: false, postgame: true });
    const wolf = buildLiveCognition("g", 1, events, { wolfTeam: true, postgame: true });
    expect(ordinary.selfFacts).not.toContain("刀7号");
    expect(wolf.selfFacts).toContain("刀7号");
    expect(ordinary.postgameFacts).toContain("4号玩家投给6号");
    expect(ordinary.postgameFacts).toContain("9号玩家 → 8号玩家");
    expect(ordinary.publicFacts).toBe(wolf.publicFacts);
    expect(ordinary.publicFacts).toContain("狼队最终决定袭击7号玩家");
    expect(ordinary.publicFacts).toContain("女巫使用解药救7号玩家");
    expect(ordinary.publicFacts).not.toContain("8号，你有没有想过他可能是女巫？");
    const inGame = buildLiveCognition("g", 4, events, { wolfTeam: false, postgame: false });
    expect(inGame.publicFacts).not.toContain("狼队最终决定袭击7号玩家");
    expect(inGame.publicFacts).not.toContain("女巫使用解药救7号玩家");
    const withIntent = buildLiveCognition("g", 1, events, {
      wolfTeam: true,
      postgame: false,
      decisions: [
        { idx: 82, kind: "wolfThink", seat: 1, decision: { thought: "先刀7号的完整初始理由", targets: [7] } },
        { idx: 84, kind: "wolfDiscuss", seat: 1, decision: { thought: "现在改为刀3号", targets: [3] } },
      ],
    });
    expect(withIntent.intentTrail).toContain("先刀7号的完整初始理由");
    expect(withIntent.intentTrail).toContain("7号 → 3号");
  });
});

describe("完整认知包提示", () => {
  it("完整事实和自我台账不经过旧字数预算降级", () => {
    const full = "完整原文".repeat(5_000);
    const intentTrail = `【你的完整意图轨迹】\n${"长期理由".repeat(1_000)}`;
    const { user } = buildPrompt(makePending(Array.from({ length: 400 }, (_, i) => `旧记录${i}`)), {
      cognition: {
        publicFacts: `【完整公共事实】\n${full}`,
        selfFacts: "【自我事实】#303 4号玩家投给6号。",
        intentTrail,
        postgameFacts: "【赛后指代】#392 9号玩家 → 8号玩家",
      },
      modelContext: 8_192,
    });
    expect(user).toContain(full);
    expect(user).toContain("#303 4号玩家投给6号");
    expect(user).toContain(intentTrail);
    expect(user).toContain("#392 9号玩家 → 8号玩家");
    expect(user).not.toContain("（早期记录已省略）");
    expect(user.indexOf("【自我事实】")).toBeGreaterThan(user.indexOf("【你的私密信息】"));
    expect(user.indexOf("【你的完整意图轨迹】")).toBeGreaterThan(user.indexOf("【自我事实】"));
    expect(user.indexOf("【赛后指代】")).toBeLessThan(user.indexOf("【输出契约】"));
  });
});
