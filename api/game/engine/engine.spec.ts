// ============================================================
// 狼人杀引擎测试
// ① 11 个版型 × 3 局完整对局（确定性启发式 autoPlayer，固定种子）
//    - 每局 ≤5000 次决策内分出胜负、无异常
//    - 信息壁垒：扫描所有 PendingDecision.view 序列化文本
//    - 狼人视角不含石像鬼/隐狼
//    - 胜利方合法
// ② 关键规则专项测试（脚本化决策）
// ============================================================

import { describe, it, expect } from "vitest";
import { createEngine } from "./index";
import type { DecisionInput, Engine, EngineEvent, PendingDecision, PlayerView } from "./api";
import { BOARDS, ROLE_META } from "../../../contracts/game";
import type { AdvancedOptions, RoleId } from "../../../contracts/game";

// ---------- 确定性随机 ----------
function mulberry32(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle<T>(arr: T[], rng: () => number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const ROLE_IDS = Object.keys(ROLE_META) as RoleId[];
const MEETING_WOLF_ROLES: RoleId[] = ["werewolf", "wolfKing", "whiteWolfKing", "nightmare", "bloodMoon", "mechWolf"];
const LONE_WOLF_ROLES: RoleId[] = ["gargoyle", "hiddenWolf"];

// ---------- autoPlayer（确定性启发式） ----------
function makeAutoPlayer(seed: number) {
  const rng = mulberry32(seed);
  let counter = 0;
  const pick = <T>(arr: T[]): T => arr[Math.floor(rng() * arr.length)];
  const answer = (p: PendingDecision): DecisionInput => {
    // 并行权衡批次：逐个子待决独立作答（各玩家互不可见彼此权衡，并发安全）
    if (p.batch) {
      counter++;
      return { thought: `THOUGHT_BATCH_#${counter}`, batchInputs: p.batch.map(answer) };
    }
    counter++;
    const thought = `THOUGHT_S${p.seat}_#${counter}_${p.kind}`;
    const speech = `SPEECH_S${p.seat}_D${p.view.day}_#${counter}：我是${p.seat}号玩家，大家理性分析局势。`;
    const mates = p.view.private.wolfTeammates ?? [];
    const nonWolfOpts = p.options.filter((s) => s !== p.seat && !mates.includes(s));
    switch (p.kind) {
      case "nightmareFear": {
        const opts = nonWolfOpts.length ? nonWolfOpts : p.options;
        return { thought, targets: [pick(opts)] };
      }
      case "wolfThink":
        return { thought };
      case "daySkill":
        return { thought, skip: true }; // 主动技能窗口：默认按兵不动
      case "wolfDiscuss":
        return { thought, speech: `WOLFCHAT_S${p.seat}_D${p.view.day}_#${counter}：队友们今晚听我的，优先刀神职。` };
      case "wolfKill": {
        const opts = nonWolfOpts.length ? nonWolfOpts : p.options;
        return { thought, targets: [pick(opts)] };
      }
      case "gargoyleCheck":
      case "seerCheck":
      case "psychicCheck":
      case "dreamerDream":
      case "guardProtect":
        return { thought, targets: [pick(p.options)] };
      case "mechWolfMimic":
        return rng() < 0.7 ? { thought, targets: [pick(p.options)] } : { thought, skip: true };
      case "witchAction": {
        const victim = p.view.private.witchVictimTonight;
        if (victim != null && victim !== p.seat && p.view.private.witchPotions?.save)
          return { thought, witchSave: true };
        return { thought, skip: true };
      }
      case "demonHunterHunt":
        return rng() < 0.5 ? { thought, targets: [pick(p.options)] } : { thought, skip: true };
      case "crowCurse":
        return rng() < 0.8 ? { thought, targets: [pick(p.options)] } : { thought, skip: true };
      case "sheriffRun":
        return { thought, targets: [rng() < 0.35 ? 1 : 0] };
      case "sheriffSpeech":
      case "pkSpeech":
      case "lastWords":
        return { thought, speech };
      case "sheriffVote":
        return { thought, targets: [pick(p.options)] };
      case "sheriffOrder":
        return { thought, targets: [rng() < 0.5 ? 1 : 0] };
      case "daySpeech": {
        if (MEETING_WOLF_ROLES.includes(p.role) && rng() < 0.04)
          return { thought, selfDestruct: true };
        if (p.role === "knight" && rng() < 0.15) {
          const others = p.view.aliveSeats.filter((s) => s !== p.seat);
          return { thought, duel: pick(others) };
        }
        return { thought, speech };
      }
      case "dayVote":
        return p.allowSkip && rng() < 0.08 ? { thought, skip: true } : { thought, targets: [pick(p.options)] };
      case "hunterShoot":
        return rng() < 0.5 ? { thought, skip: true } : { thought, targets: [pick(p.options)] };
      case "exileSkill":
        // 放逐技能询问：猎人/狼王一半概率开枪，其余沉默
        return p.options.length && rng() < 0.5
          ? { thought, targets: [pick(p.options)] }
          : { thought, skip: true };
      case "whiteWolfTake":
        return { thought, targets: [pick(p.options)] };
      case "badgePass":
        // 警徽流：一半概率移交警徽接任，一半撕毁
        return rng() < 0.5 ? { thought, targets: [pick(p.options)] } : { thought, skip: true };
      default:
        return { thought, targets: [pick(p.options)] };
    }
  };
  return answer;
}

// ---------- 对局驱动 ----------
interface CapturedView {
  seat: number;
  kind: string;
  view: PlayerView;
}

function playGame(boardIdx: number, seed: number) {
  const board = BOARDS[boardIdx];
  const rng = mulberry32(seed);
  const seatRoles = shuffle(board.roles, rng);
  const options: AdvancedOptions = {
    stepDelayMs: 0,
    sheriffEnabled: board.sheriff,
    allowSelfDestruct: true,
    speechRoundsLimit: 2,
  };
  const engine = createEngine({ boardId: board.id, seatRoles, options });
  const auto = makeAutoPlayer(seed * 7 + 1);
  const views: CapturedView[] = [];
  let decisions = 0;
  let r = engine.advance();
  while (!engine.isFinished()) {
    if (!r.pending) {
      r = engine.advance();
      continue;
    }
    decisions++;
    if (decisions > 6000) throw new Error("决策次数超限（死循环？）");
    views.push({ seat: r.pending.seat, kind: r.pending.kind, view: r.pending.view });
    engine.decide(auto(r.pending));
    r = engine.advance();
  }
  return { engine, decisions, views, seatRoles, board };
}

// ---------- 信息壁垒检查 ----------
function assertInfoBarrier(views: CapturedView[], seatRoles: RoleId[]) {
  const loneWolfSeats = seatRoles
    .map((r, i) => (LONE_WOLF_ROLES.includes(r) ? i + 1 : -1))
    .filter((s) => s > 0);
  for (const { kind, view } of views) {
    const json = JSON.stringify(view);
    // 任何玩家的心理活动绝不出现在视图中
    expect(json.includes("THOUGHT_")).toBe(false);
    // 不允许出现其他玩家的 roleId（自己 + 已公开翻牌者除外）
    const allowed = new Set<RoleId>([view.role, ...Object.values(view.revealedRoles)]);
    for (const rid of ROLE_IDS) {
      if (!allowed.has(rid)) {
        expect(json.includes(`"${rid}"`)).toBe(false);
      }
    }
    // 死者不再收到决策请求（死亡触发技除外：开枪/带人/遗言/警徽流抉择）
    if (!view.selfAlive) {
      expect(["hunterShoot", "whiteWolfTake", "lastWords", "badgePass"]).toContain(kind);
    }
    // 狼人视角：绝不含石像鬼/隐狼
    if (MEETING_WOLF_ROLES.includes(view.role)) {
      expect(json.includes('"gargoyle"')).toBe(false);
      expect(json.includes('"hiddenWolf"')).toBe(false);
      for (const hs of loneWolfSeats) {
        expect(view.private.wolfTeammates ?? []).not.toContain(hs);
      }
    }
  }
}

// ============================================================
// 主套件：11 版型 × 3 局
// ============================================================
describe("引擎：全版型完整对局（autoPlayer）", () => {
  BOARDS.forEach((board, bi) => {
    it(`${board.id}（${board.name}）× 3 局`, () => {
      for (let g = 0; g < 3; g++) {
        const seed = 20240 + bi * 977 + g * 131;
        const { engine, decisions, views, seatRoles } = playGame(bi, seed);

        // ① 5000 次决策内分出胜负，无异常（loop 内抛错即失败）
        expect(engine.isFinished()).toBe(true);
        expect(decisions).toBeLessThanOrEqual(5000);

        // ⑤ 胜利方合法
        const snap = engine.getSnapshot();
        expect(snap.winner).not.toBeNull();
        const wolves = snap.players.filter((p) => p.camp === "wolf");
        const gods = snap.players.filter((p) => p.camp === "god");
        const vils = snap.players.filter((p) => p.camp === "villager");
        if (snap.winner === "good") {
          expect(wolves.every((p) => !p.alive)).toBe(true);
        } else {
          expect(gods.every((p) => !p.alive) || vils.every((p) => !p.alive)).toBe(true);
        }

        // ③④ 信息壁垒
        assertInfoBarrier(views, seatRoles);

        expect(snap.players.length).toBe(board.playerCount);
      }
    });
  });
});

// ============================================================
// 专项规则测试（脚本化决策）
// ============================================================

const QUICK = (p: PendingDecision): DecisionInput => {
  const thought = `THOUGHT_S${p.seat}`;
  // 并行权衡批次：逐个子待决独立作答
  if (p.batch) return { thought, batchInputs: p.batch.map(QUICK) };
  switch (p.kind) {
    case "wolfThink":
      return { thought }; // 思考型决策：只需 thought
    case "daySkill":
      return { thought, skip: true }; // 主动技能窗口：默认按兵不动
    case "wolfDiscuss":
      return { thought, speech: `WOLFCHAT_S${p.seat}_D${p.view.day}：今晚统一刀口，别分票。` };
    case "sheriffSpeech":
    case "daySpeech":
    case "pkSpeech":
    case "lastWords":
      return { thought, speech: `SPEECH_S${p.seat}` };
    case "sheriffRun":
      return { thought, targets: [0] };
    case "sheriffWithdraw":
      return { thought, targets: [0] }; // 默认留在竞选（不退水）
    case "sheriffVote":
    case "dayVote":
    case "witchAction":
    case "hunterShoot":
    case "guardProtect":
    case "crowCurse":
    case "demonHunterHunt":
    case "mechWolfMimic":
    case "whiteWolfTake":
    case "exileSkill":
      return { thought, skip: true };
    default:
      return { thought, targets: [p.options[0]] };
  }
};

// 并行权衡批次应答：指定座位执行动作（duel/selfDestruct），其余子项由 QUICK 兜底
//（合并批次含发言子项——发言不合法跳过，QUICK 会给出合规 speech）
const BATCH_WITH = (p: PendingDecision, seat: number, act: Partial<DecisionInput>): DecisionInput => ({
  thought: "t",
  batchInputs: (p.batch ?? [p]).map((sub) => (sub.seat === seat ? { thought: "t", ...act } : QUICK(sub))),
});

// 合并批次中按「子待决 kind+seat」定向作答（如批次内嵌的发言者自爆/决斗），其余子项 QUICK 兜底；
// 不在批次中找不到目标子项时返回 null（交给后续分支处理）
const BATCH_ON = (
  p: PendingDecision,
  kind: string,
  seat: number,
  act: Partial<DecisionInput>,
): DecisionInput | null => {
  if (!p.batch) return null;
  const i = p.batch.findIndex((x) => x.kind === kind && x.seat === seat);
  if (i < 0) return null;
  return { thought: "t", batchInputs: p.batch.map((sub, j) => (j === i ? { thought: "t", ...act } : QUICK(sub))) };
};

// 展开待决（含批次子项）中指定 kind 的子待决列表——发言与权衡并行后，
// 后续发言以待决形式内嵌于 daySkill 合并批次，计数发言须按子待决展开
const subPendings = (pendings: PendingDecision[], kind: string): PendingDecision[] =>
  pendings.flatMap((p) => (p.batch ? p.batch.filter((s) => s.kind === kind) : p.kind === kind ? [p] : []));

// 同时暗选/暗票批次应答：逐个子待决（选民）独立映射作答（报名/投票批次为并行待决，必须回 batchInputs）
const BATCH_MAP = (
  p: PendingDecision,
  fn: (sub: PendingDecision) => DecisionInput,
): DecisionInput => ({
  thought: "t",
  batchInputs: (p.batch ?? [p]).map(fn),
});

interface DriveOpts {
  stop?: (pending: PendingDecision | null, engine: Engine) => boolean;
  options?: Partial<AdvancedOptions>;
  max?: number;
}

function drive(
  boardId: string,
  seatRoles: RoleId[],
  decide: (p: PendingDecision, e: Engine) => DecisionInput,
  opts: DriveOpts = {}
) {
  const board = BOARDS.find((b) => b.id === boardId)!;
  const options: AdvancedOptions = {
    stepDelayMs: 0,
    sheriffEnabled: board.sheriff,
    allowSelfDestruct: true,
    speechRoundsLimit: 1,
    ...opts.options,
  };
  const engine = createEngine({ boardId, seatRoles, options });
  const pendings: PendingDecision[] = [];
  const events: EngineEvent[] = [];
  const max = opts.max ?? 3000;
  let r = engine.advance();
  events.push(...r.events);
  let steps = 0;
  while (!engine.isFinished() && steps < max) {
    if (opts.stop?.(r.pending, engine)) {
      if (r.pending) pendings.push(r.pending); // 记录停止点 pending（未决策）
      break;
    }
    if (!r.pending) {
      r = engine.advance();
      events.push(...r.events);
      continue;
    }
    steps++;
    pendings.push(r.pending);
    events.push(...engine.decide(decide(r.pending, engine)));
    r = engine.advance();
    events.push(...r.events);
  }
  return { engine, pendings, events, steps };
}

const GUARD_BOARD_ROLES: RoleId[] = [
  "werewolf", "werewolf", "werewolf", "wolfKing",
  "seer", "witch", "hunter", "guard",
  "villager", "villager", "villager", "villager",
];

describe("专项：夜间规则", () => {
  it("同守同救奶穿 + 女巫一晚只能一瓶药（非法抛错可重试）", () => {
    let witchHandled = false;
    const { engine } = drive("wolfKingGuard12", GUARD_BOARD_ROLES, (p, e) => {
      const thought = "t";
      switch (p.kind) {
        case "wolfKill":
          return { thought, targets: [9] };
        case "guardProtect":
          return { thought, targets: [9] };
        case "witchAction": {
          // 同一晚解药+毒药 → 必须抛错，且引擎状态不变可重试
          expect(() => e.decide({ thought, witchSave: true, targets: [5] })).toThrow(/一瓶/);
          expect(p.view.private.witchVictimTonight).toBe(9);
          witchHandled = true;
          return { thought, witchSave: true };
        }
        case "seerCheck":
          return { thought, targets: [1] };
        default:
          return QUICK(p);
      }
    }, {
      stop: (p) => p?.kind === "sheriffRun",
    });
    expect(witchHandled).toBe(true);
    // 9号被守又被救 → 奶穿死亡
    const s9 = engine.getSnapshot().players.find((x) => x.seat === 9)!;
    expect(s9.alive).toBe(false);
    expect(s9.deathInfo).toContain("被狼人袭击");
  });

  it("守卫不能连续两晚守同一人（非法目标抛错）", () => {
    let guardNight2Seen = false;
    const { engine } = drive("wolfKingGuard12", GUARD_BOARD_ROLES, (p, e) => {
      const thought = "t";
      if (p.kind === "wolfKill") return { thought, targets: [9 + p.view.day] }; // 10/11/12 顺次
      if (p.kind === "guardProtect") {
        if (p.view.day === 1) return { thought, targets: [5] };
        // 第二晚：5 不在可选项内
        expect(p.options).not.toContain(5);
        expect(() => e.decide({ thought, targets: [5] })).toThrow(/不合法/);
        guardNight2Seen = true;
        return { thought, targets: [6] };
      }
      if (p.kind === "seerCheck") return { thought, targets: [1] };
      return QUICK(p);
    }, {
      stop: (p) => p?.kind === "guardProtect" && p.view.day === 3,
    });
    expect(guardNight2Seen).toBe(true);
    expect(engine.getSnapshot().players.find((x) => x.seat === 10)!.alive).toBe(false);
  });

  it("摄梦人：同一人连续两晚被摄 → 第二晚死亡", () => {
    const ROLES: RoleId[] = [
      "werewolf", "werewolf", "werewolf", "wolfKing",
      "seer", "witch", "hunter", "dreamer",
      "villager", "villager", "villager", "villager",
    ];
    const { engine } = drive("wolfKingDreamer12", ROLES, (p) => {
      const thought = "t";
      if (p.kind === "wolfKill") return { thought, targets: [p.view.day === 1 ? 10 : 11] };
      if (p.kind === "dreamerDream") return { thought, targets: [9] };
      if (p.kind === "seerCheck") return { thought, targets: [1] };
      return QUICK(p);
    }, {
      stop: (p) => p?.kind === "daySpeech" && p.view.day === 2,
    });
    const s9 = engine.getSnapshot().players.find((x) => x.seat === 9)!;
    expect(s9.alive).toBe(false);
    expect(s9.deathInfo).toContain("摄梦");
  });

  it("猎魔人：免疫女巫毒药；狩猎中狼则狼死", () => {
    const ROLES: RoleId[] = [
      "werewolf", "werewolf", "werewolf", "bloodMoon",
      "seer", "witch", "demonHunter", "idiot",
      "villager", "villager", "villager", "villager",
    ];
    let night2WitchPotions: { save: boolean; poison: boolean } | undefined;
    const { engine } = drive("bloodMoonHunter12", ROLES, (p) => {
      const thought = "t";
      if (p.kind === "wolfKill") return { thought, targets: [p.view.day === 1 ? 9 : 10] };
      if (p.kind === "witchAction") {
        if (p.view.day === 1) return { thought, targets: [7] }; // 毒猎魔人 → 免疫
        night2WitchPotions = p.view.private.witchPotions;
        return { thought, skip: true };
      }
      if (p.kind === "demonHunterHunt") return { thought, targets: [1] }; // 中狼 → 狼死
      if (p.kind === "seerCheck") return { thought, targets: [1] };
      return QUICK(p);
    }, {
      stop: (p) => p?.kind === "daySpeech" && p.view.day === 2,
    });
    const snap = engine.getSnapshot();
    expect(snap.players.find((x) => x.seat === 7)!.alive).toBe(true); // 猎魔人免疫毒药存活
    const s1 = snap.players.find((x) => x.seat === 1)!;
    expect(s1.alive).toBe(false);
    expect(s1.deathInfo).toContain("狩猎");
    expect(night2WitchPotions?.poison).toBe(false); // 毒药已消耗
  });

  it("噩梦之影：恐惧狼则狼队当夜无刀；恐惧神则其技能被封", () => {
    const ROLES: RoleId[] = [
      "werewolf", "werewolf", "werewolf", "nightmare",
      "seer", "witch", "hunter", "guard",
      "villager", "villager", "villager", "villager",
    ];
    // A. 恐惧狼（1号）→ 当夜无 wolfKill 决策、女巫见无刀口、全员存活到天亮
    const a = drive("nightmareGuard12", ROLES, (p) => {
      if (p.kind === "nightmareFear") return { thought: "t", targets: [1] };
      if (p.kind === "seerCheck") return { thought: "t", targets: [1] };
      return QUICK(p);
    }, {
      stop: (p) => p?.kind === "sheriffRun",
    });
    const night1Kinds = a.pendings.filter((p) => p.view.day === 1).map((p) => p.kind);
    expect(night1Kinds).toContain("nightmareFear");
    expect(night1Kinds).not.toContain("wolfKill");
    const witchP = a.pendings.find((p) => p.kind === "witchAction");
    expect(witchP?.view.private.witchVictimTonight ?? null).toBeNull();
    expect(a.engine.getSnapshot().players.every((x) => x.alive)).toBe(true);

    // B. 恐惧守卫（8号）→ 守卫当夜无决策
    const b = drive("nightmareGuard12", ROLES, (p) => {
      if (p.kind === "nightmareFear") return { thought: "t", targets: [8] };
      if (p.kind === "wolfKill") return { thought: "t", targets: [9] };
      if (p.kind === "seerCheck") return { thought: "t", targets: [1] };
      return QUICK(p);
    }, {
      stop: (p) => p?.kind === "sheriffRun",
    });
    const kinds = b.pendings.filter((p) => p.view.day === 1).map((p) => p.kind);
    expect(kinds).not.toContain("guardProtect");
    expect(b.engine.getSnapshot().players.find((x) => x.seat === 9)!.alive).toBe(false);
  });
});

describe("专项：白天规则", () => {
  const STD12: RoleId[] = [
    "werewolf", "werewolf", "werewolf", "werewolf",
    "seer", "witch", "hunter", "idiot",
    "villager", "villager", "villager", "villager",
  ];

  it("白痴被放逐：翻牌免死，之后可发言、不可被投票", () => {
    const { engine, pendings } = drive("standard12", STD12, (p) => {
      const thought = "t";
      if (p.kind === "wolfKill") return { thought, targets: [p.view.day === 1 ? 9 : 10] };
      if (p.kind === "seerCheck") return { thought, targets: [1] };
      if (p.kind === "dayVote")
        return BATCH_MAP(p, (sub) =>
          sub.seat === 8 ? { thought, skip: true } : { thought, targets: [8] },
        ); // 全投白痴（8号自己弃票）
      return QUICK(p);
    }, {
      stop: (p) => p?.kind === "dayVote" && p.view.day === 2,
    });
    const s8 = engine.getSnapshot().players.find((x) => x.seat === 8)!;
    expect(s8.alive).toBe(true);
    // 翻牌公开：后续视图可见 revealedRoles[8]
    const later = pendings.find((p) => p.view.day === 2);
    expect(later?.view.revealedRoles[8]).toBe("idiot");
    // 第2天投票选项不含白痴（不可被投票）
    const day2Vote = pendings[pendings.length - 1];
    expect(day2Vote.kind).toBe("dayVote");
    expect(day2Vote.options).not.toContain(8);
  });

  it("白痴翻牌后触发白日技能窗口：默认按兵不动，流程照常继续", () => {
    const { engine, pendings } = drive("standard12", STD12, (p) => {
      const thought = "t";
      if (p.kind === "wolfKill") return { thought, targets: [p.view.day === 1 ? 9 : 10] };
      if (p.kind === "seerCheck") return { thought, targets: [1] };
      if (p.kind === "dayVote")
        return BATCH_MAP(p, (sub) =>
          sub.seat === 8 ? { thought, skip: true } : { thought, targets: [8] },
        );
      return QUICK(p);
    }, {
      stop: (p) => p?.kind === "dayVote" && p.view.day === 2,
    });
    // 翻牌后存在一次以「8号翻牌为白痴」为思考对象的技能权衡批次
    const flipWeigh = pendings.find(
      (p) =>
        p.kind === "daySkill" &&
        (p.batch ?? [p]).some((s) => s.hint.includes("8号翻牌为白痴")),
    );
    expect(flipWeigh).toBeTruthy();
    // 白痴存活且流程推进到第2天
    expect(engine.getSnapshot().players.find((x) => x.seat === 8)!.alive).toBe(true);
    expect(pendings[pendings.length - 1].view.day).toBe(2);
  });

  it("白痴翻牌后狼人自爆：打断当天直接入夜，白痴免死不受影响", () => {
    const { engine, pendings } = drive("standard12", STD12, (p) => {
      const thought = "t";
      if (p.kind === "wolfKill") return { thought, targets: [p.view.day === 1 ? 9 : 10] };
      if (p.kind === "seerCheck") return { thought, targets: [1] };
      if (p.kind === "dayVote")
        return BATCH_MAP(p, (sub) =>
          sub.seat === 8 ? { thought, skip: true } : { thought, targets: [8] },
        );
      // 翻牌为白痴后的权衡批次：1号狼自爆
      if (
        p.kind === "daySkill" &&
        p.batch?.some((s) => s.hint.includes("8号翻牌为白痴"))
      ) {
        return {
          thought,
          batchInputs: p.batch.map((sub) =>
            sub.seat === 1 ? { thought, selfDestruct: true } : { thought, skip: true },
          ),
        };
      }
      return QUICK(p);
    }, {
      stop: (p) => p?.kind === "wolfKill" && p.view.day === 2,
    });
    const snap = engine.getSnapshot();
    expect(snap.players.find((x) => x.seat === 8)!.alive).toBe(true); // 白痴免死仍在
    expect(snap.players.find((x) => x.seat === 1)!.alive).toBe(false); // 自爆狼出局
    // 自爆打断：下一待决是第2天夜晚
    const lastP = pendings[pendings.length - 1];
    expect(lastP.view.day).toBe(2);
    expect(lastP.kind).toBe("wolfKill");
  });

  it("骑士决斗狼人：狼出局并立即入夜；骑士翻牌", () => {
    const ROLES: RoleId[] = [
      "werewolf", "werewolf", "werewolf", "whiteWolfKing",
      "seer", "witch", "knight", "guard",
      "villager", "villager", "villager", "villager",
    ];
    const { engine, pendings } = drive("whiteWolfKnight12", ROLES, (p) => {
      const thought = "t";
      if (p.kind === "wolfKill") return { thought, targets: [9] };
      if (p.kind === "seerCheck") return { thought, targets: [1] };
      if (p.kind === "daySpeech" && p.seat === 7) return { thought, duel: 1 };
      // 发言与权衡并行后，7号的发言可能内嵌于 daySkill 合并批次
      const on = BATCH_ON(p, "daySpeech", 7, { duel: 1 });
      if (on) return on;
      return QUICK(p);
    }, {
      stop: (p) => p?.kind === "wolfKill" && p.view.day === 2,
    });
    const snap = engine.getSnapshot();
    expect(snap.players.find((x) => x.seat === 1)!.alive).toBe(false);
    expect(snap.players.find((x) => x.seat === 7)!.alive).toBe(true);
    const lastP = pendings[pendings.length - 1];
    expect(lastP.view.day).toBe(2); // 立即进入黑夜
    expect(lastP.view.revealedRoles[7]).toBe("knight");
  });

  it("骑士决斗好人：骑士出局，白天流程继续", () => {
    const ROLES: RoleId[] = [
      "werewolf", "werewolf", "werewolf", "whiteWolfKing",
      "seer", "witch", "knight", "guard",
      "villager", "villager", "villager", "villager",
    ];
    const { engine } = drive("whiteWolfKnight12", ROLES, (p) => {
      const thought = "t";
      if (p.kind === "wolfKill") return { thought, targets: [9] };
      if (p.kind === "seerCheck") return { thought, targets: [1] };
      if (p.kind === "daySpeech" && p.seat === 7) return { thought, duel: 10 }; // 10是平民（9号已被刀）
      const on = BATCH_ON(p, "daySpeech", 7, { duel: 10 });
      if (on) return on;
      if (p.kind === "dayVote")
        return BATCH_MAP(p, (sub) =>
          sub.seat === 1 ? { thought, skip: true } : { thought, targets: [1] },
        );
      return QUICK(p);
    }, {
      stop: (p) => p?.kind === "wolfKill" && p.view.day === 2,
    });
    const snap = engine.getSnapshot();
    const s7 = snap.players.find((x) => x.seat === 7)!;
    expect(s7.alive).toBe(false);
    expect(s7.deathInfo).toContain("决斗");
    expect(snap.players.find((x) => x.seat === 10)!.alive).toBe(true); // 决斗目标是好人，不死
  });

  it("白狼王自爆带人：直接入夜", () => {
    const ROLES: RoleId[] = [
      "werewolf", "werewolf", "werewolf", "whiteWolfKing",
      "seer", "witch", "hunter", "guard",
      "villager", "villager", "villager", "villager",
    ];
    let takeSeen = false;
    const { engine, pendings } = drive("whiteWolfGuard12", ROLES, (p) => {
      const thought = "t";
      if (p.kind === "wolfKill") return { thought, targets: [9] };
      if (p.kind === "seerCheck") return { thought, targets: [1] };
      if (p.kind === "daySpeech" && p.seat === 4) return { thought, selfDestruct: true };
      // 发言与权衡并行后，4号的发言可能内嵌于 daySkill 合并批次
      const on = BATCH_ON(p, "daySpeech", 4, { selfDestruct: true });
      if (on) return on;
      if (p.kind === "whiteWolfTake") {
        takeSeen = true;
        return { thought, targets: [5] };
      }
      return QUICK(p);
    }, {
      stop: (p) => p?.kind === "wolfKill" && p.view.day === 2,
    });
    expect(takeSeen).toBe(true);
    const snap = engine.getSnapshot();
    const s4 = snap.players.find((x) => x.seat === 4)!;
    const s5 = snap.players.find((x) => x.seat === 5)!;
    expect(s4.alive).toBe(false);
    expect(s4.deathInfo).toContain("自爆");
    expect(s5.alive).toBe(false);
    expect(s5.deathInfo).toContain("白狼王");
    expect(pendings[pendings.length - 1].view.day).toBe(2);
  });

  it("主动技能窗口（夜亡公告+竞选结果）：骑士与见面狼均被询问，默认按兵不动白天照常", () => {
    const ROLES: RoleId[] = [
      "werewolf", "werewolf", "werewolf", "whiteWolfKing",
      "seer", "witch", "knight", "guard",
      "villager", "villager", "villager", "villager",
    ];
    const { pendings } = drive("whiteWolfKnight12", ROLES, (p) => {
      const thought = "t";
      if (p.kind === "wolfKill") return { thought, targets: [9] };
      if (p.kind === "seerCheck") return { thought, targets: [1] };
      return QUICK(p);
    }, {
      stop: (p) => p?.kind === "daySpeech", // 停在第1天首次发言前
    });
    // 首次发言前共有两轮权衡：夜亡公告（竞选报名之前）+ 竞选结果（竞选之后，此处无人上警→警徽流失）
    // 均为 4只见面狼 + 骑士（7号）的并行批次（batch），phase 为 day.skill
    const skills = pendings.filter((p) => p.kind === "daySkill" && p.view.day === 1);
    expect(skills.length).toBe(2);
    for (const sk of skills) {
      expect(sk.batch!.map((p) => p.seat)).toEqual([1, 2, 3, 4, 7]);
      expect(sk.batch!.every((p) => p.view.phase === "day.skill")).toBe(true);
      expect(sk.batch!.every((p) => p.allowSkip)).toBe(true);
    }
  });

  it("同时暗选：上警报名为全员并行批次，公布前视图互不可见他人选择", () => {
    const { pendings } = drive("standard12", STD12, (p) => {
      if (p.kind === "wolfKill") return { thought: "t", targets: [9] };
      return QUICK(p);
    }, {
      stop: (p) => p?.kind === "sheriffRun", // 停在竞选报名
    });
    const run = pendings[pendings.length - 1];
    expect(run.kind).toBe("sheriffRun");
    // 全部存活者（11人，9号首夜被刀）打包为一个并行批次，互不可见彼此选择
    expect(run.batch!.map((x) => x.seat)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12]);
    for (const sub of run.batch!) {
      expect(sub.view.publicLog.join("\n")).not.toContain("警长竞选");
    }
  });

  it("同时暗票：放逐投票为全体选民并行批次，唱票前视图互不可见他人票型", () => {
    const { pendings } = drive("standard12", STD12, (p) => {
      if (p.kind === "wolfKill") return { thought: "t", targets: [9] };
      return QUICK(p);
    }, {
      stop: (p) => p?.kind === "dayVote", // 停在第1天放逐投票
    });
    const vote = pendings[pendings.length - 1];
    expect(vote.kind).toBe("dayVote");
    // 全体存活选民打包为一个并行批次（每人 options 排除自己），唱票前无投票明细流入公开日志
    expect(vote.batch!.map((x) => x.seat)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12]);
    for (const sub of vote.batch!) {
      expect(sub.options).not.toContain(sub.seat);
      expect(sub.view.publicLog.join("\n")).not.toContain("放逐投票");
    }
  });

  it("开局权衡：夜亡公告后立即出现当天第一次技能权衡（早于警长竞选报名）", () => {
    const ROLES: RoleId[] = [
      "werewolf", "werewolf", "werewolf", "whiteWolfKing",
      "seer", "witch", "knight", "guard",
      "villager", "villager", "villager", "villager",
    ];
    const { pendings } = drive("whiteWolfKnight12", ROLES, (p) => {
      const thought = "t";
      if (p.kind === "wolfKill") return { thought, targets: [9] };
      if (p.kind === "seerCheck") return { thought, targets: [1] };
      return QUICK(p);
    }, {
      stop: (p) => p?.kind === "sheriffRun", // 停在竞选报名前
    });
    // 报名之前已经发生过一次夜亡公告后的并行权衡
    const skills = pendings.filter((p) => p.kind === "daySkill" && p.view.day === 1);
    expect(skills.length).toBe(1);
    expect(skills[0].batch!.map((p) => p.seat)).toEqual([1, 2, 3, 4, 7]);
  });

  it("瞬时权衡窗口不污染事件标签：任何事件的 phase 不得为 day.skill（发言/投票带宏观上下文标签）", () => {
    // 回归：setPhase("day.skill", …, false) 曾把引擎 phase 留在瞬时窗口，导致后续警上发言、
    // 放逐投票、死亡公告等事件全部被打上「主动技能窗口」徽标（对局记录文字框标签错乱）。
    const ROLES: RoleId[] = [
      "werewolf", "werewolf", "werewolf", "whiteWolfKing",
      "seer", "witch", "knight", "guard",
      "villager", "villager", "villager", "villager",
    ];
    const { pendings, events } = drive("whiteWolfKnight12", ROLES, (p) => QUICK(p));
    // 前置：确实发生了权衡批次与发言（否则断言无意义）
    expect(pendings.some((p) => p.kind === "daySkill")).toBe(true);
    expect(events.some((e) => e.type === "speech")).toBe(true);
    // 核心：没有任何事件携带瞬时标签 day.skill
    expect(events.filter((e) => e.phase === "day.skill")).toEqual([]);
    // 发言事件带宏观上下文标签（day.* 且非瞬时权衡/技能询问窗口）
    for (const e of events.filter((e) => e.type === "speech")) {
      expect(e.phase.startsWith("day.")).toBe(true);
      expect(["day.skill", "day.exileSkill"]).not.toContain(e.phase);
    }
  });

  it("上警候选人灰警徽标识：≥2 人上警时标记、警长落地后消失；单人上警全程不标记", () => {
    // —— ≥2 人上警（1号/5号）：警上发言阶段快照标记候选人 ——
    const part1 = drive("standard12", STD12, (p) => {
      const thought = "t";
      if (p.kind === "wolfKill") return { thought, targets: [9] };
      if (p.kind === "seerCheck") return { thought, targets: [2] };
      if (p.kind === "witchAction") return { thought, skip: true };
      if (p.kind === "sheriffRun")
        return BATCH_MAP(p, (sub) => ({ thought, targets: [[1, 5].includes(sub.seat) ? 1 : 0] }));
      return QUICK(p);
    }, {
      stop: (p) => p?.kind === "sheriffSpeech",
    });
    const snap1 = part1.engine.getSnapshot();
    expect(snap1.players.filter((x) => x.sheriffCand).map((x) => x.seat)).toEqual([1, 5]);
    expect(snap1.players.every((x) => !x.sheriff)).toBe(true);

    // —— 警徽投票全员投 1 号：警长落地，候选人标识全部消失 ——
    const part2 = drive("standard12", STD12, (p) => {
      const thought = "t";
      if (p.kind === "wolfKill") return { thought, targets: [9] };
      if (p.kind === "seerCheck") return { thought, targets: [2] };
      if (p.kind === "witchAction") return { thought, skip: true };
      if (p.kind === "sheriffRun")
        return BATCH_MAP(p, (sub) => ({ thought, targets: [[1, 5].includes(sub.seat) ? 1 : 0] }));
      if (p.kind === "sheriffVote") return BATCH_MAP(p, (sub) => ({ thought, targets: [1] }));
      return QUICK(p);
    }, {
      stop: (p) => p?.kind === "sheriffOrder", // 警长定序：紧随警长落地
    });
    const snap2 = part2.engine.getSnapshot();
    expect(snap2.players.find((x) => x.seat === 1)!.sheriff).toBe(true);
    expect(snap2.players.every((x) => !x.sheriffCand)).toBe(true);

    // —— 单人上警（3号）：直接当选，全程不出现候选人标识 ——
    const part3 = drive("standard12", STD12, (p) => {
      const thought = "t";
      if (p.kind === "wolfKill") return { thought, targets: [9] };
      if (p.kind === "seerCheck") return { thought, targets: [2] };
      if (p.kind === "witchAction") return { thought, skip: true };
      if (p.kind === "sheriffRun")
        return BATCH_MAP(p, (sub) => ({ thought, targets: [sub.seat === 3 ? 1 : 0] }));
      return QUICK(p);
    }, {
      stop: (p) => p != null && p.view.day === 2,
    });
    const snap3 = part3.engine.getSnapshot();
    expect(snap3.players.find((x) => x.seat === 3)!.sheriff).toBe(true);
    expect(snap3.players.every((x) => !x.sheriffCand)).toBe(true);
  });

  it("双爆吞警徽机制：他狼可在某段警上发言后立即自爆，警徽流失直接入夜", () => {
    const { engine, pendings } = drive("standard12", STD12, (p) => {
      const thought = "t";
      if (p.kind === "wolfKill") return { thought, targets: [9] };
      if (p.kind === "seerCheck") return { thought, targets: [1] };
      if (p.kind === "sheriffRun")
        return BATCH_MAP(p, (sub) => ({ thought, targets: [[1, 5].includes(sub.seat) ? 1 : 0] }));
      // 1号（狼，候选人）警上发言完毕 → 4号狼（非候选人）在权衡中立即自爆吞警徽
      //（gate「警上发言」：跳过前面的夜亡公告/上警名单公布权衡，保留发言后自爆场景）
      if (p.kind === "daySkill" && p.hint?.includes("警上发言")) return BATCH_WITH(p, 4, { selfDestruct: true });
      return QUICK(p);
    }, {
      stop: (p) => p?.kind === "wolfKill" && p.view.day === 2,
    });
    const snap = engine.getSnapshot();
    expect(snap.players.every((x) => !x.sheriff)).toBe(true); // 警徽流失
    expect(snap.players.find((x) => x.seat === 4)!.alive).toBe(false); // 自爆狼出局
    expect(pendings[pendings.length - 1].view.day).toBe(2); // 直接入夜
  });

  it("骑士在夜亡公告窗口决斗狼人：不进入发言，立即入夜", () => {
    const ROLES: RoleId[] = [
      "werewolf", "werewolf", "werewolf", "whiteWolfKing",
      "seer", "witch", "knight", "guard",
      "villager", "villager", "villager", "villager",
    ];
    const { engine, pendings } = drive("whiteWolfKnight12", ROLES, (p) => {
      const thought = "t";
      if (p.kind === "wolfKill") return { thought, targets: [9] };
      if (p.kind === "seerCheck") return { thought, targets: [1] };
      if (p.kind === "daySkill") return BATCH_WITH(p, 7, { duel: 1 });
      return QUICK(p);
    }, {
      stop: (p) => p?.kind === "wolfKill" && p.view.day === 2,
    });
    const snap = engine.getSnapshot();
    expect(snap.players.find((x) => x.seat === 1)!.alive).toBe(false); // 狼被决斗出局
    expect(snap.players.find((x) => x.seat === 7)!.alive).toBe(true); // 骑士存活
    // 第1天没有发生任何白天发言（窗口决斗直接入夜）
    expect(pendings.some((p) => p.kind === "daySpeech" && p.view.day === 1)).toBe(false);
    expect(pendings[pendings.length - 1].view.day).toBe(2);
  });

  it("骑士在发言后窗口决斗好人：骑士出局，放逐投票照常进行", () => {
    const ROLES: RoleId[] = [
      "werewolf", "werewolf", "werewolf", "whiteWolfKing",
      "seer", "witch", "knight", "guard",
      "villager", "villager", "villager", "villager",
    ];
    let speechDone = false;
    const { engine, pendings } = drive("whiteWolfKnight12", ROLES, (p) => {
      const thought = "t";
      if (p.kind === "wolfKill") return { thought, targets: [9] };
      if (p.kind === "seerCheck") return { thought, targets: [1] };
      if (p.kind === "daySpeech") speechDone = true; // 标记：已进入发言环节
      if (p.kind === "daySkill" && speechDone) return BATCH_WITH(p, 7, { duel: 10 }); // 发言后权衡决斗平民
      if (p.kind === "dayVote") return BATCH_MAP(p, () => ({ thought, skip: true })); // 全员弃票 → 平安日
      return QUICK(p);
    }, {
      stop: (p) => p?.kind === "wolfKill" && p.view.day === 2,
    });
    const snap = engine.getSnapshot();
    const s7 = snap.players.find((x) => x.seat === 7)!;
    expect(s7.alive).toBe(false);
    expect(s7.deathInfo).toContain("决斗");
    expect(snap.players.find((x) => x.seat === 10)!.alive).toBe(true);
    // 决斗之后放逐投票仍照常进行
    expect(pendings.some((p) => p.kind === "dayVote" && p.view.day === 1)).toBe(true);
  });

  it("白狼王在发言后窗口自爆带人：跳过投票直接入夜", () => {
    const ROLES: RoleId[] = [
      "werewolf", "werewolf", "werewolf", "whiteWolfKing",
      "seer", "witch", "hunter", "guard",
      "villager", "villager", "villager", "villager",
    ];
    let speechDone = false;
    let takeSeen = false;
    const { engine, pendings } = drive("whiteWolfGuard12", ROLES, (p) => {
      const thought = "t";
      if (p.kind === "wolfKill") return { thought, targets: [9] };
      if (p.kind === "seerCheck") return { thought, targets: [1] };
      if (p.kind === "daySpeech") speechDone = true;
      if (p.kind === "daySkill" && speechDone) return BATCH_WITH(p, 4, { selfDestruct: true });
      if (p.kind === "whiteWolfTake") {
        takeSeen = true;
        return { thought, targets: [5] };
      }
      return QUICK(p);
    }, {
      stop: (p) => p?.kind === "wolfKill" && p.view.day === 2,
    });
    expect(takeSeen).toBe(true);
    const snap = engine.getSnapshot();
    expect(snap.players.find((x) => x.seat === 4)!.alive).toBe(false);
    expect(snap.players.find((x) => x.seat === 5)!.alive).toBe(false);
    // 发言后权衡中自爆 → 当天没有放逐投票
    expect(pendings.some((p) => p.kind === "dayVote" && p.view.day === 1)).toBe(false);
    expect(pendings[pendings.length - 1].view.day).toBe(2);
  });

  it("实时介入：骑士听完2号发言后立即决斗打断，后续发言不再进行", () => {
    const ROLES: RoleId[] = [
      "werewolf", "werewolf", "werewolf", "whiteWolfKing",
      "seer", "witch", "knight", "guard",
      "villager", "villager", "villager", "villager",
    ];
    const { engine, pendings, events } = drive("whiteWolfKnight12", ROLES, (p) => {
      const thought = "t";
      if (p.kind === "wolfKill") return { thought, targets: [9] };
      if (p.kind === "seerCheck") return { thought, targets: [1] };
      // 思考对象=2号的发言 的权衡批次到来（此时2号发言已落地）→ 骑士立即决斗打断
      if (p.kind === "daySkill" && (p.hint ?? "").includes("2号的发言"))
        return BATCH_WITH(p, 7, { duel: 2 });
      return QUICK(p);
    }, {
      stop: (p) => p?.kind === "wolfKill" && p.view.day === 2,
    });
    const snap = engine.getSnapshot();
    expect(snap.players.find((x) => x.seat === 2)!.alive).toBe(false); // 2号狼被决斗出局
    // 1号、2号的发言事件落地；3号及之后再无发言事件（权衡与3号发言并行询问，被决斗打断后其发言输入作废）
    const speeches = events
      .filter((e) => e.type === "speech" && e.title === "公开发言" && e.day === 1)
      .map((e) => e.actor);
    expect(speeches).toEqual([1, 2]);
    expect(pendings[pendings.length - 1].view.day).toBe(2);
  });

  it("孤狼警示：场上仅剩最后一只狼时，自爆提示必须显式警告判负", () => {
    const ROLES: RoleId[] = [
      "werewolf", "werewolf", "werewolf", "whiteWolfKing",
      "seer", "witch", "knight", "guard",
      "villager", "villager", "villager", "villager",
    ];
    const { pendings } = drive("whiteWolfKnight12", ROLES, (p) => {
      const thought = "t";
      if (p.kind === "wolfKill")
        return { thought, targets: [p.view.day === 1 ? 9 : p.view.day === 2 ? 5 : 6] };
      if (p.kind === "seerCheck") return { thought, targets: [p.options[0]] };
      if (p.kind === "witchAction" && p.view.day === 1) return { thought, targets: [1] }; // 毒杀1号狼
      if (p.kind === "daySkill" && p.view.day === 1) return BATCH_WITH(p, 7, { duel: 2 }); // 骑士决斗2号狼
      if (p.kind === "dayVote" && p.view.day === 2)
        return BATCH_MAP(p, (sub) => ({ thought, targets: [sub.seat === 3 ? 4 : 3] })); // 放逐3号狼（3号自己投4号）
      return QUICK(p);
    }, {
      stop: (p) => p?.kind === "daySkill" && p.view.day === 3, // 停在第3天首次权衡
    });
    // 第3天：狼队仅剩4号（白狼王），其权衡提示必须包含判负警告
    const last = pendings[pendings.length - 1];
    const wolfSub = (last.batch ?? [last]).find((x) => x.seat === 4)!;
    expect(wolfSub.hint).toContain("最后一只狼");
    expect(wolfSub.hint).toContain("判负");
  });

  it("放逐技能询问：被放逐者先遗言再被问技能，猎人开枪后出局；平民沉默出局", () => {
    const { engine, events } = drive("standard12", STD12, (p) => {
      const thought = "t";
      if (p.kind === "wolfKill") return { thought, targets: [9] };
      if (p.kind === "seerCheck") return { thought, targets: [1] };
      // 第1天放逐7号猎人（7号自己弃票）
      if (p.kind === "dayVote" && p.view.day === 1)
        return BATCH_MAP(p, (sub) => (sub.seat === 7 ? { thought, skip: true } : { thought, targets: [7] }));
      // 猎人在放逐技能询问中开枪带走1号狼
      if (p.kind === "exileSkill") return { thought, targets: [1] };
      return QUICK(p);
    }, {
      stop: (p) => p?.kind === "wolfKill" && p.view.day === 2,
    });
    const snap = engine.getSnapshot();
    expect(snap.players.find((x) => x.seat === 1)!.alive).toBe(false); // 被开枪带走
    expect(snap.players.find((x) => x.seat === 1)!.deathInfo).toContain("被开枪带走");
    expect(snap.players.find((x) => x.seat === 7)!.alive).toBe(false); // 放逐出局
    expect(snap.players.find((x) => x.seat === 7)!.deathInfo).toContain("被放逐");
    // 流程顺序：遗言 → 放逐权衡 → 开枪 → 7号死亡公告（先问技能后出局）
    //（引擎原始事件无 seq 字段（seq 由服务层赋值），用数组下标比较先后）
    const idxOf = (title: string, actor: number | null) =>
      events.findIndex((e) => e.title === title && e.actor === actor);
    const lwIdx = idxOf("遗言", 7);
    const weighIdx = idxOf("放逐权衡", 7);
    const shootIdx = idxOf("开枪", 7);
    const deathIdx = events.findIndex((e) => e.title === "死亡公告" && e.content.includes("7号"));
    expect(lwIdx).toBeGreaterThanOrEqual(0);
    expect(weighIdx).toBeGreaterThan(lwIdx);
    expect(shootIdx).toBeGreaterThan(weighIdx);
    expect(deathIdx).toBeGreaterThan(shootIdx);
  });

  it("放逐技能询问：平民被放逐仅可沉默，随后出局", () => {
    const { engine, events } = drive("standard12", STD12, (p) => {
      const thought = "t";
      if (p.kind === "wolfKill") return { thought, targets: [9] };
      if (p.kind === "seerCheck") return { thought, targets: [1] };
      if (p.kind === "dayVote" && p.view.day === 1)
        return BATCH_MAP(p, (sub) => (sub.seat === 10 ? { thought, skip: true } : { thought, targets: [10] }));
      return QUICK(p);
    }, {
      stop: (p) => p?.kind === "wolfKill" && p.view.day === 2,
    });
    const snap = engine.getSnapshot();
    expect(snap.players.find((x) => x.seat === 10)!.alive).toBe(false);
    expect(snap.players.find((x) => x.seat === 10)!.deathInfo).toContain("被放逐");
    // 平民的放逐技能询问 options 为空（仅可沉默），且出现保持沉默事件
    const ask = events.find((e) => e.title === "放逐权衡" && e.actor === 10);
    expect(ask).toBeDefined();
    expect(events.some((e) => e.title === "保持沉默" && e.actor === 10)).toBe(true);
  });

  it("血月封印提示仅当夜有效：封印夜过后的夜晚，神职视图不再提示被封", () => {
    const ROLES: RoleId[] = [
      "werewolf", "werewolf", "werewolf", "bloodMoon",
      "seer", "witch", "demonHunter", "idiot",
      "villager", "villager", "villager", "villager",
    ];
    const { pendings } = drive("bloodMoonHunter12", ROLES, (p) => {
      const thought = "t";
      const d = p.view.day;
      if (p.kind === "wolfKill") return { thought, targets: [d === 1 ? 9 : d === 2 ? 10 : 11] };
      // 第1天血月使徒（4号）在权衡中自爆 → 第2夜全神职封印
      if (p.kind === "daySkill" && d === 1) return BATCH_WITH(p, 4, { selfDestruct: true });
      return QUICK(p);
    }, {
      stop: (p) => p?.kind === "demonHunterHunt" && p.view.day === 3,
    });
    const dh3 = pendings[pendings.length - 1];
    expect(dh3.kind).toBe("demonHunterHunt");
    expect(dh3.view.day).toBe(3);
    // 封印只覆盖第2夜：第3夜猎魔人被正常询问且视图无封印提示（历史 bug：提示标志残留致其仍以为被限制）
    expect(dh3.view.private.bloodMoonSealed).toBeUndefined();
  });

  it("白日交刀：狼人在权衡中交刀认输，神民立即获胜，发动事件带 skillFired 标记", () => {
    const ROLES: RoleId[] = [
      "werewolf", "werewolf", "werewolf", "whiteWolfKing",
      "seer", "witch", "knight", "guard",
      "villager", "villager", "villager", "villager",
    ];
    const { engine, events } = drive("whiteWolfKnight12", ROLES, (p) => {
      const thought = "t";
      if (p.kind === "wolfKill") return { thought, targets: [9] };
      if (p.kind === "seerCheck") return { thought, targets: [1] };
      // 第1天夜亡公告权衡中，2号狼发动白日交刀
      if (p.kind === "daySkill" && (p.hint ?? "").includes("夜亡公告"))
        return BATCH_WITH(p, 2, { surrender: true });
      return QUICK(p);
    }, {
      stop: (_p, e) => e.isFinished(),
    });
    const snap = engine.getSnapshot();
    expect(snap.winner).toBe("good"); // 狼队认输，神民胜
    expect(engine.isFinished()).toBe(true);
    const fire = events.find((e) => e.title === "白日交刀");
    expect(fire).toBeDefined();
    expect(fire?.meta?.channel).toBe("skillFired");
    expect(fire?.meta?.skillChoice).toBe("fired");
  });

  it("白日交刀·宣布胜利：狼人在权衡中宣布胜利，狼队立即获胜", () => {
    const ROLES: RoleId[] = [
      "werewolf", "werewolf", "werewolf", "whiteWolfKing",
      "seer", "witch", "knight", "guard",
      "villager", "villager", "villager", "villager",
    ];
    const { engine, events } = drive("whiteWolfKnight12", ROLES, (p) => {
      const thought = "t";
      if (p.kind === "wolfKill") return { thought, targets: [9] };
      if (p.kind === "seerCheck") return { thought, targets: [1] };
      if (p.kind === "daySkill" && (p.hint ?? "").includes("夜亡公告"))
        return BATCH_WITH(p, 4, { declareVictory: true });
      return QUICK(p);
    }, {
      stop: (_p, e) => e.isFinished(),
    });
    const snap = engine.getSnapshot();
    expect(snap.winner).toBe("wolf"); // 宣布胜利，狼队胜
    expect(engine.isFinished()).toBe(true);
    const fire = events.find((e) => e.title === "白日交刀");
    expect(fire).toBeDefined();
    expect(fire?.meta?.channel).toBe("skillFired");
    expect(fire?.content).toContain("宣布胜利");
  });

  it("警徽流：警长夜亡后可选择移交警徽给指定玩家接任", () => {
    const { engine, pendings, events } = drive("standard12", STD12, (p) => {
      const thought = "t";
      const d = p.view.day;
      if (p.kind === "sheriffRun")
        return BATCH_MAP(p, (sub) => ({ thought, targets: [sub.seat === 5 ? 1 : 0] })); // 仅5号上警 → 直接当选
      if (p.kind === "wolfKill") return { thought, targets: [d === 1 ? 9 : 5] }; // 第2夜刀死警长（竞选在第1天，首夜无警长）
      if (p.kind === "witchAction" || p.kind === "guardProtect") return { thought, skip: true }; // 不许救/守，保证警长阵亡
      if (p.kind === "badgePass") return { thought, targets: [7] }; // 警徽移交给7号
      return QUICK(p);
    }, {
      stop: (p) => p?.kind === "daySpeech" && p.view.day === 2, // 停在第2天首次发言（狼刀+警徽流已结算）
    });
    // 警长5号夜亡后出现 badgePass 待决
    expect(pendings.some((p) => p.kind === "badgePass" && p.seat === 5)).toBe(true);
    const snap = engine.getSnapshot();
    expect(snap.players.find((x) => x.seat === 7)!.sheriff).toBe(true); // 7号接任警长
    expect(snap.players.find((x) => x.seat === 5)!.sheriff).toBe(false);
    expect(events.some((e) => e.title === "警徽移交")).toBe(true);
    expect(events.some((e) => e.title === "警徽流失")).toBe(false);
  });

  it("警徽流时机：警长夜亡的警徽抉择推迟到白天公布夜亡之后（不连夜私下处置）", () => {
    const { events } = drive("standard12", STD12, (p) => {
      const thought = "t";
      const d = p.view.day;
      if (p.kind === "sheriffRun")
        return BATCH_MAP(p, (sub) => ({ thought, targets: [sub.seat === 5 ? 1 : 0] }));
      if (p.kind === "wolfKill") return { thought, targets: [d === 1 ? 9 : 5] }; // 第2夜刀警长
      if (p.kind === "witchAction" || p.kind === "guardProtect") return { thought, skip: true };
      if (p.kind === "badgePass") return { thought, targets: [7] };
      return QUICK(p);
    }, {
      stop: (p) => p?.kind === "daySpeech" && p.view.day === 2,
    });
    // 公布夜亡（第2天死亡公告）先于警徽移交
    const deathIdx = events.findIndex((e) => e.day === 2 && e.title === "死亡公告");
    const passIdx = events.findIndex((e) => e.title === "警徽移交");
    expect(deathIdx).toBeGreaterThanOrEqual(0);
    expect(passIdx).toBeGreaterThan(deathIdx);
  });

  it("退水环节：2人上警，1人退水后另一人直接当选；退水者失去候选标识", () => {
    const { engine, pendings, events } = drive("standard12", STD12, (p) => {
      const thought = "t";
      if (p.kind === "sheriffRun")
        return BATCH_MAP(p, (sub) => ({ thought, targets: [[3, 7].includes(sub.seat) ? 1 : 0] }));
      if (p.kind === "sheriffWithdraw")
        return BATCH_MAP(p, (sub) => ({ thought, targets: [sub.seat === 7 ? 1 : 0] })); // 7号退水（同时权衡批次）
      return QUICK(p);
    }, {
      stop: (p) => p?.kind === "daySpeech" && p.view.day === 1,
    });
    // 退水环节事件 + 7号退水事件
    expect(events.some((e) => e.title === "退水环节")).toBe(true);
    expect(events.some((e) => e.title === "退水" && e.actor === 7)).toBe(true);
    // 仅剩3号 → 直接当选（无警徽投票待决）
    expect(subPendings(pendings, "sheriffVote").length).toBe(0);
    const snap = engine.getSnapshot();
    expect(snap.players.find((x) => x.seat === 3)!.sheriff).toBe(true);
    // 警长落地后全员无候选标识
    expect(snap.players.every((x) => !x.sheriffCand)).toBe(true);
  });

  it("退水后可投票：3人上警1人退水 → 退水者成为警下投票人，候选池仅留任者", () => {
    const { pendings } = drive("standard12", STD12, (p) => {
      const thought = "t";
      if (p.kind === "sheriffRun")
        return BATCH_MAP(p, (sub) => ({ thought, targets: [[2, 5, 9].includes(sub.seat) ? 1 : 0] }));
      if (p.kind === "sheriffWithdraw")
        return BATCH_MAP(p, (sub) => ({ thought, targets: [sub.seat === 9 ? 1 : 0] })); // 9号退水（同时权衡批次）
      return QUICK(p);
    }, {
      stop: (p) => p?.kind === "daySpeech" && p.view.day === 1,
    });
    // 警徽投票待决存在（2/5 留任决选）；投票人为警下玩家（含退水的9号）
    const votes = subPendings(pendings, "sheriffVote");
    expect(votes.length).toBeGreaterThan(0);
    const voterSeats = votes.map((p) => p.seat);
    expect(voterSeats).toContain(9); // 退水者转为警下投票
    expect(voterSeats).not.toContain(2);
    expect(voterSeats).not.toContain(5);
    // 候选池仅留任的 2/5
    expect(votes[0].options.sort()).toEqual([2, 5]);
  });

  it("发言中断说明：自爆中断白天发言时公开未轮到发言者（防误读沉默）", () => {
    const { events } = drive(
      "standard12",
      STD12,
      (p) => {
        const thought = "t";
        if (p.kind === "wolfKill") return { thought, targets: [8] }; // 首夜刀8号平民
        if (p.kind === "daySpeech" && p.seat === 1) return { thought, selfDestruct: true }; // 首位发言者（狼）自爆
        return QUICK(p);
      },
      { options: { sheriffEnabled: false }, stop: (p) => p?.kind === "wolfKill" && p.view.day === 2 },
    );
    // 1号自爆中断 → 其后未轮到发言的存活者被公开说明（非主动沉默）
    const note = events.find((e) => e.title === "发言中断说明");
    expect(note).toBeDefined();
    expect(note!.content).toContain("5号");
    expect(note!.content).toContain("12号");
    expect(note!.content).toContain("并非");
    expect(note!.content).not.toContain("8号"); // 死者不在说明之列
  });

  it("警上阶段狼自爆：本局无警长，直接入夜", () => {
    const { engine, pendings } = drive("standard12", STD12, (p) => {
      const thought = "t";
      if (p.kind === "wolfKill") return { thought, targets: [9] };
      if (p.kind === "seerCheck") return { thought, targets: [1] };
      if (p.kind === "sheriffRun")
        return BATCH_MAP(p, (sub) => ({ thought, targets: [[1, 5].includes(sub.seat) ? 1 : 0] }));
      if (p.kind === "sheriffSpeech" && p.seat === 1) return { thought, selfDestruct: true };
      return QUICK(p);
    }, {
      stop: (p) => p?.kind === "wolfKill" && p.view.day === 2,
    });
    const snap = engine.getSnapshot();
    expect(snap.players.every((x) => !x.sheriff)).toBe(true);
    expect(snap.players.find((x) => x.seat === 1)!.alive).toBe(false);
    const lastP = pendings[pendings.length - 1];
    expect(lastP.view.day).toBe(2);
    expect(lastP.view.revealedRoles[1]).toBe("werewolf");
  });

  it("血月使徒：最后一狼被放逐无效（平安日），次夜结束时死亡", () => {
    const ROLES: RoleId[] = [
      "werewolf", "werewolf", "werewolf", "bloodMoon",
      "seer", "witch", "demonHunter", "idiot",
      "villager", "villager", "villager", "villager",
    ];
    const { engine, pendings } = drive("bloodMoonHunter12", ROLES, (p) => {
      const thought = "t";
      const d = p.view.day;
      // 夜里：n1刀9号平民，n2狼队自刀2号，n3血月独刀10号，n4刀11号，n5刀12号
      if (p.kind === "wolfKill") {
        if (d === 1) return { thought, targets: [9] };
        if (d === 2) return { thought, targets: [2] };
        if (d === 3) return { thought, targets: [10] };
        if (d === 4) return { thought, targets: [11] };
        return { thought, targets: [12] };
      }
      if (p.kind === "seerCheck") return { thought, targets: [4] };
      if (p.kind === "dayVote") {
        // 白天：d1放逐1号狼，d2放逐3号狼，d3全员弃票（平安日），d4投血月（最后一狼）
        if (d === 1)
          return BATCH_MAP(p, (sub) => (sub.seat === 1 ? { thought, skip: true } : { thought, targets: [1] }));
        if (d === 2)
          return BATCH_MAP(p, (sub) => (sub.seat === 3 ? { thought, skip: true } : { thought, targets: [3] }));
        if (d === 3) return BATCH_MAP(p, () => ({ thought, skip: true }));
        return BATCH_MAP(p, (sub) => (sub.seat === 4 ? { thought, skip: true } : { thought, targets: [4] }));
      }
      return QUICK(p);
    }, {
      stop: (p) => p?.kind === "daySpeech" && p.view.day === 5,
      max: 4000,
    });
    const snap = engine.getSnapshot();
    const s4 = snap.players.find((x) => x.seat === 4)!;
    // d4放逐无效 → 血月翻牌（n5狼刀视角可见翻牌）；次夜（n5）结束时死亡
    const night5View = pendings.find((p) => p.view.day === 5 && p.kind === "wolfKill");
    expect(night5View?.view.revealedRoles[4]).toBe("bloodMoon");
    expect(s4.alive).toBe(false);
    expect(s4.deathInfo).toContain("血月");
  });
});

