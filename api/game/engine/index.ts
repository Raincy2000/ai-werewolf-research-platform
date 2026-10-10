// ============================================================
// 狼人杀引擎 —— 完整状态机实现（纯 TypeScript，无 I/O / 无网络 / 无数据库）
// 实现方式： generator 协程驱动主流程（夜晚 → 白天 → 夜晚 …），
//   advance() 推进到下一个决策点并返回 PendingDecision；
//   decide() 校验合法性后把决策喂回协程继续执行。
// 信息壁垒：PlayerView 只组装该玩家被允许知道的信息；publicLog 只含公开信息。
// ============================================================

import type {
  CreateEngine,
  DecisionInput,
  DecisionKind,
  Engine,
  EngineEvent,
  PendingDecision,
  PlayerView,
} from "./api";
import { SPEECH_REQUIRED_KINDS } from "./api";
import { BOARDS, ROLE_META } from "../../../contracts/game";
import type { RoleId } from "../../../contracts/game";

// ---------- 内部类型 ----------
type Cause =
  | "knife"         // 狼刀
  | "sameGuardSave" // 同守同救（奶穿：守卫守护与女巫解药同时作用于狼刀目标，护盾对冲致死）
  | "poison"       // 女巫毒
  | "dream"        // 连续两晚被摄（摄梦死）
  | "dreamLink"    // 摄梦人死亡连带
  | "hunt"         // 猎魔人狩猎
  | "shoot"        // 被枪带走
  | "take"         // 被白狼王带走
  | "duel"         // 骑士决斗
  | "exile"        // 被放逐
  | "selfDestruct" // 自爆
  | "bloodmoon";   // 血月使徒诅咒（最后一狼被放逐无效后次夜结束死亡）

const CAUSE_LABEL: Record<Cause, string> = {
  knife: "被狼人袭击",
  sameGuardSave: "被同守同救",
  poison: "被女巫毒杀",
  dream: "摄梦致死",
  dreamLink: "因摄梦人阵亡而同死",
  hunt: "被猎魔人狩猎",
  shoot: "被开枪带走",
  take: "被白狼王带走",
  duel: "决斗出局",
  exile: "被放逐",
  selfDestruct: "自爆出局",
  bloodmoon: "血月诅咒降临",
};

// 中文序数（出局原因等时间表达用汉字数字，观感协调）
const CN_NUM = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十",
  "十一", "十二", "十三", "十四", "十五", "十六", "十七", "十八", "十九", "二十"];
function cnNum(n: number): string {
  return CN_NUM[n - 1] ?? String(n);
}

// 见面狼（夜间共同睁眼、参与狼刀投票、可自爆）
// 导出供服务层批量决策清洗（自爆资格判定）使用
export const MEETING_WOLVES = new Set<RoleId>([
  "werewolf",
  "wolfKing",
  "whiteWolfKing",
  "nightmare",
  "bloodMoon",
  "mechWolf",
]);
// 不见面狼（石像鬼/隐狼）：其余狼全灭后带刀
const LONE_WOLVES = new Set<RoleId>(["gargoyle", "hiddenWolf"]);

interface PlayerState {
  seat: number;
  role: RoleId;
  alive: boolean;
  revealed: boolean;      // 已公开翻牌（白痴翻牌/骑士翻牌/自爆/开枪/血月翻牌）
  sheriff: boolean;
  idiotFlipped: boolean;  // 白痴已翻牌免死：可发言，不可投票/被投票
  deathCause: Cause | null;
  deathInfo: string | null;
  hasShot: boolean;       // 猎人/狼王已开过枪
  shootBlocked: boolean;  // 当夜被恐惧/血月封印，死亡不能开枪
  // —— 私密信息累积（仅本人可见） ——
  seerChecks: { seat: number; result: "good" | "wolf" }[];
  psychicChecks: { seat: number; result: string }[];
  gargoyleChecks: { seat: number; result: string }[];
  witchSave: boolean;
  witchPoison: boolean;
  guardHistory: number[];
  dreamerHistory: number[];
  nightmareHistory: number[];
  crowHistory: number[];
  gravekeeperReveals: { seat: number; wasWolf: boolean }[];
  demonHunterResults: { seat: number; died: "target" | "self" | "none" }[];
  wolfChat: string[];          // 狼人频道夜间讨论记录（仅见面狼可见，跨夜累积）
  fearedNotice: boolean;     // 下一次视图提示"你被恐惧了"
  bloodMoonNotice: boolean;  // 下一次视图提示"血月封印"
}

interface AskReq {
  seat: number;
  kind: DecisionKind;
  options: number[];
  allowSkip: boolean;
  hint: string;
}

// 同轮并行权衡请求（daySkill）：全部持技玩家的 AskReq 打包一次产出，
// 服务层并发询问全部 AI 后一次性回传 DecisionInput[]（墙钟≈单次调用，对局不被拖累）
interface BatchAskReq {
  batchOf: AskReq[];
}

function isBatchReq(x: AskReq | BatchAskReq): x is BatchAskReq {
  return Array.isArray((x as BatchAskReq).batchOf);
}

type Flow<TRet = void> = Generator<AskReq | BatchAskReq, TRet, DecisionInput | DecisionInput[]>;

interface NightState {
  fearedSeat: number | null;
  fearedWolf: boolean;          // 噩梦恐惧了狼 → 狼队当夜不能刀
  fearedGods: Set<number>;      // 被恐惧的神（技能封印）
  knifeTarget: number | null;
  guardTarget: number | null;
  dreamTarget: number | null;
  witchSaveUsed: boolean;
  poisonTarget: number | null;
  huntTarget: number | null;
  mechMimicRole: RoleId | null; // 机械狼今夜模仿的身份（仅伪装查验结果）
}

