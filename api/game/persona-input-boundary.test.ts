import { describe, expect, it } from "vitest";
import type { GameSnapshot } from "../../contracts/game";
import { buildAnalysisPrompt } from "./analyst";
import { buildPersonaContext } from "../persona/context";
import { makeCard } from "../persona/pipeline.test";
import { personaGenderFromSetup } from "./personaVisibility";

function snapshot(): GameSnapshot {
  return {
    gameId: "g",
    boardId: "standard12",
    boardName: "12人标准场（预女猎白）",
    titleNo: "20261114001",
    status: "finished",
    day: 5,
    phase: "finished",
    phaseLabel: "结束",
    players: [{
      seat: 3, role: "witch", roleName: "女巫", camp: "god", alive: true, sheriff: false,
      deathInfo: null, aiModel: "m", personaName: "两面宿傩", personaGender: "男",
    }],
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
    createdAt: new Date(0).toISOString(),
  };
}

describe("人格输入边界：性别与关系物件", () => {
  it("分析师获得独立人格性别，不得把女巫等游戏身份当作性别", () => {
    const { user, system } = buildAnalysisPrompt(snapshot(), []);
    expect(user).toContain("3号=两面宿傩（男性，人称用「他」）");
    expect(system).toContain("不得把女巫等游戏身份当作人格性别");
  });

  it("历史快照从开局冻结人格卡恢复性别，而不是从角色名推断", () => {
    const setup = {
      personaSnapshots: {
        "3": { card: { profile: { gender: "男" } } },
      },
    };
    expect(personaGenderFromSetup(setup, 3)).toBe("男");
    expect(personaGenderFromSetup(setup, 4)).toBeNull();
  });

  it("信物与羁绊不自动升级为本人固定穿戴或高频习惯动作", () => {
    const card = makeCard({
      profile: {
        ...makeCard().profile,
        gender: "男",
        quirks: "围巾是与三笠一生羁绊的信物；咬破自己的手启动巨人化",
      },
    });
    const context = buildPersonaContext(card, null);
    expect(context.conscious).toContain("围巾是与三笠一生羁绊的信物");
    expect(context.conscious).toContain("关系信物不自动等于本人固定穿戴或高频动作");
    expect(context.conscious).toContain("可通过主体自己的观察、学习或模仿逐渐形成");
    expect(context.conscious).toContain("系统不把他人动作预置为本人习惯");
    expect(context.conscious).not.toContain("不得挪作本人习惯");
  });
});