describe("专项：查验与信息", () => {
  it("隐狼被预言家验为好人；机械狼模仿伪装通灵师查验；石像鬼被验为狼", () => {
    // 隐狼
    const HIDDEN: RoleId[] = [
      "werewolf", "werewolf", "werewolf", "hiddenWolf",
      "seer", "witch", "hunter", "crow",
      "villager", "villager", "villager", "villager",
    ];
    const h = drive("hiddenCrow12", HIDDEN, (p) => {
      if (p.kind === "wolfKill") return { thought: "t", targets: [p.view.day === 1 ? 9 : 10] };
      if (p.kind === "seerCheck" && p.view.day === 1) return { thought: "t", targets: [4] };
      if (p.kind === "seerCheck") return { thought: "t", targets: [1] };
      return QUICK(p);
    }, {
      stop: (p) => p?.kind === "daySpeech" && p.view.day === 2,
    });
    const seerNight2 = h.pendings.find((p) => p.kind === "seerCheck" && p.view.day === 2);
    expect(seerNight2?.view.private.seerChecks).toContainEqual({ seat: 4, result: "good" });
    // 狼队友列表不含隐狼
    const wolfNight2 = h.pendings.find((p) => p.kind === "wolfKill" && p.view.day === 2);
    expect(wolfNight2?.view.private.wolfTeammates ?? []).not.toContain(4);

    // 机械狼
    const MECH: RoleId[] = [
      "werewolf", "werewolf", "werewolf", "mechWolf",
      "psychic", "witch", "hunter", "guard",
      "villager", "villager", "villager", "villager",
    ];
    const m = drive("psychicMech12", MECH, (p) => {
      if (p.kind === "wolfKill") return { thought: "t", targets: [p.view.day === 1 ? 9 : 10] };
      if (p.kind === "mechWolfMimic" && p.view.day === 1) return { thought: "t", targets: [9] };
      if (p.kind === "mechWolfMimic") return { thought: "t", skip: true };
      if (p.kind === "psychicCheck" && p.view.day === 1) return { thought: "t", targets: [4] };
      if (p.kind === "psychicCheck") return { thought: "t", targets: [1] };
      return QUICK(p);
    }, {
      stop: (p) => p?.kind === "daySpeech" && p.view.day === 2,
    });
    const psyNight2 = m.pendings.find((p) => p.kind === "psychicCheck" && p.view.day === 2);
    expect(psyNight2?.view.private.psychicChecks).toContainEqual({ seat: 4, result: "平民" });
    // 机械狼与狼队见面
    const wolfNight2m = m.pendings.find((p) => p.kind === "wolfKill" && p.view.day === 2);
    expect(wolfNight2m?.view.private.wolfTeammates ?? []).toContain(4);

    // 石像鬼：被预言家验为狼；石像鬼验人得具体身份
    const GARG: RoleId[] = [
      "werewolf", "werewolf", "werewolf", "gargoyle",
      "seer", "witch", "hunter", "gravekeeper",
      "villager", "villager", "villager", "villager",
    ];
    const g = drive("gargoyleGrave12", GARG, (p) => {
      if (p.kind === "wolfKill") return { thought: "t", targets: [p.view.day === 1 ? 9 : 10] };
      if (p.kind === "gargoyleCheck") return { thought: "t", targets: [5] };
      if (p.kind === "seerCheck" && p.view.day === 1) return { thought: "t", targets: [4] };
      if (p.kind === "seerCheck") return { thought: "t", targets: [1] };
      return QUICK(p);
    }, {
      stop: (p) => p?.kind === "daySpeech" && p.view.day === 2,
    });
    const seerNight2g = g.pendings.find((p) => p.kind === "seerCheck" && p.view.day === 2);
    expect(seerNight2g?.view.private.seerChecks).toContainEqual({ seat: 4, result: "wolf" });
    const gargNight2 = g.pendings.find((p) => p.kind === "gargoyleCheck" && p.view.day === 2);
    expect(gargNight2?.view.private.gargoyleChecks).toContainEqual({ seat: 5, result: "预言家" });
    // 狼队友列表不含石像鬼
    const wolfNight2g = g.pendings.find((p) => p.kind === "wolfKill" && p.view.day === 2);
    expect(wolfNight2g?.view.private.wolfTeammates ?? []).not.toContain(4);
  });

  it("守墓人：夜晚得知上一白天被放逐者是否为狼人", () => {
    const GARG: RoleId[] = [
      "werewolf", "werewolf", "werewolf", "gargoyle",
      "seer", "witch", "hunter", "gravekeeper",
      "villager", "villager", "villager", "villager",
    ];
    const g = drive("gargoyleGrave12", GARG, (p) => {
      if (p.kind === "wolfKill") return { thought: "t", targets: [p.view.day === 1 ? 9 : 10] };
      if (p.kind === "gargoyleCheck") return { thought: "t", targets: [5] };
      if (p.kind === "seerCheck") return { thought: "t", targets: [p.view.day === 1 ? 4 : 2] };
      // 放逐1号狼（1号自己弃票）
      if (p.kind === "dayVote")
        return BATCH_MAP(p, (sub) => (sub.seat === 1 ? { thought: "t", skip: true } : { thought: "t", targets: [1] }));
      return QUICK(p);
    }, {
      stop: (p) => p?.kind === "dayVote" && p.view.day === 2,
    });
    // 发言与权衡并行后，8号守墓人的发言待决内嵌于合并批次——按子待决展开查找
    const gkNight2 = g.pendings
      .flatMap((p) => (p.batch ? p.batch : [p]))
      .find((x) => x.view.day === 2 && x.seat === 8);
    expect(gkNight2?.view.private.gravekeeperReveals).toContainEqual({ seat: 1, wasWolf: true });
  });
});

