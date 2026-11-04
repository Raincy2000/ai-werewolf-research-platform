// ============================================================
// 断点重放恢复模块（书记员层）——从 service.ts 析出（2026-10-15 架构优化专项）：
// 崩溃/重启后用落盘的 setup（座位角色+AI配置+选项）与决策日志确定性重放，把对局精确重建到断点。
// 依赖经 createRecovery 注入（registry/scheduleTick/maybeWinRateTick/persistWithPhaseBreak 属主服务），
// 本模块不反向 import service.ts，杜绝环依赖。
// ============================================================

import { BOARDS } from "../../contracts/game";
import type { AdvancedOptions, GameStatus, SeatAiConfig } from "../../contracts/game";
import type { DecisionInput, Engine, EngineEvent, PendingDecision } from "./engine/api";
import { SPEECH_REQUIRED_KINDS } from "./engine/api";
import { createEngine, MEETING_WOLVES } from "./engine/index";
import { decryptSecret } from "../lib/authCrypto";
import { withTimeout, DB_TIMEOUT_MS } from "./runtime/timing";
import { initialGameTiming, restoreTiming } from "./timing";
import {
  getGame,
  getLatestEvents,
  getLatestPhaseEvent,
  getMaxEventSeq,
} from "../queries/games";
import { getDecisions } from "../queries/decisions";
import { getStudyNotes } from "../queries/library";
import { getPersonaCardsInternal, loadMemoryPool } from "../queries/personas";
import type { AnalystAiConfig } from "../../contracts/game";
import { rebuildSeatNotesFromLog } from "./seat-notes";
import type { GameRuntime, StoredSetup } from "./service";

/** setup 里的座位 AI 配置（加密则解密；缺密钥/损坏返回 undefined=原料缺失） */
export function seatAIsOfSetup(setup: StoredSetup): SeatAiConfig[] | undefined {
  if (setup.seatAIsEnc) {
    try {
      return JSON.parse(decryptSecret(setup.seatAIsEnc)) as SeatAiConfig[];
    } catch {
      return undefined;
    }
  }
  return setup.seatAIs;
}

/** 分析师配置从加密 setup 恢复；缺失/损坏回退 null，自动生成旗标一并保留。 */
export function analystAiOfSetup(setup: StoredSetup): AnalystAiConfig | null {
  if (!setup.analystAiEnc) return null;
  try {
    const cfg = JSON.parse(decryptSecret(setup.analystAiEnc)) as Omit<AnalystAiConfig, "autoGenerate">;
    return { ...cfg, autoGenerate: setup.analystAutoGenerate !== false };
  } catch {
    return null;
  }
}

/** 事件所属时段（夜/日/ null=不涉及时段的系统类阶段） */
export function partOfPhase(phase: string): "night" | "day" | null {
  return phase.startsWith("night.") ? "night" : phase.startsWith("day.") ? "day" : null;
}

// ---------- 批量决策的规则演进对齐 ----------
// 规则升级后旧日志的并行权衡批次可能含「新规则下不再询问」的成员（实锤 2026-10-15：
// 0.3.53 起骑士决斗仅限放逐发言阶段，旧日志的夜亡公告权衡批含骑士席位 → 存储 5 条、
// 新引擎只问 4 席 → 恢复硬分叉）。仅当多余输入全部「不带动作」（按兵不动/纯思考）时
// 剔除对齐——按兵输入对任何席位都合法且不改变世界线；带动作的多余项无法安全归属、
// 存储少于期望无法凭空捏造，均属真分叉，返回 null 由调用方照旧抛错。

/** 输入是否「不带动作」：无自爆/认输/宣布胜利/决斗/目标/发言——纯思考量，剔除不改变历史 */
function isActionFreeInput(inp: DecisionInput): boolean {
  return (
    !inp.selfDestruct &&
    !inp.surrender &&
    !inp.declareVictory &&
    inp.duel == null &&
    !(inp.targets && inp.targets.length > 0) &&
    !inp.speech
  );
}

