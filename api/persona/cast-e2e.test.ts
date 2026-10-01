import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { castPersona } from "./caster";
import { ackCast, castControl, getActiveCast, getCastProgress, startCastJob } from "./progress";

// ============================================================
// 铸魂师铸造全链路端到端测试（「足以完整生成完毕」的保障）
// 本地 mock AI 端点（SSE 流式应答）扮演 chat/completions，覆盖深度模式全路径：
// ① 搜集档案 → ② 四段并行深读 → 合并成稿 → 自我批判复读 → ③ 整合量化（共 8 次调用）。
// 另验证：异步任务（startCastJob）进度轨迹、终态产物、getActiveCast 现场找回、
// 用户隔离、ackCast 取走确认——与客户端「界面消失/重开不知进度」的两个 bug 对应。
// ============================================================

const DOSSIER = [
  "## 基本概要",
  "测试人物，《测试纪元》主角，当代虚拟人物。",
  "## 生平年表",
  "- 纪元1年 出生",
  "- 纪元20年 一战成名",
  "## 外貌与气质",
  "短发，眼神锐利，沉默寡言。",
  "## 性格与人设",
  "外冷内热，极度自律。",
  "## 内在矛盾",
  "渴望归属 vs 拒绝依赖；追求秩序 vs 向往自由。",
  "## 关键经历",
  "纪元20年的背叛事件塑造了其多疑面。",
  "## 重要关系",
  "与导师老 K 亦师亦友。",
  "## 标志性语录",
  "- 「少说，多做。」",
  "## 语言风格",
  "短句，少形容词。",
  "## 特殊能力",
  "无",
].join("\n");

const READING = [
  "## 核心人格结构",
  "以「可控感」为轴心的防御型操作系统。",
  "## 内在冲突",
  "归属与自立互搏；秩序与自由互搏。",
  "## 创伤与防御",
  "背叛创伤 → 合理化与升华并用。",
  "## 动机系统",
  "自主 > 胜任 > 归属。",
  "## 依恋与关系模式",
  "低焦虑高回避：想靠近又先推开。",
  "## 压力反应",
  "先僵硬、后爆发、再自责。",
  "## 语言心智",
  "句子越短，内心越紧。",
].join("\n");

const CARD = {
  name: "测试人物",
  originName: "测试人物",
  originSource: "《测试纪元》",
  profile: {
    summary: "《测试纪元》主角，外冷内热的独行者。",
    persona: "自律克制，内在撕裂。",
    experiences: "纪元20年遭背叛，自此先防人。",
    relationships: "与导师老 K 亦师亦友。",
    quotes: ["少说，多做。"],
    speechStyle: "短句，少形容词。",
    appearance: "短发，眼神锐利。",
    values: "秩序、承诺。",
    desires: "掌控自己的命运。",
    fears: "再次被信任的人背叛。",
    socialMask: "冷漠高效。",
    innerWorld: "渴望被接住。",
    quirks: "说话前停顿半秒。",
    essence: "核心冲突：想靠近却先推开。说话短促克制，越是动情越沉默。被质疑时会先僵住半秒再反击。",
    aliveStatus: "alive",
    specialAbilities: "",
  },
  portraitChoice: "",
  params: {
    bigFive: { openness: 60, conscientiousness: 55, extraversion: 40, agreeableness: 70, neuroticism: 35 },
    attachment: { anxiety: 30, avoidance: 45 },
    darkTetrad: { machiavellianism: 50, narcissism: 40, psychopathy: 20, sadism: 10 },
    cognitiveBiases: [
      { id: "confirmation", label: "确认偏误", strength: 60 },
      { id: "anchoring", label: "锚定效应", strength: 50 },
    ],
    defenseMechanisms: [
      { id: "rationalization", label: "合理化", tendency: 55, maturity: "neurotic" },
      { id: "sublimation", label: "升华", tendency: 60, maturity: "mature" },
    ],
    emotionRegulation: { cognitiveReappraisal: 65, expressiveSuppression: 40, rumination: 30 },
    sdt: { autonomy: 70, competence: 60, relatedness: 55 },
  },
  inferred: [],
};

/** 把文本切成两块包成 SSE 流（content-type + delta 增量 + [DONE]） */
function sseBody(text: string): string {
  const mid = Math.max(1, Math.ceil(text.length / 2));
  const parts = [text.slice(0, mid), text.slice(mid)];
  return (
    parts
      .map(
        (c, i) =>
          `data: ${JSON.stringify({
            choices: [{ delta: { content: c }, ...(i === parts.length - 1 ? { finish_reason: "stop" } : {}) }],
          })}\n\n`,
      )
      .join("") + "data: [DONE]\n\n"
  );
}