export const createEngine: CreateEngine = ({ boardId, seatRoles, options }) => {
  const board = BOARDS.find((b) => b.id === boardId);
  const witchSelfSaveRule = board?.witchSelfSave ?? "never";
  const n = seatRoles.length;

  // ---------- 对局状态 ----------
  let day = 0;
  let phase = "game.init";       // 逻辑阶段（AI 视图 / 快照）：瞬时权衡窗口（day.skill, withEvent=false）也会更新它
  let phaseLabel = "初始化";
  // 事件落盘标签：仅随「有提醒事件」的阶段切换更新——瞬时权衡窗口（setPhase withEvent=false）
  // 不得污染后续发言/投票/死亡等事件的 phase 标签（历史 bug：警上发言、放逐投票被打上「主动技能窗口」徽标）
  let eventPhase = "game.init";
  let winner: "wolf" | "good" | null = null;
  let finished = false;
  // 外部结算（服务层房规裁决，如白日交刀宣布胜利审核驳回）：主流程协程封存后，
  // 赛后讨论由独立协程驱动（postGamePhase 只依赖 players/winner 等模块状态，不依赖主流程断点）
  let mainAbandoned = false;
  let postgameGen: Flow | null = null;

  const players: PlayerState[] = seatRoles.map((role, i) => ({
    seat: i + 1,
    role,
    alive: true,
    revealed: false,
    sheriff: false,
    idiotFlipped: false,
    deathCause: null,
    deathInfo: null,
    hasShot: false,
    shootBlocked: false,
    seerChecks: [],
    psychicChecks: [],
    gargoyleChecks: [],
    witchSave: true,
    witchPoison: true,
    guardHistory: [],
    dreamerHistory: [],
    nightmareHistory: [],
    crowHistory: [],
    gravekeeperReveals: [],
    demonHunterResults: [],
    wolfChat: [],
    fearedNotice: false,
    bloodMoonNotice: false,
  }));

  let sheriffSeat: number | null = null;
  let sheriffGone = false;                 // 警徽流失（本局无警长）
  // 夜亡警长的警徽流推迟标记：夜间接刀不立即处置警徽，
  // 待白天公布夜亡后才由阵亡警长抉择移交/撕毁（dayPhase 公布夜亡后消费）
  let deferredBadgeSeat: number | null = null;
  // 上警候选人名单（≥2 人才标记：单人上警直接当选，无需「竞选中」灰警徽辨识度标识）；
  // 快照据此给候选座位透出 sheriffCand，警长落地或警徽流失后不再透出
  let sheriffCandidates: number[] = [];
  let duelUsed = false;                    // 骑士已决斗
  let wolfSurrendered = false;             // 白日交刀·认输：狼队认输（checkWin 据此判神民胜）
  let wolfDeclaredVictory = false;         // 白日交刀·宣布胜利：狼队必胜时提前终局（checkWin 据此判狼胜）
  let skillCtxObject = "";                 // 当前技能权衡的思考对象（写入发动事件 meta.skillObject）
  let sealNightNum: number | null = null;  // 血月使徒自爆 → 该夜所有神职技能封印
  let bloodMoonDoomedDay: number | null = null; // 最后一狼血月被放逐无效 → 次夜结束死亡
  let lastDayExile: { seat: number; wasWolf: boolean } | null = null; // 供守墓人
  let crowCurseSeat: number | null = null; // 乌鸦诽谤（当日投票有效）
  let lastGuarded: number | null = null;
  let lastDreamTarget: number | null = null;
  let nmLastFeared: number | null = null;

  let night: NightState = freshNight();
  let nightDeaths: number[] = [];       // 待公布的夜亡
  let nightDeathsPending = false;
  let morningDeaths: number[] = [];     // 今晨公布的死者（公开信息）
  let morningAnnounceCount = 0;         // 清晨公告（announceMorning）已执行次数：>0 才说明存在"昨夜"
  const announcedDead = new Set<number>(); // 已对外公布的死亡（用于视图 alive/dead 切分）

  const publicLog: string[] = [];
  const buffer: EngineEvent[] = [];
  let awaiting: AskReq | BatchAskReq | null = null;

  function freshNight(): NightState {
    return {
      fearedSeat: null,
      fearedWolf: false,
      fearedGods: new Set<number>(),
      knifeTarget: null,
      guardTarget: null,
      dreamTarget: null,
      witchSaveUsed: false,
      poisonTarget: null,
      huntTarget: null,
      mechMimicRole: null,
    };
  }

  // ---------- 基础工具 ----------
  const at = (seat: number): PlayerState => players[seat - 1];
  const roleName = (r: RoleId): string => ROLE_META[r].name;
  const campOf = (r: RoleId) => ROLE_META[r].camp;
  const aliveSeats = (): number[] => players.filter((p) => p.alive).map((p) => p.seat);
  const aliveOthers = (seat: number): number[] => aliveSeats().filter((s) => s !== seat);
  const byRole = (r: RoleId): PlayerState | undefined => players.find((p) => p.role === r);

  function emit(
    type: EngineEvent["type"],
    actor: number | null,
    title: string,
    content: string,
    thought: string | null = null,
    meta: Record<string, unknown> | null = null
  ) {
    buffer.push({ day, phase: eventPhase, type, actor, title, content, thought, meta });
  }

  function pub(text: string) {
    publicLog.push(text);
  }

  function setPhase(id: string, label: string, withEvent = true) {
    phase = id;
    phaseLabel = label;
    if (withEvent) {
      eventPhase = id;
      emit("phase", null, label, `【${label}】`);
    }
  }

  function drain(): EngineEvent[] {
    const out = buffer.slice();
    buffer.length = 0;
    return out;
  }

  // 警徽流（参考网易狼人杀官方机制）：警长阵亡时可由阵亡者选择把警徽移交给一名
  // 存活玩家（其接任警长、获归票位与1.5票），或撕掉警徽（本局再无警长）
  function* killPlayer(seat: number, cause: Cause | Cause[], whenText: string): Flow {
    const p = at(seat);
    if (!p.alive) return;
    // 多死因（如同守同救奶穿=狼刀+同守同救）：主死因（首个）供开枪/遗言等规则判定，
    // deathInfo 合并展示全部死因（「被狼人袭击&被同守同救」）
    const causes = Array.isArray(cause) ? cause : [cause];
    p.alive = false;
    p.deathCause = causes[0];
    p.deathInfo = `${whenText} · ${causes.map((c) => CAUSE_LABEL[c]).join("&")}`;
    if (!p.sheriff) return;
    p.sheriff = false;
    sheriffSeat = null;
    // 夜亡警长：警徽抉择推迟到白天公布夜亡之后进行（不连夜私下处置警徽）
    if (phase.startsWith("night")) {
      deferredBadgeSeat = seat;
      return;
    }
    yield* resolveBadgePass(seat);
  }

  // 警徽流抉择（阵亡警长）：移交存活玩家接任 / 撕毁流失
  function* resolveBadgePass(seat: number): Flow {
    const others = aliveOthers(seat);
    if (others.length === 0) {
      emit("system", null, "警徽流失", `警长${seat}号阵亡，警徽流失，本局不再设警长。`);
      pub(`【警徽流失】警长${seat}号阵亡，本局不再设警长。`);
      return;
    }
    const inp = yield* ask({
      seat,
      kind: "badgePass",
      options: others,
      allowSkip: true,
      hint: `你是阵亡警长（警徽流抉择）：可将警徽移交给一名存活玩家（targets=[目标]，其接任警长、获归票位与1.5票），或撕掉警徽（skip=true，本局再无警长）。警徽是阵营重要资产：好人优先移给确认的好人/信息位（如验出的金水、可信发言者），狼人则可为己方续命——判断失误可能把归票权送给对手。`,
    });
    if (!inp.skip && inp.targets?.length) {
      const t = inp.targets[0];
      emit("action", seat, "警徽抉择", `${seat}号警长将警徽移交给${t}号玩家。`, inp.thought);
      installSheriff(t);
      emit("system", null, "警徽移交", `警长${seat}号阵亡，警徽移交给${t}号玩家，由其接任警长。`);
      pub(`【警徽移交】${seat}号警长阵亡，${t}号玩家接任警长。`);
    } else {
      emit("action", seat, "警徽抉择", `${seat}号警长选择撕掉警徽。`, inp.thought);
      emit("system", null, "警徽流失", `警长${seat}号阵亡，警徽撕毁流失，本局不再设警长。`);
      pub(`【警徽流失】警长${seat}号阵亡，警徽撕毁，本局不再设警长。`);
    }
  }

  // 猎人/狼王死亡时能否开枪：被毒、被摄梦死（含连带）、自爆、当夜被封印 均不能开枪
  function canShootNow(p: PlayerState): boolean {
    if (p.role !== "hunter" && p.role !== "wolfKing") return false;
    if (p.alive || p.hasShot || p.shootBlocked || !p.deathCause) return false;
    return !["poison", "dream", "dreamLink", "selfDestruct"].includes(p.deathCause);
  }

  function majority(votes: number[]): number {
    const counts = new Map<number, number>();
    for (const v of votes) counts.set(v, (counts.get(v) ?? 0) + 1);
    let max = 0;
    for (const c of counts.values()) max = Math.max(max, c);
    const tied = [...counts.entries()].filter(([, c]) => c === max).map(([s]) => s);
    return Math.min(...tied); // 平票取最小座位号
  }

  // 预言家视角查验：隐狼为好；机械狼按模仿身份；石像鬼为狼
  function seerResult(target: number): "good" | "wolf" {
    const p = at(target);
    if (p.role === "hiddenWolf") return "good";
    if (p.role === "mechWolf" && night.mechMimicRole) {
      return campOf(night.mechMimicRole) === "wolf" ? "wolf" : "good";
    }
    return campOf(p.role) === "wolf" ? "wolf" : "good";
  }

  // 具体身份查验（通灵师/石像鬼）：机械狼按模仿身份显示
  function exactRoleName(target: number): string {
    const p = at(target);
    if (p.role === "mechWolf" && night.mechMimicRole) return roleName(night.mechMimicRole);
    return roleName(p.role);
  }

  // 屠边胜负判定（同时灭绝时狼刀优先，判狼胜）
  function checkWin(): "wolf" | "good" | null {
    if (wolfSurrendered) return "good"; // 白日交刀·认输：神民立即获胜
    if (wolfDeclaredVictory) return "wolf"; // 白日交刀·宣布胜利：狼队立即获胜
    const wolvesAlive = players.some((p) => p.alive && campOf(p.role) === "wolf");
    const godsAlive = players.some((p) => p.alive && campOf(p.role) === "god");
    const villagersAlive = players.some((p) => p.alive && campOf(p.role) === "villager");
    if (!wolvesAlive) return !godsAlive || !villagersAlive ? "wolf" : "good";
    if (!godsAlive || !villagersAlive) return "wolf";
    return null;
  }

  const isGodBlocked = (seat: number, sealed: boolean): boolean =>
    sealed || night.fearedGods.has(seat);

  // ---------- 视图组装（信息壁垒出口） ----------
  function buildView(seat: number, req?: AskReq): PlayerView {
    const p = at(seat);
    const priv: PlayerView["private"] = {};
    if (MEETING_WOLVES.has(p.role)) {
      // 狼队队友（石像鬼/隐狼不见面，绝不在其中）
      priv.wolfTeammates = players
        .filter((x) => MEETING_WOLVES.has(x.role) && x.seat !== seat)
        .map((x) => x.seat);
      // 狼人频道讨论记录（信息壁垒：仅见面狼可见，绝不进 publicLog）
      if (p.wolfChat.length) priv.wolfChat = p.wolfChat.slice();
    }
    if (p.seerChecks.length) priv.seerChecks = p.seerChecks.map((c) => ({ ...c }));
    if (p.psychicChecks.length) priv.psychicChecks = p.psychicChecks.map((c) => ({ ...c }));
    if (p.gargoyleChecks.length) priv.gargoyleChecks = p.gargoyleChecks.map((c) => ({ ...c }));
    if (p.role === "witch") priv.witchPotions = { save: p.witchSave, poison: p.witchPoison };
    if (req?.kind === "witchAction") priv.witchVictimTonight = night.knifeTarget;
    if (p.guardHistory.length) priv.guardHistory = p.guardHistory.slice();
    if (p.dreamerHistory.length) priv.dreamerHistory = p.dreamerHistory.slice();
    if (p.nightmareHistory.length) priv.nightmareHistory = p.nightmareHistory.slice();
    if (p.crowHistory.length) priv.crowHistory = p.crowHistory.slice();
    if (p.gravekeeperReveals.length)
      priv.gravekeeperReveals = p.gravekeeperReveals.map((c) => ({ ...c }));
    if (p.demonHunterResults.length)
      priv.demonHunterResults = p.demonHunterResults.map((c) => ({ ...c }));
    // 仅当已发生过至少一次清晨公告才注入"昨夜死亡"——开局第1夜对局尚无"昨天"，
    // 否则空数组会被 prompt 渲染成"昨夜平安夜"，让 AI 误以为存在前一天（幻影平安夜）
    if (morningAnnounceCount > 0) priv.lastNightDeaths = morningDeaths.slice();
    if (p.fearedNotice) priv.fearedTonight = true;
    if (p.bloodMoonNotice) priv.bloodMoonSealed = true;

    const revealedRoles: Record<number, RoleId> = {};
    // 赛后阶段（postgame.*）信息壁垒解除：全员身份（含未翻牌死者）对所有人公开
    for (const x of players) if (x.revealed || phase.startsWith("postgame")) revealedRoles[x.seat] = x.role;

    // 死亡公告前的死亡不对外可见（夜间结算到天亮公告之间，死者身份仍保密）
    const pubDead = players.filter((x) => announcedDead.has(x.seat)).map((x) => x.seat);
    const pubAlive = players.filter((x) => !announcedDead.has(x.seat)).map((x) => x.seat);

    return {
      seat,
      role: p.role,
      roleName: roleName(p.role),
      camp: campOf(p.role),
      day,
      phase,
      aliveSeats: pubAlive,
      deadSeats: pubDead,
      revealedRoles,
      sheriffSeat,
      selfAlive: p.alive,
      rules: { witchSelfSave: witchSelfSaveRule, postGameDiscuss: !!options.postGameDiscuss },
      publicLog: publicLog.slice(),
      private: priv,
    };
  }

  function buildPending(req: AskReq): PendingDecision {
    return {
      seat: req.seat,
      role: at(req.seat).role,
      kind: req.kind,
      options: req.options.slice(),
      allowSkip: req.allowSkip,
      view: buildView(req.seat, req),
      hint: req.hint,
    };
  }

  // 批量请求 → 打包待决：首个子请求作为外壳，全部子待决挂在 batch 上（服务层并发处理）
  function buildPendingAny(req: AskReq | BatchAskReq): PendingDecision {
    if (!isBatchReq(req)) return buildPending(req);
    const subs = req.batchOf.map(buildPending);
    return { ...subs[0], batch: subs };
  }

  // ---------- 决策合法性校验（非法即抛错，由服务层重试） ----------
  function validate(req: AskReq, inp: DecisionInput) {
    const p = at(req.seat);
    // 发言类决策：非空 speech 必填（集合统一定义于 ./api 的 SPEECH_REQUIRED_KINDS，
    // 与服务层兜底共用，防止两处列表漂移——历史事故：兜底漏 wolfDiscuss 致对局崩溃）
    const speechKinds = SPEECH_REQUIRED_KINDS;

    // 赛后讨论发言：非空 speech 发言优先（即使同时给了 skip）；无发言时 skip=本轮弃权（不消耗机会）
    if (req.kind === "postgameSpeak") {
      const t = typeof inp.speech === "string" ? inp.speech.trim() : "";
      if (inp.targets?.length && !inp.targets.every((x) => req.options.includes(x)))
        throw new Error("赛后讨论：点名对象不合法");
      if (t) return; // 非空发言优先（即使同时给了 skip）
      if (inp.skip) return; // 弃权=本轮不说，不消耗机会
      throw new Error("赛后讨论：发言必须提供非空 speech，否则填 skip=true 弃权");
    }

    if (inp.surrender || inp.declareVictory) {
      if (req.kind !== "daySkill") throw new Error("当前阶段不能白日交刀");
      if (options.allowSurrender === false) throw new Error("本局未开启白日交刀");
      if (!options.allowSelfDestruct) throw new Error("本局未开启白日主动技能");
      if (!p.alive) throw new Error("死亡玩家不能白日交刀");
      if (!MEETING_WOLVES.has(p.role)) throw new Error("只有狼人可以白日交刀（石像鬼/隐狼不可）");
      return; // 白日交刀代替其他动作
    }

    if (inp.selfDestruct) {
      if (!["daySpeech", "pkSpeech", "sheriffSpeech", "daySkill"].includes(req.kind))
        throw new Error("当前阶段不能自爆");
      if (!options.allowSelfDestruct) throw new Error("本局未开启狼人自爆");
      if (!p.alive) throw new Error("死亡玩家不能自爆");
      if (!MEETING_WOLVES.has(p.role)) throw new Error("该角色不能自爆（石像鬼/隐狼不可自爆）");
      return; // 自爆代替发言
    }

    if (inp.duel != null) {
      if (req.kind !== "daySpeech" && req.kind !== "daySkill")
        throw new Error("当前阶段不能发起决斗（警上/PK不可）");
      if (p.role !== "knight") throw new Error("只有骑士可以发起决斗");
      if (duelUsed) throw new Error("骑士本局已经决斗过");
      const t = inp.duel;
      if (!Number.isInteger(t) || t < 1 || t > n || t === req.seat || !at(t).alive)
        throw new Error(`决斗目标不合法：${t}`);
      return; // 决斗代替发言
    }

    // 白天主动技能窗口：不自爆/不决斗即视为按兵不动（skip 或空响应均可）
    if (req.kind === "daySkill") return;

    if (speechKinds.has(req.kind)) {
      if (typeof inp.speech !== "string" || !inp.speech.trim())
        throw new Error("发言类决策必须提供非空 speech");
      return;
    }

    // 思考型决策（狼队独立思考）：只需 thought，不要求 speech、不要求 targets
    if (req.kind === "wolfThink") return;

    if (req.kind === "witchAction") {
      const wantPoison = !inp.skip && !!inp.targets && inp.targets.length > 0;
      if (inp.witchSave) {
        if (!p.witchSave) throw new Error("解药已用完");
        if (night.knifeTarget == null) throw new Error("今夜无人被刀，无法使用解药");
        const selfSaveAllowed = witchSelfSaveRule === "firstNight" && day === 1;
        if (night.knifeTarget === req.seat && !selfSaveAllowed)
          throw new Error("本版型女巫不能自救");
      }
      if (wantPoison) {
        if (!p.witchPoison) throw new Error("毒药已用完");
        if (!req.options.includes(inp.targets![0]))
          throw new Error(`毒药目标不合法：${inp.targets![0]}`);
      }
      if (inp.witchSave && wantPoison) throw new Error("同一晚只能使用一瓶药");
      return;
    }

    // 警长定序：不允许跳过；targets 必须是 [1]（升序）或 [0]（降序）
    if (req.kind === "sheriffOrder") {
      if (inp.skip) throw new Error("警长定序不允许跳过");
      const t = inp.targets;
      if (!t || t.length !== 1 || (t[0] !== 1 && t[0] !== 0))
        throw new Error("警长定序目标不合法：targets 必须是 [1]（升序）或 [0]（降序）");
      return;
    }

    // 退水：不允许跳过；targets 必须是 [1]（退水）或 [0]（继续竞选）；仅候选人可抉择
    if (req.kind === "sheriffWithdraw") {
      if (inp.skip) throw new Error("退水抉择不允许跳过");
      if (!sheriffCandidates.includes(req.seat)) throw new Error("非警上候选人不能退水");
      const t = inp.targets;
      if (!t || t.length !== 1 || (t[0] !== 1 && t[0] !== 0))
        throw new Error("退水抉择目标不合法：targets 必须是 [1]（退水）或 [0]（继续竞选）");
      return;
    }

    if (inp.skip) {
      if (!req.allowSkip) throw new Error(`该决策（${req.kind}）不允许跳过`);
      return;
    }

    const t = inp.targets?.[0];
    if (t == null || !req.options.includes(t))
      throw new Error(`目标不合法：${t}（可选：${req.options.join("/")}）`);
  }

  // ---------- 决策请求 ----------
  function* ask(req: AskReq): Flow<DecisionInput> {
    return (yield req) as DecisionInput;
  }

  // 并行权衡请求：单人退化为普通 ask；多人打包，回传与请求一一对应的决策数组
  function* askBatch(reqs: AskReq[]): Flow<DecisionInput[]> {
    if (reqs.length === 1) return [yield* ask(reqs[0])];
    return (yield { batchOf: reqs }) as DecisionInput[];
  }

  // ---------- 夜晚流程 ----------
  function* nightPhase(): Flow {
    setPhase("night.start", `第${day}夜 · 夜幕降临`);
    pub(`—— 第${day}夜 ——`);
    night = freshNight();
    const sealed = sealNightNum === day; // 血月使徒自爆后的那个夜晚
    if (sealed) {
      emit("system", null, "血月封印", "血月使徒的诅咒生效：今夜所有神职技能被封印。");
      pub("【血月封印】今夜所有神职技能被封印。");
    }

    // 1. 噩梦之影恐惧（夜间最先）
    const nm = byRole("nightmare");
    if (nm?.alive) {
      const opts = aliveSeats().filter((s) => s !== nmLastFeared);
      if (opts.length) {
        setPhase("night.nightmare", `第${day}夜 · 噩梦之影`);
        const inp = yield* ask({
          seat: nm.seat,
          kind: "nightmareFear",
          options: opts,
          allowSkip: false,
          hint: "噩梦之影：请选择今晚要恐惧的玩家（恐惧神则封其技能，恐惧狼则狼队无法刀人）",
        });
        const t = inp.targets![0];
        night.fearedSeat = t;
        nmLastFeared = t;
        nm.nightmareHistory.push(t);
        emit("action", nm.seat, "恐惧", `噩梦之影${nm.seat}号恐惧了${t}号玩家。`, inp.thought);
        const tp = at(t);
        if (campOf(tp.role) === "god") {
          night.fearedGods.add(t);
          tp.fearedNotice = true;
          emit("action", null, "恐惧生效", `${t}号玩家是神职，今夜技能被封印。`);
        } else if (campOf(tp.role) === "wolf") {
          night.fearedWolf = true;
          emit("action", null, "恐惧生效", `${t}号玩家是狼人，狼队今夜无法刀人。`);
        }
      }
    }

    // 2. 狼队夜流程：独立思考 → 讨论想法 → 投票落刀（每个阶段都产出心理活动）
    //    ≥2只见面狼存活才走 思考/讨论；单狼直接落刀（石像鬼/隐狼不参与）
    const meetingAlive = players.filter((p) => p.alive && MEETING_WOLVES.has(p.role));
    if (meetingAlive.length >= 2) {
      // 2a. 独立思考（thought-only，不发言、不进频道记录）：
      //     全队同时并行权衡（无需逐个发起，节省时间；思考互不可见，信息关系不变）
      setPhase("night.wolfThink", `第${day}夜 · 狼队独立思考`);
      const thinkInputs = yield* askBatch(
        meetingAlive.map((w) => ({
          seat: w.seat,
          kind: "wolfThink",
          options: [],
          allowSkip: false,
          hint: "狼人夜间独立思考：分析局势，拟定你心目中的刀口人选与理由（只思考，不发言）",
        })),
      );
      for (let i = 0; i < meetingAlive.length; i++) {
        const w = meetingAlive[i];
        emit("action", w.seat, "狼人频道", "（独立思考）", thinkInputs[i]?.thought ?? "", {
          channel: "wolf",
        });
      }

      // 2b. 狼人频道讨论
      setPhase("night.wolfDiscuss", `第${day}夜 · 狼队讨论`);
      for (const w of meetingAlive) {
        const inp = yield* ask({
          seat: w.seat,
          kind: "wolfDiscuss",
          options: [],
          allowSkip: false,
          hint: "狼人频道队内讨论：请向狼队友发言（提议今晚刀谁、为什么，可回应队友此前发言、制定白天伪装策略）。队内按座位顺序每晚各发言一次，后发言者能看到先发言队友的内容，你的发言也会被后续队友看到。",
        });
        const text = (inp.speech ?? "").trim();
        const line = `${w.seat}号：${text}`;
        // 追加到所有见面狼（含发言者本人）的频道记录；后续狼的讨论与当晚刀人决策的视图中可见
        for (const x of players) if (MEETING_WOLVES.has(x.role)) x.wolfChat.push(line);
        emit(
          "action",
          w.seat,
          "狼人频道",
          `${w.seat}号狼人（队内）：${text}`,
          inp.thought,
          { channel: "wolf" }
        );
      }

    }

    // 3. 狼队投票落刀（每个见面的存活狼各投一次刀口票，多数票，平票取最小座位号；
    //    投票时 view.wolfChat 已含全队讨论，投出的就是综合讨论后的最终意向）
    const loneAlive = players.filter((p) => p.alive && LONE_WOLVES.has(p.role));
    // 石像鬼/隐狼在其余狼人全部死亡后带刀
    const killers = meetingAlive.length ? meetingAlive : loneAlive;
    if (night.fearedWolf) {
      emit("action", null, "狼刀被封", "狼队今夜被恐惧，无法袭击。");
    } else if (killers.length) {
      setPhase("night.wolf", `第${day}夜 · 狼人行动`);
      const votes: number[] = [];
      for (const w of killers) {
        const inp = yield* ask({
          seat: w.seat,
          kind: "wolfKill",
          options: aliveSeats(),
          allowSkip: false,
          hint: "狼人：请选择今晚袭击的目标（狼队多数票决定）",
        });
        const t = inp.targets![0];
        votes.push(t);
        emit("action", w.seat, "狼刀投票", `${w.seat}号狼人选择袭击${t}号玩家。`, inp.thought);
      }
      night.knifeTarget = majority(votes);
      emit("action", null, "狼刀落定", `狼队最终决定袭击${night.knifeTarget}号玩家。`);
    }

    // 4. 机械狼模仿
    const mw = byRole("mechWolf");
    if (mw?.alive) {
      setPhase("night.mechwolf", `第${day}夜 · 机械狼模仿`);
      const inp = yield* ask({
        seat: mw.seat,
        kind: "mechWolfMimic",
        options: aliveOthers(mw.seat),
        allowSkip: true,
        hint: "机械狼：可选择模仿一名存活玩家（今晚被查验时显示为其身份），或放弃",
      });
      if (!inp.skip && inp.targets?.length) {
        night.mechMimicRole = at(inp.targets[0]).role;
        emit("action", mw.seat, "机械模仿", `机械狼模仿了${inp.targets[0]}号玩家的身份。`, inp.thought);
      } else {
        emit("action", mw.seat, "机械模仿", "机械狼今夜未模仿任何人。", inp.thought);
      }
    }

    // 5. 石像鬼验人
    const gk = byRole("gargoyle");
    if (gk?.alive) {
      setPhase("night.gargoyle", `第${day}夜 · 石像鬼查验`);
      const inp = yield* ask({
        seat: gk.seat,
        kind: "gargoyleCheck",
        options: aliveOthers(gk.seat),
        allowSkip: false,
        hint: "石像鬼：请选择今晚要查验具体身份的玩家",
      });
      const t = inp.targets![0];
      const res = exactRoleName(t);
      gk.gargoyleChecks.push({ seat: t, result: res });
      emit("action", gk.seat, "石像鬼查验", `石像鬼查验${t}号玩家，结果为【${res}】。`, inp.thought);
    }

    // 6. 守卫守护
    const gd = byRole("guard");
    if (gd?.alive) {
      if (isGodBlocked(gd.seat, sealed)) {
        emit("action", gd.seat, "技能被封", "守卫今夜技能被封印，无法守护。");
      } else {
        const opts = aliveSeats().filter((s) => s !== lastGuarded);
        if (opts.length) {
          setPhase("night.guard", `第${day}夜 · 守卫守护`);
          const inp = yield* ask({
            seat: gd.seat,
            kind: "guardProtect",
            options: opts,
            allowSkip: true,
            hint: "守卫：请选择今晚守护的玩家（不能连续两晚守同一人），或放弃",
          });
          if (!inp.skip && inp.targets?.length) {
            night.guardTarget = inp.targets[0];
            lastGuarded = inp.targets[0];
            gd.guardHistory.push(inp.targets[0]);
            emit("action", gd.seat, "守护", `守卫今夜守护了${inp.targets[0]}号玩家。`, inp.thought);
          } else {
            lastGuarded = null;
            emit("action", gd.seat, "守护", "守卫今夜空守。", inp.thought);
          }
        }
      }
    }

    // 7. 摄梦人摄梦（必须选择，不可自摄）
    const dr = byRole("dreamer");
    if (dr?.alive) {
      if (isGodBlocked(dr.seat, sealed)) {
        emit("action", dr.seat, "技能被封", "摄梦人今夜技能被封印，无法摄梦。");
      } else {
        setPhase("night.dreamer", `第${day}夜 · 摄梦人`);
        const inp = yield* ask({
          seat: dr.seat,
          kind: "dreamerDream",
          options: aliveOthers(dr.seat),
          allowSkip: false,
          hint: "摄梦人：请选择今晚要摄梦的玩家（必须选择，不能摄自己）",
        });
        const t = inp.targets![0];
        night.dreamTarget = t;
        dr.dreamerHistory.push(t);
        emit("action", dr.seat, "摄梦", `摄梦人今夜摄梦了${t}号玩家。`, inp.thought);
      }
    }

    // 8. 女巫行动（一晚最多一瓶药）
    const wi = byRole("witch");
    if (wi?.alive && (wi.witchSave || wi.witchPoison)) {
      if (isGodBlocked(wi.seat, sealed)) {
        emit("action", wi.seat, "技能被封", "女巫今夜技能被封印，无法用药。");
      } else {
        setPhase("night.witch", `第${day}夜 · 女巫行动`);
        // 规则提示同步：今夜被刀的是女巫自己且本版型不可自救时，hint 明确告知，避免误自救
        const selfSaveOkTonight = witchSelfSaveRule === "firstNight" && day === 1;
        const witchHint =
          night.knifeTarget === wi.seat && !selfSaveOkTonight
            ? "女巫：今夜被刀的是你，本局规则不可自救（不能用解药救自己）。可用毒药毒杀一人（targets），或放弃（skip=true）"
            : "女巫：可用解药救今夜被刀者（witchSave=true），或用毒药毒杀一人（targets），同一晚只能用一瓶";
        const inp = yield* ask({
          seat: wi.seat,
          kind: "witchAction",
          options: wi.witchPoison ? aliveOthers(wi.seat) : [],
          allowSkip: true,
          hint: witchHint,
        });
        if (inp.witchSave) {
          wi.witchSave = false;
          night.witchSaveUsed = true;
          emit("action", wi.seat, "解药", `女巫使用解药救${night.knifeTarget}号玩家。`, inp.thought);
        }
        if (!inp.skip && inp.targets?.length) {
          wi.witchPoison = false;
          night.poisonTarget = inp.targets[0];
          emit("action", wi.seat, "毒药", `女巫使用毒药毒杀${inp.targets[0]}号玩家。`, inp.thought);
        }
        if (!inp.witchSave && (inp.skip || !inp.targets?.length)) {
          emit("action", wi.seat, "女巫行动", "女巫今夜未用药。", inp.thought);
        }
      }
    }

    // 9. 预言家验人
    const se = byRole("seer");
    if (se?.alive) {
      if (isGodBlocked(se.seat, sealed)) {
        emit("action", se.seat, "技能被封", "预言家今夜技能被封印，无法查验。");
      } else {
        setPhase("night.seer", `第${day}夜 · 预言家查验`);
        const inp = yield* ask({
          seat: se.seat,
          kind: "seerCheck",
          options: aliveOthers(se.seat),
          allowSkip: false,
          hint: "预言家：请选择今晚要查验的玩家（结果：好人/狼人）",
        });
        const t = inp.targets![0];
        const res = seerResult(t);
        se.seerChecks.push({ seat: t, result: res });
        emit(
          "action",
          se.seat,
          "预言家查验",
          `预言家查验${t}号玩家，结果为【${res === "wolf" ? "狼人" : "好人"}】。`,
          inp.thought
        );
      }
    }

    // 10. 通灵师验人
    const ps = byRole("psychic");
    if (ps?.alive) {
      if (isGodBlocked(ps.seat, sealed)) {
        emit("action", ps.seat, "技能被封", "通灵师今夜技能被封印，无法查验。");
      } else {
        setPhase("night.psychic", `第${day}夜 · 通灵师查验`);
        const inp = yield* ask({
          seat: ps.seat,
          kind: "psychicCheck",
          options: aliveOthers(ps.seat),
          allowSkip: false,
          hint: "通灵师：请选择今晚要查验的玩家（结果：具体身份）",
        });
        const t = inp.targets![0];
        const res = exactRoleName(t);
        ps.psychicChecks.push({ seat: t, result: res });
        emit("action", ps.seat, "通灵师查验", `通灵师查验${t}号玩家，结果为【${res}】。`, inp.thought);
      }
    }

    // 11. 猎魔人狩猎（第二晚起）
    const dh = byRole("demonHunter");
    if (dh?.alive && day >= 2) {
      if (isGodBlocked(dh.seat, sealed)) {
        emit("action", dh.seat, "技能被封", "猎魔人今夜技能被封印，无法狩猎。");
      } else {
        setPhase("night.demonhunter", `第${day}夜 · 猎魔人狩猎`);
        const inp = yield* ask({
          seat: dh.seat,
          kind: "demonHunterHunt",
          options: aliveOthers(dh.seat),
          allowSkip: true,
          hint: "猎魔人：可选择今晚狩猎的玩家（中狼则狼死，中好人则你死），或放弃",
        });
        if (!inp.skip && inp.targets?.length) {
          night.huntTarget = inp.targets[0];
          emit("action", dh.seat, "狩猎", `猎魔人今夜狩猎了${inp.targets[0]}号玩家。`, inp.thought);
        } else {
          emit("action", dh.seat, "狩猎", "猎魔人今夜放弃狩猎。", inp.thought);
        }
      }
    }

    // 12. 乌鸦诽谤
    const cr = byRole("crow");
    if (cr?.alive) {
      if (isGodBlocked(cr.seat, sealed)) {
        emit("action", cr.seat, "技能被封", "乌鸦今夜技能被封印，无法诽谤。");
      } else {
        setPhase("night.crow", `第${day}夜 · 乌鸦诽谤`);
        const inp = yield* ask({
          seat: cr.seat,
          kind: "crowCurse",
          options: aliveOthers(cr.seat),
          allowSkip: true,
          hint: "乌鸦：可选择今晚诽谤的玩家（次日其被投票时额外计1票），或放弃",
        });
        if (!inp.skip && inp.targets?.length) {
          crowCurseSeat = inp.targets[0];
          cr.crowHistory.push(inp.targets[0]);
          emit("action", cr.seat, "诽谤", `乌鸦诽谤了${inp.targets[0]}号玩家。`, inp.thought);
        } else {
          emit("action", cr.seat, "诽谤", "乌鸦今夜未诽谤任何人。", inp.thought);
        }
      }
    }

    // 13. 守墓人（被动：得知上一白天被放逐者是否为狼人）
    const gkp = byRole("gravekeeper");
    if (lastDayExile) {
      const info = lastDayExile;
      lastDayExile = null;
      if (gkp?.alive && !isGodBlocked(gkp.seat, sealed)) {
        const wasWolf = campOf(at(info.seat).role) === "wolf";
        gkp.gravekeeperReveals.push({ seat: info.seat, wasWolf });
        emit(
          "action",
          gkp.seat,
          "守墓人",
          `守墓人得知：昨天被放逐的${info.seat}号玩家${wasWolf ? "是" : "不是"}狼人。`
        );
      }
    }

    // 夜晚结束：清空全部"下一视图提示"标志（恐惧/血月封印提示仅当夜有效——
    // 封印夜神职决策被 isGodBlocked 跳过、不经 decide 清除，标志残留会让
    // 玩家在后续夜晚仍误以为自己被限制）
    for (const x of players) {
      x.fearedNotice = false;
      x.bloodMoonNotice = false;
    }

    yield* nightSettle(sealed);
  }

  // ---------- 夜间结算 ----------
  function* nightSettle(sealed: boolean): Flow {
    setPhase("night.settle", `第${day}夜 · 夜间结算`);
    // 死因列表：通常单死因；同守同救奶穿为复合死因（狼刀+同守同救），deathInfo 合并展示
    const deaths = new Map<number, Cause[]>();

    // 狼刀结算：摄梦免疫 > 同守同救奶穿 > 守/救 > 死亡
    if (night.knifeTarget != null) {
      const t = night.knifeTarget;
      const guarded = night.guardTarget === t;
      const dreamed = night.dreamTarget === t;
      const saved = night.witchSaveUsed;
      if (dreamed) {
        emit("action", null, "摄梦保护", `${t}号玩家被摄梦保护，狼刀无效。`);
      } else if (guarded && saved) {
        deaths.set(t, ["knife", "sameGuardSave"]);
        emit("action", null, "同守同救", `${t}号玩家同守同救，奶穿身亡。`);
      } else if (guarded) {
        emit("action", null, "守护成功", `${t}号玩家被守卫守住，狼刀无效。`);
      } else if (saved) {
        emit("action", null, "解药生效", `${t}号玩家被女巫救下。`);
      } else {
        deaths.set(t, ["knife"]);
      }
    }

    // 毒药结算（猎魔人免疫毒药）
    if (night.poisonTarget != null) {
      const t = night.poisonTarget;
      if (at(t).role === "demonHunter") {
        emit("action", null, "免疫毒药", `${t}号玩家是猎魔人，免疫女巫毒药。`);
      } else {
        deaths.set(t, ["poison"]);
      }
    }

    // 猎魔人结算
    if (night.huntTarget != null) {
      const t = night.huntTarget;
      const dh = byRole("demonHunter")!;
      if (campOf(at(t).role) === "wolf") {
        deaths.set(t, ["hunt"]);
        dh.demonHunterResults.push({ seat: t, died: "target" });
        emit("action", null, "狩猎成功", `猎魔人狩猎${t}号玩家，对方是狼人，当夜死亡。`);
      } else {
        deaths.set(dh.seat, ["hunt"]);
        dh.demonHunterResults.push({ seat: t, died: "self" });
        emit("action", null, "狩猎失败", `猎魔人狩猎${t}号玩家，对方是好人，猎魔人自己死亡。`);
      }
    }

    // 摄梦三连规则：同一人连续两晚被摄 → 第二晚死亡
    if (night.dreamTarget != null && night.dreamTarget === lastDreamTarget) {
      deaths.set(night.dreamTarget, ["dream"]);
      emit("action", null, "摄梦致死", `${night.dreamTarget}号玩家连续两晚被摄梦，摄梦致死。`);
    }
    // 摄梦人当夜死亡 → 被摄者同死
    const dr = byRole("dreamer");
    if (dr && deaths.has(dr.seat) && night.dreamTarget != null && !deaths.has(night.dreamTarget)) {
      deaths.set(night.dreamTarget, ["dreamLink"]);
      emit("action", null, "梦境坍塌", `摄梦人阵亡，${night.dreamTarget}号被摄者同死。`);
    }

    // 血月使徒：最后一狼被放逐无效 → 下一夜结束时死亡
    if (bloodMoonDoomedDay != null && day === bloodMoonDoomedDay + 1) {
      const bm = byRole("bloodMoon");
      bloodMoonDoomedDay = null;
      if (bm?.alive) {
        deaths.set(bm.seat, ["bloodmoon"]);
        emit("action", null, "血月诅咒", `血月使徒${bm.seat}号的诅咒降临，其在夜终死亡。`);
      }
    }

    // 生效
    nightDeaths = [...deaths.keys()].sort((a, b) => a - b);
    for (const s of nightDeaths) {
      yield* killPlayer(s, deaths.get(s)!, `第${cnNum(day)}夜`);
      // 被恐惧/血月封印当夜死亡的猎人不能开枪
      if (at(s).role === "hunter" && (sealed || night.fearedGods.has(s))) at(s).shootBlocked = true;
    }
    nightDeathsPending = true;
    lastDreamTarget = night.dreamTarget;
  }

  // ---------- 公布夜亡（白天流程内；第1天在警长竞选之前，全场先知道死讯再上警） ----------
  function announceMorning() {
    if (!nightDeathsPending) return;
    nightDeathsPending = false;
    morningAnnounceCount++; // 记录已发生过清晨公告：此后玩家视图才会出现"昨夜死亡/平安夜"
    setPhase("day.dawn", `第${day}天 · 公布夜亡`);
    if (nightDeaths.length) {
      const names = nightDeaths.map((s) => `${s}号`).join("、");
      emit("death", null, "死亡公告", `昨夜${names}玩家死亡。`);
      pub(`【死亡公告】昨夜死亡：${names}`);
      for (const s of nightDeaths) announcedDead.add(s);
    } else {
      emit("death", null, "死亡公告", "昨夜平安夜，无人死亡。");
      pub("【死亡公告】昨夜平安夜。");
    }
    morningDeaths = nightDeaths.slice();
    nightDeaths = [];
  }

  // ---------- 开枪链（猎人/狼王；被枪带者可连锁开枪） ----------
  function* shooterChain(queue: number[]): Flow {
    const asked = new Set<number>();
    while (queue.length) {
      const s = queue.shift()!;
      if (asked.has(s)) continue;
      asked.add(s);
      const p = at(s);
      if (!canShootNow(p)) continue;
      setPhase("day.shoot", `第${day}天 · 开枪`);
      const inp = yield* ask({
        seat: s,
        kind: "hunterShoot",
        options: aliveOthers(s),
        allowSkip: true,
        hint: `${roleName(p.role)}：你阵亡了，可以开枪带走一名玩家，或放弃`,
      });
      p.hasShot = true;
      p.revealed = true; // 开枪翻牌
      if (!inp.skip && inp.targets?.length) {
        const t = inp.targets[0];
        emit("action", s, "开枪", `${s}号玩家（${roleName(p.role)}）开枪带走了${t}号玩家。`, inp.thought);
        pub(`【开枪】${s}号玩家开枪带走了${t}号玩家。`);
        yield* killPlayer(t, "shoot", `第${cnNum(day)}日`);
        announcedDead.add(t);
        emit("death", t, "死亡公告", `${t}号玩家被枪带走。`);
        if (canShootNow(at(t))) queue.push(t);
      } else {
        emit("action", s, "开枪", `${s}号玩家（${roleName(p.role)}）放弃开枪。`, inp.thought);
        pub(`【开枪】${s}号玩家放弃开枪。`);
      }
    }
  }

  // ---------- 首夜遗言（被毒/被枪带/被带走者无遗言） ----------
  function* firstNightLastWords(): Flow {
    if (day !== 1) return;
    for (const s of morningDeaths.slice().sort((a, b) => a - b)) {
      const c = at(s).deathCause;
      if (c && ["poison", "shoot", "take"].includes(c)) continue;
      setPhase("day.lastwords", `第${day}天 · 遗言`);
      const inp = yield* ask({
        seat: s,
        kind: "lastWords",
        options: [],
        allowSkip: false,
        hint: "你已在首夜出局，请发表遗言",
      });
      emit("speech", s, "遗言", inp.speech ?? "（无言）", inp.thought);
      pub(`【遗言】${s}号玩家：${inp.speech ?? "（无言）"}`);
    }
  }

  // ---------- 狼人自爆（白天发言/PK/警上） ----------
  function* doSelfDestruct(s: number, inp: DecisionInput): Flow {
    const p = at(s);
    p.revealed = true;
    // channel="skillFired"：技能发动事件显式标记（右侧权衡框加粗红字，主线同时保留）
    // skillObject=发动时的权衡思考对象，skillChoice="fired"（前端据此渲染「发动」红粗标签）
    emit("action", s, "狼人自爆", `${s}号玩家自爆，身份为【${roleName(p.role)}】！`, inp.thought, {
      channel: "skillFired",
      skillObject: skillCtxObject || undefined,
      skillChoice: "fired",
    });
    pub(`【自爆】${s}号玩家自爆，身份为${roleName(p.role)}。`);
    yield* killPlayer(s, "selfDestruct", `第${cnNum(day)}日`);
    announcedDead.add(s);
    emit("death", s, "死亡公告", `${s}号玩家自爆出局。`);

    if (p.role === "bloodMoon") {
      sealNightNum = day + 1;
      for (const x of players) if (campOf(x.role) === "god") x.bloodMoonNotice = true;
      emit("system", null, "血月诅咒", "血月使徒自爆：下一个夜晚所有神职技能被封印。");
      pub("【血月诅咒】下一个夜晚所有神职技能将被封印。");
    }

    if (p.role === "whiteWolfKing") {
      const inp2 = yield* ask({
        seat: s,
        kind: "whiteWolfTake",
        options: aliveOthers(s),
        allowSkip: true,
        hint: "白狼王：自爆可以带走一名玩家同归于尽，或放弃",
      });
      if (!inp2.skip && inp2.targets?.length) {
        const t = inp2.targets[0];
        emit("action", s, "白狼王带人", `白狼王带走了${t}号玩家！`, inp2.thought, {
          channel: "skillFired",
          skillObject: skillCtxObject || undefined,
          skillChoice: "fired",
        });
        pub(`【白狼王】${s}号白狼王带走了${t}号玩家。`);
        yield* killPlayer(t, "take", `第${cnNum(day)}日`);
        announcedDead.add(t);
        emit("death", t, "死亡公告", `${t}号玩家被白狼王带走。`);
        if (canShootNow(at(t))) yield* shooterChain([t]);
      }
    }
  }

  // ---------- 警长竞选（仅第1天天亮） ----------
  function* sheriffElection(): Flow<"aborted" | "done"> {
    setPhase("day.sheriff.run", `第${day}天 · 警长竞选报名`);
    // 上警报名：全员同时暗选（并行询问，互不可见），全部决定后统一公布——
    // 与现实举手报名一致，后决定者无法参考先决定者的选择，信息公平一致
    const candidates: number[] = [];
    const runSeats = aliveSeats();
    const runHint =
      "警长竞选报名（全员同时暗选，结果统一公布）：有明确竞选意愿则上警（targets=[1]）；否则留在警下投票选警长（targets=[0]）。流程保障：警上发言结束后还有退水环节，可放弃竞选转为警下投票——可以先上警表表态、不合适再退，不必因怕下不来台而不敢上警。注意：全员上警会因警下无人投票导致警徽直接流失，没有竞选把握建议留在警下。";
    const runInputs = yield* askBatch(
      runSeats.map((s) => ({
        seat: s,
        kind: "sheriffRun",
        options: [1, 0],
        allowSkip: false,
        hint: runHint,
      })),
    );
    for (let i = 0; i < runSeats.length; i++) {
      const s = runSeats[i];
      const inp = runInputs[i] ?? { thought: "", targets: [0] };
      if (inp.targets?.[0] === 1) {
        candidates.push(s);
        emit("action", s, "上警", `${s}号玩家参与警长竞选。`, inp.thought);
      } else {
        emit("action", s, "留在警下", `${s}号玩家不参与警长竞选。`, inp.thought);
      }
    }
    pub(`【警长竞选】上警玩家：${candidates.length ? candidates.map((s) => `${s}号`).join("、") : "无"}`);
    // ≥2 名候选人：标记「竞选中」（快照透出灰色警徽）；单人上警直接当选不标记
    if (candidates.length >= 2) sheriffCandidates = candidates.slice();

    if (candidates.length === 0 || candidates.length === aliveSeats().length) {
      sheriffGone = true;
      // 区分两种流失原因：全员上警≠无人上警（历史 bug 观感：明明人人上警却显示"无人当选"）
      const reason =
        candidates.length === 0
          ? "无人上警竞选，警徽流失，本局无警长。"
          : "全员上警，警下无人投票，警徽流失，本局无警长。";
      emit("system", null, "警徽流失", reason);
      pub(`【警徽流失】${reason}`);
      return "done";
    }
    if (candidates.length === 1) {
      installSheriff(candidates[0]);
      return "done";
    }

    // 上警名单公布后、首段警上发言前：持技玩家基于名单实时权衡——
    // 狼可抢在发言前自爆吞警徽（双爆吞警徽机制覆盖竞选全程），骑士可决斗
    const rc0 = yield* daySkillCheck("上警名单公布");
    if (rc0 === "aborted") {
      sheriffGone = true;
      emit("system", null, "警徽流失", "白天主动技能发动，警徽流失，本局无警长，直接进入黑夜。");
      pub("【警徽流失】白天主动技能发动，警徽流失，本局无警长。");
      return "aborted";
    }
    if (checkWin()) return "done";

    // 警上发言（狼可自爆吞警徽 → 本局无警长，直接入夜）
    // 发言与权衡并行：上一段发言的权衡与下一段发言合并为并行批次，发言不等待权衡
    setPhase("day.sheriff.speech", `第${day}天 · 警上发言`);
    let weighReqs: AskReq[] = [];
    let weighObject = "";
    const sheriffWeighAbort = (): void => {
      sheriffGone = true;
      emit("system", null, "警徽流失", "白天主动技能发动，警徽流失，本局无警长，直接进入黑夜。");
      pub("【警徽流失】白天主动技能发动，警徽流失，本局无警长。");
    };
    // 警上发言中断说明：技能吞警徽导致流程提前结束时，公开未轮到发言的候选人（防误读沉默）
    const sheriffSpoke = new Set<number>();
    const sheriffActed = new Set<number>();
    const noteUnspokenSheriff = (): void => {
      const skipped = candidates.filter(
        (x) => at(x).alive && !sheriffSpoke.has(x) && !sheriffActed.has(x),
      );
      if (!skipped.length) return;
      const names = skipped.map((x) => `${x}号`).join("、");
      emit(
        "system",
        null,
        "发言中断说明",
        `因技能发动，警上发言流程提前中断：${names}未轮到发言——这是流程安排所致，并非他们故意保持沉默，请勿据此怀疑其身份。`
      );
      pub(`【发言中断说明】技能发动导致流程中断：${names}未轮到发言（并非主动沉默）。`);
    };
    for (const s of candidates) {
      if (!at(s).alive) continue;
      const { input: inp, aborted, speakerDied } = yield* askSpeechWithWeigh(
        {
          seat: s,
          kind: "sheriffSpeech",
          options: [],
          allowSkip: false,
          hint: "警上发言：请发表竞选宣言（狼人可自爆吞掉警徽）",
        },
        weighReqs,
        weighObject,
      );
      weighReqs = [];
      if (aborted) {
        noteUnspokenSheriff();
        sheriffWeighAbort();
        return "aborted";
      }
      if (checkWin()) return "done";
      if (speakerDied) continue;
      if (inp.selfDestruct) {
        sheriffActed.add(s);
        skillCtxObject = "自己的警上发言";
        yield* doSelfDestruct(s, inp);
        sheriffGone = true;
        emit("system", null, "警徽流失", "狼人自爆吞掉警徽，本局无警长，直接进入黑夜。");
        pub("【警徽流失】狼人自爆吞掉警徽，本局无警长。");
        noteUnspokenSheriff();
        return "aborted";
      }
      sheriffSpoke.add(s);
      emit("speech", s, "警上发言", inp.speech ?? "", inp.thought);
      pub(`【警上发言】${s}号玩家：${inp.speech ?? ""}`);

      // 基于本段警上发言的权衡请求：与下一段发言并行询问（双爆吞警徽机制覆盖竞选全程）
      weighObject = `${s}号的警上发言`;
      weighReqs = buildWeighReqs(weighObject);
    }
    // 最后一段警上发言的权衡：单独询问结算
    if (weighReqs.length) {
      const wInputs = yield* askBatch(weighReqs);
      const rc = yield* settleWeigh(weighReqs, wInputs, weighObject);
      if (rc === "aborted") {
        sheriffWeighAbort();
        return "aborted";
      }
      if (checkWin()) return "done";
    }

    // ---------- 退水环节（警上发言结束后、警徽投票前） ----------
    // 全体候选人同时权衡去留（暗票机制，与上警报名一致：并行询问，互不可见），
    // 全部权衡结束后统一宣布退水结果——后权衡者无法参考先宣布者的选择，信息公平一致；
    // 退水者放弃竞选、转为警下投票、失去候选标识；仅剩 1 人直接当选；全员退水则警徽流失
    setPhase("day.sheriff.withdraw", `第${day}天 · 退水环节`);
    emit(
      "system",
      null,
      "退水环节",
      "警上发言结束，进入退水环节：候选人同时权衡是否退水（结果统一公布），退水者转为警下参与警徽投票，留下者进入投票决选。"
    );
    pub("【退水环节】警上发言结束：候选人同时权衡是否退水（结果统一公布），退水者转为警下投票，留下者进入投票决选。");
    const aliveCands = candidates.filter((s) => at(s).alive);
    const withdrawHint = `退水环节（全体候选人同时权衡，结果统一公布）：是否继续竞选警长？targets=[0]=继续竞选（进入警徽投票决选），targets=[1]=退水（放弃竞选，立即转为警下玩家参与警徽投票）。当前存活候选人：${aliveCands.map((x) => `${x}号`).join("、")}。`;
    const withdrawInputs = yield* askBatch(
      aliveCands.map((s) => ({
        seat: s,
        kind: "sheriffWithdraw" as const,
        options: [1, 0],
        allowSkip: false,
        hint: withdrawHint,
      })),
    );
    const staying: number[] = [];
    const withdrew: { seat: number; thought: string }[] = [];
    for (let i = 0; i < aliveCands.length; i++) {
      const s = aliveCands[i];
      const inp = withdrawInputs[i] ?? { thought: "", targets: [0] };
      if (inp.targets?.[0] === 1) {
        withdrew.push({ seat: s, thought: inp.thought ?? "" });
      } else {
        staying.push(s);
      }
    }
    // 权衡全部结束后统一宣布：退水者失去候选标识，逐个公布退水决定
    if (withdrew.length > 0) {
      const withdrewSeats = withdrew.map((w) => w.seat);
      sheriffCandidates = sheriffCandidates.filter((x) => !withdrewSeats.includes(x));
      for (const w of withdrew) {
        emit("action", w.seat, "退水", `${w.seat}号玩家退水，放弃警长竞选，转为警下投票。`, w.thought);
      }
      pub(`【退水结果】${withdrewSeats.map((s) => `${s}号`).join("、")}放弃竞选，转为警下投票。`);
    } else {
      pub("【退水结果】无人退水，全部候选人进入警徽投票决选。");
    }
    if (staying.length === 0) {
      sheriffGone = true;
      sheriffCandidates = [];
      emit("system", null, "警徽流失", "全员退水，警徽流失，本局无警长。");
      pub("【警徽流失】全员退水，本局无警长。");
      return "done";
    }
    if (staying.length === 1) {
      sheriffCandidates = [];
      installSheriff(staying[0]);
      return "done";
    }
    // 投票候选池=留任者；退水者与未上警者同为警下投票人
    sheriffCandidates = staying.slice();

    // 警徽投票（平票则PK一次，再平则警徽流失）
    setPhase("day.sheriff.vote", `第${day}天 · 警徽投票`);
    let pool = staying.slice();
    let winnerSeat: number | null = null;
    for (let round = 0; round < 2 && winnerSeat == null; round++) {
      // 警徽投票：警下玩家同时暗票（并行询问，唱票前互不可见），全部投完后统一公布
      const voters = aliveSeats().filter((s) => !staying.includes(s));
      const counts = new Map<number, number>();
      for (const c of pool) counts.set(c, 0);
      const voteReqs: AskReq[] = voters.map((v) => ({
        seat: v,
        kind: "sheriffVote",
        options: pool.slice(),
        allowSkip: true,
        hint:
          round === 0
            ? "警徽投票（同时暗票，唱票前互不可见）：请选择你支持的候选人"
            : "警上PK投票（同时暗票，唱票前互不可见）：请在PK候选人中选择",
      }));
      const voteInputs = voteReqs.length ? yield* askBatch(voteReqs) : [];
      for (let i = 0; i < voteReqs.length; i++) {
        const v = voteReqs[i].seat;
        const inp = voteInputs[i] ?? { thought: "", skip: true };
        if (!inp.skip && inp.targets?.length) {
          const t = inp.targets[0];
          counts.set(t, (counts.get(t) ?? 0) + 1);
          emit("vote", v, "警徽投票", `${v}号玩家投给${t}号。`, inp.thought);
          pub(`【警徽投票】${v}号投给${t}号`);
        } else {
          emit("vote", v, "警徽投票", `${v}号玩家弃票。`, inp.thought);
          pub(`【警徽投票】${v}号弃票`);
        }
      }
      const tally = [...counts.entries()].filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1]);
      const tallyText = tally.length ? tally.map(([s, c]) => `${s}号${c}票`).join("，") : "无人得票";
      emit("vote", null, "警徽投票结果", tallyText);
      pub(`【警徽投票结果】${tallyText}`);
      if (!tally.length) break;
      const max = tally[0][1];
      const tied = tally.filter(([, c]) => c === max).map(([s]) => s);
      if (tied.length === 1) {
        winnerSeat = tied[0];
      } else if (round === 0) {
        pool = tied;
        setPhase("day.sheriff.pk", `第${day}天 · 警上PK`);
        // 发言与权衡并行（同警上发言）：PK 发言不等待权衡
        let pkWeighReqs: AskReq[] = [];
        let pkWeighObject = "";
        for (const s of tied) {
          if (!at(s).alive) continue;
          const { input: inp, aborted, speakerDied } = yield* askSpeechWithWeigh(
            {
              seat: s,
              kind: "pkSpeech",
              options: [],
              allowSkip: false,
              hint: "警上PK发言（狼人可自爆吞掉警徽）",
            },
            pkWeighReqs,
            pkWeighObject,
          );
          pkWeighReqs = [];
          if (aborted) {
            sheriffWeighAbort();
            return "aborted";
          }
          if (checkWin()) return "done";
          if (speakerDied) continue;
          if (inp.selfDestruct) {
            skillCtxObject = "自己的警上PK发言";
            yield* doSelfDestruct(s, inp);
            sheriffGone = true;
            emit("system", null, "警徽流失", "狼人自爆吞掉警徽，本局无警长，直接进入黑夜。");
            pub("【警徽流失】狼人自爆吞掉警徽，本局无警长。");
            return "aborted";
          }
          emit("speech", s, "警上PK发言", inp.speech ?? "", inp.thought);
          pub(`【警上PK发言】${s}号玩家：${inp.speech ?? ""}`);
          pkWeighObject = `${s}号的警上PK发言`;
          pkWeighReqs = buildWeighReqs(pkWeighObject);
        }
        // 最后一段警上PK发言的权衡：单独询问结算
        if (pkWeighReqs.length) {
          const wInputs = yield* askBatch(pkWeighReqs);
          const rc = yield* settleWeigh(pkWeighReqs, wInputs, pkWeighObject);
          if (rc === "aborted") {
            sheriffWeighAbort();
            return "aborted";
          }
          if (checkWin()) return "done";
        }
      }
    }
    if (winnerSeat != null) {
      installSheriff(winnerSeat);
    } else {
      sheriffGone = true;
      emit("system", null, "警徽流失", "警徽投票平局，警徽流失，本局无警长。");
      pub("【警徽流失】警徽投票平局，本局无警长。");
    }
    return "done";
  }

  function installSheriff(seat: number) {
    sheriffSeat = seat;
    sheriffCandidates = []; // 警长落地：候选人「竞选中」灰警徽随之消失
    at(seat).sheriff = true;
    emit("system", null, "警长落地", `${seat}号玩家当选警长（归票位，1.5票）。`);
    pub(`【警长竞选】${seat}号玩家当选警长。`);
  }

  // ---------- 白日交刀·宣布胜利（狼队必胜时提前终局，狼队立即获胜） ----------
  function* doDeclareVictory(s: number, inp: DecisionInput): Flow {
    const p = at(s);
    p.revealed = true;
    for (const x of players) if (campOf(x.role) === "wolf") x.revealed = true;
    wolfDeclaredVictory = true;
    emit(
      "action",
      s,
      "白日交刀",
      `${s}号玩家（${roleName(p.role)}）代表狼队宣布胜利！狼人阵营提前锁定胜局。`,
      inp.thought,
      {
        channel: "skillFired",
        skillObject: skillCtxObject || undefined,
        skillChoice: "fired",
      }
    );
    pub("【白日交刀】狼人阵营宣布胜利，提前终局。");
  }

  // ---------- 白日交刀（狼队认输，视为白日主动技能，与自爆同批权衡） ----------
  function* doSurrender(s: number, inp: DecisionInput): Flow {
    const p = at(s);
    p.revealed = true;
    // 揭晓全部狼人身份（投降亮牌）
    for (const x of players) if (campOf(x.role) === "wolf") x.revealed = true;
    wolfSurrendered = true;
    // channel="skillFired"：发动事件显式标记（右侧权衡框红粗定位，主线同时保留）
    emit(
      "action",
      s,
      "白日交刀",
      `${s}号玩家（${roleName(p.role)}）代表狼队白日交刀！狼人阵营认输，神民阵营胜利。`,
      inp.thought,
      {
        channel: "skillFired",
        skillObject: skillCtxObject || undefined,
        skillChoice: "fired",
      }
    );
    pub("【白日交刀】狼人阵营交刀认输，神民阵营胜利。");
  }

  // ---------- 骑士决斗（发言/主动技能窗口共用） ----------
  // aborted = 中狼，白天结束立即入夜；done = 中好人，骑士出局，白天流程继续
  function* doDuel(s: number, inp: DecisionInput): Flow<"aborted" | "done"> {
    duelUsed = true;
    const p = at(s);
    p.revealed = true;
    const t = inp.duel!;
    const tp = at(t);
    // channel="skillFired"：技能发动事件显式标记——右侧权衡框据此以加粗红字呈现（主线同时保留）
    emit("action", s, "骑士决斗", `骑士${s}号翻牌，向${t}号玩家发起决斗！`, inp.thought, {
      channel: "skillFired",
      skillObject: skillCtxObject || undefined,
      skillChoice: "fired",
    });
    pub(`【决斗】骑士${s}号向${t}号玩家发起决斗！`);
    if (campOf(tp.role) === "wolf") {
      yield* killPlayer(t, "duel", `第${cnNum(day)}日`);
      announcedDead.add(t);
      emit("death", t, "决斗结果", `${t}号玩家是狼人，决斗出局！立即进入黑夜。`);
      pub(`【决斗】${t}号玩家出局，白天结束，立即进入黑夜。`);
      if (canShootNow(tp)) yield* shooterChain([t]);
      return "aborted";
    }
    yield* killPlayer(s, "duel", `第${cnNum(day)}日`);
    announcedDead.add(s);
    emit("death", s, "决斗结果", `${t}号玩家是好人，骑士${s}号出局，白天流程继续。`);
    pub(`【决斗】${t}号玩家是好人，骑士${s}号出局。`);
    return "done";
  }

  // 最后一只狼自爆判负警示：狼阵营仅剩提问者自己时，自爆=神民立即胜利，必须在提示中显式阻断
  function lastWolfBoomWarning(): string {
    return players.filter((x) => x.alive && campOf(x.role) === "wolf").length === 1
      ? "⚠️警告：你是场上最后一只狼——自爆后场上再无狼人，神民将立即胜利（直接判负）！自爆不能换任何战术收益，绝不能自爆！"
      : "";
  }

  // ---------- 白天主动技能实时介入（骑士决斗 / 狼人自爆 / 白狼王自爆带人等） ----------
  // 持有可用白天主动技能的存活玩家，在白天全程实时跟进公开信息：
  // 夜亡公告后、上警名单公布后、每段警上/白天/PK发言之后、警长当选后（第1天），都会获得一次发动机会——
  // 可择机打断不利信息的扩散（如狼队友被查杀时立即自爆入夜、骑士听出狼立即决斗）。
  // 不发动则按兵不动（思考量落观察者事件，不进公开记录，不暴露身份）。
  // 构造本轮权衡请求（不立即询问）：objectText 写入按兵/发动事件 meta.skillObject
  function buildWeighReqs(objectText: string): AskReq[] {
    const actors = players.filter(
      (p) =>
        p.alive &&
        ((p.role === "knight" && !duelUsed) ||
          (options.allowSelfDestruct && MEETING_WOLVES.has(p.role))),
    );
    if (!actors.length) return [];
    skillCtxObject = objectText;
    // withEvent=false：权衡阶段不产生 phase 提醒事件——中间对局记录完全不显示权衡过程，
    // 且 eventPhase 不随之切换：后续发言/投票/死亡事件仍打宏观上下文标签（警上发言/放逐投票…），
    // 不会被「主动技能窗口」这个瞬时标签污染（按兵不动事件带 channel=skillThink 进右侧滚动框）
    setPhase("day.skill", `第${day}天 · 主动技能权衡（${objectText}）`, false);
    const reqs: AskReq[] = [];
    for (const a of actors) {
      const s = a.seat;
      if (!at(s).alive) continue;
      const isKnight = a.role === "knight" && !duelUsed;
      const canBoom = options.allowSelfDestruct && MEETING_WOLVES.has(a.role);
      if (!isKnight && !canBoom) continue;
      const surrenderPart =
        options.allowSurrender === false
          ? ""
          : "；或白日交刀认输（surrender=true，狼队认输、神民立即获胜——仅局面崩溃胜利无望时用）；或白日交刀宣布胜利（declareVictory=true，狼队立即获胜——仅在必胜时用：场上非狼玩家仅剩1人，或存活人数配置使好人绝无翻盘轮次，或其他你确信的必胜局面；误判则狼队白给，这是提前宣布胜利的爽感附带的风险）";
      const hint = isKnight
        ? `主动技能权衡（思考对象：${objectText}）：骑士可选择现在翻牌决斗（duel=目标座位），或 skip 按兵不动继续观察。决斗全场仅一次：中狼则狼出局并立即入夜，中好人则你出局。`
        : `主动技能权衡（思考对象：${objectText}）：可选择现在自爆（selfDestruct=true，当天剩余流程跳过直接入夜，可打断不利信息扩散）${surrenderPart}；或 skip 按兵不动继续观察。${lastWolfBoomWarning()}`;
      reqs.push({ seat: s, kind: "daySkill", options: aliveOthers(s), allowSkip: true, hint });
    }
    return reqs;
  }

  // 结算一轮权衡：自爆/决斗可能中断当天；按兵不动落观察者事件
  function* settleWeigh(reqs: AskReq[], inputs: DecisionInput[], objectText: string): Flow<"aborted" | "done"> {
    for (let i = 0; i < reqs.length; i++) {
      const s = reqs[i].seat;
      const a = at(s);
      const isKnight = a.role === "knight" && !duelUsed;
      const canBoom = options.allowSelfDestruct && MEETING_WOLVES.has(a.role);
      const inp = inputs[i] ?? { thought: "", skip: true };
      if (inp.selfDestruct && canBoom) {
        yield* doSelfDestruct(s, inp);
        emit("system", null, "进入黑夜", "狼人自爆，跳过当天剩余流程，直接进入黑夜。");
        pub("【自爆】当天剩余流程跳过，直接进入黑夜。");
        return "aborted";
      }
      if (inp.surrender && canBoom) {
        yield* doSurrender(s, inp);
        return "done"; // 对局结束（checkWin 判神民胜，由主流程 endGame 收尾）
      }
      if (inp.declareVictory && canBoom) {
        yield* doDeclareVictory(s, inp);
        return "done"; // 对局结束（checkWin 判狼胜，由主流程 endGame 收尾）
      }
      if (inp.duel != null && isKnight) {
        const r = yield* doDuel(s, inp);
        if (r === "aborted") return "aborted";
        if (checkWin()) return "done";
        continue;
      }
      // 按兵不动：仅观察者可见思考量（骑士的决斗权衡、狼人的自爆权衡），不进公开记录。
      // meta.channel="skillThink"：前端据此把它从对局记录分流到「技能权衡」滚动框（日志导出仍按时间序合并）；
      // meta.skillObject/skillChoice="hold"：前端据此渲染「思考对象」+「按兵」双标签
      emit(
        "action",
        s,
        "技能权衡",
        `${s}号玩家在${objectText}后权衡，按兵不动。`,
        inp.thought,
        { channel: "skillThink", skillObject: objectText, skillChoice: "hold" },
      );
    }
    return "done";
  }

  // 阻塞式权衡检查（夜亡公告/上警名单公布/警长当选等非发言相邻节点）：询问并结算
  function* daySkillCheck(objectText: string): Flow<"aborted" | "done"> {
    const reqs = buildWeighReqs(objectText);
    if (!reqs.length) return "done";
    const inputs = yield* askBatch(reqs);
    return yield* settleWeigh(reqs, inputs, objectText);
  }

  // 发言与权衡并行（核心：发言不再等待权衡）：
  // 「基于上一段发言的权衡批次」与「下一段发言请求」合并为一个并行批次，服务层并发询问——
  // 发言人思考与持技者权衡墙钟并进；返回后先结算权衡（自爆/决斗中狼则中断当天，
  // 发言输入作废；决斗中好人且死者为发言人则跳过其发言），再落地发言。
  function* askSpeechWithWeigh(speechReq: AskReq, weighReqs: AskReq[], weighObject: string): Flow<{
    input: DecisionInput;
    aborted: boolean;
    speakerDied: boolean;
  }> {
    const inputs = yield* askBatch(weighReqs.length ? [...weighReqs, speechReq] : [speechReq]);
    const input = inputs[inputs.length - 1] ?? { thought: "" };
    if (!weighReqs.length) return { input, aborted: false, speakerDied: false };
    const rc = yield* settleWeigh(weighReqs, inputs.slice(0, weighReqs.length), weighObject);
    return { input, aborted: rc === "aborted", speakerDied: !at(speechReq.seat).alive };
  }

  // ---------- 白天发言（全体发言固定1轮，可自爆/骑士决斗） ----------
  // 轮次规则：全体发言固定 1 轮；有警长版型第1天的发言由「警上竞选发言 + 全体发言1轮」构成。
  // 发言顺序：警长存活时先由警长做 sheriffOrder 决策（升序/降序），全体存活者（除警长）
  // 按该方向从警长下一位起循环发言，警长最后归票；警长死亡/无警长则按座位升序发言。
  function* daySpeeches(): Flow<"aborted" | "done"> {
    let speakers = aliveSeats(); // 白痴翻牌后仍可发言
    if (sheriffSeat != null && at(sheriffSeat).alive) {
      const s = sheriffSeat;
      // 升序方向（座位号递增循环）与降序方向（座位号递减循环）的存活发言序列（均不含警长）
      const asc: number[] = [];
      const desc: number[] = [];
      for (let i = 1; i < n; i++) {
        const up = ((s - 1 + i) % n) + 1;
        if (at(up).alive) asc.push(up);
        const down = (((s - 1 - i) % n) + n) % n + 1;
        if (at(down).alive) desc.push(down);
      }
      if (asc.length > 0) {
        setPhase("day.sheriffOrder", `第${day}天 · 警长定序`);
        const inp = yield* ask({
          seat: s,
          kind: "sheriffOrder",
          options: [1, 0],
          allowSkip: false,
          hint: `警长定序：选择升序（从${asc[0]}号开始）或降序（从${desc[0]}号开始）发言，您将最后归票发言`,
        });
        const ascending = inp.targets![0] === 1;
        const ordered = ascending ? asc : desc;
        speakers = [...ordered, s]; // 警长最后归票发言
        emit(
          "system",
          s,
          "警长定序",
          `警长${s}号选择${ascending ? "升序" : "降序"}发言（从${ordered[0]}号开始），警长最后归票发言。`,
          inp.thought
        );
        pub(`【警长定序】警长${s}号选择${ascending ? "升序" : "降序"}发言，警长最后归票发言。`);
      }
    }
    // 发言与权衡并行：上一段发言的权衡请求与下一段发言请求合并为并行批次（发言不等待权衡）
    let weighReqs: AskReq[] = [];
    let weighObject = "";
    // 发言中断说明（防误读沉默）：技能发动导致当天流程提前结束时，公开列出「未轮到发言」的玩家——
    // 他们的沉默是流程中断所致而非故意藏身份，避免后续被错误怀疑（线上实锤的博弈噪声）
    const spoken = new Set<number>(); // 已落地发言
    const acted = new Set<number>();  // 以自爆/决斗等方式主动行动过
    const noteUnspoken = (): void => {
      const skipped = speakers.filter((x) => at(x).alive && !spoken.has(x) && !acted.has(x));
      if (!skipped.length) return;
      const names = skipped.map((x) => `${x}号`).join("、");
      emit(
        "system",
        null,
        "发言中断说明",
        `因技能发动，当天发言流程提前中断：${names}未轮到发言——这是流程安排所致，并非他们故意保持沉默，请勿据此怀疑其身份。`
      );
      pub(`【发言中断说明】技能发动导致流程中断：${names}未轮到发言（并非主动沉默）。`);
    };
    for (const s of speakers) {
      if (!at(s).alive) continue;
      const p = at(s);
      const isKnightReady = p.role === "knight" && !duelUsed;
      const canBoom = options.allowSelfDestruct && MEETING_WOLVES.has(p.role);
      const roundText = "共1轮";
      setPhase("day.speech", `第${day}天 · 白天发言（${roundText}）`);
      const { input: inp, aborted, speakerDied } = yield* askSpeechWithWeigh(
        {
          seat: s,
          kind: "daySpeech",
          options: [],
          allowSkip: false,
          hint: `白天发言（${roundText}）${isKnightReady ? "；骑士可翻牌决斗（duel=目标）" : ""}${canBoom ? `；狼人可自爆（selfDestruct=true）${lastWolfBoomWarning()}` : ""}`,
        },
        weighReqs,
        weighObject,
      );
      weighReqs = [];
      if (aborted) {
        noteUnspoken();
        return "aborted";
      }
      if (checkWin()) return "done";
      if (speakerDied) continue; // 权衡结算中发言者被骑士决斗出局（中好人），跳过其发言

      if (inp.selfDestruct && canBoom) {
        acted.add(s);
        skillCtxObject = "自己的发言";
        yield* doSelfDestruct(s, inp);
        emit("system", null, "进入黑夜", "狼人自爆，跳过当天剩余流程，直接进入黑夜。");
        pub("【自爆】当天剩余流程跳过，直接进入黑夜。");
        noteUnspoken();
        return "aborted";
      }

      if (inp.duel != null && isKnightReady) {
        acted.add(s);
        skillCtxObject = "自己的发言";
        const rd = yield* doDuel(s, inp);
        if (rd === "aborted") {
          noteUnspoken();
          return "aborted";
        }
        if (checkWin()) return "done";
        continue;
      }

      spoken.add(s);
      emit("speech", s, "公开发言", inp.speech ?? "", inp.thought);
      pub(`【白天发言】${s}号玩家：${inp.speech ?? ""}`);

      // 基于本段发言的权衡请求：与下一段发言并行询问（可自爆/决斗打断进程）
      weighObject = `${s}号的发言`;
      weighReqs = buildWeighReqs(weighObject);
    }
    // 最后一段发言的权衡：单独询问结算
    if (weighReqs.length) {
      const wInputs = yield* askBatch(weighReqs);
      const rc = yield* settleWeigh(weighReqs, wInputs, weighObject);
      if (rc === "aborted") return "aborted";
      if (checkWin()) return "done";
    }
    return "done";
  }

  // ---------- 放逐投票（平票PK一次，再平则平安日） ----------
  function* exileVote(): Flow {
    setPhase("day.vote", `第${day}天 · 放逐投票`);
    const eligible = (s: number) => at(s).alive && !at(s).idiotFlipped;
    const voters = aliveSeats().filter(eligible);
    let pool = aliveSeats().filter(eligible);
    let exiled: number | null = null;
    let peace = false;

    for (let round = 0; round < 2 && exiled == null && !peace; round++) {
      const counts = new Map<number, number>();
      // 放逐投票：全体投票者同时暗票（并行询问，唱票前互不可见），全部投完后统一公布
      const activeVoters = round === 0 ? voters : voters.filter((s) => !pool.includes(s));
      const voteReqs: AskReq[] = [];
      for (const v of activeVoters) {
        if (!eligible(v)) continue;
        const opts = pool.filter((s) => s !== v && eligible(s));
        if (!opts.length) continue;
        voteReqs.push({
          seat: v,
          kind: "dayVote",
          options: opts,
          allowSkip: true,
          hint:
            round === 0
              ? "放逐投票（同时暗票，唱票前互不可见）：请选择你要放逐的玩家（可弃票）"
              : "平票PK投票（同时暗票，唱票前互不可见）：请在PK玩家中选择",
        });
      }
      const voteInputs = voteReqs.length ? yield* askBatch(voteReqs) : [];
      for (let i = 0; i < voteReqs.length; i++) {
        const v = voteReqs[i].seat;
        const inp = voteInputs[i] ?? { thought: "", skip: true };
        if (!inp.skip && inp.targets?.length) {
          const t = inp.targets[0];
          const w = at(v).sheriff ? 1.5 : 1;
          counts.set(t, (counts.get(t) ?? 0) + w);
          emit(
            "vote",
            v,
            "放逐投票",
            `${v}号玩家投给${t}号${at(v).sheriff ? "（警长1.5票）" : ""}。`,
            inp.thought
          );
          pub(`【放逐投票】${v}号投给${t}号`);
        } else {
          emit("vote", v, "放逐投票", `${v}号玩家弃票。`, inp.thought);
          pub(`【放逐投票】${v}号弃票`);
        }
      }

      // 乌鸦诽谤：被诽谤者被投时额外计1票
      if (crowCurseSeat != null && (counts.get(crowCurseSeat) ?? 0) > 0) {
        counts.set(crowCurseSeat, counts.get(crowCurseSeat)! + 1);
        emit("action", null, "乌鸦诽谤", `${crowCurseSeat}号玩家被乌鸦诽谤，额外计1票。`);
        pub(`【乌鸦】${crowCurseSeat}号玩家被诽谤，被投票时额外计1票。`);
      }

      const tally = [...counts.entries()].filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1]);
      const tallyText = tally.length
        ? tally.map(([s, c]) => `${s}号${c}票`).join("，")
        : "无人得票";
      emit("vote", null, "投票结果", tallyText);
      pub(`【投票结果】${tallyText}`);
      if (!tally.length) {
        peace = true; // 全员弃票 → 平安日
        break;
      }
      const max = tally[0][1];
      const tied = tally.filter(([, c]) => c === max).map(([s]) => s);
      if (tied.length === 1) {
        exiled = tied[0];
        break;
      }
      if (round === 0) {
        pool = tied;
        setPhase("day.pk", `第${day}天 · 平票PK`);
        // 发言与权衡并行（同白天发言）：PK 发言不等待权衡
        let pkWeighReqs: AskReq[] = [];
        let pkWeighObject = "";
        const pkWeighAbort = (): void => {
          crowCurseSeat = null;
        };
        for (const s of tied) {
          if (!at(s).alive) continue;
          const { input: inp, aborted, speakerDied } = yield* askSpeechWithWeigh(
            {
              seat: s,
              kind: "pkSpeech",
              options: [],
              allowSkip: false,
              hint: "平票PK发言（狼人可自爆直接入夜）",
            },
            pkWeighReqs,
            pkWeighObject,
          );
          pkWeighReqs = [];
          if (aborted) {
            pkWeighAbort();
            return;
          }
          if (checkWin()) return;
          if (speakerDied) continue;
          if (inp.selfDestruct && options.allowSelfDestruct && MEETING_WOLVES.has(at(s).role)) {
            skillCtxObject = "自己的平票PK发言";
            yield* doSelfDestruct(s, inp);
            emit("system", null, "进入黑夜", "狼人自爆，跳过当天剩余流程，直接进入黑夜。");
            pub("【自爆】当天剩余流程跳过，直接进入黑夜。");
            crowCurseSeat = null;
            return;
          }
          emit("speech", s, "PK发言", inp.speech ?? "", inp.thought);
          pub(`【PK发言】${s}号玩家：${inp.speech ?? ""}`);
          pkWeighObject = `${s}号的平票PK发言`;
          pkWeighReqs = buildWeighReqs(pkWeighObject);
        }
        // 最后一段平票PK发言的权衡：单独询问结算
        if (pkWeighReqs.length) {
          const wInputs = yield* askBatch(pkWeighReqs);
          const rc = yield* settleWeigh(pkWeighReqs, wInputs, pkWeighObject);
          if (rc === "aborted") {
            pkWeighAbort();
            return;
          }
          if (checkWin()) return;
        }
      } else {
        peace = true; // 再平 → 平安日
      }
    }
    crowCurseSeat = null;

    if (peace || exiled == null) {
      emit("system", null, "平安日", "投票平局，今天无人被放逐（平安日）。");
      pub("【平安日】今天无人被放逐。");
      return;
    }

    const p = at(exiled);
    emit("vote", null, "放逐结果", `${exiled}号玩家被放逐。`);
    pub(`【放逐】${exiled}号玩家被放逐。`);

    // 血月使徒：作为最后一狼被放逐 → 放逐无效（平安日），次夜结束时死亡
    if (
      p.role === "bloodMoon" &&
      !players.some((x) => x.alive && x.seat !== exiled && campOf(x.role) === "wolf")
    ) {
      p.revealed = true;
      bloodMoonDoomedDay = day;
      emit(
        "system",
        exiled,
        "血月使徒",
        `${exiled}号翻牌为【血月使徒】，且是最后一狼：本次放逐无效（平安日），其将于下一夜结束时死亡。`
      );
      pub(`【血月使徒】${exiled}号翻牌为血月使徒（最后一狼），本次放逐无效！`);
      return;
    }

    lastDayExile = { seat: exiled, wasWolf: campOf(p.role) === "wolf" };

    // 白痴被放逐：翻牌免死，之后可发言但不可投票也不可被投票
    if (p.role === "idiot" && !p.idiotFlipped) {
      p.idiotFlipped = true;
      p.revealed = true;
      emit(
        "system",
        exiled,
        "白痴翻牌",
        `${exiled}号玩家翻牌为【白痴】，免于出局！之后可发言，但不可投票也不可被投票。`
      );
      pub(`【翻牌】${exiled}号玩家是白痴，免于出局。`);
      // 发动时机：白痴翻牌信息公开后——持技玩家获得一次权衡
      // （骑士可顺势决斗、狼队可自爆吞掉当天剩余流程；白痴免死已生效，打断不影响其存活）
      const rFlip = yield* daySkillCheck(`${exiled}号翻牌为白痴`);
      if (rFlip === "aborted") return; // 自爆打断：当天剩余流程跳过直接入夜
      if (checkWin()) return; // 决斗/交刀分出胜负
      return;
    }

    // 真实主持人机制：放逐不立即出局——先遗言，再公开询问是否发动技能（全角色都问，
    // 避免从"是否被问"抿出身份），沉默则出局，发动则结算后出局
    // 1. 遗言（未出局，以发言状态发表）
    setPhase("day.lastwords", `第${day}天 · 遗言`);
    const inp = yield* ask({
      seat: exiled,
      kind: "lastWords",
      options: [],
      allowSkip: false,
      hint: "你被放逐了，请发表遗言",
    });
    emit("speech", exiled, "遗言", inp.speech ?? "（无言）", inp.thought);
    pub(`【遗言】${exiled}号玩家：${inp.speech ?? "（无言）"}`);

    // 发动时机①：被放逐玩家发表遗言后——持技玩家获得一次权衡
    const rLw = yield* daySkillCheck(`${exiled}号的遗言`);
    if (rLw === "aborted") {
      // 自爆打断：放逐已定局，先落出局再入夜
      yield* killPlayer(exiled, "exile", `第${cnNum(day)}日`);
      announcedDead.add(exiled);
      emit("death", exiled, "死亡公告", `${exiled}号玩家被放逐出局。`);
      return;
    }
    if (checkWin()) return;

    // 2. 放逐技能询问（权衡状态；可开枪者（猎人/狼王）才给目标选项，其余角色仅可沉默——
    //    思考量录入对局记录（非并行权衡，不进右侧权衡框）
    setPhase("day.exileSkill", `第${day}天 · 放逐技能询问`);
    const canShootHere =
      (p.role === "hunter" || p.role === "wolfKing") && !p.hasShot && !p.shootBlocked;
    pub(`【放逐】主持人询问${exiled}号玩家是否要发动技能。`);
    const inp2 = yield* ask({
      seat: exiled,
      kind: "exileSkill",
      options: canShootHere ? aliveOthers(exiled) : [],
      allowSkip: true,
      hint: canShootHere
        ? "你被放逐了：你可以发动技能开枪带走一名玩家（targets=[目标]），或保持沉默（skip=true）出局。"
        : "你被放逐了：主持人询问你是否要发动技能（此询问面向所有人，不代表你有技能）。没有可发动的技能或不想发动则保持沉默（skip=true），沉默后出局。",
    });
    emit(
      "action",
      exiled,
      "放逐权衡",
      `${exiled}号玩家被放逐，权衡是否发动技能。`,
      inp2.thought,
    );

    // 3. 发动（开枪）或沉默，然后进入出局状态
    if (canShootHere && !inp2.skip && inp2.targets?.length) {
      const t = inp2.targets[0];
      p.hasShot = true;
      p.revealed = true;
      emit("action", exiled, "开枪", `${exiled}号玩家（${roleName(p.role)}）开枪带走了${t}号玩家。`, inp2.thought);
      pub(`【开枪】${exiled}号玩家开枪带走了${t}号玩家。`);
      yield* killPlayer(t, "shoot", `第${cnNum(day)}日`);
      announcedDead.add(t);
      emit("death", t, "死亡公告", `${t}号玩家被枪带走。`);
      // 被带走者是狼王也可能开枪（连带开枪链）
      if (canShootNow(at(t))) yield* shooterChain([t]);
    } else {
      emit("action", exiled, "保持沉默", `${exiled}号玩家未发动技能。`, inp2.thought);
      pub(`【放逐】${exiled}号玩家保持沉默。`);
    }
    yield* killPlayer(exiled, "exile", `第${cnNum(day)}日`);
    announcedDead.add(exiled);
    emit("death", exiled, "死亡公告", `${exiled}号玩家被放逐出局。`);

    // 发动时机②：被放逐玩家选择是否发动技能（技能询问结果落地）后——持技玩家再获一次权衡
    const rEs = yield* daySkillCheck(`${exiled}号的技能询问`);
    if (rEs === "aborted") return; // 自爆打断，直接入夜
    if (checkWin()) return;
  }

  // ---------- 白天主流程 ----------
  function* dayPhase(): Flow {
    setPhase("day.start", `第${day}天 · 天亮`);
    pub(`—— 第${day}天 ——`);

    // 1. 公布昨夜死亡（先于警长竞选：全场先知道死讯再决定是否上警）
    announceMorning();

    // 1.5 夜亡警长的警徽流：公布夜亡之后才由阵亡警长抉择移交/撕毁
    if (deferredBadgeSeat != null) {
      const s = deferredBadgeSeat;
      deferredBadgeSeat = null;
      yield* resolveBadgePass(s);
    }

    // 2. 夜间死亡的开枪链（猎人/狼王）
    yield* shooterChain(morningDeaths.slice().sort((a, b) => a - b));
    // 3. 首夜遗言
    yield* firstNightLastWords();
    // 4. 胜负检查
    if (checkWin()) return;

    // 5. 夜亡公告后：持技玩家立即获得当天第一次权衡——
    //    这是「开局双爆吞警徽」的前提（狼队可在警长竞选前就自爆抢节奏，而不是等到发言前）
    const r0 = yield* daySkillCheck("夜亡公告");
    if (checkWin()) return;
    if (r0 === "aborted") {
      // 第1天竞选前自爆 → 警徽一并吞掉
      if (day === 1 && options.sheriffEnabled && !sheriffGone) {
        sheriffGone = true;
        emit("system", null, "警徽流失", "狼人自爆吞掉警徽，本局无警长。");
        pub("【警徽流失】狼人自爆吞掉警徽，本局无警长。");
      }
      return;
    }

    // 6. 第1天：死亡公告之后才警长竞选；警上自爆则本局无警长、直接入夜
    let skipToNight = false;
    let electionDone = false;
    if (day === 1 && options.sheriffEnabled && !sheriffGone) {
      const r = yield* sheriffElection();
      if (r === "aborted") skipToNight = true;
      else electionDone = true;
    }
    if (skipToNight) return;

    // 7. 竞选尘埃落定后（仅第1天）：持技玩家基于竞选结果（X号当选警长/警徽流失）权衡一次。
    //    第2天起「夜亡公告」与发言开始之间无新公开信息，不再重复权衡；
    //    「投票前」权衡与「夜亡公告」严重重合，亦已取消——发言过程中的实时权衡已覆盖介入需求。
    if (electionDone) {
      const obj = sheriffSeat != null ? `${sheriffSeat}号当选警长` : "警徽流失";
      const rSkill = yield* daySkillCheck(obj);
      if (checkWin()) return;
      if (rSkill === "aborted") return;
    }

    // 8. 白天发言（每段发言之后均插入一次实时权衡，见 daySpeeches）
    const r2 = yield* daySpeeches();
    if (checkWin()) return;
    if (r2 === "aborted") return;

    // 9. 放逐投票
    yield* exileVote();
  }

  // ---------- 结束 ----------
  function endGame(w: "wolf" | "good") {
    winner = w;
    setPhase("game.over", "游戏结束");
    const table = players
      .map((p) => `${p.seat}号【${roleName(p.role)}】${p.alive ? "存活" : "出局"}`)
      .join("，");
    emit("result", null, "游戏结果", `${w === "wolf" ? "狼人" : "好人"}阵营胜利！${table}`);
    pub(`【游戏结束】${w === "wolf" ? "狼人" : "好人"}阵营胜利。`);
  }

  // ---------- 赛后讨论（分出胜负后、对局正式结束前的尾声环节） ----------
  // 聊天室机制：全员（含死者）按座位顺序逐个询问、发言即时落公开记录——后发言者能在
  // publicLog 里看到之前所有人的赛后发言（含本轮），实现有来有回的讨论与点名回复；
  // 信息壁垒解除（身份全亮、全程对局记录所有人可见）。
  // 每人最多 QUOTA 次发言机会；skip=本轮弃权不消耗机会；一整轮无人发言（或全员机会用尽）→ 环节结束。
  function* postGamePhase(): Flow {
    const QUOTA = Math.max(1, Math.min(10, Math.floor(options.postGameSpeechLimit ?? 5))); // 每人最多发言机会（skip 弃权不消耗）
    const MAX_ROUNDS = QUOTA * 2; // 轮数保险丝：正常 ≤QUOTA 轮（全员每轮都说也只会说 QUOTA 轮）
    const used = new Map<number, number>(); // 座位 → 已用次数
    setPhase("postgame.discuss", "赛后讨论"); // withEvent=true：阶段提醒 + 事件标签
    emit(
      "system",
      null,
      "赛后讨论开始",
      `对局结束，全员进入赛后频道（聊天室）：身份全亮、全程对局记录所有人可见。按座位顺序轮流发言——复盘分析、抒发不满、吐槽批评皆可，还可以点名回复任何一位玩家。每人最多 ${QUOTA} 次发言机会；一整轮无人发言时环节结束。`
    );
    pub(`【赛后讨论】对局结束，聊天室开启：全员按座位顺序自由讨论（每人最多 ${QUOTA} 次发言，可点名回复）。`);
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      let anySpoke = false;
      for (const p of players) { // 含死者，全员；按座位顺序
        const left = QUOTA - (used.get(p.seat) ?? 0);
        if (left <= 0) continue;
        const nudge =
          (used.get(p.seat) ?? 0) === 0
            ? "你还没有发过言——大家都很期待听听你的想法，请积极参与讨论！"
            : "";
        const inp = (yield* ask({
          seat: p.seat,
          kind: "postgameSpeak",
          options: [0, ...players.map((x) => x.seat).filter((s) => s !== p.seat)], // 0=@所有人；其余=可点名对象（含死者，可多人）
          allowSkip: true,
          hint: `赛后讨论·聊天室（第${round}轮，你还剩 ${left} 次发言机会）：对局已结束，全员身份与全程记录公开，之前所有人的赛后发言都在公开记录的【赛后讨论】条目里。想说什么都可以——复盘分析、点评表现、抒发不满、吐槽批评；点名可 targets=[对方座位]，也可同时 @多人（targets=[3,5]）或 @所有人（targets=[0]），speech 里承接 TA 们的发言。发言填 speech（targets 留空=对大家说）；本轮确实无话可说再 skip=true（不消耗机会，后面仍可发言）。${nudge}`,
        })) as DecisionInput;
        const text = typeof inp.speech === "string" ? inp.speech.trim() : "";
        if (!text) continue; // 弃权/空发言=本轮过，不消耗机会
        used.set(p.seat, (used.get(p.seat) ?? 0) + 1);
        anySpoke = true;
        // 点名对象：单人=number / 多人=number[] / @所有人="all"；无前两者则不附 meta
        const rawTargets = (inp.targets ?? []).filter((t) => t !== p.seat);
        const hasAll = rawTargets.includes(0);
        const many = rawTargets.filter((t) => t !== 0);
        const addressTo = hasAll ? ("all" as const) : many.length === 1 ? many[0]! : many.length > 1 ? many : null;
        emit("speech", p.seat, "赛后讨论", text, inp.thought ?? null, {
          round,
          remain: QUOTA - (used.get(p.seat) ?? 0),
          ...(addressTo != null ? { addressTo } : {}),
        });
        const toText = hasAll ? "所有人" : many.map((t) => `${t}号`).join("、");
        pub(toText ? `【赛后讨论】${p.seat}号 → ${toText}：${text}` : `【赛后讨论】${p.seat}号：${text}`);
      }
      if (!anySpoke) break; // 一整轮无人发言 → 结束
    }
    emit(
      "system",
      null,
      "赛后讨论结束",
      "所有玩家的发言机会已用尽或无人再发言，赛后讨论环节结束。"
    );
    pub("【赛后讨论结束】");
  }

  // ---------- 主流程 ----------
  function* mainFlow(): Flow {
    setPhase("game.start", "游戏开始");
    emit(
      "system",
      null,
      "游戏开始",
      `版型【${board?.name ?? boardId}】，${n}名玩家就位。${options.sheriffEnabled ? "有警长。" : "无警长。"}屠边规则。${
        options.postGameDiscuss
          ? "本局已开启赛后讨论环节：对局结束后全员身份公开，进入赛后频道自由讨论（想说什么都可以）。"
          : ""
      }`
    );
    pub(`游戏开始：${n}名玩家。${options.postGameDiscuss ? "本局已开启赛后讨论环节。" : ""}`);
    while (true) {
      day++;
      yield* nightPhase();
      let w = checkWin();
      if (w) {
        // 终局清晨同样先亮「天亮」阶段提醒：此前只有 dayPhase 路径发 day.start，
        // 夜后定局直接 announceMorning 导致事件流缺「第N天·天亮」（日夜交界显示不完整）
        setPhase("day.start", `第${day}天 · 天亮`);
        pub(`—— 第${day}天 ——`);
        announceMorning();
        endGame(w);
        if (options.postGameDiscuss) yield* postGamePhase();
        return;
      }
      yield* dayPhase();
      w = checkWin();
      if (w) {
        endGame(w);
        if (options.postGameDiscuss) yield* postGamePhase();
        return;
      }
      if (day > 100) {
        // 保险丝（正常对局不会到达）
        const wolves = players.filter((p) => p.alive && campOf(p.role) === "wolf").length;
        const goods = players.filter((p) => p.alive && campOf(p.role) !== "wolf").length;
        endGame(wolves >= goods ? "wolf" : "good");
        if (options.postGameDiscuss) yield* postGamePhase();
        return;
      }
    }
  }

  const gen = mainFlow();

  // ---------- 引擎实例 ----------
  const engine: Engine = {
    getSnapshot() {
      return {
        day,
        phase,
        phaseLabel,
        winner,
        finished,
        pendingSeat: awaiting ? (isBatchReq(awaiting) ? (awaiting.batchOf[0]?.seat ?? null) : awaiting.seat) : null,
        pendingKind: awaiting ? (isBatchReq(awaiting) ? (awaiting.batchOf[0]?.kind ?? null) : awaiting.kind) : null,
        pendingSeats: awaiting ? (isBatchReq(awaiting) ? awaiting.batchOf.map((r) => r.seat) : [awaiting.seat]) : [],
        pendingActs: awaiting
          ? (isBatchReq(awaiting)
              ? awaiting.batchOf.map((r) => ({ seat: r.seat, kind: r.kind as string }))
              : [{ seat: awaiting.seat, kind: awaiting.kind as string }])
          : [],
        players: players.map((p) => {
          // 技能存量（上帝视角权威事实）：分析师胜率评估据此，杜绝凭印象编造「女巫还有解药」
          const stock: string[] = [];
          if (p.role === "witch") {
            stock.push(`解药${p.witchSave ? "可用" : "已用"}`);
            stock.push(`毒药${p.witchPoison ? "可用" : "已用"}`);
          }
          if (p.role === "hunter" || p.role === "wolfKing") {
            stock.push(`开枪${p.hasShot ? "已用" : "可用"}`);
          }
          if (p.role === "knight") {
            stock.push(`决斗${duelUsed ? "已用" : "可用"}`);
          }
          // 查验/狩猎记录摘要：各类各取最近 6 条
          const checks: string[] = [];
          for (const c of p.seerChecks.slice(-6)) checks.push(`查验${c.seat}号=${c.result === "wolf" ? "狼人" : "好人"}`);
          for (const c of p.psychicChecks.slice(-6)) checks.push(`查验${c.seat}号=${c.result}`);
          for (const c of p.gargoyleChecks.slice(-6)) checks.push(`查验${c.seat}号=${c.result}`);
          for (const c of p.gravekeeperReveals.slice(-6)) checks.push(`守墓${c.seat}号=${c.wasWolf ? "狼人" : "好人"}`);
          for (const c of p.demonHunterResults.slice(-6))
            checks.push(`狩猎${c.seat}号=${c.died === "target" ? "中狼" : c.died === "self" ? "中好人自毙" : "空猎"}`);
          return {
            seat: p.seat,
            role: p.role,
            camp: campOf(p.role),
            alive: p.alive,
            sheriff: p.sheriff,
            // 上警「竞选中」灰警徽标识：警长落地或警徽流失后即不再透出
            sheriffCand: sheriffCandidates.includes(p.seat) && sheriffSeat == null && !sheriffGone,
            deathInfo: p.deathInfo,
            stock,
            checks,
          };
        }),
      };
    },

    advance() {
      if (finished) return { events: drain(), pending: null };
      if (awaiting) return { events: [], pending: buildPendingAny(awaiting) };
      // 外部结算后的驱动切换：主流程已封存，开启赛后讨论则新建赛后协程驱动尾声环节
      //（与自然终局 mainFlow 内 yield* postGamePhase() 完全同权——同一套聊天室机制与待决形态）
      let driver = postgameGen ?? gen;
      if (mainAbandoned && !postgameGen) {
        if (!options.postGameDiscuss) {
          finished = true;
          return { events: drain(), pending: null };
        }
        postgameGen = postGamePhase();
        driver = postgameGen;
      }
      const r = driver.next();
      if (r.done) {
        finished = true;
        return { events: drain(), pending: null };
      }
      awaiting = r.value;
      return { events: drain(), pending: buildPendingAny(awaiting) };
    },

    // 外部结算（引擎外房规裁决落定终局）：封存主流程协程与在飞待决，落定胜者并产出
    // 与 endGame 同格式的结果事件；postGameDiscuss 开启时 finished 暂缓到赛后协程跑完
    //（advance 驱动切换见上），与自然终局的「endGame → postGamePhase → finished」同语义。
    settleExternal(w: "wolf" | "good", note?: string, pubLine?: string): EngineEvent[] {
      winner = w;
      awaiting = null; // 在飞待决封存（主流程协程不再恢复）
      mainAbandoned = true;
      setPhase("game.over", "游戏结束");
      const table = players
        .map((p) => `${p.seat}号【${roleName(p.role)}】${p.alive ? "存活" : "出局"}`)
        .join("，");
      // 裁决缘由先入公开记录（玩家可见——赛后复盘的认知依据），再出胜负公告
      if (pubLine) pub(pubLine);
      else if (note) pub(`【终局裁决】${note}`);
      emit("result", null, "游戏结果", `${w === "wolf" ? "狼人" : "好人"}阵营胜利！${note ?? ""}${table}`);
      pub(`【游戏结束】${w === "wolf" ? "狼人" : "好人"}阵营胜利。`);
      if (!options.postGameDiscuss) finished = true;
      return drain();
    },

    decide(input: DecisionInput) {
      if (!awaiting) throw new Error("当前没有待决的决策");
      const req = awaiting;
      // 活跃协程路由：外部结算后主流程封存，赛后讨论决策喂给赛后协程
      const driver = postgameGen ?? gen;
      if (isBatchReq(req)) {
        // 批量待决：逐个子请求校验对应子决策（非法即抛错，状态不变，可重试）
        const inputs = input.batchInputs ?? [];
        if (inputs.length !== req.batchOf.length)
          throw new Error(`并行权衡决策数量不匹配：期望 ${req.batchOf.length}，实际 ${inputs.length}`);
        for (let i = 0; i < req.batchOf.length; i++) {
          validate(req.batchOf[i], inputs[i]);
          const sp = at(req.batchOf[i].seat);
          sp.fearedNotice = false;
          sp.bloodMoonNotice = false;
        }
        awaiting = null; // 校验通过后才清除待决（校验失败保留可重试）
        const r = driver.next(inputs);
        if (r.done) {
          finished = true;
        } else {
          awaiting = r.value;
        }
        return drain();
      }
      validate(req, input); // 非法即抛错，状态不变，可重试
      awaiting = null; // 校验通过后才清除待决
      const p = at(req.seat);
      p.fearedNotice = false;
      p.bloodMoonNotice = false;
      const r = driver.next(input);
      if (r.done) {
        finished = true;
      } else {
        awaiting = r.value;
      }
      return drain();
    },

    isFinished() {
      return finished;
    },
  };

  return engine;
};
