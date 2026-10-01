// ============================================================
// 狼人杀引擎公开接口（子代理A实现，子代理B消费）
// 引擎是纯状态机：不依赖数据库、不依赖网络、不做任何 AI HTTP 调用。
// 信息壁垒的铁律：PendingDecision.view 返回的数据 = 该玩家【被允许知道】的全部信息，
// 服务层只能用它组装 prompt，绝不允许把引擎内部状态喂给 AI。
// ============================================================

import type { RoleId, Camp, AdvancedOptions } from "../../../contracts/game";

// ---------- 引擎事件（由引擎产出，服务层赋 seq 并持久化） ----------
export interface EngineEvent {
  day: number;
  phase: string;          // 阶段 id，如 "night.wolf" / "day.speech"
  type: "system" | "phase" | "speech" | "action" | "vote" | "death" | "result";
  actor: number | null;   // 座位号
  title: string;          // "公开发言" | "夜间行动" | "投票结果" | "死亡公告" ...
  content: string;        // 观察者可见的完整描述
  thought: string | null; // 心理活动（来自 AI 决策，仅观察者可见）
  meta: Record<string, unknown> | null;
}

// ---------- 玩家视角（信息壁垒出口，只含该玩家可见信息） ----------
export interface PlayerView {
  seat: number;
  role: RoleId;
  roleName: string;
  camp: Camp;
  day: number;
  phase: string;
  aliveSeats: number[];           // 存活座位
  deadSeats: number[];            // 已死亡座位（不知道身份，除非翻牌）
  revealedRoles: Record<number, RoleId>; // 已公开翻牌的身份（白痴翻牌、骑士翻牌、自爆狼等）
  sheriffSeat: number | null;
  selfAlive: boolean;
  rules?: { witchSelfSave: "firstNight" | "never"; postGameDiscuss?: boolean }; // 本局公开规则（引擎填充后必有；可选仅为兼容手写测试夹具）
  // 公开历史：发言与投票记录（所有玩家都能看到的东西）
  publicLog: string[];            // 按时间排序的公开事件文本（发言全文、投票明细、死亡公告）
  // 私密信息（因角色而异；不包含其他玩家身份！）
  private: {
    wolfTeammates?: number[];     // 狼队队友座位（石像鬼/隐狼不见面，不在其中）
    wolfChat?: string[];          // 狼人频道夜间讨论记录（仅见面狼队可见，按时间序，形如 "3号：先刀5号"）
    seerChecks?: { seat: number; result: "good" | "wolf" }[];
    psychicChecks?: { seat: number; result: string }[];   // 具体身份名
    gargoyleChecks?: { seat: number; result: string }[];
    witchPotions?: { save: boolean; poison: boolean };    // 剩余药
    witchVictimTonight?: number | null;                    // 今夜被刀者（仅女巫行动时给）
    guardHistory?: number[];                               // 守护历史
    dreamerHistory?: number[];                             // 摄梦历史
    nightmareHistory?: number[];
    crowHistory?: number[];
    gravekeeperReveals?: { seat: number; wasWolf: boolean }[];
    demonHunterResults?: { seat: number; died: "target" | "self" | "none" }[];
    lastNightDeaths?: number[];    // 今晨公布的死者（公开信息）
    fearedTonight?: boolean;       // 被噩梦之影恐惧（仅当被恐惧的神行动时）
    bloodMoonSealed?: boolean;     // 血月封印中
  };
}

// ---------- 待决决策（引擎需要什么，服务层就去问 AI） ----------
export type DecisionKind =
  | "nightmareFear"      // 噩梦之影恐惧 → targets[0]
  | "wolfThink"          // 狼人夜间独立思考（频道讨论之前）→ 仅需 thought，speech 留空
  | "wolfDiscuss"        // 狼人频道夜间讨论 → speech（内容仅狼队可见，不进公开记录）
  | "wolfKill"           // 狼人刀人（每个见面的狼各投一次刀口票，引擎取多数票）→ targets[0]
  | "gargoyleCheck"      // 石像鬼验人 → targets[0]
  | "guardProtect"       // 守卫守护 → targets[0] 或 skip
  | "dreamerDream"       // 摄梦人摄梦 → targets[0]
  | "witchAction"        // 女巫 → targets[0] 毒杀对象；meta 里表达是否用解药
  | "seerCheck"          // 预言家验人 → targets[0]
  | "psychicCheck"       // 通灵师验人 → targets[0]
  | "mechWolfMimic"      // 机械狼模仿 → targets[0] 或 skip
  | "demonHunterHunt"    // 猎魔人狩猎 → targets[0] 或 skip
  | "crowCurse"          // 乌鸦诽谤 → targets[0] 或 skip
  | "sheriffRun"         // 是否上警 → targets=[1]参与 [0]不参与
  | "sheriffSpeech"      // 警上发言 → speech
  | "sheriffWithdraw"    // 退水（警上发言结束后）→ targets=[1]退水（转为警下投票） [0]继续竞选
  | "sheriffVote"        // 警徽投票 → targets[0]
  | "sheriffOrder"       // 警长选择发言顺序 → targets=[1]升序 [0]降序（从警长下一位开始，警长最后发言）
  | "daySkill"           // 白天主动技能实时权衡（夜亡公告/警长当选/每段发言之后）→ 骑士 duel=目标 / 狼 selfDestruct=true / skip 按兵不动
  | "daySpeech"          // 白天发言 → speech（狼可 selfDestruct，骑士可 duel）
  | "dayVote"            // 放逐投票 → targets[0]
  | "pkSpeech"           // 平票PK发言 → speech
  | "lastWords"          // 遗言 → speech
  | "exileSkill"         // 放逐技能询问（全角色都问以隐藏身份）→ 有技能 targets[0] 发动 / skip 沉默出局
  | "badgePass"          // 警徽流抉择（警长阵亡时）→ targets[0] 移交警徽接任 / skip 撕毁流失
  | "hunterShoot"        // 猎人/狼王开枪 → targets[0] 或 skip
  | "whiteWolfTake"      // 白狼王自爆带人 → targets[0]
  | "postgameSpeak";     // 赛后讨论发言 → speech；skip=本轮弃权不消耗机会（不属 SPEECH_REQUIRED_KINDS：skip 合法）

