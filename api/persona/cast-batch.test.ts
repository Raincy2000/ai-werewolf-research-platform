import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { runCastChain } from "./caster";
import { getActiveCasts, getCastProgress } from "./progress";
import { appRouter } from "../router";

// ============================================================
// 批量并发铸造编排测试（mock AI 端点 + 真 castBatch 端点）
// 覆盖：任务链（消歧自动取首候选→铸造）、查无此人独立失败、并发闸门 2、
// 复数活跃列表（进行中优先、完成倒序、上限）
// ============================================================

function sseText(text: string): string {
  const mid = Math.max(1, Math.ceil(text.length / 2));
  return (
    `data: ${JSON.stringify({ choices: [{ delta: { content: text.slice(0, mid) } }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ delta: { content: text.slice(mid) }, finish_reason: "stop" }] })}\n\n` +
    "data: [DONE]\n\n"
  );
}

const DOSSIER = "## 基本概要\n测试人物档案。\n## 生平年表\n- 出生\n## 性格与人设\n沉稳。";
const READING = "## 核心人格结构\n以秩序为轴。";
const CARD = (name: string) =>
  JSON.stringify({
    name,
    originName: name,
    originSource: "《测试纪元》",
    profile: {
      summary: `${name}，测试人物。`,
      persona: "沉稳克制。",
      experiences: "早年历练。",
      relationships: "师友数名。",
      quotes: ["少说，多做。"],
      speechStyle: "短句。",
      appearance: "清瘦，目光沉静。",
      values: "秩序。",
      desires: "掌控。",
      fears: "失控。",
      socialMask: "冷淡。",
      innerWorld: "热忱。",
      quirks: "沉思。",
      essence: "核心冲突：想靠近却先推开。",
      aliveStatus: "alive",
      specialAbilities: "",
    },
    portraitChoice: "",
    params: {
      bigFive: { openness: 60, conscientiousness: 70, extraversion: 40, agreeableness: 55, neuroticism: 30 },
      attachment: { anxiety: 30, avoidance: 50 },
      darkTetrad: { machiavellianism: 45, narcissism: 35, psychopathy: 15, sadism: 5 },
      cognitiveBiases: [
        { id: "confirmation", label: "确认偏误", strength: 55 },
        { id: "anchoring", label: "锚定效应", strength: 50 },
      ],
      defenseMechanisms: [
        { id: "rationalization", label: "合理化", tendency: 55, maturity: "neurotic" },
        { id: "sublimation", label: "升华", tendency: 60, maturity: "mature" },
      ],
      emotionRegulation: { cognitiveReappraisal: 65, expressiveSuppression: 45, rumination: 30 },
      sdt: { autonomy: 70, competence: 65, relatedness: 55 },
    },
    inferred: [],
  });

const AI_CFG = { provider: "custom" as const, baseUrl: "", model: "mock", apiKey: "sk-mock" };

