// ============================================================
// 关系网 tRPC 路由（§27/§29/§30）
//
// 2026-10-22 审计修复（P0-1）：
// - 所有读取/写入先过 api/network/guards 的租户归属校验，禁止跨账户 IDOR
// - graph 只返回当前用户名下人格发出的关系；节点再按 userId/deletedAt 过滤
// - 补完任务 status/pause/cancel/resume 校验 job.userId
// - 新增 network.rsqItems（RSQ 问卷渲染）与 manual canon 的 age/place 字段
// ============================================================
import { z } from "zod";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { createRouter, authedProcedure } from "../middleware";
import { getDb } from "../queries/connection";
import { personas, personaRelations, relationCompletionJobs } from "../../db/schema";
import { listRelations } from "./repo/relationRepo";
import { createWeaveJob, weaveRelations, getCompletionStatus, listCompletionJobs, resumeCompletion } from "./weave";
import { cancelJobRecord, finishJob } from "./jobControl";
import { scoreRSQ, listRsqItems, type RSQFeedback } from "../persona/rsq";
import { toRadarData } from "../persona/rsqInterpreter";
import { saveRSQResponse, getLatestRSQ, listRSQHistory, listLatestRSQFor, rsqCoverage } from "./repo/rsqRepo";
import {
  listCanonLog,
  addManualCanonEvent,
  updateCanonEvent,
  deleteCanonEvent,
  canonCoverage,
  listBackfillJobs,
  listValleyHistory,
  reorderCanonEvents,
} from "./repo/canonLogRepo";
import { backfillCanonLog } from "../persona/canonBackfill";
import { writeRelationRow, correctRelation, applyRelationColumns } from "./writeModel";
import { RELATION_KINDS, RELATION_FORMS, RELATION_KIND_TO_FORM } from "../../contracts/interpersonal";
import {
  assertOwnedPersona,
  assertOwnedPersonas,
  assertOwnedCanonEvent,
  assertOwnedCompletionJob,
  allOwnedPersonaIds,
} from "./guards";
import { listPresets } from "../queries/presets";

const personaIdSchema = z.number().int().positive();

