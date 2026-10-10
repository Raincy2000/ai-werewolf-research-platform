// ============================================================
// AI狼人杀 — 前后端共享契约（唯一事实源）
// 前端页面、后端引擎、AI服务层都以此文件为准
// ============================================================

import type { PersonaSeatBinding } from "./persona";

// ---------- AI 接入 ----------
export type AiProvider = "kimi" | "openai" | "deepseek" | "custom" | "anthropic";

export interface SeatAiConfig {
  seat: number;          // 1-based 座位号
  provider: AiProvider;
  baseUrl: string;       // OpenAI 兼容端点或 anthropic 端点
  model: string;
  apiKey: string;        // 仅存内存，绝不落盘
}

export interface AdvancedOptions {
  stepDelayMs: number;        // 每步间隔（前端默认 500，提速研究节奏）
  phaseBreakMs?: number;      // 日夜交界停歇（前端默认 2000；一个夜/日的互动轮次结束、进入下一日/夜前的阅读缓冲）
  sheriffEnabled: boolean;    // 是否开启警长竞选（12人版型默认 true）
  allowSelfDestruct: boolean; // 允许狼人自爆（默认 true）
  allowSurrender?: boolean;   // 允许白日交刀（默认 true；false 则狼人权衡中不提供交刀选项）
  speechRoundsLimit: number;  // 白天发言轮数上限（默认 2）
  postGameDiscuss?: boolean;  // 赛后讨论环节开关（引擎默认关：不传=关闭；前端 UI 默认开）
  postGameAutoStart?: boolean; // 赛后自动开始讨论（默认 false=分出胜负后挂起，等用户手动开启；true=径直生成）
  postGameSpeechLimit?: number; // 每玩家赛后最多发言机会（默认 5，1-10；skip 弃权不消耗）
  aiTimeLimitSec?: number;    // AI 单决策总时限（秒，下限 120；0/缺省=不限制——单次调用 90s 超时仍生效；DeepSeek 思考模式自动放宽至 260s 下限，思考链耗时长，过紧只会批量超时托管）
  libraryEnabled?: boolean;   // 赛前图书馆学习（开局前各座位 AI 先自主学习图书馆资料形成心得，学完才开赛）
  libraryMaxSec?: number;     // 单个座位最长学习时间（秒，默认 120，不设下限；超时该座位按未学习开赛）
  // 玩家人格可见度（人格圈层的信息壁垒；仅有人格卡座位的玩家可获得圈层知晓，普通 AI 不受影响）：
  //   full=完全可见：有人格的玩家知道所有其他有人格玩家的人格姓名（仅姓名，详细人格不透露），
  //        无人格玩家对其而言是迷雾；
  //   partial=部分可见：personaFogSeats 勾选的人格玩家被上迷雾（对其他人格玩家隐匿姓名；
  //        被上迷雾者自己知道自己在雾里），未上迷雾的人格玩家姓名可见；
  //   none=不可见：所有玩家对有人格的玩家而言都是迷雾（可观察言行自行推测）。
  personaVisibility?: "full" | "partial" | "none"; // 默认 full
  personaFogSeats?: number[]; // partial 档：被上迷雾的座位号（仅对已绑人格卡的座位生效）
}

