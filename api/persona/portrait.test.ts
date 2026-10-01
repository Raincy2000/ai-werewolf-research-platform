// ============================================================
// 肖像抓取与参考页提取 — 纯函数单测
// ============================================================

import { describe, expect, it } from "vitest";
import { extractImageCandidates } from "./portrait";
import { extractPageUrl, parsePortraitCandidates } from "./caster";

describe("extractImageCandidates（页面代表图提取）", () => {
  it("og:image 优先（两种属性顺序），协议相对 URL 补 https", () => {
    const html = `<html><head>
      <meta property="og:image" content="//upload.wikimedia.org/portrait.jpg">
      <meta content="https://example.com/alt.png" property="og:image">
      <meta name="twitter:image" content="https://example.com/tw.webp">
      </head><body></body></html>`;
    const urls = extractImageCandidates(html);
    expect(urls[0]).toBe("https://upload.wikimedia.org/portrait.jpg");
    expect(urls).toContain("https://example.com/alt.png");
    expect(urls).toContain("https://example.com/tw.webp");
  });

  it("infobox 图兜底；http 链接拒绝；去重", () => {
    const html = `<table class="infobox"><tr><td><img src="//wiki.org/a.jpg"></td></tr></table>
      <meta property="og:image" content="http://insecure.org/x.jpg">
      <meta property="og:image" content="https://wiki.org/a.jpg">`;
    const urls = extractImageCandidates(html);
    expect(urls).toContain("https://wiki.org/a.jpg");
    expect(urls.some((u) => u.startsWith("http://"))).toBe(false);
    expect(urls.filter((u) => u === "https://wiki.org/a.jpg").length).toBe(1);
  });
});

describe("extractPageUrl（铸魂师参考页提取）", () => {
  it("优先维基/百科页面", () => {
    const dossier = `## 参考页面\n- 曹操 - 维基百科 | https://zh.wikipedia.org/wiki/曹操\n- 某论坛 | https://bbs.example.com/t/1`;
    expect(extractPageUrl(dossier)).toBe("https://zh.wikipedia.org/wiki/曹操");
  });
  it("无维基退回第一个 https 链接；无链接返回 null", () => {
    expect(extractPageUrl("见 https://example.com/a 和 https://example.com/b")).toBe(
      "https://example.com/a",
    );
    expect(extractPageUrl("没有任何链接")).toBeNull();
  });
});

describe("parsePortraitCandidates（①搜集的候选肖像解析）", () => {
  it("解析「候选肖像」小节的 说明|直链 条目，去重限 5 张", () => {
    const dossier = `## 候选肖像
- 长发后期剧照 | https://cdn.example.com/eren-long.jpg
- 维基标准像 | https://upload.wikimedia.org/eren.png
- 长发后期剧照（重复） | https://cdn.example.com/eren-long.jpg
## 参考页面
- 维基 | https://zh.wikipedia.org/wiki/艾伦`;
    const list = parsePortraitCandidates(dossier);
    expect(list.length).toBe(2);
    expect(list[0]!.label).toBe("长发后期剧照");
    expect(list[0]!.url).toBe("https://cdn.example.com/eren-long.jpg");
  });
  it("无说明的纯直链兜底；http 与非图片链接拒绝", () => {
    const dossier = `## 候选肖像\n- https://cdn.example.com/a.webp\n- http://insecure.org/x.jpg\n- https://example.com/page`;
    const list = parsePortraitCandidates(dossier);
    expect(list.map((c) => c.url)).toEqual(["https://cdn.example.com/a.webp"]);
  });
  it("无候选小节返回空数组", () => {
    expect(parsePortraitCandidates("## 基本概要\n没有图")).toEqual([]);
  });
});