describe("专项：狼人频道", () => {
  it("多狼局首夜：wolfDiscuss 决策 + 频道事件 + wolfChat 进入后续狼视图 + 信息壁垒（石像鬼局）", () => {
    const GARG: RoleId[] = [
      "werewolf", "werewolf", "werewolf", "gargoyle",
      "seer", "witch", "hunter", "gravekeeper",
      "villager", "villager", "villager", "villager",
    ];
    const { pendings, events } = drive("gargoyleGrave12", GARG, (p) => {
      if (p.kind === "wolfDiscuss")
        return { thought: "t", speech: `队内发言${p.seat}号：我提议今晚刀9号` };
      if (p.kind === "wolfKill") return { thought: "t", targets: [9] };
      if (p.kind === "gargoyleCheck") return { thought: "t", targets: [5] };
      if (p.kind === "seerCheck") return { thought: "t", targets: [1] };
      return QUICK(p);
    }, {
      stop: (p) => p?.kind === "sheriffRun",
    });

    // ① 首夜 1/2/3 号见面狼各发一次 wolfDiscuss（phase 正确），且全部在 wolfKill 之前
    const night1 = pendings.filter((p) => p.view.day === 1);
    const discuss = night1.filter((p) => p.kind === "wolfDiscuss");
    expect(discuss.map((p) => p.seat)).toEqual([1, 2, 3]);
    expect(discuss.every((p) => p.view.phase === "night.wolfDiscuss")).toBe(true);
    const kills = night1.filter((p) => p.kind === "wolfKill");
    expect(kills.map((p) => p.seat)).toEqual([1, 2, 3]);
    const kinds1 = night1.map((p) => p.kind);
    expect(kinds1.indexOf("wolfKill")).toBeGreaterThan(kinds1.lastIndexOf("wolfDiscuss"));
    // 石像鬼（4号不见面）：不参与讨论、不参与狼刀投票
    expect(night1.some((p) => p.seat === 4 && (p.kind === "wolfDiscuss" || p.kind === "wolfKill"))).toBe(false);

    // ② 观察者频道事件：每次讨论产出一条 action 事件（独立思考事件同样挂「狼人频道」标签，按内容区分）
    const chanEvents = events.filter(
      (e) => e.title === "狼人频道" && !e.content.includes("独立思考"),
    );
    expect(chanEvents.length).toBe(3);
    expect(chanEvents.map((e) => e.actor)).toEqual([1, 2, 3]);
    for (const e of chanEvents) {
      expect(e.type).toBe("action");
      expect(e.phase).toBe("night.wolfDiscuss");
      expect(e.thought).toBe("t");
      expect(e.meta).toEqual({ channel: "wolf" });
    }
    expect(chanEvents[0].content).toBe("1号狼人（队内）：队内发言1号：我提议今晚刀9号");

    // ③ wolfChat 追加到所有见面狼：先发言者影响后发言者与当晚刀人选择
    const d1 = discuss.find((p) => p.seat === 1)!;
    const d2 = discuss.find((p) => p.seat === 2)!;
    const d3 = discuss.find((p) => p.seat === 3)!;
    expect(d1.view.private.wolfChat ?? []).toEqual([]); // 首夜首位发言者面前还没有记录
    expect(d2.view.private.wolfChat).toEqual(["1号：队内发言1号：我提议今晚刀9号"]);
    expect(d3.view.private.wolfChat).toEqual([
      "1号：队内发言1号：我提议今晚刀9号",
      "2号：队内发言2号：我提议今晚刀9号",
    ]);
    const fullChat = [
      "1号：队内发言1号：我提议今晚刀9号",
      "2号：队内发言2号：我提议今晚刀9号",
      "3号：队内发言3号：我提议今晚刀9号",
    ];
    for (const k of kills) expect(k.view.private.wolfChat).toEqual(fullChat);

    // ④ 信息壁垒：石像鬼/非狼玩家的视图绝无 wolfChat；任何 publicLog 不含频道内容
    const garg = night1.find((p) => p.kind === "gargoyleCheck")!;
    expect(garg.seat).toBe(4);
    expect(garg.view.private.wolfChat).toBeUndefined();
    for (const p of pendings) {
      if (![1, 2, 3].includes(p.seat)) {
        // 非见面狼（含石像鬼）的序列化文本不含狼队讨论内容
        expect(p.view.private.wolfChat).toBeUndefined();
        expect(JSON.stringify(p.view)).not.toContain("wolfChat");
        expect(JSON.stringify(p.view)).not.toContain("队内发言");
      }
      // wolfChat 绝不进入 publicLog（包括狼自己的视图）
      expect(p.view.publicLog.join("\n")).not.toContain("队内发言");
      expect(p.view.publicLog.join("\n")).not.toContain("狼人频道");
    }
  });

  it("隐狼局：隐狼不参与讨论、视图无 wolfChat", () => {
    const HIDDEN: RoleId[] = [
      "werewolf", "werewolf", "werewolf", "hiddenWolf",
      "seer", "witch", "hunter", "crow",
      "villager", "villager", "villager", "villager",
    ];
    const { pendings } = drive("hiddenCrow12", HIDDEN, (p) => {
      if (p.kind === "wolfDiscuss") return { thought: "t", speech: `队内发言${p.seat}号` };
      if (p.kind === "wolfKill") return { thought: "t", targets: [9] };
      return QUICK(p);
    }, {
      stop: (p) => p?.kind === "sheriffRun",
    });
    const night1 = pendings.filter((p) => p.view.day === 1);
    expect(night1.filter((p) => p.kind === "wolfDiscuss").map((p) => p.seat)).toEqual([1, 2, 3]);
    expect(night1.some((p) => p.seat === 4 && (p.kind === "wolfDiscuss" || p.kind === "wolfKill"))).toBe(false);
    for (const p of pendings.filter((x) => x.seat === 4)) {
      expect(p.view.private.wolfChat).toBeUndefined();
      expect(JSON.stringify(p.view)).not.toContain("队内发言");
    }
  });

  it("当夜只剩1只见面狼：跳过讨论环节，直接落刀", () => {
    const ROLES: RoleId[] = [
      "werewolf", "werewolf", "werewolf", "bloodMoon",
      "seer", "witch", "demonHunter", "idiot",
      "villager", "villager", "villager", "villager",
    ];
    const { pendings } = drive("bloodMoonHunter12", ROLES, (p) => {
      const thought = "t";
      const d = p.view.day;
      // 夜里：n1刀9，n2刀10且猎魔人猎杀2号狼，n3血月独刀11
      if (p.kind === "wolfKill") return { thought, targets: [d === 1 ? 9 : d === 2 ? 10 : 11] };
      // 第2夜猎魔人猎杀2号狼（之后夜里放弃）
      if (p.kind === "demonHunterHunt")
        return p.view.day === 2 ? { thought, targets: [2] } : { thought, skip: true };
      // 白天：d1放逐1号狼，d2放逐3号狼 → 第3夜仅剩血月4号
      if (p.kind === "dayVote") {
        if (d === 1)
          return BATCH_MAP(p, (sub) => (sub.seat === 1 ? { thought, skip: true } : { thought, targets: [1] }));
        if (d === 2)
          return BATCH_MAP(p, (sub) => (sub.seat === 3 ? { thought, skip: true } : { thought, targets: [3] }));
        return BATCH_MAP(p, () => ({ thought, skip: true }));
      }
      return QUICK(p);
    }, {
      stop: (p) => p?.kind === "daySpeech" && p.view.day === 3,
      max: 4000,
    });
    // 第1夜 4 只见面狼讨论，第2夜 3 只（1号已被放逐），第3夜仅剩血月 → 无讨论
    const n1 = pendings.filter((p) => p.view.day === 1);
    expect(n1.filter((p) => p.kind === "wolfDiscuss").map((p) => p.seat)).toEqual([1, 2, 3, 4]);
    const n2 = pendings.filter((p) => p.view.day === 2);
    expect(n2.filter((p) => p.kind === "wolfDiscuss").map((p) => p.seat)).toEqual([2, 3, 4]);
    const n3 = pendings.filter((p) => p.view.day === 3);
    expect(n3.some((p) => p.kind === "wolfDiscuss")).toBe(false);
    expect(n3.filter((p) => p.kind === "wolfKill").map((p) => p.seat)).toEqual([4]);
  });
});

