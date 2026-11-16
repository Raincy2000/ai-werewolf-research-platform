import { describe, expect, it } from "vitest";
import type { DecisionInput, EngineEvent, PendingDecision } from "./engine/api";
import { createEngine } from "./engine/index";
import type { RoleId } from "../../contracts/game";

function respond(p: PendingDecision): DecisionInput {
  if (p.kind === "sheriffOrder") return { thought: "定序考量", targets: [1] };
  if (p.kind === "witchAction") return p.view.day === 1 ? { thought: "t", witchSave: true } : { thought: "t", skip: true };
  if (p.kind === "exileSkill") return p.options.length
    ? { thought: "开枪权衡", targets: [p.options[0]] }
    : { thought: "无技能可发动", skip: true };
  if (p.batch) {
    return {
      thought: "t",
      batchInputs: p.batch.map((sub) => ({
        thought: "t",
        speech: "测试发言",
        targets: [sub.kind === "sheriffRun" ? (sub.seat === 1 ? 1 : 0) : (sub.options[0] ?? 0)],
      })),
    };
  }
  return {
    thought: "t",
    speech: "测试发言",
    targets: p.options.length ? [p.options[0]] : undefined,
    skip: p.allowSkip ? true : undefined,
  };
}

describe("技能与心理活动的统一展示", () => {
  it("警长定序同时进入公开频道与权衡面板，两侧均保留观察者心理", () => {
    const roles: RoleId[] = ["seer", "witch", "hunter", "villager", "villager", "villager", "werewolf", "werewolf", "werewolf"];
    const engine = createEngine({ boardId: "standard9", seatRoles: roles, options: { sheriffEnabled: true, stepDelayMs: 0, allowSelfDestruct: true, speechRoundsLimit: 1 } });
    let found = false;
    for (let i = 0; i < 100 && !found; i++) {
      const { pending } = engine.advance();
      if (!pending) continue;
      if (pending.kind === "sheriffOrder") {
        const events = engine.decide(respond(pending));
        const orders = events.filter((e) => e.title === "警长定序");
        expect(orders).toHaveLength(2);
        const thought = orders.find((e) => e.meta?.channel === "skillThink");
        expect(thought?.thought).toBe("定序考量");
        expect(thought?.meta?.skillObject).toBe("警长定序");
        const publicOrder = orders.find((e) => e.meta?.channel !== "skillThink");
        expect(publicOrder).toBeDefined();
        expect(publicOrder?.type).toBe("system");
        expect(publicOrder?.actor).toBe(pending.seat);
        expect(publicOrder?.content).toBe(thought?.content);
        expect(publicOrder?.content).toContain("升序");
        expect(publicOrder?.thought).toBe("定序考量");
        expect(publicOrder?.meta).toBeNull();
        found = true;
      } else {
        engine.decide(respond(pending));
      }
    }
    expect(found).toBe(true);
  });

  it("定序的公开事件与权衡事件都附加同一份人格标准模板", async () => {
    const { enrichPersonaEvents } = await import("./service");
    expect(enrichPersonaEvents).toBeTypeOf("function");
    const rt = {
      personaEventMeta: new Map([[1, {
        name: "测试人格",
        dual: true,
        contextVersion: "test",
        degraded: [],
        tensions: [],
        gt: "博弈解释",
        psy: "人格解释",
        observerThought: "【参数触发】测试【涌现输出】主体原文",
      }]]),
    };
    const events = [
      { actor: 1, type: "system", title: "警长定序", thought: "主体原文", meta: { channel: "skillThink" } },
      { actor: 1, type: "system", title: "警长定序", thought: "主体原文", meta: null },
    ];
    enrichPersonaEvents(rt as never, events as never);
    for (const event of events) {
      expect((event.meta as { persona?: { name?: string } } | null)?.persona?.name).toBe("测试人格");
      expect(event.thought).toBe("【参数触发】测试【涌现输出】主体原文");
    }
    expect(rt.personaEventMeta.size).toBe(0);
  }, 20_000);

  it("系统放逐问询不显示心理活动，实际开枪保留心理活动", () => {
    const roles: RoleId[] = ["seer", "witch", "hunter", "guard", "villager", "villager", "villager", "villager", "werewolf", "werewolf", "werewolf", "wolfKing"];
    const engine = createEngine({ boardId: "wolfKingGuard12", seatRoles: roles, options: { sheriffEnabled: false, stepDelayMs: 0, allowSelfDestruct: true, speechRoundsLimit: 1 } });
    const events: EngineEvent[] = [];
    for (let i = 0; i < 180; i++) {
      const { pending } = engine.advance();
      if (!pending) continue;
      const produced = engine.decide(respond(pending));
      events.push(...produced);
      if (produced.some((e) => e.title === "开枪" && e.actor === 4) || engine.isFinished()) break;
    }
    const fired = events.find((e) => e.title === "开枪" && e.thought === "开枪权衡");
    expect(fired).toBeDefined();
    const inquiry = events.find((e) => e.title === "放逐权衡" && e.actor === fired?.actor);
    expect(inquiry).toBeDefined();
    expect(inquiry?.thought).toBeNull();
    expect(fired?.thought).toBe("开枪权衡");
  });
});
