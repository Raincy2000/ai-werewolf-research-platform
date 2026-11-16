// ============================================================
// 心理检查集群（手动开启的终局收尾，可续跑）
// 语义变迁（对局 20261009001 实锤）：曾是终局自动触发——被动模式一旦中断（未配分析师/
// 进程重启丢内存配置/平台回收）就难以补齐，该局心理检查从未发生。
// 现改为用户主动开启：分出胜负后顶栏出现「开始心理检查」，点击启动；中断后再点只补未完成座位
//（已有报告的座位不重跑；已有回写事件的座位不重写——人格演进不重复入账）。
// 版图拆分（2026-10-15 第三波）：自 service.ts 抽出；
// errMessage/snapshotFromRuntime/requireOwnedGame/recoverGame/registry 依先例依赖注入，杜绝环引用。
// ============================================================

import type {
  AdvancedOptions,
  AnalystAiConfig,
  GameSnapshot,
  PollResult,
  SeatAiConfig,
} from "../../contracts/game";
import { BOARDS, boardRulesText } from "../../contracts/game";
import type { PersonaCard } from "../../contracts/persona";
import type { GameRow } from "../../db/schema";
import { appendEvents, getAllEvents, getGame } from "../queries/games";
import { getPersona, getPersonaReportsForGame, upsertPersonaReport, listPersonaWritebackFailedSeats } from "../queries/personas";
import { runNotebookWriteback } from "../persona/notebook";
import { runPsyCheck } from "../persona/anatomist";
import { runCognitionWrite, COGNITION_NOTE_ENABLED } from "../persona/cognition";
import { buildLogDigest } from "./logDigest";
import { buildPrivateEvidenceIndex, buildPublicEvidenceIndex, type EvidenceRef } from "./evidence";
import { MEETING_WOLVES } from "./engine/index";
import type { GameRuntime, StoredSetup } from "./service";


/** 心理检查任务的进度透出载荷：有人格座位且已分出胜负的对局，逐座位 pending/running/done */
export async function psyCheckPayload(
  gameId: string,
  row: GameRow,
  rt: GameRuntime | null,
): Promise<PollResult["psyCheck"]> {
  const binds = rt?.seatPersonas ?? ((row.setup as StoredSetup)?.seatPersonas ?? []);
  if (binds.length === 0 || row.winner == null) return null;
  const reports = await getPersonaReportsForGame(gameId).catch(() => []);
  const doneIds = new Set(reports.map((r) => r.personaId));
  return {
    seats: binds.map((b) => ({
      seat: b.seat,
      status: rt?.psyCheckRunning?.has(b.seat)
        ? ("running" as const)
        : doneIds.has(b.personaId)
          ? ("done" as const)
          : ("pending" as const),
    })),
  };
}


