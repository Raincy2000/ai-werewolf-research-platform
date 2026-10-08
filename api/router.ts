import { z } from "zod";
import { createRouter, publicQuery, authedProcedure } from "./middleware";
import { gameRouter } from "./game/router";
import { authRouter } from "./auth/router";
import { createPreset, deletePreset, listPresets, updatePreset } from "./queries/presets";
import {
  deleteLibraryDoc,
  insertLibraryDoc,
  listLibraryDocs,
} from "./queries/library";
import {
  createPersona,
  deletePersona,
  getPersona,
  listPersonaDrift,
  listPersonaMemories,
  listPersonaRelationships,
  listPersonas,
  updatePersona,
} from "./queries/personas";
import { personaInputSchema } from "../contracts/persona";
import { castPersona, researchPerson, runCastChain } from "./persona/caster";
import { getActiveCast, getActiveCasts, getCastProgress, runWithCastProgress, startCastJob, ackCast, castControl } from "./persona/progress";
import { randomUUID } from "node:crypto";
import { extractTextFromUpload } from "./lib/fileExtract";

// API 存档的输入校验（provider 与座位配置同一枚举）
const presetInputSchema = z.object({
  name: z.string().trim().min(1, "存档名称不能为空").max(64),
  provider: z.enum(["kimi", "openai", "deepseek", "custom", "anthropic"]),
  baseUrl: z.string().max(256),
  model: z.string().max(128),
  apiKey: z.string().max(256),
});

// API 存档：登录用户的多套 AI 接入配置（key AES-GCM 加密落库、按用户隔离），
// 供创建对局时一键取用到选中座位，免去重复输入；跨设备登录即同步
const presetRouter = createRouter({
  list: authedProcedure.query(({ ctx }) => listPresets(ctx.user.id)),
  create: authedProcedure
    .input(presetInputSchema)
    .mutation(({ input, ctx }) => createPreset(ctx.user.id, input)),
  update: authedProcedure
    .input(z.object({ id: z.number().int().positive(), patch: presetInputSchema.partial() }))
    .mutation(({ input, ctx }) => updatePreset(input.id, ctx.user.id, input.patch)),
  remove: authedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(({ input, ctx }) => deletePreset(input.id, ctx.user.id)),
});