describe("专项：认知与流程修复", () => {
  const STD12: RoleId[] = [
    "werewolf", "werewolf", "werewolf", "werewolf",
    "seer", "witch", "hunter", "idiot",
    "villager", "villager", "villager", "villager",
  ];

  it("① 第1夜视图无 lastNightDeaths（不存在幻影'前一天平安夜'），清晨公告后字段才出现", () => {
    const engine = createEngine({
      boardId: "standard12",
      seatRoles: STD12,
      options: { stepDelayMs: 0, sheriffEnabled: true, allowSelfDestruct: true, speechRoundsLimit: 1 },
    });
    const r = engine.advance();
    // 4只见面狼 → 首个决策是狼队独立思考；第1夜视图绝不含"昨夜死亡/平安夜"的信息来源
    expect(r.pending?.kind).toBe("wolfThink");
    expect(r.pending?.view.day).toBe(1);
    expect(r.pending?.view.phase.startsWith("night")).toBe(true);
    expect(r.pending?.view.private.lastNightDeaths).toBeUndefined();
    expect("lastNightDeaths" in r.pending!.view.private).toBe(false);

    // 走完第1夜与第1天清晨公告后，视图中才出现 lastNightDeaths
    const d = drive("standard12", STD12, (p) => {
      if (p.kind === "wolfKill") return { thought: "t", targets: [12] };
      return QUICK(p);
    }, { stop: (p) => p?.kind === "sheriffRun" });
    const run = d.pendings[d.pendings.length - 1];
    expect(run.kind).toBe("sheriffRun");
    expect(run.view.private.lastNightDeaths).toEqual([12]);
  });

  it("② 第1天顺序：死亡公告先于警长竞选，竞选 pending 的视图里死者已进入 deadSeats", () => {
    const { pendings, events } = drive("standard12", STD12, (p) => {
      if (p.kind === "wolfKill") return { thought: "t", targets: [12] };
      return QUICK(p);
    }, { stop: (p) => p?.kind === "sheriffRun" });
    // 警长竞选相关 pending 出现前，死亡公告事件已发出
    const deathEvt = events.find(
      (e) => e.type === "death" && e.title === "死亡公告" && e.content.includes("12号"),
    );
    expect(deathEvt).toBeDefined();
    // 首个 sheriffRun pending 的视图：12号已在 deadSeats（公告先于竞选）
    const firstRun = pendings[pendings.length - 1];
    expect(firstRun.kind).toBe("sheriffRun");
    expect(firstRun.view.deadSeats).toContain(12);
    expect(firstRun.view.aliveSeats).not.toContain(12);
  });

  it("③ 12人有警长版型第1夜狼队 pending 顺序：独立思考×4→讨论×4→投票落刀×4", () => {
    const { pendings } = drive("standard12", STD12, (p) => {
      if (p.kind === "wolfKill") return { thought: "t", targets: [12] };
      return QUICK(p);
    }, { stop: (p) => p?.kind === "witchAction" });
    // wolfThink 已改为全队并行批次——按子待决展开后计数（顺序仍为座位序）
    const wolfNight1 = pendings
      .flatMap((p) => (p.batch ? p.batch : [p]))
      .filter(
        (p) =>
          p.view.day === 1 &&
          ["wolfThink", "wolfDiscuss", "wolfKill"].includes(p.kind),
      );
    const wolves = [1, 2, 3, 4];
    expect(wolfNight1.map((p) => `${p.kind}:${p.seat}`)).toEqual([
      ...wolves.map((s) => `wolfThink:${s}`),
      ...wolves.map((s) => `wolfDiscuss:${s}`),
      ...wolves.map((s) => `wolfKill:${s}`),
    ]);
    // 思考阶段的 phase 名
    expect(
      wolfNight1.filter((p) => p.kind === "wolfThink").every((p) => p.view.phase === "night.wolfThink"),
    ).toBe(true);
    // 投票落刀时 view.wolfChat 已含全队4条讨论（讨论→投票的信息衔接）
    for (const p of wolfNight1.filter((x) => x.kind === "wolfKill")) {
      expect((p.view.private.wolfChat ?? []).length).toBe(4);
    }
  });

  it("④ 不可自救版型：女巫自救仍抛'本版型女巫不能自救'，hint 已明确告知", () => {
    let witchSeen = false;
    drive("standard12", STD12, (p, e) => {
      if (p.kind === "wolfKill") return { thought: "t", targets: [6] }; // 刀女巫自己
      if (p.kind === "witchAction") {
        witchSeen = true;
        expect(p.view.private.witchVictimTonight).toBe(6);
        expect(p.hint).toContain("不可自救");
        expect(() => e.decide({ thought: "t", witchSave: true })).toThrow(/不能自救/);
        return { thought: "t", skip: true };
      }
      return QUICK(p);
    }, { stop: (p) => p?.kind === "sheriffRun" });
    expect(witchSeen).toBe(true);
  });
});

