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
  listPersonaCognitionNotes,
  setPersonaAutoCognition,
  updatePersonaCognitionNote,
  deletePersonaCognitionNote,
  listPersonas,
  updatePersona,
} from "./queries/personas";
import { personaInputSchema } from "../contracts/persona";
import { castPersona, researchPerson, runCastChain } from "./persona/caster";
import { getActiveCast, getActiveCasts, getCastProgress, runWithCastProgress, ackCast, castControl, discardCastDraft, hydrateCastDrafts } from "./persona/progress";
import { enqueueCasts, castApiIdentity } from "./persona/castQueue";
import { runCognitionWrite, cognitionWritingSince } from "./persona/cognition";
import { encryptSecret, decryptSecret } from "./lib/authCrypto";
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

/** 铸造参数检查点（起跑即落盘，apiKey 加密存储）：中断续铸的完整原料 */
async function saveCastParamsCheckpoint(
  castId: string,
  userId: number | string,
  payload: Record<string, unknown>,
): Promise<void> {
  const { upsertCastCheckpoint } = await import("./queries/personas");
  const encQuad = (q: { provider: string; baseUrl: string; model: string; apiKey: string }) => ({
    ...q,
    apiKey: encryptSecret(q.apiKey ?? ""),
  });
  const p = { ...payload } as Record<string, unknown>;
  for (const k of ["searchAi", "understandAi", "synthAi"]) {
    if (p[k]) p[k] = encQuad(p[k] as never);
  }
  await upsertCastCheckpoint(castId, "params", { ...p, userId }).catch(() => {
    /* 检查点落盘失败不阻塞铸造 */
  });
}

