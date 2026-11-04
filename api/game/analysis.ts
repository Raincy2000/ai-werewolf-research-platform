// ============================================================
// 分析任务流水线：analyze（复盘报告→落库→内存检查点）→ distill（蒸馏进经验指南）
// 分段 + 检查点：每段开始都刷新 updatedAt 心跳；analyze 产物落库的同时写入 job.report，
// 任务中途死亡（进程波动/调用悬挂）时可从检查点复活——有 report 则跳过 analyze 直接续跑 distill。
// 版图拆分（2026-10-15 第四波）：自 service.ts 抽出；
// exportGame/maybeAutoPsyCheck/combineGuideText/errMessage/registry/guideCache 依先例依赖注入。
// ============================================================

import type {
  AdvancedOptions,
  AnalysisJobStage,
  AnalystAiConfig,
  GameEvent,
  GameSnapshot,
} from "../../contracts/game";
import { BOARDS } from "../../contracts/game";
import { appendEvents, getGame } from "../queries/games";
import { getAnalysis, getLatestGuide, insertGuideVersion, upsertAnalysis } from "../queries/guide";
import { buildBoardRulesText, runAnalysis, runDistillBoard, runDistillCommon } from "./analyst";
import type { GameRuntime, StoredSetup } from "./service";


// ---------- 分析任务状态（内存跟踪；含阶段检查点与自愈心跳） ----------
// 导出仅供测试/诊断使用（构造停滞任务、观察阶段流转），运行时不应外部修改
export interface AnalysisJob {
  status: "running" | "done" | "failed";
  stage: AnalysisJobStage; // 当前阶段：analyze=撰写报告 / distill=沉淀指南；done 后归 null
  error: string | null;
  updatedAt: number; // 最近一次阶段推进/检查点写入时间（自愈心跳依据）
  report: string | null; // analyze 阶段产物的内存检查点：distill 失败/中断可跳过 analyze 直接续跑
  commonDone: boolean; // distill 阶段内检查点：共通指南已蒸馏落库 → 自愈重跑时跳过共通段，只续跑版型段
  cfg: AnalystAiConfig; // 复活所需配置（仅存内存，与座位 apiKey 一样绝不落盘）
  snapshot: GameSnapshot | null; // 指南版本 note 所需（版型/胜负），免去复活时重新导出
}
export const analysisJobs = new Map<string, AnalysisJob>();


