// ============================================================
// 书记员（Recorder）· 隐藏基础设施层 —— 对局服务的内部支撑
// 版图约定（2026-10-10 用户裁定）：
//   法官 judge/    —— 流程秩序的唯一写者（播报、判罚、终局落定）
//   分析师 analyst —— 纯读者/意见提供者（胜率、复盘、蒸馏）
//   人格研究 persona/ —— 心镜涌现、记事簿、心理检查
//   书记员 runtime/ —— 隐而不现：落笔（持久化）、编号（seq）、计时（超时守卫）。
//                      它不是产品角色，界面永远不会出现「书记员」三个字。
// 本文件：计时工具（Promise 超时守卫 + DB 调用上限）。
// ============================================================

export const DB_TIMEOUT_MS = 15_000; // tick 循环内单次 DB 调用最长等待，超时抛错走 handleTickError

// Promise.race 超时保护：promise 在 ms 内未 settle 则以 label 报错 reject。
// 注意：不取消底层 promise，只是不再等待（race 已订阅它，不会产生 unhandledRejection）
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label)), ms);
    // Node 环境下不阻断进程退出；测试/其他环境无 unref 则忽略
    (timer as { unref?: () => void }).unref?.();
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}