describe("专项：发言轮次与警长定序", () => {
  const STD12: RoleId[] = [
    "werewolf", "werewolf", "werewolf", "werewolf",
    "seer", "witch", "hunter", "idiot",
    "villager", "villager", "villager", "villager",
  ];

  it("无警长版型（standard9）：第1天全体发言仅1轮（speechRoundsLimit 不再生效）", () => {
    const R9: RoleId[] = [
      "seer", "witch", "hunter",
      "villager", "villager", "villager",
      "werewolf", "werewolf", "werewolf",
    ];
    const { pendings } = drive("standard9", R9, (p) => {
      const thought = "t";
      if (p.kind === "wolfKill") return { thought, targets: [1] };
      if (p.kind === "seerCheck") return { thought, targets: [7] };
      return QUICK(p);
    }, {
      options: { speechRoundsLimit: 3 }, // 该选项不再影响全体发言轮数
      stop: (p) => p?.kind === "dayVote" && p.view.day === 1,
    });

    // 无警长版型：不出现 sheriffOrder 决策
    expect(pendings.some((p) => p.kind === "sheriffOrder")).toBe(false);
    // 第1天全体发言恰1轮：首夜1号被刀，存活 2~9 号按座位升序各发言1次
    //（发言与权衡并行后，后续发言内嵌于 daySkill 合并批次，按子待决展开计数）
    const d1 = subPendings(pendings, "daySpeech").filter((p) => p.view.day === 1);
    expect(d1.map((p) => p.seat)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    expect(d1.every((p) => p.hint.includes("共1轮"))).toBe(true);
    expect(d1.every((p) => p.view.phase === "day.speech" || p.view.phase === "day.skill")).toBe(true);
  });

  it("有警长版型（standard12）：第1天 = 警上竞选发言 + 全体发言恰1轮", () => {
    const { pendings } = drive("standard12", STD12, (p) => {
      const thought = "t";
      if (p.kind === "wolfKill") return { thought, targets: [12] };
      if (p.kind === "seerCheck") return { thought, targets: [1] };
      if (p.kind === "sheriffRun")
        return BATCH_MAP(p, (sub) => ({ thought, targets: [[5, 6].includes(sub.seat) ? 1 : 0] }));
      if (p.kind === "sheriffVote") return BATCH_MAP(p, () => ({ thought, targets: [5] }));
      if (p.kind === "sheriffOrder") return { thought, targets: [1] };
      return QUICK(p);
    }, {
      options: { speechRoundsLimit: 3 }, // 该选项不再影响全体发言轮数
      stop: (p) => p?.kind === "dayVote" && p.view.day === 1,
    });

    // 警上发言：5/6 号候选人各发言1次（先于公布夜亡与全体发言）
    //（发言与权衡并行后，后续发言内嵌于 daySkill 合并批次，按子待决展开计数）
    const campaign = subPendings(pendings, "sheriffSpeech");
    expect(campaign.map((p) => p.seat)).toEqual([5, 6]);
    // 全体发言恰1轮：12号首夜被刀，警长5号选升序 → 6~11、1~4，警长最后归票
    const d1 = subPendings(pendings, "daySpeech").filter((p) => p.view.day === 1);
    expect(d1.map((p) => p.seat)).toEqual([6, 7, 8, 9, 10, 11, 1, 2, 3, 4, 5]);
    expect(d1.every((p) => p.hint.includes("共1轮"))).toBe(true);
  });

  it("sheriffOrder：全体发言前先定序；升序/降序顺序正确且警长最后归票；非法定序抛错", () => {
    const setup = (order: 0 | 1) => {
      const box: { orderSeen: PendingDecision | null } = { orderSeen: null };
      const r = drive("standard12", STD12, (p, e) => {
        const thought = "t";
        if (p.kind === "wolfKill") return { thought, targets: [12] };
        if (p.kind === "seerCheck") return { thought, targets: [1] };
        if (p.kind === "sheriffRun")
          return BATCH_MAP(p, (sub) => ({ thought, targets: [[5, 6].includes(sub.seat) ? 1 : 0] }));
        if (p.kind === "sheriffVote") return BATCH_MAP(p, () => ({ thought, targets: [5] }));
        if (p.kind === "sheriffOrder") {
          box.orderSeen = p;
          // 非法定序：targets 必须是 [1] 或 [0]，且不允许跳过；抛错后状态不变可重试
          expect(() => e.decide({ thought, targets: [2] })).toThrow(/定序/);
          expect(() => e.decide({ thought, targets: [1, 0] })).toThrow(/定序/);
          expect(() => e.decide({ thought })).toThrow(/定序/);
          expect(() => e.decide({ thought, skip: true })).toThrow(/不允许跳过/);
          return { thought, targets: [order] };
        }
        return QUICK(p);
      }, {
        stop: (p) => p?.kind === "dayVote" && p.view.day === 1,
      });
      return { ...r, orderSeen: box.orderSeen };
    };

    // —— 升序：从警长下一位（6号）起按座位升序循环，警长5号最后 ——
    const asc = setup(1);
    expect(asc.orderSeen).not.toBeNull();
    expect(asc.orderSeen!.seat).toBe(5);
    expect(asc.orderSeen!.options).toEqual([1, 0]);
    expect(asc.orderSeen!.allowSkip).toBe(false);
    expect(asc.orderSeen!.view.phase).toBe("day.sheriffOrder");
    expect(asc.orderSeen!.hint).toContain("从6号开始"); // 升序首位
    expect(asc.orderSeen!.hint).toContain("从4号开始"); // 降序首位
    expect(asc.orderSeen!.hint).toContain("最后归票发言");
    // 定序决策出现在首个全体发言之前
    const kinds = asc.pendings.map((p) => p.kind);
    expect(kinds.indexOf("sheriffOrder")).toBeGreaterThanOrEqual(0);
    expect(kinds.indexOf("sheriffOrder")).toBeLessThan(kinds.indexOf("daySpeech"));
    const ascSpeeches = subPendings(asc.pendings, "daySpeech").filter((p) => p.view.day === 1);
    expect(ascSpeeches.map((p) => p.seat)).toEqual([6, 7, 8, 9, 10, 11, 1, 2, 3, 4, 5]);
    const ascEvt = asc.events.find((e) => e.title === "警长定序");
    expect(ascEvt?.type).toBe("system");
    expect(ascEvt?.content).toContain("升序");

    // —— 降序：从4号起按座位降序循环，警长5号最后 ——
    const desc = setup(0);
    const descSpeeches = subPendings(desc.pendings, "daySpeech").filter((p) => p.view.day === 1);
    expect(descSpeeches.map((p) => p.seat)).toEqual([4, 3, 2, 1, 11, 10, 9, 8, 7, 6, 5]);
    const descEvt = desc.events.find((e) => e.title === "警长定序");
    expect(descEvt?.type).toBe("system");
    expect(descEvt?.content).toContain("降序");
  });

  it("警长死亡后：次日按座位升序发言，不再出现 sheriffOrder 决策", () => {
    const { pendings } = drive("standard12", STD12, (p) => {
      const thought = "t";
      const d = p.view.day;
      if (p.kind === "wolfKill") return { thought, targets: [d === 1 ? 12 : 5] }; // 第2夜刀死警长
      if (p.kind === "seerCheck") return { thought, targets: [1] };
      if (p.kind === "sheriffRun")
        return BATCH_MAP(p, (sub) => ({ thought, targets: [sub.seat === 5 ? 1 : 0] })); // 仅5号上警 → 直接当选
      if (p.kind === "sheriffOrder") return { thought, targets: [1] };
      if (p.kind === "badgePass") return { thought, skip: true }; // 警长被刀后撕掉警徽（测试警徽流失场景）
      return QUICK(p);
    }, {
      stop: (p) => p?.kind === "dayVote" && p.view.day === 2,
    });

    // 第1天：5号直接当选警长（无警上发言/投票环节），全体发言前出现一次 sheriffOrder
    expect(pendings.some((p) => p.kind === "sheriffSpeech")).toBe(false);
    const d1Order = pendings.filter((p) => p.kind === "sheriffOrder" && p.view.day === 1);
    expect(d1Order.length).toBe(1);
    expect(d1Order[0].seat).toBe(5);
    // 第2天：警长5号第2夜被刀（警徽流失）→ 不再出现 sheriffOrder，按座位升序发言
    expect(pendings.some((p) => p.kind === "sheriffOrder" && p.view.day === 2)).toBe(false);
    const d2 = subPendings(pendings, "daySpeech").filter((p) => p.view.day === 2);
    expect(d2.map((p) => p.seat)).toEqual([1, 2, 3, 4, 6, 7, 8, 9, 10, 11]);
    expect(d2.every((p) => p.hint.includes("共1轮"))).toBe(true);
  });
});

describe("专项：decide 校验", () => {
  it("非法目标/非法跳过/缺发言/非狼自爆时抛错", () => {
    const engine = createEngine({
      boardId: "standard9",
      seatRoles: ["werewolf", "werewolf", "werewolf", "seer", "witch", "hunter", "villager", "villager", "villager"],
      options: { stepDelayMs: 0, sheriffEnabled: false, allowSelfDestruct: true, speechRoundsLimit: 1 },
    });
    const r = engine.advance();
    // 3只见面狼 → 首夜狼队流水线为 独立思考(并行批次)→频道讨论→落刀，首个决策是 wolfThink 批次（thought-only）
    expect(r.pending?.kind).toBe("wolfThink");
    expect(r.pending?.batch?.map((x) => x.seat)).toEqual([1, 2, 3]);
    // 思考型决策不要求 speech/targets（并行批次须按子项数量作答）
    engine.decide({ thought: "t", batchInputs: r.pending!.batch!.map(() => ({ thought: "t" })) });
    // 过掉剩余思考，推进到频道讨论（speech 必填）
    let r0 = engine.advance();
    let guard0 = 0;
    while (r0.pending && r0.pending.kind !== "wolfDiscuss" && guard0++ < 50) {
      engine.decide(QUICK(r0.pending));
      r0 = engine.advance();
    }
    expect(r0.pending?.kind).toBe("wolfDiscuss");
    expect(() => engine.decide({ thought: "t" })).toThrow(/speech/);
    engine.decide({ thought: "t", speech: "今晚先刀9号" });
    // 其余狼的讨论/反思快速过掉，推进到狼刀
    guard0 = 0;
    while (r0.pending && r0.pending.kind !== "wolfKill" && guard0++ < 50) {
      engine.decide(QUICK(r0.pending));
      r0 = engine.advance();
    }
    expect(r0.pending?.kind).toBe("wolfKill");
    // 目标不在 options 内
    expect(() => engine.decide({ thought: "t", targets: [999] })).toThrow(/不合法/);
    // 非法后状态不变，可正常重试
    expect(() => engine.decide({ thought: "t" })).toThrow(/不合法/);
    engine.decide({ thought: "t", targets: [9] });
    // 推进到预言家
    let r2 = engine.advance();
    let guard = 0;
    while (r2.pending && r2.pending.kind !== "seerCheck" && guard++ < 50) {
      engine.decide(QUICK(r2.pending));
      r2 = engine.advance();
    }
    expect(r2.pending?.kind).toBe("seerCheck");
    // seerCheck 不允许 skip
    expect(() => engine.decide({ thought: "t", skip: true })).toThrow(/不允许跳过/);
    engine.decide({ thought: "t", targets: [1] });
    // 推进到白天发言，验证缺 speech 抛错 & 非狼自爆抛错
    let r3 = engine.advance();
    guard = 0;
    while (r3.pending && r3.pending.kind !== "daySpeech" && guard++ < 80) {
      engine.decide(QUICK(r3.pending));
      r3 = engine.advance();
    }
    expect(r3.pending?.kind).toBe("daySpeech");
    expect(() => engine.decide({ thought: "t" })).toThrow(/speech/);
    if (r3.pending && r3.pending.view.camp !== "wolf") {
      expect(() => engine.decide({ thought: "t", selfDestruct: true })).toThrow(/不能自爆/);
    }
  });
});

// ============================================================
// 专项：赛后讨论（postGameDiscuss 开关；默认关）
// 快速对局脚本：狼队每晚顺次刀平民（9→10→11→12），白天全员弃票平安日，
// 第4夜结束平民灭绝 → 狼胜，进入 mainFlow 尾声（postgame 环节或径直 return）。
// ============================================================
describe("专项：赛后讨论", () => {
  // 速杀脚本：pgDecide 处理赛后讨论待决（聊天室机制：按座位顺序逐个单问，缺省全员 skip），其余决策快速推进
  const speedKill =
    (pgDecide?: (p: PendingDecision) => DecisionInput) =>
    (p: PendingDecision): DecisionInput => {
      const thought = "t";
      if (p.kind === "wolfKill") return { thought, targets: [8 + p.view.day] }; // 9/10/11/12 顺次
      if (p.kind === "postgameSpeak") return pgDecide ? pgDecide(p) : { thought, skip: true };
      return QUICK(p);
    };
  // 当前轮次：hint 内含「第N轮」
  const pgRoundOf = (p: PendingDecision): number => Number(/第(\d+)轮/.exec(p.hint)?.[1] ?? 0);

  it("默认关闭：不传 postGameDiscuss 时全程无赛后讨论", () => {
    const { engine, pendings, events } = drive("wolfKingGuard12", GUARD_BOARD_ROLES, speedKill());
    expect(engine.isFinished()).toBe(true);
    expect(engine.getSnapshot().winner).toBe("wolf"); // 速杀脚本狼胜
    expect(subPendings(pendings, "postgameSpeak").length).toBe(0);
    expect(events.some((e) => e.title === "赛后讨论开始")).toBe(false);
    expect(events.some((e) => e.title === "赛后讨论结束")).toBe(false);
    expect(events.some((e) => e.phase.startsWith("postgame"))).toBe(false);
  });

  it("开启完整流程：前2轮全员发言、第3轮全员弃权 → 环节结束", () => {
    const { engine, pendings, events } = drive(
      "wolfKingGuard12",
      GUARD_BOARD_ROLES,
      speedKill((p) => {
        const round = pgRoundOf(p);
        return round <= 2
          ? { thought: "t", speech: `赛后感想S${p.seat}R${round}` }
          : { thought: "t", skip: true };
      }),
      { options: { postGameDiscuss: true } },
    );
    expect(engine.isFinished()).toBe(true);
    expect(engine.getSnapshot().winner).toBe("wolf"); // 胜负不受赛后讨论影响

    // 环节开始/结束事件齐备
    expect(events.some((e) => e.type === "system" && e.title === "赛后讨论开始")).toBe(true);
    expect(events.some((e) => e.type === "system" && e.title === "赛后讨论结束")).toBe(true);

    // 赛后发言事件：12 人 × 2 轮 = 24 条，全部挂在 postgame.discuss 阶段
    const pgSpeeches = events.filter((e) => e.type === "speech" && e.title === "赛后讨论");
    expect(pgSpeeches.length).toBe(24);
    expect(pgSpeeches.every((e) => e.phase === "postgame.discuss")).toBe(true);
    // 每轮每人一条：轮次 meta 为 1/2，内容含座位与轮次
    expect(pgSpeeches.filter((e) => e.meta?.round === 1).length).toBe(12);
    expect(pgSpeeches.filter((e) => e.meta?.round === 2).length).toBe(12);
    expect(pgSpeeches.some((e) => e.content === "赛后感想S7R2")).toBe(true);
    // 顺序单问：3 轮 × 12 人 = 36 个独立 postgameSpeak 待决（非批次）
    const pgPendings = pendings.filter((p) => p.kind === "postgameSpeak");
    expect(pgPendings.length).toBe(36);
    expect(pgPendings.every((p) => !p.batch)).toBe(true);
  });

  it("机会用尽：仅7号每轮发言，5次用尽后第6轮起不再询问7号", () => {
    const { engine, pendings, events } = drive(
      "wolfKingGuard12",
      GUARD_BOARD_ROLES,
      speedKill((p) =>
        p.seat === 7 ? { thought: "t", speech: "7号的赛后发言" } : { thought: "t", skip: true },
      ),
      { options: { postGameDiscuss: true } },
    );
    expect(engine.isFinished()).toBe(true);
    // 7号恰好发言 5 次（机会上限），事件 meta.remain 递减到 0
    const s7 = events.filter((e) => e.type === "speech" && e.title === "赛后讨论" && e.actor === 7);
    expect(s7.length).toBe(5);
    expect(s7.map((e) => e.meta?.remain)).toEqual([4, 3, 2, 1, 0]);
    // 其余座位从未发言
    expect(events.some((e) => e.type === "speech" && e.title === "赛后讨论" && e.actor !== 7)).toBe(false);
    // 7号恰好被问 5 次：5 次机会用尽后第 6 轮起不再有 7 号的 postgameSpeak 待决
    const pgPendings = pendings.filter((p) => p.kind === "postgameSpeak");
    expect(pgPendings.filter((p) => p.seat === 7).length).toBe(5);
    // 第6轮：其余 11 人仍被逐个询问（弃权），全员静默 → 环节结束
    expect(pgPendings.length).toBe(5 * 12 + 11);
    expect(events.some((e) => e.title === "赛后讨论结束")).toBe(true);
  });

  it("发言机会上限可配：postGameSpeechLimit=1 时仅7号发言 1 次后即不再被询问", () => {
    const { engine, pendings, events } = drive(
      "wolfKingGuard12",
      GUARD_BOARD_ROLES,
      speedKill((p) =>
        p.seat === 7 ? { thought: "t", speech: "7号唯一的赛后发言" } : { thought: "t", skip: true },
      ),
      { options: { postGameDiscuss: true, postGameSpeechLimit: 1 } },
    );
    expect(engine.isFinished()).toBe(true);
    // 7号恰好发言 1 次（机会上限 1），meta.remain 直接归 0
    const s7 = events.filter((e) => e.type === "speech" && e.title === "赛后讨论" && e.actor === 7);
    expect(s7.length).toBe(1);
    expect(s7[0]?.meta?.remain).toBe(0);
    // 7号恰好被问 1 次（机会用尽后不再询问）
    const pgPendings = pendings.filter((p) => p.kind === "postgameSpeak");
    expect(pgPendings.filter((p) => p.seat === 7).length).toBe(1);
    // 第1轮全员 12 人（7号用掉唯一机会），第2轮除7号外 11 人仍被询问（全弃权→静默结束）
    expect(pgPendings.length).toBe(12 + 11);
    expect(events.some((e) => e.title === "赛后讨论结束")).toBe(true);
  });

  it("点名回复：3号 targets=[5] → 事件 meta.addressTo=5，公开记录含「3号 → 5号」", () => {
    const pgLogs: string[] = [];
    const { engine, events } = drive(
      "wolfKingGuard12",
      GUARD_BOARD_ROLES,
      (p) => {
        if (p.kind === "postgameSpeak") pgLogs.push(p.view.publicLog.join("\n"));
        return speedKill((pp) =>
          pp.seat === 3 && pgRoundOf(pp) === 1
            ? { thought: "t", speech: "5号你第二晚刀歪了", targets: [5] }
            : { thought: "t", skip: true },
        )(p);
      },
      { options: { postGameDiscuss: true } },
    );
    expect(engine.isFinished()).toBe(true);
    // 点名事件：meta.addressTo=5
    const s3 = events.find((e) => e.type === "speech" && e.title === "赛后讨论" && e.actor === 3);
    expect(s3?.meta?.addressTo).toBe(5);
    // 公开记录（喂给后续发言者）含「3号 → 5号」格式的点名发言
    expect(pgLogs.join("\n")).toContain("【赛后讨论】3号 → 5号：5号你第二晚刀歪了");
  });

  it("点名多人与所有人：targets=[5,7] → addressTo 数组；targets=[0] → 「所有人」", () => {
    const { engine, events } = drive(
      "wolfKingGuard12",
      GUARD_BOARD_ROLES,
      speedKill((p) => {
        if (p.seat === 3 && pgRoundOf(p) === 1) return { thought: "t", speech: "你们两个配合有问题", targets: [5, 7] };
        if (p.seat === 8 && pgRoundOf(p) === 1) return { thought: "t", speech: "大家都打得不错", targets: [0] };
        return { thought: "t", skip: true };
      }),
      { options: { postGameDiscuss: true } },
    );
    expect(engine.isFinished()).toBe(true);
    const s3 = events.find((e) => e.type === "speech" && e.title === "赛后讨论" && e.actor === 3);
    expect(s3?.meta?.addressTo).toEqual([5, 7]);
    const s8 = events.find((e) => e.type === "speech" && e.title === "赛后讨论" && e.actor === 8);
    expect(s8?.meta?.addressTo).toBe("all");
  });

  it("有来有回：5号在3号之后被问时，其 publicLog 已含3号本轮的发言（聊天室核心断言）", () => {
    const views: Record<number, PlayerView> = {};
    const { engine } = drive(
      "wolfKingGuard12",
      GUARD_BOARD_ROLES,
      (p) => {
        if (p.kind === "postgameSpeak" && pgRoundOf(p) === 1) views[p.seat] = p.view;
        return speedKill((pp) =>
          pp.seat === 3 && pgRoundOf(pp) === 1
            ? { thought: "t", speech: "三号的复盘内容ABC" }
            : { thought: "t", skip: true },
        )(p);
      },
      { options: { postGameDiscuss: true } },
    );
    expect(engine.isFinished()).toBe(true);
    // 3号发言前的视角（1/2/3号）不含该发言；3号之后的视角（4~12号）都能看到
    expect(views[3].publicLog.join("\n")).not.toContain("三号的复盘内容ABC");
    expect(views[5].publicLog.join("\n")).toContain("三号的复盘内容ABC");
    expect(views[12].publicLog.join("\n")).toContain("三号的复盘内容ABC");
  });

  it("信息壁垒：赛后阶段全员身份亮牌（含未翻牌死者）；对局中期不泄露", () => {
    let day1Pending: PendingDecision | null = null;
    const { engine, pendings } = drive(
      "wolfKingGuard12",
      GUARD_BOARD_ROLES,
      (p) => {
        if (!day1Pending && p.view.day === 1 && p.kind === "daySpeech") day1Pending = p;
        return speedKill()(p); // 赛后全员弃权（一轮即结束）
      },
      { options: { postGameDiscuss: true } },
    );
    expect(engine.isFinished()).toBe(true);

    // 赛后首轮：12 个独立待决（含死者 9~12 号）的 view.revealedRoles 覆盖全部 12 个座位
    const subs = pendings.filter((p) => p.kind === "postgameSpeak");
    expect(subs.length).toBe(12);
    for (const sub of subs) {
      const revealedSeats = Object.keys(sub.view.revealedRoles).map(Number).sort((a, b) => a - b);
      expect(revealedSeats).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
      expect(sub.view.revealedRoles[9]).toBe("villager"); // 未翻牌死者的身份也亮了
      expect(sub.view.revealedRoles[1]).toBe("werewolf"); // 狼人身份同样全亮
      expect(sub.view.phase).toBe("postgame.discuss");
      expect(sub.allowSkip).toBe(true);
      // 可点名对象=除自己外全部座位（含死者）+ 0（@所有人）
      expect(sub.options).toEqual([0, ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].filter((s) => s !== sub.seat)]);
    }

    // 对局中期（day 1）：速杀脚本无人翻牌，revealedRoles 为空——赛后全亮不得回灌中期
    expect(day1Pending).not.toBeNull();
    expect(Object.keys(day1Pending!.view.revealedRoles).length).toBe(0);
  });
});

