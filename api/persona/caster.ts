// ============================================================
// 铸魂师（Soul Caster）：把现实/虚拟人物蒸馏为人格参数卡
// 双 AI 协作（用户决策）：
//   检索 AI（默认 Kimi，启用 $web_search 内置工具联网检索）负责信息采集——
//     消歧候选（researchPerson）与研究档案（dossier）；
//   整合 AI 负责把档案按七组心理学说蒸馏量化为人格参数卡（castPersona）。
// 保真度规矩：资料不足处由整合 AI 按心理学原型补全，路径写入 params.inferred（授权条款）；
//   检索 AI 非 Kimi（无联网）时全参数标推断并附 notice。
// ============================================================

import type { AiTestInput } from "../../contracts/game";
import type {
  CasterCandidate,
  PersonaCardInput,
  PersonaCastResult,
  PersonaResearchResult,
} from "../../contracts/persona";
import { personaInputSchema } from "../../contracts/persona";
import { parseJsonRobust } from "../game/ai/parse";
import { omitSamplingParams } from "../game/ai/modelCaps";
import { fetchImageAsDataUrl, fetchPortraitFromPage } from "./portrait";
import { gatherEvidence, formatEvidence, type EvidencePool } from "./websearch";
import { callResponsesApi } from "./responses";
import { longFetch, netErrorMessage } from "../lib/longFetch";
import { accumulateAnthropicStream, accumulateChatStream, synthesizeChatResponse } from "../lib/sse";
import { makeCharsReporter, note, stage, withLane, castCheckpoint } from "./progress";

// 铸魂师不设任何客户端时限：铸造是重质量的长文档任务，思考型模型（DeepSeek v4-pro / kimi-k3 等）
// 允许想多久想多久（用户决策：质量优先，超时限制与思考禁用一律不要）
const MAX_TOOL_ROUNDS = 12; // 联网检索最大工具往返轮数（实测铸造①搜集大任务常需 4-6 轮；6 曾卡死临界任务）
// 收敛兜底：最后一轮为「强制产出轮」——去掉 tools 并指示模型基于已有检索结果直接作答，
// 前期搜索成果（fiber 加密结果服务端可解密，前文可见）不再因差一轮而整体丢弃降级。

/** 网络层重试（与主链路 callAi 同款指数退避 + 主链路「429 例外重试」同款语义）：
 * - 底层走 longFetch：取消 undici 默认 300s headersTimeout 隐藏上限（长生成不被传输层掐断）
 * - fetch failed/连接重置等网络瞬断：重试 3 次（1s→2s→4s）
 * - HTTP 429（限流/引擎过载）与 5xx：按 Retry-After 头或递增退避重试 3 次（3s→6s→12s）——
 *   DeepSeek「engine overloaded」正是此类，等一等多半自愈；
 * - 其余 4xx（协议错误）立即返回交上层（重试无意义）
 * - 重试耗尽后错误经 netErrorMessage 翻译为人话（底层错误码保留在括号内）
 */
async function fetchWithRetry(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const MAX_ATTEMPTS = 4;
  let lastErr: unknown = null;
  let lastWasNetErr = false;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0 && lastWasNetErr) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
    }
    try {
      const res = await longFetch(url, init);
      lastWasNetErr = false;
      if ((res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS - 1) {
        const ra = Number(res.headers.get("retry-after"));
        await new Promise((r) =>
          setTimeout(r, Number.isFinite(ra) && ra > 0 ? ra * 1000 : 3000 * 2 ** attempt),
        );
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      lastWasNetErr = true;
    }
  }
  if (lastErr instanceof Error) {
    throw new Error(netErrorMessage(lastErr));
  }
  throw lastErr;
}

// ---------- 底层：Kimi $web_search 内置工具循环 ----------
// Moonshot 内置工具协议：声明 builtin_function $web_search 后，模型发出 tool_calls 时，
// 客户端回填 assistant(tool_calls) 与 tool（echo 参数）消息，平台在服务端完成真实检索并续写。
interface ChatMessage {
  role: string;
  content: string | null;
  /** kimi-k3 保留式思考（Preserved Thinking）始终开启：多轮回传必须保留思考链 */
  reasoning_content?: string | null;
  tool_calls?: unknown;
  tool_call_id?: string;
  name?: string;
}

/** HTTP 错误信息：429（限流/引擎过载）给人话（已自动重试仍繁忙→稍后重试），其余带原始摘要 */
function httpErrorMessage(status: number, msg: string): string {
  if (status === 429) {
    return "HTTP 429：服务方繁忙（引擎过载/限流），已自动重试多次仍繁忙——请稍后重试（DeepSeek/OpenAI 高峰常见）";
  }
  return `HTTP ${status}: ${msg.slice(0, 200)}`;
}

/** chat/completions 统一出口（流式优先 + 400 回退链；导出仅供测试） */
export async function postChat(
  cfg: AiTestInput,
  body: Record<string, unknown>,
  opts?: { progressPrefix?: string },
): Promise<unknown> {
  await castCheckpoint(); // 暂停/终止控制点：每次 AI 调用前检查
  const url = `${cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  // 流式（SSE）优先：响应头先行到达、内容持续吐字——长生成不再考验任何空闲超时，
  // 且顺带产出真实生成进度；端点不支持流式（400）时去掉 stream 自动回退非流式。
  const chars = makeCharsReporter(opts?.progressPrefix);
  body.stream = true;
  const post = async () => {
    const res = await fetchWithRetry(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(body),
    });
    const ct = res.headers.get("content-type") ?? "";
    if (res.status >= 200 && res.status < 300 && body.stream === true && ct.includes("text/event-stream")) {
      return { status: res.status, data: synthesizeChatResponse(await accumulateChatStream(res, chars)), raw: "" };
    }
    const raw = await res.text();
    let data: unknown = raw;
    try {
      data = JSON.parse(raw);
    } catch {
      /* 非 JSON 响应 */
    }
    return { status: res.status, data, raw };
  };
  const errText = (data: unknown, raw: string) =>
    data && typeof data === "object"
      ? String((data as { error?: { message?: unknown } }).error?.message ?? raw)
      : raw;
  // 单次尝试：流式优先 + 400 回退链（去 stream / 去 temperature）
  const attempt = async (): Promise<unknown> => {
    let { status, data, raw } = await post();
    // 端点不支持 SSE 流式：400 时去掉 stream 重试（后续回退链同此模式）
    if (status === 400 && body.stream === true) {
      delete body.stream;
      ({ status, data, raw } = await post());
    }
    // 思考类模型（如 kimi-k2.5）端点只允许 temperature=1：400 且报错点名 temperature 时，
    // 去掉该参数重试一次（与 providers.ts 主链路同款兼容，铸魂师三 AI 同样可能踩中）
    if (status === 400 && "temperature" in body && /temperature/i.test(errText(data, raw))) {
      delete body.temperature;
      ({ status, data, raw } = await post());
    }
    if (status < 200 || status >= 300) {
      throw new Error(httpErrorMessage(status, errText(data, raw)));
    }
    return data;
  };
  // 流式中断整调用重发：长生成 SSE 中途被网关/中间盒掐断（实锤：12 分钟级 terminated）
  // 此前一发就死——fetchWithRetry 只能管到响应头到达之前，流中死亡需要整调用级重试；
  // HTTP 语义错误（参数/鉴权）重试无意义，立即抛
  let lastErr: unknown = null;
  for (let i = 0; i < 3; i++) {
    try {
      return await attempt();
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (/^HTTP \d/.test(msg)) throw err;
      if (i < 2) await new Promise((r) => setTimeout(r, 2_000 * (i + 1)));
    }
  }
  throw lastErr;
}

// ---------- kimi-k3 联网检索：Formula API 官方工具通道 ----------
// 背景：k3 上 $web_search（builtin_function）工具回声在 Moonshot 服务端故障
//（官方论坛 2026-07-23 实锤，逐字节相同请求 k2.6 正常），k3 的正确通道是 Formula API
// 官方工具（标准 OpenAI function 协议，官方文档 2026-08 明示 k3 实测通过）：
//   1. GET  /formulas/moonshot/web-search:latest/tools   取工具声明
//   2. POST /chat/completions（带声明；模型返回标准 function tool_calls）
//   3. POST /formulas/moonshot/web-search:latest/fibers  按 tool_calls 原样执行（arguments 原样透传）
//   4. POST /chat/completions（assistant 含 tool_calls + role:tool 回填执行结果）
const KIMI_FORMULA_WEB_SEARCH = "moonshot/web-search:latest";

interface FormulaTool {
  type: string;
  function: { name: string; description?: string; parameters?: unknown };
}

/** 取官方工具声明（formula tools 端点） */
async function kimiFormulaTools(cfg: AiTestInput): Promise<FormulaTool[]> {
  const url = `${cfg.baseUrl.replace(/\/+$/, "")}/formulas/${KIMI_FORMULA_WEB_SEARCH}/tools`;
  const res = await fetchWithRetry(url, {
    headers: { authorization: `Bearer ${cfg.apiKey}` },
  });
  const raw = await res.text();
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Formula tools 获取失败 HTTP ${res.status}: ${raw.slice(0, 160)}`);
  }
  const data = JSON.parse(raw) as { tools?: FormulaTool[] };
  if (!Array.isArray(data.tools) || data.tools.length === 0) {
    throw new Error("Formula tools 声明为空");
  }
  return data.tools;
}

