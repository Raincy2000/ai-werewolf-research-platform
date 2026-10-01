// ============================================================
// 服务端请求总时长解除（长任务天花板）
// 背景：Node ≥18 的 http server 默认 requestTimeout=300s——铸魂师铸造（多步合计
// 常超 5 分钟）、分析报告等单请求长任务会被服务端主动掐断 socket：前端 fetch 报错
// 跳走（用户感知「界面忽然消失」），后端 handler 空跑、结果无法送达。
// 本机回环/受控环境下单请求不设总时长上限（AI 调用层另有自身的重试与容错）。
// ============================================================

import type { Server } from "node:http";

/** requestTimeout 置 0（不设总时限）；headersTimeout/keepAliveTimeout 维持默认即可
 * （它们限制的是客户端发请求头/复用空闲，与本机长轮询/长任务无冲突） */
export function applyServerTimeouts(server: Server): void {
  server.requestTimeout = 0;
}
