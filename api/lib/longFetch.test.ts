import { describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { longFetch, netErrorMessage } from "./longFetch";

function errWithCause(code: string): Error {
  return new Error("fetch failed", { cause: { code } });
}

describe("netErrorMessage 人话翻译", () => {
  it("响应头/响应体超时 → 「长时间未响应」文案并保留错误码", () => {
    for (const code of ["UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]) {
      const msg = netErrorMessage(errWithCause(code));
      expect(msg).toContain("长时间未响应");
      expect(msg).toContain(code);
    }
  });

  it("连接类错误 → 「无法连接模型服务」文案", () => {
    for (const code of ["UND_ERR_CONNECT_TIMEOUT", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]) {
      expect(netErrorMessage(errWithCause(code))).toContain("无法连接模型服务");
    }
  });

  it("中断类错误 → 「连接被服务方中断」文案", () => {
    for (const code of ["ECONNRESET", "UND_ERR_SOCKET", "EPIPE"]) {
      expect(netErrorMessage(errWithCause(code))).toContain("连接被服务方中断");
    }
  });

  it("未知错误码 → 通用文案并保留原码；无 cause → 纯文案", () => {
    const msg = netErrorMessage(errWithCause("SOME_WEIRD_CODE"));
    expect(msg).toContain("网络请求失败");
    expect(msg).toContain("SOME_WEIRD_CODE");
    expect(netErrorMessage(new Error("fetch failed"))).toBe(
      "网络请求失败，已自动重试仍失败——请稍后重试",
    );
  });
});

describe("longFetch", () => {
  it("经自定义 dispatcher 完成请求并读取响应体（验证 fetch/Agent 接线可用）", async () => {
    const server = http.createServer((_req, res) => {
      // 模拟长生成：延迟吐响应头（300s 隐藏超时已被取消，此处只做接线冒烟）
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      }, 300);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const res = await longFetch(`http://127.0.0.1:${port}/`, { method: "GET" });
      expect(res.status).toBe(200);
      const data = (await res.json()) as { ok: boolean };
      expect(data.ok).toBe(true);
    } finally {
      server.close();
    }
  });
});