/** 执行官方工具（fibers 端点；arguments 为模型输出的 JSON 字符串，原样透传不二次编码） */
async function kimiFormulaExec(cfg: AiTestInput, name: string, argumentsStr: string): Promise<string> {
  const url = `${cfg.baseUrl.replace(/\/+$/, "")}/formulas/${KIMI_FORMULA_WEB_SEARCH}/fibers`;
  const res = await fetchWithRetry(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({ name, arguments: argumentsStr }),
  });
  const raw = await res.text();
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Formula fiber 执行失败 HTTP ${res.status}: ${raw.slice(0, 160)}`);
  }
  const data = JSON.parse(raw) as {
    status?: string;
    context?: { output?: string; encrypted_output?: string };
  };
  // 搜索类工具为 protected：结果在 encrypted_output（可直接塞回 tool 消息）
  const out = data.context?.output ?? data.context?.encrypted_output ?? "";
  // fiber 失败立即抛错（走降级链）：把失败文本回填给模型只会让它重复空搜到轮数上限
  if (data.status && data.status !== "succeeded") {
    throw new Error(`检索执行失败（fiber status=${data.status}）`);
  }
  return out;
}

/** k3 联网检索主循环（Formula 通道，标准 function 协议）
 * 机制：①上限 12 轮；②最后一轮为强制产出轮（去 tools + 指示直接作答，保住前期搜索成果）；
 * ③fiber 执行失败（HTTP 错误/状态非 succeeded）立即抛错走降级链——不让模型拿失败结果空搜到底
 * （导出仅供测试） */
export async function callKimiFormulaWebSearch(
  cfg: AiTestInput,
  system: string,
  user: string,
): Promise<string> {
  const tools = await kimiFormulaTools(cfg);
  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
  let retriedEmpty = false; // 瞬态空内容重试标记（每次铸造最多重试一轮）
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const isLastChance = round === MAX_TOOL_ROUNDS - 1;
    const roundMessages: ChatMessage[] = isLastChance
      ? [...messages, { role: "user", content: "【系统提示】检索轮次已达上限。请基于以上已完成的检索结果直接输出最终内容，禁止再调用任何工具。" }]
      : messages;
    // Kimi 思考系模型（k2.5/k3）端点只允许 temperature=1：不传由端点默认（免 400 空跑一轮）
    const data = (await postChat(
      cfg,
      { model: cfg.model, messages: roundMessages, ...(isLastChance ? {} : { tools }) },
      { progressPrefix: `联网检索 第 ${round + 1} 轮` },
    )) as {
      choices?: { finish_reason?: string; message?: { content?: string | null; reasoning_content?: string | null; tool_calls?: unknown } }[];
    };
    const choice = data.choices?.[0];
    const msg = choice?.message;
    const toolCalls = Array.isArray(msg?.tool_calls) ? (msg.tool_calls as Record<string, unknown>[]) : [];
    if (choice?.finish_reason === "tool_calls" && toolCalls.length > 0) {
      // kimi-k3 保留式思考始终开启：多轮工具调用必须原样回传完整 assistant message
      // （含 reasoning_content），否则思考链断裂 → 空内容 / 工具循环未收敛
      messages.push({
        role: "assistant",
        content: msg?.content ?? "",
        ...(typeof msg?.reasoning_content === "string" && msg.reasoning_content
          ? { reasoning_content: msg.reasoning_content }
          : {}),
        tool_calls: toolCalls,
      });
      for (const tc of toolCalls) {
        const fn = tc.function as { name?: unknown; arguments?: unknown };
        const fnName = String(fn?.name ?? "");
        const argsStr = typeof fn?.arguments === "string" ? fn.arguments : JSON.stringify(fn?.arguments ?? {});
        // fiber 失败（含 status≠succeeded）直接抛出降级：失败结果回填只会让模型重复空搜
        const result = await kimiFormulaExec(cfg, fnName, argsStr);
        messages.push({
          role: "tool",
          tool_call_id: String(tc.id ?? ""),
          content: result,
        });
      }
      continue;
    }
    const text = typeof msg?.content === "string" ? msg.content.trim() : "";
    if (!text) {
      // 瞬态空内容（k3 思考型偶发某轮 finish=stop 但正文为空）：不占轮次上限重试一次
      if (!retriedEmpty) {
        retriedEmpty = true;
        round--;
        continue;
      }
      throw new Error("检索 AI 返回内容为空");
    }
    return text;
  }
  throw new Error("联网检索轮数超限（Formula 工具循环未收敛）"); // 理论不可达（末轮强制产出）
}

/** 带 $web_search 的 Kimi 对话（非 Kimi provider 不可用，调用方需先判定）；
 * 模型路由：k3 直走 Formula 官方工具通道（builtin 回声在 k3 服务端故障）；
 * 其他 Kimi 模型先走内置 $web_search，若报 tokenization failed 则自动改走 Formula 通道 */
async function callKimiWebSearch(
  cfg: AiTestInput,
  system: string,
  user: string,
): Promise<string> {
  if (/k3/i.test(cfg.model)) {
    return callKimiFormulaWebSearch(cfg, system, user);
  }
  try {
    return await callKimiBuiltinWebSearch(cfg, system, user);
  } catch (err) {
    // builtin 回声故障（tokenization failed）：改走 Formula 官方工具通道
    if (err instanceof Error && /tokenization failed/i.test(err.message)) {
      console.warn(`[铸魂师] 内置 $web_search 回声故障，改走 Formula 官方工具通道`);
      return callKimiFormulaWebSearch(cfg, system, user);
    }
    throw err;
  }
}

/** 内置 $web_search（builtin_function）工具循环——k2.5/k2.6 等模型的常规通道
 * 与 Formula 通道同机制：上限 12 轮 + 末轮强制产出（去 tools 直接作答，保住前期搜索成果） */
async function callKimiBuiltinWebSearch(
  cfg: AiTestInput,
  system: string,
  user: string,
): Promise<string> {
  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
  const tools = [{ type: "builtin_function", function: { name: "$web_search" } }];
  let retriedEmpty = false; // 瞬态空内容重试标记（每次铸造最多重试一轮）
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const isLastChance = round === MAX_TOOL_ROUNDS - 1;
    const roundMessages: ChatMessage[] = isLastChance
      ? [...messages, { role: "user", content: "【系统提示】检索轮次已达上限。请基于以上已完成的检索结果直接输出最终内容，禁止再调用任何工具。" }]
      : messages;
    // Kimi 思考系模型端点只允许 temperature=1：不传由端点默认（免 400 空跑一轮）
    const data = (await postChat(
      cfg,
      { model: cfg.model, messages: roundMessages, ...(isLastChance ? {} : { tools }) },
      { progressPrefix: `联网检索 第 ${round + 1} 轮` },
    )) as {
      choices?: { finish_reason?: string; message?: { content?: string | null; reasoning_content?: string | null; tool_calls?: unknown } }[];
    };
    const choice = data.choices?.[0];
    const msg = choice?.message;
    const toolCalls = Array.isArray(msg?.tool_calls) ? (msg.tool_calls as Record<string, unknown>[]) : [];
    if (choice?.finish_reason === "tool_calls" && toolCalls.length > 0) {
      // 回填 assistant 与 tool echo（平台据此执行检索并续写）：
      // - assistant.content 用空串而非 null（严格 tokenizer 拒绝 null content 的实锤形态）
      // - tool.content 必须【原样回显】arguments 字符串（Moonshot 返回的就是 JSON 字符串，
      //   二次 JSON.stringify 会把它编码成字符串的字符串 → tokenization failed）
      // kimi 思考系保留式思考：多轮回传同样保留 reasoning_content（k2.6 开启保留时亦然）
      messages.push({
        role: "assistant",
        content: msg?.content ?? "",
        ...(typeof msg?.reasoning_content === "string" && msg.reasoning_content
          ? { reasoning_content: msg.reasoning_content }
          : {}),
        tool_calls: toolCalls,
      });
      for (const tc of toolCalls) {
        const args = (tc.function as { arguments?: unknown })?.arguments;
        messages.push({
          role: "tool",
          tool_call_id: String(tc.id ?? ""),
          name: String((tc.function as { name?: unknown })?.name ?? "$web_search"),
          content: typeof args === "string" ? args : JSON.stringify(args ?? {}),
        });
      }
      continue;
    }
    const text = typeof msg?.content === "string" ? msg.content.trim() : "";
    if (!text) {
      // 瞬态空内容（思考型模型偶发 finish=stop 但正文为空）：不占轮次上限重试一次
      if (!retriedEmpty) {
        retriedEmpty = true;
        round--;
        continue;
      }
      throw new Error("检索 AI 返回内容为空");
    }
    return text;
  }
  throw new Error("联网检索轮数超限（工具循环未收敛）"); // 理论不可达（末轮强制产出）
}

/** 阶段 AI 统一调用（三流程全联网的核心路由）：
 *  - Kimi：内置 $web_search 工具循环（断链降级纯文本，附原因）
 *  - Anthropic：服务端 web_search 工具（同响应带回引用，无需回声）
 *  - DeepSeek/OpenAI：Responses API 原生 web_search（失败降级纯文本）
 *  - 自定义/其他：纯文本调用
 *  evidence（服务端证据池）随 user 注入——任何模型都能用上真实网页资料 */
async function callStageAi(
  cfg: AiTestInput,
  system: string,
  user: string,
  opts?: { web?: boolean; evidence?: string },
): Promise<{ text: string; webSearched: boolean; offlineReason?: string }> {
  const wantWeb = opts?.web !== false;
  const userFull = opts?.evidence?.trim()
    ? `${user}\n\n【服务端检索补充材料】（应用后端实搜的真实网页资料，可信度高，请优先采信）\n${opts.evidence.trim()}`
    : user;
  const offlineSystem = `${system}\n【注意】你无法联网检索，请基于模型内部知识与随附的补充材料回答，并在资料不足之处明确标注。`;

  // Kimi：内置工具循环
  if (cfg.provider === "kimi") {
    if (wantWeb) {
      try {
        const text = await callKimiWebSearch(cfg, system, userFull);
        return { text, webSearched: true };
      } catch (err) {
        const reason = err instanceof Error ? err.message.slice(0, 120) : String(err).slice(0, 120);
        console.warn(`[铸魂师] Kimi 联网检索失败，降级：${reason}`);
        const r = await callStageAi(cfg, offlineSystem, user, { web: false, evidence: opts?.evidence });
        return { ...r, offlineReason: reason };
      }
    }
    const data = (await postChat(
      cfg,
      { model: cfg.model, messages: [
          { role: "system", content: offlineSystem },
          { role: "user", content: userFull },
        ] },
    )) as { choices?: { message?: { content?: string | null } }[] };
    const text = typeof data.choices?.[0]?.message?.content === "string" ? data.choices[0].message.content.trim() : "";
    if (!text) throw new Error("AI 返回内容为空");
    return { text, webSearched: false };
  }

  // Anthropic：服务端 web_search 工具
  if (cfg.provider === "anthropic") {
    const text = await callPlainAi(cfg, wantWeb ? system : offlineSystem, userFull, { webSearch: wantWeb });
    return { text, webSearched: wantWeb };
  }

  // DeepSeek/OpenAI：Responses API 原生 web_search
  if ((cfg.provider === "deepseek" || cfg.provider === "openai") && wantWeb) {
    try {
      const text = await callResponsesApi(cfg, system, userFull, { webSearch: true });
      return { text, webSearched: true };
    } catch (err) {
      const reason = err instanceof Error ? err.message.slice(0, 120) : String(err).slice(0, 120);
      console.warn(`[铸魂师] ${cfg.provider} Responses 联网失败，降级：${reason}`);
      const r = await callStageAi(cfg, offlineSystem, user, { web: false, evidence: opts?.evidence });
      return { ...r, offlineReason: reason };
    }
  }

  // 自定义/其余：纯文本
  const data = (await postChat(
    cfg,
    {
      model: cfg.model,
      messages: [
        { role: "system", content: wantWeb ? `${system}\n【注意】联网能力不可用，请基于随附的补充材料与内部知识回答。` : offlineSystem },
        { role: "user", content: userFull },
      ],
      temperature: 0.6,
    },
  )) as { choices?: { message?: { content?: string | null } }[] };
  const text = typeof data.choices?.[0]?.message?.content === "string" ? data.choices[0].message.content.trim() : "";
  if (!text) throw new Error("AI 返回内容为空");
  return { text, webSearched: false };
}

/** 整合 AI 调用（JSON 模式；Anthropic 端点在 system 里强制 JSON） */
async function callSynthAi(cfg: AiTestInput, system: string, user: string): Promise<string> {
  await castCheckpoint(); // 暂停/终止控制点
  const isAnthropic = cfg.provider === "anthropic";
  const url = isAnthropic
    ? `${cfg.baseUrl.replace(/\/+$/, "")}/v1/messages`
    : `${cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  // 流式（SSE）优先：响应头先行到达、内容持续吐字——长生成不再考验任何空闲超时；
  // 端点不支持流式（400）时去掉 stream 自动回退非流式
  const chars = makeCharsReporter();
  const body: Record<string, unknown> = isAnthropic
    ? {
        model: cfg.model,
        max_tokens: 4096,
        system: `${system}\n\n【输出要求】只输出一个 JSON 对象，禁止输出任何其他文字或 markdown 代码块。`,
        messages: [{ role: "user", content: user }],
        stream: true,
      }
    : {
        model: cfg.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        ...(omitSamplingParams(cfg) ? {} : { temperature: 0.5 }),
        response_format: { type: "json_object" },
        stream: true,
      };
  const headers = {
    "content-type": "application/json",
    ...(isAnthropic
      ? { "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01" }
      : { authorization: `Bearer ${cfg.apiKey}` }),
  };
  const post = async () => {
    const r = await fetchWithRetry(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const ct = r.headers.get("content-type") ?? "";
    if (r.status >= 200 && r.status < 300 && body.stream === true && ct.includes("text/event-stream")) {
      // 流式：按家协议累加后合成非流式同形结构（extractText 零改动）
      if (isAnthropic) {
        const acc = await accumulateAnthropicStream(r, chars);
        return { status: r.status, data: { content: [{ type: "text", text: acc.text }] }, raw: "" };
      }
      return { status: r.status, data: synthesizeChatResponse(await accumulateChatStream(r, chars)), raw: "" };
    }
    const text = await r.text();
    let d: unknown = text;
    try {
      d = JSON.parse(text);
    } catch {
      /* 保留原文 */
    }
    return { status: r.status, data: d, raw: text };
  };
  const snippet = (d: unknown, raw: string) =>
    d && typeof d === "object"
      ? String((d as { error?: { message?: unknown } }).error?.message ?? raw)
      : raw;
  let { status, data, raw } = await post();
  // 端点不支持 SSE 流式：400 时去掉 stream 重试（后续回退链同此模式）
  if (status === 400 && body.stream === true) {
    delete body.stream;
    ({ status, data, raw } = await post());
  }
  // 思考类模型只允许 temperature=1：去掉该参数重试（providers.ts 同款兼容）
  if (status === 400 && "temperature" in body && /temperature/i.test(snippet(data, raw))) {
    delete body.temperature;
    ({ status, data, raw } = await post());
  }
  // 部分 OpenAI 兼容端点不支持 response_format：400 时去掉重试一次
  if (status === 400 && !isAnthropic && "response_format" in body) {
    delete body.response_format;
    ({ status, data, raw } = await post());
  }
  if (status < 200 || status >= 300) {
    throw new Error(status === 429 ? httpErrorMessage(status, snippet(data, raw)) : `HTTP ${status}: ${snippet(data, raw).slice(0, 200)}`);
  }
  return extractText(data, isAnthropic);
}

function extractText(data: unknown, isAnthropic: boolean): string {
  if (isAnthropic) {
    const blocks = (data as { content?: { type?: unknown; text?: unknown }[] })?.content;
    const text = Array.isArray(blocks)
      ? blocks.filter((b) => b?.type === "text" && typeof b?.text === "string").map((b) => b.text as string).join("\n")
      : "";
    if (!text.trim()) throw new Error("整合 AI 返回内容为空");
    return text.trim();
  }
  const msg = (data as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]?.message;
  const text = typeof msg?.content === "string" ? msg.content.trim() : "";
  if (!text) throw new Error("整合 AI 返回内容为空");
  return text;
}

/** 深读 AI 调用（纯文本模式：深度人格解读是 markdown 长文，不走 JSON 契约）；
 * Anthropic 且 webSearch=true 时挂服务端 web_search 工具（Anthropic 基础设施执行，无需回声） */
async function callPlainAi(
  cfg: AiTestInput,
  system: string,
  user: string,
  opts?: { webSearch?: boolean },
): Promise<string> {
  await castCheckpoint(); // 暂停/终止控制点
  const isAnthropic = cfg.provider === "anthropic";
  const url = isAnthropic
    ? `${cfg.baseUrl.replace(/\/+$/, "")}/v1/messages`
    : `${cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  // 流式（SSE）优先：响应头先行到达、内容持续吐字——长生成不再考验任何空闲超时；
  // 端点不支持流式（400）时去掉 stream 自动回退非流式
  const chars = makeCharsReporter();
  const body: Record<string, unknown> = isAnthropic
    ? {
        model: cfg.model,
        max_tokens: 4096,
        system,
        messages: [{ role: "user", content: user }],
        stream: true,
        // Anthropic 服务端 web_search 工具（联网由 Anthropic 执行，同响应带回引用，无需回声）
        ...(opts?.webSearch
          ? { tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 5 }] }
          : {}),
      }
    : {
        model: cfg.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        ...(omitSamplingParams(cfg) ? {} : { temperature: 0.6 }),
        stream: true,
      };
  const headers = {
    "content-type": "application/json",
    ...(isAnthropic
      ? { "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01" }
      : { authorization: `Bearer ${cfg.apiKey}` }),
  };
  const post = async () => {
    const r = await fetchWithRetry(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const ct = r.headers.get("content-type") ?? "";
    if (r.status >= 200 && r.status < 300 && body.stream === true && ct.includes("text/event-stream")) {
      // 流式：按家协议累加后合成非流式同形结构（extractText 零改动）
      if (isAnthropic) {
        const acc = await accumulateAnthropicStream(r, chars);
        return { status: r.status, data: { content: [{ type: "text", text: acc.text }] }, raw: "" };
      }
      return { status: r.status, data: synthesizeChatResponse(await accumulateChatStream(r, chars)), raw: "" };
    }
    const text = await r.text();
    let d: unknown = text;
    try {
      d = JSON.parse(text);
    } catch {
      /* 保留原文 */
    }
    return { status: r.status, data: d, raw: text };
  };
  const snippet = (d: unknown, raw: string) =>
    d && typeof d === "object"
      ? String((d as { error?: { message?: unknown } }).error?.message ?? raw)
      : raw;
  let { status, data, raw } = await post();
  // 端点不支持 SSE 流式：400 时去掉 stream 重试（后续回退链同此模式）
  if (status === 400 && body.stream === true) {
    delete body.stream;
    ({ status, data, raw } = await post());
  }
  // 思考类模型只允许 temperature=1：去掉该参数重试（providers.ts 同款兼容）
  if (status === 400 && "temperature" in body && /temperature/i.test(snippet(data, raw))) {
    delete body.temperature;
    ({ status, data, raw } = await post());
  }
  if (status < 200 || status >= 300) {
    throw new Error(status === 429 ? httpErrorMessage(status, snippet(data, raw)) : `HTTP ${status}: ${snippet(data, raw).slice(0, 200)}`);
  }
  return extractText(data, isAnthropic);
}

/** 从模型输出中提取 JSON 对象（去围栏、截首尾花括号、鲁棒解析） */
function extractJson(text: string): Record<string, unknown> | null {
  const cleaned = text.replace(/```(?:json)?/gi, "");
  const start = cleaned.indexOf("{");
  if (start < 0) return null;
  const end = cleaned.lastIndexOf("}");
  const obj = parseJsonRobust(cleaned.slice(start, end > start ? end + 1 : undefined));
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return null;
  return obj as Record<string, unknown>;
}

