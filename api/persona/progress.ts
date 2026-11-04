// ============================================================
// 铸造进度登记处：铸魂师长任务的「真实进度」透出 + 暂停/继续/终止控制
// 设计：AsyncLocalStorage 携带 castId（与并行 lane），叶子代码（postChat/工具循环/
// 各家流式累加器）直接上报，免穿十余层函数签名；前端以 castId 轮询
// persona.castProgress 获取当前阶段与细节行。
// 无 castId（旧前端/测试直调）时全部上报函数静默空转，行为与原先完全一致。
// ============================================================

import { AsyncLocalStorage } from "node:async_hooks";
import type { CastControlAction, CastProgressState, PersonaCastResult } from "../../contracts/persona";

interface CastCtx {
  castId: string;
  lane: string; // 并行子任务的细节分行键（main=主流程）
}

interface Entry extends CastProgressState {
  lanes: Map<string, string>; // lane → 细节行（已含 lane 前缀）
  userId: number | string | null; // 归属用户（castActive 按用户找回现场；同步任务为 null）
  result: PersonaCastResult | null; // 完成产物（done 后随 castProgress 透出）
  cancelRequested: boolean; // 终止标志（下个检查点抛 CastCancelledError）
  interrupted?: boolean; // 中断水合条目（进程死亡后从检查点恢复的占位，可续铸）
}

/** 铸造被终止（用户点「终止生成」）：任务链在检查点抛出，条目直接删除不入终态 */
export class CastCancelledError extends Error {
  constructor() {
    super("铸造已被终止");
    this.name = "CastCancelledError";
  }
}

const als = new AsyncLocalStorage<CastCtx>();
const registry = new Map<string, Entry>();
// 清扫已废止（2026-10-14 用户裁定）：草稿箱是生成进程的全程镜像，
// 清库权限只有两个——用户主动删除 / 草稿核对入库成功核销；此外任何清扫都是对草稿箱的背叛。
// 状态全程写穿 persona_cast_drafts（queued/running/paused/interrupted/failed/done），重启水合复原。
function sweep(): void {
  /* 永不清扫 */
}


// 查询层静态导入封装（vitest 模块拦截只对静态/顶层 import 生效——动态 import()
// 在模块内会穿透 mock 直打真实方言实现，曾致测试里 MySQL 路径 TypeError）；
// getDb() 在调用时才读 env，静态导入无加载期副作用，也无循环依赖（personas 不回引 progress）
import {
  deleteCastCheckpoints,
  deletePersonaCastDraft,
  listAllCastCheckpointParams,
  listCastCheckpoints,
  listPersonaCastDrafts,
  setCastDraftStatus,
  upsertCastCheckpoint,
  upsertPersonaCastDraft,
} from "../queries/personas";

/** 落库失败的统一静默（不阻塞铸造）；fn 内抛错绝不逃逸 */
function withQueries(fn: () => Promise<unknown>): void {
  void fn().catch(() => {
    /* 落库失败不阻塞铸造 */
  });
}

/** 草稿完成即落库（status=done） */
function persistCastDraftNow(castId: string, st: Entry): void {
  withQueries(() =>
    upsertPersonaCastDraft({
      castId,
      userId: st.userId != null ? String(st.userId) : null,
      name: st.name ?? "",
      result: st.result,
      status: "done",
    }),
  );
}

/** 进程状态写穿草稿箱（失败静默：不落库不等于不落状态，下一轮状态转变再补） */
function persistDraftStatus(castId: string, status: string): void {
  withQueries(() => setCastDraftStatus(castId, status));
}

