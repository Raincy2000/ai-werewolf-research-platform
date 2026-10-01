import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { callKimiFormulaWebSearch } from "./caster";

// ============================================================
// Formula 联网循环的收敛机制测试（本地 mock Moonshot 端点）
// 背景：MAX_TOOL_ROUNDS=6 时，铸造①搜集大任务常需 4-6 轮检索——模型第 6 轮还在搜
// 就被判「未收敛」，前期搜索成果全部丢弃并降级为内部知识（用户实测踩中）。
// 修复：上限 12 + 末轮「强制产出轮」（去 tools 直接作答）+ fiber 失败立即抛错降级。
// ============================================================

function sseText(text: string, finish = "stop"): string {
  return (
    `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: finish }] })}\n\n` +
    "data: [DONE]\n\n"
  );
}
function sseToolCall(id: string, query: string): string {
  return (
    `data: ${JSON.stringify({
      choices: [
        {
          delta: {
            reasoning_content: "k3 保留式思考链（工具轮）",
            tool_calls: [
              { index: 0, id, type: "function", function: { name: "web_search", arguments: JSON.stringify({ query }) } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    })}\n\n` + "data: [DONE]\n\n"
  );
}

describe("Formula 联网循环收敛机制（mock Moonshot）", () => {
  let server: http.Server;
  let baseUrl = "";
  let chatRounds = 0;
  let fiberCalls = 0;
  let lastChatHadTools: boolean | null = null;
  let lastChatSawForceHint = false;
  let lastAssistantReasoning = false;
  // 模式：toolCallsFor=前几轮都返 tool_calls；fiberFail=fiber 返回 failed；emptyOnce=首个产出轮 content 为空
  let toolCallsFor = 3;
  let fiberFail = false;
  let emptyOnce = false;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const url = req.url ?? "";
        if (url.includes("/tools") && req.method === "GET") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ tools: [{ type: "function", function: { name: "web_search", parameters: {} } }] }));
          return;
        }
        if (url.includes("/fibers")) {
          fiberCalls++;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            fiberFail
              ? JSON.stringify({ status: "failed", context: {} })
              : JSON.stringify({ status: "succeeded", context: { encrypted_output: "MOONSHOT ENCRYPTED 搜索结果内容" } }),
          );
          return;
        }
        // chat/completions
        chatRounds++;
        const parsed = JSON.parse(body) as { tools?: unknown[]; messages?: { role: string; content: string; reasoning_content?: string }[] };
        lastChatHadTools = Array.isArray(parsed.tools);
        lastChatSawForceHint = (parsed.messages ?? []).some(
          (m) => typeof m.content === "string" && m.content.includes("检索轮次已达上限"),
        );
        lastAssistantReasoning = (parsed.messages ?? []).some(
          (m) => m.role === "assistant" && typeof m.reasoning_content === "string" && m.reasoning_content.length > 0,
        );
        res.writeHead(200, { "content-type": "text/event-stream" });
        if (chatRounds <= toolCallsFor) {
          res.end(sseToolCall(`ws_${chatRounds}`, `搜索词${chatRounds}`));
        } else if (emptyOnce) {
          emptyOnce = false;
          res.end(sseText("")); // 瞬态空内容（finish=stop 但正文为空）
        } else {
          res.end(sseText("基于检索结果的最终档案内容"));
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });

  afterAll(async () => {
    await new Promise((r) => server.close(r));
  });

  const cfg = () => ({ provider: "kimi" as const, baseUrl, model: "kimi-k3", apiKey: "sk-mock" });

  function reset() {
    chatRounds = 0;
    fiberCalls = 0;
    lastChatHadTools = null;
    lastChatSawForceHint = false;
    lastAssistantReasoning = false;
    emptyOnce = false;
    fiberFail = false;
  }

  it("正常 3 轮收敛：返回最终文本，fiber 逐轮执行", async () => {
    reset();
    toolCallsFor = 3;
    const text = await callKimiFormulaWebSearch(cfg(), "系统", "用户问题");
    expect(text).toBe("基于检索结果的最终档案内容");
    expect(chatRounds).toBe(4); // 3 轮工具 + 1 轮产出
    expect(fiberCalls).toBe(3);
  });

  it("临界任务不再未收敛：连续 11 轮还想搜 → 第 12 轮强制产出轮（无 tools + 提示）成功产出", async () => {
    reset();
    toolCallsFor = 11; // 前 11 轮都继续要求搜索
    const text = await callKimiFormulaWebSearch(cfg(), "系统", "用户问题");
    expect(text).toBe("基于检索结果的最终档案内容"); // 不抛错、不降级、保住成果
    expect(chatRounds).toBe(12); // 11 轮工具 + 第 12 轮强制产出
    expect(fiberCalls).toBe(11);
    expect(lastChatHadTools).toBe(false); // 末轮未带 tools
    expect(lastChatSawForceHint).toBe(true); // 末轮带「直接作答」提示
  });

  it("fiber 执行失败（status=failed）立即抛错走降级链，不空转到底", async () => {
    reset();
    toolCallsFor = 99;
    fiberFail = true;
    await expect(callKimiFormulaWebSearch(cfg(), "系统", "用户问题")).rejects.toThrow("检索执行失败");
    expect(chatRounds).toBe(1); // 第一轮 fiber 失败即中断
    expect(fiberCalls).toBe(1);
  });

  it("瞬态空内容（finish=stop 但正文为空）不占轮次上限重试一轮后成功", async () => {
    reset();
    toolCallsFor = 2; // 2 轮工具
    emptyOnce = true; // 第 3 轮首次产出为空
    const text = await callKimiFormulaWebSearch(cfg(), "系统", "用户问题");
    expect(text).toBe("基于检索结果的最终档案内容");
    expect(chatRounds).toBe(4); // 2 轮工具 + 空内容 1 轮 + 重试产出 1 轮（重试不占上限）
    expect(emptyOnce).toBe(false); // 标记已消耗
  });

  it("kimi-k3 保留式思考：assistant 回声原样回传 reasoning_content（否则思考链断裂→空内容）", async () => {
    reset();
    toolCallsFor = 2; // 两轮工具调用，检验第二轮请求的 assistant 回声是否带上思考链
    const text = await callKimiFormulaWebSearch(cfg(), "系统", "用户问题");
    expect(text).toBe("基于检索结果的最终档案内容");
    expect(lastAssistantReasoning).toBe(true); // 多轮请求里 assistant message 必须保留 reasoning_content
  });
});