// 发言类决策（需要非空 speech）——引擎校验与服务层兜底共用同一事实源，
// 严禁在别处另建同名列表（历史事故：服务层漏掉 wolfDiscuss → 兜底无 speech → 对局崩溃）
export const SPEECH_REQUIRED_KINDS: ReadonlySet<DecisionKind> = new Set([
  "sheriffSpeech",
  "daySpeech",
  "pkSpeech",
  "lastWords",
  "wolfDiscuss", // 狼人频道队内发言，speech 必填（内容仅狼队可见）
]);

export interface PendingDecision {
  seat: number;            // 需要谁决策
  role: RoleId;            // 其角色
  kind: DecisionKind;
  options: number[];       // 合法目标座位（空数组表示任意存活者）
  allowSkip: boolean;
  view: PlayerView;        // 该玩家视角（已含信息壁垒）
  hint: string;            // 给 prompt 组装者的中文任务说明，如 "请选择今晚要袭击的目标"
  batch?: PendingDecision[]; // 同轮并行权衡（daySkill）：全部持技玩家的待决打包，
                             // 服务层并发询问、一次性回传 batchInputs，墙钟≈单次调用
}

// ---------- AI 决策回传 ----------
export interface DecisionInput {
  thought: string;          // 心理活动（观察者可见，不进其他玩家 prompt）
  speech?: string;          // 公开发言（发言类决策必填）
  targets?: number[];       // 目标座位
  skip?: boolean;           // 放弃技能
  selfDestruct?: boolean;   // 狼人自爆（daySpeech/pkSpeech/sheriffSpeech/daySkill 时可用）
  surrender?: boolean;      // 白日交刀·认输（daySkill 时可用：狼队认输，神民立即获胜）
  declareVictory?: boolean; // 白日交刀·宣布胜利（daySkill 时可用：狼队必胜时提前终局，狼队立即获胜；误判则白给）
  duel?: number | null;     // 骑士决斗目标（daySpeech/daySkill 时可用）
  witchSave?: boolean;      // 女巫是否用解药（witchAction 时可用）
  batchInputs?: DecisionInput[]; // 与 PendingDecision.batch 一一对应的各玩家决策
}

// ---------- 引擎实例 ----------
export interface Engine {
  getSnapshot(): {
    day: number;
    phase: string;
    phaseLabel: string;
    winner: "wolf" | "good" | null;
    finished: boolean;
    pendingSeat: number | null;
    pendingKind: string | null;
    pendingSeats: number[];
    /** 当前待决按座位展开（并行批次中每个座位的类型可能不同，如权衡+发言合并批次） */
    pendingActs: { seat: number; kind: string }[];
    players: {
      seat: number; role: RoleId; camp: Camp; alive: boolean; sheriff: boolean;
      /** 上警竞选中（≥2 名候选人时才标记；警长落地/警徽流失后为 false）——前端灰色警徽 */
      sheriffCand: boolean;
      deathInfo: string | null;
      /** 技能存量（上帝视角权威事实，如「解药可用」「开枪已用」；无技能角色为空数组） */
      stock: string[];
      /** 查验/狩猎记录摘要（各类各取最近 6 条；无记录角色为空数组） */
      checks: string[];
    }[];
  };
  // 推进自动流程直到需要 AI 决策；返回产出的事件与待决项
  advance(): { events: EngineEvent[]; pending: PendingDecision | null };
  // 应用 AI 决策（随后再调 advance 继续）
  decide(input: DecisionInput): EngineEvent[];
  isFinished(): boolean;
}

// 创建引擎实例（角色随机分配到座位后传入，保证可复现性）
// 实际实现由子代理A在 ./index.ts 提供，本文件只声明类型。
export type CreateEngine = (opts: {
  boardId: string;
  seatRoles: RoleId[];      // seatRoles[i] = 座位 i+1 的角色
  options: AdvancedOptions;
}) => Engine;