// ---------- 草稿持久化水合（重启后从 persona_cast_drafts 恢复未取走的草稿） ----------
let hydrated = false;
/** 进程内首次调用时把库中未取走的草稿水合进登记处（幂等） */
export async function hydrateCastDrafts(): Promise<void> {
  if (hydrated) return;
  hydrated = true;
  try {
    // 静态导入（见文件头注释）
    // 中断铸造水合（断电/进程死亡后）：有 params 检查点且无条目无草稿 → 「已中断」占位条目
    try {
      const ckptParams = await listAllCastCheckpointParams();
      const drafts = await listPersonaCastDrafts();
      const draftIds = new Set(drafts.map((d) => d.castId));
      for (const [ckptCastId, params] of ckptParams) {
        if (registry.has(ckptCastId) || draftIds.has(ckptCastId)) continue;
        const pname = (params as { name?: string })?.name;
        const e = newEntry(ckptCastId, (params as { userId?: string | number })?.userId ?? null, pname);
        e.label = "已中断（可从断点续铸）";
        e.detail = "进程中断前的阶段产物已落盘，点「继续铸造」从断点接续";
        e.interrupted = true;
        registry.set(ckptCastId, e);
      }
    } catch {
      /* 检查点读取失败不影响草稿水合 */
    }
    const rows = await listPersonaCastDrafts();
    for (const r of rows) {
      if (registry.has(r.castId)) continue;
      if (r.status === "saved") continue; // 已核销入库：留痕留在库里，不进内存登记处（否则「核对草稿」会复活）
      const e = newEntry(r.castId, r.userId, r.name);
      e.startedAt = r.createdAt.getTime();
      e.updatedAt = r.createdAt.getTime();
      if (r.status === "done" && r.result != null) {
        e.done = true;
        e.result = r.result as PersonaCastResult;
        e.label = "草稿已铸成（重开恢复）";
      } else {
        // 非终态条目的水合：进程已死，running/paused 一律归为可续铸的中断；failed/interrupted 照旧
        e.done = false;
        e.interrupted = true;
        e.label = r.status === "failed" ? "失败（可断点续铸）" : "已中断（可从断点续铸）";
        e.detail = "";
      }
      registry.set(r.castId, e);
    }
  } catch {
    hydrated = false; // DB 未就绪等：下次再试
  }
}

function toPublic(st: Entry): CastProgressState {
  return {
    castId: st.castId,
    name: st.name,
    label: st.label,
    detail: st.detail,
    startedAt: st.startedAt,
    updatedAt: st.updatedAt,
    done: st.done,
    error: st.error,
    result: st.result,
    paused: st.paused,
    interrupted: st.interrupted === true,
  };
}

function newEntry(castId: string, userId: number | string | null, name?: string): Entry {
  const now = Date.now();
  return {
    castId,
    name,
    label: "排队准备中",
    detail: "",
    startedAt: now,
    updatedAt: now,
    done: false,
    error: null,
    result: null,
    paused: false,
    lanes: new Map(),
    userId,
    cancelRequested: false,
  };
}

/** 以 castId 包裹一次铸造/检索任务：自动建条目、终局落 done/error；无 castId 直接执行 */
export async function runWithCastProgress<T>(
  castId: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (!castId) return fn();
  registry.set(castId, newEntry(castId, null));
  try {
    const result = await als.run({ castId, lane: "main" }, fn);
    const st = registry.get(castId);
    if (st) {
      st.done = true;
      st.updatedAt = Date.now();
    }
    sweep();
    return result;
  } catch (err) {
    const st = registry.get(castId);
    if (st) {
      st.done = true;
      st.error = err instanceof Error ? err.message : String(err);
      st.updatedAt = Date.now();
    }
    sweep();
    throw err;
  }
}

/** 排队登记（铸魂生产队列入口）：任务未起跑先亮卡「排队中」，轮询/控制即刻可用 */
export function registerQueuedCast(castId: string, userId: number | string, name: string): void {
  if (registry.has(castId)) return;
  const e = newEntry(castId, userId, name);
  e.label = "排队中（等待并发空位）";
  registry.set(castId, e);
  // 入队即落库：生成进程一开始，草稿箱就有这张卡
  withQueries(() =>
    upsertPersonaCastDraft({
      castId,
      userId: userId != null ? String(userId) : null,
      name,
      result: null,
      status: "queued",
    }),
  );
}

/** 排队/在飞任务是否已被终止（队列 kick 启动前检查；起跑后由检查点接管） */
export function isCastCancelled(castId: string): boolean {
  return registry.get(castId)?.cancelRequested === true;
}

/** 启动铸造后台任务（异步任务模式）：建条目后立即返回，任务在后台跑；
 * 完成产物落 result、失败落 error，前端经 castProgress 轮询终态与产物。
 * 根治「单请求长任务被掐断后结果无法送达」——不再依赖长连接存活。
 * name=铸造人格名（人格研究站「生成中」卡片显示）。
 * 返回任务完成 Promise（批量编排用；不 await 即为 fire-and-forget） */