// ============================================================
// 第一步：消歧检索（人名 → 候选对象列表）
// ============================================================

export async function researchPerson(
  searchCfg: AiTestInput,
  name: string,
  hint?: string,
  opts?: { web?: boolean },
): Promise<PersonaResearchResult> {
  const system = [
    "你是「铸魂师」的首席资料官，为数字人类心理学实验场采集人物资料。",
    "用户会给你一个人物名（现实名人或文学/影视/游戏等虚构人物）。你的任务：找出确有其人的候选对象，处理重名消歧。",
    "严格只输出 JSON：",
    '{"candidates":[{"name":"人物名","source":"出处（作品名或现实领域）","identity":"身份一句话","summary":"基本信息附录（性格与生平，两三句）"}]}',
    "规则：按相关度排序，最多 4 个；明显指向单一人物时只给 1 个；完全查无此人时返回空数组。禁止输出任何 JSON 之外的文字。",
  ].join("\n");
  // 服务端证据池（消歧也有真实资料佐证）
  await castCheckpoint();
  stage("搜集公开资料证据池（维基/搜索引擎实搜）");
  const pool = opts?.web === false ? null : await gatherEvidence(name, hint).catch(() => null);
  const evidence = pool ? formatEvidence(pool, "anchor") : "";
  const user = [
    `人物名：「${name}」`,
    hint?.trim() ? `用户补充提示：${hint.trim()}` : "",
    "请给出候选对象列表。",
  ]
    .filter(Boolean)
    .join("\n");

  await castCheckpoint();
  stage("联网检索候选对象（重名消歧）");
  const { text, webSearched, offlineReason } = await callStageAi(searchCfg, system, user, {
    web: opts?.web !== false,
    evidence: evidence || undefined,
  });
  const obj = extractJson(text);
  const rawList = Array.isArray(obj?.candidates) ? (obj.candidates as unknown[]) : [];
  const candidates: CasterCandidate[] = rawList
    .map((c) => {
      const o = (c ?? {}) as Record<string, unknown>;
      return {
        name: String(o.name ?? "").trim(),
        source: String(o.source ?? "").trim(),
        identity: String(o.identity ?? "").trim(),
        summary: String(o.summary ?? "").trim().slice(0, 400),
      };
    })
    .filter((c) => c.name.length > 0)
    .slice(0, 4);
  return {
    candidates,
    notice: webSearched
      ? undefined
      : offlineReason
        ? `联网检索失败已降级为模型内部知识（${offlineReason}）：候选可能不准，铸造参数将全标推断项。`
        : "当前检索 AI 未配置 Kimi（未联网），候选来自模型内部知识，可能存在偏差。",
  };
}