export const networkRouter = createRouter({
  /** RSQ 问卷题目（前端填写用；L/M/S 三档电池） */
  rsqItems: authedProcedure
    .input(z.object({ level: z.enum(["L", "M", "S"]).optional() }).optional())
    .query(({ input }) => listRsqItems(input?.level ?? "L")),

  /** 关系网图（可视化主视图）：只返回当前用户人格发出的关系 */
  graph: authedProcedure
    .input(z.object({ layer: z.enum(["canon", "vale", "all"]).optional() }).optional())
    .query(async ({ input, ctx }) => {
      const ownIds = await allOwnedPersonaIds(ctx.user.id);
      const layer = input?.layer ?? "all";
      if (ownIds.length === 0) return { edges: [], nodes: [], nodeIds: [] };
      const db = getDb();
      const conds = [
        eq(personaRelations.status, "active"),
        inArray(personaRelations.fromPersonaId, ownIds),
      ];
      if (layer !== "all") conds.push(eq(personaRelations.layer, layer));
      const rows: any[] = await db.select().from(personaRelations).where(and(...conds));
      const edges = rows.map((r: any) => ({
        id: r.id,
        from: r.fromPersonaId,
        to: r.toPersonaId,
        toName: r.toName,
        kind: r.kind,
        form: r.form,
        layer: r.layer,
        positivity: r.positivity ?? 0,
        negativity: r.negativity ?? 0,
        trust: r.trust ?? 50,
        involvement: Math.max(r.positivity ?? 0, r.negativity ?? 0),
        ambivalence: Math.min(r.positivity ?? 0, r.negativity ?? 0),
        closeness: r.closeness ?? 0,
        dependence: r.dependence ?? 0,
        reciprocity: r.reciprocity ?? 0,
        powerBalance: r.powerBalance ?? 0,
        formality: r.formality ?? 0,
        commitment: r.commitment ?? 0,
        dangling: r.toPersonaId === 0,
      }));
      type Edge = (typeof edges)[number];
      const ids = [
        ...new Set([
          ...edges.map((e: Edge) => e.from),
          ...edges.filter((e: Edge) => !e.dangling).map((e: Edge) => e.to),
        ]),
      ];
      const nodeRows: any[] = ids.length
        ? await db
            .select({ id: personas.id, name: personas.name, source: personas.source, imageData: personas.imageData })
            .from(personas)
            .where(and(inArray(personas.id, ids), eq(personas.userId, ctx.user.id), isNull(personas.deletedAt)))
        : [];
      const nodes = nodeRows.map((n: any) => ({ id: n.id, name: n.name, source: n.source, image: n.imageData ?? null }));
      return { edges, nodes, nodeIds: ids };
    }),

  /** 单人格发出的关系（详情页用；校验归属） */
  of: authedProcedure
    .input(z.object({ personaId: personaIdSchema }))
    .query(async ({ input, ctx }) => {
      await assertOwnedPersona(ctx.user.id, input.personaId);
      return listRelations({ fromPersonaId: input.personaId, includeDangling: true });
    }),

  /** 启动关系补完（编织） */
  startCompletion: authedProcedure
    .input(
      z.object({
        personaIds: z.array(personaIdSchema).max(200).optional(),
        apiPresetId: z.number().int().positive().nullable().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      if (input.personaIds?.length) await assertOwnedPersonas(ctx.user.id, input.personaIds);
      if (!input.apiPresetId) {
        return { jobId: 0, error: "请选择存档中的 API：补完需要联网检索原世界关系网" };
      }
      // 校验 API 存档归属
      const presets = await listPresets(String(ctx.user.id));
      if (!presets.some((p) => p.id === input.apiPresetId)) {
        return { jobId: 0, error: "API 存档不存在或不属于当前账户" };
      }
      const created: any = await createWeaveJob({
        userId: ctx.user.id,
        personaIds: input.personaIds,
        apiPresetId: input.apiPresetId ?? null,
      });
      const jobId = typeof created === "number" ? created : Number(created?.jobId ?? 0);
      const reused = typeof created === "object" && created?.reused === true;
      if (!reused) {
        void weaveRelations({
          userId: ctx.user.id,
          personaIds: input.personaIds,
          apiPresetId: input.apiPresetId,
          allowWeb: true,
          jobId,
        }).catch(async (e) => {
          const msg = e instanceof Error ? e.message : String(e);
          try {
            // CAS 收尾：不覆盖并发 cancelled（复用 T2 的统一 finishJob 语义）
            await finishJob(jobId, "failed", {
              progress: JSON.stringify({ phase: "failed", reason: msg }),
              stats: JSON.stringify({ reason: msg }),
              finishedAt: new Date(),
            });
          } catch {
            /* 兜底失败也无计可施 */
          }
        });
      }
      return { jobId, reused: reused || undefined };
    }),

  /** 补完任务状态（校验 job 归属；僵尸自愈由 weave.getCompletionStatus 完成） */
  completionStatus: authedProcedure
    .input(z.object({ jobId: z.number().int().positive() }))
    .query(async ({ input, ctx }) => {
      await assertOwnedCompletionJob(ctx.user.id, input.jobId);
      const st = await getCompletionStatus(input.jobId, String(ctx.user.id));
      if (!st) return null;
      return st;
    }),

  /** 补完任务列表（最近 20 条；关闭弹窗/重启后仍可见可操作） */
  listCompletionJobs: authedProcedure.query(async ({ ctx }) => listCompletionJobs(String(ctx.user.id))),

  /** 继续已暂停/失败的任务（从 scope 自恢复 personaIds/apiPresetId） */
  resumeCompletion: authedProcedure
    .input(z.object({ jobId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      await assertOwnedCompletionJob(ctx.user.id, input.jobId);
      return resumeCompletion(input.jobId, String(ctx.user.id));
    }),

  /** 暂停补完（保留进度，可 resume） */
  pauseCompletion: authedProcedure
    .input(z.object({ jobId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      await assertOwnedCompletionJob(ctx.user.id, input.jobId);
      const db = getDb();
      await db
        .update(relationCompletionJobs)
        .set({ status: "paused" })
        .where(
          and(
            eq(relationCompletionJobs.id, input.jobId),
            eq(relationCompletionJobs.userId, String(ctx.user.id)),
            eq(relationCompletionJobs.status, "running"),
          ),
        );
      return { ok: true };
    }),

  /** 终止补完（不可继续；DB→cancelled + abort 内存调用链） */
  cancelCompletion: authedProcedure
    .input(z.object({ jobId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      await assertOwnedCompletionJob(ctx.user.id, input.jobId);
      const ok = await cancelJobRecord(input.jobId);
      return { ok };
    }),

  // ============================================================
  // L2 主观层：RSQ 关系自陈测评
  // ============================================================

  submitRSQ: authedProcedure
    .input(
      z.object({
        fromPersonaId: personaIdSchema,
        toPersonaId: personaIdSchema,
        raw: z.record(z.string(), z.number().int().min(1).max(7)),
        selfSummary: z.string().max(200).nullable().optional(),
        feedback: z
          .object({
            affect: z.number(),
            willingness: z.number(),
            perceivedDepth: z.number(),
            hardestItems: z.array(z.object({ itemNo: z.number().nullable(), reason: z.string(), tag: z.string() })),
            missingDimensions: z.array(z.object({ suggestion: z.string(), possibleDimension: z.string() })),
          })
          .nullable()
          .optional(),
        behavioralGap: z.number().min(0).max(1).optional(),
        gameId: z.string().nullable().optional(),
        batteryLevel: z.enum(["L", "M", "S"]).optional(),
        model: z.string().nullable().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      if (input.fromPersonaId === input.toPersonaId) {
        throw new Error("不能对自己填写关系测评");
      }
      await assertOwnedPersonas(ctx.user.id, [input.fromPersonaId, input.toPersonaId]);
      const rawNum: Record<number, number> = {};
      for (const [k, v] of Object.entries(input.raw)) {
        const n = Number(k);
        if (Number.isFinite(n)) rawNum[n] = v;
      }
      const result = scoreRSQ(rawNum, {
        behavioralGap: input.behavioralGap,
        feedback: (input.feedback ?? null) as RSQFeedback | null,
        selfSummary: input.selfSummary ?? null,
      });
      const id = await saveRSQResponse({
        fromPersonaId: input.fromPersonaId,
        toPersonaId: input.toPersonaId,
        gameId: input.gameId ?? null,
        batteryLevel: input.batteryLevel ?? "L",
        result,
        model: input.model ?? null,
      });
      return { id, result, radar: toRadarData(result.dims) };
    }),

  latestRSQ: authedProcedure
    .input(z.object({ fromPersonaId: personaIdSchema, toPersonaId: personaIdSchema }))
    .query(async ({ input, ctx }) => {
      await assertOwnedPersonas(ctx.user.id, [input.fromPersonaId, input.toPersonaId]);
      const rec = await getLatestRSQ(input.fromPersonaId, input.toPersonaId);
      if (!rec) return null;
      return { ...rec, radar: toRadarData(rec.dims) };
    }),

  rsqHistory: authedProcedure
    .input(
      z.object({
        fromPersonaId: personaIdSchema,
        toPersonaId: personaIdSchema,
        order: z.enum(["asc", "desc"]).optional(),
        limit: z.number().int().positive().max(200).optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      await assertOwnedPersonas(ctx.user.id, [input.fromPersonaId, input.toPersonaId]);
      const list = await listRSQHistory(input.fromPersonaId, input.toPersonaId, {
        order: input.order,
        limit: input.limit,
      });
      return list.map((r) => ({ ...r, radar: toRadarData(r.dims) }));
    }),

  rsqLatestFor: authedProcedure
    .input(z.object({ fromPersonaId: personaIdSchema }))
    .query(async ({ input, ctx }) => {
      await assertOwnedPersona(ctx.user.id, input.fromPersonaId);
      const list = await listLatestRSQFor(input.fromPersonaId);
      return list.map((r) => ({ ...r, radar: toRadarData(r.dims) }));
    }),

  /** 测评覆盖率（按账户隔离） */
  rsqCoverage: authedProcedure.query(async ({ ctx }) => rsqCoverage(ctx.user.id)),

  // ============================================================
  // L1 现实层：单视角关系记忆
  // ============================================================

  canonLog: authedProcedure
    .input(
      z.object({
        personaId: personaIdSchema,
        aboutPersonaId: personaIdSchema,
        order: z.enum(["asc", "desc"]).optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      await assertOwnedPersonas(ctx.user.id, [input.personaId, input.aboutPersonaId]);
      return listCanonLog(input.personaId, input.aboutPersonaId, { order: input.order });
    }),

  valleyHistory: authedProcedure
    .input(z.object({ personaId: personaIdSchema, aboutPersonaId: personaIdSchema }))
    .query(async ({ input, ctx }) => {
      await assertOwnedPersonas(ctx.user.id, [input.personaId, input.aboutPersonaId]);
      return listValleyHistory(input.personaId, input.aboutPersonaId);
    }),

  /** 手动补充一条现实记忆（无需核查） */
  addCanonEvent: authedProcedure
    .input(
      z.object({
        personaId: personaIdSchema,
        aboutPersonaId: personaIdSchema,
        era: z.string().min(1).max(64),
        eventText: z.string().min(1).max(400),
        feeling: z.string().min(1).max(1200),
        impact: z.string().max(200).nullable().optional(),
        age: z.number().int().min(0).max(200).nullable().optional(),
        place: z.string().max(40).nullable().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      await assertOwnedPersonas(ctx.user.id, [input.personaId, input.aboutPersonaId]);
      return addManualCanonEvent(input);
    }),

  updateCanonEvent: authedProcedure
    .input(
      z.object({
        id: z.number().int().positive(),
        patch: z.object({
          era: z.string().max(64).optional(),
          eventText: z.string().max(400).optional(),
          feeling: z.string().max(1200).optional(),
          impact: z.string().max(200).nullable().optional(),
          age: z.number().int().min(0).max(200).nullable().optional(),
          place: z.string().max(40).nullable().optional(),
        }),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      await assertOwnedCanonEvent(ctx.user.id, input.id);
      await updateCanonEvent(input.id, input.patch);
      return { ok: true };
    }),

  deleteCanonEvent: authedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      await assertOwnedCanonEvent(ctx.user.id, input.id);
      await deleteCanonEvent(input.id);
      return { ok: true };
    }),

  /** 拖动排序：把某视角下的现实层事件按 orderedIds 重排（写 sort_order，1..N） */
  reorderCanonEvents: authedProcedure
    .input(
      z.object({
        personaId: personaIdSchema,
        aboutPersonaId: personaIdSchema,
        orderedIds: z.array(z.number().int().positive()).min(1).max(500),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      await assertOwnedPersonas(ctx.user.id, [input.personaId, input.aboutPersonaId]);
      return reorderCanonEvents(input);
    }),

  /** 手动新建一条关系（原世界层，默认维度留给后续编辑/补完覆盖） */
  createManualRelation: authedProcedure
    .input(
      z.object({
        fromPersonaId: personaIdSchema,
        toPersonaId: personaIdSchema,
        kind: z.string().trim().max(32),
        form: z.string().trim().max(8).optional(),
        basis: z.string().trim().max(300).nullable().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      if (input.fromPersonaId === input.toPersonaId) throw new Error("不能与自己建立关系");
      await assertOwnedPersonas(ctx.user.id, [input.fromPersonaId, input.toPersonaId]);
      const kind = (RELATION_KINDS as readonly string[]).includes(input.kind) ? input.kind : "unspecified";
      const form =
        input.form && (RELATION_FORMS as readonly string[]).includes(input.form)
          ? input.form
          : (RELATION_KIND_TO_FORM as Record<string, string>)[kind] ?? "CS";
      const existing = await listRelations({
        fromPersonaId: input.fromPersonaId,
        toPersonaId: input.toPersonaId,
        layer: "canon",
      });
      if (existing.length > 0) {
        return { relationId: existing[0]!.id ?? 0, created: false };
      }
      const r = await writeRelationRow({
        fromPersonaId: input.fromPersonaId,
        toPersonaId: input.toPersonaId,
        layer: "canon",
        kind,
        form,
        basis: input.basis ?? null,
        actor: "manual.createRelation",
        originModule: "manual",
        reasonKind: "manual",
        overwrite: false,
      });
      return { relationId: r.relationId ?? 0, created: r.created === true };
    }),

  /** 编辑一条关系（kind/form 走校正留痕；备注直接更新） */
  updateManualRelation: authedProcedure
    .input(
      z.object({
        relationId: z.number().int().positive(),
        patch: z.object({
          kind: z.string().trim().max(32).optional(),
          form: z.string().trim().max(8).optional(),
          basis: z.string().trim().max(300).nullable().optional(),
        }),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const rows: any[] = await db
        .select()
        .from(personaRelations)
        .where(and(eq(personaRelations.id, input.relationId), eq(personaRelations.status, "active")))
        .limit(1);
      const row = rows[0];
      if (!row) throw new Error("关系不存在或已被替换，请刷新后重试");
      await assertOwnedPersonas(ctx.user.id, [row.fromPersonaId, row.toPersonaId]);
      const patch: Record<string, string | null> = {};
      if (input.patch.kind !== undefined) {
        if (!(RELATION_KINDS as readonly string[]).includes(input.patch.kind)) throw new Error("关系类别非法");
        patch.kind = input.patch.kind;
      }
      if (input.patch.form !== undefined) {
        if (!(RELATION_FORMS as readonly string[]).includes(input.patch.form)) throw new Error("关系形式非法");
        patch.form = input.patch.form;
      }
      if (input.patch.basis !== undefined) patch.basis = input.patch.basis ?? null;
      if (Object.keys(patch).length === 0) return { ok: true, relationId: input.relationId };
      if (patch.kind !== undefined || patch.form !== undefined) {
        const r = await correctRelation({
          relationId: input.relationId,
          patch,
          actor: "manual.updateRelation",
          reasonKind: "manual",
          evidence: ["详情页手动编辑关系"],
        });
        return { ok: r.ok, relationId: r.relationId ?? input.relationId };
      }
      await applyRelationColumns({
        relationId: input.relationId,
        patch,
        reasonKind: "manual",
        actor: "manual.updateRelation",
        originModule: "manual",
      });
      return { ok: true, relationId: input.relationId };
    }),

  /** 现实层覆盖率（按账户隔离；可选单人格） */
  canonCoverage: authedProcedure
    .input(z.object({ personaId: personaIdSchema.optional() }).optional())
    .query(async ({ input, ctx }) => {
      if (input?.personaId) await assertOwnedPersona(ctx.user.id, input.personaId);
      return canonCoverage(ctx.user.id, input?.personaId);
    }),

  /** 补完任务台账（按账户隔离） */
  backfillJobs: authedProcedure
    .input(z.object({ personaId: personaIdSchema.optional() }).optional())
    .query(async ({ input, ctx }) => {
      if (input?.personaId) await assertOwnedPersona(ctx.user.id, input.personaId);
      return listBackfillJobs(ctx.user.id, input?.personaId);
    }),

  /** 启动现实层补完（异步，立即返回） */
  startBackfillCanon: authedProcedure
    .input(
      z.object({
        personaId: personaIdSchema,
        aboutPersonaId: personaIdSchema,
        apiPresetId: z.number().int().positive().nullable().optional(),
        force: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      await assertOwnedPersonas(ctx.user.id, [input.personaId, input.aboutPersonaId]);
      if (!input.apiPresetId) {
        return { started: false, error: "没有可用 API：请先在「关系补完」里配置一个" };
      }
      const presets = await listPresets(String(ctx.user.id));
      if (!presets.some((p) => p.id === input.apiPresetId)) {
        return { started: false, error: "API 存档不存在或不属于当前账户" };
      }
      void backfillCanonLog({
        userId: ctx.user.id,
        personaId: input.personaId,
        aboutPersonaId: input.aboutPersonaId,
        apiPresetId: input.apiPresetId ?? null,
        allowWeb: true,
        force: input.force ?? false,
      }).catch(() => {
        /* 失败状态由 job 台账体现 */
      });
      return { started: true };
    }),

  /** 现实层补完任务状态（轮询；按账户隔离） */
  backfillCanonStatus: authedProcedure
    .input(z.object({ personaId: personaIdSchema, aboutPersonaId: personaIdSchema }))
    .query(async ({ input, ctx }) => {
      await assertOwnedPersonas(ctx.user.id, [input.personaId, input.aboutPersonaId]);
      const jobs = await listBackfillJobs(ctx.user.id, input.personaId);
      const job: any = jobs.find((j: { aboutPersonaId: number }) => j.aboutPersonaId === input.aboutPersonaId);
      if (!job) return { status: "none", itemCount: 0, error: null, warning: null, stats: null };
      const fin = job.finishedAt ? new Date(job.finishedAt as never).getTime() : 0;
      const started = job.createdAt ? new Date(job.createdAt as never).getTime() : 0;
      const isZombie =
        job.status === "running" && (fin > 0 || (started > 0 && Date.now() - started > 20 * 60_000));
      return {
        status: isZombie ? "done" : job.status,
        itemCount: job.itemCount,
        error: job.error ?? null,
        warning: job.warning ?? null,
        stats: job.stats ?? null,
      };
    }),

  /** 兼容旧调用：同步执行（仅供脚本/测试用，前端不要用） */
  backfillCanon: authedProcedure
    .input(
      z.object({
        personaId: personaIdSchema,
        aboutPersonaId: personaIdSchema,
        apiPresetId: z.number().int().positive().nullable().optional(),
        force: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      await assertOwnedPersonas(ctx.user.id, [input.personaId, input.aboutPersonaId]);
      return backfillCanonLog({
        userId: ctx.user.id,
        personaId: input.personaId,
        aboutPersonaId: input.aboutPersonaId,
        apiPresetId: input.apiPresetId ?? null,
        allowWeb: true,
        force: input.force ?? false,
      });
    }),
});
