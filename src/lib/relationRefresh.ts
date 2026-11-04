// ============================================================
// 关系数据变更事件（2026-10-22）
//
// 背景：关系补完/手录/排序发生在不同组件（RelationGraphBar、Personas 页），
// 但人格详情弹窗是独立数据快照——补完结束后不会自己更新（用户实锤）。
// 统一用一个 window 事件做“关系网数据已变化”广播：
//  - RelationGraphBar 在补完结束、canon 补完结束、手录/删除/排序成功后 emit；
//  - Personas 详情页订阅后，用空白加载页重新拉取整份 detail（刷新衔接）。
// ============================================================

export interface RelationChangedDetail {
  /** 受影响的人格 id（缺省=全部；详情页会判断是否与当前卡相关） */
  personaIds?: number[];
  /** 调试/日志用 */
  reason?: string;
}

const EVENT_NAME = "ww:relations-changed";

export function notifyRelationsChanged(detail: RelationChangedDetail = {}): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<RelationChangedDetail>(EVENT_NAME, { detail }));
}

export function subscribeRelationsChanged(
  cb: (detail: RelationChangedDetail) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (e: Event) => cb((e as CustomEvent<RelationChangedDetail>).detail ?? {});
  window.addEventListener(EVENT_NAME, handler);
  return () => window.removeEventListener(EVENT_NAME, handler);
}