export function startCastJob(
  castId: string,
  userId: number | string,
  name: string,
  fn: () => Promise<unknown>,
): Promise<void> {
  registry.set(castId, newEntry(castId, userId, name));
  persistDraftStatus(castId, "running"); // 起跑写穿
  return (async () => {
    try {
      const result = await als.run({ castId, lane: "main" }, fn);
      const st = registry.get(castId);
      if (st) {
        st.done = true;
        st.result = (result ?? null) as PersonaCastResult | null;
        st.updatedAt = Date.now();
        // 草稿落库：进程重启/超时清扫都不再丢（取走后 ackCast 连带删库）
        if (st.result) {
          persistCastDraftNow(castId, st);
        }
      }
    } catch (err) {
      // 终止：取消并删除整个流程（条目不入终态，直接消失）
      if (err instanceof CastCancelledError) {
        registry.delete(castId);
        return;
      }
      const st = registry.get(castId);
      if (st) {
        st.done = true;
        st.error = err instanceof Error ? err.message : String(err);
        st.updatedAt = Date.now();
        // 有检查点的失败=可续铸的中断（网络中断/进程抖动）——卡片给「断点续铸」而非只有「知道了」
        withQueries(async () => {
            const ck = await listCastCheckpoints(castId);
            const cur = registry.get(castId);
            if (ck.params) {
              if (cur) {
                cur.interrupted = true;
                cur.done = false; // 中断态不是终态：不被清扫、可续铸
                cur.label = "已中断（可从断点续铸）";
                cur.detail = st.error ?? "";
              }
              persistDraftStatus(castId, "interrupted");
            } else {
              persistDraftStatus(castId, "failed");
            }
          });
      }
    } finally {
      sweep();
    }
  })();
}

/** 阶段检查点落盘（铸魂师各阶段产物即写即存——进程死亡/断电后从断点续铸的原料）。
 * 无 castId 上下文（测试直调）时静默空转。 */
export function saveCastCheckpoint(stage: string, data: unknown): void {
  const ctx = als.getStore();
  if (!ctx) return;
  // 僵尸写防护：条目已不存在（终止/取走草稿）的任务不再落任何检查点
  if (!registry.has(ctx.castId)) return;
  withQueries(() => upsertCastCheckpoint(ctx.castId, stage, data));
}

/** 检查点（埋在各阶段边界与每次 AI 调用入口）：
 * - 已请求终止 → 抛 CastCancelledError（任务链中断、条目删除）
 * - 已暂停 → 挂起等待，直到继续/终止/条目消失
 * 无 castId 上下文（旧前端/测试直调 castPersona）时静默空转 */
export async function castCheckpoint(): Promise<void> {
  const ctx = als.getStore();
  if (!ctx) return;
  const st = registry.get(ctx.castId);
  if (!st) throw new CastCancelledError(); // 条目消失（终止已清理）→ 中断任务链
  if (st.cancelRequested) throw new CastCancelledError();
  if (!st.paused) return;
  // 挂起：300ms 轮询等待继续/终止
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      const cur = registry.get(ctx.castId);
      if (!cur || cur.cancelRequested || !cur.paused || cur.done) {
        clearInterval(timer);
        resolve();
      }
    }, 300);
  });
  const cur = registry.get(ctx.castId);
  if (!cur || cur.cancelRequested) throw new CastCancelledError();
}

/** 铸造控制：pause=暂停（下个检查点挂起）/ resume=继续 / cancel=终止并删除整个流程。
 * 返回 false=条目不存在或已结束（前端按无此任务处理） */
export function castControl(
  castId: string,
  userId: number | string,
  action: CastControlAction,
): boolean {
  const st = registry.get(castId);
  if (!st || (st.userId !== null && st.userId !== userId)) return false;
  if (action === "pause") {
    if (st.done || st.paused) return false;
    st.paused = true;
    st.updatedAt = Date.now();
    persistDraftStatus(castId, "paused");
    return true;
  }
  if (action === "resume") {
    if (st.done || !st.paused) return false;
    st.paused = false;
    st.updatedAt = Date.now();
    persistDraftStatus(castId, "running");
    return true;
  }
  // cancel：打终止标志（下个检查点任务链自清理）+ 条目立即删除（卡片即刻消失——
  // 原来要等检查点抛出任务链才删，在飞 AI 调用几分钟内卡片一直「加载中」，像终止无效）；
  // 终止=用户主动删除（清库唯一通道）：检查点与草稿行连清
  st.cancelRequested = true;
  registry.delete(castId);
  withQueries(async () => {
    await deletePersonaCastDraft(castId);
    await deleteCastCheckpoints(castId);
  });
  return true;
}