// ============================================================
// 批量并发铸造：消歧自动取首候选 → 三步铸造（castBatch 端点的任务链）
// 并发闸门由调用方控制（castBatch 分批启动，防高峰限流）
// ============================================================

/** 单人铸造链：联网消歧 → 自动选定首候选 → 铸造；
 * 查无此人直接失败（该卡显示失败原因，不影响同批其他卡）；
 * 多候选时 notice 注明自动选定（不合适可删除后单独铸造） */
export async function runCastChain(
  searchCfg: AiTestInput,
  understandCfg: AiTestInput,
  synthCfg: AiTestInput,
  name: string,
  hint: string | undefined,
  opts?: CastOptions,
): Promise<PersonaCastResult> {
  const r = await researchPerson(searchCfg, name, hint, { web: opts?.web?.stage1 });
  const cand = r.candidates[0];
  if (!cand) {
    throw new Error(`查无此人：「${name}」未找到候选对象（可补充提示后单独铸造）`);
  }
  const result = await castPersona(searchCfg, understandCfg, synthCfg, cand.name, cand.source, hint, opts);
  if (r.candidates.length > 1) {
    const auto = `重名消歧：共 ${r.candidates.length} 个候选，已自动选定首候选「${cand.name}」（不合适可删除后单独铸造）。`;
    result.notice = result.notice ? `${auto}${result.notice}` : auto;
  }
  return result;
}