/** 输入与待决成员的角色相容性：动作必须落在有权发动的席位上（狼队动作/骑士决斗/发言类） */
function inputFitsMember(inp: DecisionInput, member: PendingDecision): boolean {
  if (inp.selfDestruct || inp.surrender || inp.declareVictory) return MEETING_WOLVES.has(member.role);
  if (inp.duel != null) return member.role === "knight";
  const memberNeedsSpeech = (SPEECH_REQUIRED_KINDS as ReadonlySet<string>).has(member.kind);
  if (inp.speech != null) return memberNeedsSpeech;
  if (memberNeedsSpeech) return false; // 发言席位的输入必须带发言
  return true; // 按兵/纯思考对任何权衡席位合法
}

/** 批量决策对齐：返回剔除多余项后的新决策载荷；无法安全对齐返回 null。
 *  obsoleteSeats：调用方按引擎重放状态给出的「旧批次多余席位」精确提示（命中即按席位剔除）。
 *  批次成员顺序模型：非发言成员（权衡项）按席位升序，发言成员追加在尾部（askSpeechWithWeigh 契约）。
 *  单席退化：旧日志的多人权衡批在新规则下只剩 1 个成员时引擎退化为单独询问——
 *  按「一批一員」对齐，返回剔除后唯一的裸输入（非 batchInputs 包裹）。 */
export function alignBatchDecision(
  pending: PendingDecision,
  decision: DecisionInput,
  obsoleteSeats: number[] = [],
): DecisionInput | null {
  const isDegenerateSingle = !pending.batch;
  const batch = pending.batch ?? [pending];
  const inputs = decision.batchInputs;
  if (!inputs) return null;
  const k = inputs.length - batch.length;
  if (k <= 0) return null; // 存储不多于期望：无需对齐 / 无法捏造
  // 对齐结果按待决形态打包：批量 → batchInputs 包裹；单席退化 → 裸输入
  const pack = (kept: DecisionInput[]): DecisionInput =>
    isDegenerateSingle ? kept[0]! : { ...decision, batchInputs: kept };
  const needsSpeech = (m: PendingDecision) => (SPEECH_REQUIRED_KINDS as ReadonlySet<string>).has(m.kind);
  // 精确路径：多余席位已知——旧批次 = 升序权衡成员（含多余席位）+ 尾部发言成员，剔除多余席位对应输入位
  if (obsoleteSeats.length === k) {
    const weigh = batch.filter((m) => !needsSpeech(m));
    const tail = batch.filter((m) => needsSpeech(m));
    const oldSeats = [
      ...[...weigh.map((m) => m.seat), ...obsoleteSeats].sort((a, b) => a - b),
      ...tail.map((m) => m.seat),
    ];
    if (oldSeats.length === inputs.length) {
      const dropIdx = new Set(
        oldSeats.map((s, i) => (obsoleteSeats.includes(s) ? i : -1)).filter((i) => i >= 0),
      );
      if (dropIdx.size === k && [...dropIdx].every((i) => isActionFreeInput(inputs[i]!))) {
        const kept = inputs.filter((_, i) => !dropIdx.has(i));
        // 保留输入还需与成员按位相容（角色权限/发言必填），否则按真分叉处理
        for (let m = 0; m < batch.length; m++) {
          if (!inputFitsMember(kept[m]!, batch[m]!)) return null;
        }
        return pack(kept);
      }
      return null; // 带动作项落在多余席位：真分叉
    }
    // 长度对不上说明旧批次构成与模型不符，落回试探路径
  }
  // 回退路径（席位提示不可用）：试探剔除 k 个不带动作的输入位，
  // 使剩余输入与成员按位相容（组合封顶防病态展开——批次规模 ≤13）
  const freePositions = inputs.map((inp, i) => (isActionFreeInput(inp) ? i : -1)).filter((i) => i >= 0);
  if (freePositions.length < k) return null;
  const tryDrop = (drop: number[]): DecisionInput | null => {
    const kept = inputs.filter((_, i) => !drop.includes(i));
    for (let m = 0; m < batch.length; m++) {
      if (!inputFitsMember(kept[m]!, batch[m]!)) return null;
    }
    return pack(kept);
  };
  // 组合枚举（k=1 最常见；k>1 依组合数封顶 300 次）
  let budget = 300;
  const combine = (start: number, picked: number[]): DecisionInput | null => {
    if (picked.length === k) return --budget > 0 ? tryDrop(picked) : null;
    for (let i = start; i < freePositions.length && budget > 0; i++) {
      const r = combine(i + 1, [...picked, freePositions[i]!]);
      if (r) return r;
    }
    return null;
  };
  return combine(0, []);
}