/** 分析流水线工厂：注入 service.ts 的导出/工具与运行时状态，返回两个驱动入口 */
export function createAnalysisPipeline(deps: {
  exportGame: (gameId: string, userId?: string) => Promise<{ snapshot: GameSnapshot; events: unknown[] }>;
  maybeAutoPsyCheck: (gameId: string, options: AdvancedOptions | undefined, point: "postgameEnd" | "reportDone") => void;
  resumePostGameAfterReview: (gameId: string) => Promise<void>;
  combineGuideText: (boardId: string, common: string, boardGuide: string) => string;
  errMessage: (err: unknown) => string;
  registry: Map<string, GameRuntime>;
  guideCache: Map<string, { at: number; text: string }>;
}) {

  // ---------- 分析任务流水线：analyze（复盘报告→落库→内存检查点）→ distill（蒸馏进经验指南） ----------
  // 分段 + 检查点：每段开始都刷新 updatedAt 心跳；analyze 产物落库的同时写入 job.report，
  // 任务中途死亡（进程波动/调用悬挂）时可从检查点复活——有 report 则跳过 analyze 直接续跑 distill。
  // 负责维护 analysisJobs 状态；异常向上抛出（调用方决定记日志还是仅置 failed）
  async function runAnalysisJob(gameId: string, cfg: AnalystAiConfig): Promise<void> {
    // 检查点恢复：既有任务停在 distill 阶段且持有 report → 复用任务对象续跑，否则从头开始
    const existing = analysisJobs.get(gameId);
    const job: AnalysisJob =
      existing && existing.report && existing.stage === "distill"
        ? existing
        : { status: "running", stage: null, error: null, updatedAt: 0, report: null, commonDone: false, cfg, snapshot: null };
    job.status = "running";
    job.error = null;
    job.cfg = cfg;
    job.updatedAt = Date.now();
    analysisJobs.set(gameId, job);
    // 指南蒸馏归属：对局属主（账户隔离）；读取失败不放行他人经验（蒸馏跳过指南段较安全？——
    // 实际选择：无法确认归属则抛错终止任务，绝不让经验写入错误账户）
    const ownerRow = await getGame(gameId);
    const ownerId = ownerRow?.userId;
    if (!ownerId) throw new Error(`无法确认对局 ${gameId} 的归属用户，分析任务终止`);

    try {
      // ---------- 阶段 1：analyze（导出对局 → AI 复盘 → 报告落库 + 内存检查点） ----------
      if (!job.report) {
        job.stage = "analyze";
        job.updatedAt = Date.now();
        const { snapshot, events } = await deps.exportGame(gameId);
        job.snapshot = snapshot;
        const report = await runAnalysis(cfg, snapshot, events as GameEvent[]);
        await upsertAnalysis(gameId, report, cfg.model);
        job.report = report; // 内存检查点：此后任务死亡可跳过 analyze 直接续跑 distill
        job.updatedAt = Date.now();
        // 「自动心理检查」且本局无赛后讨论：复盘报告已生成——此刻自动开始心理检查
        deps.maybeAutoPsyCheck(
          gameId,
          (deps.registry.get(gameId)?.options ?? (ownerRow.setup as StoredSetup).options) as AdvancedOptions | undefined,
          "reportDone",
        );
      }

      // ---------- 阶段 2：distill 两段式（共通指南 → 版型指南，各自独立 scope 落库） ----------
      job.stage = "distill";
      job.updatedAt = Date.now();
      // 复活路径上快照可能不在内存（如外部构造的检查点任务）：回退到重新导出
      const snapshot = job.snapshot ?? (await deps.exportGame(gameId)).snapshot;
      const boardId = snapshot.boardId;
      const winnerLabel =
        snapshot.winner === "wolf" ? "狼人胜" : snapshot.winner === "good" ? "好人胜" : "胜负未知";

      // 段 1：共通经验（scope="common"）；commonDone 检查点命中则跳过（自愈重跑不重复落库）
      let commonGuide: string | null = null;
      if (!job.commonDone) {
        const latestCommon = await getLatestGuide(ownerId, "common");
        commonGuide = await runDistillCommon(cfg, latestCommon?.content ?? null, job.report);
        await insertGuideVersion({
          scope: "common",
          version: (latestCommon?.version ?? 0) + 1,
          content: commonGuide,
          gameId,
          note: `共通｜收录对局 ${gameId.slice(0, 8)}：${snapshot.boardName} ${winnerLabel}`,
          userId: ownerId,
        });
        job.commonDone = true; // 内存检查点：此后任务死亡可跳过共通段直接续跑版型段
        job.updatedAt = Date.now();
      } else {
        // 跳过共通段时仍需其最新内容，用于刷新注入缓存
        commonGuide = (await getLatestGuide(ownerId, "common"))?.content ?? null;
      }

      // 段 2：版型特定经验（scope=版型 id）
      const boardCtx = {
        boardName: snapshot.boardName,
        rolesSummary: BOARDS.find((b) => b.id === boardId)?.summary ?? snapshot.boardName,
        // 本版型规则文本：蒸馏 prompt 据此禁止与规则相悖的建议（如 12 人场女巫自救）
        rulesText: buildBoardRulesText(boardId),
      };
      const latestBoard = await getLatestGuide(ownerId, boardId);
      const boardGuide = await runDistillBoard(cfg, boardCtx, latestBoard?.content ?? null, job.report);
      await insertGuideVersion({
        scope: boardId,
        version: (latestBoard?.version ?? 0) + 1,
        content: boardGuide,
        gameId,
        note: `${snapshot.boardName}｜收录对局 ${gameId.slice(0, 8)}：${winnerLabel}`,
        userId: ownerId,
      });
      // 指南已更新：立即刷新该版型的注入缓存，后续决策用上最新版
      deps.guideCache.set(`${ownerId}:${boardId}`, {
        at: Date.now(),
        text: deps.combineGuideText(boardId, commonGuide ?? "", boardGuide),
      });
      job.stage = null;
      job.status = "done";
      job.updatedAt = Date.now();
      // 报告与两类认知指南均已落库、注入缓存已刷新，才允许解除复盘前置挂起。
      // 自动讨论由此直接续跑；手动讨论仅解除条件，不要求用户打开报告。
      await deps.resumePostGameAfterReview(gameId);
    } catch (err) {
      job.status = "failed";
      job.error = deps.errMessage(err).slice(0, 500); // 保留原始 API 错误，前端「分析失败 · 重试」可见
      job.updatedAt = Date.now();
      throw err;
    }
  }

  /** 配置了分析师且选择「自动生成」的对局，分出胜负后自动复盘并蒸馏进指南
   *（「手动生成」的对局在观察室由用户点击生成；失败只落系统事件，绝不上抛阻塞对局） */
  function triggerAutoAnalysis(gameId: string, rt: GameRuntime, snap: { day: number; phase: string }): void {
    if (!rt.analystAi || rt.analystAi.autoGenerate === false) return;
    const existingJob = analysisJobs.get(gameId);
    if (existingJob && (existingJob.status === "running" || existingJob.status === "done" || existingJob.status === "failed") && existingJob.stage !== null) return;
    const cfg = rt.analystAi;
    void (async () => {
      const existing = await getAnalysis(gameId).catch(() => null);
      if (existing?.report) return;
      // 二次闸门：首次查询期间已有触发者启动任务时，不再并发重复消费 AI 调用。
      if (analysisJobs.get(gameId)?.status === "running") return;
      await runAnalysisJob(gameId, cfg);
    })().catch(async (err) => {
      try {
        await appendEvents([
          {
            gameId,
            seq: ++rt.seq,
            day: snap.day,
            phase: snap.phase,
            type: "system",
            actor: null,
            actorLabel: null,
            title: "分析任务失败",
            content: `分析师复盘失败：${deps.errMessage(err).slice(0, 300)}`,
            thought: null,
            meta: null,
          },
        ]);
      } catch {
        /* 记日志失败也不再上抛 */
      }
    });
  }

  return { runAnalysisJob, triggerAutoAnalysis };
}