describe("铸魂师铸造全链路 E2E（异步任务 + 流式 mock 端点）", () => {
  let server: http.Server;
  let baseUrl = "";
  const calls: Record<string, number> = {};

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const parsed = JSON.parse(body) as { messages?: { role: string; content: string }[] };
        const sys = String(parsed.messages?.[0]?.content ?? "");
        let key = "other";
        let text = "好的。";
        if (sys.includes("第一步：搜集信息")) {
          key = "dossier";
          text = DOSSIER;
        } else if (sys.includes("怀疑者审稿人")) {
          key = "critique";
          text = READING;
        } else if (sys.includes("合并成稿")) {
          key = "merge";
          text = READING;
        } else if (sys.includes("分段深读")) {
          key = "segment";
          text = READING;
        } else if (sys.includes("深入理解")) {
          key = "reading"; // 快速模式的单段深读
          text = READING;
        } else if (sys.includes("第三步：整合量化")) {
          key = "quantify";
          text = JSON.stringify(CARD);
        }
        calls[key] = (calls[key] ?? 0) + 1;
        // 模拟真实生成耗时，让前端轮询能捕到各阶段
        setTimeout(() => {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end(sseBody(text));
        }, 150);
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });

  afterAll(async () => {
    await new Promise((r) => server.close(r));
  });

  it("深度模式完整铸造成功：8 次调用、终态产物合法、阶段轨迹可见、现场可找回", async () => {
    const cfg = { provider: "custom" as const, baseUrl, model: "mock-model", apiKey: "sk-mock" };
    const castId = "e2e-cast-deep";
    startCastJob(castId, 42, "测试人物", () =>
      castPersona(cfg, cfg, cfg, "测试人物", "《测试纪元》", undefined, {
        web: { stage1: false, stage2: false, stage3: false },
        deepRead: { segmented: true, selfCritique: true },
      }),
    );

    // 轮询至终态（记录阶段轨迹）
    const labels = new Set<string>();
    let p = getCastProgress(castId, 42);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      p = getCastProgress(castId, 42);
      if (p) labels.add(p.label);
      if (p?.done) break;
      await new Promise((r) => setTimeout(r, 30));
    }

    // 终态与产物
    expect(p, "30s 内铸造应完成").toBeTruthy();
    expect(p!.done).toBe(true);
    expect(p!.error).toBeNull();
    const result = p!.result!;
    expect(result.draft.name).toBe("测试人物");
    expect(result.draft.originSource).toBe("《测试纪元》");
    expect(result.draft.params.bigFive.openness).toBe(60);
    expect(result.draft.params.attachment.avoidance).toBe(45);
    expect(result.draft.params.defenseMechanisms).toHaveLength(2);
    expect(result.draft.profile.quotes).toEqual(["少说，多做。"]);
    expect(result.draft.profile.essence).toContain("想靠近却先推开");
    // 未联网 → 全部参数标推断（客户端编辑器可据此提示核对）
    expect(result.draft.params.inferred.length).toBeGreaterThan(10);

    // 调用计数：①1 + ②(4 段 + 合并 + 批判) + ③1 = 8，每步恰好一次（无重修）
    expect(calls).toEqual({ dossier: 1, segment: 4, merge: 1, critique: 1, quantify: 1 });

    // 阶段轨迹：①②③ 都出现过（客户端界面得以实时展示真实进度）
    expect([...labels].some((l) => l.includes("① 搜集"))).toBe(true);
    expect([...labels].some((l) => l.includes("②"))).toBe(true);
    expect([...labels].some((l) => l.includes("③ 整合量化"))).toBe(true);

    // 现场找回：重开向导能拿到完成态与草稿（「重新点开不知道进程到哪了」根治）
    const active = getActiveCast(42);
    expect(active?.castId).toBe(castId);
    expect(active?.done).toBe(true);
    expect(active?.result?.draft.name).toBe("测试人物");

    // 用户隔离
    expect(getActiveCast(43)).toBeNull();
    expect(getCastProgress(castId, 43)).toBeNull();

    // 取走确认后不再恢复
    ackCast(castId);
    expect(getActiveCast(42)).toBeNull();
  });

  it("快速模式（单段深读无批判）同样完整跑完：5 次调用", async () => {
    for (const k of Object.keys(calls)) delete calls[k];
    const cfg = { provider: "custom" as const, baseUrl, model: "mock-model", apiKey: "sk-mock" };
    const castId = "e2e-cast-fast";
    startCastJob(castId, 42, "测试人物", () =>
      castPersona(cfg, cfg, cfg, "测试人物", undefined, undefined, {
        web: { stage1: false, stage2: false, stage3: false },
        deepRead: { segmented: false, selfCritique: false },
      }),
    );
    let p = getCastProgress(castId, 42);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      p = getCastProgress(castId, 42);
      if (p?.done) break;
      await new Promise((r) => setTimeout(r, 30));
    }
    expect(p!.done).toBe(true);
    expect(p!.error).toBeNull();
    expect(p!.result!.draft.name).toBe("测试人物");
    // ①1 + ②单段1 + ③1 = 3
    expect(calls).toEqual({ dossier: 1, reading: 1, quantify: 1 });
    ackCast(castId);
  });

  it("铸造途中终止：任务链中断、条目删除、castActive 不再找回", async () => {
    for (const k of Object.keys(calls)) delete calls[k];
    const cfg = { provider: "custom" as const, baseUrl, model: "mock-model", apiKey: "sk-mock" };
    const castId = "e2e-cast-cancel";
    startCastJob(castId, 42, "测试人物", () =>
      castPersona(cfg, cfg, cfg, "测试人物", undefined, undefined, {
        web: { stage1: false, stage2: false, stage3: false },
        deepRead: { segmented: true, selfCritique: true },
      }),
    );
    // 等它跑进①（150ms 延迟响应）
    await new Promise((r) => setTimeout(r, 100));
    expect(getCastProgress(castId, 42)?.name).toBe("测试人物");
    expect(castControl(castId, 42, "cancel")).toBe(true);
    await new Promise((r) => setTimeout(r, 600)); // 任务链在检查点中断并清理
    expect(getCastProgress(castId, 42)).toBeNull();
    expect(getActiveCast(42)).toBeNull();
    // ①之后不再产生新的 AI 调用（②/③ 未发生）
    expect(calls.segment ?? 0).toBe(0);
    expect(calls.quantify ?? 0).toBe(0);
  });
});