// 人格研究站：人格参数卡的增删改查（登录用户隔离；AI 铸造走 P2 铸魂师管线）
// 铁律1「人格量化」的参数结构由 contracts/persona.personaInputSchema 硬校验（全维度 0-100）
const personaRouter = createRouter({
  list: authedProcedure.query(async ({ ctx }) => {
    // 认知书写中徽标透出（内存台账 → ISO 时刻；无在飞书写为 null）
    const rows = await listPersonas(ctx.user.id);
    return rows.map((r) => {
      const at = cognitionWritingSince(r.id);
      return { ...r, cognitionWritingAt: at != null ? new Date(at).toISOString() : null };
    });
  }),
  get: authedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .query(({ input, ctx }) => getPersona(input.id, ctx.user.id)),
  // 详情一屏数据：卡 + 记忆 + 关系 + 漂移（详情弹窗单次往返）
  detail: authedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .query(async ({ input, ctx }) => {
      const card = await getPersona(input.id, ctx.user.id);
      if (!card) return null;
      const [memories, drift, cognitionNotes] = await Promise.all([
        listPersonaMemories(input.id, ctx.user.id),
        listPersonaDrift(input.id, ctx.user.id),
        listPersonaCognitionNotes(input.id, ctx.user.id),
      ]);
      return {
        card,
        memories: memories ?? [],
        relationships: [],
        drift: drift ?? [],
        relationshipHistory: [],
        incomingRelationships: [],
        cognitionNotes: cognitionNotes ?? [],
        // 认知书写中徽标透出（与列表同一内存台账；详情页据此常显「书写中」并续轮询）
        cognitionWritingAt: (() => {
          const at = cognitionWritingSince(input.id);
          return at != null ? new Date(at).toISOString() : null;
        })(),
      };
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
      // 统一走铸魂生产队列：单轮=入队 1 个（与批量/中途加入同一架构）；
      // 异步任务模式：立即返回 castId，铸造由队列滚动调度——单请求长任务不依赖长连接存活
      const castId = input.castId ?? randomUUID();
      void saveCastParamsCheckpoint(castId, ctx.user.id, {
        kind: "cast",
        name: input.name,
        source: input.source ?? null,
        hint: input.hint ?? null,
        searchAi: input.searchAi,
        understandAi: input.understandAi,
        synthAi: input.synthAi,
        web: input.web ?? null,
        deepRead: input.deepRead ?? null,
      });
      const [enq] = enqueueCasts(ctx.user.id, [
        {
          castId,
          name: input.name,
          // 该铸造占用的 API 身份集合（①②③去重）：队列按身份分组限流（同 API 最多 2 个铸造）
          apiKeys: [
            ...new Set([input.searchAi, input.understandAi, input.synthAi].map(castApiIdentity)),
          ],
          run: () =>
            castPersona(input.searchAi, input.understandAi, input.synthAi, input.name, input.source, input.hint, {
              web: input.web,
              deepRead: input.deepRead,
            }),
        },
      ]);
      return { castId: enq.castId };
    }),
  // 铸造进度轮询（铸魂师长任务的真实进度：阶段 label + 细节行 detail + 完成产物 result）
  castProgress: authedProcedure
    .input(z.object({ castId: z.string().trim().min(1).max(64) }))
    .query(async ({ input, ctx }) => {
      // 先水合持久化草稿（重启后内存登记处为空）：幂等、仅首次生效
      await hydrateCastDrafts();
      return getCastProgress(input.castId, ctx.user.id);
    }),
  // 找回最近铸造（进行中优先）——向导重开时恢复现场
  castActive: authedProcedure.query(async ({ ctx }) => {
    await hydrateCastDrafts();
    return getActiveCast(ctx.user.id);
  }),
  // 全部活跃铸造（进行中优先，上限 8 条）——人格研究站「生成中」卡片列表（批量并发铸造逐卡显示）；
  // 末尾并入已核销入库（saved）的草稿：清库唯一条件是用户主动删除，核销后留痕仍要在草稿箱可见
  castActives: authedProcedure.query(async ({ ctx }) => {
    await hydrateCastDrafts();
    const actives = getActiveCasts(ctx.user.id);
    try {
      const { listPersonaCastDrafts } = await import("./queries/personas");
      const rows = await listPersonaCastDrafts();
      const seen = new Set(actives.map((a) => a.castId));
      for (const r of rows) {
        if (r.status !== "saved" || seen.has(r.castId)) continue;
        if (r.userId !== null && String(r.userId) !== String(ctx.user.id)) continue;
        actives.push({
          castId: r.castId,
          name: r.name,
          label: "已入库 · 留痕保留",
          detail: "草稿与生成过程留痕保留在草稿箱，仅你主动删除才清除",
          startedAt: r.createdAt.getTime(),
          updatedAt: r.createdAt.getTime(),
          done: true,
          error: null,
          result: null,
          paused: false,
          saved: true,
        });
      }
    } catch {
      /* saved 并入失败不阻塞活跃列表 */
    }
    return actives;
  }),
  // 生成留痕（进度标记点+各阶段已落盘研究文本）：白名单组装，apiKey/地址永不透出
  castTrace: authedProcedure
    .input(z.object({ castId: z.string().trim().min(1).max(64) }))
    .query(async ({ input, ctx }) => {
      await hydrateCastDrafts();
      const { listCastCheckpoints, listPersonaCastDrafts } = await import("./queries/personas");
      const ck = await listCastCheckpoints(input.castId).catch(() => ({}) as Record<string, unknown>);
      const drafts = await listPersonaCastDrafts().catch(() => []);
      const draft = drafts.find((d) => d.castId === input.castId);
      if (draft && draft.userId !== null && String(draft.userId) !== String(ctx.user.id)) return null;
      const live = getCastProgress(input.castId, ctx.user.id);
      if (!draft && !live) return null;
      const TEXT_CAP = 20000;
      const cap = (s: unknown) => (typeof s === "string" ? s.slice(0, TEXT_CAP) : undefined);
      const stages: { key: string; label: string; available: boolean; text?: string }[] = [];
      const p = ck.params as Record<string, unknown> | undefined;
      if (p) {
        const ai = (q: unknown) => {
          const m = (q as { provider?: string; model?: string } | undefined)?.model;
          const pr = (q as { provider?: string } | undefined)?.provider;
          return m ? `${pr ?? "?"}:${m}` : "未配置";
        };
        stages.push({
          key: "params", label: "配置确认", available: true,
          text: [
            `人格名：${p.name ?? "?"}`,
            p.source ? `出处：${p.source}` : null,
            p.hint ? `消歧提示：${p.hint}` : null,
            `搜集 AI：${ai(p.searchAi)}；解读 AI：${ai(p.understandAi)}；整合 AI：${ai(p.synthAi)}`,
          ].filter(Boolean).join("\n"),
        });
      }
      const rs = ck.research as { name?: string; source?: string | null; hint?: string | null } | undefined;
      if (rs) stages.push({
        key: "research", label: "身份核对", available: true,
        text: [`锁定对象：${rs.name ?? "?"}`, rs.source ? `出处：${rs.source}` : null, rs.hint ? `消歧提示：${rs.hint}` : null].filter(Boolean).join("\n"),
      });
      const pool = ck.pool as { name?: string; source?: string | null; snippet?: string }[] | undefined;
      if (Array.isArray(pool) && pool.length > 0) stages.push({
        key: "pool", label: "素材检索", available: true,
        text: pool.slice(0, 20).map((c, i) => `${i + 1}. ${c.name ?? "?"}${c.source ? `（${c.source}）` : ""}${c.snippet ? `\n   ${String(c.snippet).slice(0, 200)}` : ""}`).join("\n"),
      });
      const dk = ck.dossier as { dossier?: string; webSearched?: boolean; offlineReason?: string } | undefined;
      if (dk?.dossier) stages.push({
        key: "dossier", label: "研究档案", available: true,
        text: `${dk.webSearched === false ? `（离线生成${dk.offlineReason ? `：${dk.offlineReason}` : ""}）\n\n` : ""}${cap(dk.dossier) ?? ""}`,
      });
      const rd = ck.reading as { reading?: string } | undefined;
      if (rd?.reading) stages.push({ key: "reading", label: "人格解读", available: true, text: cap(rd.reading) });
      const pts = ck.portraits as unknown[] | undefined;
      if (Array.isArray(pts) && pts.length > 0) stages.push({
        key: "portraits", label: "肖像甄选", available: true,
        text: `已甄选候选肖像 ${pts.length} 张（图像数据不回传，入库后可在人格卡查看定稿肖像）`,
      });
      const result = (draft?.result ?? live?.result) as { draft?: { profile?: { summary?: string; essence?: string } } } | null | undefined;
      if (result?.draft) stages.push({
        key: "draft", label: "整合定稿", available: true,
        text: ["草稿已铸成（完整参数卡在「核对草稿」中查看）", result.draft.profile?.summary ? `\n概要：${result.draft.profile.summary.slice(0, 500)}` : null].filter(Boolean).join("\n"),
      });
      return {
        castId: input.castId,
        name: draft?.name ?? live?.name ?? "",
        status: draft?.status ?? (live?.done ? (live.error ? "failed" : "done") : live?.paused ? "paused" : live?.interrupted ? "interrupted" : "running"),
        stages,
      };
    }),
  // 用户主动删除草稿（清库唯一通道）：条目+草稿+检查点全清
  castDraftDiscard: authedProcedure
    .input(z.object({ castId: z.string().trim().min(1).max(64) }))
    .mutation(({ input, ctx }) => ({ ok: discardCastDraft(input.castId, ctx.user.id) })),
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
      // 统一走铸魂生产队列：批量=入队 N 个，滚动并发窗（无旧分块的队头阻塞），
      // 中途加入（单轮或再来一批）无缝衔接
      const items = input.items.map((it) => ({ castId: randomUUID(), name: it.name.trim(), hint: it.hint }));
      for (const it of items) {
        void saveCastParamsCheckpoint(it.castId, ctx.user.id, {
          kind: "chain",
          name: it.name,
          source: null,
          hint: it.hint ?? null,
          searchAi: input.searchAi,
          understandAi: input.understandAi,
          synthAi: input.synthAi,
          web: input.web ?? null,
          deepRead: input.deepRead ?? null,
        });
      }
      enqueueCasts(
        ctx.user.id,
        items.map((it) => ({
          castId: it.castId,
          name: it.name,
          apiKeys: [
            ...new Set([input.searchAi, input.understandAi, input.synthAi].map(castApiIdentity)),
          ],
          run: () =>
            runCastChain(input.searchAi, input.understandAi, input.synthAi, it.name, it.hint, {
              web: input.web,
              deepRead: input.deepRead,
            }),
        })),
      );
      return { items };
    }),
  // 赛后自动书写开关（认知笔记页签；开=该局心理检查完后由参赛绑定模型自动书写）
  setAutoCognition: authedProcedure
    .input(
      z.object({
        personaId: z.number().int().positive(),
        enabled: z.boolean(),
        includeReports: z.boolean().optional(),
        includeDrift: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      await setPersonaAutoCognition(input.personaId, ctx.user.id, {
        enabled: input.enabled,
        includeReports: input.includeReports === true,
        includeDrift: input.includeDrift === true,
      });
      return { ok: true };
    }),
  // 记录认知（自我认知笔记书写：两程管线，参数后台塑形、术语零容忍；同步等待，失败抛错由前端提示）
  writeCognition: authedProcedure
    .input(
      z.object({
        personaId: z.number().int().positive(),
        cfg: z.object({
          provider: z.enum(["kimi", "openai", "deepseek", "custom", "anthropic"]),
          baseUrl: z.string(),
          model: z.string(),
          apiKey: z.string(),
        }),
        includeReports: z.boolean().optional(),
        includeDrift: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      // 后台书写（立即返回）：多人格可同时记录认知，互不等待；完成品出现在沿革里
      void runCognitionWrite({
        personaId: input.personaId,
        userId: ctx.user.id,
        cfg: { seat: 0, ...input.cfg },
        includeReports: input.includeReports === true,
        includeDrift: input.includeDrift === true,
      }).catch(() => {
        /* 失败不落库即无新篇，前端轮询超时自然收敛 */
      });
      return { started: true };
    }),
  // 编辑认知笔记（最新篇被编辑时现役认知同步更新）
  updateCognitionNote: authedProcedure
    .input(z.object({ noteId: z.number().int().positive(), personaId: z.number().int().positive(), content: z.string().trim().min(1).max(600) }))
    .mutation(async ({ input, ctx }) => {
      await updatePersonaCognitionNote(input.noteId, input.personaId, ctx.user.id, input.content);
      return { ok: true };
    }),
  // 删除认知笔记（最新篇被删时现役认知回退到新的最新篇）
  deleteCognitionNote: authedProcedure
    .input(z.object({ noteId: z.number().int().positive(), personaId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      await deletePersonaCognitionNote(input.noteId, input.personaId, ctx.user.id);
      return { ok: true };
    }),
  // 核对入库核销（草稿转 saved 留痕保留，不删除——清库唯一通道是 castDraftDiscard）
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
  // 断点续铸（中断条目「继续铸造」）：从检查点恢复参数与各阶段产物，跳已完成阶段
  resumeCast: authedProcedure
    .input(z.object({ castId: z.string().trim().min(1).max(64) }))
    .mutation(async ({ input, ctx }) => {
      const { listCastCheckpoints, deleteCastCheckpoints } = await import("./queries/personas");
      const ck = await listCastCheckpoints(input.castId);
      const params = ck.params as {
        kind?: string; name?: string; source?: string | null; hint?: string | null;
        searchAi?: never; understandAi?: never; synthAi?: never;
        web?: never; deepRead?: never; userId?: number | string;
      } | undefined;
      if (!params?.name || !params.searchAi) return { ok: false };
      if (params.userId != null && String(params.userId) !== String(ctx.user.id)) return { ok: false };
      const decQuad = (q: { provider: string; baseUrl: string; model: string; apiKey: string }) => ({
        ...q, apiKey: decryptSecret(q.apiKey ?? ""),
      });
      const searchAi = decQuad(params.searchAi as never) as never;
      const understandAi = decQuad(params.understandAi as never) as never;
      const synthAi = decQuad(params.synthAi as never) as never;
      const dossierCk = ck.dossier as { dossier?: string; webSearched?: boolean; offlineReason?: string } | undefined;
      const researchCk = ck.research as { name?: string; source?: string | null } | undefined;
      const resume = {
        pool: ck.pool as never,
        dossier: dossierCk?.dossier,
        webSearched: dossierCk?.webSearched,
        offlineReason: dossierCk?.offlineReason,
        reading: (ck.reading as { reading?: string } | undefined)?.reading,
        downloaded: ck.portraits as never,
      };
      const opts = { web: params.web as never, deepRead: params.deepRead as never, resume };
      // 链式（批量自动消歧）且尚无消歧检查点 → 重跑链；否则直跑铸造主流程
      const run =
        params.kind === "chain" && !researchCk
          ? () => runCastChain(searchAi, understandAi, synthAi, params.name!, params.hint ?? undefined, opts)
          : () =>
              castPersona(
                searchAi, understandAi, synthAi,
                researchCk?.name ?? params.name!,
                params.source ?? researchCk?.source ?? undefined,
                params.hint ?? undefined,
                opts,
              );
      // 续铸同 castId：中断占位条目被 startCastJob 的新条目覆盖
      enqueueCasts(ctx.user.id, [
        {
          castId: input.castId,
          name: params.name!,
          apiKeys: [...new Set([searchAi, understandAi, synthAi].map(castApiIdentity))],
          run,
        },
      ]);
      void deleteCastCheckpoints; // 检查点即留痕长期保留（清库唯一通道=用户主动删除；续铸再断仍可再续）
      return { ok: true };
    }),
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
