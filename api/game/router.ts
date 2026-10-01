import { z } from "zod";
import { createRouter, publicQuery, authedProcedure } from "../middleware";
import { gameService } from "./service";
import { BOARDS } from "../../contracts/game";

const seatSchema = z.object({
  seat: z.number().int().min(1),
  provider: z.enum(["kimi", "openai", "deepseek", "custom", "anthropic"]),
  baseUrl: z.string(),
  model: z.string(),
  apiKey: z.string(),
});

export const gameRouter = createRouter({
  // 版型定义为静态契约：公开可读（未登录也可浏览版型）
  boards: publicQuery.query(() => BOARDS),

  create: authedProcedure
    .input(z.object({
      boardId: z.string(),
      seats: z.array(seatSchema),
      options: z.object({
        stepDelayMs: z.number().int().min(200).max(30000),
        phaseBreakMs: z.number().int().min(0).max(60000).optional(),
        sheriffEnabled: z.boolean(),
        allowSelfDestruct: z.boolean(),
        allowSurrender: z.boolean().optional(),
        speechRoundsLimit: z.number().int().min(1).max(5),
        // 必须显式声明：zod 默认剥离未知键，漏掉它会导致前端传的赛后讨论开关被静默丢弃、setup 里根本没有它
        postGameDiscuss: z.boolean().optional(),
        postGameAutoStart: z.boolean().optional(),
        postGameSpeechLimit: z.number().int().min(1).max(10).optional(),
        // AI 单决策总时限（0=不限制）
        aiTimeLimitSec: z.number().int().min(0).max(600).optional(),
        // 图书馆赛前学习开关与单座最长学习时间（不设下限）
        libraryEnabled: z.boolean().optional(),
        libraryMaxSec: z.number().int().min(1).max(3600).optional(),
        // 玩家人格可见度三档与 partial 档迷雾座位（必须显式声明：zod 默认剥离未知键）
        personaVisibility: z.enum(["full", "partial", "none"]).optional(),
        personaFogSeats: z.array(z.number().int().min(1)).optional(),
      }),
      analystAi: z.object({
        provider: z.enum(["kimi", "openai", "deepseek", "custom", "anthropic"]),
        baseUrl: z.string(),
        model: z.string(),
        apiKey: z.string(),
        // 必须显式声明：zod 默认剥离未知键，漏掉它会导致前端 autoGenerate:false 被静默丢弃、终局仍自动生成
        autoGenerate: z.boolean().optional(),
      }).nullable().optional(),
      // 胜率推测开关（必须显式声明：zod 默认剥离未知键）
      winRateEnabled: z.boolean().optional(),
      // 人格研究库：座位人格绑定（必须显式声明：zod 默认剥离未知键）
      seatPersonas: z
        .array(z.object({ seat: z.number().int().min(1), personaId: z.number().int().positive() }))
        .optional(),
    }))
    .mutation(({ input, ctx }) => gameService.createGame(input, ctx.user.id)),

  control: authedProcedure
    .input(z.object({ gameId: z.string(), action: z.enum(["start", "pause", "terminate", "stopPostGame"]) }))
    .mutation(({ input, ctx }) => gameService.control(input.gameId, input.action, ctx.user.id)),

  // 已结束对局补开赛后讨论：强制 postGameDiscuss 重放到断点，续跑生成赛后讨论
  startPostGame: authedProcedure
    .input(z.object({ gameId: z.string() }))
    .mutation(({ input, ctx }) => gameService.startPostGame(input.gameId, ctx.user.id)),

  // 赛前学习心得（图书馆对局）：按座位返回各 AI 的学习记录（观察者上帝视角可见）
  studyNotes: authedProcedure
    .input(z.object({ gameId: z.string() }))
    .query(({ input, ctx }) => gameService.studyNotes(input.gameId, ctx.user.id)),

  poll: authedProcedure
    .input(
      z.object({
        gameId: z.string(),
        afterSeq: z.number().int().min(0),
        lastSig: z.string().max(512).optional(),
        // 胜率推测增量游标（id > afterWinRateId 的评估记录）
        afterWinRateId: z.number().int().min(0).optional(),
      }),
    )
    .query(({ input, ctx }) =>
      gameService.poll(input.gameId, input.afterSeq, input.lastSig, ctx.user.id, input.afterWinRateId),
    ),

  list: authedProcedure.query(({ ctx }) => gameService.list(ctx.user.id)),

  export: authedProcedure
    .input(z.object({ gameId: z.string() }))
    .query(({ input, ctx }) => gameService.exportGame(input.gameId, ctx.user.id)),

  // 连通性测试：只向服务商 ping 用户自带 key，不触库，保持公开（登录前编辑存档也可用）
  aiTest: publicQuery
    .input(z.object({
      provider: z.enum(["kimi", "openai", "deepseek", "custom", "anthropic"]),
      baseUrl: z.string(),
      model: z.string(),
      apiKey: z.string(),
    }))
    .mutation(({ input }) => gameService.aiTest(input)),

  guide: authedProcedure.query(({ ctx }) => gameService.guide(ctx.user.id)),

  guideVersions: authedProcedure
    .input(z.object({ scope: z.string().min(1).max(32) }))
    .query(({ input, ctx }) => gameService.guideVersions(ctx.user.id, input.scope)),

  guideVersion: authedProcedure
    .input(z.object({ scope: z.string().min(1).max(32), version: z.number().int().min(1) }))
    .query(({ input, ctx }) => gameService.guideVersion(ctx.user.id, input.scope, input.version)),

  updateGuide: authedProcedure
    .input(z.object({ scope: z.string().min(1).max(32), content: z.string().min(1).max(20000) }))
    .mutation(({ input, ctx }) => gameService.updateGuide(ctx.user.id, input.scope, input.content)),

  analysis: authedProcedure
    .input(z.object({ gameId: z.string() }))
    .query(({ input, ctx }) => gameService.getAnalysis(input.gameId, ctx.user.id)),

  generateAnalysis: authedProcedure
    .input(z.object({
      gameId: z.string(),
      analystAi: z.object({
        provider: z.enum(["kimi", "openai", "deepseek", "custom", "anthropic"]),
        baseUrl: z.string(),
        model: z.string(),
        apiKey: z.string(),
      }).optional(),
    }))
    .mutation(({ input, ctx }) => gameService.generateAnalysis(input.gameId, ctx.user.id, input.analystAi)),

  // 人格研究库：本局人格座位的《心理尸检报告》（对局页「心理尸检」入口）
  personaReports: authedProcedure
    .input(z.object({ gameId: z.string() }))
    .query(({ input, ctx }) => gameService.personaReports(input.gameId, ctx.user.id)),
});
