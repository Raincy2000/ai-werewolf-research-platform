// ============================================================
// 证据池与 Responses API 解析 — 纯函数单测
// ============================================================

import { describe, expect, it } from "vitest";
import { formatEvidence, parseDdgHtml, type EvidencePool } from "./websearch";
import { extractResponsesText } from "./responses";

const DDG_FIXTURE = `<table>
<tr><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fzhihu.com%2Fanswer%2F1&amp;rut=abc" class="result-link">艾伦耶格尔人物分析</a></td></tr>
<tr><td class="result-snippet">艾伦的驱动力是自由执念与守护同伴的撕裂……</td></tr>
<tr><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=http%3A%2F%2Finsecure.com%2Fx" class="result-link">不安全链接</a></td></tr>
<tr><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fbaike.com%2Feren" class="result-link">艾伦·耶格尔_百科</a></td></tr>
<tr><td class="result-snippet">  终局时长发、发动地鸣  </td></tr>
</table>`;

describe("parseDdgHtml（DDG lite 结果解析）", () => {
  it("提取标题/解码 uddg 链接/摘要配对；拒绝非 https", () => {
    const rows = parseDdgHtml(DDG_FIXTURE, 5);
    expect(rows.length).toBe(2);
    expect(rows[0]!.url).toBe("https://zhihu.com/answer/1");
    expect(rows[0]!.title).toBe("艾伦耶格尔人物分析");
    expect(rows[0]!.text).toContain("自由执念");
    expect(rows[1]!.url).toBe("https://baike.com/eren");
  });
});

describe("formatEvidence（证据池注入文本）", () => {
  const pool: EvidencePool = {
    snippets: [
      { title: "维基百科·艾伦", url: "https://zh.wikipedia.org/wiki/x", text: "艾伦·耶格尔是……", source: "wikipedia-zh" },
      { title: "知乎分析", url: "https://zhihu.com/answer/1", text: "他的内在冲突是……", source: "duckduckgo" },
    ],
    portraitUrls: [{ label: "维基代表图", url: "https://upload.wikimedia.org/x.jpg" }],
  };
  it("full 全量 / review 偏评论向 / anchor 截断压缩", () => {
    expect(formatEvidence(pool, "full")).toContain("维基百科·艾伦");
    expect(formatEvidence(pool, "full")).toContain("知乎分析");
    const review = formatEvidence(pool, "review");
    expect(review).toContain("知乎分析");
    expect(review).not.toContain("维基百科·艾伦");
    // review 无评论向时退回 anchor 兜底
    const wikiOnly: EvidencePool = { snippets: [pool.snippets[0]!], portraitUrls: [] };
    expect(formatEvidence(wikiOnly, "review")).toContain("维基百科·艾伦");
    expect(formatEvidence({ snippets: [], portraitUrls: [] }, "full")).toBe("");
  });
});

describe("extractResponsesText（Responses API 响应解析）", () => {
  it("从 output[].content[] 提取 output_text；忽略工具调用项", () => {
    const data = {
      output: [
        { type: "web_search_call", action: { queries: ["x"] } },
        {
          type: "message",
          content: [
            { type: "output_text", text: "第一段" },
            { type: "refusal", refusal: "no" },
            { type: "output_text", text: "第二段" },
          ],
        },
      ],
    };
    expect(extractResponsesText(data)).toBe("第一段\n第二段");
    expect(extractResponsesText({})).toBe("");
    expect(extractResponsesText({ output: [] })).toBe("");
  });
});