export const PROVIDER_PRESETS: Record<AiProvider, { label: string; baseUrl: string; model: string }> = {
  kimi:      { label: "Kimi (Moonshot)", baseUrl: "https://api.moonshot.cn/v1", model: "moonshot-v1-8k" },
  openai:    { label: "OpenAI",          baseUrl: "https://api.openai.com/v1",  model: "gpt-4o-mini" },
  deepseek:  { label: "DeepSeek",        baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  custom:    { label: "自定义(OpenAI兼容)", baseUrl: "",                          model: "" },
  anthropic: { label: "Claude (Anthropic)", baseUrl: "https://api.anthropic.com", model: "claude-sonnet-4-5" },
};

// ---------- 角色 ----------
export type RoleId =
  | "villager"
  | "werewolf" | "wolfKing" | "whiteWolfKing" | "gargoyle" | "nightmare" | "bloodMoon" | "hiddenWolf" | "mechWolf"
  | "seer" | "psychic" | "witch" | "hunter" | "guard" | "idiot" | "knight" | "dreamer" | "gravekeeper" | "demonHunter" | "crow";

export type Camp = "wolf" | "god" | "villager";

export const ROLE_META: Record<RoleId, { name: string; camp: Camp; description: string }> = {
  villager:      { name: "平民",     camp: "villager", description: "无技能，白天参与发言与投票" },
  werewolf:      { name: "狼人",     camp: "wolf",     description: "每晚与狼队共刀一人，白天可自爆" },
  wolfKing:      { name: "狼王",     camp: "wolf",     description: "死亡时可开枪带走一人（被毒/被摄梦死不能开枪）" },
  whiteWolfKing: { name: "白狼王",   camp: "wolf",     description: "白天自爆时可带走一人（被毒后自爆不能带人）" },
  gargoyle:      { name: "石像鬼",   camp: "wolf",     description: "不与狼队见面，每晚验一人具体身份；其余狼死完后带刀" },
  nightmare:     { name: "噩梦之影", camp: "wolf",     description: "每晚最先恐惧一人：神则当夜技能封锁，狼则狼队当夜不能刀" },
  bloodMoon:     { name: "血月使徒", camp: "wolf",     description: "自爆后次夜封印所有神职技能；最后一狼被放逐则放逐无效，次夜结束时死亡" },
  hiddenWolf:    { name: "隐狼",     camp: "wolf",     description: "不与狼队见面，被查验显示为好人；其余狼死完后带刀" },
  mechWolf:      { name: "机械狼",   camp: "wolf",     description: "每晚可模仿一人，被查验时显示为模仿的身份；其余狼死完后带刀" },
  seer:          { name: "预言家",   camp: "god",      description: "每晚查验一人是好人还是狼人" },
  psychic:       { name: "通灵师",   camp: "god",      description: "每晚查验一人的具体身份" },
  witch:         { name: "女巫",     camp: "god",      description: "解药毒药各一瓶，同一晚只能用一瓶" },
  hunter:        { name: "猎人",     camp: "god",      description: "死亡时可开枪带走一人（被毒/被摄梦死不能开枪）" },
  guard:         { name: "守卫",     camp: "god",      description: "每晚守一人（可自守），不能连守同一人；同守同救则奶穿" },
  idiot:         { name: "白痴",     camp: "god",      description: "被放逐时翻牌免死，之后可发言不可投票也不可被投票" },
  knight:        { name: "骑士",     camp: "god",      description: "白天发言可翻牌决斗：对方狼则其死并入夜，对方好人则骑士死。一局一次" },
  dreamer:       { name: "摄梦人",   camp: "god",      description: "每晚摄梦一人：当夜免疫狼刀；摄梦人死其同死；连续两晚被摄则死" },
  gravekeeper:   { name: "守墓人",   camp: "god",      description: "每晚得知上一白天被放逐者是否为狼人" },
  demonHunter:   { name: "猎魔人",   camp: "god",      description: "第二晚起每晚可狩猎：中狼则狼死，中好人则自死；免疫毒药" },
  crow:          { name: "乌鸦",     camp: "god",      description: "每晚诽谤一人，次日白天其被投票时额外计一票" },
};

// ---------- 版型 ----------
export interface BoardDef {
  id: string;
  name: string;
  playerCount: number;
  sheriff: boolean;            // 是否默认有警长
  roles: RoleId[];             // 长度 = playerCount，顺序无关（开局随机分配到座位）
  witchSelfSave: "firstNight" | "never";
  summary: string;             // 阵容摘要，大厅页展示
}

export const BOARDS: BoardDef[] = [
  { id: "standard9", name: "9人标准局（暗牌）", playerCount: 9, sheriff: false,
    roles: ["seer","witch","hunter","villager","villager","villager","werewolf","werewolf","werewolf"],
    witchSelfSave: "firstNight", summary: "经典入门版型，暗牌小局节奏明快，适合快速实验与基线对照" },
  { id: "standard12", name: "12人标准场（预女猎白）", playerCount: 12, sheriff: true,
    roles: ["seer","witch","hunter","idiot","villager","villager","villager","villager","werewolf","werewolf","werewolf","werewolf"],
    witchSelfSave: "never", summary: "屠边规则经典竞技版型；白痴被放逐可翻牌免死，代价是失去投票权" },
  { id: "wolfKingGuard12", name: "12人狼王守卫", playerCount: 12, sheriff: true,
    roles: ["seer","witch","hunter","guard","villager","villager","villager","villager","werewolf","werewolf","werewolf","wolfKing"],
    witchSelfSave: "never", summary: "狼王出局可开枪带走一人，守卫的夜间守护与狼队刀法深度博弈" },
  { id: "whiteWolfGuard12", name: "12人白狼王守卫", playerCount: 12, sheriff: true,
    roles: ["seer","witch","hunter","guard","villager","villager","villager","villager","werewolf","werewolf","werewolf","whiteWolfKing"],
    witchSelfSave: "never", summary: "白狼王白昼自爆带走一人，双爆吞警徽，攻防节奏更凶悍" },
  { id: "whiteWolfKnight12", name: "12人白狼王骑士", playerCount: 12, sheriff: true,
    roles: ["seer","witch","knight","guard","villager","villager","villager","villager","werewolf","werewolf","werewolf","whiteWolfKing"],
    witchSelfSave: "never", summary: "骑士白昼亮剑决斗：戳中狼人直接处决，戳错则以死谢罪" },
  { id: "gargoyleGrave12", name: "12人石像鬼守墓人", playerCount: 12, sheriff: true,
    roles: ["seer","witch","hunter","gravekeeper","villager","villager","villager","villager","werewolf","werewolf","werewolf","gargoyle"],
    witchSelfSave: "never", summary: "石像鬼与狼队互不见面、夜间可查验身份；守墓人查验死者阵营" },
  { id: "bloodMoonHunter12", name: "12人血月使徒猎魔人", playerCount: 12, sheriff: true,
    roles: ["seer","witch","demonHunter","idiot","villager","villager","villager","villager","werewolf","werewolf","werewolf","bloodMoon"],
    witchSelfSave: "never", summary: "血月使徒自爆封印全场神职技能；猎魔人夜间狩猎，猎错则反噬" },
  { id: "wolfKingDreamer12", name: "12人狼王摄梦人", playerCount: 12, sheriff: true,
    roles: ["seer","witch","hunter","dreamer","villager","villager","villager","villager","werewolf","werewolf","werewolf","wolfKing"],
    witchSelfSave: "never", summary: "摄梦人每晚摄梦庇护一人，被连续两夜摄梦者将在梦中出局" },
  { id: "nightmareGuard12", name: "12人噩梦之影", playerCount: 12, sheriff: true,
    roles: ["seer","witch","hunter","guard","villager","villager","villager","villager","werewolf","werewolf","werewolf","nightmare"],
    witchSelfSave: "never", summary: "噩梦之影每夜封锁一名玩家技能，神职随时可能哑火" },
  { id: "psychicMech12", name: "12人通灵师机械狼", playerCount: 12, sheriff: true,
    roles: ["psychic","witch","hunter","guard","villager","villager","villager","villager","werewolf","werewolf","werewolf","mechWolf"],
    witchSelfSave: "never", summary: "通灵师直接验出具体身份；机械狼可模仿任一神职技能，真假难辨" },
  { id: "hiddenCrow12", name: "12人隐狼乌鸦", playerCount: 12, sheriff: true,
    roles: ["seer","witch","hunter","crow","villager","villager","villager","villager","werewolf","werewolf","werewolf","hiddenWolf"],
    witchSelfSave: "never", summary: "隐狼被验为好人且与狼队不见面；乌鸦夜间诅咒扰乱白天票型" },
];

// ---------- 对局状态快照（上帝视角） ----------
export type GameStatus = "created" | "running" | "paused" | "finished";

export interface PlayerSnapshot {
  seat: number;
  role: RoleId;
  roleName: string;
  camp: Camp;
  alive: boolean;
  sheriff: boolean;
  sheriffCandidate?: boolean; // 上警竞选中（灰色警徽标识；警长落地/警徽流失后消失）
  deathInfo: string | null;   // 死因描述，如 "第2夜被刀"
  aiModel: string;            // 该座位的模型名（研究展示用）
  personaName?: string | null; // 人格研究库：该座位绑定的人格名（未绑定为 null/缺省）
}

export interface GameSnapshot {
  gameId: string;
  boardId: string;
  boardName: string;
  titleNo: string;            // 对局标题号（如 20260811001；旧数据可能为 ""）
  status: GameStatus;
  day: number;
  phase: string;              // 引擎内部阶段 id
  phaseLabel: string;         // 中文阶段名，如 "第2夜 · 狼人行动"
  players: PlayerSnapshot[];
  winner: "wolf" | "good" | null;
  seq: number;                // 当前事件序号（增量轮询游标）
  pendingSeat: number | null; // 正在行动/发言的座位（批量待决时为首个座位）
  pendingKind: string | null; // 当前待决类型（批量待决时为子类型，如 daySkill/dayVote）
  pendingSeats: number[];     // 当前待决覆盖的全部座位（批量=多人同时行动）
  pendingActs: { seat: number; kind: string }[]; // 当前待决按座位展开（合并批次中类型可不同）
  // 停歇类型：none=无停歇；nightToDay=夜→日交替停歇；dayToNight=日→夜交替停歇；thinkBeat=独立思考阅读节拍
  //（对局记录黄灯=日夜交替停歇；发动权衡黄灯=仅日→夜停歇；其余时间不亮黄灯）
  phaseBreaking: "none" | "nightToDay" | "dayToNight" | "thinkBeat";
  phaseBreakTotalMs: number;      // 当前停歇总时长（毫秒，无停歇为 0）
  phaseBreakStartedAt: number;    // 当前停歇起始时刻（epoch ms，无停歇为 0；倒计时文字框据此计算）
  speechRoundsLimit: number;
  /** 赛前学习中的座位（祖母绿「学习中」状态环；仅图书馆对局的学习阶段非空） */
  studyingSeats?: number[];
  createdAt: string;
}

// ---------- 事件日志 ----------
export type EventType = "system" | "phase" | "speech" | "action" | "vote" | "death" | "result";

export interface GameEvent {
  seq: number;
  day: number;
  phase: string;
  type: EventType;
  actor: number | null;       // 座位号；系统事件为 null
  actorLabel: string | null;  // 如 "3号玩家"
  title: string;              // 简短标题，如 "公开发言" / "夜间行动" / "投票"
  content: string;            // 正文
  thought: string | null;     // 心理活动（仅观察者可见，绝不喂给其他玩家）
  meta: Record<string, unknown> | null;
  createdAt: string;
}

// ---------- 分析师与经验指南 ----------
export interface AnalystAiConfig {
  provider: AiProvider;
  baseUrl: string;
  model: string;
  apiKey: string;
  /** 对局结束后是否自动生成分析报告（false = 仅手动生成；缺省 true 兼容旧配置） */
  autoGenerate?: boolean;
}

export interface GuideInfo {
  version: number;        // 0 = 暂无指南
  content: string;        // 指南全文（markdown 风格文本）
  updatedAt: string | null;
  entryCount: number;     // 已蒸馏的对局篇数
}

// 指南作用域："common" = 共通内容（通用于所有版型）；其余值为版型 id（仅适用该版型）
export type GuideScope = "common" | string;

export interface GuideBoardEntry {
  boardId: string;
  boardName: string;
  guide: GuideInfo;       // 该版型的特定内容指南
}

// 指南总览：共通内容 + 各版型特定内容
export interface GuideOverview {
  common: GuideInfo;
  boards: GuideBoardEntry[];   // 仅包含有特定内容（version>0）的版型
}

export interface GuideVersionSummary {
  version: number;
  gameId: string | null;  // 本版指南由哪局分析蒸馏而来
  note: string;           // 版本说明（如 "收录第3局：9人标准局 狼人胜"）
  createdAt: string;
}

export interface AnalysisReport {
  gameId: string;
  report: string;         // 分析报告全文（心理学+博弈论）
  model: string;          // 分析师所用模型
  createdAt: string;
}

export type AnalysisJobStatus = "idle" | "running" | "done" | "failed";

// 分析任务当前阶段：analyze=撰写复盘报告 / distill=沉淀经验指南；done/idle/failed 时为 null
export type AnalysisJobStage = "analyze" | "distill" | null;

// ---------- 分析师胜率推测（对局中实时评估双方胜率） ----------
export interface WinRateEntry {
  id: number;          // 入库自增 id（前端增量轮询游标）
  day: number;
  phase: string;       // 评估时刻的引擎阶段 id
  goodPct: number;     // 神民阵营胜率（0-100）
  wolfPct: number;     // 狼人阵营胜率（0-100，恒等于 100 - goodPct）
  reasons: string[];   // 本次评估给出的胜率变动理由与依据（≤6 条）
  /** 触发本次评估的事件锚点（如「4号狼人独立思考」；旧数据无此列为 null，前端回退阶段名） */
  triggerLabel?: string | null;
  createdAt: string;
}

// ---------- tRPC 输入/输出 ----------
export interface CreateGameInput {
  boardId: string;
  seats: SeatAiConfig[];
  options: AdvancedOptions;
  analystAi?: AnalystAiConfig | null;  // autoGenerate!==false 时终局自动生成分析报告并蒸馏入指南；false 时仅观察室手动生成
  winRateEnabled?: boolean;            // 胜率推测：对局中实时评估神民/狼人胜率并记录理由（随 setup 落库，重启恢复后仍生效）
  seatPersonas?: PersonaSeatBinding[]; // 人格研究库：座位人格绑定（绑定的座位以该人格参赛；随 setup 落库供断点恢复）
}

export interface PollResult {
  /** 304 式快路径：tickKey 与客户端一致且无新事件时为 true，此时不返回 snapshot/tickKey 冗余数据 */
  unchanged: boolean;
  /** 服务端 tickKey（客户端下次轮询携带 lastSig 以命中快路径） */
  tickKey?: string;
  /** unchanged=true 快路径时缺省（客户端本就不读）；否则为最新快照（无 runtime 的行快照亦可为 null） */
  snapshot?: GameSnapshot | null;
  events: GameEvent[];   // seq > afterSeq 的增量事件
  /** 胜率推测（仅本局开启时返回）：最新胜率 + id > afterWinRateId 的增量评估记录；无记录时 50/50 空列表 */
  winRate?: { goodPct: number; wolfPct: number; entries: WinRateEntry[] };
  /** 补开赛后讨论资格：已结束、分了胜负、尚无赛后内容的对局为 true（前端据此显示「开启赛后讨论」按钮） */
  postGameEligible?: boolean;
  /** 心理检查进度（有人格座位且已分出胜负的对局返回）：逐座位 pending=未检查/running=检查中/done=已生成
   *  （心理检查为主动开启环节——按钮点击启动，中断后可续跑：已完成座位不重跑） */
  psyCheck?: { seats: { seat: number; status: "pending" | "running" | "done" }[] } | null;
  /** 赛前学习进度（仅本局开启图书馆时返回）：done 完成数 / total 总数 / studying 学习中 / inFlight 正在学习的座位 */
  study?: { done: number; total: number; studying: boolean; inFlight?: number[] };
}

export interface GameSummary {
  id: string;
  boardName: string;
  titleNo: string;          // 对局标题号：YYYYMMDD+当日序号3位（如 20260811001；旧数据回填，兜底为 ""）
  status: GameStatus;
  winner: "wolf" | "good" | null;
  dayCount: number;
  createdAt: string;
  playerCount: number;
}

/** 对局标题号生成器：本地日期 YYYYMMDD + 当日序号 3 位（人格讨论/引用对局的统一编号） */
export function formatGameTitleNo(date: Date, seq: number): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}${m}${d}${String(seq).padStart(3, "0")}`;
}

export interface AiTestInput {
  provider: AiProvider;
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface AiTestResult {
  ok: boolean;
  message: string;
  latencyMs: number;
}

// ---------- API 存档（用户保存的多套 AI 接入配置，一键取用到座位） ----------
export interface ApiPreset {
  id: number;
  name: string;
  provider: AiProvider;
  baseUrl: string;
  model: string;
  apiKey: string;
  updatedAt: string; // ISO 时间
}

export interface ApiPresetInput {
  name: string;
  provider: AiProvider;
  baseUrl: string;
  model: string;
  apiKey: string;
}
