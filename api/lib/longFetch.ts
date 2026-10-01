// ============================================================
// 长时生成专用 fetch（铸魂师等人格研究长文档链路）
// 背景：Node 内置 fetch（undici）带隐藏的传输层超时——headersTimeout / bodyTimeout
// 默认 300s；思考型模型的非流式长生成动辄 5 分钟以上不吐响应头，会被底层以
// UND_ERR_HEADERS_TIMEOUT 直接掐断，应用层 AbortController 管不到这一层。
// 此处改用 npm undici 包的 fetch + 自定义 Agent 取消该上限
// （全局 fetch 的 instanceof 校验拒绝外部包 Agent——实测 UND_ERR_INVALID_ARG——
// 故必须连 fetch 一起使用包内实现）。
// 与「铸魂师不设客户端时限（质量优先，思考型模型想多久想多久）」的设计决策一致；
// 真实网络故障（断网/连接重置/拒连）仍照常抛错进入上层重试。
// ============================================================

import { Agent, fetch as undiciFetch } from "undici";

// 0 = 关闭该层超时：等响应头 / 响应体块间隔均不设上限
const longAgent = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

/** 与全局 fetch 同签名同语义，仅底层换成无 300s 隐藏超时的 dispatcher */
export function longFetch(url: string, init: RequestInit): Promise<Response> {
  return undiciFetch(url, {
    ...init,
    dispatcher: longAgent,
  } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>;
}

/** 网络层错误的人话翻译：友好文案在前，底层错误码保留在括号内便于排查 */
export function netErrorMessage(err: Error): string {
  const cause = (err as { cause?: { code?: string; message?: string } }).cause;
  const code = cause?.code;
  const detail = code ?? cause?.message;
  const hint =
    code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_BODY_TIMEOUT"
      ? "模型服务长时间未响应（生成耗时过长或网络不畅），已自动重试仍失败——请稍后重试"
      : code === "UND_ERR_CONNECT_TIMEOUT" ||
          code === "ECONNREFUSED" ||
          code === "ENOTFOUND" ||
          code === "EAI_AGAIN"
        ? "无法连接模型服务（网络不通或服务地址有误）——请检查网络与端点配置后重试"
        : code === "ECONNRESET" || code === "UND_ERR_SOCKET" || code === "EPIPE"
          ? "连接被服务方中断，已自动重试仍失败——请稍后重试"
          : "网络请求失败，已自动重试仍失败——请稍后重试";
  return detail ? `${hint}（${detail}）` : hint;
}