// 图书馆：登录用户上传/管理赛前学习资料（AI 对局前置知识库；文本服务端提取入库）
const libraryRouter = createRouter({
  list: authedProcedure.query(({ ctx }) => listLibraryDocs(ctx.user.id)),
  // 上传：base64 文件内容 + 文件名，服务端按格式提取纯文本（docx 解包、文本类直读）
  upload: authedProcedure
    .input(
      z.object({
        name: z.string().trim().min(1).max(128),
        contentBase64: z.string().max(8_000_000), // ≈6MB 原文件（AI 选择性查阅，容量不设业务上限）
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const { format, content } = extractTextFromUpload(input.name, input.contentBase64);
      const id = await insertLibraryDoc({
        userId: ctx.user.id,
        name: input.name,
        format,
        content,
        sizeBytes: Math.floor(input.contentBase64.length * 0.75),
      });
      return { id, chars: content.length };
    }),
  remove: authedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(({ input, ctx }) => deleteLibraryDoc(input.id, ctx.user.id)),
  // 全文读取（预览用）
  read: authedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .query(async ({ input, ctx }) => {
      const { getLibraryDoc } = await import("./queries/library");
      const doc = await getLibraryDoc(input.id, ctx.user.id);
      return doc
        ? { id: doc.id, name: doc.name, format: doc.format, sizeBytes: doc.sizeBytes, content: doc.content }
        : null;
    }),
});

// 人格研究库：人格参数卡的增删改查（登录用户隔离；AI 铸造走 P2 铸魂师管线）
// 铁律1「人格量化」的参数结构由 contracts/persona.personaInputSchema 硬校验（全维度 0-100）
const personaRouter = createRouter({
  list: authedProcedure.query(({ ctx }) => listPersonas(ctx.user.id)),
  get: authedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .query(({ input, ctx }) => getPersona(input.id, ctx.user.id)),
  // 详情一屏数据：卡 + 记忆 + 关系 + 漂移（详情弹窗单次往返）
  detail: authedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .query(async ({ input, ctx }) => {
      const card = await getPersona(input.id, ctx.user.id);
      if (!card) return null;
      const [memories, relationships, drift] = await Promise.all([
        listPersonaMemories(input.id, ctx.user.id),
        listPersonaRelationships(input.id, ctx.user.id),
        listPersonaDrift(input.id, ctx.user.id),
      ]);
      return { card, memories: memories ?? [], relationships: relationships ?? [], drift: drift ?? [] };
    }),
  create: authedProcedure
    .input(personaInputSchema)
    .mutation(({ input, ctx }) => createPersona(ctx.user.id, input, "manual")),
  // 铸魂师第一步：人名消歧检索（Kimi 联网；其他 provider 退化为内部知识并附 notice）
  research: authedProcedure
    .input(
      z.object({
        name: z.string().trim().min(1).max(64),
        hint: z.string().trim().max(200).optional(),
        searchAi: z.object({
          provider: z.enum(["kimi", "openai", "deepseek", "custom", "anthropic"]),
          baseUrl: z.string(),
          model: z.string(),
          apiKey: z.string(),
        }),
        // 联网检索开关（①搜集阶段；默认开）
        webSearch: z.boolean().optional(),
        // 进度轮询标识（前端生成 uuid，铸造期间轮询 persona.castProgress 取真实进度）
        castId: z.string().trim().min(1).max(64).optional(),
      }),
    )
    .mutation(({ input }) =>
      runWithCastProgress(input.castId, () =>
        researchPerson(input.searchAi, input.name, input.hint, { web: input.webSearch }),
      ),
    ),
  // 铸魂师三步铸造：①搜集（研究档案）→ ②深读（人格解读）→ ③整合（完整档案+量化，未入库）
  cast: authedProcedure
    .input(
      z.object({
        name: z.string().trim().min(1).max(64),
        source: z.string().trim().max(128).optional(),
        hint: z.string().trim().max(200).optional(),
        searchAi: z.object({
          provider: z.enum(["kimi", "openai", "deepseek", "custom", "anthropic"]),
          baseUrl: z.string(),
          model: z.string(),
          apiKey: z.string(),
        }),
        understandAi: z.object({
          provider: z.enum(["kimi", "openai", "deepseek", "custom", "anthropic"]),
          baseUrl: z.string(),
          model: z.string(),
          apiKey: z.string(),
        }),
        synthAi: z.object({
          provider: z.enum(["kimi", "openai", "deepseek", "custom", "anthropic"]),
          baseUrl: z.string(),
          model: z.string(),
          apiKey: z.string(),
        }),
        // 分阶段联网开关（默认全开）与深读深度（默认双开；快速模式双关）——必须显式声明（zod 剥离未知键）
        web: z
          .object({
            stage1: z.boolean().optional(),
            stage2: z.boolean().optional(),
            stage3: z.boolean().optional(),
          })
          .optional(),
        deepRead: z
          .object({
            segmented: z.boolean().optional(),
            selfCritique: z.boolean().optional(),
          })
          .optional(),
        // 进度轮询标识（前端生成 uuid，铸造期间轮询 persona.castProgress 取真实进度）
        castId: z.string().trim().min(1).max(64).optional(),
      }),
    )
    .mutation(({ input, ctx }) => {
      // 异步任务模式：立即返回 castId，铸造在后台跑——单请求长任务不再依赖长连接存活
      // （Node requestTimeout/网络抖动曾致「铸造途中界面消失、结果无法送达」）
      const castId = input.castId ?? randomUUID();
      startCastJob(castId, ctx.user.id, input.name, () =>
        castPersona(input.searchAi, input.understandAi, input.synthAi, input.name, input.source, input.hint, {
          web: input.web,
          deepRead: input.deepRead,
        }),
      );
      return { castId };
    }),
  // 铸造进度轮询（铸魂师长任务的真实进度：阶段 label + 细节行 detail + 完成产物 result）
  castProgress: authedProcedure
    .input(z.object({ castId: z.string().trim().min(1).max(64) }))
    .query(({ input, ctx }) => getCastProgress(input.castId, ctx.user.id)),
  // 找回最近铸造（进行中优先）——向导重开时恢复现场
  castActive: authedProcedure.query(({ ctx }) => getActiveCast(ctx.user.id)),
  // 全部活跃铸造（进行中优先，上限 8 条）——人格研究库「生成中」卡片列表（批量并发铸造逐卡显示）
  castActives: authedProcedure.query(({ ctx }) => getActiveCasts(ctx.user.id)),
  // 批量并发铸造：每人一条任务链（联网消歧自动取首候选→三步铸造），并发闸门 2（防高峰限流）
  castBatch: authedProcedure
    .input(
      z.object({
        items: z
          .array(
            z.object({
              name: z.string().trim().min(1).max(64),
              hint: z.string().trim().max(200).optional(),
            }),
          )
          .min(1)
          .max(12),
        searchAi: z.object({
          provider: z.enum(["kimi", "openai", "deepseek", "custom", "anthropic"]),
          baseUrl: z.string(),
          model: z.string(),
          apiKey: z.string(),
        }),
        understandAi: z.object({
          provider: z.enum(["kimi", "openai", "deepseek", "custom", "anthropic"]),
          baseUrl: z.string(),
          model: z.string(),
          apiKey: z.string(),
        }),
        synthAi: z.object({
          provider: z.enum(["kimi", "openai", "deepseek", "custom", "anthropic"]),
          baseUrl: z.string(),
          model: z.string(),
          apiKey: z.string(),
        }),
        // 分阶段联网开关与深读深度（与单人铸造同构；必须显式声明：zod 默认剥离未知键）
        web: z
          .object({
            stage1: z.boolean().optional(),
            stage2: z.boolean().optional(),
            stage3: z.boolean().optional(),
          })
          .optional(),
        deepRead: z
          .object({
            segmented: z.boolean().optional(),
            selfCritique: z.boolean().optional(),
          })
          .optional(),
      }),
    )
    .mutation(({ input, ctx }) => {
      const items = input.items.map((it) => ({ castId: randomUUID(), name: it.name.trim(), hint: it.hint }));
      // 并发闸门：同时最多 2 个铸造任务（单个铸造的②四段本身已多路并发，闸门防高峰限流）
      void (async () => {
        const CONCURRENCY = 2;
        for (let i = 0; i < items.length; i += CONCURRENCY) {
          await Promise.all(
            items.slice(i, i + CONCURRENCY).map((it) =>
              startCastJob(it.castId, ctx.user.id, it.name, () =>
                runCastChain(input.searchAi, input.understandAi, input.synthAi, it.name, it.hint, {
                  web: input.web,
                  deepRead: input.deepRead,
                }),
              ),
            ),
          );
        }
      })();
      return { items };
    }),
  // 取走/放弃草稿后确认（条目清除，不再恢复）
  castAck: authedProcedure
    .input(z.object({ castId: z.string().trim().min(1).max(64) }))
    .mutation(({ input }) => {
      ackCast(input.castId);
      return { ok: true };
    }),
  // 铸造控制：暂停/继续/终止（终止=取消并删除整个铸造流程）
  castControl: authedProcedure
    .input(
      z.object({
        castId: z.string().trim().min(1).max(64),
        action: z.enum(["pause", "resume", "cancel"]),
      }),
    )
    .mutation(({ input, ctx }) => ({ ok: castControl(input.castId, ctx.user.id, input.action) })),
  // 从链接抓取肖像（编辑器「从链接获取图片」；服务端下载转 data URL，规避跨域）
  fetchPortrait: authedProcedure
    .input(z.object({ url: z.string().trim().url().max(2000) }))
    .mutation(async ({ input }) => {
      const { fetchPortraitFromPage, fetchImageAsDataUrl } = await import("./persona/portrait");
      // 直接是图片链接 → 下载转 data URL；页面链接 → 提取 og:image 再下载
      const imageData = /\.(jpe?g|png|webp|gif)(\?|#|$)/i.test(input.url)
        ? await fetchImageAsDataUrl(input.url)
        : await fetchPortraitFromPage(input.url);
      return { imageData };
    }),
  // 铸造草稿确认入库（source="ai-cast"）
  createCasted: authedProcedure
    .input(personaInputSchema)
    .mutation(({ input, ctx }) => createPersona(ctx.user.id, input, "ai-cast")),
  update: authedProcedure
    .input(z.object({ id: z.number().int().positive(), patch: personaInputSchema.partial() }))
    .mutation(({ input, ctx }) => updatePersona(input.id, ctx.user.id, input.patch)),
  remove: authedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(({ input, ctx }) => deletePersona(input.id, ctx.user.id)),
  // 回收站：软删列表（先惰性清理 30 天过期项）
  trash: authedProcedure.query(async ({ ctx }) => {
    const { listPersonaTrash } = await import("./queries/personas");
    return listPersonaTrash(ctx.user.id);
  }),
  // 回收站还原（记忆/关系/漂移/报告本就连体保留，原样回来）
  restore: authedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const { restorePersona } = await import("./queries/personas");
      return restorePersona(input.id, ctx.user.id);
    }),
  // 回收站彻底删除（级联清除记忆/关系/漂移；心理检查报告作为研究档案保留）
  destroy: authedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const { destroyPersona } = await import("./queries/personas");
      return destroyPersona(input.id, ctx.user.id);
    }),
  // 该人格的全部《心理检查报告》（详情页「心理检查报告」页签）
  reports: authedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .query(async ({ input, ctx }) => {
      const { listPersonaReports } = await import("./queries/personas");
      return (await listPersonaReports(input.id, ctx.user.id)) ?? [];
    }),
});

export const appRouter = createRouter({
  ping: publicQuery.query(() => ({ ok: true, ts: Date.now() })),
  auth: authRouter,
  game: gameRouter,
  preset: presetRouter,
  library: libraryRouter,
  persona: personaRouter,
});

export type AppRouter = typeof appRouter;
