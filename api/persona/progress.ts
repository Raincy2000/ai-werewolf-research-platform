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
const DONE_TTL_MS = 30 * 60 * 1000; // 终态保留 30 分钟供前端收尾轮询，随后清扫

function sweep(): void {
  const now = Date.now();
  for (const [id, e] of registry) {
    if (e.done && now - e.updatedAt > DONE_TTL_MS) registry.delete(id);
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

/** 启动铸造后台任务（异步任务模式）：建条目后立即返回，任务在后台跑；
 * 完成产物落 result、失败落 error，前端经 castProgress 轮询终态与产物。
 * 根治「单请求长任务被掐断后结果无法送达」——不再依赖长连接存活。
 * name=铸造人格名（人格研究库「生成中」卡片显示）。
 * 返回任务完成 Promise（批量编排用；不 await 即为 fire-and-forget） */
export function startCastJob(
  castId: string,
  userId: number | string,
  name: string,
  fn: () => Promise<unknown>,
): Promise<void> {
  registry.set(castId, newEntry(castId, userId, name));
  return (async () => {
    try {
      const result = await als.run({ castId, lane: "main" }, fn);
      const st = registry.get(castId);
      if (st) {
        st.done = true;
        st.result = (result ?? null) as PersonaCastResult | null;
        st.updatedAt = Date.now();
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
      }
    } finally {
      sweep();
    }
  })();
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
    return true;
  }
  if (action === "resume") {
    if (st.done || !st.paused) return false;
    st.paused = false;
    st.updatedAt = Date.now();
    return true;
  }
  // cancel：打终止标志（检查点抛出后任务链自清理）；已结束/未在跑的直接删条目
  st.cancelRequested = true;
  if (st.done) registry.delete(castId);
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
 * ——人格研究库「生成中」卡片列表（批量并发铸造时逐卡显示） */
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

/** 用户取走/放弃草稿后确认（删除条目，防止已完成铸造在向导重开时被反复恢复） */
export function ackCast(castId: string): void {
  registry.delete(castId);
}