// ============================================================
// 三步铸造（三个可分别配置的 AI）：
//   ① 搜集 AI（默认 Kimi 联网）：全网搜集人物资料，保证真实可靠（研究档案 + 参考页面 URL）
//   ② 深读 AI：透过表象把握人物核心（深度人格解读：核心结构/内在矛盾/创伤防御/动机/关系/心智）
//   ③ 整合 AI：整合①②成果 → 完整人物档案（含对局注入专用「人格精粹」）+ 七组量化参数卡
// ============================================================

function buildDossierPrompts(name: string, source: string | undefined, hint: string | undefined) {
  const today = new Date().toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" });
  const system = [
    "你是「铸魂师」的首席资料官（第一步：搜集信息），为数字人类心理学实验场采集目标人物的研究档案。",
    `【时间锚】今天是 ${today}。人物的一切状态必须以当前时间为准：`,
    "- 在世者取其【当下最新状态】（最新形象/最新经历/最新关系，如 long-haired 后期形象而非早年短发形象）；",
    "- 已故者（含虚构作品中已死亡/结局离世者）取其【离世前最终状态】；",
    "- 禁止使用其早年/剧情早期的过时形象与过时经历。",
    "第一要务是真实可靠：只写有公开资料/原作设定支撑的内容，存疑之处标注「存疑」，资料不足标注「资料不足」，绝不编造。",
    "用中文 markdown 输出，总长 ≤3500 字，严格按以下小节组织：",
    "## 基本概要（是谁、出处、时代/背景，一段；注明其当下时间点的在世状态）",
    "## 生平年表（关键节点，5-10 行）",
    "## 外貌与气质（最新状态的肖像、体态、给人的感觉）",
    "## 性格与人设（核心性格、行事风格、外在表现）",
    "## 内在矛盾（TA 身上同时存在的冲突面，务必列 2-4 组）",
    "## 关键经历（塑造人格的事件：创伤/成就/背叛/失去…）",
    "## 重要关系（人物关系网：信任/宿怨/羁绊）",
    "## 标志性语录（原话或高度公认的台词，3-5 条，逐条引用）",
    "## 语言风格（用词/节奏/口癖/人称习惯）",
    "## 特殊能力（若原作/设定中有超自然/超常能力，概述之；没有则写「无」）",
    "## 候选肖像（联网搜取 3-5 张最能代表其最新状态的本人肖像图片，每行一条：- 说明（时期/出处）| 图片直链URL）",
    "## 参考页面（列出本档案依据的关键页面，每行一条：- 标题 | URL；若该人物有维基百科/百度百科页面，务必列出）",
  ].join("\n");
  const user = [
    `目标人物：「${name}」`,
    source?.trim() ? `出处：${source.trim()}` : "",
    hint?.trim() ? `用户补充提示：${hint.trim()}` : "",
    "请输出研究档案（真实可靠第一；状态以当下时间为准；候选肖像务必给可直接打开的图片直链）。",
  ]
    .filter(Boolean)
    .join("\n");
  return { system, user };
}

/** 候选肖像条目（①搜集 AI 产出，③整合 AI 从中挑选——③无需上网） */
export interface PortraitCandidate {
  label: string; // 说明（时期/出处）
  url: string; // 图片直链
}

