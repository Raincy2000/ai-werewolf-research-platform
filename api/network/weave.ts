// ============================================================
// 编织 · 联网检索原世界关系网（§29 编织模块的核心能力）
// 用户定调：**补完 = 用 API 联网检索原作关系**，不是从档案自举、不是语义精修。
//
// 流程：人格卡 → 联网检索原作关系 → 结构化（kind/form/9 维）→ 写 canon 层 → 落台账
//
// 2026-10-22 审计 P0-7 修复：
//  - AbortController 贯穿任务：取消 / 30 分钟硬上限真正中止 AI 调用（不再只 reject 外层）；
//  - 所有终态写入走 jobControl.finishJob（CAS，不覆盖 cancelled，failed 不会被 applied 覆盖）；
//  - 收尾只写一次 progress（保留 written/webSearched/log，修复汇总恒 0）；
//  - 支持 resume（从 progress.doneIds 续跑，不重复已完成人格）；
//  - createWeaveJob 对同用户 running 任务去重（返回 {jobId, reused}）；
//  - 新增 listCompletionJobs / getCompletionStatus（含僵尸自愈）/ resumeCompletion。
// ============================================================
import { and, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { personas, personaRelations, relationCompletionJobs, relationCompletionItems } from "../../db/schema";
import { listPresets } from "../queries/presets";
import { callWithWebSearch } from "../persona/caster";
import { prepareWebContext } from "../persona/websearch";
import { backfillCanonLog } from "../persona/canonBackfill";
import { writeRelationRow } from "./writeModel";
import { insertReturningId } from "../queries/dialect";
import { finishJob, isJobAborted, isJobActive, registerJob, clearJob } from "./jobControl";
import { RELATION_KINDS, RELATION_KIND_TO_FORM } from "../../contracts/interpersonal";
import type { AiTestInput } from "../../contracts/game";

export interface WeaveInput {
  userId: string;
  personaIds?: number[];
  apiPresetId?: number | null;
  /** 是否联网（默认 true） */
  allowWeb?: boolean;
}

export interface WeaveResult {
  jobId: number;
  /** 检索到并写入的关系条目数 */
  written: number;
  /** 覆盖的人格数 */
  cards: number;
  /** 联网成功的人格数 */
  webSearched: number;
  /** 失败的人格 */
  failed: { name: string; error: string }[];
  /** 未匹配到库内人格的对方名 */
  unresolved: string[];
}

/** job.scope 的 JSON 形状（resume 自恢复 apiPresetId / personaIds） */
interface WeaveScope {
  personaIds?: number[];
  apiPresetId?: number | null;
}

/** job.progress 的常见字段（未知字段原样保留） */
interface WeaveProgress extends Record<string, unknown> {
  phase?: string;
  total?: number;
  done?: number;
  current?: string;
  written?: number;
  webSearched?: number;
  log?: string[];
  /** 已完成的人格 id（resume 续跑依据） */
  doneIds?: number[];
  backfill?: { done: number; total: number };
}

const SYSTEM = [
  "你是「人格研究站」的关系网编织者，负责从**原作事实**中还原人物之间的人际关系。",
  "用户会给你一个人物名与其出处。请联网检索该人物在原作中的人际关系（家人/挚友/宿敌/师徒/君臣/爱人/亏欠者等）。",
  "对每一个对 TA 重要的人物，输出一条关系。严格只输出 JSON：",
  '{"relations":[{"name":"对方标准名","aliases":["其他译名"],',
  '"kind":"kin|beloved|sworn_friend|comrade|mentor|sovereign|peer|rival|nemesis|creditor|kin_slayer|unspecified",',
  '"form":"CS|AR|EM|MP","positivity":0,"negativity":0,"trust":50,"closeness":0,',
  '"dependence":0,"reciprocity":0,"powerBalance":0,"formality":0,"commitment":0,',
  '"basis":"原作依据一句（尽量含出处）"}]}',
  "【维度定义】",
  "- positivity/negativity：正面与负面情感，**两者可同时高**（爱恨交织，例如亲手了结挚爱时两者都接近 100）；",
  "- trust：信任（可预测→可靠→信念）；closeness：亲密/自我重叠；",
  "- dependence：依赖；reciprocity：互惠；commitment：愿为这段关系承担代价的意志；",
  "- powerBalance：-100（我完全居下）..0（平等）..100（我完全居上）；formality：0（完全自发）..100（完全正式）；",
  "- form（Fiske 四型）：CS 共同分享（家人/挚友/爱人）｜AR 权威排序（师徒/君臣）｜EM 平等匹配（同侪/对手）｜MP 市场定价（亏欠/交易）。",
  "【规则】",
  "- 只列**在原作中确实有实质关系**的人物，宁缺毋滥；",
  "- 若原作明确记载了矛盾情感（既爱又恨、既是恩人又是仇敌），必须 positivity 与 negativity 同时给高值；",
  "- 禁止输出 JSON 之外的任何文字。"
].join("\n");

/** 名字变体：三笠·阿克曼 → [三笠·阿克曼, 三笠, 阿克曼] */
function nameVariants(name: string): string[] {
  const full = String(name || "").trim();
  if (!full) return [];
  const parts = full.split(/[·・.\s]/).filter((x) => x.length >= 2);
  return [...new Set([full, ...parts])];
}

function clamp100(v: unknown, d = 0): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : d;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function pickKind(v: unknown): string {
  const k = String(v ?? "").trim();
  return (RELATION_KINDS as readonly string[]).includes(k) ? k : "unspecified";
}

function pickForm(v: unknown, kind: string): string {
  const f = String(v ?? "").trim();
  if (["CS", "AR", "EM", "MP"].includes(f)) return f;
  return (RELATION_KIND_TO_FORM as Record<string, string>)[kind] ?? "CS";
}

/** 解析 AI 输出（容错：截取首尾大括号） */
function parseRelations(text: string): Record<string, unknown>[] {
  const cleaned = String(text || "").replace(/```(?:json)?/gi, "");
  const s = cleaned.indexOf("{");
  const e = cleaned.lastIndexOf("}");
  if (s < 0 || e <= s) return [];
  try {
    const obj = JSON.parse(cleaned.slice(s, e + 1)) as Record<string, unknown>;
    const arr = obj.relations;
    return Array.isArray(arr) ? (arr as Record<string, unknown>[]) : [];
  } catch {
    return [];
  }
}

// ============================================================
// 任务状态读写小工具
// ============================================================

function abortError(msg = "任务已终止"): Error {
  const err = new Error(msg);
  err.name = "AbortError";
  return err;
}

/** 给 Promise 加超时 + 可中止（任务取消/硬上限时立即 reject） */
function withTimeout<T>(p: Promise<T>, ms: number, label: string, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => finish(() => reject(abortError()));
    const timer = setTimeout(
      () => finish(() => reject(new Error(label + " 超时（" + Math.round(ms / 1000) + "s）"))),
      ms,
    );
    if (!signal) {
      /* 无 signal：只做超时 */
    } else if (signal.aborted) {
      finish(() => reject(abortError()));
      return;
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    p.then(
      (v) => finish(() => resolve(v)),
      (e) => finish(() => reject(e)),
    );
  });
}

/** 把不可中止的异步调用包成可中止（用于 prepareWebContext 等无 signal 参数的函数） */
function abortable<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => { signal.removeEventListener("abort", onAbort); resolve(v); },
      (e) => { signal.removeEventListener("abort", onAbort); reject(e); },
    );
  });
}

function timeOf(v: unknown): number {
  if (v instanceof Date) return v.getTime();
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function parseScope(raw: string | null | undefined): WeaveScope {
  const o = parseJsonObject(raw);
  const ids = Array.isArray(o.personaIds)
    ? (o.personaIds as unknown[]).map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0)
    : [];
  const preset = Number(o.apiPresetId);
  return {
    personaIds: ids.length > 0 ? ids : undefined,
    apiPresetId: Number.isFinite(preset) && preset > 0 ? preset : null,
  };
}

function parseProgress(raw: string | null | undefined): WeaveProgress {
  const o = parseJsonObject(raw);
  const doneIds = Array.isArray(o.doneIds)
    ? (o.doneIds as unknown[]).map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0)
    : [];
  const log = Array.isArray(o.log) ? (o.log as unknown[]).map((x) => String(x)) : [];
  return {
    ...o,
    written: Number.isFinite(Number(o.written)) ? Number(o.written) : 0,
    webSearched: Number.isFinite(Number(o.webSearched)) ? Number(o.webSearched) : 0,
    doneIds,
    log,
  };
}

interface JobRowLike {
  id: number;
  userId: string | null;
  scope: string;
  status: string;
  progress: string | null;
  stats: string | null;
  createdAt: unknown;
  finishedAt: unknown;
}

async function jobRowOf(jobId: number): Promise<JobRowLike | null> {
  if (!Number.isFinite(jobId) || jobId <= 0) return null;
  const db = getDb();
  const rows: any[] = await db
    .select()
    .from(relationCompletionJobs)
    .where(eq(relationCompletionJobs.id, jobId))
    .limit(1);
  return (rows[0] as JobRowLike | undefined) ?? null;
}

/** 读取任务当前状态（用于暂停/终止响应）*/
async function jobStatusOf(jobId: number): Promise<string | null> {
  if (!jobId) return null;
  try {
    const db = getDb();
    const rows: any[] = await db
      .select({ status: relationCompletionJobs.status })
      .from(relationCompletionJobs)
      .where(eq(relationCompletionJobs.id, jobId))
      .limit(1);
    return rows[0]?.status ?? null;
  } catch {
    return null;
  }
}

/** 写进度（前端轮询可见） */
async function setProgress(jobId: number, p: Record<string, unknown>): Promise<void> {
  if (!jobId) return;
  try {
    const db = getDb();
    await db.update(relationCompletionJobs).set({ progress: JSON.stringify(p) }).where(eq(relationCompletionJobs.id, jobId));
  } catch { /* 进度写失败不影响主流程 */ }
}

/** scope 合并写回（首次执行时把 apiPresetId 记进任务，resume 才能自恢复） */
async function updateJobScope(jobId: number, scope: WeaveScope): Promise<void> {
  try {
    const db = getDb();
    await db
      .update(relationCompletionJobs)
      .set({ scope: JSON.stringify({ ...scope }) })
      .where(eq(relationCompletionJobs.id, jobId));
  } catch { /* scope 写失败只影响 resume 自恢复 */ }
}

/** 单次 AI 调用上限。Kimi k3 联网单次实测 90s+，120s 会误杀；给到 240s。 */
const AI_CALL_TIMEOUT_MS = 240_000;

/** 单个任务的硬上限（含全部人格）*/
const JOB_HARD_LIMIT_MS = 30 * 60_000;

/** 僵尸判定：running 超过 2 小时 / 已有 finishedAt → failed（应用重启/崩溃）*/
const STALE_JOB_MS = 2 * 60 * 60_000;

/**
 * ★ 清理僵尸任务：running 但已超 2 小时或已写 finishedAt 的任务一律标记 failed。
 *
 * 场景：应用重启/崩溃后后台 Promise 消失，DB 里的 status 永远停在 running，
 * 前端轮询看到 0/0 不动。新建任务/查询状态时先收掉上一轮僵尸。
 */
async function reapStaleJobs(userId?: string): Promise<void> {
  try {
    const db = getDb();
    const conds = [eq(relationCompletionJobs.status, "running")];
    if (userId) conds.push(eq(relationCompletionJobs.userId, String(userId)));
    const rows: any[] = await db
      .select({
        id: relationCompletionJobs.id,
        createdAt: relationCompletionJobs.createdAt,
        finishedAt: relationCompletionJobs.finishedAt,
        progress: relationCompletionJobs.progress,
        stats: relationCompletionJobs.stats,
      })
      .from(relationCompletionJobs)
      .where(and(...conds));
    const cutoff = Date.now() - STALE_JOB_MS;
    for (const r of rows) {
      const at = timeOf(r.createdAt);
      const fin = timeOf(r.finishedAt);
      const stale = fin > 0 || (at > 0 && at < cutoff);
      if (!stale) continue;
      const prev = parseProgress(r.progress);
      await finishJob(r.id, "failed", {
        progress: JSON.stringify({ ...prev, phase: "stale", reason: "应用重启或任务中断，已自动收尾" }),
        stats: JSON.stringify({ reason: "stale" }),
        finishedAt: new Date(),
      });
    }
  } catch { /* 清理失败不影响主流程 */ }
}

/**
 * 创建编织任务（路由立即返回 jobId，供前端轮询进度）。
 *
 * ★ 同用户去重：已有 running 任务时不再新建，返回 {jobId, reused:true}。
 *   调用方（router）拿到 reused=true 时**不要**再重复启动 weaveRelations——
 *   否则会重复计费/重复写边。
 */
export async function createWeaveJob(input: {
  userId: string;
  personaIds?: number[];
  apiPresetId?: number | null;
}): Promise<{ jobId: number; reused: boolean }> {
  const db = getDb();
  // ★ 先收掉上一轮遗留的僵尸任务（应用重启后它们永远停在 running）
  await reapStaleJobs(String(input.userId));

  // 同用户 running 去重（进程内/跨进程都以 DB 为唯一事实源）
  const running: any[] = await db
    .select({ id: relationCompletionJobs.id })
    .from(relationCompletionJobs)
    .where(
      and(
        eq(relationCompletionJobs.userId, String(input.userId)),
        eq(relationCompletionJobs.status, "running"),
      ),
    )
    .orderBy(desc(relationCompletionJobs.createdAt))
    .limit(1);
  if (running.length > 0) return { jobId: Number(running[0].id), reused: true };

  const scope: WeaveScope = {
    personaIds: input.personaIds?.length ? input.personaIds : undefined,
    apiPresetId: input.apiPresetId != null ? input.apiPresetId : null,
  };
  const progress: WeaveProgress = {
    phase: "init",
    total: 0,
    done: 0,
    current: "",
    written: 0,
    webSearched: 0,
    log: [],
    doneIds: [],
  };
  const jobId = await insertReturningId(relationCompletionJobs, {
    userId: String(input.userId),
    scope: JSON.stringify(scope),
    status: "running",
    progress: JSON.stringify(progress),
  });
  return { jobId: Number(jobId), reused: false };
}

/** 任务运行期间的计数（异常收尾时也要能报告已完成数量） */
interface WeaveCounters {
  written: number;
  cards: number;
  webSearched: number;
  truncated: number;
  /** 后置现实层补完队列的 Promise（运行期间保留 job 注册，使 cancel 能中止队列） */
  postQueue?: Promise<void>;
}

/**
 * 编织主流程：**联网检索原作关系**并写入 canon 层。
 * 失败不阻断：单个人格失败只记录，不中断整体。
 * jobId 可由 createWeaveJob 预创建（此时复用该任务并持续写进度）。
 */
export async function weaveRelations(input: WeaveInput & { jobId?: number }): Promise<WeaveResult> {
  const { userId, personaIds, apiPresetId, allowWeb = true } = input;
  let jobId = input.jobId ?? 0;
  if (!jobId) {
    const created = await createWeaveJob({ userId, personaIds, apiPresetId });
    jobId = created.jobId;
    if (created.reused) {
      return {
        jobId,
        written: 0,
        cards: 0,
        webSearched: 0,
        failed: [{ name: "-", error: "同一用户已有补完任务在运行，已复用现有任务" }],
        unresolved: [],
      };
    }
  }

  const controller = new AbortController();
  if (!registerJob(jobId, controller)) {
    // 本进程内同一任务已在跑：不重复执行（防双击/重复计费）
    return {
      jobId,
      written: 0,
      cards: 0,
      webSearched: 0,
      failed: [{ name: "-", error: "同一任务已在运行" }],
      unresolved: [],
    };
  }

  const counters: WeaveCounters = { written: 0, cards: 0, webSearched: 0, truncated: 0 };
  let hardLimitFired = false;
  // ★ 30 分钟硬上限：真正 abort 调用链（不是只 reject 外层）
  const hardTimer = setTimeout(() => {
    hardLimitFired = true;
    controller.abort(abortError("关系补完任务超过 30 分钟硬上限，已中止"));
  }, JOB_HARD_LIMIT_MS);

  try {
    const result = await weaveRelationsInner(
      { userId, personaIds, apiPresetId, allowWeb, jobId },
      controller.signal,
      counters,
    );
    if (hardLimitFired) {
      // ★ 30 分钟硬上限：inner 已按「取消」中途返回，这里补终态（CAS：用户 cancel 优先）
      const msg = "关系补完任务超过 30 分钟硬上限，已中止";
      const final = await finishJob(jobId, "failed", {
        progress: JSON.stringify({
          phase: "timeout",
          reason: msg,
          written: counters.written,
          webSearched: counters.webSearched,
          done: counters.cards,
        }),
        stats: JSON.stringify({
          reason: msg,
          written: counters.written,
          webSearched: counters.webSearched,
          cards: counters.cards,
          timeout: true,
        }),
        finishedAt: new Date(),
      });
      // finishJob 返回 cancelled 时说明用户已终止，保留终止语义
      return {
        jobId,
        written: counters.written,
        cards: counters.cards,
        webSearched: counters.webSearched,
        failed: [{ name: "-", error: final === "cancelled" ? "任务已被终止" : msg }],
        unresolved: [],
      };
    }
    return result;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // 尝试读回已写进度（失败时也给前端真实计数）
    let prev: WeaveProgress = {};
    try {
      const row = await jobRowOf(jobId);
      prev = parseProgress(row?.progress);
    } catch { /* ignore */ }
    const phase = hardLimitFired ? "timeout" : controller.signal.aborted ? "cancelled" : "failed";
    // CAS：DB 已是 cancelled 时不会覆盖成 failed
    await finishJob(jobId, "failed", {
      progress: JSON.stringify({
        ...prev,
        phase,
        reason: msg,
        written: counters.written,
        webSearched: counters.webSearched,
        done: counters.cards,
      }),
      stats: JSON.stringify({
        reason: msg,
        written: counters.written,
        webSearched: counters.webSearched,
        cards: counters.cards,
        truncated: counters.truncated,
        timeout: hardLimitFired,
      }),
      finishedAt: new Date(),
    });
    return {
      jobId,
      written: counters.written,
      cards: counters.cards,
      webSearched: counters.webSearched,
      failed: [{ name: "-", error: msg }],
      unresolved: [],
    };
  } finally {
    clearTimeout(hardTimer);
    if (counters.postQueue) {
      // 后置现实层补完队列运行期间保留 controller 注册：cancelJobRecord 仍能 abort 中止队列
      void counters.postQueue.finally(() => clearJob(jobId));
    } else {
      clearJob(jobId);
    }
  }
}

/** 真正的编织流程（被 weaveRelations 包了超时/中止） */
async function weaveRelationsInner(
  input: WeaveInput & { jobId: number },
  signal: AbortSignal,
  counters: WeaveCounters,
): Promise<WeaveResult> {
  const db = getDb();
  const { userId, allowWeb = true, jobId } = input;
  const uid = String(userId);

  const jobRow = await jobRowOf(jobId);
  if (!jobRow) throw new Error("任务不存在（jobId=" + jobId + "）");
  if (String(jobRow.userId ?? "") !== uid) throw new Error("任务不属于当前用户");

  const scope = parseScope(jobRow.scope);
  const prev = parseProgress(jobRow.progress);
  const doneIds = new Set<number>((prev.doneIds ?? []).filter((n) => Number.isFinite(n)));
  const log: string[] = Array.isArray(prev.log) ? [...prev.log] : [];
  let written = prev.written ?? 0;
  let webSearched = prev.webSearched ?? 0;
  counters.written = written;
  counters.webSearched = webSearched;
  counters.cards = doneIds.size;

  // resume：从 scope/progress 续跑
  const requestedIds = input.personaIds?.length ? input.personaIds : scope.personaIds;
  const presetId = input.apiPresetId ?? scope.apiPresetId ?? null;
  if (presetId != null && scope.apiPresetId !== presetId) {
    await updateJobScope(jobId, { ...scope, personaIds: requestedIds, apiPresetId: presetId });
  }

  /** 统一收尾（取消/暂停/无 API 等提前结束路径） */
  const stopWithProgress = async (phase: string, reason?: string): Promise<WeaveResult> => {
    await setProgress(jobId, {
      ...prev,
      phase,
      total: counters.cards,
      done: counters.cards,
      doneIds: [...doneIds],
      current: "",
      written,
      webSearched,
      log,
      ...(reason ? { reason } : {}),
    });
    return {
      jobId,
      written,
      cards: counters.cards,
      webSearched,
      failed: reason ? [{ name: "-", error: reason }] : [],
      unresolved: [],
    };
  };

  if (jobRow.status === "cancelled") return stopWithProgress("cancelled");

  // ---- API 配置 ----
  let cfg: AiTestInput | null = null;
  if (presetId != null) {
    const presets = await listPresets(uid);
    const chosen = presets.find((p) => p.id === presetId);
    if (chosen) {
      cfg = { provider: chosen.provider, baseUrl: chosen.baseUrl, model: chosen.model, apiKey: chosen.apiKey };
    }
  }
  if (!cfg) {
    // 未选 API：记录原因后直接结束（不做规则自举冒充补完）
    await finishJob(jobId, "failed", {
      progress: JSON.stringify({
        ...prev,
        phase: "no-api",
        written: 0,
        webSearched: 0,
        log,
      }),
      stats: JSON.stringify({ written: 0, cards: 0, reason: "未选择 API，无法联网检索原作关系" }),
      finishedAt: new Date(),
    });
    return {
      jobId,
      written: 0,
      cards: 0,
      webSearched: 0,
      failed: [{ name: "-", error: "未选择 API" }],
      unresolved: [],
    };
  }

  // ---- 读取人格卡（软删人格不参与编织：P1-13）----
  const all: any[] = await db
    .select({
      id: personas.id,
      name: personas.name,
      source: personas.source,
      originName: personas.originName,
      originSource: personas.originSource,
      profile: personas.profile,
    })
    .from(personas)
    .where(and(eq(personas.userId, uid), isNull(personas.deletedAt)));
  type Card = (typeof all)[number];
  const targetsAll: Card[] = requestedIds?.length ? all.filter((c: Card) => requestedIds.includes(c.id)) : all;
  // ★ resume：跳过已完成的人格（不重复计费/不重复写）
  const targets = targetsAll.filter((c: Card) => !doneIds.has(c.id));
  const candidates = all.map((c: Card) => ({ id: c.id, name: c.name }));

  await setProgress(jobId, {
    phase: "running",
    total: targetsAll.length,
    done: doneIds.size,
    current: "",
    written,
    webSearched,
    log,
    doneIds: [...doneIds],
  });

  const failed: { name: string; error: string }[] = [];
  const unresolved = new Set<string>();
  const items: (typeof relationCompletionItems.$inferInsert)[] = [];
  /** 需要做现实层补完的 pair：只要 AI 识别出关系就补，不依赖边是否有变更（用户实锤：重跑补完时关系不变就永远不重写事件） */
  const backfillPairs = new Map<string, [number, number]>();

  /** 取消/暂停检查点：每张卡、每次 AI 调用前调用 */
  const checkControl = async (cardName?: string): Promise<"ok" | "cancelled" | "paused"> => {
    if (signal.aborted || isJobAborted(jobId)) {
      await setProgress(jobId, {
        phase: "cancelled",
        total: targetsAll.length,
        done: doneIds.size,
        current: cardName ?? "",
        written,
        webSearched,
        log,
        doneIds: [...doneIds],
      });
      return "cancelled";
    }
    const st = await jobStatusOf(jobId);
    if (st === "cancelled") {
      await setProgress(jobId, {
        phase: "cancelled",
        total: targetsAll.length,
        done: doneIds.size,
        current: cardName ?? "",
        written,
        webSearched,
        log,
        doneIds: [...doneIds],
      });
      return "cancelled";
    }
    if (st === "paused") {
      await setProgress(jobId, {
        phase: "paused",
        total: targetsAll.length,
        done: doneIds.size,
        current: cardName ?? "",
        written,
        webSearched,
        log,
        doneIds: [...doneIds],
      });
      return "paused";
    }
    return "ok";
  };

  for (const card of targets) {
    const ctrl = await checkControl(card.name);
    if (ctrl !== "ok") return stopWithProgress(ctrl);

    await setProgress(jobId, {
      phase: "running",
      total: targetsAll.length,
      done: doneIds.size,
      current: card.name,
      written,
      webSearched,
      log,
      doneIds: [...doneIds],
    });

    try {
      let prof: Record<string, unknown> = {};
      try { prof = typeof card.profile === "string" ? JSON.parse(card.profile) : (card.profile as never); } catch { prof = {}; }
      const originSource = String(card.originSource ?? prof.originSource ?? "").trim();

      // ★ 按存档里选的 API 决定联网方式
      //   Kimi/Anthropic → 让模型自己搜（useBuiltin）
      //   DeepSeek       → 用它独立的 Search API 拿材料
      //   其他           → 本地检索兜底
      const web = allowWeb
        ? await abortable(
            prepareWebContext(cfg, card.name, originSource).catch(
              () => ({ mode: "none" as const, useBuiltin: false, evidence: "", note: "联网准备失败" }),
            ),
            signal,
          )
        : { mode: "none" as const, useBuiltin: false, evidence: "", note: "未启用联网" };
      const evidence = web.evidence;

      const user = [
        `人物名：「${card.name}」`,
        originSource ? `出处：「${originSource}」` : "出处：未知（请先联网确认该人物出自哪部作品）",
        "请检索该人物在原作中的人际关系，按契约输出 JSON。",
      ].join("\n");

      const ctrl2 = await checkControl(card.name);
      if (ctrl2 !== "ok") return stopWithProgress(ctrl2);

      const r = await withTimeout(
        callWithWebSearch(cfg, SYSTEM, user, { web: web.useBuiltin, evidence, signal }),
        AI_CALL_TIMEOUT_MS,
        "检索「" + card.name + "」",
        signal,
      );
      // ★ 输出截断检测（finish_reason=length）：不把半截 JSON 当结果用，卡片记失败
      if (r.truncated) {
        counters.truncated++;
        failed.push({
          name: card.name,
          error: "AI 输出被截断（finish_reason=" + (r.finishReason ?? "length") + "），本卡未写入",
        });
        log.push(card.name + "：输出截断");
        doneIds.add(card.id);
        counters.cards = doneIds.size;
        await setProgress(jobId, {
          phase: "running",
          total: targetsAll.length,
          done: doneIds.size,
          current: "",
          written,
          webSearched,
          log,
          doneIds: [...doneIds],
        });
        continue;
      }
      if (r.webSearched || web.mode !== "none") webSearched++;
      if (!r.webSearched && web.mode === "none") {
        log.push(card.name + "：该 API 无联网能力，结果来自内部知识");
      }
      const rels = parseRelations(r.text);
      if (rels.length === 0) {
        failed.push({ name: card.name, error: r.webSearched ? "AI 未产出可解析关系" : `未联网：${r.offlineReason ?? "未知"}` });
      } else {
        for (const rel of rels) {
          const ctrl3 = await checkControl(card.name);
          if (ctrl3 !== "ok") return stopWithProgress(ctrl3);
          const toName = String(rel.name ?? "").trim();
          if (!toName) continue;
          // 匹配库内人格（名字变体）
          const variants = [...nameVariants(toName), ...(Array.isArray(rel.aliases) ? (rel.aliases as string[]) : [])];
          let toId = 0;
          for (const c of candidates as { id: number; name: string }[]) {
            if (c.id === card.id) continue;
            if (variants.some((v) => nameVariants(c.name).includes(v)) || nameVariants(c.name).some((v) => variants.includes(v))) {
              toId = c.id;
              break;
            }
          }
          if (toId === 0) { unresolved.add(toName); continue; }
          backfillPairs.set(card.id + "->" + toId, [card.id, toId]);
          // ★ 双方关系事件都要有：AI 只列了 A→B 时，反向 B→A 也要强制补一遍；
          //   否则会出现「五条悟有走马灯记忆、夏油杰侧没有」的单边缺事件。
          backfillPairs.set(toId + "->" + card.id, [toId, card.id]);

          const kind = pickKind(rel.kind);
          const form = pickForm(rel.form, kind);
          const pw = typeof rel.powerBalance === "number" ? Math.max(-100, Math.min(100, Math.round(rel.powerBalance))) : 0;

          const w = await writeRelationRow({
            fromPersonaId: card.id,
            toPersonaId: toId,
            toName,
            layer: "canon",
            kind,
            form,
            positivity: clamp100(rel.positivity),
            negativity: clamp100(rel.negativity),
            trust: clamp100(rel.trust, 50),
            closeness: clamp100(rel.closeness),
            dependence: clamp100(rel.dependence),
            reciprocity: clamp100(rel.reciprocity),
            powerBalance: pw,
            formality: clamp100(rel.formality),
            commitment: clamp100(rel.commitment),
            basis: String(rel.basis ?? "").slice(0, 400) || null,
            sourceRef: `weave:${jobId}`,
            actor: "weave.weaveRelations",
            originModule: "weave",
            overwrite: true,
          });
          // ★ writeModel 语义：created=新建 / changed=已有行被更新；无变更不再计「写入」
          const didWrite = w.created === true || (typeof w.changed === "number" && w.changed > 0);
          if (didWrite) {
            written++;
            counters.written = written;
            items.push({
              jobId, fromPersonaId: card.id, toPersonaId: toId, layer: "canon",
              param: "kind", action: "fill", beforeJson: null,
              afterJson: JSON.stringify({ kind, form, positivity: clamp100(rel.positivity), negativity: clamp100(rel.negativity) }),
              sourceTier: r.webSearched ? "wiki" : "canon",
              evidence: String(rel.basis ?? "").slice(0, 400) || null,
              confidence: r.webSearched ? 0.8 : 0.5,
              userDecision: "accepted",
            });
          }
        }
        log.push(`${card.name}：${rels.length} 条候选`);
      }
    } catch (e) {
      // 任务级中止 → 交给外层收尾（不再继续处理后续卡片）
      if (signal.aborted || isJobAborted(jobId) || (e instanceof Error && e.name === "AbortError")) {
        await stopWithProgress("cancelled");
        return {
          jobId,
          written,
          cards: counters.cards,
          webSearched,
          failed,
          unresolved: [...unresolved],
        };
      }
      failed.push({ name: card.name, error: e instanceof Error ? e.message : String(e) });
      log.push(`${card.name}：失败`);
    }
    doneIds.add(card.id);
    counters.cards = doneIds.size;
    written = counters.written;
    await setProgress(jobId, {
      phase: "running",
      total: targetsAll.length,
      done: doneIds.size,
      current: "",
      written,
      webSearched,
      log,
      doneIds: [...doneIds],
    });
  }

  if (items.length > 0) await db.insert(relationCompletionItems).values(items);

  // ============================================================
  // ★ I3「编织后双向可查」：对每条成功写入的 A→B，B→A 没有 active canon 边就补占位边。
  //   只在本 job 的 owner 人格集合内操作（不跨账户）；占位边 originModule=weave、
  //   basis 明示「对称补齐占位」，方便后续补完时被真实数据覆盖（overwrite:true 的后续写入会更新它）。
  // ============================================================
  const writtenPairs: [number, number][] = [];
  {
    const pairSeen = new Set<string>();
    for (const it of items) {
      if (!it.fromPersonaId || !it.toPersonaId) continue;
      const k = it.fromPersonaId + "->" + it.toPersonaId;
      if (pairSeen.has(k)) continue;
      pairSeen.add(k);
      writtenPairs.push([it.fromPersonaId, it.toPersonaId]);
    }
  }
  const symmetry = await completeSymmetry({
    jobId,
    pairs: writtenPairs,
    ownedIds: new Set<number>(all.map((c: Card) => Number(c.id))),
  });
  if (symmetry.created > 0) log.push("对称补全：" + symmetry.created + " 条占位边");
  if (symmetry.failed > 0) log.push("对称补全失败：" + symmetry.failed + " 条");

  // ============================================================
  // ★ 收尾：必须等后置现实层补完队列结束再置 applied。
  //   历史 bug：先 applied，后置队列在后台裸跑；用户看到“完成”后关窗口/关客户端，
  //   队列被杀，于是出现“边已写、关系事件没补、反向缺失”的半成品（2026-10-23 实锤）。
  // ============================================================
  const finalProgress: WeaveProgress = {
    phase: "done",
    total: targetsAll.length,
    done: doneIds.size,
    current: "",
    written,
    webSearched,
    log,
    doneIds: [...doneIds],
  };
  const stats = {
    written,
    cards: doneIds.size,
    webSearched,
    failed: failed.length,
    unresolved: unresolved.size,
    truncated: counters.truncated,
    symmetry: symmetry.created,
    symmetryFailed: symmetry.failed,
    resumed: doneIds.size > targets.length,
  };

  if (backfillPairs.size > 0) {
    const pairs = [...backfillPairs.values()];
    const finalPresetId = presetId;
    const backfillTotal = pairs.length;
    let backfillDone = 0;
    await setProgress(jobId, {
      ...finalProgress,
      phase: "backfill",
      backfill: { done: 0, total: backfillTotal },
    });
    const queue = (async () => {
      for (const [a, b] of pairs) {
        if (signal.aborted || isJobAborted(jobId)) break;
        try {
          const st = await jobStatusOf(jobId);
          if (st === "cancelled") break;
        } catch { /* ignore */ }
        try {
          await backfillCanonLog({
            userId: uid,
            personaId: a,
            aboutPersonaId: b,
            apiPresetId: finalPresetId,
            allowWeb: true,
            force: true, // 每次补完按第一人称重写关系事件/感受（旧 AI 行软删、manual 保留）
          });
        } catch {
          /* 单对失败不影响其他对 */
        }
        backfillDone++;
        await setProgress(jobId, {
          ...finalProgress,
          phase: "backfill",
          backfill: { done: backfillDone, total: backfillTotal },
        });
      }
    })();
    counters.postQueue = queue;
    await queue;
    counters.postQueue = undefined;
    finalProgress.backfill = { done: backfillDone, total: backfillTotal };
  }

  await finishJob(jobId, "applied", {
    progress: JSON.stringify(finalProgress),
    stats: JSON.stringify(stats),
    itemCount: targetsAll.length,
    finishedAt: new Date(),
  });

  return { jobId, written, cards: doneIds.size, webSearched, failed, unresolved: [...unresolved] };
}

// ============================================================
// 供 network router 接线的任务查询/恢复接口（Lead 负责接线）
// ============================================================

/**
 * I3 对称补全：对每条成功写入的 A→B，若 B→A 没有 active canon 边，补一条占位边。
 * 安全约束：只允许本 job owner 的人格（ownedIds），绝不跨账户写边。
 */
async function completeSymmetry(input: {
  jobId: number;
  pairs: Array<[number, number]>;
  ownedIds: Set<number>;
}): Promise<{ created: number; failed: number }> {
  if (input.pairs.length === 0) return { created: 0, failed: 0 };
  const db = getDb();
  let created = 0;
  let failed = 0;
  const seen = new Set<string>();
  for (const [from, to] of input.pairs) {
    if (!input.ownedIds.has(from) || !input.ownedIds.has(to)) continue;
    const key = from + "->" + to;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const existing: any[] = await db
        .select({ id: personaRelations.id })
        .from(personaRelations)
        .where(
          and(
            eq(personaRelations.fromPersonaId, to),
            eq(personaRelations.toPersonaId, from),
            eq(personaRelations.layer, "canon"),
            eq(personaRelations.status, "active"),
          ),
        )
        .limit(1);
      if (existing.length > 0) continue;
      const w = await writeRelationRow({
        fromPersonaId: to,
        toPersonaId: from,
        toName: null,
        layer: "canon",
        kind: "unspecified",
        form: "CS",
        basis: "关系补全：对向已有关系，对称补齐占位",
        sourceRef: `weave:${input.jobId}`,
        actor: "weave.completeSymmetry",
        originModule: "weave",
        reasonKind: "event",
        overwrite: false,
      });
      if (w.created === true || (typeof w.changed === "number" && w.changed > 0)) created++;
    } catch {
      failed++;
    }
  }
  return { created, failed };
}

export interface CompletionJobView {
  id: number;
  status: string;
  progress: Record<string, unknown>;
  progressRaw: string | null;
  statsRaw: string | null;
  stats: Record<string, unknown>;
  scope: WeaveScope;
  createdAt: unknown;
  finishedAt: unknown;
}

function toJobView(row: JobRowLike): CompletionJobView {
  const progress = parseProgress(row.progress);
  return {
    id: Number(row.id),
    status: String(row.status),
    progress,
    progressRaw: row.progress,
    statsRaw: row.stats,
    stats: parseJsonObject(row.stats),
    scope: parseScope(row.scope),
    createdAt: row.createdAt,
    finishedAt: row.finishedAt,
  };
}

/**
 * 补完任务状态（轮询用）：含僵尸自愈。
 * - running 且带 finishedAt / 创建超过 2 小时 → 置 failed 并返回 failed（不再谎报 running）
 * - 归属校验：任务不属于 userId 时返回 null（防越权读取）
 */
export async function getCompletionStatus(jobId: number, userId: string): Promise<CompletionJobView | null> {
  let row = await jobRowOf(jobId);
  if (!row) return null;
  if (row.userId != null && String(row.userId) !== String(userId)) return null;
  if (row.status === "running") {
    const fin = timeOf(row.finishedAt);
    const created = timeOf(row.createdAt);
    const zombie = fin > 0 || (created > 0 && Date.now() - created > STALE_JOB_MS);
    if (zombie) {
      const prev = parseProgress(row.progress);
      await finishJob(jobId, "failed", {
        progress: JSON.stringify({
          ...prev,
          phase: "stale",
          reason: "应用重启或任务中断，已自动收尾",
        }),
        stats: JSON.stringify({ ...parseJsonObject(row.stats), reason: "stale" }),
        finishedAt: new Date(),
      });
      row = (await jobRowOf(jobId)) ?? row;
    }
  }
  return toJobView(row);
}

/** 补完任务列表（按创建时间倒序，最多 20 条） */
export async function listCompletionJobs(userId: string): Promise<CompletionJobView[]> {
  const db = getDb();
  const rows: any[] = await db
    .select()
    .from(relationCompletionJobs)
    .where(
      and(
        eq(relationCompletionJobs.userId, String(userId)),
        // 用户要求：已完成/已终止/已失败的任务不要再恢复成一堆“进程”。
        // 只返回仍在进行中的 pending/running/paused；完成后由界面自动消失。
        inArray(relationCompletionJobs.status, ["pending", "running", "paused"]),
      ),
    )
    .orderBy(desc(relationCompletionJobs.createdAt))
    .limit(20);
  return rows.map((r: JobRowLike) => toJobView(r));
}

/**
 * 继续已暂停/失败的任务：
 *  - 校验归属，置 running（CAS：不复活 cancelled/applied），从 scope 自恢复 personaIds/apiPresetId，
 *    后台重新拉起 weaveRelations（跳过 progress.doneIds 里已完成的人格）并立即返回。
 */
export async function resumeCompletion(
  jobId: number,
  userId: string,
): Promise<{ ok: boolean; started?: boolean; jobId?: number; error?: string }> {
  const row = await jobRowOf(jobId);
  if (!row) return { ok: false, error: "任务不存在" };
  if (row.userId != null && String(row.userId) !== String(userId)) return { ok: false, error: "任务不属于当前用户" };
  if (row.status === "cancelled") return { ok: false, error: "任务已终止，不能继续" };
  if (row.status === "applied") return { ok: false, error: "任务已完成" };
  if (row.status === "running") return { ok: false, error: "任务正在运行" };

  const db = getDb();
  await db
    .update(relationCompletionJobs)
    .set({ status: "running", finishedAt: null })
    .where(
      and(
        eq(relationCompletionJobs.id, jobId),
        ne(relationCompletionJobs.status, "cancelled"),
        ne(relationCompletionJobs.status, "applied"),
      ),
    );
  const check: any[] = await db
    .select({ status: relationCompletionJobs.status })
    .from(relationCompletionJobs)
    .where(eq(relationCompletionJobs.id, jobId))
    .limit(1);
  if (check[0]?.status !== "running") return { ok: false, error: "任务状态不允许继续" };

  const scope = parseScope(row.scope);
  void weaveRelations({
    userId: String(userId),
    personaIds: scope.personaIds,
    apiPresetId: scope.apiPresetId ?? null,
    allowWeb: true,
    jobId,
  }).catch(() => { /* 状态由 job 台账体现 */ });
  return { ok: true, started: true, jobId };
}

/** 任务是否在本进程运行（startCompletion 去重后可据此决定是否需要真正启动） */
export function isCompletionJobActive(jobId: number): boolean {
  return isJobActive(jobId);
}