// ============================================================
// 专项：赛后讨论开局告知 + 快照技能存量（胜率分析师的权威事实源）
// ============================================================
describe("专项：开局告知与快照存量", () => {
  it("postGameDiscuss:true → game.start 事件含赛后讨论告知，首 pending 的 view.rules.postGameDiscuss=true", () => {
    const { pendings, events } = drive("wolfKingGuard12", GUARD_BOARD_ROLES, QUICK, {
      options: { postGameDiscuss: true },
      stop: (p) => p != null, // 停在首个待决（开局第一夜）
    });
    const startEvt = events.find((e) => e.phase === "game.start" && e.type === "system")!;
    expect(startEvt.content).toContain("赛后讨论");
    expect(pendings.length).toBeGreaterThan(0);
    expect(pendings[0].view.rules?.postGameDiscuss).toBe(true);
  });

  it("postGameDiscuss 缺省 → 开局事件无告知，rules.postGameDiscuss=false", () => {
    const { pendings, events } = drive("wolfKingGuard12", GUARD_BOARD_ROLES, QUICK, {
      stop: (p) => p != null,
    });
    const startEvt = events.find((e) => e.phase === "game.start" && e.type === "system")!;
    expect(startEvt.content).not.toContain("赛后讨论");
    expect(pendings.length).toBeGreaterThan(0);
    expect(pendings[0].view.rules?.postGameDiscuss).toBe(false);
  });

  it("快照技能存量：开局女巫「解药可用/毒药可用」、猎人与狼王「开枪可用」，平民为空", () => {
    const engine = createEngine({
      boardId: "wolfKingGuard12",
      seatRoles: GUARD_BOARD_ROLES,
      options: { stepDelayMs: 0, sheriffEnabled: true, allowSelfDestruct: true, speechRoundsLimit: 1 },
    });
    const snap = engine.getSnapshot();
    const witch = snap.players.find((p) => p.role === "witch")!;
    expect(witch.stock).toContain("解药可用");
    expect(witch.stock).toContain("毒药可用");
    expect(snap.players.find((p) => p.role === "hunter")!.stock).toContain("开枪可用");
    expect(snap.players.find((p) => p.role === "wolfKing")!.stock).toContain("开枪可用");
    const villager = snap.players.find((p) => p.role === "villager")!;
    expect(villager.stock).toEqual([]);
    expect(villager.checks).toEqual([]);
  });
});