/** 计算旧批次的多余席位提示：引擎重放到该待决点时，存活且有权权衡却不在新批次中的席位
 * （规则演进被移出批次的成员——如非发言阶段的骑士）。无漂移场景返回空数组。
 * 单席退化待决同样适用（旧批次的其余成员全部视为多余席位）。 */
function obsoleteWeighSeats(engine: Engine, pending: PendingDecision): number[] {
  const inBatch = new Set((pending.batch ?? [pending]).map((m) => m.seat));
  return engine
    .getSnapshot()
    .players.filter(
      (p) => p.alive && !inBatch.has(p.seat) && (p.role === "knight" || MEETING_WOLVES.has(p.role)),
    )
    .map((p) => p.seat);
}

/** 顺序条目合并为批量（规则演进反向漂移：旧版本逐个询问、新版本批量询问——如实锤的退水环节）。
 *  日志从位置 i 起连续的 N 条单座决策若能按序喂满批量成员（kind+seat 逐位吻合），
 *  合并为一份批量载荷返回；否则 null。成员合法性由引擎 decide 复验把关。
 *  导出仅供测试（恢复回归用例直接校准拼接行为）。 */
export function expandSequentialBatch(
  pending: PendingDecision,
  decisions: { kind: string; seat: number; decision: unknown }[],
  i: number,
): { decision: DecisionInput; consumed: number } | null {
  const batch = pending.batch;
  if (!batch || batch.length <= 1) return null;
  if (i + batch.length > decisions.length) return null;
  const inputs: DecisionInput[] = [];
  for (let m = 0; m < batch.length; m++) {
    const rec = decisions[i + m]!;
    if (rec.kind !== batch[m]!.kind || rec.seat !== batch[m]!.seat) return null;
    const d = rec.decision as DecisionInput;
    if (d.batchInputs) return null; // 嵌套批量：非顺序条目形态
    inputs.push(d);
  }
  return { decision: { thought: "", batchInputs: inputs }, consumed: batch.length };
}

/** 恢复模块的宿主依赖（主服务注入，杜绝反向引用） */
export interface RecoveryDeps {
  registry: Map<string, GameRuntime>;
  scheduleTick: (gameId: string, rt: GameRuntime, delayMs: number) => void;
  maybeWinRateTick: (gameId: string, rt: GameRuntime) => void;
  persistWithPhaseBreak: (gameId: string, rt: GameRuntime, events: EngineEvent[]) => Promise<void>;
}