/** 从研究档案的「候选肖像」小节解析候选图（兼容全节扫描兜底） */
export function parsePortraitCandidates(dossier: string): PortraitCandidate[] {
  const out: PortraitCandidate[] = [];
  const seen = new Set<string>();
  const push = (label: string, url: string) => {
    const u = url.trim().replace(/[，。；、.,;]+$/, "");
    if (!/^https:\/\//i.test(u) || seen.has(u)) return;
    seen.add(u);
    out.push({ label: label.trim().slice(0, 60) || "候选肖像", url: u });
  };
  const section = dossier.match(/##\s*候选肖像([\s\S]{0,3000}?)(?=\n##\s|$)/);
  const scan = (text: string) => {
    for (const m of text.matchAll(/-\s*([^|\n]{0,60}?)\s*\|\s*(https:\/\/[^\s）\]"']+\.(?:jpe?g|png|webp|gif)[^\s）\]"']*)/gi)) {
      push(m[1] ?? "", m[2] ?? "");
    }
    // 兜底：该节里任何形如图片直链的 URL（无说明文字时）
    if (section && out.length === 0) {
      for (const m of text.matchAll(/(https:\/\/[^\s|）\]"']+\.(?:jpe?g|png|webp|gif)[^\s）\]"']*)/gi)) {
        push("", m[1] ?? "");
      }
    }
  };
  if (section) scan(section[1] ?? "");
  return out.slice(0, 5);
}

/** 从研究档案提取最适合抓肖像的页面 URL（优先维基/百科，退回第一个 https 链接） */
export function extractPageUrl(dossier: string): string | null {
  const urls = [...dossier.matchAll(/https:\/\/[^\s|）\]>"']+/g)].map((m) => m[0].replace(/[，。；、.,;]+$/, ""));
  if (urls.length === 0) return null;
  const wiki = urls.find((u) => /wikipedia\.org|baike\.baidu\.com|moegirl|zhwiki/i.test(u));
  return wiki ?? urls[0] ?? null;
}

function buildReadingPrompts(name: string, dossier: string) {
  const system = [
    "你是「铸魂师」的首席人格解读师（第二步：深入理解）。你已拿到目标人物的研究档案。",
    "你的任务：透过表象把握人物的核心——不停留在「他做了什么」，要回答「他为什么只能这样做」。",
    "允许使用心理学语言（这里是分析层，术语解禁）。用中文 markdown 输出，总长 ≤2500 字，严格按以下小节组织：",
    "## 核心人格结构（TA 的心灵操作系统：什么在驱动 TA 的一切判断）",
    "## 内在冲突（≥3 组同时在场、互相拉扯的冲突，写清每一组的两极各要什么）",
    "## 创伤与防御（哪些旧伤在暗中支配 TA；TA 用什么防御机制抵挡）",
    "## 动机系统（自主/胜任/归属三大需要各自的状态与优先级）",
    "## 依恋与关系模式（TA 如何信任、如何爱人、如何防备背叛）",
    "## 压力反应（被逼到墙角时 TA 的典型反应链）",
    "## 语言心智（TA 怎样说话就怎样思考：用词背后的认知习惯）",
  ].join("\n");
  const user = [`目标人物：「${name}」`, "", "【研究档案】", dossier, "", "请输出深度人格解读。"].join("\n");
  return { system, user };
}

// ---------- 分段深读（深度模式：四段各自深挖 → 合并 → 自我批判复读） ----------
const READING_SEGMENTS: ReadonlyArray<{ id: string; title: string; short: string; focus: string }> = [
  { id: "core", title: "核心人格结构与动机系统", short: "核心", focus: "TA 的心灵操作系统：什么在驱动 TA 的一切判断；自主/胜任/归属三大需要的状态与优先级" },
  { id: "conflict", title: "内在冲突与创伤防御", short: "冲突", focus: "≥3 组同时在场、互相拉扯的冲突（写清每一组的两极各要什么）；旧伤如何暗中支配 TA；TA 用什么防御机制抵挡" },
  { id: "bond", title: "依恋与关系模式", short: "依恋", focus: "TA 如何信任、如何爱人、如何防备背叛；重要关系中的重复剧本" },
  { id: "pressure", title: "压力反应与语言心智", short: "压力", focus: "被逼到墙角时的典型反应链；TA 怎样说话就怎样思考：用词背后的认知习惯" },
];

function buildReadingSegmentPrompts(
  name: string,
  dossier: string,
  segment: (typeof READING_SEGMENTS)[number],
) {
  const system = [
    "你是「铸魂师」的首席人格解读师（第二步：深入理解 · 分段深读）。",
    `本轮你只负责一个专题：「${segment.title}」。聚焦、写透，不要泛泛覆盖其他主题。`,
    "允许使用心理学语言（这里是分析层，术语解禁）。中文 markdown 输出，≤1200 字。",
  ].join("\n");
  const user = [
    `目标人物：「${name}」`,
    "",
    "【研究档案】",
    dossier,
    "",
    `【本轮专题】${segment.title}：${segment.focus}`,
    "请输出该专题的深度解读。",
  ].join("\n");
  return { system, user };
}

function buildReadingMergePrompts(name: string, parts: { title: string; text: string }[]) {
  const system = [
    "你是「铸魂师」的首席人格解读师（第二步：深入理解 · 合并成稿）。",
    "把四个专题的分段解读合并为一份完整深度人格解读：去重、消除矛盾、统一视角。",
    "严格按以下小节组织，总长 ≤2500 字，中文 markdown：",
    "## 核心人格结构 / ## 内在冲突 / ## 创伤与防御 / ## 动机系统 / ## 依恋与关系模式 / ## 压力反应 / ## 语言心智",
  ].join("\n");
  const user = [
    `目标人物：「${name}」`,
    "",
    "【分段解读】",
    ...parts.map((p) => `### ${p.title}\n${p.text}`),
    "",
    "请输出合并后的完整深度人格解读。",
  ].join("\n");
  return { system, user };
}

/** 自我批判复读：以怀疑者身份复审解读，揪出无据推测与被调和掉的冲突（直接服务铁律6 防扁平化） */
function buildReadingCritiquePrompts(name: string, dossier: string, reading: string) {
  const system = [
    "你是「铸魂师」的怀疑者审稿人（第二步：深入理解 · 自我批判复读）。",
    "以怀疑者身份复审这份人格解读：",
    "1. 哪些论断在档案中找不到依据（无据推测）？删除或降级为「存疑」标注；",
    "2. 哪些人物冲突被悄悄调和/扁平化了？必须恢复为同时在场、互相拉扯的形态；",
    "3. 哪些重要侧面被遗漏了？补上。",
    "直接输出修订后的完整解读（保持原小节结构），禁止输出修订说明。",
  ].join("\n");
  const user = [
    `目标人物：「${name}」`,
    "",
    "【研究档案】（原始素材）",
    dossier,
    "",
    "【待审解读】",
    reading,
    "",
    "请输出修订后的完整深度人格解读。",
  ].join("\n");
  return { system, user };
}

const PARAM_CONTRACT = `{
  "name": "人格名（人物本名）",
  "originName": "原型人物名",
  "originSource": "出处（作品名或「现实人物」）",
  "profile": {
    "summary": "基本概要（一段）",
    "persona": "人设与性格画像（含内在矛盾）",
    "experiences": "关键经历（塑造人格的事件）",
    "relationships": "重要关系",
    "quotes": ["标志性原话语录，≤5 条"],
    "speechStyle": "语言风格",
    "appearance": "外貌与气质（一段）",
    "values": "价值观与信念",
    "desires": "欲望与驱动力",
    "fears": "恐惧与软肋",
    "socialMask": "社交面具与对外形象",
    "innerWorld": "内心世界与隐秘面",
    "quirks": "习惯与癖好",
    "essence": "人格精粹（≤500字，给对局注入用的行为指导：核心冲突如何表现为言行/什么会点燃TA/TA怎样说话与隐藏——这是完整档案的实战蒸馏，必须信息密度极高、可直接指导扮演；人物状态同样以当下时间为准：在世取最新状态/已故取终态）",
    "aliveStatus": "alive 或 deceased（判断其在当下时间点的在世状态：在世 alive；已故（含虚构作品中已死亡/结局离世）deceased）",
    "specialAbilities": "特殊能力概述（原作/设定中有超自然/超常能力时写，没有则空串）"
  },
  "portraitChoice": "从候选肖像中选出的那张图片的 URL（见下方候选列表，选最符合人物当下状态的一张）",
  "params": {
    "bigFive": {"openness": 0, "conscientiousness": 0, "extraversion": 0, "agreeableness": 0, "neuroticism": 0},
    "attachment": {"anxiety": 0, "avoidance": 0},
    "darkTetrad": {"machiavellianism": 0, "narcissism": 0, "psychopathy": 0, "sadism": 0},
    "cognitiveBiases": [{"id": "confirmation", "label": "确认偏误", "strength": 0}],
    "defenseMechanisms": [{"id": "rationalization", "label": "合理化", "tendency": 0, "maturity": "neurotic"}],
    "emotionRegulation": {"cognitiveReappraisal": 0, "expressiveSuppression": 0, "rumination": 0},
    "sdt": {"autonomy": 0, "competence": 0, "relatedness": 0}
  },
  "inferred": ["资料不足而被推断补全的参数路径，如 bigFive.openness、darkTetrad.sadism"]
}`;

function buildQuantifyPrompts(
  name: string,
  dossier: string,
  reading: string,
  webSearched: boolean,
  candidates: PortraitCandidate[],
) {
  const today = new Date().toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" });
  const system = [
    "你是「铸魂师」的人格量化分析师（第三步：整合量化），精通大五人格、依恋理论、黑暗四人格、认知偏差、防御机制、情绪调节（Gross）与自我决定论（SDT）。",
    "把「研究档案 + 深度人格解读」整合为一张完整的人格参数卡（完整人物档案 + 七组量化参数 + 对局注入专用的人格精粹 + 在世状态 + 特殊能力封印 + 肖像挑选）。",
    `【时间锚】今天是 ${today}：档案与参数所反映的人物状态必须以当下时间为准（在世取最新状态/已故取终态），不得反映其早年过时形象与经历。`,
    "量化铁律：",
    "1. 全部参数为 0-100 整数；",
    "2. 真情生于撕裂——禁止扁平化：相互冲突的参数必须同时给足强度（如宜人性 25 与马基雅维利 85 并存；神经质 80 与表达抑制 75 并存），内在矛盾是人格的核心，不得调和取舍；",
    "3. 每条参数都要有档案/解读依据；资料不足的字段按心理学原型给出最合理推断，并把参数路径写入 inferred 数组（推断项）；",
    "4. 认知偏差 2-7 条、防御机制 2-7 条（maturity 仅限 primitive/neurotic/mature）；语录必须是人物原话或公认台词；",
    "5. profile.essence（人格精粹）是整卡最重要的字段：≤500 字、行为指导级——它将被直接注入对局扮演该人格，必须写出 TA 的核心冲突如何变成具体言行、什么情境会点燃 TA、TA 如何说话与隐藏；",
    "6. portraitChoice：从【候选肖像】列表里选出最符合人物当下状态（最新形象/终态形象）的一张，输出其原 URL，禁止编造列表之外的 URL；",
    "7. 严格只输出 JSON 本体，禁止任何解释文字与 markdown 围栏。",
  ].join("\n");
  const user = [
    `目标人物：「${name}」`,
    "",
    webSearched ? "【研究档案】（第一步·联网搜集）" : "【研究档案】（第一步·未联网，来自模型内部知识——拿不准的参数一律写入 inferred）",
    dossier,
    "",
    "【深度人格解读】（第二步·深入理解）",
    reading,
    "",
    candidates.length > 0
      ? `【候选肖像】（③只需从中挑选 URL，无需上网）\n${candidates.map((c, i) => `${i + 1}. ${c.label} | ${c.url}`).join("\n")}`
      : "【候选肖像】（①未能搜到候选图：portraitChoice 输出空串）",
    "",
    "【输出契约】严格按此结构输出（数值为示意，请按素材重新评估）：",
    PARAM_CONTRACT,
  ].join("\n");
  return { system, user };
}

// ---------- 草稿清洗：把模型输出矫正为合法 PersonaCardInput（钳位/过滤/截断） ----------
const clamp01 = (v: unknown, dflt = 50): number => {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : dflt;
  return Math.max(0, Math.min(100, n));
};
const asStr = (v: unknown, max: number): string => String(v ?? "").trim().slice(0, max);
const VALID_MATURITY = new Set(["primitive", "neurotic", "mature"]);

export function sanitizeCastedDraft(
  raw: Record<string, unknown>,
  fallbackName: string,
): PersonaCardInput {
  const p = (raw.params ?? {}) as Record<string, unknown>;
  const prof = (raw.profile ?? {}) as Record<string, unknown>;
  const num = (obj: unknown, key: string): number =>
    clamp01((obj as Record<string, unknown> | undefined)?.[key]);

  const biases = (Array.isArray(p.cognitiveBiases) ? p.cognitiveBiases : [])
    .map((b) => {
      const o = (b ?? {}) as Record<string, unknown>;
      const label = asStr(o.label, 32);
      return label
        ? { id: asStr(o.id, 64) || label, label, strength: clamp01(o.strength) }
        : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .slice(0, 12);

  const defenses = (Array.isArray(p.defenseMechanisms) ? p.defenseMechanisms : [])
    .map((d) => {
      const o = (d ?? {}) as Record<string, unknown>;
      const label = asStr(o.label, 32);
      const maturity = VALID_MATURITY.has(String(o.maturity))
        ? (String(o.maturity) as "primitive" | "neurotic" | "mature")
        : "neurotic";
      return label
        ? { id: asStr(o.id, 64) || label, label, tendency: clamp01(o.tendency), maturity }
        : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .slice(0, 12);

  const quotes = (Array.isArray(prof.quotes) ? prof.quotes : [])
    .map((q) => asStr(q, 200))
    .filter(Boolean)
    .slice(0, 5);

  const inferred = (Array.isArray(raw.inferred) ? raw.inferred : [])
    .map((x) => asStr(x, 128))
    .filter(Boolean)
    .slice(0, 64);

  return {
    name: asStr(raw.name, 64) || fallbackName,
    originName: asStr(raw.originName, 128) || null,
    originSource: asStr(raw.originSource, 128) || null,
    profile: {
      summary: asStr(prof.summary, 4000),
      persona: asStr(prof.persona, 4000),
      experiences: asStr(prof.experiences, 8000),
      relationships: asStr(prof.relationships, 4000),
      quotes,
      speechStyle: asStr(prof.speechStyle, 2000),
      appearance: asStr(prof.appearance, 2000),
      values: asStr(prof.values, 3000),
      desires: asStr(prof.desires, 3000),
      fears: asStr(prof.fears, 3000),
      socialMask: asStr(prof.socialMask, 2000),
      innerWorld: asStr(prof.innerWorld, 3000),
      quirks: asStr(prof.quirks, 2000),
      essence: asStr(prof.essence, 1200),
      aliveStatus:
        prof.aliveStatus === "alive" || prof.aliveStatus === "deceased" ? prof.aliveStatus : null,
      specialAbilities: asStr(prof.specialAbilities, 1000),
    },
    params: {
      bigFive: {
        openness: num(p.bigFive, "openness"),
        conscientiousness: num(p.bigFive, "conscientiousness"),
        extraversion: num(p.bigFive, "extraversion"),
        agreeableness: num(p.bigFive, "agreeableness"),
        neuroticism: num(p.bigFive, "neuroticism"),
      },
      attachment: { anxiety: num(p.attachment, "anxiety"), avoidance: num(p.attachment, "avoidance") },
      darkTetrad: {
        machiavellianism: num(p.darkTetrad, "machiavellianism"),
        narcissism: num(p.darkTetrad, "narcissism"),
        psychopathy: num(p.darkTetrad, "psychopathy"),
        sadism: num(p.darkTetrad, "sadism"),
      },
      cognitiveBiases: biases,
      defenseMechanisms: defenses,
      emotionRegulation: {
        cognitiveReappraisal: num(p.emotionRegulation, "cognitiveReappraisal"),
        expressiveSuppression: num(p.emotionRegulation, "expressiveSuppression"),
        rumination: num(p.emotionRegulation, "rumination"),
      },
      sdt: {
        autonomy: num(p.sdt, "autonomy"),
        competence: num(p.sdt, "competence"),
        relatedness: num(p.sdt, "relatedness"),
      },
      inferred,
    },
    notes: "",
  };
}

/** 全部参数标推断（未联网降级模式） */
function markAllInferred(draft: PersonaCardInput): PersonaCardInput {
  const paths = [
    ...Object.keys(draft.params.bigFive).map((k) => `bigFive.${k}`),
    "attachment.anxiety",
    "attachment.avoidance",
    ...Object.keys(draft.params.darkTetrad).map((k) => `darkTetrad.${k}`),
    ...Object.keys(draft.params.emotionRegulation).map((k) => `emotionRegulation.${k}`),
    ...Object.keys(draft.params.sdt).map((k) => `sdt.${k}`),
    ...draft.params.cognitiveBiases.map((b) => `cognitiveBiases.${b.id}`),
    ...draft.params.defenseMechanisms.map((d) => `defenseMechanisms.${d.id}`),
  ];
  return { ...draft, params: { ...draft.params, inferred: [...new Set([...draft.params.inferred, ...paths])] } };
}

/** 铸造编排选项（向导「分阶段联网开关 + 深读深度」） */
export interface CastOptions {
  /** 三阶段各自的联网检索开关（默认全开；模型原生联网 + 服务端证据池双轨） */
  web?: { stage1?: boolean; stage2?: boolean; stage3?: boolean };
  /** 深读深度：segmented=四段分段深挖；selfCritique=自我批判复读（默认双开；快速模式双关） */
  deepRead?: { segmented?: boolean; selfCritique?: boolean };
}

export async function castPersona(
  searchCfg: AiTestInput,
  understandCfg: AiTestInput,
  synthCfg: AiTestInput,
  name: string,
  source?: string,
  hint?: string,
  opts?: CastOptions,
): Promise<PersonaCastResult> {
  const web = {
    stage1: opts?.web?.stage1 !== false,
    stage2: opts?.web?.stage2 !== false,
    stage3: opts?.web?.stage3 !== false,
  };
  const deepRead = {
    segmented: opts?.deepRead?.segmented !== false,
    selfCritique: opts?.deepRead?.selfCritique !== false,
  };

  // 服务端证据池（模型无关的联网底座；任一阶段开联网即采集；全链 best-effort）
  await castCheckpoint();
  stage("搜集公开资料证据池（维基/搜索引擎实搜）");
  const pool: EvidencePool =
    web.stage1 || web.stage2 || web.stage3
      ? await gatherEvidence(name, hint).catch(() => ({ snippets: [], portraitUrls: [] }))
      : { snippets: [], portraitUrls: [] };

  // ① 搜集 AI：研究档案（含候选肖像与参考页面 URL；证据池全量注入）
  await castCheckpoint();
  stage("① 搜集人物研究档案");
  const dp = buildDossierPrompts(name, source, hint);
  const { text: dossier, webSearched, offlineReason } = await callStageAi(searchCfg, dp.system, dp.user, {
    web: web.stage1,
    evidence: web.stage1 ? formatEvidence(pool, "full") || undefined : undefined,
  });

  // ② 深读 AI：快速模式=单段式；深度模式=四段分段深挖（并行）→ 合并 → 自我批判复读
  const reviewEvidence = web.stage2 ? formatEvidence(pool, "review") || undefined : undefined;
  let reading: string;
  if (deepRead.segmented) {
    await castCheckpoint();
    stage("② 分段深读人格（4 专题并行）");
    const parts = await Promise.all(
      READING_SEGMENTS.map(async (seg) =>
        withLane(seg.short, async () => {
          const sp = buildReadingSegmentPrompts(name, dossier, seg);
          const r = await callStageAi(understandCfg, sp.system, sp.user, {
            web: web.stage2,
            evidence: reviewEvidence,
          });
          return { title: seg.title, text: r.text };
        }),
      ),
    );
    await castCheckpoint();
    stage("② 合并四段解读成稿");
    const mp = buildReadingMergePrompts(name, parts);
    reading = (await callStageAi(understandCfg, mp.system, mp.user, { web: false })).text.trim();
  } else {
    await castCheckpoint();
    stage("② 深读人格解读");
    const rp = buildReadingPrompts(name, dossier);
    reading = (
      await callStageAi(understandCfg, rp.system, rp.user, { web: web.stage2, evidence: reviewEvidence })
    ).text.trim();
  }
  if (deepRead.selfCritique) {
    await castCheckpoint();
    stage("② 自我批判复读（揪出无据推测、恢复被调和的冲突）");
    const cp = buildReadingCritiquePrompts(name, dossier, reading);
    reading = (await callStageAi(understandCfg, cp.system, cp.user, { web: false })).text.trim();
  }

  // 候选肖像下载（①联网搜取 + 证据池维基代表图合并；③只需挑选，无需上网）
  await castCheckpoint();
  stage("挑选与下载候选肖像");
  const seen = new Set<string>();
  const candidates = [...parsePortraitCandidates(dossier), ...pool.portraitUrls].filter((c) => {
    if (seen.has(c.url)) return false;
    seen.add(c.url);
    return true;
  });
  const downloaded = (
    await Promise.all(
      candidates.slice(0, 4).map(async (c) => ({
        ...c,
        dataUrl: await fetchImageAsDataUrl(c.url),
      })),
    )
  ).filter((c): c is PortraitCandidate & { dataUrl: string } => c.dataUrl !== null);

  // ③ 整合 AI：①+②+证据锚点 → 完整档案（含人格精粹）+ 七组量化 + 肖像挑选（校验失败重修一次）
  await castCheckpoint();
  stage("③ 整合量化人格参数卡");
  const qp = buildQuantifyPrompts(name, dossier, reading, webSearched, downloaded);
  const anchorEvidence = web.stage3 ? formatEvidence(pool, "anchor") || undefined : undefined;
  let lastIssues = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt === 1) note("结构校验未过，带原因重修中");
    const user =
      attempt === 0
        ? qp.user
        : `${qp.user}\n\n【上一次输出未通过结构校验】${lastIssues}\n请修正后重新输出完整 JSON。`;
    // ③ 联网开 → 统一路由（Kimi 工具循环 / Anthropic server tool / DeepSeek·OpenAI Responses + 证据锚点）；
    // 联网关 → callSynthAi（response_format JSON 模式，结构更稳）。输出均经 extractJson 鲁棒解析。
    const text = web.stage3
      ? (
          await callStageAi(synthCfg, qp.system, user, {
            web: true,
            evidence: anchorEvidence,
          })
        ).text
      : await callSynthAi(synthCfg, qp.system, user);
    const obj = extractJson(text);
    if (obj) {
      let draft = sanitizeCastedDraft(obj, name);
      if (!webSearched) draft = markAllInferred(draft);
      const check = personaInputSchema.safeParse(draft);
      // 空壳拦截（实锤：张雪峰一轮合成产出全空 profile 却通过 schema——各字段只有 max 无 min）。
      // 档案正文两段为空 = 合成失败，按校验未过走重修/重试，绝不让空壳入库
      if (check.success && (!draft.profile.summary.trim() || !draft.profile.persona.trim())) {
        lastIssues = "合成产出为空壳（summary/persona 均空）——请基于①档案与②深读真实撰写完整档案";
        continue;
      }
      if (check.success) {
        // 肖像定案：③的 portraitChoice 命中候选下载集则用其 data URL；
        // 未命中/未选 → 第一张下载成功的候选；全灭 → 参考页 og:image 兜底
        const choiceUrl = typeof obj.portraitChoice === "string" ? obj.portraitChoice.trim() : "";
        const picked = downloaded.find((c) => c.url === choiceUrl) ?? downloaded[0] ?? null;
        let finalImage: string | null = picked?.dataUrl ?? null;
        if (!finalImage) {
          const pageUrl = extractPageUrl(dossier);
          if (pageUrl) finalImage = await fetchPortraitFromPage(pageUrl);
        }
        return {
          draft: { ...draft, imageData: finalImage ?? null },
          notice: webSearched
            ? finalImage
              ? undefined
              : "档案已铸成；未能自动获取肖像，可在编辑器中上传或从链接获取。"
            : offlineReason
              ? `联网检索失败已降级为模型内部知识（${offlineReason}）：全部参数已按推断项标注，请在编辑器里核对。`
              : "检索 AI 未联网：档案来自模型内部知识（已尽量用服务端实搜材料补足），全部参数已按推断项标注，请在编辑器里核对。",
        };
      }
      lastIssues = check.error.issues
        .slice(0, 6)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("；")
        .slice(0, 500);
      continue;
    }
    lastIssues = "输出不是可解析的 JSON 对象";
  }
  throw new Error(`整合量化失败：${lastIssues || "AI 输出异常"}（可重试，或检查整合 AI 配置）`);
}
