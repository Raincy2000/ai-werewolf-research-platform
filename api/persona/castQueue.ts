// ============================================================
// 铸魂生产队列（2026-10-13 用户裁定）：单轮/批量/中途加入的统一架构
// 铸造本质是一条生产进程——单轮=入队 1 个，批量=入队 N 个，中途加入=随时再入队。
// 滚动并发窗（上限 2：单个铸造的②四段深读本身已多路并发，闸门防高峰限流），
// 一个任务卡住/失败绝不阻塞后续（旧批量分块 Promise.all 有队头阻塞）。
// 配套兜底：草稿箱持久化（progress.ts/persona_cast_drafts）——生产过程的任何结局都可挽回。
// ============================================================

import { randomUUID } from "node:crypto";
import { getCastProgress, isCastCancelled, registerQueuedCast, startCastJob } from "./progress";

/** 并发窗（2026-10-14 用户裁定）：同一 API 身份最多同时 2 个铸造（约 6 条流程——
 *  1 搜集 + 4 段并行深读 + 1 整合，正好是限流安全线）；不同 API 的人格可并行；
 *  全局总闸 6 个铸造（防摆出多个不同 API 打爆本机与网络） */
export const CAST_QUEUE_PER_API = 2;
export const CAST_QUEUE_GLOBAL = 6;

/** API 身份（调度分组键）：提供方+端点+模型+密钥指纹——同一账户同一模型视为同一身份 */
export function castApiIdentity(cfg: {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
}): string {
  let h = 0;
  const s = `${cfg.provider}|${cfg.baseUrl}|${cfg.model}|${cfg.apiKey}`;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return `${cfg.provider}:${cfg.model}:${h.toString(36)}`;
}

interface QueuedCast {
  castId: string;
  userId: number | string;
  name: string;
  apiKeys: string[]; // 该铸造占用的 API 身份集合（①②③三件套去重后）
  run: () => Promise<unknown>;
}

const queue: QueuedCast[] = [];
const running = new Map<string, string[]>(); // castId → apiKeys
const runningByKey = new Map<string, number>(); // apiKey → 在飞铸造数

/** 入队铸造任务（单轮/批量/中途加入同一路径）；返回各任务的 castId（输入带 castId 则沿用） */
export function enqueueCasts(
  userId: number | string,
  jobs: { castId?: string; name: string; apiKeys?: string[]; run: () => Promise<unknown> }[],
): { castId: string }[] {
  const out: { castId: string }[] = [];
  for (const j of jobs) {
    const castId = j.castId ?? randomUUID();
    registerQueuedCast(castId, userId, j.name); // 排队即刻在卡片列表可见（「排队中」）
    queue.push({ castId, userId, name: j.name, apiKeys: j.apiKeys ?? [], run: j.run });
    out.push({ castId });
  }
  kick();
  return out;
}

/** 队列状态（测试与观测用） */
export function castQueueDepth(): { queued: number; running: number } {
  return { queued: queue.length, running: running.size };
}

/** 资格判定：全局总闸未满 且 该任务的每个 API 身份都在「同 API 2 个铸造」额度内 */
function eligible(job: QueuedCast): boolean {
  if (running.size >= CAST_QUEUE_GLOBAL) return false;
  // 无身份信息的任务（测试/旧调用）归入共享默认组，受同组额度约束
  const keys = job.apiKeys.length > 0 ? job.apiKeys : ["__default__"];
  return keys.every((k) => (runningByKey.get(k) ?? 0) < CAST_QUEUE_PER_API);
}

/** 滚动调度：窗口有空位就启动下一个；已取消的排队任务直接丢弃不启动 */
function kick(): void {
  // 滚动扫描：队首不合格不堵队列——跳过它继续找下一个合格的（不同 API 的人格不被同 API 的排队堵住）
  for (let i = 0; i < queue.length; ) {
    const job = queue[i]!;
    // 终止即删条目（0.3.39 起取消立即生效）：条目不存在也视为已终止，不启动
    if (isCastCancelled(job.castId) || !getCastProgress(job.castId)) {
      queue.splice(i, 1);
      continue; // 排队期间被终止：丢弃（不占窗口）
    }
    if (!eligible(job)) {
      i++;
      continue;
    }
    queue.splice(i, 1);
    const keys = job.apiKeys.length > 0 ? job.apiKeys : ["__default__"];
    running.set(job.castId, keys);
    for (const k of keys) runningByKey.set(k, (runningByKey.get(k) ?? 0) + 1);
    void startCastJob(job.castId, job.userId, job.name, job.run)
      .catch(() => {
        /* 任务失败已在登记处落 error，队列照常滚动 */
      })
      .finally(() => {
        const keys = running.get(job.castId) ?? [];
        running.delete(job.castId);
        for (const k of keys) runningByKey.set(k, Math.max(0, (runningByKey.get(k) ?? 1) - 1));
        kick();
      });
  }
}