export function createRecovery(deps: RecoveryDeps) {
  const { registry, scheduleTick, maybeWinRateTick, persistWithPhaseBreak } = deps;
  const recoveringGames = new Map<string, Promise<GameRuntime | null>>();

  // 恢复后 running 立即补链继续跑；paused/created 保持原状态待用户启动；finished 仅用于完整复盘。
  // 旧对局 setup 无 seatAIs → 返回 null（保持「重启后仅可查看事件」的旧行为）。
  async function recoverGame(gameId: string): Promise<GameRuntime | null> {
    const inflight = recoveringGames.get(gameId);
    if (inflight) return inflight;
    const task = doRecoverGame(gameId).finally(() => recoveringGames.delete(gameId));
    recoveringGames.set(gameId, task);
    return task;
  }

  async function doRecoverGame(gameId: string): Promise<GameRuntime | null> {
    const rt = await buildRuntimeFromStore(gameId);
    // running 的对局立即补链继续跑（恢复前的服务中断等价于一次长卡顿）
    if (rt && rt.status === "running") {
      scheduleTick(gameId, rt, 0);
      maybeWinRateTick(gameId, rt); // 恢复续跑后补一次胜率评估（开关随 setup 落库）
    }
    return rt;
  }

  // 从落盘原料重建运行时（doRecoverGame 的主体，纯搬运；唯一扩展：optionsOverride 覆盖
  // setup.options——已结束对局补开赛后讨论时强制 postGameDiscuss:true 重放，让生成器
  // 越过 endGame 继续进入 postGamePhase）。
  async function buildRuntimeFromStore(
    gameId: string,
    opts?: { optionsOverride?: Partial<AdvancedOptions> },
  ): Promise<GameRuntime | null> {
    const row = await withTimeout(getGame(gameId), DB_TIMEOUT_MS, "读取对局超时");
    if (!row) return null;
    const setup = (row.setup ?? null) as StoredSetup | null;
    const seatAIs = setup ? seatAIsOfSetup(setup) : undefined;
    if (!seatAIs || !setup?.seatRoles?.length) return null; // 旧对局：无恢复原料
    const board = BOARDS.find((b) => b.id === row.boardId);
    if (!board) return null;

    const options: AdvancedOptions = { ...setup.options, ...opts?.optionsOverride };
    const engine = createEngine({ boardId: board.id, seatRoles: setup.seatRoles, options });
    const decisions = await withTimeout(getDecisions(gameId), DB_TIMEOUT_MS, "决策日志读取超时");
    const maxSeq = await withTimeout(getMaxEventSeq(gameId), DB_TIMEOUT_MS, "事件游标读取超时");
    // displayPhase 以库中最后一条阶段提醒为准（显示跟随已落盘内容，而非引擎活阶段值）
    const latestPhaseEvt = await withTimeout(
      getLatestPhaseEvent(gameId),
      DB_TIMEOUT_MS,
      "阶段提醒读取超时",
    );
    // 确定性重放：逐条重放已采纳决策；每个待决点应与记录一致（kind+seat 一致性校验）。
    // 关键：捕获最后一条决策 decide() 排出的事件批——运行时是「决策日志先于事件落盘」
    // （appendDecision → persistWithPhaseBreak），崩溃/重启若落在两者之间（含交界静歇的
    // 数秒睡眠窗口），该批事件会全部或部分（交界切分的前半已落、后半未落）丢失；
    // 重放只能恢复引擎状态，事件必须由恢复流程比对补齐（见下方断点事件补漏）。
    let lastDrained: EngineEvent[] = [];
    for (let i = 0; i < decisions.length; i++) {
      const rec = decisions[i];
      // 外部结算条目（auditSettle）：不喂 advance/decide（其时刻待决是被封存而非消费），
      // 直接调引擎 settleExternal 落定胜者——引擎快照 winner/phase 与赛后衔接全部精确重建
      //（kind 落库为自由字符串；auditSettle 不在 DecisionKind 枚举内——它是服务层结算标记）
      if ((rec.kind as string) === "auditSettle") {
        const d = rec.decision as { auditSettle?: unknown; auditNote?: unknown; auditPub?: unknown };
        if (d.auditSettle !== "wolf" && d.auditSettle !== "good") {
          throw new Error(`恢复重放分叉：auditSettle 条目胜者非法（${JSON.stringify(d.auditSettle)}，${gameId}）`);
        }
        lastDrained = engine.settleExternal(
          d.auditSettle,
          typeof d.auditNote === "string" ? d.auditNote : undefined,
          typeof d.auditPub === "string" ? d.auditPub : undefined,
        );
        continue;
      }
      const adv = engine.advance();
      if (!adv.pending) throw new Error(`恢复重放分叉：第 ${i} 步前引擎已无待决（${gameId}）`);
      const pending = adv.pending;
      const recDecision = rec.decision as DecisionInput;
      const kindSeatMatch = pending.kind === rec.kind && pending.seat === rec.seat;
      if (kindSeatMatch && pending.batch && !recDecision.batchInputs) {
        // 顺序→批量合并（反向漂移：旧版本逐个询问、新版本批量询问，实锤于退水环节）——
        // 日志中连续 N 条单座决策按序喂满批量成员则合并消费；成员合法性由 decide 复验
        const expanded = expandSequentialBatch(pending, decisions, i);
        if (expanded) {
          console.warn(
            `[recover] 规则演进容差：顺序条目合并为批量 ${rec.kind}（${gameId}，${expanded.consumed} 条）`,
          );
          lastDrained = engine.decide(expanded.decision);
          i += expanded.consumed - 1; // 循环自增后落在合并段最后一格
          continue;
        }
      }
      if (!kindSeatMatch && pending.kind === rec.kind && recDecision.batchInputs) {
        // 批量首席位漂移（含单席退化：旧批次在新规则下只剩 1 员）——直接尝试收缩对齐
        const alignedC = alignBatchDecision(pending, recDecision, obsoleteWeighSeats(engine, pending));
        if (alignedC) {
          console.warn(
            `[recover] 规则演进容差：批量权衡席位漂移对齐 ${rec.kind}（${gameId}，${recDecision.batchInputs.length}→${pending.batch?.length ?? 1}）`,
          );
          lastDrained = engine.decide(alignedC);
          continue;
        }
      }
      if (!kindSeatMatch) {
        // 规则演进容差（2026-10-15 实锤）：规则升级后旧日志里的部分决策在新规则下不再产生
        //（如 0.3.53 最后一狼直通宣判后，旧日志的「遗言后权衡/放逐技能询问」已成废案）——
        // 当前待决与日志不一致时，向后探测至多 3 条：若后续条目与当前待决精确吻合（kind+seat），
        // 则中间条目按「规则演进废案」跳过（这些废案本就不会改变世界线：按兵不动/被规则禁用的询问）；
        // 探测无果才是真分叉（日志损坏），照旧抛错
        const probeLimit = Math.min(decisions.length, i + 4);
        let skipTo = -1;
        for (let j = i + 1; j < probeLimit; j++) {
          if (decisions[j].kind === pending.kind && decisions[j].seat === pending.seat) {
            skipTo = j;
            break;
          }
        }
        if (skipTo < 0) {
          throw new Error(
            `恢复重放分叉：第 ${i} 步期望 ${rec.kind}@seat${rec.seat}，实际 ${pending.kind}@seat${pending.seat}（${gameId}）`,
          );
        }
        console.warn(
          `[recover] 规则演进容差：跳过废案决策 ${decisions.slice(i, skipTo).map((d) => `${d.kind}@${d.seat}`).join("、")}（${gameId}）`,
        );
        i = skipTo - 1; // 循环自增后正好落在吻合条目上，由正常路径消费它
        continue;
      }
      try {
        lastDrained = engine.decide(recDecision);
      } catch (err) {
        // 批量权衡的规则演进对齐（实锤 2026-10-15，对局 20261011004）：旧日志批次含新规则
        // 不再询问的成员（如骑士决斗 0.3.53 起仅限放逐发言阶段），多余成员全部按兵不动时
        // 剔除对齐——按兵输入不改变世界线；对齐失败（带动作/数量倒挂）照旧抛真分叉。
        // decide 校验失败保留待决（engine 契约），此处重试安全。
        const aligned = alignBatchDecision(
          pending,
          recDecision,
          obsoleteWeighSeats(engine, pending),
        );
        if (!aligned) throw err;
        console.warn(
          `[recover] 规则演进容差：批量权衡席位漂移对齐 ${rec.kind}（${gameId}，${recDecision.batchInputs?.length}→${pending.batch?.length}）`,
        );
        lastDrained = engine.decide(aligned);
      }
    }

    // 已落盘事件尾部：① lastDayPart/lastEventPhase 必须以「已落盘内容」为基准——
    // 引擎活阶段值在 decide() 中先行推进，崩溃恢复时可能领先落盘内容一整个时段
    //（历史 bug：以引擎活阶段为基准，补漏批的日夜交界被误判为同时段，停歇静默跳过）；
    // ② 供最后一条决策事件批的落盘前缀比对（断点事件补漏）
    const persistedTail = await withTimeout(
      getLatestEvents(gameId, lastDrained.length + 10),
      DB_TIMEOUT_MS,
      "事件尾部读取超时",
    );
    // 赛前学习笔记（总开关开启时，来源可为历史/指南/图书馆）：恢复可读，未学全则开赛时补足
    const studyRows = options.libraryEnabled
      ? await withTimeout(getStudyNotes(gameId), DB_TIMEOUT_MS, "学习笔记读取超时").catch(() => [] as { seat: number; notes: string }[])
      : [];
    const studyMap = new Map<number, string>(studyRows.map((r) => [r.seat, r.notes]));
    const latestEvt = persistedTail[persistedTail.length - 1] ?? null;
    const rowCreatedMs = row.createdAt instanceof Date ? row.createdAt.getTime() : Date.parse(String(row.createdAt));
    const latestMs = latestEvt ? Date.parse(latestEvt.createdAt) : rowCreatedMs;
    const legacyTiming = {
      ...initialGameTiming(),
      startedAt: rowCreatedMs,
      accumulatedMs: Math.max(0, latestMs - rowCreatedMs),
      endedAt: row.status === "finished" ? latestMs : null,
      savedAt: Date.now(),
    };

    const rt: GameRuntime = {
      engine,
      boardId: board.id,
      userId: row.userId ?? null,
      options,
      seatAIs,
      manualRolesAssigned: setup.manualRolesAssigned === true,
      status: row.status as GameStatus,
      timing: restoreTiming(setup.timing ?? legacyTiming, row.status as GameStatus, Date.now()),
      pending: null,
      seq: maxSeq,
      decisionIdx: decisions.length,
      timer: null,
      ticking: false,
      lastTickAt: Date.now(),
      noProgressTicks: 0,
      pauseWaiters: [],
      decisionEpoch: 0,
      suspendDraft: null,
      analystAi: analystAiOfSetup(setup), // 分析师配置加密随 setup 恢复，自动复盘不再因重启失效
      // 时段基准以「已落盘内容」为准（而非引擎活阶段值——崩溃时后者可能领先一整个时段，
      // 导致补漏批的交界被静默跳过）；无任何落盘事件时按引擎阶段兜底（等价于空基准）
      lastDayPart: latestEvt
        ? (partOfPhase(latestEvt.phase) ?? "")
        : engine.getSnapshot().phase.startsWith("night.")
          ? "night"
          : engine.getSnapshot().phase.startsWith("day.")
            ? "day"
            : "",
      lastEventPhase: latestEvt?.phase ?? null,
      displayPhase: latestPhaseEvt
        ? {
            day: latestPhaseEvt.day,
            phase: latestPhaseEvt.phase,
            phaseLabel: latestPhaseEvt.title,
          }
        : null,
      pendingHold: false,
      breakKind: null,
      acts: null,
      breakStartedAt: null,
      winRateEnabled: setup.winRateEnabled === true, // 恢复依据：开关随 setup 落库
      winRateInFlight: false,
      winRateFinalPending: false,
      winRateDirty: false,
      winRateLastEvalAt: 0,
      winRateLastSeq: -1,
      winRateLoopTimer: null,
      winRateLastStoredSeq: 0,
      // 胜负落库状态随 row 重建：已落过 winner 的对局（含赛后讨论中断恢复）不再重复落库/触发分析
      decidedPersisted: row.winner != null,
      // 恢复重建为 false：只有 running 对局会被恢复，恢复时 rt.pending 非空走直接决策路径，
      // 挂起只会在「新 advance 出 postgameSpeak」时触发一次（正常对局只会出现一次赛后讨论）
      postgameAutoHeld: false,
      // 对局笔记随决策日志重建（与引擎状态同源，重放一致性天然成立）
      seatNotes: rebuildSeatNotesFromLog(decisions),
      studyNotes: studyMap,
      studyDoneSeats: new Set(studyMap.keys()),
      studying: false,
      studyDone: options.libraryEnabled ? studyMap.size >= seatAIs.length : true,
    };
    registry.set(gameId, rt);

    // 人格研究站：优先使用开局冻结快照；仅旧对局缺省快照时回退研究站现卡。
    if (setup?.seatPersonas?.length) {
      rt.seatPersonas = setup.seatPersonas;
      try {
        const cards = await getPersonaCardsInternal(setup.seatPersonas.map((s) => s.personaId));
        rt.personaCards = new Map();
        rt.personaMemory = new Map();
        rt.personaSnapshots = new Map();
        rt.personaEventMeta = new Map();
        for (const info of setup.seatPersonas) {
          const snapshot = setup.personaSnapshots?.[String(info.seat)];
          if (snapshot) {
            rt.personaSnapshots.set(info.seat, snapshot);
            rt.personaCards.set(info.seat, snapshot.card);
            rt.personaMemory.set(info.seat, snapshot.memory);
            continue;
          }
          const card = cards.find((c) => c.id === info.personaId);
          if (!card) continue;
          rt.personaCards.set(info.seat, card);
          rt.personaMemory.set(info.seat, await loadMemoryPool(card.id));
        }
      } catch {
        /* 人格数据不可用时整局按普通 AI 继续 */
      }
    }

    // ---------- 断点事件补漏 ----------
    // 运行时顺序是「appendDecision（决策日志）→ persistWithPhaseBreak（事件）」：崩溃/重启
    // 若落在两者之间——尤其是交界静歇的数秒睡眠窗口（前半已落盘、后半未落盘）——最后一条
    // 决策的事件批会全部或部分丢失，且引擎重放只恢复状态不补事件（decide 排出即弃）。
    // 这里把重放捕获的最后一批事件与已落盘尾部做前缀比对，缺失后缀经 persistWithPhaseBreak
    // 补齐：事件流完整（天亮/夜临公告不再凭空消失），日夜交界停歇也随之恢复。
    // 倒数第二条及更早的决策必有后续决策落盘背书（其 tick 完整走完），不会缺失。
    // 2026-10-15 实锤：已结束对局（心理检查触发恢复重放）补漏误判——已落盘尾部之后跟着
    // 心理检查/认知笔记等服务层事件，前缀比对在非末端位置部分命中 → 把早已落盘的赛后发言
    // 整段重落（张雪峰最后发言+赛后讨论结束重复诈尸）。补漏边界（三重闸门）：
    // 整批未落盘（崩溃窗口）全批补齐；匹配段恰在尾部末端补缺失后缀；
    // 匹配段不在末端（批后已有服务层事件/手术改写）绝不补落（杜绝重复诈尸）
    if (lastDrained.length > 0) {
      const sameEvt = (dbEvt: { day: number; phase: string; type: string; actor: number | null; title: string; content: string; thought: string | null }, ev: EngineEvent): boolean =>
        dbEvt.day === ev.day &&
        dbEvt.phase === ev.phase &&
        dbEvt.type === ev.type &&
        dbEvt.actor === ev.actor &&
        dbEvt.title === ev.title &&
        dbEvt.content === ev.content &&
        dbEvt.thought === ev.thought;
      let bestLen = 0;
      let bestPos = -1;
      for (let p = 0; p + bestLen < persistedTail.length; p++) {
        if (!sameEvt(persistedTail[p], lastDrained[0])) continue;
        let k = 1;
        while (
          p + k < persistedTail.length &&
          k < lastDrained.length &&
          sameEvt(persistedTail[p + k], lastDrained[k])
        ) {
          k++;
        }
        if (k > bestLen || (k === bestLen && p > bestPos)) {
          bestLen = k;
          bestPos = p;
        }
      }
      const missing =
        bestPos === -1 // 整批都没落盘（崩溃窗口事件整批丢失）：全批补齐
          ? lastDrained.slice()
          : bestPos + bestLen === persistedTail.length
            ? lastDrained.slice(bestLen) // 匹配段恰在尾部末端：缺失后缀=崩溃窗口丢失，补齐
            : []; // 匹配段不在末端（批后有后续事件/手术改写）→ 绝不补落，杜绝重复诈尸
      if (missing.length > 0) {
        await persistWithPhaseBreak(gameId, rt, missing);
      }
    }

    return rt;
  }

  return { recoverGame, buildRuntimeFromStore };
}