/** 按用户找回最近铸造（进行中优先，其次最近完成的）——前端重开向导恢复现场 */
export function getActiveCast(userId: number | string): CastProgressState | null {
  let bestRunning: Entry | null = null;
  let bestDone: Entry | null = null;
  for (const e of registry.values()) {
    if (e.userId !== userId) continue;
    if (!e.done) {
      if (!bestRunning || e.startedAt > bestRunning.startedAt) bestRunning = e;
    } else if (!bestDone || e.startedAt > bestDone.startedAt) {
      bestDone = e;
    }
  }
  const best = bestRunning ?? bestDone;
  return best ? toPublic(best) : null;
}

/** 按用户列出全部活跃铸造（进行中按启动倒序在前，其次已完成按完成倒序；上限 8 条）
 * ——人格研究站「生成中」卡片列表（批量并发铸造时逐卡显示） */
export function getActiveCasts(userId: number | string, limit = 8): CastProgressState[] {
  const running: Entry[] = [];
  const done: Entry[] = [];
  for (const e of registry.values()) {
    if (e.userId !== userId) continue;
    if (e.done) done.push(e);
    else running.push(e);
  }
  running.sort((a, b) => b.startedAt - a.startedAt);
  done.sort((a, b) => b.updatedAt - a.updatedAt);
  return [...running, ...done].slice(0, limit).map(toPublic);
}

/** 并行子任务各挂一个 lane（细节分行显示，如四段深读各自的生成字数） */
export function withLane<T>(lane: string, fn: () => Promise<T>): Promise<T> {
  const ctx = als.getStore();
  return ctx ? als.run({ ...ctx, lane }, fn) : fn();
}

/** 切换阶段（清空上一阶段的细节行） */
export function stage(label: string): void {
  const ctx = als.getStore();
  if (!ctx) return;
  const st = registry.get(ctx.castId);
  if (!st || st.done) return;
  st.label = label;
  st.lanes.clear();
  st.detail = "";
  st.updatedAt = Date.now();
}

/** 更新当前 lane 的细节行（main lane 原文；命名 lane 自动冠以 lane 名） */
export function note(text: string): void {
  const ctx = als.getStore();
  if (!ctx) return;
  const st = registry.get(ctx.castId);
  if (!st || st.done) return;
  st.lanes.set(ctx.lane, ctx.lane === "main" ? text : `${ctx.lane} ${text}`);
  st.detail = [...st.lanes.values()].join("；");
  st.updatedAt = Date.now();
}

/** 生成字数上报器（节流：≥200 字或距上次 ≥400ms 才写一次；prefix 如「联网检索 第 2 轮」）
 * 入参兼容两种形态：流式累加器直接传「已累加文本」（取长度），数字则直用 */
export function makeCharsReporter(prefix?: string): (accumulated: string | number) => void {
  let lastN = 0;
  let lastT = 0;
  return (input) => {
    const n = typeof input === "number" ? input : input.length;
    const now = Date.now();
    if (lastN > 0 && n - lastN < 200 && now - lastT < 400) return;
    lastN = n;
    lastT = now;
    note(`${prefix ? `${prefix} · ` : ""}已生成 ${n} 字`);
  };
}

/** 前端轮询出口（去除内部 lanes 字段；userId 非空时校验归属，防串号） */
export function getCastProgress(castId: string, userId?: number | string): CastProgressState | null {
  const st = registry.get(castId);
  if (!st) return null;
  if (userId !== undefined && st.userId !== null && st.userId !== userId) return null;
  return toPublic(st);
}

/** 核对入库核销（清库不删稿——2026-10-14 用户裁定：清库唯一条件是用户主动删除并确认。
 * 核销只做两件事：内存条目移除（卡片从「生成中」消失）+ 草稿状态转 saved（留痕长期保留，
 * 草稿箱里可回看全过程研究文本，直到用户亲手删除）） */
export function ackCast(castId: string): void {
  registry.delete(castId);
  withQueries(() => setCastDraftStatus(castId, "saved"));
}

/** 用户主动删除草稿（清库唯一通道）：条目+草稿+检查点全清。任何状态都可删（排队/生成中由 castControl cancel 走同一路径） */
export function discardCastDraft(castId: string, userId: number | string): boolean {
  const st = registry.get(castId);
  if (st && st.userId !== null && st.userId !== userId) return false;
  if (st && !st.done) st.cancelRequested = true; // 生成中直删=先打终止标志，任务链下个检查点自断
  registry.delete(castId);
  withQueries(async () => {
    await deletePersonaCastDraft(castId);
    await deleteCastCheckpoints(castId);
  });
  return true;
}