/** 心理检查集群工厂：注入 service.ts 内部工具与运行时注册表，返回对外两个入口 */
export function createPsyCheck(deps: {
  errMessage: (err: unknown) => string;
  snapshotFromRuntime: (gameId: string, row: GameRow, rt: GameRuntime) => GameSnapshot;
  requireOwnedGame: (gameId: string, userId?: string) => Promise<GameRow>;
  recoverGame: (gameId: string) => Promise<GameRuntime | null>;
  registry: Map<string, GameRuntime>;
}) {

  // ---------- 心理检查（手动开启的终局收尾，可续跑） ----------
  // 语义变迁（对局 20261009001 实锤）：曾是终局自动触发——被动模式一旦中断（未配分析师/
  // 进程重启丢内存配置/平台回收）就难以补齐，该局心理检查从未发生。
  // 现改为用户主动开启：分出胜负后顶栏出现「开始心理检查」，点击启动；中断后再点只补未完成座位
  //（已有报告的座位不重跑；已有回写事件的座位不重写——人格演进不重复入账）。

  /** 心理检查在飞座位与完成座位的运行时状态键（rt.psyCheckRunning / rt.psyCheckDone） */

  /** 单个人格的检查链（局部保序：记事簿回写 → 心理检查报告 → 参战计数）；
   * 续跑跳过：已有回写事件的座位不重写（防记忆重复入账），报告由调用方按 todo 控制 */
  async function runPsyCheckForSeat(
    gameId: string,
    rt: GameRuntime,
    ctx: {
      cfg: SeatAiConfig;
      snapshot: GameSnapshot;
      digest: string;
      winnerText: string;
      titleNo: string;
      others: { seat: number; name: string; personaId: number; known: boolean }[];
      publicEvidence: EvidenceRef[];
      events: Awaited<ReturnType<typeof getAllEvents>>;
      writebackDoneSeats: Set<number>;
    },
    seat: number,
    card: PersonaCard,
  ): Promise<void> {
    const { cfg, snapshot, digest, winnerText, titleNo, others, writebackDoneSeats } = ctx;
    const player = snapshot.players.find((p) => p.seat === seat);
    const roleName = player?.roleName ?? "未知身份";
    const outcome = `${winnerText}${player && !player.alive ? `；出局（${player.deathInfo ?? "死亡"}）` : "；存活"}`;
    const privateEvidence = buildPrivateEvidenceIndex(gameId, seat, ctx.events, {
      wolfTeam: MEETING_WOLVES.has(player?.role ?? "villager"),
    });
    const evidence = [...ctx.publicEvidence, ...privateEvidence];
    // ---- 记事簿回写：记忆入库/强化/衰减、关系传递、人格漂移（续跑跳过已完成座位） ----
    if (writebackDoneSeats.has(seat)) {
      // 已回写过：漂移已生效、记忆已入账——不重复执行
    } else {
      try {
        const wb = await runNotebookWriteback({
          cfg,
          card,
          seat,
          roleName,
          outcome,
          gameTitleNo: titleNo,
          digest,
          gameId,
          otherPersonas: others.filter((o) => o.seat !== seat),
          evidence,
        });
        if (wb) {
          await appendEvents([
            {
              gameId,
              seq: ++rt.seq,
              day: snapshot.day,
              phase: snapshot.phase,
              type: "system",
              actor: null,
              actorLabel: null,
              title: "记事簿回写",
              content: `「${card.name}」（${seat}号）记忆回写${wb.skipped ? "（幂等跳过，已回写过）" : "完成"}：新增记忆 ${wb.memoriesAdded} 条、强化 ${wb.memoriesReinforced} 条、关系更新 ${wb.relationshipsTouched} 项、人格漂移 ${wb.driftApplied.length} 处${wb.driftApplied.length ? `（${wb.driftApplied.map((d) => d.path).join("、")}）` : ""}。`,
              thought: null,
              meta: { personaNotebook: wb.text },
            },
          ]);
        } else {
          // AI 输出非法/失败：落失败事件（不写成功事件），下次 startPsyCheck 会因回写未完成而重试
          await appendEvents([
            {
              gameId,
              seq: ++rt.seq,
              day: snapshot.day,
              phase: snapshot.phase,
              type: "system",
              actor: null,
              actorLabel: null,
              title: "记事簿回写失败",
              content: `「${card.name}」（${seat}号）记忆回写未完成：AI 输出不可用；重新点击「开始心理检查」会补跑该座位。`,
              thought: null,
              meta: null,
            },
          ]);
        }
      } catch (err) {
        await appendEvents([
          {
            gameId,
            seq: ++rt.seq,
            day: snapshot.day,
            phase: snapshot.phase,
            type: "system",
            actor: null,
            actorLabel: null,
            title: "记事簿回写失败",
            content: `「${card.name}」（${seat}号）记忆回写失败：${deps.errMessage(err).slice(0, 200)}`,
            thought: null,
            meta: null,
          },
        ]);
      }
    }
    // ---- 心理检查师：《心理检查报告》 ----
    try {
      // 官方规则全文注入：心理检查的规则认知与引擎/玩家/分析师同一事实源
      const rulesBoard = BOARDS.find((b) => b.id === rt.boardId);
      const rulesText = rulesBoard ? boardRulesText(rulesBoard, rt.options.sheriffEnabled) : undefined;
      const report = await runPsyCheck(cfg, { card, seat, roleName, outcome, digest, gameTitleNo: titleNo, rulesText, evidence });
      await upsertPersonaReport({ gameId, personaId: card.id, seat, report, model: cfg.model });
      await appendEvents([
        {
          gameId,
          seq: ++rt.seq,
          day: snapshot.day,
          phase: snapshot.phase,
          type: "system",
          actor: null,
          actorLabel: null,
          title: "心理检查报告已生成",
          content: `「${card.name}」（${seat}号）的《心理检查报告》已生成：三个转折点 + 参数撕裂还原 + 人格状态与走向，可在本页「心理检查」按钮与人格详情页查看。`,
          thought: null,
          meta: null,
        },
      ]);
      rt.psyCheckDone?.add(seat);
      // ---- 赛后自动书写认知笔记（该人格开了开关才触发；用本局参赛绑定的座位模型；
      // 不算对局内行为：不占状态环、不影响心理检查进度；失败只落事件） ----
      const seatCfg = rt.seatAIs.find((s) => s.seat === seat);
      const ownerId = rt.userId;
      // 机制已下线：连事件都不写（对局流程零痕迹）。代码保留待自省情景启用。
      if (seatCfg && COGNITION_NOTE_ENABLED) {
        try {
          // 开关读取用最新卡（对局期间的开关改动即时生效）；无 userId 的内部/测试路径用局内卡
          const fresh = ownerId ? await getPersona(card.id, ownerId) : card;
          // 默认开启（null=未设置=开）：只有显式关闭才不写
          const auto = fresh?.autoCognition;
          if (auto?.enabled !== false) {
            const wr = await runCognitionWrite({
              personaId: card.id,
              userId: ownerId ?? "",
              cfg: seatCfg,
              // 自动模式语义（2026-10-14 用户裁定）：报告=自由查看权（TA 自己决定翻不翻开），
              // 漂移阅读权沿用开关；报告锁定本局这一份
              includeReports: auto ? auto.includeReports === true : true, // 报告自由查看权默认授予（显式关闭才收）
              includeDrift: auto?.includeDrift === true,
              mode: "auto",
              gameId,
              gameTitleNo: titleNo,
            });
            await appendEvents([
              {
                gameId,
                seq: ++rt.seq,
                day: snapshot.day,
                phase: snapshot.phase,
                type: "system",
                actor: null,
                actorLabel: null,
                title: wr ? "认知笔记已更新" : "认知笔记书写失败",
                content: wr
                  ? `「${card.name}」（${seat}号）赛后亲笔更新了自我认知笔记（${seatCfg.model}${wr.readReport === true ? "，书写前翻看了自己的心理检查报告" : wr.readReport === false ? "，未翻看心理检查报告" : ""}），可在人格详情页「认知笔记」页签查看。`
                  : `「${card.name}」（${seat}号）赛后自动书写认知笔记失败（AI 调用或输出校验未通过），可在人格详情页手动「记录认知」重试。`,
                thought: null,
                meta: null,
              },
            ]);
          }
        } catch (err) {
          await appendEvents([
            {
              gameId,
              seq: ++rt.seq,
              day: snapshot.day,
              phase: snapshot.phase,
              type: "system",
              actor: null,
              actorLabel: null,
              title: "认知笔记书写失败",
              content: `「${card.name}」（${seat}号）赛后自动书写异常：${deps.errMessage(err).slice(0, 200)}`,
              thought: null,
              meta: null,
            },
          ]).catch(() => { /* 事件失败不再上抛 */ });
        }
      }
    } catch (err) {
      await appendEvents([
        {
          gameId,
          seq: ++rt.seq,
          day: snapshot.day,
          phase: snapshot.phase,
          type: "system",
          actor: null,
          actorLabel: null,
          title: "心理检查报告生成失败",
          content: `「${card.name}」（${seat}号）心理检查报告生成失败：${deps.errMessage(err).slice(0, 200)}`,
          thought: null,
          meta: null,
        },
      ]);
    }
    // ---- 参战计数：已迁移至 createGame「落座即计」（对局创建成功即入数）——
    // 收尾链不再重复计数（重启续跑/补跑检查都不再触碰计数） ----
  }

  /** 心理检查后台任务：todo 座位并行（并发 3），完成进度写 rt.psyCheckRunning/done（poll 透出） */
  async function runPsyCheckJob(
    gameId: string,
    rt: GameRuntime,
    cfg: SeatAiConfig,
    todoSeats: number[],
  ): Promise<void> {
    const row = await getGame(gameId);
    if (!row) return;
    const events = await getAllEvents(gameId);
    const snapshot = deps.snapshotFromRuntime(gameId, row, rt);
    const digest = buildLogDigest(snapshot, events);
    const winnerText = snapshot.winner === "wolf" ? "狼人阵营胜利" : snapshot.winner === "good" ? "神民阵营胜利" : "未分胜负";
    // 人格可知性名册（迷雾规则：full 全可见；partial 中 personaFogSeats 被上迷雾；none 全迷雾）——
    // 记事簿回写的锚点双轨依据：可知的归人格名，迷雾/无人格的归「标题号·代号」
    const visibility = rt.options.personaVisibility ?? "full";
    const fogSeats = new Set(rt.options.personaFogSeats ?? []);
    const others = (rt.seatPersonas ?? []).map((b) => ({
      seat: b.seat,
      name: rt.personaCards?.get(b.seat)?.name ?? b.name,
      personaId: b.personaId,
      known: visibility === "full" || (visibility === "partial" && !fogSeats.has(b.seat)),
    }));
    // 回写完成判定：事件流里该座位的「记事簿回写」成功事件（内容以「名字」（N号）开头）
    const writebackDoneSeats = new Set(
      events
        .filter((e) => e.title === "记事簿回写")
        .map((e) => /^「.+」（(\d+)号）/.exec(e.content)?.[1])
        .filter((s): s is string => !!s)
        .map(Number),
    );
    const ctx = {
      cfg,
      snapshot,
      digest,
      winnerText,
      titleNo: row.titleNo ?? "",
      others,
      publicEvidence: buildPublicEvidenceIndex(gameId, events),
      events,
      writebackDoneSeats,
    };
    const CONCURRENCY = 3; // 各人格链相互独立；过高并发只会撞限流转重试，不降质量
    let cursor = 0;
    const worker = async () => {
      while (cursor < todoSeats.length) {
        const seat = todoSeats[cursor++]!;
        const card = rt.personaCards?.get(seat);
        if (!card) {
          rt.psyCheckRunning?.delete(seat);
          continue;
        }
        await runPsyCheckForSeat(gameId, rt, ctx, seat, card);
        rt.psyCheckRunning?.delete(seat);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, todoSeats.length) }, () => worker()),
    );
  }


  /** 开始心理检查（用户主动开启，可续跑）：分出胜负即可（无赛后讨论/赛后待开始同样开放）。
   *  AI 配置：前端分析师配置 → 对局分析师配置 → 1 号座位配置（逐级兜底，与胜率分析同规）。
   *  幂等：进行中的调用直接复视；已完成座位跳过；写库失败记事件不阻塞其余座位。 */
  /** 自动心理检查触发：使用数据库中的对局属主身份，不能匿名调用归属校验。
   * 无人格或全部已完成是正常幂等；真正的启动失败落系统事件，绝不静默吞掉。 */
  function maybeAutoPsyCheck(gameId: string, options: AdvancedOptions | undefined, point: "postgameEnd" | "reportDone"): void {
    if (!options || options.autoPsyCheck !== true) return;
    const postgameOn = options.postGameDiscuss === true;
    if (point === "postgameEnd" && !postgameOn) return;
    if (point === "reportDone" && postgameOn) return;
    void (async () => {
      const row = await getGame(gameId);
      if (!row) throw new Error("对局不存在，无法自动开始心理检查");
      if (!((row.setup as StoredSetup).seatPersonas?.length)) return;
      const result = await startPsyCheck(gameId, null, row.userId);
      if (!result.started && result.reason !== "全部人格的心理检查已完成") {
        throw new Error(result.reason ?? "未知原因");
      }
    })().catch(async (err) => {
      const message = deps.errMessage(err).slice(0, 300);
      console.error(`[autoPsyCheck] 对局 ${gameId} 自动启动失败：${message}`);
      const rt = deps.registry.get(gameId);
      if (!rt) return;
      try {
        const snap = rt.engine.getSnapshot();
        await appendEvents([{
          gameId,
          seq: ++rt.seq,
          day: snap.day,
          phase: snap.phase,
          type: "system",
          actor: null,
          actorLabel: null,
          title: "自动心理检查启动失败",
          content: `自动心理检查未能开始：${message}。可点击「开始心理检查」重试。`,
          thought: null,
          meta: null,
        }]);
      } catch {
        /* 控制台已保留原始错误；事件落库失败不再上抛 */
      }
    });
  }

  async function startPsyCheck(
    gameId: string,
    analystCfg: AnalystAiConfig | null | undefined,
    userId?: string,
  ): Promise<{ started: boolean; reason?: string }> {
    const row = await deps.requireOwnedGame(gameId, userId);
    if (row.winner == null) return { started: false, reason: "对局尚未分出胜负——心理检查在分出胜负后开放" };
    const setup = row.setup as StoredSetup;
    const binds = setup.seatPersonas ?? [];
    if (binds.length === 0) return { started: false, reason: "本局没有人格座位" };
    // 运行时缺失则重放重建（读人格卡/快照；paused/finished 对局不补链不续跑）
    let rt = deps.registry.get(gameId) ?? null;
    if (!rt) {
      rt = await deps.recoverGame(gameId).catch(() => null);
      if (!rt) return { started: false, reason: "对局恢复原料缺失，无法开始心理检查" };
    }
    if (!rt.personaCards || rt.personaCards.size === 0) {
      return { started: false, reason: "人格卡已不可用（可能被删除），无法检查" };
    }
    if ((rt.psyCheckRunning?.size ?? 0) > 0) return { started: true }; // 幂等复视：已在进行中
    const cfgSource = analystCfg ?? rt.analystAi ?? (rt.seatAIs[0] ?? null);
    if (!cfgSource) return { started: false, reason: "没有可用的 AI 配置" };
    const cfg: SeatAiConfig = { ...cfgSource, seat: 0 };
    // 续跑核心：补「还没有心理检查报告」或「记事簿回写失败/未完成」的座位
    const reports = await getPersonaReportsForGame(gameId).catch(() => []);
    const doneIds = new Set(reports.map((r) => r.personaId));
    const failedWriteback = new Set(await listPersonaWritebackFailedSeats(gameId).catch(() => []));
    const todoSeats = binds
      .filter((b) => !doneIds.has(b.personaId) || failedWriteback.has(b.seat))
      .map((b) => b.seat);
    if (todoSeats.length === 0) return { started: false, reason: "全部人格的心理检查已完成" };
    rt.psyCheckRunning = new Set(todoSeats);
    void runPsyCheckJob(gameId, rt, cfg, todoSeats)
      .catch(async (err) => {
        try {
          const snap = rt.engine.getSnapshot();
          await appendEvents([
            {
              gameId,
              seq: ++rt.seq,
              day: snap.day,
              phase: snap.phase,
              type: "system",
              actor: null,
              actorLabel: null,
              title: "心理检查失败",
              content: `心理检查任务异常中断：${deps.errMessage(err).slice(0, 300)}——重新点击「开始心理检查」可从断点续跑。`,
              thought: null,
              meta: null,
            },
          ]);
        } catch {
          /* 记日志失败也不再上抛 */
        }
      })
      .finally(() => {
        rt.psyCheckRunning?.clear();
      });
    return { started: true };
  }

  return { maybeAutoPsyCheck, startPsyCheck };
}