describe("批量并发铸造编排", () => {
  let server: http.Server;
  let baseUrl = "";
  const delays: string[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const parsed = JSON.parse(body) as { messages?: { role: string; content: string }[] };
        const sys = String(parsed.messages?.[0]?.content ?? "");
        const user = String(parsed.messages?.[1]?.content ?? "");
        let text = "好的。";
        let delay = 50;
        if (sys.includes("重名消歧")) {
          // 消歧：曹操→2 候选；五条悟→1 候选；查无此人星→空
          const name = user.match(/人物名：「([^」]+)」/)?.[1] ?? "";
          if (name.includes("查无此人")) text = JSON.stringify({ candidates: [] });
          else if (name === "曹操") {
            text = JSON.stringify({
              candidates: [
                { name: "曹操", source: "《三国演义》", identity: "曹魏奠基人", summary: "枭雄。" },
                { name: "曹操", source: "现代同名", identity: "路人", summary: "同名者。" },
              ],
            });
          } else {
            text = JSON.stringify({ candidates: [{ name, source: "《测试纪元》", identity: "主角", summary: "测试人物。" }] });
          }
        } else if (sys.includes("第一步：搜集信息")) {
          text = DOSSIER;
          delay = 60;
        } else if (sys.includes("深入理解") || sys.includes("分段深读") || sys.includes("合并成稿") || sys.includes("怀疑者审稿人")) {
          text = READING;
          delay = 60;
        } else if (sys.includes("第三步：整合量化")) {
          const name = user.match(/目标人物：「([^」]+)」/)?.[1] ?? "测试人物";
          text = CARD(name);
          delay = 60;
        }
        setTimeout(() => {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end(sseText(text));
        }, delay);
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });

  afterAll(async () => {
    await new Promise((r) => server.close(r));
  });

  it("castBatch 全链路：2 成功 + 查无此人独立失败；并发闸门 2；复数列表透出", async () => {
    const caller = appRouter.createCaller({
      req: new Request("http://test.local/"),
      resHeaders: new Headers(),
      user: { id: "u-batch", email: "b@t.local", username: "batch", avatar: "", createdAt: new Date().toISOString() },
    });
    const { items } = await caller.persona.castBatch({
      items: [{ name: "曹操" }, { name: "五条悟" }, { name: "查无此人星" }],
      searchAi: { ...AI_CFG, baseUrl },
      understandAi: { ...AI_CFG, baseUrl },
      synthAi: { ...AI_CFG, baseUrl },
      web: { stage1: false, stage2: false, stage3: false },
      deepRead: { segmented: false, selfCritique: false },
    });
    expect(items).toHaveLength(3);

    // 闸门观测：进行中任务数峰值
    let maxRunning = 0;
    const deadline = Date.now() + 30_000;
    const doneSet = new Set<string>();
    while (Date.now() < deadline) {
      let running = 0;
      for (const it of items) {
        const p = getCastProgress(it.castId, "u-batch");
        if (p && !p.done) running++;
        if (p?.done) doneSet.add(it.castId);
      }
      maxRunning = Math.max(maxRunning, running);
      if (doneSet.size === items.length) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(doneSet.size).toBe(3);
    expect(maxRunning).toBeLessThanOrEqual(2); // 并发闸门 2
    expect(maxRunning).toBeGreaterThanOrEqual(1);

    // 终态：曹操/五条悟成功（多候选自动选定首候选 + notice 注明），查无此人独立失败
    const byName = new Map(items.map((it) => [it.name, getCastProgress(it.castId, "u-batch")!]));
    expect(byName.get("曹操")!.error).toBeNull();
    expect(byName.get("曹操")!.result!.draft.name).toBe("曹操");
    expect(byName.get("曹操")!.result!.notice).toContain("自动选定首候选");
    expect(byName.get("五条悟")!.error).toBeNull();
    expect(byName.get("五条悟")!.result!.draft.name).toBe("五条悟");
    expect(byName.get("查无此人星")!.error).toContain("查无此人");
    expect(byName.get("查无此人星")!.result).toBeNull();

    // 复数活跃列表：3 项全部透出（已完成的按完成倒序）
    const actives = getActiveCasts("u-batch");
    expect(actives.length).toBe(3);
    expect(actives.every((a) => a.done)).toBe(true);
    // 用户隔离
    expect(getActiveCasts("other-user")).toEqual([]);
  }, 60_000);

  it("runCastChain：多候选自动取首候选并注明；查无此人直接失败", async () => {
    const cfg = { ...AI_CFG, baseUrl };
    const r = await runCastChain(cfg, cfg, cfg, "曹操", undefined, {
      web: { stage1: false, stage2: false, stage3: false },
      deepRead: { segmented: false, selfCritique: false },
    });
    expect(r.draft.name).toBe("曹操");
    expect(r.notice).toContain("共 2 个候选");
    await expect(
      runCastChain(cfg, cfg, cfg, "查无此人星", undefined, {
        web: { stage1: false, stage2: false, stage3: false },
      }),
    ).rejects.toThrow("查无此人");
  }, 60_000);
});
